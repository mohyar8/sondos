import type { BookingStatus } from '../shared/admin.js'
import type {
  AdminNewBookingNotification,
  CustomerBookingReceivedNotification,
  CustomerBookingStatusChangedNotification,
  EmailTemplate,
} from '../shared/notifications.js'
import { RIYADH_TIME_ZONE, isValidDateKey, parseInstant } from '../shared/timing.js'

/**
 * The shared email layout, formatters, the three existing booking emails and
 * the flow-2 approval email (plan rev. 2 B1 #5).
 *
 * Every email (the existing direct ones and the outbox emails in
 * worker/emails/*) goes through renderEmailLayout(), so the Resend design
 * stays one design. Left-to-right tokens (phone numbers, email addresses,
 * booking references) are bidi-isolated in the subject, the HTML and the
 * plain text, so `+966…` never renders as `…966+` inside Arabic text
 * (inspection defect #16); names, deadlines and amounts are isolated too
 * (TM-12, SB-6). No email ever carries bank details: they are shown only on
 * the booking page, to the booking's owner (W2-13).
 */

export const BRAND_NAME = 'المصورة سندس يار'
export const WHATSAPP_NOTE =
  'يظل التواصل عبر واتساب هو وسيلة التواصل الرسمية اليدوية لمراجعة التفاصيل.'

/** The line above the raw link in the existing emails (kept unchanged). */
const DEFAULT_LINK_FALLBACK_LABEL = 'إذا لم يعمل الزر، افتح الرابط:'

interface StatusCopy {
  label: string
  message: string
}

const statusCopyByStatus: Readonly<Record<BookingStatus, StatusCopy>> = {
  pending_review: {
    label: 'قيد المراجعة',
    message:
      'تم استلام طلبكِ وهو الآن قيد المراجعة. لا يُعد التاريخ مؤكدًا حتى تتم الموافقة.',
  },
  approved_hold: {
    label: 'تم قبول الطلب وحجز التاريخ',
    message:
      'تم قبول طلبكِ وحجز التاريخ مبدئيًا. سيتم التواصل معكِ يدويًا لمتابعة الخطوات.',
  },
  contract_pending: {
    label: 'بانتظار توقيع العقد',
    message:
      'طلبكِ بانتظار توقيع العقد، وسيستمر التواصل حول العقد يدويًا.',
  },
  contract_signed: {
    label: 'تم توقيع العقد',
    message:
      'تم تسجيل توقيع العقد يدويًا، وسيتم تزويدكِ بالخطوة التالية.',
  },
  payment_pending: {
    label: 'بانتظار تحويل العربون',
    message:
      'يرجى متابعة تعليمات التحويل البنكي التي تم الاتفاق عليها يدويًا عبر واتساب.',
  },
  confirmed: {
    label: 'الحجز مؤكد',
    message: 'تم استلام العربون وتأكيد الحجز بنجاح.',
  },
  rejected: {
    label: 'تعذر قبول الطلب',
    message:
      'نعتذر، تعذر قبول طلبكِ. يمكنكِ التواصل عبر واتساب للاستفسار أو اختيار تاريخ آخر.',
  },
  cancelled: {
    label: 'الحجز ملغي',
    message:
      'تم إلغاء الحجز. يمكنكِ التواصل عبر واتساب إذا احتجتِ إلى توضيح.',
  },
  expired: {
    label: 'انتهت مهلة الطلب',
    message:
      'انتهت مهلة متابعة الطلب. يمكنكِ التواصل عبر واتساب أو إرسال طلب جديد.',
  },
}

const sarFormatter = new Intl.NumberFormat('ar-SA', {
  style: 'currency',
  currency: 'SAR',
  maximumFractionDigits: 0,
})

// Western digits (03-design-system §2.3): the deposit is an amount she
// transfers, so it reads exactly as on the booking page (hub-model.ts).
const depositFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn', {
  style: 'currency',
  currency: 'SAR',
  maximumFractionDigits: 0,
})

// Western digits and the Gregorian calendar (03-design-system §2.3), the same
// options as the journey countdown in the SPA.
const emailDateFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const emailInstantDateFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const emailInstantTimeFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
})

