import { MAXIMUM_DEPOSIT_BASE_TOTAL } from '../../../shared/deposit'
import type { HandoverMethod } from '../../../shared/portal/handover'
import { SETTINGS_TEXT_RULES } from '../../../shared/settings'
import {
  countCodePoints,
  findPaymentInstructionLike,
  normalizeFreeText,
  normalizePersonName,
  type FreeTextRule,
} from '../../../shared/text'
import {
  RIYADH_TIME_ZONE,
  isValidDateKey,
  isValidLocalTime,
  riyadhDateKey,
} from '../../../shared/timing'
import {
  WHATSAPP_MESSAGE_MAX_LENGTH,
  buildWhatsAppUrlFor,
  isolateLtr,
  type StoredWhatsAppNumber,
  type WhatsAppLinkResult,
} from '../../lib/whatsapp'

/**
 * WhatsApp messages the studio sends to a customer (W2-14, UX-15, TM-19),
 * pre-filled and editable: the admin opens the chat and WhatsApp sends
 * nothing without her. Studio voice («نحن», 08-copy-ar §0.1), the bride
 * addressed in the feminine singular.
 *
 * Every function here is pure: no clock, no storage, no logging. The
 * caller passes what one message needs and each template reads only its
 * own fields, so no message carries more of her data than it must (SB-13):
 * never her last name, phone, email or delivery address. No template ever
 * carries bank details (they stay on the bookings page, W2-13), and the
 * only link one can hold is the site's own bookings page, built from a
 * validated origin. Values a customer or an admin typed are isolated so
 * they cannot reorder the Arabic around them (SB-6), and the link itself
 * is built only by src/lib/whatsapp.ts (TM-19).
 */

/**
 * The closed list of template ids. The Worker keeps the same list for the
 * contact log (worker/portal/admin-booking-log.ts); a test keeps them equal.
 */
export const adminContactTemplateIds = [
  'request_received',
  'approved_online',
  'approved_legacy',
  'hold_reminder',
  'terms_reminder',
  'deposit_recorded',
  'event_details_request',
  'event_reminder',
  'production_update',
  'album_ready',
  'handover_confirmation',
  'handover_day',
  'feedback_request',
  'offline_selection',
] as const

export type AdminContactTemplateId = (typeof adminContactTemplateIds)[number]

const templateIdSet: ReadonlySet<string> = new Set(adminContactTemplateIds)

export function isAdminContactTemplateId(
  value: unknown,
): value is AdminContactTemplateId {
  return typeof value === 'string' && templateIdSet.has(value)
}

/** The name the admin sees for each template (list, timeline, queue). */
export const adminContactTemplateLabels: Readonly<
  Record<AdminContactTemplateId, string>
> = {
  request_received: 'استلام الطلب',
  approved_online: 'قبول الطلب وحجز التاريخ مبدئيًا',
  approved_legacy: 'قبول الطلب (مسار سابق)',
  hold_reminder: 'تذكير بمهلة الحجز',
  terms_reminder: 'تذكير بالموافقة على الشروط',
  deposit_recorded: 'تأكيد استلام العربون',
  event_details_request: 'طلب تفاصيل المناسبة',
  event_reminder: 'تذكير بموعد المناسبة',
  production_update: 'تحديث تجهيز الألبوم',
  album_ready: 'الألبوم جاهز',
  handover_confirmation: 'تأكيد موعد التسليم',
  handover_day: 'يوم التسليم',
  feedback_request: 'طلب رأيها في التجربة',
  offline_selection: 'اختيار صور الألبوم',
}

/** The album stages production_update speaks of («ready» is album_ready). */
export type AdminContactProductionStage = 'design' | 'printing'

