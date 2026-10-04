import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  AdminBookingAction,
  AdminBookingDetail,
  BookingStatus,
} from '../../shared/admin'
import {
  ADMIN_MFA_REQUIRED_CODE,
  ADMIN_MFA_REQUIRED_MESSAGE,
  getAdminLimitMessage,
  performAdminBookingAction,
  updateAdminBookingNotes,
  type AdminApiError,
  type AdminSession,
} from '../api/admin'
import { useAuth } from '../auth/auth-context'
import AdminIcon from '../features/admin-portal/AdminIcon'
import {
  formatAdminCalendarDate,
  formatCustomerName,
  formatCustomerText,
} from '../features/admin-portal/format'
import {
  ADMIN_STACKED_LAYOUT_QUERY,
  useMediaQuery,
} from '../features/admin-portal/use-media-query'
import { WhatsAppIcon } from '../layout/icons'
import { isTopmostModal } from '../lib/modal-stack'
import { getRiyadhToday, listenForPageReturn } from '../lib/riyadh-calendar'
import {
  WHATSAPP_INTERNATIONAL_NUMBER,
  buildWhatsAppUrl,
} from '../lib/whatsapp'
import './BookingActions.css'

interface BookingActionsProps {
  booking: AdminBookingDetail
  getIdToken: () => Promise<string | null>
  onBookingUpdated: (booking: AdminBookingDetail) => void
  onRefreshDetails: () => void
  onRefreshList: () => void
  /**
   * true while an action or a notes save is in flight, false once it settles
   * (or this component unmounts). The dashboard keeps the booking panel open
   * meanwhile, so Escape or «إغلاق التفاصيل» never cut a request off.
   */
  onBusyChange: (busy: boolean) => void
  /**
   * The detail panel's sticky bottom bar (design-system §5.8). On stacked
   * layouts (below 64rem) the status-change buttons render there, so they
   * stay in reach while the admin reads a long booking; wider layouts keep
   * them in this panel's own column.
   */
  stickyActionBar: HTMLElement | null
}

interface NotesEditorState {
  bookingId: string
  serverNotes: string
  draft: string
}

interface FeedbackMessage {
  bookingId: string
  message: string
}

interface ActionFeedback extends FeedbackMessage {
  /**
   * The Worker scheduled no status email to her (`customerEmailQueued:
   * false`), so the owner has to tell her herself.
   */
  customerNotEmailed: boolean
}

interface ActionConfirmationDialogProps {
  action: AdminBookingAction
  booking: AdminBookingDetail
  note: string
  errorMessage: string | null
  isSubmitting: boolean
  isActionStillAllowed: boolean
  /** Why the action can no longer be confirmed, or null. */
  unavailableMessage: string | null
  opener: HTMLButtonElement | null
  /** Receives focus when the opener no longer exists after the dialog closes. */
  fallbackFocusRef: RefObject<HTMLElement | null>
  onNoteChange: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
}

const MAXIMUM_TRANSITION_NOTE_LENGTH = 500
const MAXIMUM_ADMIN_NOTES_LENGTH = 2_000
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Unicode isolates keep a Latin run (a booking id) whole inside Arabic text. */
const LEFT_TO_RIGHT_ISOLATE = '\u2066'
/** The same for her name, whichever script it is written in (SEC-10). */
const FIRST_STRONG_ISOLATE = '\u2068'
const POP_DIRECTIONAL_ISOLATE = '\u2069'

const actionLabels: Record<AdminBookingAction, string> = {
  approve: 'قبول الطلب وحجز التاريخ',
  reject: 'رفض الطلب',
  mark_contract_sent: 'تم إرسال العقد',
  mark_contract_signed: 'تم استلام العقد الموقّع',
  request_payment: 'طلب تحويل العربون',
  confirm_payment: 'تأكيد استلام العربون',
  cancel: 'إلغاء الحجز',
}

/**
 * Audit SEC-19: the Worker never approves a request whose event date has
 * passed (409 EVENT_DATE_PASSED); rejecting it stays possible.
 */
const PAST_EVENT_APPROVAL_MESSAGE =
  'لا يمكن قبول الطلب لأن تاريخ المناسبة قد مضى. يمكنكِ رفضه بدلًا من ذلك.'

