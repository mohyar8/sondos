import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { flushSync } from 'react-dom'
import { useAuth, type TotpEnrollment } from '../../auth/auth-context'
import { toAsciiDigits } from '../../lib/ascii-digits'
import AdminIcon from './AdminIcon'
import { formatAdminTimestamp } from './format'
import './AdminSecurityPanel.css'

interface AdminSecurityPanelProps {
  /**
   * Called once she has confirmed her identity with her authenticator app
   * (a fresh sign-in: password, then the code), e.g. to reload what a 403
   * ADMIN_MFA_REQUIRED refused.
   */
  onIdentityConfirmed?: () => void
}

type PendingStep = 'start' | 'finish' | 'confirm'
type FocusTarget = 'steps' | 'start' | 'confirm'

interface Feedback {
  tone: 'success' | 'danger' | 'info'
  message: string
}

const TOTP_FACTOR_ID = 'totp'
const OTPAUTH_PREFIX = 'otpauth://totp/'

/** The base32 key in groups of four, easier to read and type into an app. */
function groupSecretKey(secretKey: string): string {
  return secretKey.match(/.{1,4}/g)?.join(' ') ?? secretKey
}

/** The code as she typed or pasted it: Arabic digits mapped, spaces dropped. */
function normalizeCode(value: string): string {
  return toAsciiDigits(value).replace(/\s/g, '')
}

/**
 * Adds an authenticator app (TOTP second factor) to the signed-in admin
 * account (audit SEC-02, C-6). No QR library: the key and the otpauth link
 * are shown as text to copy into the app, or opened directly on a phone.
 * The key is held only in memory while she enrolls and is dropped when she
 * finishes, cancels or leaves. Firebase itself refuses the enrollment when
 * the project has not enabled TOTP; that case gets its own message.
 *
 * Once an app is enrolled, «تأكيد الهوية بتطبيق المصادقة» signs her in
 * again with it, so a session from before (or without) the app gains the
 * second factor that ADMIN_REQUIRE_MFA asks for. Whoever mounts the panel
 * keeps it mounted through enrollment: its own view switches to that
 * button and focus follows.
 */
