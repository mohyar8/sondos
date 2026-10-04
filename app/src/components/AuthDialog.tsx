import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type RefObject,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import {
  useAuth,
  type AuthError,
  type ProfileInput,
  type SecondFactorChallenge,
} from '../auth/auth-context'
import {
  MAXIMUM_PERSON_NAME_LENGTH,
  normalizePersonName,
} from '../auth/person-name'
import { toAsciiDigits } from '../lib/ascii-digits'
import { isTopmostModal } from '../lib/modal-stack'
import './AuthDialog.css'

type AuthMode = 'sign-in' | 'register' | 'forgot-password'
type DialogView =
  | AuthMode
  | 'profile'
  | 'loading'
  | 'account-error'
  /** The code from her authenticator app (after sign-in or re-auth). */
  | 'second-factor'
  /** Her password again, for an action that wants a recent sign-in. */
  | 'reauthenticate'
type AuthDialogPurpose = 'booking' | 'account'
/**
 * `sign-in` (default): sign in, register or complete the profile.
 * `reauthenticate`: the signed-in account confirms its password (and, when
 * enrolled, its authenticator code) — opened by ReauthenticationHost.
 */
type AuthDialogIntent = 'sign-in' | 'reauthenticate'
type PendingAction = 'submit' | 'sign-out'
type NoticeTone = 'info' | 'success' | 'danger'

type FieldName =
  | 'firstName'
  | 'lastName'
  | 'phone'
  | 'email'
  | 'password'
  | 'passwordConfirmation'
  | 'verificationCode'

type FieldErrors = Partial<Record<FieldName, string>>

interface AuthDialogProps {
  openerRef: RefObject<HTMLButtonElement | null>
  completionFocusRef: RefObject<HTMLElement | null>
  onRequestClose: () => void
  purpose?: AuthDialogPurpose
  intent?: AuthDialogIntent
  onAuthenticationComplete?: () => void
}

// Field errors belong to the view whose form produced them, so they never
// leak into the next form when the view changes underneath (e.g. register →
// profile after PROFILE_REQUIRED).
interface FieldErrorState {
  view: DialogView
  errors: FieldErrors
}

interface ProfileValidation {
  value: ProfileInput | null
  errors: FieldErrors
}

interface AuthFieldProps {
  label: string
  name: FieldName
  type: 'text' | 'email' | 'password' | 'tel'
  autoComplete: string
  error: string | undefined
  feedbackId: string | undefined
  inputMode?: 'email' | 'tel' | 'numeric'
  maxLength?: number
  minLength?: number
  isLtr?: boolean
  isInitialFocus?: boolean
}

const FIELD_NAMES: readonly FieldName[] = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'password',
  'passwordConfirmation',
  'verificationCode',
]
const NO_FIELD_ERRORS: FieldErrors = {}
const VERIFICATION_CODE_PATTERN = /^\d{6}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')
const INITIAL_FOCUS_SELECTOR = '[data-initial-focus]'
// Last-resort focus target when both the opener and the completion target
// are unavailable — typically because the site behind this dialog was made
// `inert` by the email-verification gate the moment a new account signed in.
// EmailVerificationGate marks its own focus target with this attribute.
const RETURN_FOCUS_FALLBACK_SELECTOR = '[data-auth-return-focus]'
const ACCOUNT_ERROR_FALLBACK_MESSAGE =
  'تعذر تحميل بيانات الحساب. حاولي مرة أخرى لاحقًا.'
const SIGNED_OUT_MESSAGE =
  'تم تسجيل الخروج. يمكنكِ الآن تسجيل الدخول بحساب آخر أو إنشاء حساب جديد.'
const EXPIRED_CODE_STEP_MESSAGE =
  'انتهت مهلة التحقق. أعيدي إدخال كلمة المرور للمتابعة.'

function isFieldName(value: string): value is FieldName {
  return FIELD_NAMES.some((fieldName) => fieldName === value)
}

function hasFieldErrors(errors: FieldErrors): boolean {
  return FIELD_NAMES.some((fieldName) => errors[fieldName] !== undefined)
}

function getFormValue(formData: FormData, name: string): string {
  const value = formData.get(name)

  return typeof value === 'string' ? value : ''
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index)

    if (
      characterCode <= 0x1f ||
      (characterCode >= 0x7f && characterCode <= 0x9f)
    ) {
      return true
    }
  }

  return false
}

function isValidEmail(value: string): boolean {
  return (
    value.length <= 320 &&
    !containsControlCharacter(value) &&
    EMAIL_PATTERN.test(value)
  )
}

function isValidPhone(value: string): boolean {
  if (value.length > 32 || containsControlCharacter(value)) {
    return false
  }

  const compactValue = value.replace(/[\s()-]/g, '')

  return (
    /^05\d{8}$/.test(compactValue) ||
    /^5\d{8}$/.test(compactValue) ||
    /^9665\d{8}$/.test(compactValue) ||
    /^\+9665\d{8}$/.test(compactValue)
  )
}