const actionDescriptions: Record<AdminBookingAction, string> = {
  approve:
    'سيؤدي قبول الطلب إلى حجز تاريخ المناسبة وجعله غير متاح للطلبات الأخرى.',
  reject:
    'رفض الطلب إجراء نهائي لهذه المرحلة، ولن يؤدي إلى تأكيد التاريخ أو حجزه.',
  mark_contract_sent:
    'استخدمي هذا الإجراء فقط بعد إرسال العقد فعليًا إلى العميلة بالطريقة المتفق عليها.',
  mark_contract_signed:
    'استخدمي هذا الإجراء فقط بعد استلام العقد الموقّع من العميلة والتحقق منه.',
  request_payment:
    'يجب إرسال تعليمات العربون وبيانات التحويل البنكي يدويًا عبر واتساب قبل تحديث هذه المرحلة.',
  confirm_payment:
    'تحققي من وصول التحويل البنكي فعليًا قبل تأكيد الحجز. لا تعتمدي على رسالة العميلة وحدها.',
  cancel:
    'سيؤدي إلغاء الحجز إلى إنهاء الطلب، وقد يصبح التاريخ متاحًا مرة أخرى إذا لم يوجد حجز آخر أو حجب يدوي.',
}

/** Pre-filled, editable WhatsApp text per status; addressed to the bride. */
const whatsappStageMessages: Record<BookingStatus, string> = {
  pending_review:
    'استلمنا طلبكِ عبر الموقع، وهو الآن قيد المراجعة، وسنتواصل معكِ بعد التحقق من التفاصيل.',
  approved_hold:
    'تم قبول طلبكِ مبدئيًا، وتاريخ مناسبتكِ محجوز لكِ مؤقتًا لاستكمال الخطوات التالية.',
  contract_pending:
    'أرسلنا إليكِ العقد، وننتظر توقيعكِ عليه وإعادته لاستكمال إجراءات الحجز.',
  contract_signed:
    'استلمنا العقد الموقّع، وسنتواصل معكِ لاستكمال الخطوة التالية.',
  payment_pending:
    'نرجو منكِ إكمال تحويل العربون المتفق عليه، ثم إرسال إشعار التحويل عبر واتساب لمراجعته.',
  confirmed: 'تم تأكيد حجزكِ بنجاح. نتطلع لتوثيق يومكِ بكل عناية.',
  rejected:
    'نعتذر منكِ، تعذّر قبول طلب الحجز لهذا التاريخ. يسعدنا تواصلكِ معنا عبر واتساب لأي استفسار.',
  cancelled:
    'تم إلغاء الحجز. تواصلي معنا عبر واتساب إن احتجتِ إلى أي توضيح.',
  expired:
    'انتهت مهلة طلب الحجز السابق. تواصلي معنا عبر واتساب لمعرفة الخيارات المتاحة.',
}

function isDestructiveAction(action: AdminBookingAction): boolean {
  return action === 'reject' || action === 'cancel'
}

function normalizeSaudiWhatsAppNumber(phone: string): string | null {
  const compactPhone = phone.replace(/[\s+()-]/g, '')

  if (/^05\d{8}$/.test(compactPhone)) {
    return `966${compactPhone.slice(1)}`
  }

  if (/^5\d{8}$/.test(compactPhone)) {
    return `966${compactPhone}`
  }

  if (/^9665\d{8}$/.test(compactPhone)) {
    return compactPhone
  }

  return null
}

/**
 * lib/whatsapp is the one wa.me builder (one base URL, one encoder), but it
 * always addresses the studio's own number. Here the admin writes TO the
 * customer, so only the recipient segment is swapped for her number. If the
 * helper's link ever stops having that shape, no link is offered rather than
 * a wrong one.
 */
function buildCustomerWhatsAppUrl(
  customerNumber: string,
  message: string,
): string | null {
  const url = new URL(buildWhatsAppUrl(message))

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'wa.me' ||
    url.pathname !== `/${WHATSAPP_INTERNATIONAL_NUMBER}`
  ) {
    return null
  }

  url.pathname = `/${customerNumber}`
  return url.toString()
}