/**
 * What a message may need. Only `reference` is always required; each
 * template reads its own fields below and ignores the rest, so a caller may
 * pass one object with everything it has (a work-queue item, a booking).
 *
 * - request_received, approved_legacy, event_details_request: eventDate.
 * - approved_online: holdExpiresAt; depositAmount when known.
 * - hold_reminder: holdExpiresAt. terms_reminder: holdExpiresAt if known.
 * - deposit_recorded: depositAmount (the amount recorded as received).
 * - event_reminder: eventDate; eventStartTime if known.
 * - production_update: productionStage.
 * - handover_confirmation, handover_day: slotStartsAt and handoverMethod;
 *   for a pickup, the studio's pickupAddress and pickupInstructions if
 *   set; handover_day also `now`, else it names the date instead of «اليوم».
 * - album_ready, feedback_request, offline_selection: nothing more.
 */
export interface AdminContactTemplateInput {
  /** booking_requests.id, the reference she sees on her bookings page. */
  readonly reference: string
  /** Her first name for the greeting; left out when it is not a valid name. */
  readonly firstName?: string | null
  /** `YYYY-MM-DD`, a Riyadh calendar date. */
  readonly eventDate?: string | null
  /** A canonical ISO instant (`toISOString()`). */
  readonly holdExpiresAt?: string | null
  /** Whole riyals. */
  readonly depositAmount?: number | null
  /** `HH:MM`, Riyadh wall-clock time. */
  readonly eventStartTime?: string | null
  readonly productionStage?: AdminContactProductionStage | null
  /** A canonical ISO instant. */
  readonly slotStartsAt?: string | null
  readonly handoverMethod?: HandoverMethod | null
  /** The studio's pickup settings, admin-authored text. */
  readonly pickupAddress?: string | null
  readonly pickupInstructions?: string | null
  /**
   * `window.location.origin`: the only host a message may link to. Anything
   * but a bare https origin (or http on this machine, for development)
   * leaves the link out.
   */
  readonly siteOrigin?: string | null
  /** The current time, server-corrected; only handover_day reads it. */
  readonly now?: Date | null
}

/** Why no message was produced. */
export type AdminContactTemplateIssue = 'invalid_input' | 'message_too_long'

export type AdminContactTemplateResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false
      readonly issue: AdminContactTemplateIssue
      readonly reason: string
    }

const templateIssueReasons: Record<AdminContactTemplateIssue, string> = {
  invalid_input:
    'تعذّر تجهيز الرسالة الجاهزة لأن بيانات الحجز اللازمة لها غير مكتملة.',
  message_too_long:
    'تعذّر تجهيز الرسالة الجاهزة لأنها أطول من الحد المسموح.',
}

/**
 * A reference as the Worker issues it (crypto.randomUUID()), with room for
 * older ids: Latin letters, digits and hyphens only, so it can neither
 * break out of its isolate nor change the link's query.
 */
const REFERENCE_PATTERN = /^[A-Za-z0-9-]{1,64}$/

/** What `toISOString()` writes; anything looser is refused. */
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

/** Longest origin read at all. */
const SITE_ORIGIN_MAX_LENGTH = 256

/** http is accepted only for these hosts (the local dev server). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
])

/** The customer hub; `?booking=` opens one booking in it. */
const MY_BOOKINGS_PATH = '/my-bookings'

/** The marks Intl may put around Arabic output; the message needs none. */
const INTL_DIRECTION_MARKS = /[؜‎‏]/g

const FIRST_STRONG_ISOLATE = '⁨'
const POP_DIRECTIONAL_ISOLATE = '⁩'

/*
 * Western digits and the Gregorian calendar (03-design-system §2.3), the
 * same formats as the emails (worker/email-templates.ts).
 */
const riyadhDateFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const riyadhTimeFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
})

/** Reads a date key or a wall-clock time built at UTC, so no shift applies. */
const calendarDateFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const wallClockFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: 'UTC',
  hour: 'numeric',
  minute: '2-digit',
})

const amountFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn', {
  maximumFractionDigits: 0,
})

const GREETING_WITHOUT_NAME = 'مرحبًا،'
const SIGN_OFF = 'مع تحيات المصورة سندس يار.'
const TIME_ZONE_NOTE = 'بتوقيت السعودية'

