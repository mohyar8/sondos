import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type RefObject,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { RECENT_SIGN_IN_GUARD_SECONDS } from '../../../shared/admin-session'
import { RIYADH_TIME_ZONE } from '../../../shared/timing'
import {
  useAuth,
  type AuthError,
  type ReauthenticationRequest,
  type SecondFactorChallenge,
} from '../../auth/auth-context'
import { toAsciiDigits } from '../../lib/ascii-digits'
import { containTabFocus, isTopmostModal } from '../../lib/modal-stack'
import { serverLimitMessages } from '../../lib/server-error-messages'
// The shared dialog, field and notice layout (bottom sheet on phones,
// centred panel from 64rem, reduced-motion aware).
import '../../components/AuthDialog.css'

type ReauthView = 'password' | 'second-factor' | 'confirmed'
type FieldName = 'password' | 'verificationCode'

interface FieldError {
  field: FieldName
  message: string
}

interface Feedback {
  tone: 'danger' | 'success'
  message: string
}

interface ReauthDialogProps {
  /** The open request (AuthContextValue.reauthentication). */
  request: ReauthenticationRequest
  /**
   * Every close but «متابعة»: Escape, the backdrop, «إغلاق», «إلغاء
   * الإجراء». Cancels the action she started, before or after success.
   */
  onCancel: () => void
  /** «متابعة» on the success view: the action she started is sent again. */
  onContinue: () => void
}

interface ReauthFieldProps {
  label: string
  name: string
  type: 'password' | 'text'
  autoComplete: string
  value: string
  onChange: (value: string) => void
  inputRef: RefObject<HTMLInputElement | null>
  error: string | undefined
  inputMode?: 'numeric'
  maxLength?: number
}

const VERIFICATION_CODE_PATTERN = /^\d{6}$/
const INITIAL_FOCUS_SELECTOR = '[data-initial-focus]'
// EmailVerificationGate's focus target: the last resort when the element
// that had focus is gone or inert.
const RETURN_FOCUS_FALLBACK_SELECTOR = '[data-auth-return-focus]'
const PASSWORD_REQUIRED_MESSAGE = 'أدخلي كلمة المرور.'
const CODE_FORMAT_MESSAGE =
  'أدخلي الرمز المكوّن من 6 أرقام كما يظهر في تطبيق المصادقة.'
const EXPIRED_CODE_STEP_MESSAGE =
  'انتهت مهلة التحقق. أعيدي إدخال كلمة المرور للمتابعة.'
/**
 * How long the Worker's AD+R, AD+S and CO+R guards count a sign-in as
 * recent (TM-08 / SB-14): the guard's own window, 30 s inside the 10-minute
 * D1 CHECK, so the time shown is never later than the Worker's cut-off.
 * Display only: the Worker decides.
 */
const RECENT_SIGN_IN_GUARD_MS = RECENT_SIGN_IN_GUARD_SECONDS * 1000

// Riyadh time with Western digits, like every instant on the site.
const validUntilFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
})

/**
 * When her fresh sign-in stops counting as recent (the Worker's guard). The
 * minute is shown without its seconds, so it never runs past the guard.
 */
function formatValidUntil(confirmedAt: number): string {
  return validUntilFormatter.format(
    new Date(confirmedAt + RECENT_SIGN_IN_GUARD_MS),
  )
}

/** The code as she typed or pasted it: Arabic digits mapped, spaces dropped. */
function normalizeVerificationCode(value: string): string {
  return toAsciiDigits(value).replace(/\s/g, '')
}

