import type { EmailTemplate } from '../../shared/notifications.js'
import {
  BRAND_NAME,
  WHATSAPP_NOTE,
  buildMyBookingDeepLinkUrl,
  formatEmailDate,
  formatEmailInstant,
  isolateLtrText,
  isolatePersonName,
  ltrValue,
  renderEmailLayout,
  sanitizePersonName,
  stripBidiControls,
} from '../email-templates.js'
import type { NotificationKind } from '../notify/outbox.js'
import type { ReceiptChannel } from '../settings/features.js'

/**
 * Hold emails for flow 2 (ADR-001 §2.1, §2.2; 08-copy-ar §4.3 and §8.2): the
 * 24 h and 6 h reminders while she still owes a receipt, and the notice that
 * the hold has expired. They are rendered when they are queued in the outbox
 * (worker/notify/outbox.ts) and go through the shared layout, addressed to
 * her in the feminine singular.
 *
 * The button deep-links to `/my-bookings?booking=<id>` built from
 * APP_BASE_URL. When APP_BASE_URL is unset or unusable the email is still
 * complete: it just has no button and names the page instead.
 *
 * Output safety (SB-6): every string reaches the HTML only through
 * renderEmailLayout, which escapes it; her name is sanitised and wrapped in
 * a first-strong isolate, and the booking reference in a left-to-right
 * isolate, in the text and the HTML alike. No email carries bank details or
 * the studio's number: the WhatsApp step points to the button on her
 * bookings page, which shows the current number (with its change notice,
 * TM-03) and records her notice, which protects the hold (B1).
 */

export type HoldReminderKind = Extract<
  NotificationKind,
  'hold_reminder_24h' | 'hold_reminder_6h'
>

/** What she still owes before the deadline. */
export type HoldOwedStep =
  /** `approved_hold`, terms not yet accepted: accept them first. */
  | 'accept_terms'
  /** `approved_hold`, terms accepted: transfer the deposit, send the receipt. */
  | 'deposit_receipt'
  /** `payment_pending` whose latest receipt was rejected: send a new one. */
  | 'new_receipt'

export interface HoldReminderEmailInput {
  readonly kind: HoldReminderKind
  readonly customerFirstName: string
  /** booking_requests.id, which is also the booking reference she sees. */
  readonly bookingId: string
  /** Riyadh calendar date, `YYYY-MM-DD`. */
  readonly eventDate: string
  /** The deadline, an ISO instant. */
  readonly holdExpiresAt: string
  readonly owedStep: HoldOwedStep
  /**
   * Where her receipt goes: 'upload' only while receipt uploads are open
   * (PM), otherwise 'whatsapp' (worker/settings/features.ts).
   */
  readonly receiptChannel: ReceiptChannel
  readonly appBaseUrl: string | undefined
}

export interface HoldExpiredEmailInput {
  readonly customerFirstName: string
  readonly bookingId: string
  readonly eventDate: string
  /** The deadline that passed, an ISO instant. */
  readonly holdExpiresAt: string
  readonly appBaseUrl: string | undefined
}

const MAXIMUM_FIRST_NAME_LENGTH = 60
const LINK_FALLBACK_LABEL = 'إذا لم يعمل الزر، افتحي الرابط:'
const REMINDER_SUBJECT_PREFIX = 'تبقّى وقت قليل لإكمال حجزكِ'
const EXPIRED_SUBJECT_PREFIX = 'انتهت مهلة حجزكِ المبدئي'

const reminderHeadingByKind: Readonly<Record<HoldReminderKind, string>> = {
  hold_reminder_24h: 'تبقّى وقت قليل لإكمال حجزكِ',
  hold_reminder_6h: 'تنتهي مهلة حجزكِ قريبًا',
}

/** Accepting the terms comes first, whatever the receipt channel. */
const ACCEPT_TERMS_COPY =
  'لتأكيد التاريخ نهائيًا، وافقي على شروط الحجز من صفحة حجوزاتي قبل انتهاء المهلة، ثم أكملي خطوة العربون كما تظهر لكِ هناك.'

const receiptStepCopy: Readonly<
  Record<Exclude<HoldOwedStep, 'accept_terms'>, Readonly<Record<ReceiptChannel, string>>>
> = {
  deposit_receipt: {
    whatsapp:
      'لتأكيد التاريخ نهائيًا، حوّلي العربون ثم أرسلي إيصال التحويل عبر واتساب من زر الإرسال في صفحة حجوزاتي قبل انتهاء المهلة؛ تجدين تفاصيل التحويل في الصفحة نفسها.',
    upload:
      'لتأكيد التاريخ نهائيًا، حوّلي العربون ثم ارفعي إيصال التحويل من صفحة حجوزاتي قبل انتهاء المهلة؛ تجدين تفاصيل التحويل في الصفحة نفسها.',
  },
  new_receipt: {
    whatsapp:
      'لتأكيد التاريخ نهائيًا، أرسلي إيصالًا جديدًا لتحويل العربون عبر واتساب من زر الإرسال في صفحة حجوزاتي قبل انتهاء المهلة.',
    upload:
      'لتأكيد التاريخ نهائيًا، ارفعي إيصالًا جديدًا لتحويل العربون من صفحة حجوزاتي قبل انتهاء المهلة.',
  },
}

/**
 * The sentence that tells her what to do next: accept the terms; transfer
 * and send the receipt on WhatsApp; or upload the receipt (plan 11 W2-03).
 */
export function holdOwedStepCopy(
  owedStep: HoldOwedStep,
  receiptChannel: ReceiptChannel,
): string {
  return owedStep === 'accept_terms'
    ? ACCEPT_TERMS_COPY
    : receiptStepCopy[owedStep][receiptChannel]
}