const MY_BOOKINGS_LINK_LABEL = 'صفحة حجوزاتي:'
const RECEIPT_STEP =
  'بعد التحويل، اضغطي «أرسلي صورة الإيصال عبر واتساب» في صفحة حجوزاتي، وأرفقي صورة الإيصال في المحادثة.'

function plainIntl(value: string): string {
  return value.replace(INTL_DIRECTION_MARKS, '')
}

/** A run of Arabic text with digits, kept whole inside the sentence. */
function isolateFormatted(value: string): string {
  return `${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`
}

function readReference(value: unknown): string | null {
  return typeof value === 'string' && REFERENCE_PATTERN.test(value)
    ? value
    : null
}

function readInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) {
    return null
  }

  const instant = new Date(value)

  // A rolled-over date (Feb 30) reads back differently.
  return !Number.isNaN(instant.getTime()) &&
    instant.toISOString().slice(0, 19) === value.slice(0, 19)
    ? instant
    : null
}

function readDateKey(value: unknown): string | null {
  return typeof value === 'string' && isValidDateKey(value) ? value : null
}

function readAmount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAXIMUM_DEPOSIT_BASE_TOTAL
    ? value
    : null
}

function readHandoverMethod(value: unknown): HandoverMethod | null {
  return value === 'pickup' || value === 'delivery' ? value : null
}

function readProductionStage(
  value: unknown,
): AdminContactProductionStage | null {
  return value === 'design' || value === 'printing' ? value : null
}

/**
 * Admin-authored pickup text as the settings rule accepts it, and only when
 * it holds no link, handle, IBAN or long number (SB-17's tripwire): a
 * message then never carries a foreign link or payment details even if a
 * stored value predates those rules. Otherwise the text is left out.
 */
function readPickupText(value: unknown, rule: FreeTextRule): string | null {
  if (value === null || value === undefined) {
    return null
  }

  const result = normalizeFreeText(value, rule)

  if (!result.ok || result.value.length === 0) {
    return null
  }

  return findPaymentInstructionLike(result.value, null) === null
    ? result.value
    : null
}

/** A bare origin of this site, or null (see AdminContactTemplateInput). */
function readSiteOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > SITE_ORIGIN_MAX_LENGTH) {
    return null
  }

  let url: URL

  try {
    url = new URL(value)
  } catch (error) {
    if (error instanceof TypeError) {
      return null
    }

    throw error
  }

  // No path, query, fragment, credentials or trailing slash.
  if (url.origin !== value) {
    return null
  }

  return url.protocol === 'https:' ||
    (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    ? url.origin
    : null
}

function myBookingsLink(origin: string | null, reference: string): string | null {
  if (origin === null) {
    return null
  }

  const url = new URL(MY_BOOKINGS_PATH, origin)

  url.searchParams.set('booking', reference)

  return url.origin === origin ? url.href : null
}

function formatDeadline(instant: Date): string {
  return isolateFormatted(
    `${plainIntl(riyadhDateFormatter.format(instant))}، الساعة ${plainIntl(riyadhTimeFormatter.format(instant))} ${TIME_ZONE_NOTE}`,
  )
}

function formatRiyadhDate(instant: Date): string {
  return isolateFormatted(plainIntl(riyadhDateFormatter.format(instant)))
}

function formatRiyadhTime(instant: Date): string {
  return isolateFormatted(
    `${plainIntl(riyadhTimeFormatter.format(instant))} ${TIME_ZONE_NOTE}`,
  )
}

function formatCalendarDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)

  return isolateFormatted(
    plainIntl(
      calendarDateFormatter.format(new Date(Date.UTC(year, month - 1, day, 12))),
    ),
  )
}

function formatWallClock(localTime: string): string {
  const [hour, minute] = localTime.split(':').map(Number)

  return isolateFormatted(
    `${plainIntl(wallClockFormatter.format(new Date(Date.UTC(2000, 0, 1, hour, minute))))} ${TIME_ZONE_NOTE}`,
  )
}

/** «1,300 ر.س.» with the digit run kept left to right. */
function formatAmount(amount: number): string {
  return `${isolateLtr(plainIntl(amountFormatter.format(amount)))} ر.س.`
}

