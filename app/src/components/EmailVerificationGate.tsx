import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import {
  useAuth,
  type AuthError,
  type VerificationEmailState,
} from '../auth/auth-context'
import { NEW_TAB_HINT } from '../layout/social-links'
import { buildWhatsAppUrl } from '../lib/whatsapp'
import './EmailVerificationGate.css'

type GateAction = 'check' | 'resend' | 'sign-out'
type FeedbackTone = 'success' | 'error' | 'notice'
// 'context' = an error that reached the gate through the auth context rather
// than from one of the gate's own buttons (e.g. the verification email that
// registration sends automatically could not be sent, or the profile could
// not be loaded).
type FeedbackOrigin = GateAction | 'context'

interface FeedbackMessage {
  tone: FeedbackTone
  text: string
  origin: FeedbackOrigin
}

const RESEND_COOLDOWN_SECONDS = 60

const SUPPORT_URL = buildWhatsAppUrl(
  'السلام عليكم، أحتاج مساعدة في تأكيد البريد الإلكتروني لحسابي في موقع المصورة سندس يار.',
)

// One description per `verificationEmail` status (auth context), so the page
// never claims a link was sent before, or unless, the send succeeded.
const SENT_DESCRIPTION =
  'أرسلنا رابط تأكيد إلى بريدكِ الإلكتروني. افتحي الرسالة واضغطي رابط التأكيد، ثم عودي إلى هذه الصفحة واضغطي «تحققت من البريد».'
// The first link, sent by registration while this page is already showing.
const FIRST_SENDING_DESCRIPTION =
  'جارٍ إرسال رابط التأكيد إلى بريدكِ الإلكتروني…'
const SENDING_DESCRIPTION =
  'جارٍ إرسال رابط تأكيد جديد إلى بريدكِ الإلكتروني…'
// No send in this session (a returning account that is still unverified):
// nothing is known about delivery, so nothing is claimed.
const UNCONFIRMED_DESCRIPTION =
  'لم يُؤكَّد بريدكِ الإلكتروني بعد. افتحي أحدث رسالة تأكيد وصلتكِ منّا واضغطي رابط التأكيد، ثم عودي إلى هذه الصفحة واضغطي «تحققت من البريد». إذا لم تجدي الرسالة، أعيدي إرسالها.'
const SEND_FAILED_DESCRIPTION =
  'لم نتمكن من التأكد من إرسال رابط التأكيد إلى بريدكِ الإلكتروني. أعيدي إرسال الرسالة، ثم افتحيها واضغطي رابط التأكيد، وعودي إلى هذه الصفحة واضغطي «تحققت من البريد».'

// Design system §2.3: Western digits for anything transactional — a
// countdown is exactly that, so the numbering system is pinned to Latin
// instead of relying on `ar-SA`'s Eastern-Arabic default.
const westernNumberFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn', {
  maximumFractionDigits: 0,
})

// Number agreement after «بعد» (08-copy-ar §4.3): ثانية واحدة / ثانيتين /
// 3–10 ثوانٍ / 11+ ثانية.
function formatSecondsAfter(seconds: number): string {
  if (seconds === 1) {
    return 'ثانية واحدة'
  }

  if (seconds === 2) {
    return 'ثانيتين'
  }

  const digits = westernNumberFormatter.format(seconds)

  return seconds >= 3 && seconds <= 10
    ? `${digits} ثوانٍ`
    : `${digits} ثانية`
}

function getStatusDescription(
  status: VerificationEmailState['status'],
): string {
  switch (status) {
    case 'idle':
      return UNCONFIRMED_DESCRIPTION
    case 'sending':
      return FIRST_SENDING_DESCRIPTION
    case 'sent':
      return SENT_DESCRIPTION
    case 'failed':
      return SEND_FAILED_DESCRIPTION
  }
}

function getNoticeClassName(tone: FeedbackTone): string {
  switch (tone) {
    case 'success':
      return 'notice notice--success'
    case 'error':
      return 'notice notice--danger'
    case 'notice':
      return 'notice notice--info'
  }
}

