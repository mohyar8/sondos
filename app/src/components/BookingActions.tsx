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
import {
  DEFAULT_EXTEND_HOURS,
  MAXIMUM_EXTEND_HOURS,
  MINIMUM_EXTEND_HOURS,
  MINIMUM_OFFLINE_NOTE_CODE_POINTS,
  isFlowTwoOnlyAdminAction,
  type AdminApprovalPreview,
  type AdminApprovalUnavailableReason,
  type AdminBookingAction,
  type AdminBookingActionRequest,
  type AdminBookingDetail,
  type AdminFlowVersion,
  type BookingStatus,
} from '../../shared/admin'
import { countCodePoints } from '../../shared/text'
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
  formatAdminCurrency,
  formatAdminTimestamp,
  formatCustomerName,
  formatCustomerText,
} from '../features/admin-portal/format'
import {
  ADMIN_STACKED_LAYOUT_QUERY,
  useMediaQuery,
} from '../features/admin-portal/use-media-query'
import { WhatsAppIcon } from '../layout/icons'
import { toAsciiDigits } from '../lib/ascii-digits'
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

/** What the admin typed into the dialog's fields, as typed (#18). */
interface ActionInputs {
  note: string
  extendHours: string
  depositAmount: string
}

/** One message per field, null when the field is fine; text, never colour. */
interface ActionFieldErrors {
  note: string | null
  extendHours: string | null
  depositAmount: string | null
}

type ParsedActionInputs =
  | {
      ok: true
      request: AdminBookingActionRequest
    }
  | {
      ok: false
      errors: ActionFieldErrors
    }

interface ActionConfirmationDialogProps {
  action: AdminBookingAction
  booking: AdminBookingDetail
  flowVersion: AdminFlowVersion
  inputs: ActionInputs
  /** Shown after a refused attempt; every value null before that. */
  fieldErrors: ActionFieldErrors
  /** Incremented on every refused attempt: focus moves to the first error. */
  invalidAttempt: number
  errorMessage: string | null
  isSubmitting: boolean
  isActionStillAllowed: boolean
  /** Why the action can no longer be confirmed, or null. */
  unavailableMessage: string | null
  opener: HTMLButtonElement | null
  /** Receives focus when the opener no longer exists after the dialog closes. */
  fallbackFocusRef: RefObject<HTMLElement | null>
  onInputChange: (field: keyof ActionInputs, value: string) => void
  onConfirm: () => void
  onCancel: () => void
}

const MAXIMUM_TRANSITION_NOTE_LENGTH = 500
const MAXIMUM_ADMIN_NOTES_LENGTH = 2_000
/** A whole riyal amount or an hour count, as digits (UX-07). */
const MAXIMUM_NUMBER_INPUT_LENGTH = 12
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Unicode isolates keep a Latin run (a booking id) whole inside Arabic text. */
const LEFT_TO_RIGHT_ISOLATE = '⁦'
/** The same for her name, whichever script it is written in (SEC-10). */
const FIRST_STRONG_ISOLATE = '⁨'
const POP_DIRECTIONAL_ISOLATE = '⁩'

const NO_FIELD_ERRORS: ActionFieldErrors = {
  note: null,
  extendHours: null,
  depositAmount: null,
}

const EMPTY_INPUTS: ActionInputs = {
  note: '',
  extendHours: String(DEFAULT_EXTEND_HOURS),
  depositAmount: '',
}