function greeting(firstName: unknown): string {
  const name = normalizePersonName(firstName)

  return name === null
    ? GREETING_WITHOUT_NAME
    : `مرحبًا ${isolateFormatted(name)}،`
}

/** The body of one message: its paragraphs and whether it links the hub. */
interface TemplateBody {
  readonly paragraphs: readonly string[]
  readonly linksToBookings: boolean
}

type TemplateRenderer = (input: AdminContactTemplateInput) => TemplateBody | null

/** Pickup place and instructions, or where she will get them. */
function pickupParagraphs(input: AdminContactTemplateInput): string[] {
  const address = readPickupText(
    input.pickupAddress,
    SETTINGS_TEXT_RULES.pickupAddress,
  )
  const instructions = readPickupText(
    input.pickupInstructions,
    SETTINGS_TEXT_RULES.pickupInstructions,
  )

  if (address === null) {
    return ['سنرسل إليكِ مكان الاستلام هنا قبل الموعد.']
  }

  // Each line is its own paragraph, so no line can reorder another.
  return instructions === null
    ? ['مكان الاستلام:', address]
    : ['مكان الاستلام:', address, instructions]
}

const renderers: Readonly<Record<AdminContactTemplateId, TemplateRenderer>> = {
  request_received(input) {
    const eventDate = readDateKey(input.eventDate)

    if (eventDate === null) {
      return null
    }

    return {
      paragraphs: [
        `استلمنا طلب حجزكِ ليوم ${formatCalendarDate(eventDate)}، وهو الآن قيد المراجعة. لا يُعد التاريخ مؤكدًا حتى تتم الموافقة، وسنتواصل معكِ بعد التحقق من التفاصيل.`,
      ],
      linksToBookings: true,
    }
  },

  approved_online(input) {
    const deadline = readInstant(input.holdExpiresAt)

    if (deadline === null) {
      return null
    }

    const amount = readAmount(input.depositAmount)

    return {
      paragraphs: [
        `تم قبول طلب حجزكِ، وحجزنا لكِ التاريخ مبدئيًا حتى ${formatDeadline(deadline)}.`,
        // Its own line: «ر.س.» ends in a full stop of its own.
        ...(amount === null ? [] : [`مبلغ العربون: ${formatAmount(amount)}`]),
        'لتأكيد التاريخ نهائيًا، أكملي الخطوات من صفحة حجوزاتي قبل انتهاء المهلة: الموافقة على شروط الحجز ثم تحويل العربون. تفاصيل التحويل تظهر لكِ في صفحة حجوزاتي فقط.',
        RECEIPT_STEP,
        'إذا انتهت المهلة دون إكمال الخطوات، قد يُلغى الحجز المبدئي ويصبح التاريخ متاحًا للطلبات الأخرى.',
      ],
      linksToBookings: true,
    }
  },

  approved_legacy(input) {
    const eventDate = readDateKey(input.eventDate)

    if (eventDate === null) {
      return null
    }

    return {
      paragraphs: [
        `تم قبول طلبكِ مبدئيًا، وحجزنا لكِ تاريخ مناسبتكِ يوم ${formatCalendarDate(eventDate)} مؤقتًا. سنتواصل معكِ هنا لاستكمال الخطوات التالية.`,
      ],
      linksToBookings: false,
    }
  },

  hold_reminder(input) {
    const deadline = readInstant(input.holdExpiresAt)

    if (deadline === null) {
      return null
    }

    return {
      paragraphs: [
        `تذكير: تنتهي مهلة حجزكِ المبدئي يوم ${formatDeadline(deadline)}. أكملي الخطوات من صفحة حجوزاتي قبل انتهاء المهلة لتأكيد التاريخ نهائيًا.`,
        'إن كنتِ قد حوّلتِ العربون، فاضغطي «أرسلي صورة الإيصال عبر واتساب» في صفحة حجوزاتي، وأرفقي صورة الإيصال في المحادثة.',
      ],
      linksToBookings: true,
    }
  },

  terms_reminder(input) {
    const deadline = readInstant(input.holdExpiresAt)
    const beforeDeadline =
      deadline === null ? '' : ` قبل انتهاء المهلة يوم ${formatDeadline(deadline)}`

    return {
      paragraphs: [
        `لم تكتمل موافقتكِ على شروط الحجز بعد. اطّلعي على الشروط ووافقي عليها من صفحة حجوزاتي${beforeDeadline}، ثم أكملي تحويل العربون لتأكيد التاريخ نهائيًا.`,
      ],
      linksToBookings: true,
    }
  },

  deposit_recorded(input) {
    const amount = readAmount(input.depositAmount)

    if (amount === null) {
      return null
    }

    return {
      paragraphs: [
        `استلمنا عربونكِ بمبلغ ${formatAmount(amount)}، وتم تأكيد حجزكِ بنجاح. نتطلع لتوثيق يومكِ بكل عناية.`,
        'يمكنكِ الآن إضافة تفاصيل يومكِ من صفحة حجوزاتي.',
      ],
      linksToBookings: true,
    }
  },

  event_details_request(input) {
    const eventDate = readDateKey(input.eventDate)

    if (eventDate === null) {
      return null
    }

    return {
      paragraphs: [
        `يقترب موعد مناسبتكِ يوم ${formatCalendarDate(eventDate)}. نرجو منكِ إضافة تفاصيل يومكِ (الموقع، الوقت، طلباتكِ الخاصة) من صفحة حجوزاتي، لنستعد لتوثيقه بكل عناية.`,
      ],
      linksToBookings: true,
    }
  },

  event_reminder(input) {
    const eventDate = readDateKey(input.eventDate)

    if (eventDate === null) {
      return null
    }

    const startTime =
      typeof input.eventStartTime === 'string' &&
      isValidLocalTime(input.eventStartTime)
        ? `، الساعة ${formatWallClock(input.eventStartTime)}`
        : ''

    return {
      paragraphs: [
        `نذكّركِ بموعد مناسبتكِ يوم ${formatCalendarDate(eventDate)}${startTime}. نتطلع لتوثيق يومكِ بكل عناية.`,
        'إن تغيّر أي من التفاصيل، حدّثيها من صفحة حجوزاتي أو أخبرينا هنا.',
      ],
      linksToBookings: true,
    }
  },

  production_update(input) {
    const stage = readProductionStage(input.productionStage)

    if (stage === null) {
      return null
    }

    return {
      paragraphs: [
        stage === 'design'
          ? 'يجري الآن تصميم ألبومكِ، وسنبلغكِ حين يصبح جاهزًا للاستلام.'
          : 'ألبومكِ الآن قيد الطباعة، وسنبلغكِ حين يصبح جاهزًا للاستلام.',
      ],
      linksToBookings: false,
    }
  },

  album_ready() {
    return {
      paragraphs: [
        'ألبومكِ جاهز! احجزي موعد الاستلام أو التوصيل من صفحة حجوزاتي.',
      ],
      linksToBookings: true,
    }
  },

  handover_confirmation(input) {
    const slot = readInstant(input.slotStartsAt)
    const method = readHandoverMethod(input.handoverMethod)

    if (slot === null || method === null) {
      return null
    }

    const when = `يوم ${formatRiyadhDate(slot)}، الساعة ${formatRiyadhTime(slot)}`

    return method === 'pickup'
      ? {
          paragraphs: [
            `تم تأكيد موعد استلام ألبومكِ ${when}.`,
            ...pickupParagraphs(input),
          ],
          linksToBookings: true,
        }
      : {
          paragraphs: [
            `تم تأكيد موعد توصيل ألبومكِ ${when}، إلى العنوان الذي أضفتِه في صفحة حجوزاتي.`,
          ],
          linksToBookings: true,
        }
  },

  handover_day(input) {
    const slot = readInstant(input.slotStartsAt)
    const method = readHandoverMethod(input.handoverMethod)

    if (slot === null || method === null) {
      return null
    }

    // «اليوم» only when the caller's clock says so; never a wrong «today».
    const isToday =
      input.now instanceof Date &&
      !Number.isNaN(input.now.getTime()) &&
      riyadhDateKey(input.now) === riyadhDateKey(slot)
    const when = isToday
      ? `اليوم الساعة ${formatRiyadhTime(slot)}`
      : `يوم ${formatRiyadhDate(slot)}، الساعة ${formatRiyadhTime(slot)}`
    const change = 'إن احتجتِ إلى أي تعديل، تواصلي معنا هنا.'

    return method === 'pickup'
      ? {
          paragraphs: [
            `نذكّركِ بموعد استلام ألبومكِ ${when}.`,
            ...pickupParagraphs(input),
            change,
          ],
          linksToBookings: false,
        }
      : {
          paragraphs: [`نذكّركِ بموعد توصيل ألبومكِ ${when}.`, change],
          linksToBookings: false,
        }
  },

  feedback_request() {
    return {
      paragraphs: [
        'تم تسليم ألبومكِ، ونتمنى أن يكون قد نال إعجابكِ. يسعدنا سماع رأيكِ في تجربتكِ معنا، ويمكنكِ مشاركته من صفحة حجوزاتي إن رغبتِ.',
      ],
      linksToBookings: true,
    }
  },

  offline_selection() {
    return {
      paragraphs: [
        'حان وقت اختيار صور ألبومكِ. سنشارككِ صور يومكِ، فاختاري منها صوركِ المفضّلة ضمن عدد صور باقتكِ، ثم أرسلي إلينا اختياركِ النهائي في هذه المحادثة.',
      ],
      linksToBookings: false,
    }
  },
}