function getMutationErrorMessage(
  error: AdminApiError,
  operation: 'action' | 'notes',
): string {
  // Rate limit, body cap, preview, a declined password prompt.
  const limitMessage = getAdminLimitMessage(error)

  if (limitMessage !== null) {
    return limitMessage
  }

  switch (error.code) {
    case ADMIN_MFA_REQUIRED_CODE:
      return ADMIN_MFA_REQUIRED_MESSAGE
    case 'EVENT_DATE_PASSED':
      return PAST_EVENT_APPROVAL_MESSAGE
    case 'DATE_UNAVAILABLE':
      return 'تعذر قبول الطلب لأن التاريخ محجوز بطلب آخر أو محجوب يدويًا.'
    case 'INVALID_STATUS_TRANSITION':
      return 'تغيّرت حالة الطلب بالفعل، لذلك سيتم تحديث التفاصيل قبل محاولة إجراء آخر.'
    // NOTES_TOO_LONG is the notes endpoint's code since unit D2; NOTE_TOO_LONG
    // stays for the action note (and for a Worker from before D2).
    case 'NOTES_TOO_LONG':
    case 'NOTE_TOO_LONG':
      return operation === 'notes'
        ? 'يجب ألا تتجاوز الملاحظات الداخلية 2000 حرف.'
        : 'يجب ألا تتجاوز ملاحظة الإجراء 500 حرف.'
    case 'BOOKING_NOT_FOUND':
      return 'لم يعد طلب الحجز موجودًا أو متاحًا.'
    case 'INVALID_BOOKING_ID':
      return 'مرجع طلب الحجز غير صالح. أغلقي التفاصيل ثم افتحي الطلب من القائمة.'
    case 'INVALID_ACTION':
      return 'هذا الإجراء غير صالح لحالة الطلب الحالية.'
    case 'INVALID_REQUEST_BODY':
      return 'تعذر التحقق من البيانات المدخلة. راجعيها ثم أعيدي المحاولة.'
    case 'UNAUTHENTICATED':
      return 'انتهت جلسة تسجيل الدخول. سجّلي الخروج ثم أعيدي تسجيل الدخول.'
    case 'FORBIDDEN':
      return 'لا يملك هذا الحساب صلاحية تنفيذ الإجراء الإداري.'
  }

  switch (error.kind) {
    case 'unauthenticated':
      return 'انتهت جلسة تسجيل الدخول. سجّلي الخروج ثم أعيدي تسجيل الدخول.'
    case 'forbidden':
      return 'لا يملك هذا الحساب صلاحية تنفيذ الإجراء الإداري.'
    case 'not-found':
      return 'لم يعد طلب الحجز موجودًا أو متاحًا.'
    case 'conflict':
      return 'تعارض هذا التحديث مع تغيير آخر على الطلب. حدّثي التفاصيل وحاولي مجددًا.'
    case 'invalid-request':
      return 'تعذر التحقق من البيانات المدخلة. راجعيها ثم أعيدي المحاولة.'
    case 'network':
      return 'تعذر الاتصال بالخدمة حاليًا. تحققي من الاتصال ثم أعيدي المحاولة.'
    case 'server':
      return 'تعذر حفظ التغيير حاليًا. أعيدي المحاولة بعد قليل.'
    case 'malformed-response':
      return 'وصل رد غير مكتمل من الخدمة. حدّثي التفاصيل قبل المحاولة مجددًا.'
    case 'aborted':
      return 'تم إيقاف الطلب قبل اكتماله.'
  }
}