/** The code as she typed or pasted it: Arabic digits mapped, spaces dropped. */
function normalizeVerificationCode(value: string): string {
  return toAsciiDigits(value).replace(/\s/g, '')
}

// Names follow auth/person-name.ts (SEC-10), the Worker's rule: Arabic or
// Latin letters only, with spaces, apostrophes and hyphens between them — no
// other scripts, digits, links or invisible characters.
const NAME_RULE_HINT = `بالأحرف العربية أو اللاتينية فقط (يُسمح بالمسافة والشرطة والفاصلة العليا بين الكلمات)، وبحد أقصى ${MAXIMUM_PERSON_NAME_LENGTH} حرفًا.`

function validateProfileFields(formData: FormData): ProfileValidation {
  const firstName = normalizePersonName(getFormValue(formData, 'firstName'))
  const lastName = normalizePersonName(getFormValue(formData, 'lastName'))
  const phone = toAsciiDigits(getFormValue(formData, 'phone')).trim()
  const errors: FieldErrors = {}

  if (firstName === null) {
    errors.firstName = `أدخلي الاسم الأول ${NAME_RULE_HINT}`
  }

  if (lastName === null) {
    errors.lastName = `أدخلي اسم العائلة ${NAME_RULE_HINT}`
  }

  if (!phone || !isValidPhone(phone)) {
    errors.phone = 'أدخلي رقم جوال سعوديًا صحيحًا.'
  }

  return {
    value:
      firstName === null || lastName === null || hasFieldErrors(errors)
        ? null
        : {
            firstName,
            lastName,
            phone,
          },
    errors,
  }
}

function getAuthErrorMessage(
  error: AuthError,
  isProfileSubmission = false,
): string {
  if (isProfileSubmission && error.code === 'INVALID_INPUT') {
    return 'تحققي من الاسم ورقم الجوال ثم حاولي حفظ البيانات مرة أخرى.'
  }

  return error.message
}

// A server verdict that clearly concerns one field is shown on that field;
// anything ambiguous (wrong credentials, network, …) stays a form-level
// notice so it never points at the wrong input.
function getServerErrorField(
  view: DialogView,
  error: AuthError,
): FieldName | null {
  switch (error.code) {
    case 'EMAIL_ALREADY_IN_USE':
      return view === 'register' ? 'email' : null
    case 'WEAK_PASSWORD':
      return view === 'register' ? 'password' : null
    case 'INVALID_INPUT':
      return view === 'sign-in' || view === 'forgot-password'
        ? 'email'
        : view === 'reauthenticate'
          ? 'password'
          : null
    // Re-authentication asks for the password alone, so a wrong one can
    // only be that field.
    case 'INVALID_CREDENTIALS':
      return view === 'reauthenticate' ? 'password' : null
    case 'INVALID_VERIFICATION_CODE':
      return view === 'second-factor' ? 'verificationCode' : null
    default:
      return null
  }
}

function focusFirstInvalidField(
  form: HTMLFormElement,
  errors: FieldErrors,
) {
  if (!form.isConnected) {
    return
  }

  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement)) {
      continue
    }

    const fieldName = element.name

    if (isFieldName(fieldName) && errors[fieldName] !== undefined) {
      element.focus()
      return
    }
  }
}

function canReceiveFocus(element: HTMLElement): boolean {
  return (
    element !== document.body &&
    element.isConnected &&
    element.getClientRects().length > 0 &&
    element.closest('[inert]') === null
  )
}

function restoreFocus(candidates: ReadonlyArray<HTMLElement | null>) {
  for (const candidate of candidates) {
    if (!candidate || !canReceiveFocus(candidate)) {
      continue
    }

    candidate.focus()

    if (document.activeElement === candidate) {
      return
    }
  }
}

function getDialogTitle(
  view: DialogView,
  purpose: AuthDialogPurpose,
): string {
  switch (view) {
    case 'sign-in':
      return purpose === 'account'
        ? 'تسجيل الدخول إلى حسابكِ'
        : 'تسجيل الدخول لإكمال الحجز'
    case 'register':
      return 'إنشاء حساب جديد'
    case 'forgot-password':
      return 'استعادة كلمة المرور'
    case 'profile':
      return 'استكمال بياناتكِ'
    case 'loading':
      return 'جارٍ التحقق من حسابكِ'
    case 'account-error':
      return 'تعذر تحميل بيانات الحساب'
    case 'second-factor':
      return 'التحقق بخطوتين'
    case 'reauthenticate':
      return 'تأكيد هويتكِ'
  }
}