const reminderConsequenceByKind: Readonly<Record<HoldReminderKind, string>> = {
  hold_reminder_24h:
    'إذا انتهت المهلة دون ذلك، يُلغى الحجز المؤقت ويصبح التاريخ متاحًا للطلبات الأخرى.',
  hold_reminder_6h:
    'أكملي الآن لتفادي إلغاء الحجز المبدئي؛ فبعد انتهاء المهلة يصبح التاريخ متاحًا للطلبات الأخرى.',
}

/**
 * Her first name as it may appear in an email: no control, format, bidi or
 * line-separator characters (email-templates.ts sanitizePersonName),
 * whitespace collapsed, at most 60 characters. Blank when nothing is left.
 */
export function sanitizeFirstName(value: string): string {
  return sanitizePersonName(value, MAXIMUM_FIRST_NAME_LENGTH)
}

/** «أهلًا <name>،» with the name bidi-isolated, or «أهلًا،» when it is blank. */
function greeting(firstName: string): string {
  const name = isolatePersonName(sanitizeFirstName(firstName))

  return name.length > 0 ? `أهلًا ${name}،` : 'أهلًا،'
}

function subjectWithReference(prefix: string, bookingId: string): string {
  return `${prefix} — ${stripBidiControls(bookingId).trim()}`
}

function plainTextAction(
  deepLink: string | null,
  withLinkLabel: string,
  withoutLinkLine: string,
): readonly string[] {
  return deepLink === null ? [withoutLinkLine] : [withLinkLabel, deepLink]
}

/**
 * The 24 h or 6 h hold reminder. Null when the deadline is not a usable
 * instant (the job then queues nothing).
 */
export function renderHoldReminderEmail(
  input: HoldReminderEmailInput,
): EmailTemplate | null {
  const deadline = formatEmailInstant(input.holdExpiresAt)

  if (deadline === null) {
    return null
  }

  const intro = `${greeting(input.customerFirstName)} تبقّى وقت محدود لإكمال حجزكِ قبل انتهاء المهلة.`
  const eventDate = formatEmailDate(input.eventDate)
  const deepLink = buildMyBookingDeepLinkUrl(input.appBaseUrl, input.bookingId)
  const body = `${holdOwedStepCopy(input.owedStep, input.receiptChannel)} ${reminderConsequenceByKind[input.kind]}`
  const text = [
    BRAND_NAME,
    '',
    intro,
    '',
    `رقم الطلب: ${isolateLtrText(input.bookingId)}`,
    `تاريخ المناسبة: ${eventDate}`,
    `تنتهي المهلة في: ${deadline}`,
    '',
    body,
    '',
    ...plainTextAction(
      deepLink,
      'أكملي حجزكِ من صفحة حجوزاتي:',
      'يمكنكِ إكمال حجزكِ من صفحة حجوزاتي في موقعنا.',
    ),
    '',
    WHATSAPP_NOTE,
  ].join('\n')

  return {
    subject: subjectWithReference(REMINDER_SUBJECT_PREFIX, input.bookingId),
    text,
    html: renderEmailLayout({
      heading: reminderHeadingByKind[input.kind],
      intro,
      summaryRows: [
        ['رقم الطلب', ltrValue(input.bookingId)],
        ['تاريخ المناسبة', eventDate],
        ['تنتهي المهلة في', deadline],
      ],
      body,
      actionUrl: deepLink,
      actionLabel: 'أكملي حجزكِ',
      linkFallbackLabel: LINK_FALLBACK_LABEL,
    }),
  }
}

/**
 * The notice that her hold expired and the date was released. Null when the
 * deadline is not a usable instant (the booking still expires; no email).
 */
export function renderHoldExpiredEmail(
  input: HoldExpiredEmailInput,
): EmailTemplate | null {
  const deadline = formatEmailInstant(input.holdExpiresAt)

  if (deadline === null) {
    return null
  }

  const intro = `${greeting(input.customerFirstName)} انتهت مهلة حجزكِ المبدئي، وأصبح التاريخ متاحًا للطلبات الأخرى.`
  const eventDate = formatEmailDate(input.eventDate)
  const deepLink = buildMyBookingDeepLinkUrl(input.appBaseUrl, input.bookingId)
  const body =
    'إن رغبتِ في المتابعة، يمكنكِ التواصل معنا عبر واتساب أو إرسال طلب جديد.'
  const text = [
    BRAND_NAME,
    '',
    intro,
    '',
    `رقم الطلب: ${isolateLtrText(input.bookingId)}`,
    `تاريخ المناسبة: ${eventDate}`,
    `انتهت المهلة في: ${deadline}`,
    '',
    body,
    '',
    ...plainTextAction(
      deepLink,
      'تفاصيل الطلب في صفحة حجوزاتي:',
      'يمكنكِ مراجعة تفاصيل الطلب من صفحة حجوزاتي في موقعنا.',
    ),
    '',
    WHATSAPP_NOTE,
  ].join('\n')

  return {
    subject: subjectWithReference(EXPIRED_SUBJECT_PREFIX, input.bookingId),
    text,
    html: renderEmailLayout({
      heading: EXPIRED_SUBJECT_PREFIX,
      intro,
      summaryRows: [
        ['رقم الطلب', ltrValue(input.bookingId)],
        ['تاريخ المناسبة', eventDate],
        ['انتهت المهلة في', deadline],
      ],
      body,
      actionUrl: deepLink,
      actionLabel: 'فتح حجوزاتي',
      linkFallbackLabel: LINK_FALLBACK_LABEL,
    }),
  }
}