function ActionConfirmationDialog({
  action,
  booking,
  note,
  errorMessage,
  isSubmitting,
  isActionStillAllowed,
  unavailableMessage,
  opener,
  fallbackFocusRef,
  onNoteChange,
  onConfirm,
  onCancel,
}: ActionConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const safeButtonRef = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const noteId = useId()
  const noteCounterId = useId()
  const isDestructive = isDestructiveAction(action)

  // Scroll lock, initial focus and focus return. A destructive action (reject,
  // cancel) opens on the SAFE button «تراجع», so a stray Enter never confirms
  // it; any other action opens on its confirm button. The dialog is keyed by
  // its action, so this runs once per opening.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const initialFocusTarget = isDestructive
      ? safeButtonRef.current
      : confirmButtonRef.current
    const fallbackFocusTarget = fallbackFocusRef.current

    document.body.style.overflow = 'hidden'

    const animationFrame = window.requestAnimationFrame(() => {
      initialFocusTarget?.focus()
    })

    return () => {
      window.cancelAnimationFrame(animationFrame)
      document.body.style.overflow = previousOverflow

      // Passive-effect cleanup runs after React has updated the DOM, so
      // isConnected is already accurate here.
      if (opener?.isConnected) {
        opener.focus()
      } else if (fallbackFocusTarget?.isConnected) {
        // The opener disappears when the action changed the status (its
        // button is no longer allowed): land on the actions heading.
        fallbackFocusTarget.focus()
      }
    }
  }, [fallbackFocusRef, isDestructive, opener])

  // The confirm button is disabled while the request runs, which drops focus
  // to <body>; the password prompt, when one opened, hands it back to this
  // dialog itself. Once the request settles with the dialog still open (an
  // error), focus returns to a button, by the same rule as the initial
  // focus: «تراجع» for a destructive action or one that can no longer be
  // confirmed, else the confirm button.
  const wasSubmittingRef = useRef(isSubmitting)

  useEffect(() => {
    const hasSettled = wasSubmittingRef.current && !isSubmitting

    wasSubmittingRef.current = isSubmitting

    if (!hasSettled) {
      return
    }

    // A frame later, so it runs after the password prompt's own focus return.
    const animationFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current

      if (!dialog || !isTopmostModal(dialog)) {
        return
      }

      const activeElement = document.activeElement

      if (activeElement !== dialog && dialog.contains(activeElement)) {
        return
      }

      const confirmButton = confirmButtonRef.current
      const focusTarget =
        !isDestructive && confirmButton && !confirmButton.disabled
          ? confirmButton
          : safeButtonRef.current

      focusTarget?.focus()
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [isDestructive, isSubmitting])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // The password prompt can open over this dialog while its request
      // runs; until it closes, the keyboard is the prompt's.
      if (dialogRef.current && !isTopmostModal(dialogRef.current)) {
        return
      }

      if (event.key === 'Escape') {
        if (event.isComposing) {
          return
        }

        // This dialog is the topmost layer, so it always consumes Escape
        // (defect #5): the booking panel's own Escape handler sees
        // defaultPrevented and leaves the panel open. While the request is
        // in flight Escape does nothing at all — it is never cut off.
        event.preventDefault()

        if (!isSubmitting) {
          onCancel()
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

    // Capture phase: this runs before every bubble-phase keydown listener on
    // the document (the dashboard's Escape handler included), whatever order
    // the two were added in.
    document.addEventListener('keydown', handleKeyDown, true)

    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [isSubmitting, onCancel])

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !isSubmitting) {
      onCancel()
    }
  }

  return createPortal(
    <div
      className="booking-action-dialog__backdrop"
      onMouseDown={handleBackdropMouseDown}
    >
      <div
        className="booking-action-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={isSubmitting || undefined}
        tabIndex={-1}
      >
        <header className="booking-action-dialog__header">
          <p className="booking-actions__eyebrow">تأكيد الإجراء</p>
          <h2 id={titleId}>{actionLabels[action]}</h2>
        </header>

        <p
          className={`notice ${
            isDestructive ? 'notice--danger' : 'notice--warning'
          } booking-action-dialog__description`}
          id={descriptionId}
        >
          <AdminIcon className="notice__icon" name="alert" />
          <span>{actionDescriptions[action]}</span>
        </p>

        <dl className="booking-action-dialog__summary">
          <div>
            <dt>مرجع الطلب</dt>
            <dd>
              <bdi className="booking-actions__reference" dir="ltr">
                {booking.id}
              </bdi>
            </dd>
          </div>
          <div>
            <dt>العميلة</dt>
            <dd>
              <bdi>{formatCustomerName(booking.customer)}</bdi>
            </dd>
          </div>
          <div>
            <dt>تاريخ المناسبة</dt>
            <dd>{formatAdminCalendarDate(booking.eventDate)}</dd>
          </div>
        </dl>

        <div className="field booking-action-dialog__field">
          <label className="field__label" htmlFor={noteId}>
            ملاحظة داخلية عن هذا الانتقال (اختيارية)
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={(event) => onNoteChange(event.currentTarget.value)}
            maxLength={MAXIMUM_TRANSITION_NOTE_LENGTH}
            rows={4}
            disabled={isSubmitting}
            aria-describedby={noteCounterId}
          />
          <span className="field__hint booking-actions__counter" id={noteCounterId}>
            <bdi dir="ltr">
              {note.length} / {MAXIMUM_TRANSITION_NOTE_LENGTH}
            </bdi>{' '}
            حرف
          </span>
        </div>

        {unavailableMessage && (
          <p className="notice notice--warning" role="alert">
            <AdminIcon className="notice__icon" name="alert" />
            <span>{unavailableMessage}</span>
          </p>
        )}

        {errorMessage && (
          <p className="notice notice--danger" role="alert">
            <AdminIcon className="notice__icon" name="alert" />
            <span>{errorMessage}</span>
          </p>
        )}

        {isSubmitting && (
          <p className="booking-action-dialog__progress" role="status">
            جارٍ تنفيذ الإجراء. لا تغلقي الصفحة حتى يكتمل.
          </p>
        )}

        <div className="booking-action-dialog__actions">
          <button
            className={`btn ${
              isDestructive
                ? 'booking-actions__button--destructive'
                : 'btn--primary'
            }`}
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting || !isActionStillAllowed}
          >
            {isSubmitting
              ? 'جارٍ التنفيذ…'
              : `تأكيد: ${actionLabels[action]}`}
          </button>
          <button
            className="btn btn--secondary"
            ref={safeButtonRef}
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            تراجع
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export default function BookingActions({
  booking,
  getIdToken,
  onBookingUpdated,
  onRefreshDetails,
  onRefreshList,
  onBusyChange,
  stickyActionBar,
}: BookingActionsProps) {
  const { requestReauthentication } = useAuth()
  // Lets an action or a notes save ask for her password again (401
  // REAUTH_REQUIRED) and retry once.
  const adminSession = useMemo<AdminSession>(
    () => ({ getIdToken, requestReauthentication }),
    [getIdToken, requestReauthentication],
  )
  const [activeAction, setActiveAction] =
    useState<AdminBookingAction | null>(null)
  const [transitionNote, setTransitionNote] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] =
    useState<ActionFeedback | null>(null)
  const [isActionSubmitting, setIsActionSubmitting] = useState(false)
  const [notesEditorState, setNotesEditorState] =
    useState<NotesEditorState | null>(null)
  const [notesSuccess, setNotesSuccess] =
    useState<FeedbackMessage | null>(null)
  const [notesError, setNotesError] =
    useState<FeedbackMessage | null>(null)
  const [isNotesSubmitting, setIsNotesSubmitting] = useState(false)
  const [actionOpener, setActionOpener] =
    useState<HTMLButtonElement | null>(null)
  // Today in Asia/Riyadh, re-read when she returns to the tab (a panel left
  // open past midnight) and after the Worker answers EVENT_DATE_PASSED.
  const [todayKey, setTodayKey] = useState(() => getRiyadhToday().key)
  const actionSubmissionRef = useRef(false)
  const notesSubmissionRef = useRef(false)
  const actionAbortControllerRef = useRef<AbortController | null>(null)
  const notesAbortControllerRef = useRef<AbortController | null>(null)
  const actionsHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const isMountedRef = useRef(true)
  const notesCounterId = useId()
  const actionBarLabelId = useId()
  const isStackedLayout = useMediaQuery(ADMIN_STACKED_LAYOUT_QUERY)
  const actionBarTarget = isStackedLayout ? stickyActionBar : null
  const isBusy = isActionSubmitting || isNotesSubmitting

  const serverNotes = booking.adminNotes ?? ''
  const currentNotesState =
    notesEditorState?.bookingId === booking.id &&
    notesEditorState.serverNotes === serverNotes
      ? notesEditorState
      : {
          bookingId: booking.id,
          serverNotes,
          draft: serverNotes,
        }
  const notesChanged =
    currentNotesState.draft !== currentNotesState.serverNotes
  const normalizedPhone = normalizeSaudiWhatsAppNumber(
    booking.customer.phone,
  )
  const greetingName = formatCustomerText(booking.customer.firstName)
  const whatsappMessage = [
    // A stored first name with nothing visible left is simply left out.
    greetingName
      ? `مرحبًا ${FIRST_STRONG_ISOLATE}${greetingName}${POP_DIRECTIONAL_ISOLATE}،`
      : 'مرحبًا،',
    `بخصوص طلب الحجز رقم ${LEFT_TO_RIGHT_ISOLATE}${booking.id}${POP_DIRECTIONAL_ISOLATE} لتاريخ ${formatAdminCalendarDate(booking.eventDate)}:`,
    whatsappStageMessages[booking.status],
    'مع تحيات المصورة سندس يار.',
  ].join('\n')
  const whatsappUrl = normalizedPhone
    ? buildCustomerWhatsAppUrl(normalizedPhone, whatsappMessage)
    : null
  const visibleActionSuccess =
    actionSuccess?.bookingId === booking.id ? actionSuccess : null
  const visibleNotesSuccess =
    notesSuccess?.bookingId === booking.id
      ? notesSuccess.message
      : null
  const visibleNotesError =
    notesError?.bookingId === booking.id
      ? notesError.message
      : null
  // Approving a past event date always fails on the Worker, so the button
  // is not offered; a notice says why.
  const isApprovalBlockedByDate =
    booking.allowedActions.includes('approve') &&
    booking.eventDate < todayKey
  const availableActions = isApprovalBlockedByDate
    ? booking.allowedActions.filter((action) => action !== 'approve')
    : booking.allowedActions
  const isActionStillAllowed = activeAction
    ? availableActions.includes(activeAction)
    : false
  // The date case is not repeated while the Worker's own answer to it is
  // already shown as the error.
  const actionUnavailableMessage =
    activeAction === null || isActionStillAllowed
      ? null
      : !booking.allowedActions.includes(activeAction)
        ? 'لم يعد هذا الإجراء متاحًا بعد تحديث حالة الطلب.'
        : actionError === null
          ? PAST_EVENT_APPROVAL_MESSAGE
          : null

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
      actionAbortControllerRef.current?.abort()
      notesAbortControllerRef.current?.abort()
    }
  }, [])

  useEffect(
    () => listenForPageReturn(() => setTodayKey(getRiyadhToday().key)),
    [],
  )

  // Tell the dashboard while a request is in flight; the cleanup reports the
  // end (or this component unmounting).
  useEffect(() => {
    if (!isBusy) {
      return
    }

    onBusyChange(true)

    return () => onBusyChange(false)
  }, [isBusy, onBusyChange])

  function openActionDialog(
    event: MouseEvent<HTMLButtonElement>,
    action: AdminBookingAction,
  ) {
    if (isActionSubmitting || isNotesSubmitting) {
      return
    }

    setActionOpener(event.currentTarget)
    setTransitionNote('')
    setActionError(null)
    setActionSuccess(null)
    setActiveAction(action)
  }

  function closeActionDialog() {
    if (isActionSubmitting) {
      return
    }

    setActiveAction(null)
    setTransitionNote('')
    setActionError(null)
  }

  async function submitAction() {
    if (
      !activeAction ||
      !isActionStillAllowed ||
      actionSubmissionRef.current
    ) {
      return
    }

    actionSubmissionRef.current = true
    setIsActionSubmitting(true)
    setActionError(null)

    const abortController = new AbortController()
    actionAbortControllerRef.current?.abort()
    actionAbortControllerRef.current = abortController

    const submittedAction = activeAction
    const normalizedNote = transitionNote.trim()
    const token = await getIdToken()

    if (!isMountedRef.current || abortController.signal.aborted) {
      return
    }

    if (!token) {
      setActionError(
        'تعذر التحقق من جلسة تسجيل الدخول. سجّلي الخروج ثم أعيدي تسجيل الدخول.',
      )
      setIsActionSubmitting(false)
      actionSubmissionRef.current = false
      return
    }

    const result = await performAdminBookingAction(
      token,
      booking.id,
      {
        action: submittedAction,
        ...(normalizedNote ? { note: normalizedNote } : {}),
      },
      abortController.signal,
      adminSession,
    )

    if (!isMountedRef.current || abortController.signal.aborted) {
      return
    }

    actionAbortControllerRef.current = null

    if (result.ok) {
      onBookingUpdated(result.data.booking)
      onRefreshList()
      setActionSuccess({
        bookingId: booking.id,
        message: `تم تنفيذ إجراء «${actionLabels[submittedAction]}» بنجاح.`,
        // null (a Worker from before the field) says nothing either way.
        customerNotEmailed: result.data.customerEmailQueued === false,
      })
      setActiveAction(null)
      setTransitionNote('')
    } else {
      setActionError(getMutationErrorMessage(result.error, 'action'))

      // The Worker's Riyadh date is the authority: re-read ours so the
      // approve button is withdrawn as well.
      if (result.error.code === 'EVENT_DATE_PASSED') {
        setTodayKey(getRiyadhToday().key)
      }

      if (result.error.code === 'INVALID_STATUS_TRANSITION') {
        onRefreshDetails()
        onRefreshList()
      }
    }

    setIsActionSubmitting(false)
    actionSubmissionRef.current = false
  }

  function updateNotesDraft(value: string) {
    setNotesEditorState({
      bookingId: booking.id,
      serverNotes,
      draft: value,
    })
    setNotesSuccess(null)
    setNotesError(null)
  }

  async function saveNotes() {
    if (
      notesSubmissionRef.current ||
      !notesChanged ||
      currentNotesState.draft.length > MAXIMUM_ADMIN_NOTES_LENGTH
    ) {
      return
    }

    notesSubmissionRef.current = true
    setIsNotesSubmitting(true)
    setNotesSuccess(null)
    setNotesError(null)

    const abortController = new AbortController()
    notesAbortControllerRef.current?.abort()
    notesAbortControllerRef.current = abortController

    const submittedNotes = currentNotesState.draft
    const token = await getIdToken()

    if (!isMountedRef.current || abortController.signal.aborted) {
      return
    }

    if (!token) {
      setNotesError({
        bookingId: booking.id,
        message:
          'تعذر التحقق من جلسة تسجيل الدخول. سجّلي الخروج ثم أعيدي تسجيل الدخول.',
      })
      setIsNotesSubmitting(false)
      notesSubmissionRef.current = false
      return
    }

    const result = await updateAdminBookingNotes(
      token,
      booking.id,
      { notes: submittedNotes },
      abortController.signal,
      adminSession,
    )

    if (!isMountedRef.current || abortController.signal.aborted) {
      return
    }

    notesAbortControllerRef.current = null

    if (result.ok) {
      const savedNotes = result.data.adminNotes ?? ''
      const updatedBooking: AdminBookingDetail = {
        ...booking,
        adminNotes: result.data.adminNotes,
        updatedAt: result.data.updatedAt,
      }

      setNotesEditorState({
        bookingId: booking.id,
        serverNotes: savedNotes,
        draft: savedNotes,
      })
      setNotesSuccess({
        bookingId: booking.id,
        message: result.data.adminNotes
          ? 'تم حفظ الملاحظات الداخلية.'
          : 'تم مسح الملاحظات الداخلية.',
      })
      onBookingUpdated(updatedBooking)
    } else {
      setNotesError({
        bookingId: booking.id,
        message: getMutationErrorMessage(result.error, 'notes'),
      })

      if (result.error.code === 'BOOKING_NOT_FOUND') {
        onRefreshDetails()
      }
    }

    setIsNotesSubmitting(false)
    notesSubmissionRef.current = false
  }

  // One set of status-change buttons, rendered in this panel or in the
  // sticky bar; either way a click opens the same confirmation dialog.
  const actionButtons = availableActions.map((action) => (
    <button
      className={`btn ${
        isDestructiveAction(action)
          ? 'booking-actions__button--destructive'
          : 'btn--primary'
      }`}
      key={action}
      type="button"
      onClick={(event) => openActionDialog(event, action)}
      disabled={isBusy}
    >
      {actionLabels[action]}
    </button>
  ))

  return (
    <section
      className="booking-actions"
      aria-labelledby="booking-actions-title"
    >
      <header className="booking-actions__header">
        <p className="booking-actions__eyebrow">إدارة الطلب</p>
        <h3
          id="booking-actions-title"
          ref={actionsHeadingRef}
          tabIndex={-1}
        >
          الإجراءات المتاحة
        </h3>
        <p className="booking-actions__lead">
          تظهر فقط الإجراءات التي يسمح بها الخادم لحالة الطلب الحالية.
        </p>
      </header>

      {visibleActionSuccess && (
        // One live region, so the warning is announced with the success.
        <div className="booking-actions__feedback" role="status">
          <p className="notice notice--success">
            <AdminIcon className="notice__icon" name="check" />
            <span>{visibleActionSuccess.message}</span>
          </p>

          {visibleActionSuccess.customerNotEmailed && (
            <p className="notice notice--warning">
              <AdminIcon className="notice__icon" name="alert" />
              {whatsappUrl ? (
                <span>
                  لم تُرسَل رسالة بريد إلى العميلة بهذا التحديث، فأبلغيها به
                  عبر واتساب:{' '}
                  <a
                    className="booking-actions__notice-link"
                    href={whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    فتح محادثة واتساب
                    <span className="booking-actions__visually-hidden">
                      (تفتح في نافذة جديدة)
                    </span>
                  </a>
                </span>
              ) : (
                <span>
                  لم تُرسَل رسالة بريد إلى العميلة بهذا التحديث، فأبلغيها به
                  يدويًا.
                </span>
              )}
            </p>
          )}
        </div>
      )}

      {isApprovalBlockedByDate && (
        <p className="notice notice--warning">
          <AdminIcon className="notice__icon" name="alert" />
          <span>
            مضى تاريخ هذه المناسبة، لذلك لم يعد قبول الطلب متاحًا. يمكنكِ
            رفضه.
          </span>
        </p>
      )}

      {availableActions.length > 0 ? (
        actionBarTarget ? (
          <>
            <p className="booking-actions__bar-hint">
              <AdminIcon className="booking-actions__button-icon" name="info" />
              <span>
                أزرار تغيير الحالة مثبّتة في الشريط أسفل الشاشة.
              </span>
            </p>
            {createPortal(
              <div
                className="booking-actions__bar"
                role="group"
                aria-labelledby={actionBarLabelId}
              >
                <p className="booking-actions__bar-label" id={actionBarLabelId}>
                  تغيير حالة الطلب
                </p>
                <div className="booking-actions__bar-buttons">
                  {actionButtons}
                </div>
              </div>,
              actionBarTarget,
            )}
          </>
        ) : (
          <div className="booking-actions__buttons">{actionButtons}</div>
        )
      ) : (
        <p className="notice booking-actions__empty">
          <AdminIcon className="notice__icon" name="info" />
          <span>لا توجد إجراءات انتقال متاحة للحالة الحالية.</span>
        </p>
      )}

      <section
        className="booking-actions__block"
        aria-labelledby="booking-whatsapp-title"
      >
        <h4 id="booking-whatsapp-title">التواصل مع العميلة</h4>
        <p className="booking-actions__lead">
          يفتح الزر واتساب برسالة جاهزة قابلة للتعديل، ولا تُرسَل إلا بعد
          ضغطكِ على الإرسال.
        </p>

        {whatsappUrl ? (
          <a
            className="btn btn--whatsapp booking-actions__whatsapp-link"
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <WhatsAppIcon className="booking-actions__button-icon" />
            <span>فتح محادثة واتساب</span>
            <span className="booking-actions__visually-hidden">
              (تفتح في نافذة جديدة)
            </span>
          </a>
        ) : (
          <p className="notice notice--warning" role="note">
            <AdminIcon className="notice__icon" name="alert" />
            <span>
              رقم جوال العميلة (
              <bdi dir="ltr">
                {formatCustomerText(booking.customer.phone)}
              </bdi>
              ) ليس رقمًا
              سعوديًا صالحًا، لذلك لا يمكن فتح محادثة واتساب منه. تواصلي معها
              يدويًا.
            </span>
          </p>
        )}
      </section>

      <section
        className="booking-actions__block"
        aria-labelledby="booking-notes-editor-title"
      >
        <h4 id="booking-notes-editor-title">الملاحظات الداخلية</h4>
        <p className="booking-actions__lead">
          ملاحظات إدارية لا تظهر للعميلة.
        </p>

        <div className="field booking-actions__notes-field">
          <label className="field__label" htmlFor="booking-admin-notes">
            نص الملاحظات
          </label>
          <textarea
            id="booking-admin-notes"
            value={currentNotesState.draft}
            onChange={(event) =>
              updateNotesDraft(event.currentTarget.value)
            }
            maxLength={MAXIMUM_ADMIN_NOTES_LENGTH}
            rows={6}
            disabled={isBusy}
            aria-describedby={notesCounterId}
          />
          <span
            className="field__hint booking-actions__counter"
            id={notesCounterId}
          >
            <bdi dir="ltr">
              {currentNotesState.draft.length} / {MAXIMUM_ADMIN_NOTES_LENGTH}
            </bdi>{' '}
            حرف
          </span>
        </div>

        {visibleNotesSuccess && (
          <p className="notice notice--success" role="status">
            <AdminIcon className="notice__icon" name="check" />
            <span>{visibleNotesSuccess}</span>
          </p>
        )}

        {visibleNotesError && (
          <p className="notice notice--danger" role="alert">
            <AdminIcon className="notice__icon" name="alert" />
            <span>{visibleNotesError}</span>
          </p>
        )}

        <div className="booking-actions__buttons">
          <button
            className="btn btn--primary"
            type="button"
            onClick={saveNotes}
            disabled={!notesChanged || isBusy}
          >
            {isNotesSubmitting ? 'جارٍ حفظ الملاحظات…' : 'حفظ الملاحظات'}
          </button>
          <button
            className="btn btn--secondary"
            type="button"
            onClick={() => updateNotesDraft('')}
            disabled={currentNotesState.draft.length === 0 || isBusy}
          >
            مسح النص
          </button>
        </div>
      </section>

      {activeAction && (
        <ActionConfirmationDialog
          action={activeAction}
          booking={booking}
          errorMessage={actionError}
          fallbackFocusRef={actionsHeadingRef}
          isActionStillAllowed={isActionStillAllowed}
          isSubmitting={isActionSubmitting}
          key={activeAction}
          note={transitionNote}
          opener={actionOpener}
          unavailableMessage={actionUnavailableMessage}
          onCancel={closeActionDialog}
          onConfirm={submitAction}
          onNoteChange={setTransitionNote}
        />
      )}
    </section>
  )
}