/** LEFT-TO-RIGHT ISOLATE … POP DIRECTIONAL ISOLATE (Unicode UAX #9). */
const LEFT_TO_RIGHT_ISOLATE = '\u2066'
/** FIRST STRONG ISOLATE: the isolate takes the direction of its own text. */
const FIRST_STRONG_ISOLATE = '\u2068'
const POP_DIRECTIONAL_ISOLATE = '\u2069'
const BIDI_CONTROL_CHARACTERS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
/**
 * Everything a name must not carry into an email (audit SEC-10): control
 * (Cc), format (Cf, which includes every bidi control and zero-width
 * character), line separator (Zl) and paragraph separator (Zp).
 */
const NAME_UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
/**
 * The rest of the default-ignorable code points: characters that render as
 * nothing (Hangul fillers, the combining grapheme joiner, variation
 * selectors). Removed, so a name made of them reads as blank, not as a name.
 */
const NAME_INVISIBLE_CHARACTERS = /\p{Default_Ignorable_Code_Point}/gu
/** A fourth and later combining mark on one letter (stacked "Zalgo" marks). */
const EXCESS_COMBINING_MARKS = /(\p{M}{3})\p{M}+/gu
const MAXIMUM_EMAIL_NAME_LENGTH = 80
/** Shown in the admin email when the stored name sanitises to nothing. */
const NAME_UNAVAILABLE_LABEL = 'غير متاح'

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }

    return replacements[character] ?? character
  })
}

/** Removes bidi control characters, so a value can never re-order its surroundings. */
export function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROL_CHARACTERS, '')
}

/**
 * A customer's name as it may appear in an email: control, format, bidi and
 * line/paragraph-separator characters become spaces, the other invisible
 * (default-ignorable) characters are removed, a letter keeps at most three
 * combining marks, whitespace is collapsed, and at most `maximumLength`
 * characters (code points) are kept. Blank when nothing is left. Names saved
 * before the stricter profile rule (worker/profile.ts) pass through here too.
 */
export function sanitizePersonName(
  value: string,
  maximumLength: number = MAXIMUM_EMAIL_NAME_LENGTH,
): string {
  const cleaned = value
    .normalize('NFC')
    .replace(NAME_UNSAFE_CHARACTERS, ' ')
    .replace(NAME_INVISIBLE_CHARACTERS, '')
    .replace(EXCESS_COMBINING_MARKS, '$1')
    .replace(/\s+/g, ' ')
    .trim()

  return [...cleaned].slice(0, maximumLength).join('').trim()
}

/**
 * A name (its parts sanitised one by one and joined with a space) wrapped in
 * FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE, for plain text and HTML
 * alike (escapeHtml keeps both marks). The name then keeps its own direction
 * and cannot re-order the Arabic text around it (audit SEC-10). Blank when
 * every part sanitises to nothing.
 */
export function isolatePersonName(...parts: readonly string[]): string {
  const name = parts
    .map((part) => sanitizePersonName(part))
    .filter((part) => part.length > 0)
    .join(' ')

  return name.length > 0
    ? `${FIRST_STRONG_ISOLATE}${name}${POP_DIRECTIONAL_ISOLATE}`
    : ''
}

/**
 * The greeting of the customer emails: «أهلًا <name>،», or «أهلًا،» when the
 * name sanitises to nothing.
 */
function customerGreeting(firstName: string): string {
  const name = isolatePersonName(firstName)

  return name.length > 0 ? `أهلًا ${name}،` : 'أهلًا،'
}

/**
 * A left-to-right token (phone number, email address, booking reference)
 * isolated for Arabic plain text: `الجوال: \u2066+966…\u2069` keeps the `+` in front.
 */
export function isolateLtrText(value: string): string {
  return `${LEFT_TO_RIGHT_ISOLATE}${stripBidiControls(value)}${POP_DIRECTIONAL_ISOLATE}`
}

/**
 * Text this module formatted itself (a Riyadh deadline, an amount) wrapped in
 * FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE, so its digits and marks
 * cannot re-order the Arabic sentence around it. Not for user input: the
 * value is trusted formatter output, whose own marks stay inside the isolate.
 */
function isolateFormattedText(value: string): string {
  return `${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`
}

/**
 * The same isolation in HTML. `dir="ltr"` isolates in every browser-based
 * client; the inline `unicode-bidi` keeps `embed` as the fallback for clients
 * that ignore `isolate`.
 */
export function renderLtrHtml(value: string): string {
  return `<span dir="ltr" style="direction:ltr;unicode-bidi:embed;unicode-bidi:isolate;">${escapeHtml(stripBidiControls(value))}</span>`
}