/** Which field a failed step points at, if the error clearly concerns one. */
function getErrorField(view: ReauthView, error: AuthError): FieldName | null {
  switch (error.code) {
    // The password is the only thing she typed on that step.
    case 'INVALID_INPUT':
    case 'INVALID_CREDENTIALS':
      return view === 'password' ? 'password' : null
    case 'INVALID_VERIFICATION_CODE':
      return view === 'second-factor' ? 'verificationCode' : null
    default:
      return null
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

function getTitle(view: ReauthView): string {
  switch (view) {
    case 'password':
      return 'تأكيد هويتكِ'
    case 'second-factor':
      return 'التحقق بخطوتين'
    case 'confirmed':
      return 'تم تأكيد هويتكِ'
  }
}

function getDescription(view: ReauthView): string {
  switch (view) {
    // The plan's one REAUTH_REQUIRED wording (§3.1), from the app's table.
    case 'password':
      return serverLimitMessages.REAUTH_REQUIRED
    case 'second-factor':
      return 'افتحي تطبيق المصادقة على جوالكِ، ثم أدخلي الرمز المكوّن من 6 أرقام الظاهر الآن لهذا الحساب.'
    case 'confirmed':
      return 'اختاري «متابعة» لإكمال الإجراء الذي بدأتِه، أو «إلغاء الإجراء» إن غيّرتِ رأيكِ.'
  }
}

function StatusIcon({
  tone,
  className,
}: {
  tone: Feedback['tone']
  className: string
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {tone === 'danger' ? (
        <>
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
        </>
      ) : (
        <>
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="m7.5 12.5 3 3 6-6.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  )
}

// A labelled, required input whose error sits under it (danger text and an
// alert icon, never a red border alone) and is linked by aria-describedby.
function ReauthField({
  label,
  name,
  type,
  autoComplete,
  value,
  onChange,
  inputRef,
  error,
  inputMode,
  maxLength,
}: ReauthFieldProps) {
  const inputId = useId()
  const errorId = `${inputId}-error`

  return (
    <div className={error === undefined ? 'field' : 'field field--error'}>
      <label className="field__label" htmlFor={inputId}>
        {label}
        <span className="field__required" aria-hidden="true">
          *
        </span>
      </label>
      <input
        ref={inputRef}
        id={inputId}
        name={name}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        autoCapitalize="none"
        spellCheck={false}
        dir="ltr"
        maxLength={maxLength}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        data-initial-focus=""
        required
      />
      {error !== undefined && (
        <p className="field__error" id={errorId}>
          <StatusIcon tone="danger" className="auth-dialog__error-icon" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

/**
 * The app's one «confirm your identity» dialog, for the admin and for
 * customers alike (W1-08, UX-16, TM-07, TM-08). ReauthenticationHost opens
 * it for every AuthProvider request: a 403 REAUTH_REQUIRED retried by the
 * API client or useReauthRetry, or an account-security step.
 *
 * - Password step: her account's email in a read-only `username` field (so
 *   a password manager matches the saved login) and her current password.
 *   The password lives only in this component's state, is cleared after
 *   every attempt and goes nowhere but the AuthProvider's
 *   reauthenticateWithPassword; nothing here logs or stores it.
 * - Code step, when the account has an authenticator app (landed with the
 *   Wave 0 MFA work, kept so an enrolled admin can still confirm).
 * - Success: «التحقق صالح حتى {time}»; only «متابعة» sends the action she
 *   started once more, and «إلغاء الإجراء» is still there if she changed
 *   her mind.
 *
 * Labelled modal, Tab trapped; Escape, the backdrop and «إغلاق» cancel in
 * every view, success included; focus returns to where she was. Nothing
 * can close it while a check is in flight.
 */
export default function ReauthDialog({
  request,
  onCancel,
  onContinue,
}: ReauthDialogProps) {
  const { reauthenticateWithPassword, completeSecondFactor, cancelSecondFactor } =
    useAuth()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [secondFactor, setSecondFactor] =
    useState<SecondFactorChallenge | null>(null)
  const [selectedFactorUid, setSelectedFactorUid] = useState<string | null>(
    null,
  )
  const [isBusy, setIsBusy] = useState(false)
  const [fieldError, setFieldError] = useState<FieldError | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const isMountedRef = useRef(true)
  const isBusyRef = useRef(false)
  // Captured once: the request object is replaced when she succeeds.
  const returnFocusRef = useRef(request.returnFocus)
  const titleId = useId()
  const descriptionId = useId()
  const usernameId = useId()
  const usernameHintId = useId()

  const view: ReauthView =
    request.confirmedAt !== null
      ? 'confirmed'
      : secondFactor !== null
        ? 'second-factor'
        : 'password'
  const activeFactorUid =
    secondFactor?.factors.find((factor) => factor.uid === selectedFactorUid)
      ?.uid ??
    secondFactor?.factors[0]?.uid ??
    null
  const visibleFieldError = (field: FieldName): string | undefined =>
    fieldError?.field === field ? fieldError.message : undefined

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Scroll lock while open; focus goes back where she was once it closes.
  useEffect(() => {
    const returnFocus = returnFocusRef.current
    const previousOverflow = document.body.style.overflow

    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow

      // A frame later, so a dialog underneath has re-rendered first. One
      // shot, nothing left running after it.
      window.requestAnimationFrame(() => {
        restoreFocus([
          returnFocus,
          document.querySelector<HTMLElement>(RETURN_FOCUS_FALLBACK_SELECTOR),
        ])
      })
    }
  }, [])

  // Each step starts on its field (or «متابعة» after success).
  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current

      if (!dialog) {
        return
      }

      const focusTarget =
        dialog.querySelector<HTMLElement>(INITIAL_FOCUS_SELECTOR) ?? dialog

      focusTarget.focus()
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [view])

  // A code step she leaves (back, close, success) is dropped in the
  // provider, so its resolver never outlives this dialog.
  useEffect(() => {
    if (secondFactor === null) {
      return
    }

    const challengeId = secondFactor.id

    return () => cancelSecondFactor(challengeId)
  }, [cancelSecondFactor, secondFactor])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current

      // Only the topmost dialog acts on a key.
      if (!dialog || !isTopmostModal(dialog)) {
        return
      }

      if (event.key === 'Escape') {
        if (!isBusy) {
          event.preventDefault()
          onCancel()
        }

        return
      }

      if (event.key === 'Tab') {
        containTabFocus(dialog, event)
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isBusy, onCancel])

  function beginAttempt(): boolean {
    if (isBusyRef.current) {
      return false
    }

    isBusyRef.current = true
    setIsBusy(true)
    setFieldError(null)
    setFormError(null)

    return true
  }

  function endAttempt() {
    isBusyRef.current = false
    setIsBusy(false)
  }

  /** Commits the error first, so the field is announced with it on focus. */
  function showFieldError(field: FieldName, message: string) {
    flushSync(() => {
      endAttempt()
      setFieldError({ field, message })
    })

    const input = field === 'password' ? passwordRef.current : codeRef.current

    input?.focus()
  }

  function showError(error: AuthError) {
    const field = getErrorField(view, error)

    if (field !== null) {
      showFieldError(field, error.message)
      return
    }

    endAttempt()
    setFormError(error.message)
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!beginAttempt()) {
      return
    }

    if (password.length === 0) {
      showFieldError('password', PASSWORD_REQUIRED_MESSAGE)
      return
    }

    const result = await reauthenticateWithPassword(password)

    if (!isMountedRef.current) {
      return
    }

    // Used once: never kept after the attempt, whatever its outcome.
    setPassword('')

    if (result.ok) {
      // The provider marked the request confirmed: the success view shows.
      endAttempt()
      return
    }

    if (result.secondFactor) {
      endAttempt()
      setCode('')
      setSecondFactor(result.secondFactor)
      setSelectedFactorUid(result.secondFactor.factors[0]?.uid ?? null)
      return
    }

    showError(result.error)
  }

  /** Back to the password step (her choice, or an expired code session). */
  function leaveSecondFactor(message: string | null = null) {
    setSecondFactor(null)
    setSelectedFactorUid(null)
    setCode('')
    setFieldError(null)
    setFormError(message)
  }

  async function handleCodeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (secondFactor === null || !beginAttempt()) {
      return
    }

    const normalizedCode = normalizeVerificationCode(code)

    if (!VERIFICATION_CODE_PATTERN.test(normalizedCode)) {
      showFieldError('verificationCode', CODE_FORMAT_MESSAGE)
      return
    }

    if (activeFactorUid === null) {
      endAttempt()
      leaveSecondFactor(EXPIRED_CODE_STEP_MESSAGE)
      return
    }

    const result = await completeSecondFactor(
      secondFactor.id,
      activeFactorUid,
      normalizedCode,
    )

    if (!isMountedRef.current) {
      return
    }

    if (result.ok) {
      endAttempt()
      setSecondFactor(null)
      setCode('')
      return
    }

    if (result.error.code === 'MFA_SESSION_EXPIRED') {
      endAttempt()
      leaveSecondFactor(result.error.message)
      return
    }

    showError(result.error)
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !isBusy) {
      onCancel()
    }
  }

  // UX-16: after success, until when the fresh sign-in counts as recent.
  const feedback: Feedback | null =
    request.confirmedAt !== null
      ? {
          tone: 'success',
          message: `التحقق صالح حتى ${formatValidUntil(request.confirmedAt)}.`,
        }
      : formError !== null
        ? { tone: 'danger', message: formError }
        : null

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
            <p className="eyebrow">أمان الحساب</p>
            <h2 id={titleId} className="auth-dialog__title">
              {getTitle(view)}
            </h2>
          </div>

          <button
            className="btn btn--ghost auth-dialog__close"
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            aria-label="إغلاق نافذة تأكيد الهوية وإلغاء الإجراء"
          >
            إغلاق
          </button>
        </header>

        <p className="auth-dialog__description" id={descriptionId}>
          {getDescription(view)}
        </p>

        {view === 'password' && (
          <form
            className="auth-dialog__form"
            onSubmit={(event) => void handlePasswordSubmit(event)}
            noValidate
          >
            <div className="field">
              <label className="field__label" htmlFor={usernameId}>
                الحساب
              </label>
              {/* UX-16: the account, read-only, for password managers too. */}
              <input
                id={usernameId}
                name="username"
                type="email"
                autoComplete="username"
                dir="ltr"
                value={request.email}
                readOnly
                aria-describedby={usernameHintId}
              />
              <p className="field__hint" id={usernameHintId}>
                تأكيد الهوية لهذا الحساب، ولا يمكن تغييره هنا.
              </p>
            </div>

            <ReauthField
              label="كلمة المرور"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(value) => {
                setPassword(value)

                if (fieldError?.field === 'password') {
                  setFieldError(null)
                }
              }}
              inputRef={passwordRef}
              error={visibleFieldError('password')}
            />

            <button
              className="btn btn--primary btn--lg"
              type="submit"
              aria-disabled={isBusy || undefined}
            >
              {isBusy ? 'جارٍ التحقق…' : 'تأكيد كلمة المرور'}
            </button>

            <button
              className="text-link auth-dialog__link auth-dialog__switch"
              type="button"
              onClick={onCancel}
              disabled={isBusy}
            >
              إلغاء الإجراء
            </button>
          </form>
        )}

        {view === 'second-factor' && secondFactor !== null && (
          <form
            className="auth-dialog__form"
            onSubmit={(event) => void handleCodeSubmit(event)}
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

            <ReauthField
              label="رمز التحقق"
              name="verificationCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              value={code}
              onChange={(value) => {
                setCode(value)

                if (fieldError?.field === 'verificationCode') {
                  setFieldError(null)
                }
              }}
              inputRef={codeRef}
              error={visibleFieldError('verificationCode')}
            />

            <button
              className="btn btn--primary btn--lg"
              type="submit"
              aria-disabled={isBusy || undefined}
            >
              {isBusy ? 'جارٍ التحقق…' : 'التحقق والمتابعة'}
            </button>

            <button
              className="text-link auth-dialog__link auth-dialog__switch"
              type="button"
              onClick={() => leaveSecondFactor()}
              disabled={isBusy}
            >
              العودة إلى كلمة المرور
            </button>
          </form>
        )}

        {view === 'confirmed' && (
          <div className="auth-dialog__form">
            <button
              className="btn btn--primary btn--lg"
              type="button"
              onClick={onContinue}
              data-initial-focus=""
            >
              متابعة
            </button>

            <button
              className="text-link auth-dialog__link auth-dialog__switch"
              type="button"
              onClick={onCancel}
            >
              إلغاء الإجراء
            </button>
          </div>
        )}

        {/* Persistent live regions: only their content changes, which
            screen readers announce reliably. */}
        <div className="auth-dialog__feedback">
          <div role="alert" aria-atomic="true">
            {feedback?.tone === 'danger' && (
              <div className="notice notice--danger">
                <StatusIcon tone="danger" className="notice__icon" />
                <p>{feedback.message}</p>
              </div>
            )}
          </div>

          <div role="status" aria-atomic="true">
            {feedback?.tone === 'success' && (
              <div className="notice notice--success">
                <StatusIcon tone="success" className="notice__icon" />
                <p>{feedback.message}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