const actionLabels: Record<AdminBookingAction, string> = {
  approve: 'قبول الطلب وحجز التاريخ',
  reject: 'رفض الطلب',
  mark_contract_sent: 'تم إرسال العقد',
  mark_contract_signed: 'تم استلام العقد الموقّع',
  request_payment: 'طلب تحويل العربون',
  confirm_payment: 'تأكيد استلام العربون',
  cancel: 'إلغاء الحجز',
  extend_hold: 'تمديد مهلة الحجز المؤقت',
  expire_hold: 'إنهاء الحجز المؤقت',
  reinstate_hold: 'إعادة الحجز المؤقت',
  confirm_offline: 'تأكيد الحجز يدويًا (الشروط والعربون)',
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
  extend_hold:
    'تمنح العميلة ساعات إضافية لإكمال الموافقة على الشروط وتحويل العربون. تُحسب المهلة الجديدة من المهلة الحالية أو من الآن أيهما أبعد، ولا تتجاوز بداية يوم المناسبة. ستصلها رسالة بالموعد الجديد.',
  expire_hold:
    'انتهت مهلة الحجز المؤقت دون إكمال الخطوات. إنهاؤه يحرّر التاريخ للطلبات الأخرى، ويمكن إعادته لاحقًا ما دام التاريخ متاحًا ولم يبدأ يوم المناسبة.',
  reinstate_hold:
    'يعيد الحجز المؤقت بمهلة جديدة: 48 ساعة أو حتى بداية يوم المناسبة أيهما أقرب. لا يُقبل إذا كان التاريخ محجوزًا بطلب آخر أو محجوبًا.',
  confirm_offline:
    'استخدميه فقط عندما تتعذر على العميلة الموافقة على الشروط وإكمال الخطوات من الموقع. يسجّل موافقتها على النسخة الحالية من الشروط كما أخذتِها منها (عبر واتساب مثلًا)، ويسجّل العربون المستلم، ويؤكد الحجز. يتطلب تسجيل دخول حديثًا وسببًا مكتوبًا.',
}

/**
 * TM-20: the amount recorded is the one seen in the bank statement; a
 * WhatsApp notice, a receipt image or a matching transaction number is not
 * proof of payment.
 */
const BANK_STATEMENT_HINT =
  'أدخلي المبلغ كما يظهر في كشف حسابكِ البنكي أو تطبيق البنك، بالريال وبدون كسور. إشعار واتساب أو صورة الإيصال أو تطابق رقم العملية ليست إثباتًا للدفع.'

const EXTEND_HOURS_ERROR = `يجب أن تكون ساعات التمديد عددًا صحيحًا بين ${MINIMUM_EXTEND_HOURS} و${MAXIMUM_EXTEND_HOURS}.`
const OFFLINE_NOTE_ERROR = `اكتبي سبب التأكيد اليدوي (${MINIMUM_OFFLINE_NOTE_CODE_POINTS} أحرف على الأقل).`
const LOW_AMOUNT_NOTE_ERROR =
  'المبلغ أقل من العربون المطلوب؛ اكتبي ملاحظة توضّح سبب قبوله.'