/** A summary-table value rendered left-to-right and bidi-isolated. */
export interface EmailLtrValue {
  readonly ltr: string
}

export type EmailSummaryValue = string | EmailLtrValue

export type EmailSummaryRow = readonly [label: string, value: EmailSummaryValue]

export function ltrValue(value: string): EmailLtrValue {
  return { ltr: value }
}

export interface EmailLayoutInput {
  readonly heading: string
  readonly intro: string
  readonly summaryRows: readonly EmailSummaryRow[]
  readonly body: string
  /** The button's target. Null, or a URL that is not plain http(s), renders no button. */
  readonly actionUrl: string | null
  readonly actionLabel: string
  /** The line above the raw link; defaults to the wording of the existing emails. */
  readonly linkFallbackLabel?: string
}

/** Parses an absolute http(s) URL without credentials, or returns null. */
function parseSafeHttpUrl(value: string): URL | null {
  const url = URL.parse(value)

  if (
    url === null ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null
  }

  return url
}

export function normalizeApplicationBaseUrl(
  value: string | undefined,
): string | null {
  const trimmedValue = value?.trim()

  if (!trimmedValue) {
    return null
  }

  const url = parseSafeHttpUrl(trimmedValue)

  if (url === null) {
    return null
  }

  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')

  return url.toString().replace(/\/$/, '')
}

export function buildAdminBookingUrl(
  appBaseUrl: string | undefined,
  bookingReference: string,
): string | null {
  const normalizedBaseUrl = normalizeApplicationBaseUrl(appBaseUrl)
  const normalizedReference = bookingReference.trim()

  if (!normalizedBaseUrl || normalizedReference.length === 0) {
    return null
  }

  const url = new URL(`${normalizedBaseUrl}/admin`)

  url.searchParams.set('booking', normalizedReference)

  return url.toString()
}

export function buildMyBookingsUrl(
  appBaseUrl: string | undefined,
): string | null {
  const normalizedBaseUrl = normalizeApplicationBaseUrl(appBaseUrl)

  return normalizedBaseUrl
    ? new URL(`${normalizedBaseUrl}/my-bookings`).toString()
    : null
}

/**
 * The customer hub deep link `<APP_BASE_URL>/my-bookings?booking=<id>`
 * (ADR §2.6), or null when APP_BASE_URL is unset or unusable, or the id is
 * blank. The SPA falls back to the booking list for an id it cannot show.
 */
export function buildMyBookingDeepLinkUrl(
  appBaseUrl: string | undefined,
  bookingId: string,
): string | null {
  const myBookingsUrl = buildMyBookingsUrl(appBaseUrl)
  const normalizedBookingId = bookingId.trim()

  if (!myBookingsUrl || normalizedBookingId.length === 0) {
    return null
  }

  const url = new URL(myBookingsUrl)

  url.searchParams.set('booking', normalizedBookingId)

  return url.toString()
}

function normalizeSafeHttpUrl(value: string): string | null {
  return parseSafeHttpUrl(value.trim())?.toString() ?? null
}

export function formatTotal(value: number): string {
  return Number.isSafeInteger(value) && value >= 0
    ? sarFormatter.format(value)
    : 'غير متاح'
}

/**
 * A Riyadh calendar date (`YYYY-MM-DD`) in Arabic, e.g. «الاثنين، 5 أكتوبر
 * 2026». An invalid key is returned unchanged.
 */
export function formatEmailDate(dateKey: string): string {
  if (!isValidDateKey(dateKey)) {
    return dateKey
  }

  const [year, month, day] = dateKey.split('-').map(Number)

  return emailDateFormatter.format(new Date(Date.UTC(year, month - 1, day, 12)))
}

/**
 * An instant as its Riyadh date and time, e.g. «الخميس، 24 سبتمبر 2026،
 * الساعة 3:00 م بتوقيت السعودية», or null when the value is not a usable
 * instant.
 */
export function formatEmailInstant(value: string): string | null {
  const instant = parseInstant(value)

  if (instant === null) {
    return null
  }

  return `${emailInstantDateFormatter.format(instant)}، الساعة ${emailInstantTimeFormatter.format(instant)} بتوقيت السعودية`
}