function NoticeIcon({ tone }: { tone: FeedbackTone }) {
  if (tone === 'error') {
    return (
      <svg
        className="notice__icon"
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
        className="notice__icon"
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
      className="notice__icon"
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

export default function EmailVerificationGate() {
  const {
    firebaseUser,
    profile,
    authError,
    verificationEmail,
    sendVerificationEmail,
    checkEmailVerification,
    signOutUser,
  } = useAuth()
  // Result of the gate's own last action.
  const [feedback, setFeedback] = useState<FeedbackMessage | null>(null)
  const [pendingAction, setPendingAction] = useState<GateAction | null>(null)
  // The error object the gate's own last action produced. The context mirrors
  // every action error into `authError` as the very same object, so this is
  // how a context error is told apart from one the gate did not cause.
  const [ownError, setOwnError] = useState<AuthError | null>(null)
  const [cooldownEndsAt, setCooldownEndsAt] =
    useState<number | null>(null)
  const [
    remainingCooldownSeconds,
    setRemainingCooldownSeconds,
  ] = useState(0)
  const titleId = useId()
  const descriptionId = useId()
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const feedbackRef = useRef<HTMLDivElement | null>(null)
  const isMountedRef = useRef(true)
  const pendingActionRef = useRef<GateAction | null>(null)

  const registeredEmail =
    firebaseUser?.email ??
    profile?.email ??
    'البريد المسجل غير متوفر'
  const isBusy = pendingAction !== null
  const isChecking = pendingAction === 'check'
  const isResending = pendingAction === 'resend'
  const isSigningOut = pendingAction === 'sign-out'
  const isCoolingDown = remainingCooldownSeconds > 0
  // Registration's own send may still be in flight when the gate mounts.
  const isSendInFlight = verificationEmail.status === 'sending'

  // Inspection #8a: the gate mounts as soon as the new account signs in,
  // BEFORE registration has sent the verification email, so it must never
  // assume the link left. It reads the send's real status from the context
  // (`verificationEmail`), which stays "failed" — with its reason — until
  // another send starts, whatever other actions do to `authError`.
  const deliveryError =
    verificationEmail.status === 'failed' ? verificationEmail.error : null
  // Any other context error (e.g. the profile could not be loaded) is shown
  // as it is, without implying that the email was not sent.
  const externalError =
    authError !== null &&
    authError !== ownError &&
    authError !== deliveryError &&
    !isBusy
      ? authError
      : null

  const errorFeedback: FeedbackMessage | null =
    feedback?.tone === 'error'
      ? feedback
      : externalError !== null
        ? { tone: 'error', text: externalError.message, origin: 'context' }
        : deliveryError !== null
          ? { tone: 'error', text: deliveryError.message, origin: 'context' }
          : null
  const statusFeedback =
    feedback !== null && feedback.tone !== 'error' ? feedback : null
  const isContextErrorShown = errorFeedback?.origin === 'context'
  const description = isResending
    ? SENDING_DESCRIPTION
    : getStatusDescription(verificationEmail.status)
  const resendLabel = isResending
    ? 'جارٍ إعادة الإرسال…'
    : isCoolingDown
      ? `إعادة الإرسال بعد ${formatSecondsAfter(remainingCooldownSeconds)}`
      : 'إعادة إرسال رسالة التحقق'
  const retryLabel = isResending
    ? 'جارٍ إعادة الإرسال…'
    : isCoolingDown
      ? `إعادة المحاولة بعد ${formatSecondsAfter(remainingCooldownSeconds)}`
      : 'إعادة محاولة الإرسال'

  // Ends the running action and commits its result before focusing it, so
  // the focused notice already holds the new text when it is read out.
  // `commitAlongside` lands related state in the same commit.
  const showFeedback = useCallback(
    (message: FeedbackMessage, commitAlongside?: () => void) => {
      flushSync(() => {
        pendingActionRef.current = null
        setPendingAction(null)
        setFeedback(message)
        commitAlongside?.()
      })
      feedbackRef.current?.focus()
    },
    [],
  )

  useEffect(() => {
    isMountedRef.current = true

    // The gate can mount underneath the open account dialog (a new account
    // signs in while registration is still running); never pull focus out
    // of a modal dialog.
    const activeElement = document.activeElement
    const isFocusInModalDialog =
      activeElement instanceof HTMLElement &&
      activeElement.closest('[aria-modal="true"]') !== null

    if (!isFocusInModalDialog) {
      headingRef.current?.focus()
    }

    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (cooldownEndsAt === null) {
      return
    }

    const intervalId = window.setInterval(() => {
      const nextRemaining = Math.max(
        0,
        Math.ceil((cooldownEndsAt - Date.now()) / 1000),
      )

      setRemainingCooldownSeconds(nextRemaining)

      if (nextRemaining === 0) {
        window.clearInterval(intervalId)
      }
    }, 1000)

    return () => window.clearInterval(intervalId)
  }, [cooldownEndsAt])

  function beginAction(action: GateAction): boolean {
    if (pendingActionRef.current !== null) {
      return false
    }

    pendingActionRef.current = action
    setPendingAction(action)
    setFeedback(null)

    return true
  }

  function finishAction() {
    pendingActionRef.current = null
    setPendingAction(null)
  }

  async function handleCheckVerification() {
    if (!beginAction('check')) {
      return
    }

    const result = await checkEmailVerification()

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      const { error } = result

      showFeedback(
        { tone: 'error', text: error.message, origin: 'check' },
        () => setOwnError(error),
      )
      return
    }

    if (!result.verified) {
      showFeedback({
        tone: 'notice',
        text: 'لم يكتمل تأكيد البريد بعد. افتحي رابط التأكيد في الرسالة ثم حاولي مرة أخرى.',
        origin: 'check',
      })
      return
    }

    showFeedback({
      tone: 'success',
      text: 'تم تأكيد البريد الإلكتروني بنجاح. جارٍ نقلكِ إلى حسابكِ.',
      origin: 'check',
    })
  }

  async function handleResendVerification() {
    if (isCoolingDown || isSendInFlight || !beginAction('resend')) {
      return
    }

    const result = await sendVerificationEmail()

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      const { error } = result

      showFeedback(
        { tone: 'error', text: error.message, origin: 'resend' },
        () => setOwnError(error),
      )
      return
    }

    const nextCooldownEndsAt =
      Date.now() + RESEND_COOLDOWN_SECONDS * 1000

    showFeedback(
      {
        tone: 'success',
        text: 'أرسلنا رسالة تأكيد جديدة إلى بريدكِ الإلكتروني.',
        origin: 'resend',
      },
      () => {
        setCooldownEndsAt(nextCooldownEndsAt)
        setRemainingCooldownSeconds(RESEND_COOLDOWN_SECONDS)
      },
    )
  }

  async function handleSignOut() {
    if (!beginAction('sign-out')) {
      return
    }

    const result = await signOutUser()

    if (!isMountedRef.current) {
      return
    }

    if (!result.ok) {
      const { error } = result

      showFeedback(
        { tone: 'error', text: error.message, origin: 'sign-out' },
        () => setOwnError(error),
      )
      return
    }

    finishAction()
  }

  function renderNotice(message: FeedbackMessage) {
    return (
      <div
        className={getNoticeClassName(message.tone)}
        ref={feedbackRef}
        tabIndex={-1}
        // When the account dialog closes and cannot return focus to the
        // (now inert) page behind this gate, it focuses the element carrying
        // this attribute: this error when it came from the context, the page
        // heading otherwise.
        data-auth-return-focus={message.origin === 'context' ? '' : undefined}
      >
        <NoticeIcon tone={message.tone} />
        <p>{message.text}</p>
      </div>
    )
  }

  return (
    <main className="email-verification" dir="rtl">
      <section
        className="card email-verification__card"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <p className="email-verification__brand">
          المصورة سندس يار
        </p>
        <p className="eyebrow email-verification__eyebrow">
          خطوة حماية الحساب
        </p>

        <h1
          className="email-verification__title"
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          data-auth-return-focus={isContextErrorShown ? undefined : ''}
        >
          تأكيد البريد الإلكتروني
        </h1>

        <p
          className="email-verification__description"
          id={descriptionId}
        >
          {description}
        </p>

        <p className="email-verification__email">
          <span className="email-verification__email-label">
            البريد المسجل
          </span>
          <bdi className="email-verification__email-value">
            {registeredEmail}
          </bdi>
        </p>

        <div className="email-verification__instructions">
          <h2>قبل المتابعة</h2>
          <ul>
            <li>
              تحققي من صندوق الوارد في بريدكِ الإلكتروني.
            </li>
            <li>
              راجعي مجلد الرسائل غير المرغوب فيها أو Spam/Junk.
            </li>
            <li>
              افتحي أحدث رسالة إذا طلبتِ إعادة الإرسال أكثر من مرة.
            </li>
          </ul>
        </div>

        <p className="email-verification__wrong-email">
          إذا كان البريد غير صحيح، سجّلي الخروج وأنشئي حسابًا
          جديدًا بالبريد الصحيح.
        </p>

        {/* Persistent live regions: only their content changes, which screen
            readers announce reliably (a freshly inserted region often is
            not). */}
        <div className="email-verification__feedback">
          <div role="alert" aria-atomic="true">
            {errorFeedback !== null && renderNotice(errorFeedback)}
          </div>

          <div role="status" aria-atomic="true">
            {statusFeedback !== null && renderNotice(statusFeedback)}
          </div>

          {deliveryError !== null && (
            <button
              className="btn btn--secondary email-verification__retry"
              type="button"
              onClick={() => void handleResendVerification()}
              disabled={isBusy || isCoolingDown || isSendInFlight}
            >
              {retryLabel}
            </button>
          )}
        </div>

        <div className="email-verification__actions">
          <button
            className="btn btn--primary btn--lg"
            type="button"
            onClick={() => void handleCheckVerification()}
            disabled={isBusy}
          >
            {isChecking
              ? 'جارٍ التحقق من البريد…'
              : 'تحققت من البريد'}
          </button>

          <button
            className="btn btn--secondary btn--lg"
            type="button"
            onClick={() => void handleResendVerification()}
            disabled={isBusy || isCoolingDown || isSendInFlight}
          >
            {resendLabel}
          </button>

          <button
            className="btn btn--ghost email-verification__sign-out"
            type="button"
            onClick={() => void handleSignOut()}
            disabled={isBusy}
          >
            {isSigningOut
              ? 'جارٍ تسجيل الخروج…'
              : 'تسجيل الخروج'}
          </button>
        </div>

        <p className="email-verification__support">
          هل تحتاجين إلى مساعدة؟{' '}
          <a
            className="email-verification__support-link"
            href={SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            تواصلي معنا عبر واتساب
            <span className="email-verification__visually-hidden">
              {' '}
              {NEW_TAB_HINT}
            </span>
          </a>
        </p>
      </section>
    </main>
  )
}