function getDialogDescription(
  view: DialogView,
  purpose: AuthDialogPurpose,
): string {
  switch (view) {
    case 'sign-in':
      return purpose === 'account'
        ? 'سجّلي الدخول لعرض حجوزاتكِ ومتابعة طلباتكِ.'
        : 'سجّلي الدخول للانتقال إلى مراجعة تفاصيل طلب الحجز.'
    case 'register':
      return purpose === 'account'
        ? 'أنشئي حسابكِ لحفظ بياناتكِ ومتابعة حجوزاتكِ.'
        : 'أنشئي حسابكِ لحفظ بياناتكِ ومتابعة طلب الحجز.'
    case 'forgot-password':
      return 'أدخلي بريدكِ الإلكتروني لإرسال رابط استعادة كلمة المرور.'
    case 'profile':
      return purpose === 'account'
        ? 'احفظي بيانات التواصل المطلوبة لاستكمال حسابكِ.'
        : 'احفظي بيانات التواصل المطلوبة قبل متابعة طلب الحجز.'
    case 'loading':
      return 'نراجع حالة تسجيل الدخول وبيانات ملفكِ الشخصي.'
    case 'account-error':
      return 'لم نتمكن من تجهيز ملفكِ الشخصي للمتابعة.'
    case 'second-factor':
      return 'افتحي تطبيق المصادقة على جوالكِ، ثم أدخلي الرمز المكوّن من 6 أرقام الظاهر الآن لهذا الحساب.'
    case 'reauthenticate':
      return 'لحماية حسابكِ، أدخلي كلمة المرور مرة أخرى لإكمال الإجراء الذي بدأتِه.'
  }
}

function NoticeIcon({
  tone,
  className,
}: {
  tone: NoticeTone
  className: string
}) {
  if (tone === 'danger') {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M12 3.5 2.5 20h19L12 3.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="M12 9.5v5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="12" cy="17.25" r="0.9" fill="currentColor" />
      </svg>
    )
  }

  if (tone === 'success') {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
        <path
          d="m7.5 12.5 3 3 6-6.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 11v5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="7.75" r="0.9" fill="currentColor" />
    </svg>
  )
}

function RequiredMark() {
  return (
    <span className="field__required" aria-hidden="true">
      *
    </span>
  )
}