function renderSummaryValue(value: EmailSummaryValue): string {
  return typeof value === 'string' ? escapeHtml(value) : renderLtrHtml(value.ltr)
}

function renderSummaryRows(rows: readonly EmailSummaryRow[]): string {
  return rows
    .map(
      ([label, value]) => `
        <tr>
          <th style="padding:10px 0 10px 16px;text-align:right;vertical-align:top;color:#766963;font-size:14px;font-weight:600;border-bottom:1px solid #e5ddd8;">${escapeHtml(label)}</th>
          <td style="padding:10px 0;text-align:right;vertical-align:top;color:#2d2927;font-size:14px;font-weight:500;border-bottom:1px solid #e5ddd8;overflow-wrap:anywhere;">${renderSummaryValue(value)}</td>
        </tr>`,
    )
    .join('')
}

function renderActionLink(
  urlValue: string | null,
  label: string,
  linkFallbackLabel: string,
): string {
  const safeUrl = urlValue === null ? null : normalizeSafeHttpUrl(urlValue)

  if (!safeUrl) {
    return ''
  }

  const escapedUrl = escapeHtml(safeUrl)

  return `
    <p style="margin:28px 0 12px;text-align:center;">
      <a href="${escapedUrl}" style="display:inline-block;padding:13px 24px;background:#835f58;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;border-radius:6px;">${escapeHtml(label)}</a>
    </p>
    <p style="margin:0;color:#766963;font-size:12px;line-height:1.8;overflow-wrap:anywhere;">${escapeHtml(linkFallbackLabel)}<br><a href="${escapedUrl}" dir="ltr" style="color:#6f4d47;direction:ltr;unicode-bidi:embed;unicode-bidi:isolate;">${escapedUrl}</a></p>`
}