/** Why `approve` will take the legacy path (#17 approvalPreview). */
const approvalUnavailableReasons: Record<AdminApprovalUnavailableReason, string> = {
  SETTINGS_INCOMPLETE:
    'إعدادات التأكيد الإلكتروني غير مكتملة (قاعدة العربون أو الحساب البنكي أو شروط الحجز)',
  SWITCH_OFF: 'التأكيد الإلكتروني متوقف في إعدادات النشر',
  KILL_SWITCH: 'مفتاح إيقاف التأكيد الإلكتروني مفعّل',
  EVENT_TOO_SOON: 'موعد المناسبة أقرب من ثلاثة أيام',
  EVENT_PASSED: 'تاريخ المناسبة قد مضى',
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

/**
 * 409 codes that mean the row moved under the dialog (another tab, the
 * cron, a customer step, a settings change): the details and the list are
 * refreshed so the buttons match the row again. Legacy rows only ever
 * answer the first (N-29).
 */
const STALE_STATE_CODES: ReadonlySet<string> = new Set([
  'INVALID_STATUS_TRANSITION',
  'GRACE_PERIOD_OVER',
  'HOLD_NOT_OVERDUE',
  'TERMS_NOT_ACCEPTED',
  'TERMS_ALREADY_ACCEPTED',
  'DATE_NOT_FREE',
  'SETTINGS_CHANGED',
])

/** Reject, cancel and the admin's own expiry end something for her. */
function isDestructiveAction(action: AdminBookingAction): boolean {
  return action === 'reject' || action === 'cancel' || action === 'expire_hold'
}

/**
 * The row's flow. A bundle whose parser predates #17 (src/api/admin.ts
 * before W3-02) drops `flowVersion`; the action names then prove flow 2
 * (shared/admin.ts: the flow-2-only actions, and `confirm_payment` on an
 * approved hold, which the legacy map never offers). A row that proves
 * nothing is treated as flow 1, whose dialog never asks for an amount.
 */
function resolveFlowVersion(booking: AdminBookingDetail): AdminFlowVersion {
  if (booking.flowVersion !== undefined) {
    return booking.flowVersion
  }

  const provesFlowTwo =
    booking.allowedActions.some(isFlowTwoOnlyAdminAction) ||
    (booking.status === 'approved_hold' &&
      booking.allowedActions.includes('confirm_payment'))

  return provesFlowTwo ? 2 : 1
}

/** `depositAmount` is sent with these (#18); the Worker refuses it elsewhere. */
function takesDepositAmount(
  action: AdminBookingAction,
  flowVersion: AdminFlowVersion,
): boolean {
  return (
    action === 'confirm_offline' ||
    (action === 'confirm_payment' && flowVersion === 2)
  )
}

/** A whole number typed in any digits toAsciiDigits reads (UX-07), or null. */
function readWholeNumberInput(value: string): number | null {
  const digits = toAsciiDigits(value.trim())

  return /^[0-9]{1,8}$/.test(digits) ? Number(digits) : null
}

/**
 * The request body for the action, or the field errors that stop it. The
 * same rules the Worker applies (#18, H3, TM-20), so a refused body is
 * explained next to its field before the request is made: hours 1–168,
 * the amount 1..the booking's total, a reason of at least ten characters
 * for the offline confirmation, and a reason whenever less than the
 * requested deposit is recorded.
 */
function parseActionInputs(
  action: AdminBookingAction,
  flowVersion: AdminFlowVersion,
  booking: AdminBookingDetail,
  inputs: ActionInputs,
): ParsedActionInputs {
  const errors: ActionFieldErrors = { ...NO_FIELD_ERRORS }
  const note = inputs.note.trim()
  const request: AdminBookingActionRequest = {
    action,
    ...(note ? { note } : {}),
  }

  if (action === 'extend_hold') {
    const hours = readWholeNumberInput(inputs.extendHours)

    if (
      hours === null ||
      hours < MINIMUM_EXTEND_HOURS ||
      hours > MAXIMUM_EXTEND_HOURS
    ) {
      errors.extendHours = EXTEND_HOURS_ERROR
    } else {
      request.extendHours = hours
    }
  }

  if (takesDepositAmount(action, flowVersion)) {
    const amount = readWholeNumberInput(inputs.depositAmount)

    if (amount === null || amount < 1 || amount > booking.estimatedTotal) {
      errors.depositAmount = `يجب إدخال مبلغ العربون المستلم بالريال كعدد صحيح لا يقل عن 1 ولا يتجاوز إجمالي الحجز (${formatAdminCurrency(booking.estimatedTotal)}).`
    } else {
      request.depositAmount = amount

      if (
        action === 'confirm_payment' &&
        typeof booking.depositAmount === 'number' &&
        amount < booking.depositAmount &&
        note.length === 0
      ) {
        errors.note = LOW_AMOUNT_NOTE_ERROR
      }
    }
  }

  if (
    action === 'confirm_offline' &&
    countCodePoints(note) < MINIMUM_OFFLINE_NOTE_CODE_POINTS
  ) {
    errors.note = OFFLINE_NOTE_ERROR
  }

  return errors.note || errors.extendHours || errors.depositAmount
    ? { ok: false, errors }
    : { ok: true, request }
}

/** What `approve` will do, as the Worker computed it (#17), or nothing known. */
function describeApprovalPreview(
  preview: AdminApprovalPreview | null | undefined,
): string | null {
  if (preview === undefined || preview === null) {
    return null
  }

  if (preview.flowVersion === 2) {
    return `سيفتح القبول التأكيد الإلكتروني: عربون ${formatAdminCurrency(preview.depositAmount)} ومهلة ${preview.holdHours} ساعة تُكمل خلالها العميلة الموافقة على الشروط وتحويل العربون من الموقع.`
  }

  return `سيأخذ القبول المسار اليدوي (${approvalUnavailableReasons[preview.reason]}): حجز مؤقت لمدة 24 ساعة ومتابعة العقد والعربون عبر واتساب.`
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
    case 'DATE_NOT_FREE':
      return 'تاريخ المناسبة محجوز بطلب آخر لا يزال ساريًا.'
    case 'INVALID_STATUS_TRANSITION':
      return 'تغيّرت حالة الطلب بالفعل، لذلك سيتم تحديث التفاصيل قبل محاولة إجراء آخر.'
    // NOTES_TOO_LONG is the notes endpoint's code since unit D2; NOTE_TOO_LONG
    // stays for the action note (and for a Worker from before D2).
    case 'NOTES_TOO_LONG':
    case 'NOTE_TOO_LONG':
      return operation === 'notes'
        ? 'يجب ألا تتجاوز الملاحظات الداخلية 2000 حرف.'
        : 'يجب ألا تتجاوز ملاحظة الإجراء 500 حرف.'
    case 'NOTE_REQUIRED':
      return `هذا الإجراء يتطلب ملاحظة توضّح السبب (${MINIMUM_OFFLINE_NOTE_CODE_POINTS} أحرف على الأقل).`
    case 'INVALID_TEXT':
      return 'تحتوي الملاحظة على رموز غير مسموح بها.'
    case 'CONTENT_NOT_ALLOWED':
      return 'لا يجوز أن تحتوي الملاحظة على روابط أو أرقام حسابات أو أرقام جوال؛ تعليمات الدفع تُدخل في إعدادات الحساب البنكي فقط.'
    case 'INVALID_EXTEND_HOURS':
      return EXTEND_HOURS_ERROR
    case 'INVALID_AMOUNT':
      return 'يجب إدخال مبلغ العربون المستلم بالريال كعدد صحيح لا يقل عن 1 ولا يتجاوز إجمالي الحجز.'
    case 'GRACE_PERIOD_OVER':
      return 'انقضت فترة السماح بعد انتهاء المهلة، فلم يعد التمديد أو تأكيد العربون ممكنًا لهذا الحجز.'
    case 'HOLD_BEYOND_EVENT':
      return 'لا يمكن أن تتجاوز المهلة الجديدة بداية يوم المناسبة. قلّلي عدد الساعات.'
    case 'HOLD_NOT_OVERDUE':
      return 'لم تنتهِ مهلة الحجز المؤقت بعد.'
    case 'TERMS_NOT_ACCEPTED':
      return 'لم توافق العميلة على الشروط إلكترونيًا بعد؛ استخدمي التأكيد اليدوي بعد تسجيل موافقتها.'
    case 'TERMS_ALREADY_ACCEPTED':
      return 'وافقت العميلة على الشروط إلكترونيًا؛ استخدمي تأكيد استلام العربون.'
    case 'SETTINGS_CHANGED':
      return 'تغيّرت إعدادات التأكيد الإلكتروني أثناء تنفيذ الإجراء. حدّثي التفاصيل ثم أعيدي المحاولة.'
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
  flowVersion,
  inputs,
  fieldErrors,
  invalidAttempt,
  errorMessage,
  isSubmitting,
  isActionStillAllowed,
  unavailableMessage,
  opener,
  fallbackFocusRef,
  onInputChange,
  onConfirm,
  onCancel,
}: ActionConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null)
  const safeButtonRef = useRef<HTMLButtonElement | null>(null)
  const hoursInputRef = useRef<HTMLInputElement | null>(null)
  const amountInputRef = useRef<HTMLInputElement | null>(null)
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null)
  const titleId = useId()
  const descriptionId = useId()
  const noteId = useId()
  const noteCounterId = useId()
  const noteErrorId = useId()
  const hoursId = useId()
  const hoursHintId = useId()
  const hoursErrorId = useId()
  const amountId = useId()
  const amountHintId = useId()
  const amountErrorId = useId()
  const isDestructive = isDestructiveAction(action)
  const showsHours = action === 'extend_hold'
  const showsAmount = takesDepositAmount(action, flowVersion)
  // The reason is part of the record (H3), or of accepting less (TM-20).
  const noteIsRequired =
    action === 'confirm_offline' ||
    (showsAmount && fieldErrors.note === LOW_AMOUNT_NOTE_ERROR)
  const approvalPreviewText =
    action === 'approve' ? describeApprovalPreview(booking.approvalPreview) : null
  const showsHold =
    flowVersion === 2 &&
    booking.holdExpiresAt !== null &&
    (showsHours || showsAmount || action === 'expire_hold')

  // Scroll lock, initial focus and focus return. A destructive action (reject,
  // cancel, expire) opens on the SAFE button «تراجع», so a stray Enter never
  // confirms it; an action with a field to fill opens on that field; any
  // other action opens on its confirm button. The dialog is keyed by its
  // action, so this runs once per opening.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const initialFocusTarget = isDestructive
      ? safeButtonRef.current
      : (hoursInputRef.current ??
        amountInputRef.current ??
        confirmButtonRef.current)
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

  // A refused attempt lands on the first field with an error (text under
  // the field, aria-invalid on it), in the order the fields render.
  useEffect(() => {
    if (invalidAttempt === 0) {
      return
    }

    const target = fieldErrors.extendHours
      ? hoursInputRef.current
      : fieldErrors.depositAmount
        ? amountInputRef.current
        : fieldErrors.note
          ? noteInputRef.current
          : null

    target?.focus()
  }, [fieldErrors, invalidAttempt])

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

  const noteDescribedBy = [noteCounterId, fieldErrors.note ? noteErrorId : null]
    .filter((id) => id !== null)
    .join(' ')
  const hoursDescribedBy = [hoursHintId, fieldErrors.extendHours ? hoursErrorId : null]
    .filter((id) => id !== null)
    .join(' ')
  const amountDescribedBy = [
    amountHintId,
    fieldErrors.depositAmount ? amountErrorId : null,
  ]
    .filter((id) => id !== null)
    .join(' ')

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

        {approvalPreviewText && (
          <p className="notice notice--info">
            <AdminIcon className="notice__icon" name="info" />
            <span>{approvalPreviewText}</span>
          </p>
        )}

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
          {showsHold && booking.holdExpiresAt !== null && (
            <div>
              <dt>المهلة الحالية</dt>
              <dd>{formatAdminTimestamp(booking.holdExpiresAt)}</dd>
            </div>
          )}
          {showsAmount && typeof booking.depositAmount === 'number' && (
            <div>
              <dt>العربون المطلوب</dt>
              <dd>{formatAdminCurrency(booking.depositAmount)}</dd>
            </div>
          )}
          {showsAmount && (
            <div>
              <dt>إجمالي الحجز</dt>
              <dd>{formatAdminCurrency(booking.estimatedTotal)}</dd>
            </div>
          )}
        </dl>

        {showsHours && (
          <div
            className={`field booking-action-dialog__field${
              fieldErrors.extendHours ? ' field--error' : ''
            }`}
          >
            <label className="field__label" htmlFor={hoursId}>
              عدد ساعات التمديد
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={hoursId}
              ref={hoursInputRef}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={inputs.extendHours}
              onChange={(event) =>
                onInputChange('extendHours', event.currentTarget.value)
              }
              maxLength={MAXIMUM_NUMBER_INPUT_LENGTH}
              disabled={isSubmitting}
              required
              aria-required="true"
              aria-invalid={fieldErrors.extendHours ? true : undefined}
              aria-describedby={hoursDescribedBy}
            />
            <span className="field__hint" id={hoursHintId}>
              من {MINIMUM_EXTEND_HOURS} إلى {MAXIMUM_EXTEND_HOURS} ساعة، تُضاف
              إلى المهلة الحالية أو إلى الآن أيهما أبعد.
            </span>
            {fieldErrors.extendHours && (
              <p className="field__error" id={hoursErrorId}>
                <AdminIcon className="notice__icon" name="alert" />
                <span>{fieldErrors.extendHours}</span>
              </p>
            )}
          </div>
        )}

        {showsAmount && (
          <div
            className={`field booking-action-dialog__field${
              fieldErrors.depositAmount ? ' field--error' : ''
            }`}
          >
            <label className="field__label" htmlFor={amountId}>
              مبلغ العربون المستلم (بالريال)
              <span className="field__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id={amountId}
              ref={amountInputRef}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={inputs.depositAmount}
              onChange={(event) =>
                onInputChange('depositAmount', event.currentTarget.value)
              }
              maxLength={MAXIMUM_NUMBER_INPUT_LENGTH}
              disabled={isSubmitting}
              required
              aria-required="true"
              aria-invalid={fieldErrors.depositAmount ? true : undefined}
              aria-describedby={amountDescribedBy}
            />
            <span className="field__hint" id={amountHintId}>
              {BANK_STATEMENT_HINT}
            </span>
            {fieldErrors.depositAmount && (
              <p className="field__error" id={amountErrorId}>
                <AdminIcon className="notice__icon" name="alert" />
                <span>{fieldErrors.depositAmount}</span>
              </p>
            )}
          </div>
        )}

        <div
          className={`field booking-action-dialog__field${
            fieldErrors.note ? ' field--error' : ''
          }`}
        >
          <label className="field__label" htmlFor={noteId}>
            {action === 'confirm_offline'
              ? 'سبب التأكيد اليدوي'
              : noteIsRequired
                ? 'ملاحظة توضّح سبب قبول مبلغ أقل'
                : 'ملاحظة داخلية عن هذا الانتقال (اختيارية)'}
            {noteIsRequired && (
              <span className="field__required" aria-hidden="true">
                *
              </span>
            )}
          </label>
          <textarea
            id={noteId}
            ref={noteInputRef}
            value={inputs.note}
            onChange={(event) => onInputChange('note', event.currentTarget.value)}
            maxLength={MAXIMUM_TRANSITION_NOTE_LENGTH}
            rows={4}
            disabled={isSubmitting}
            required={noteIsRequired || undefined}
            aria-required={noteIsRequired || undefined}
            aria-invalid={fieldErrors.note ? true : undefined}
            aria-describedby={noteDescribedBy}
          />
          <span className="field__hint booking-actions__counter" id={noteCounterId}>
            {action === 'confirm_offline' && (
              <>
                {`${MINIMUM_OFFLINE_NOTE_CODE_POINTS} أحرف على الأقل، بلا روابط أو أرقام حسابات أو أرقام جوال. `}
              </>
            )}
            <bdi dir="ltr">
              {inputs.note.length} / {MAXIMUM_TRANSITION_NOTE_LENGTH}
            </bdi>{' '}
            حرف
          </span>
          {fieldErrors.note && (
            <p className="field__error" id={noteErrorId}>
              <AdminIcon className="notice__icon" name="alert" />
              <span>{fieldErrors.note}</span>
            </p>
          )}
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
  const [actionInputs, setActionInputs] = useState<ActionInputs>(EMPTY_INPUTS)
  const [fieldErrors, setFieldErrors] =
    useState<ActionFieldErrors>(NO_FIELD_ERRORS)
  const [invalidAttempt, setInvalidAttempt] = useState(0)
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
  const flowVersion = resolveFlowVersion(booking)

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
    setActionInputs(EMPTY_INPUTS)
    setFieldErrors(NO_FIELD_ERRORS)
    setInvalidAttempt(0)
    setActionError(null)
    setActionSuccess(null)
    setActiveAction(action)
  }

  function closeActionDialog() {
    if (isActionSubmitting) {
      return
    }

    setActiveAction(null)
    setActionInputs(EMPTY_INPUTS)
    setFieldErrors(NO_FIELD_ERRORS)
    setActionError(null)
  }

  function updateActionInput(field: keyof ActionInputs, value: string) {
    setActionInputs((current) => ({ ...current, [field]: value }))
    // The field's message goes once it is edited; the next attempt re-checks.
    setFieldErrors((current) =>
      current[field] === null ? current : { ...current, [field]: null },
    )
  }

  async function submitAction() {
    if (
      !activeAction ||
      !isActionStillAllowed ||
      actionSubmissionRef.current
    ) {
      return
    }

    const parsedInputs = parseActionInputs(
      activeAction,
      flowVersion,
      booking,
      actionInputs,
    )

    if (!parsedInputs.ok) {
      setFieldErrors(parsedInputs.errors)
      setInvalidAttempt((count) => count + 1)
      return
    }

    actionSubmissionRef.current = true
    setIsActionSubmitting(true)
    setActionError(null)

    const abortController = new AbortController()
    actionAbortControllerRef.current?.abort()
    actionAbortControllerRef.current = abortController

    const submittedAction = activeAction
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
      parsedInputs.request,
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
      setActionInputs(EMPTY_INPUTS)
    } else {
      setActionError(getMutationErrorMessage(result.error, 'action'))

      // The Worker's Riyadh date is the authority: re-read ours so the
      // approve button is withdrawn as well.
      if (result.error.code === 'EVENT_DATE_PASSED') {
        setTodayKey(getRiyadhToday().key)
      }

      if (
        result.error.code !== undefined &&
        STALE_STATE_CODES.has(result.error.code)
      ) {
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
        {flowVersion === 2 && (
          <p className="booking-actions__lead">
            هذا الطلب على مسار التأكيد الإلكتروني
            {booking.holdExpiresAt !== null &&
            (booking.status === 'approved_hold' ||
              booking.status === 'expired')
              ? `؛ مهلة الحجز المؤقت: ${formatAdminTimestamp(booking.holdExpiresAt)}.`
              : '.'}
          </p>
        )}
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

      {booking.noticeProtected === true && (
        // B1 / UX-02: she said she transferred for this deadline; the hold
        // never expires on its own, the owner decides against the statement.
        <p className="notice notice--info">
          <AdminIcon className="notice__icon" name="info" />
          <span>
            أبلغت العميلة بتحويل العربون لهذه المهلة، فلن ينتهي الحجز المؤقت
            تلقائيًا. تحققي من كشف الحساب البنكي ثم أكّدي الاستلام أو أنهي
            الحجز المؤقت بنفسكِ.
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
          fieldErrors={fieldErrors}
          flowVersion={flowVersion}
          inputs={actionInputs}
          invalidAttempt={invalidAttempt}
          isActionStillAllowed={isActionStillAllowed}
          isSubmitting={isActionSubmitting}
          key={activeAction}
          opener={actionOpener}
          unavailableMessage={actionUnavailableMessage}
          onCancel={closeActionDialog}
          onConfirm={submitAction}
          onInputChange={updateActionInput}
        />
      )}
    </section>
  )
}