// One labelled input (design-system §4.5). The error text sits under its own
// field (danger colour + alert icon, never a red border alone); the input
// points at it — and at the form-level feedback region when one is shown —
// through aria-describedby.
function AuthField({
  label,
  name,
  type,
  autoComplete,
  error,
  feedbackId,
  inputMode,
  maxLength,
  minLength,
  isLtr = false,
  isInitialFocus = false,
}: AuthFieldProps) {
  const inputId = useId()
  const errorId = `${inputId}-error`
  const describedBy = [error === undefined ? null : errorId, feedbackId ?? null]
    .filter((value): value is string => value !== null)
    .join(' ')

  return (
    <div className={error === undefined ? 'field' : 'field field--error'}>
      <label className="field__label" htmlFor={inputId}>
        {label}
        <RequiredMark />
      </label>
      <input
        id={inputId}
        name={name}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCapitalize={isLtr ? 'none' : undefined}
        spellCheck={isLtr ? false : undefined}
        dir={isLtr ? 'ltr' : undefined}
        maxLength={maxLength}
        minLength={minLength}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        data-initial-focus={isInitialFocus ? '' : undefined}
        required
      />
      {error !== undefined && (
        <p className="field__error" id={errorId}>
          <NoticeIcon tone="danger" className="auth-dialog__error-icon" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

export default function AuthDialog({
  openerRef,
  completionFocusRef,
  onRequestClose,
  purpose = 'booking',
  intent = 'sign-in',
  onAuthenticationComplete,
}: AuthDialogProps) {
  const {
    firebaseUser,
    profile,
    isInitializing,
    isAuthenticated,
    isAuthAvailable,
    profileRequired,
    authError,
    signIn,
    register,
    completeProfile,
    sendPasswordReset,
    signOutUser,
    clearAuthError,
    completeSecondFactor,
    cancelSecondFactor,
    reauthenticate,
  } = useAuth()
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const [pendingAction, setPendingAction] =
    useState<PendingAction | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [fieldErrorState, setFieldErrorState] =
    useState<FieldErrorState | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  // The code step, once her password was accepted for an account with an
  // authenticator app. Local, so it ends with this dialog.
  const [secondFactor, setSecondFactor] =
    useState<SecondFactorChallenge | null>(null)
  const [selectedFactorUid, setSelectedFactorUid] = useState<string | null>(
    null,
  )
  const dialogRef = useRef<HTMLDivElement>(null)
  const isMountedRef = useRef(true)
  const pendingActionRef = useRef<PendingAction | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const feedbackId = useId()

  const isReauthentication = intent === 'reauthenticate'
  const activeView: DialogView = isReauthentication
    ? secondFactor
      ? 'second-factor'
      : 'reauthenticate'
    : profileRequired
      ? 'profile'
      : isInitializing
        ? 'loading'
        : isAuthenticated && !profile
          ? 'account-error'
          : secondFactor
            ? 'second-factor'
            : mode
  const isBusy = pendingAction !== null
  const canClose = isReauthentication || !profileRequired
  const activeFactorUid =
    secondFactor?.factors.find((factor) => factor.uid === selectedFactorUid)
      ?.uid ??
    secondFactor?.factors[0]?.uid ??
    null
  // §4.6: Escape / backdrop / close are disabled while a request is in
  // flight, so the dialog never disappears while the server may still commit.
  const canDismiss = canClose && !isBusy
  const fieldErrors =
    fieldErrorState?.view === activeView
      ? fieldErrorState.errors
      : NO_FIELD_ERRORS
  const showsFieldErrors = hasFieldErrors(fieldErrors)
  // The password prompt shows only what its own submits produced: an older
  // error in the context belongs to the screen underneath.
  const contextErrorMessage = authError && !isReauthentication
    ? isAuthAvailable
      ? getAuthErrorMessage(authError, activeView === 'profile')
      : authError.message
    : null
  // A field-level verdict from the server is also mirrored in the context's
  // authError; it is already shown on its field, so it is not repeated here.
  const visibleError = isAuthAvailable
    ? generalError ?? (showsFieldErrors ? null : contextErrorMessage)
    : contextErrorMessage ?? generalError
  const hasFeedback =
    activeView !== 'account-error' &&
    (visibleError !== null || successMessage !== null)
  const feedbackDescriptionId = hasFeedback ? feedbackId : undefined

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    // <body> is never a return target: focus sits there when the element
    // she used was disabled or removed (e.g. an admin dialog's confirm
    // button while its request asked for this prompt), and then the
    // completion target below must be reached instead.
    const returnFocusElement =
      openerRef.current ??
      (document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body
        ? document.activeElement
        : null)
    // The ref OBJECT is kept, not its current value: the completion target
    // (e.g. the booking review heading) only mounts once she is signed in,
    // i.e. after this dialog opened, so it must be read when the dialog
    // closes. The opener is the element that existed at open time and is
    // captured now.
    const completionFocusTarget = completionFocusRef

    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow

      window.requestAnimationFrame(() => {
        restoreFocus([
          returnFocusElement,
          completionFocusTarget.current,
          document.querySelector<HTMLElement>(
            RETURN_FOCUS_FALLBACK_SELECTOR,
          ),
        ])
      })
    }
  }, [completionFocusRef, openerRef])

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const dialogElement = dialogRef.current

      if (!dialogElement) {
        return
      }

      const focusTarget =
        dialogElement.querySelector<HTMLElement>(INITIAL_FOCUS_SELECTOR) ??
        dialogElement

      focusTarget.focus()
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [activeView])

  // A code step she walks away from (back, close, unmount) is dropped, so its
  // resolver never outlives the dialog that showed it.
  useEffect(() => {
    if (secondFactor === null) {
      return
    }

    const challengeId = secondFactor.id

    return () => cancelSecondFactor(challengeId)
  }, [cancelSecondFactor, secondFactor])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // A dialog opened on top of this one (the password prompt) owns the
      // keyboard until it closes.
      if (dialogRef.current && !isTopmostModal(dialogRef.current)) {
        return
      }

      if (event.key === 'Escape') {
        if (canDismiss) {
          event.preventDefault()
          onRequestClose()
        }

        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) {
        return
      }

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getClientRects().length > 0)

      if (focusableElements.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]
      const activeElement = document.activeElement

      if (!dialogRef.current.contains(activeElement)) {
        event.preventDefault()
        const focusTarget = event.shiftKey ? lastElement : firstElement

        focusTarget?.focus()
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault()
        lastElement?.focus()
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault()
        firstElement?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [canDismiss, onRequestClose])

  const resetFeedback = useCallback(() => {
    setGeneralError(null)
    setFieldErrorState(null)
    setSuccessMessage(null)
    clearAuthError()
  }, [clearAuthError])

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode)
    resetFeedback()
  }

  function beginAction(action: PendingAction): boolean {
    if (pendingActionRef.current !== null) {
      return false
    }

    pendingActionRef.current = action
    setPendingAction(action)
    resetFeedback()

    return true
  }

  function finishAction() {
    pendingActionRef.current = null
    setPendingAction(null)
  }

  // Commits the errors first so the focused input already carries
  // aria-invalid and its error description when assistive tech reads it.
  function rejectWithFieldErrors(
    form: HTMLFormElement,
    view: DialogView,
    errors: FieldErrors,
  ) {
    flushSync(() => {
      finishAction()
      setFieldErrorState({ view, errors })
    })
    focusFirstInvalidField(form, errors)
  }

  function showActionError(
    form: HTMLFormElement,
    view: DialogView,
    error: AuthError,
    isProfileSubmission = false,
  ) {
    const message = getAuthErrorMessage(error, isProfileSubmission)
    const fieldName = getServerErrorField(view, error)

    if (fieldName !== null) {
      const errors: FieldErrors = {}

      errors[fieldName] = message
      rejectWithFieldErrors(form, view, errors)
      return
    }

    finishAction()
    setGeneralError(message)
  }

  function handleFieldChange(event: FormEvent<HTMLFormElement>) {
    const target = event.target

    if (!(target instanceof HTMLInputElement)) {
      return
    }

    const fieldName = target.name

    if (!isFieldName(fieldName)) {
      return
    }

    setFieldErrorState((current) => {
      if (!current || current.errors[fieldName] === undefined) {
        return current
      }

      const errors: FieldErrors = { ...current.errors }

      delete errors[fieldName]

      return { view: current.view, errors }
    })
  }

  async function handleSignInSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const form = event.currentTarget

    if (!beginAction('submit')) {
      return
    }

    const formData = new FormData(form)
    const email = getFormValue(formData, 'email').trim()
    const password = getFormValue(formData, 'password')
    const errors: FieldErrors = {}

    if (!email || !isValidEmail(email)) {
      errors.email = 'أدخلي بريدًا إلكترونيًا صحيحًا.'
    }

    if (!password) {
      errors.password = 'أدخلي كلمة المرور.'
    }

    if (hasFieldErrors(errors)) {
      rejectWithFieldErrors(form, 'sign-in', errors)
      return
    }

    const result = await signIn(email, password)

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      if (result.secondFactor) {
        enterSecondFactor(result.secondFactor)
        return
      }

      showActionError(form, 'sign-in', result.error)
      return
    }

    finishAction()
    onAuthenticationComplete?.()
  }

  /** Password accepted: the dialog moves on to the authenticator code. */
  function enterSecondFactor(challenge: SecondFactorChallenge) {
    finishAction()
    setSecondFactor(challenge)
    setSelectedFactorUid(challenge.factors[0]?.uid ?? null)
  }

  /** Back to the password step (her choice, or an expired code session). */
  function leaveSecondFactor(message: string | null = null) {
    setSecondFactor(null)
    setSelectedFactorUid(null)
    resetFeedback()

    if (message !== null) {
      setGeneralError(message)
    }
  }

  async function handleReauthenticationSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    const form = event.currentTarget

    if (!beginAction('submit')) {
      return
    }

    const password = getFormValue(new FormData(form), 'password')

    if (!password) {
      rejectWithFieldErrors(form, 'reauthenticate', {
        password: 'أدخلي كلمة المرور.',
      })
      return
    }

    const result = await reauthenticate(password)

    // Success closes the prompt: ReauthenticationHost unmounts this dialog.
    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      if (result.secondFactor) {
        enterSecondFactor(result.secondFactor)
        return
      }

      showActionError(form, 'reauthenticate', result.error)
      return
    }

    finishAction()
  }

  async function handleSecondFactorSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    const form = event.currentTarget

    if (!secondFactor || !beginAction('submit')) {
      return
    }

    const code = normalizeVerificationCode(
      getFormValue(new FormData(form), 'verificationCode'),
    )

    if (!VERIFICATION_CODE_PATTERN.test(code)) {
      rejectWithFieldErrors(form, 'second-factor', {
        verificationCode:
          'أدخلي الرمز المكوّن من 6 أرقام كما يظهر في تطبيق المصادقة.',
      })
      return
    }

    if (activeFactorUid === null) {
      finishAction()
      leaveSecondFactor(EXPIRED_CODE_STEP_MESSAGE)
      return
    }

    const result = await completeSecondFactor(
      secondFactor.id,
      activeFactorUid,
      code,
    )

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      if (result.error.code === 'MFA_SESSION_EXPIRED') {
        finishAction()
        leaveSecondFactor(getAuthErrorMessage(result.error))
        return
      }

      showActionError(form, 'second-factor', result.error)
      return
    }

    finishAction()
    setSecondFactor(null)

    if (!isReauthentication) {
      onAuthenticationComplete?.()
    }
  }

  async function handleRegistrationSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    const form = event.currentTarget

    if (!beginAction('submit')) {
      return
    }

    const formData = new FormData(form)
    const profileValidation = validateProfileFields(formData)
    const email = getFormValue(formData, 'email').trim()
    const password = getFormValue(formData, 'password')
    const passwordConfirmation = getFormValue(
      formData,
      'passwordConfirmation',
    )
    const errors: FieldErrors = { ...profileValidation.errors }

    if (!email || !isValidEmail(email)) {
      errors.email = 'أدخلي بريدًا إلكترونيًا صحيحًا.'
    }

    if (password.length < 8) {
      errors.password = 'يجب ألا تقل كلمة المرور عن 8 أحرف.'
    } else if (password !== passwordConfirmation) {
      errors.passwordConfirmation = 'كلمتا المرور غير متطابقتين.'
    }

    if (!profileValidation.value || hasFieldErrors(errors)) {
      rejectWithFieldErrors(form, 'register', errors)
      return
    }

    const result = await register({
      ...profileValidation.value,
      email,
      password,
    })

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      showActionError(form, 'register', result.error, profileRequired)
      return
    }

    finishAction()
    onAuthenticationComplete?.()
  }

  async function handlePasswordResetSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    const form = event.currentTarget

    if (!beginAction('submit')) {
      return
    }

    const formData = new FormData(form)
    const email = getFormValue(formData, 'email').trim()

    if (!email || !isValidEmail(email)) {
      rejectWithFieldErrors(form, 'forgot-password', {
        email: 'أدخلي بريدًا إلكترونيًا صحيحًا.',
      })
      return
    }

    const result = await sendPasswordReset(email)

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      showActionError(form, 'forgot-password', result.error)
      return
    }

    finishAction()
    setSuccessMessage(
      'إذا كان البريد مرتبطًا بحساب، فستصلكِ رسالة تحتوي على رابط استعادة كلمة المرور.',
    )
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const form = event.currentTarget

    if (!beginAction('submit')) {
      return
    }

    const profileValidation = validateProfileFields(new FormData(form))

    if (!profileValidation.value) {
      rejectWithFieldErrors(form, 'profile', profileValidation.errors)
      return
    }

    const result = await completeProfile(profileValidation.value)

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      showActionError(form, 'profile', result.error, true)
      return
    }

    finishAction()
    onAuthenticationComplete?.()
  }

  async function handleAccountErrorSignOut() {
    if (!beginAction('sign-out')) {
      return
    }

    const result = await signOutUser()

    if (!isMountedRef.current) {
      return
    }

    finishAction()

    if (result.ok) {
      onRequestClose()
      return
    }

    setGeneralError(getAuthErrorMessage(result.error))
  }

  // Inspection #8b: the profile-completion step used to have no way out
  // (no close button while profileRequired). Signing out here keeps the
  // dialog open on the sign-in form, where she can use another account,
  // create a new one, or simply close the dialog.
  async function handleProfileExit() {
    if (!beginAction('sign-out')) {
      return
    }

    const result = await signOutUser()

    if (!isMountedRef.current) {
      return
    }

    finishAction()

    if (!result.ok) {
      setGeneralError(getAuthErrorMessage(result.error))
      return
    }

    setMode('sign-in')
    setSuccessMessage(SIGNED_OUT_MESSAGE)
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && canDismiss) {
      onRequestClose()
    }
  }

  if (typeof document === 'undefined') {
    return null
  }

  return createPortal(
    <div
      className="dialog__backdrop auth-dialog__backdrop"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="dialog auth-dialog__panel"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="auth-dialog__handle" aria-hidden="true" />

        <header className="auth-dialog__header">
          <div className="auth-dialog__heading">
            <p className="eyebrow">
              {isReauthentication
                ? 'أمان الحساب'
                : purpose === 'account'
                  ? 'حساب العميلة'
                  : 'متابعة طلب الحجز'}
            </p>
            <h2 id={titleId} className="auth-dialog__title">
              {getDialogTitle(activeView, purpose)}
            </h2>
          </div>

          {canClose && (
            <button
              className="btn btn--ghost auth-dialog__close"
              type="button"
              onClick={onRequestClose}
              disabled={isBusy}
              aria-label={
                isReauthentication
                  ? 'إغلاق نافذة تأكيد الهوية'
                  : 'إغلاق نافذة تسجيل الدخول'
              }
            >
              إغلاق
            </button>
          )}
        </header>

        <p className="auth-dialog__description" id={descriptionId}>
          {getDialogDescription(activeView, purpose)}
        </p>

        {activeView === 'loading' && (
          <div
            className="notice notice--info auth-dialog__status"
            role="status"
          >
            <NoticeIcon tone="info" className="notice__icon" />
            <p>جارٍ تحميل بيانات الحساب، يرجى الانتظار.</p>
          </div>
        )}

        {activeView === 'account-error' && (
          <div className="auth-dialog__account-error">
            <div className="notice notice--danger" role="alert">
              <NoticeIcon tone="danger" className="notice__icon" />
              <p>{visibleError ?? ACCOUNT_ERROR_FALLBACK_MESSAGE}</p>
            </div>

            <button
              className="btn btn--secondary"
              type="button"
              onClick={() => void handleAccountErrorSignOut()}
              aria-disabled={isBusy || undefined}
              data-initial-focus=""
            >
              {pendingAction === 'sign-out'
                ? 'جارٍ تسجيل الخروج…'
                : 'تسجيل الخروج والمحاولة بحساب آخر'}
            </button>
          </div>
        )}

        {activeView === 'sign-in' && (
          <form
            className="auth-dialog__form"
            onSubmit={(event) => void handleSignInSubmit(event)}
            onChange={handleFieldChange}
            noValidate
          >
            <AuthField
              label="البريد الإلكتروني"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              error={fieldErrors.email}
              feedbackId={feedbackDescriptionId}
              isLtr
              isInitialFocus
            />

            <AuthField
              label="كلمة المرور"
              name="password"
              type="password"
              autoComplete="current-password"
              error={fieldErrors.password}
              feedbackId={feedbackDescriptionId}
              isLtr
            />

            <div className="auth-dialog__form-links">
              <button
                className="text-link auth-dialog__link"
                type="button"
                onClick={() => switchMode('forgot-password')}
                disabled={isBusy}
              >
                نسيتِ كلمة المرور؟
              </button>
              <button
                className="text-link auth-dialog__link"
                type="button"
                onClick={() => switchMode('register')}
                disabled={isBusy}
              >
                إنشاء حساب جديد
              </button>
            </div>

            <button
              className="btn btn--primary btn--lg"
              type="submit"
              aria-disabled={isBusy || undefined}
            >
              {pendingAction === 'submit'
                ? 'جارٍ تسجيل الدخول…'
                : 'تسجيل الدخول'}
            </button>
          </form>
        )}

        {activeView === 'register' && (
          <form
            className="auth-dialog__form"
            onSubmit={(event) => void handleRegistrationSubmit(event)}
            onChange={handleFieldChange}
            noValidate
          >
            <div className="auth-dialog__field-grid">
              <AuthField
                label="الاسم الأول"
                name="firstName"
                type="text"
                autoComplete="given-name"
                maxLength={80}
                error={fieldErrors.firstName}
                feedbackId={feedbackDescriptionId}
                isInitialFocus
              />

              <AuthField
                label="اسم العائلة"
                name="lastName"
                type="text"
                autoComplete="family-name"
                maxLength={80}
                error={fieldErrors.lastName}
                feedbackId={feedbackDescriptionId}
              />
            </div>

            <AuthField
              label="رقم الجوال"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={32}
              error={fieldErrors.phone}
              feedbackId={feedbackDescriptionId}
              isLtr
            />

            <AuthField
              label="البريد الإلكتروني"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              error={fieldErrors.email}
              feedbackId={feedbackDescriptionId}
              isLtr
            />

            <div className="auth-dialog__field-grid">
              <AuthField
                label="كلمة المرور"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                error={fieldErrors.password}
                feedbackId={feedbackDescriptionId}
                isLtr
              />

              <AuthField
                label="تأكيد كلمة المرور"
                name="passwordConfirmation"
                type="password"
                autoComplete="new-password"
                minLength={8}
                error={fieldErrors.passwordConfirmation}
                feedbackId={feedbackDescriptionId}
                isLtr
              />
            </div>

            <button
              className="btn btn--primary btn--lg"
              type="submit"
              aria-disabled={isBusy || undefined}
            >
              {pendingAction === 'submit'
                ? 'جارٍ إنشاء الحساب…'
                : 'إنشاء الحساب'}
            </button>

            <button
              className="text-link auth-dialog__link auth-dialog__switch"
              type="button"
              onClick={() => switchMode('sign-in')}
              disabled={isBusy}
            >
              لديكِ حساب؟ سجّلي الدخول
            </button>
          </form>
        )}

        {activeView === 'forgot-password' && (
          <form
            className="auth-dialog__form"
            onSubmit={(event) => void handlePasswordResetSubmit(event)}
            onChange={handleFieldChange}
            noValidate
          >
            <AuthField
              label="البريد الإلكتروني"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              error={fieldErrors.email}
              feedbackId={feedbackDescriptionId}
              isLtr
              isInitialFocus
            />

            <button
              className="btn btn--primary btn--lg"
              type="submit"
              aria-disabled={isBusy || undefined}
            >
              {pendingAction === 'submit'
                ? 'جارٍ الإرسال…'
                : 'إرسال رابط الاستعادة'}
            </button>

            <button
              className="text-link auth-dialog__link auth-dialog__switch"
              type="button"
              onClick={() => switchMode('sign-in')}
              disabled={isBusy}
            >
              العودة إلى تسجيل الدخول
            </button>
          </form>
        )}

        {activeView === 'profile' && (
          <form
            className="auth-dialog__form"
            onSubmit={(event) => void handleProfileSubmit(event)}
            onChange={handleFieldChange}
            noValidate
          >
            <div className="auth-dialog__field-grid">
              <AuthField
                label="الاسم الأول"
                name="firstName"
                type="text"
                autoComplete="given-name"
                maxLength={80}
                error={fieldErrors.firstName}
                feedbackId={feedbackDescriptionId}
                isInitialFocus
              />

              <AuthField
                label="اسم العائلة"
                name="lastName"
                type="text"
                autoComplete="family-name"
                maxLength={80}
                error={fieldErrors.lastName}
                feedbackId={feedbackDescriptionId}
              />
            </div>

            <AuthField
              label="رقم الجوال"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              maxLength={32}
              error={fieldErrors.phone}
              feedbackId={feedbackDescriptionId}
              isLtr
            />

            <button
              className="btn btn--primary btn--lg"
              type="submit"
              aria-disabled={isBusy || undefined}
            >
              {pendingAction === 'submit'
                ? 'جارٍ حفظ البيانات…'
                : 'حفظ البيانات والمتابعة'}
            </button>

            <div className="auth-dialog__exit">
              <p className="auth-dialog__exit-hint">
                ليس هذا حسابكِ، أو تفضّلين المتابعة لاحقًا؟
              </p>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => void handleProfileExit()}
                aria-disabled={isBusy || undefined}
              >
                {pendingAction === 'sign-out'
                  ? 'جارٍ تسجيل الخروج…'
                  : 'تسجيل الخروج واستخدام حساب آخر'}
              </button>
            </div>
          </form>
        )}

        {activeView === 'reauthenticate' && (
          <form
            className="auth-dialog__form"
            onSubmit={(event) => void handleReauthenticationSubmit(event)}
            onChange={handleFieldChange}
            noValidate
          >
            {firebaseUser?.email && (
              <p className="auth-dialog__account">
                <span>الحساب:</span>{' '}
                <bdi dir="ltr">{firebaseUser.email}</bdi>
              </p>
            )}

            {/* Lets a password manager match the saved login. */}
            <input
              type="email"
              name="username"
              autoComplete="username"
              value={firebaseUser?.email ?? ''}
              readOnly
              hidden
            />

            <AuthField
              label="كلمة المرور"
              name="password"
              type="password"
              autoComplete="current-password"
              error={fieldErrors.password}
              feedbackId={feedbackDescriptionId}
              isLtr
              isInitialFocus
            />

            <button
              className="btn btn--primary btn--lg"
              type="submit"
              aria-disabled={isBusy || undefined}
            >
              {pendingAction === 'submit'
                ? 'جارٍ التحقق…'
                : 'تأكيد كلمة المرور'}
            </button>

            <button
              className="text-link auth-dialog__link auth-dialog__switch"
              type="button"
              onClick={onRequestClose}
              disabled={isBusy}
            >
              إلغاء الإجراء
            </button>
          </form>
        )}

        {activeView === 'second-factor' && secondFactor && (
          <form
            className="auth-dialog__form"
            onSubmit={(event) => void handleSecondFactorSubmit(event)}
            onChange={handleFieldChange}
            noValidate
          >
            {secondFactor.factors.length > 1 && (
              <fieldset className="auth-dialog__factors">
                <legend className="field__label">
                  تطبيق المصادقة الذي ستستخدمينه
                </legend>
                {secondFactor.factors.map((factor, index) => (
                  <label className="auth-dialog__factor" key={factor.uid}>
                    <input
                      type="radio"
                      name="secondFactor"
                      value={factor.uid}
                      checked={factor.uid === activeFactorUid}
                      onChange={() => setSelectedFactorUid(factor.uid)}
                    />
                    <bdi dir="auto">
                      {factor.label ?? `تطبيق المصادقة ${index + 1}`}
                    </bdi>
                  </label>
                ))}
              </fieldset>
            )}

            <AuthField
              label="رمز التحقق"
              name="verificationCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              error={fieldErrors.verificationCode}
              feedbackId={feedbackDescriptionId}
              isLtr
              isInitialFocus
            />

            <button
              className="btn btn--primary btn--lg"
              type="submit"
              aria-disabled={isBusy || undefined}
            >
              {pendingAction === 'submit' ? 'جارٍ التحقق…' : 'التحقق والمتابعة'}
            </button>

            <button
              className="text-link auth-dialog__link auth-dialog__switch"
              type="button"
              onClick={() => leaveSecondFactor()}
              disabled={isBusy}
            >
              {isReauthentication
                ? 'العودة إلى كلمة المرور'
                : 'العودة إلى تسجيل الدخول'}
            </button>
          </form>
        )}

        {activeView !== 'account-error' && (
          // Persistent live regions: only their content changes, which
          // screen readers announce reliably (a freshly inserted region
          // often is not).
          <div className="auth-dialog__feedback" id={feedbackId}>
            <div role="alert" aria-atomic="true">
              {visibleError !== null && (
                <div className="notice notice--danger">
                  <NoticeIcon tone="danger" className="notice__icon" />
                  <p>{visibleError}</p>
                </div>
              )}
            </div>

            <div role="status" aria-atomic="true">
              {successMessage !== null && (
                <div className="notice notice--success">
                  <NoticeIcon tone="success" className="notice__icon" />
                  <p>{successMessage}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