export function renderEmailLayout(input: EmailLayoutInput): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(input.heading)}</title>
  </head>
  <body dir="rtl" style="margin:0;padding:0;background:#f5f1ee;color:#2d2927;font-family:Tahoma,Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f5f1ee;">
      <tr>
        <td align="center" style="padding:28px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:620px;background:#ffffff;border:1px solid #e5ddd8;">
            <tr>
              <td style="padding:32px 28px;text-align:right;">
                <p style="margin:0 0 20px;color:#835f58;font-size:15px;font-weight:700;">${escapeHtml(BRAND_NAME)}</p>
                <h1 style="margin:0 0 14px;color:#2d2927;font-size:25px;line-height:1.5;font-weight:700;">${escapeHtml(input.heading)}</h1>
                <p style="margin:0 0 22px;color:#554d49;font-size:15px;line-height:1.9;">${escapeHtml(input.intro)}</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-top:1px solid #e5ddd8;">
                  ${renderSummaryRows(input.summaryRows)}
                </table>
                <p style="margin:22px 0 0;color:#554d49;font-size:15px;line-height:1.9;">${escapeHtml(input.body)}</p>
                ${renderActionLink(input.actionUrl, input.actionLabel, input.linkFallbackLabel ?? DEFAULT_LINK_FALLBACK_LABEL)}
                <p style="margin:24px 0 0;padding-top:18px;border-top:1px solid #e5ddd8;color:#766963;font-size:13px;line-height:1.9;">${escapeHtml(WHATSAPP_NOTE)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

export function plainTextLink(urlValue: string): string {
  return normalizeSafeHttpUrl(urlValue) ?? 'الرابط غير متاح.'
}

export function renderAdminNewBookingTemplate(
  input: AdminNewBookingNotification,
): EmailTemplate {
  const customerName =
    isolatePersonName(input.customerFirstName, input.customerLastName) ||
    NAME_UNAVAILABLE_LABEL
  const total = formatTotal(input.finalTotal)
  const subject = `طلب حجز جديد — ${isolateLtrText(input.bookingReference)}`
  const text = [
    BRAND_NAME,
    '',
    'طلب حجز جديد',
    'وصل طلب حجز جديد ويحتاج إلى مراجعة يدوية. لم يتم قبول الطلب أو تأكيد التاريخ بعد.',
    '',
    `رقم الطلب: ${isolateLtrText(input.bookingReference)}`,
    `اسم العميلة: ${customerName}`,
    `الجوال: ${isolateLtrText(input.customerPhone)}`,
    `البريد الإلكتروني: ${isolateLtrText(input.customerEmail)}`,
    `تاريخ المناسبة: ${input.eventDate}`,
    `الباقة: ${input.packageName}`,
    `الإجمالي التقديري: ${total}`,
    '',
    'افتح الطلب في لوحة الإدارة:',
    plainTextLink(input.adminBookingUrl),
    '',
    WHATSAPP_NOTE,
  ].join('\n')

  return {
    subject,
    text,
    html: renderEmailLayout({
      heading: 'طلب حجز جديد',
      intro:
        'وصل طلب حجز جديد ويحتاج إلى مراجعة يدوية. لم يتم قبول الطلب أو تأكيد التاريخ بعد.',
      summaryRows: [
        ['رقم الطلب', ltrValue(input.bookingReference)],
        ['اسم العميلة', customerName],
        ['الجوال', ltrValue(input.customerPhone)],
        ['البريد الإلكتروني', ltrValue(input.customerEmail)],
        ['تاريخ المناسبة', input.eventDate],
        ['الباقة', input.packageName],
        ['الإجمالي التقديري', total],
      ],
      body: 'يرجى مراجعة الطلب والتواصل مع العميلة يدويًا.',
      actionUrl: input.adminBookingUrl,
      actionLabel: 'فتح الطلب في لوحة الإدارة',
    }),
  }
}

export function renderCustomerBookingReceivedTemplate(
  input: CustomerBookingReceivedNotification,
): EmailTemplate {
  const total = formatTotal(input.finalTotal)
  const subject = `تم استلام طلب حجزك — ${isolateLtrText(input.bookingReference)}`
  const notice =
    'تم استلام طلبكِ وهو قيد المراجعة. لا يُعد التاريخ مؤكدًا حتى تتم الموافقة واستلام العربون.'
  const text = [
    BRAND_NAME,
    '',
    customerGreeting(input.customerFirstName),
    notice,
    '',
    `رقم الطلب: ${isolateLtrText(input.bookingReference)}`,
    `تاريخ المناسبة: ${input.eventDate}`,
    `الباقة: ${input.packageName}`,
    `الإجمالي التقديري: ${total}`,
    '',
    'متابعة الطلب من صفحة حجوزاتي:',
    plainTextLink(input.myBookingsUrl),
    '',
    WHATSAPP_NOTE,
  ].join('\n')

  return {
    subject,
    text,
    html: renderEmailLayout({
      heading: 'تم استلام طلب حجزكِ',
      intro: `${customerGreeting(input.customerFirstName)} ${notice}`,
      summaryRows: [
        ['رقم الطلب', ltrValue(input.bookingReference)],
        ['تاريخ المناسبة', input.eventDate],
        ['الباقة', input.packageName],
        ['الإجمالي التقديري', total],
      ],
      body: 'سنراجع التفاصيل ونتواصل معكِ يدويًا قبل أي تأكيد.',
      actionUrl: input.myBookingsUrl,
      actionLabel: 'فتح حجوزاتي',
    }),
  }
}

export function renderCustomerBookingStatusTemplate(
  input: CustomerBookingStatusChangedNotification,
): EmailTemplate {
  const previousStatus = statusCopyByStatus[input.previousStatus]
  const newStatus = statusCopyByStatus[input.newStatus]
  const subject = `تحديث طلب الحجز — ${isolateLtrText(input.bookingReference)}`
  const text = [
    BRAND_NAME,
    '',
    customerGreeting(input.customerFirstName),
    'تم تحديث حالة طلب الحجز.',
    '',
    `رقم الطلب: ${isolateLtrText(input.bookingReference)}`,
    `تاريخ المناسبة: ${input.eventDate}`,
    `الحالة السابقة: ${previousStatus.label}`,
    `الحالة الحالية: ${newStatus.label}`,
    '',
    newStatus.message,
    '',
    'متابعة الطلب من صفحة حجوزاتي:',
    plainTextLink(input.myBookingsUrl),
    '',
    WHATSAPP_NOTE,
  ].join('\n')

  return {
    subject,
    text,
    html: renderEmailLayout({
      heading: 'تم تحديث حالة طلبكِ',
      intro: `${customerGreeting(input.customerFirstName)} تم تحديث حالة طلب الحجز.`,
      summaryRows: [
        ['رقم الطلب', ltrValue(input.bookingReference)],
        ['تاريخ المناسبة', input.eventDate],
        ['الحالة السابقة', previousStatus.label],
        ['الحالة الحالية', newStatus.label],
      ],
      body: newStatus.message,
      actionUrl: input.myBookingsUrl,
      actionLabel: 'فتح حجوزاتي',
    }),
  }
}

/**
 * The flow-2 approval email (B1 #5): what the status email says when an
 * approval opens the online confirmation. Built by the caller from the
 * approved row's own snapshot, never from request input.
 */
export interface CustomerFlowTwoApprovalNotification {
  readonly customerFirstName: string
  /** booking_requests.id, which is also the booking reference she sees. */
  readonly bookingReference: string
  /** Riyadh calendar date, `YYYY-MM-DD`. */
  readonly eventDate: string
  /** booking_requests.hold_expires_at, an ISO instant. */
  readonly holdExpiresAt: string
  /** booking_requests.deposit_amount, whole riyals. */
  readonly depositAmount: number
  readonly myBookingsUrl: string
}

const FLOW_TWO_APPROVAL_HEADING = 'تم قبول طلبكِ وحجز التاريخ مبدئيًا'
const FLOW_TWO_APPROVAL_BODY =
  'لتأكيد التاريخ نهائيًا، أكملي الخطوات من صفحة حجوزاتي قبل انتهاء المهلة: الموافقة على شروط الحجز ثم تحويل العربون. تفاصيل التحويل تظهر لكِ في صفحة حجوزاتي فقط، ولا نرسلها عبر البريد الإلكتروني. إذا انتهت المهلة دون إكمال الخطوات، قد يُلغى الحجز المبدئي ويصبح التاريخ متاحًا للطلبات الأخرى.'

/**
 * The status email for a flow-2 approval: the deadline in Riyadh time, the
 * deposit amount and that the steps continue on the bookings page. It never
 * carries bank details (they stay on the booking page, W2-13). Null when
 * the deadline is not a usable instant or the deposit is not a positive
 * whole amount; the caller then sends no email rather than a wrong one.
 * Flow-1 approvals keep renderCustomerBookingStatusTemplate unchanged.
 */
export function renderCustomerFlowTwoApprovalTemplate(
  input: CustomerFlowTwoApprovalNotification,
): EmailTemplate | null {
  const deadline = formatEmailInstant(input.holdExpiresAt)

  if (
    deadline === null ||
    !Number.isSafeInteger(input.depositAmount) ||
    input.depositAmount <= 0
  ) {
    return null
  }

  const isolatedDeadline = isolateFormattedText(deadline)
  const deposit = isolateFormattedText(
    depositFormatter.format(input.depositAmount),
  )
  const eventDate = formatEmailDate(input.eventDate)
  const status = statusCopyByStatus.approved_hold.label
  const intro = `${customerGreeting(input.customerFirstName)} تم قبول طلب حجزكِ، وحجزنا لكِ التاريخ مبدئيًا حتى ${isolatedDeadline}.`
  const subject = `${FLOW_TWO_APPROVAL_HEADING} — ${isolateLtrText(input.bookingReference)}`
  const text = [
    BRAND_NAME,
    '',
    intro,
    '',
    `رقم الطلب: ${isolateLtrText(input.bookingReference)}`,
    `تاريخ المناسبة: ${eventDate}`,
    `الحالة الحالية: ${status}`,
    `مبلغ العربون: ${deposit}`,
    `تنتهي المهلة في: ${isolatedDeadline}`,
    '',
    FLOW_TWO_APPROVAL_BODY,
    '',
    'أكملي الخطوات من صفحة حجوزاتي:',
    plainTextLink(input.myBookingsUrl),
    '',
    WHATSAPP_NOTE,
  ].join('\n')

  return {
    subject,
    text,
    html: renderEmailLayout({
      heading: FLOW_TWO_APPROVAL_HEADING,
      intro,
      summaryRows: [
        ['رقم الطلب', ltrValue(input.bookingReference)],
        ['تاريخ المناسبة', eventDate],
        ['الحالة الحالية', status],
        ['مبلغ العربون', deposit],
        ['تنتهي المهلة في', isolatedDeadline],
      ],
      body: FLOW_TWO_APPROVAL_BODY,
      actionUrl: input.myBookingsUrl,
      actionLabel: 'فتح حجوزاتي',
      linkFallbackLabel: 'إذا لم يعمل الزر، افتحي الرابط:',
    }),
  }
}