function templateFailure(
  issue: AdminContactTemplateIssue,
): AdminContactTemplateResult {
  return { ok: false, issue, reason: templateIssueReasons[issue] }
}

/**
 * The text of one template for one booking, or why there is none: a
 * missing or malformed required field never becomes «undefined» or
 * «Invalid Date» in a message to her. The text is the same for the same
 * input.
 */
export function renderAdminContactTemplate(
  templateId: AdminContactTemplateId,
  input: AdminContactTemplateInput,
): AdminContactTemplateResult {
  const reference = readReference(input.reference)

  if (!isAdminContactTemplateId(templateId) || reference === null) {
    return templateFailure('invalid_input')
  }

  const body = renderers[templateId](input)

  if (body === null) {
    return templateFailure('invalid_input')
  }

  const link = body.linksToBookings
    ? myBookingsLink(readSiteOrigin(input.siteOrigin), reference)
    : null
  const lines = [
    greeting(input.firstName),
    ...body.paragraphs,
    '',
    `رقم الطلب: ${isolateLtr(reference)}`,
    // The link on a line of its own: nothing bidi can attach to it.
    ...(link === null ? [] : [MY_BOOKINGS_LINK_LABEL, link]),
    '',
    SIGN_OFF,
  ]
  const text = lines.join('\n')

  return countCodePoints(text) > WHATSAPP_MESSAGE_MAX_LENGTH
    ? templateFailure('message_too_long')
    : { ok: true, text }
}

export type AdminContactLinkResult =
  | WhatsAppLinkResult
  | {
      readonly ok: false
      readonly issue: AdminContactTemplateIssue
      readonly reason: string
    }

/**
 * The chat link that opens her WhatsApp with one template pre-filled. The
 * number is a StoredWhatsAppNumber (a queue item's `waDigits`) or the phone
 * stored on her profile; both go through the one builder in
 * src/lib/whatsapp.ts, which refuses an invalid number rather than opening
 * the wrong chat.
 */
export function buildAdminContactLink(
  recipient: string | StoredWhatsAppNumber,
  templateId: AdminContactTemplateId,
  input: AdminContactTemplateInput,
): AdminContactLinkResult {
  const message = renderAdminContactTemplate(templateId, input)

  return message.ok ? buildWhatsAppUrlFor(recipient, message.text) : message
}