export default function AdminSecurityPanel({
  onIdentityConfirmed,
}: AdminSecurityPanelProps) {
  const {
    secondFactors,
    startTotpEnrollment,
    finishTotpEnrollment,
    cancelTotpEnrollment,
    requestReauthentication,
  } = useAuth()
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null)
  const [pendingStep, setPendingStep] = useState<PendingStep | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{
    target: FocusTarget
    sequence: number
  } | null>(null)
  const pendingStepRef = useRef<PendingStep | null>(null)
  const isMountedRef = useRef(true)
  const stepsHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const startButtonRef = useRef<HTMLButtonElement | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const stepsTitleId = useId()
  const codeFieldId = useId()
  const codeErrorId = useId()
  const codeHintId = useId()
  const secretId = useId()
  const linkId = useId()

  const totpFactors = secondFactors.filter(
    (factor) => factor.factorId === TOTP_FACTOR_ID,
  )
  const isBusy = pendingStep !== null
  const otpauthUrl =
    enrollment !== null && enrollment.otpauthUrl.startsWith(OTPAUTH_PREFIX)
      ? enrollment.otpauthUrl
      : null

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  // The key never outlives the panel that showed it.
  useEffect(() => {
    if (enrollment === null) {
      return
    }

    const enrollmentId = enrollment.id

    return () => cancelTotpEnrollment(enrollmentId)
  }, [cancelTotpEnrollment, enrollment])

  useEffect(() => {
    if (focusRequest === null) {
      return
    }

    // The start and confirm buttons stand in for each other: which one is
    // shown follows the enrolled factors, not the step she just finished.
    const animationFrame = window.requestAnimationFrame(() => {
      const target =
        focusRequest.target === 'steps'
          ? stepsHeadingRef.current
          : focusRequest.target === 'confirm'
            ? (confirmButtonRef.current ?? startButtonRef.current)
            : (startButtonRef.current ?? confirmButtonRef.current)

      target?.focus()
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [focusRequest])

  function requestFocus(target: FocusTarget) {
    setFocusRequest((current) => ({
      target,
      sequence: (current?.sequence ?? 0) + 1,
    }))
  }

  function beginStep(step: PendingStep): boolean {
    if (pendingStepRef.current !== null) {
      return false
    }

    pendingStepRef.current = step
    setPendingStep(step)
    setFeedback(null)
    setCodeError(null)
    setCopyStatus(null)

    return true
  }

  function endStep() {
    pendingStepRef.current = null
    setPendingStep(null)
  }

  // Commits the error first, so the field already carries aria-invalid and
  // its message when focus lands on it.
  function rejectCode(form: HTMLFormElement, message: string) {
    flushSync(() => {
      endStep()
      setCodeError(message)
    })
    form
      .querySelector<HTMLInputElement>('input[name="verificationCode"]')
      ?.focus()
  }

  async function startEnrollment() {
    if (!beginStep('start')) {
      return
    }

    const result = await startTotpEnrollment()

    if (!isMountedRef.current) {
      return
    }

    endStep()

    if (!result.ok) {
      setFeedback({ tone: 'danger', message: result.error.message })
      return
    }

    setEnrollment(result.enrollment)
    requestFocus('steps')
  }

  async function handleCodeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const form = event.currentTarget

    if (enrollment === null || !beginStep('finish')) {
      return
    }

    const value = new FormData(form).get('verificationCode')
    const code = normalizeCode(typeof value === 'string' ? value : '')

    if (code.length !== enrollment.codeLength || !/^\d+$/.test(code)) {
      rejectCode(
        form,
        `أدخلي الرمز المكوّن من ${enrollment.codeLength} أرقام كما يظهر في التطبيق.`,
      )
      return
    }

    const result = await finishTotpEnrollment(enrollment.id, code)

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok && result.error.code === 'INVALID_VERIFICATION_CODE') {
      rejectCode(form, result.error.message)
      return
    }

    endStep()

    if (!result.ok) {
      if (result.error.code === 'MFA_SESSION_EXPIRED') {
        setEnrollment(null)
        requestFocus('start')
      }

      setFeedback({ tone: 'danger', message: result.error.message })
      return
    }

    // The status region announces it; focus moves on to the next step,
    // «تأكيد الهوية بتطبيق المصادقة».
    setEnrollment(null)
    setFeedback({
      tone: 'success',
      message:
        'تم تفعيل التحقق بخطوتين، وسيُطلب منكِ رمز من تطبيق المصادقة عند كل تسجيل دخول. ولاستخدامه في جلسة الدخول الحالية، أكّدي هويتكِ بالزر «تأكيد الهوية بتطبيق المصادقة».',
    })
    requestFocus('confirm')
  }

  async function confirmIdentity() {
    if (!beginStep('confirm')) {
      return
    }

    // Her account has an authenticator app, so the prompt asks for her
    // password and then its code, and the fresh token carries the factor.
    // The prompt hands focus back to this button when it closes.
    const confirmed = await requestReauthentication()

    if (!isMountedRef.current) {
      return
    }

    endStep()

    if (!confirmed) {
      setFeedback({
        tone: 'info',
        message:
          'لم يكتمل تأكيد الهوية، لذلك بقيت الجلسة كما هي. أعيدي المحاولة عندما تكونين مستعدة.',
      })
      return
    }

    setFeedback({
      tone: 'success',
      message:
        'تم تأكيد هويتكِ بتطبيق المصادقة. يمكنكِ الآن إعادة الإجراء الذي طلبتِه.',
    })
    onIdentityConfirmed?.()
  }

  function cancelEnrollment() {
    if (enrollment === null || isBusy) {
      return
    }

    setEnrollment(null)
    setCodeError(null)
    setCopyStatus(null)
    setFeedback({
      tone: 'info',
      message: 'أُلغي التفعيل. إن كنتِ أضفتِ الحساب إلى التطبيق، فاحذفيه منه.',
    })
    requestFocus('start')
  }

  async function copyText(text: string, successMessage: string) {
    setCopyStatus(null)

    if (!('clipboard' in navigator)) {
      setCopyStatus('النسخ التلقائي غير متاح في هذا المتصفح. حدّدي النص وانسخيه يدويًا.')
      return
    }

    try {
      await navigator.clipboard.writeText(text)

      if (isMountedRef.current) {
        setCopyStatus(successMessage)
      }
    } catch (error: unknown) {
      // writeText rejects with a DOMException (NotAllowedError) when the
      // browser refuses; anything else is a bug, reported without logging
      // the copied text.
      if (!(error instanceof DOMException)) {
        reportError(error)
      }

      if (isMountedRef.current) {
        setCopyStatus('تعذر النسخ تلقائيًا. حدّدي النص وانسخيه يدويًا.')
      }
    }
  }

  return (
    <section
      className="admin-panel admin-security"
      aria-labelledby={titleId}
    >
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">أمان الحساب</p>
          <h2 id={titleId}>التحقق بخطوتين</h2>
        </div>
      </div>

      {/* Persistent live regions: only their content changes, which screen
          readers announce reliably (a freshly inserted region often is
          not). Focus never moves to them. */}
      <div className="admin-security__feedback">
        <div role="alert" aria-atomic="true">
          {feedback?.tone === 'danger' && (
            <p className="notice notice--danger admin-notice">
              <AdminIcon className="notice__icon" name="alert" />
              <span>{feedback.message}</span>
            </p>
          )}
        </div>

        <div role="status" aria-atomic="true">
          {feedback && feedback.tone !== 'danger' && (
            <p className={`notice notice--${feedback.tone} admin-notice`}>
              <AdminIcon
                className="notice__icon"
                name={feedback.tone === 'success' ? 'check' : 'info'}
              />
              <span>{feedback.message}</span>
            </p>
          )}
        </div>
      </div>

      {totpFactors.length > 0 && enrollment === null && (
        <div className="admin-security__status">
          <p className="admin-security__lead">
            التحقق بخطوتين مفعّل لحسابكِ: بعد كلمة المرور يُطلب رمز من تطبيق
            المصادقة على جوالكِ.
          </p>
          <ul className="admin-security__factors">
            {totpFactors.map((factor) => (
              <li key={factor.uid}>
                <bdi dir="auto">{factor.displayName ?? 'تطبيق المصادقة'}</bdi>
                <span className="admin-muted">
                  {' '}
                  — أُضيف في{' '}
                  <span className="admin-number">
                    {formatAdminTimestamp(factor.enrollmentTime)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="admin-security__lead">
            إن طلبت لوحة الإدارة التحقق بخطوتين لجلسة الدخول الحالية، فأكّدي
            هويتكِ بكلمة المرور ثم برمز التطبيق، وبعدها أعيدي الإجراء الذي
            طلبتِه.
          </p>
          <button
            className="btn btn--primary"
            ref={confirmButtonRef}
            type="button"
            onClick={() => void confirmIdentity()}
            aria-disabled={isBusy || undefined}
          >
            {pendingStep === 'confirm'
              ? 'جارٍ تأكيد الهوية…'
              : 'تأكيد الهوية بتطبيق المصادقة'}
          </button>
        </div>
      )}

      {totpFactors.length === 0 && enrollment === null && (
        <div className="admin-security__intro">
          <p className="admin-security__lead">
            يحمي التحقق بخطوتين بيانات العميلات حتى لو عرف أحدٌ كلمة مروركِ:
            بعد كلمة المرور يُطلب رمز من ستة أرقام يتجدد كل 30 ثانية في تطبيق
            مصادقة على جوالكِ.
          </p>
          <button
            className="btn btn--primary"
            ref={startButtonRef}
            type="button"
            onClick={() => void startEnrollment()}
            aria-disabled={isBusy || undefined}
          >
            {pendingStep === 'start'
              ? 'جارٍ التحضير…'
              : 'تفعيل التحقق بخطوتين'}
          </button>
        </div>
      )}

      {enrollment !== null && (
        <section
          className="admin-security__enrollment"
          aria-labelledby={stepsTitleId}
        >
          <h3
            className="admin-security__steps-title"
            id={stepsTitleId}
            ref={stepsHeadingRef}
            tabIndex={-1}
          >
            خطوات إضافة تطبيق المصادقة
          </h3>

          <ol className="admin-security__steps">
            <li>
              <p>
                ثبّتي على جوالكِ تطبيق مصادقة، مثل{' '}
                <bdi className="admin-security__app-name" dir="ltr">
                  Google Authenticator
                </bdi> أو{' '}
                <bdi className="admin-security__app-name" dir="ltr">
                  Microsoft Authenticator
                </bdi>
                .
              </p>
            </li>

            <li>
              <p>
                أضيفي في التطبيق حسابًا جديدًا بإدخال المفتاح السري التالي
                يدويًا (نوع الرمز: حسب الوقت). وإن كنتِ تفتحين هذه الصفحة على
                الجوال نفسه، فافتحي رابط الإعداد مباشرة في التطبيق.
              </p>

              <div className="admin-security__secret">
                <span className="admin-muted" id={secretId}>
                  المفتاح السري
                </span>
                <code
                  className="admin-security__code"
                  dir="ltr"
                  aria-labelledby={secretId}
                >
                  {groupSecretKey(enrollment.secretKey)}
                </code>
                <button
                  className="btn btn--secondary"
                  type="button"
                  onClick={() =>
                    void copyText(enrollment.secretKey, 'تم نسخ المفتاح السري.')
                  }
                >
                  نسخ المفتاح
                </button>
              </div>

              {otpauthUrl !== null && (
                <div className="admin-security__secret">
                  <span className="admin-muted" id={linkId}>
                    رابط الإعداد (يمكن تحويله إلى رمز QR)
                  </span>
                  <code
                    className="admin-security__code admin-security__code--url"
                    dir="ltr"
                    aria-labelledby={linkId}
                  >
                    {otpauthUrl}
                  </code>
                  <div className="admin-security__actions">
                    <button
                      className="btn btn--secondary"
                      type="button"
                      onClick={() =>
                        void copyText(otpauthUrl, 'تم نسخ رابط الإعداد.')
                      }
                    >
                      نسخ الرابط
                    </button>
                    <a className="btn btn--ghost" href={otpauthUrl}>
                      فتح في تطبيق المصادقة
                    </a>
                  </div>
                </div>
              )}

              <p className="admin-muted" role="status">
                {copyStatus ?? ''}
              </p>
            </li>

            <li>
              <form
                className="admin-security__form"
                onSubmit={(event) => void handleCodeSubmit(event)}
                noValidate
              >
                <div className={codeError ? 'field field--error' : 'field'}>
                  <label className="field__label" htmlFor={codeFieldId}>
                    الرمز الظاهر الآن في التطبيق
                  </label>
                  <input
                    className="input admin-security__code-input"
                    id={codeFieldId}
                    name="verificationCode"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    dir="ltr"
                    maxLength={12}
                    required
                    aria-invalid={codeError ? true : undefined}
                    aria-describedby={
                      codeError ? `${codeHintId} ${codeErrorId}` : codeHintId
                    }
                    onChange={() => setCodeError(null)}
                  />
                  <span className="field__hint" id={codeHintId}>
                    {`أكملي التفعيل قبل ${formatAdminTimestamp(enrollment.completeBy)}.`}
                  </span>
                  {codeError && (
                    <p className="field__error" id={codeErrorId}>
                      <AdminIcon className="admin-button-icon" name="alert" />
                      <span>{codeError}</span>
                    </p>
                  )}
                </div>

                <div className="admin-security__actions">
                  <button
                    className="btn btn--primary"
                    type="submit"
                    aria-disabled={isBusy || undefined}
                  >
                    {pendingStep === 'finish'
                      ? 'جارٍ التأكيد…'
                      : 'تأكيد التفعيل'}
                  </button>
                  <button
                    className="btn btn--ghost"
                    type="button"
                    onClick={cancelEnrollment}
                    disabled={isBusy}
                  >
                    إلغاء
                  </button>
                </div>
              </form>
            </li>
          </ol>

          <p className="admin-muted">
            لا تشاركي المفتاح السري أو الرابط مع أحد، ولا تحفظيهما في مكان
            آخر؛ لن يُعرضا مرة أخرى بعد التفعيل.
          </p>
        </section>
      )}
    </section>
  )
}
