import type {
  BookingPackageSnapshot,
  BookingSnapshotExtra,
} from '../../../shared/booking'
import {
  journeyStageLabels,
  type JourneyStageId,
} from '../../../shared/journey'
import { RIYADH_TIME_ZONE, parseInstant } from '../../../shared/timing'
import type { CustomerBooking, CustomerBookingStatus } from '../../api/bookings'
import { buildWhatsAppUrl } from '../../lib/whatsapp'
import { formatArabicCount } from './arabic-count'
import {
  findStageViewForBooking,
  resolveStageView,
  stageViews,
  type StageViewId,
  type StageViewRegistry,
} from './stage-views'

/**
 * The customer hub's pure model («حجوزاتي», ADR-001 W3-7 T3, design §5.5,
 * copy §4): what each booking card says, in which order the cards appear,
 * her next step, and the WhatsApp message prefilled for each booking.
 * MyBookings.tsx only renders it. No I/O, no clock reads.
 */

// ---------------------------------------------------------------------------
// Status and stage presentation
// ---------------------------------------------------------------------------

/** Badge tone (03-design-system §4.4); the label always says it in words. */
export type BookingTone = 'info' | 'warning' | 'success' | 'danger' | 'neutral'

export interface BookingPresentation {
  /**
   * `journey`: the tracker, the countdown and the next step are shown.
   * `legacy`: the manual flow-1 path and the terminal statuses keep their
   * existing labels and guidance only (ADR-001 §2.1, D2).
   */
  readonly mode: 'journey' | 'legacy'
  /** Her journey stage in `journey` mode; null in `legacy` mode. */
  readonly stage: JourneyStageId | null
  readonly label: string
  readonly guidance: string
  readonly tone: BookingTone
  /** A flow-1 booking on the manual path: shows the «مسار سابق» tag (copy §4.1). */
  readonly isLegacyFlow: boolean
}

interface StatusCopy {
  readonly label: string
  readonly guidance: string
  readonly tone: BookingTone
}

/**
 * Labels unchanged from the pre-Run-3 hub (D2: legacy rows stay readable);
 * guidance with the feminine forms corrected (08-copy-ar §11.1).
 */
const legacyStatusCopy: Readonly<Record<CustomerBookingStatus, StatusCopy>> = {
  pending_review: {
    label: 'قيد المراجعة',
    guidance:
      'تم استلام طلبكِ وهو الآن قيد المراجعة. لا يُعد التاريخ مؤكدًا حتى تتم الموافقة.',
    tone: 'info',
  },
  approved_hold: {
    label: 'تم قبول الطلب وحجز التاريخ',
    guidance:
      'تم قبول طلبكِ وحجز التاريخ مبدئيًا. ستنتقلين بعد ذلك إلى مرحلة العقد.',
    tone: 'warning',
  },
  contract_pending: {
    label: 'بانتظار توقيع العقد',
    guidance: 'طلبكِ بانتظار توقيع العقد قبل الانتقال إلى العربون.',
    tone: 'info',
  },
  contract_signed: {
    label: 'تم توقيع العقد',
    guidance: 'تم تسجيل توقيع العقد، وسيتم تزويدكِ بتعليمات العربون.',
    tone: 'info',
  },
  payment_pending: {
    label: 'بانتظار تحويل العربون',
    guidance: 'بانتظار تحويل العربون حسب التعليمات المتفق عليها عبر واتساب.',
    tone: 'info',
  },
  confirmed: {
    label: 'الحجز مؤكد',
    guidance: 'تم استلام العربون وتأكيد الحجز بنجاح.',
    tone: 'success',
  },
  rejected: {
    label: 'تعذر قبول الطلب',
    guidance:
      'تعذر قبول الطلب. يمكنكِ التواصل عبر واتساب للاستفسار أو اختيار تاريخ آخر.',
    tone: 'danger',
  },
  cancelled: {
    label: 'الحجز ملغي',
    guidance: 'تم إلغاء الحجز. يمكنكِ التواصل عبر واتساب إذا احتجتِ إلى توضيح.',
    tone: 'neutral',
  },
  expired: {
    label: 'انتهت مهلة الطلب',
    guidance:
      'انتهت مهلة متابعة هذا الطلب. يمكنكِ التواصل عبر واتساب أو تقديم طلب جديد.',
    tone: 'neutral',
  },
}

/** Card guidance for every stage — 08-copy-ar §4.2, second column. */
const stageGuidance: Readonly<Record<JourneyStageId, string>> = {
  pending_review:
    'تم استلام طلبكِ وهو الآن قيد المراجعة. لا يُعد التاريخ مؤكدًا حتى تتم الموافقة.',
  approved_hold:
    'تم قبول طلبكِ، وتاريخكِ محجوز مؤقتًا. أكملي حجزكِ قبل انتهاء المهلة أدناه.',
  terms_and_receipt_pending:
    'وافقي على شروط الحجز وارفعي إيصال تحويل العربون لتأكيد التاريخ نهائيًا.',
  receipt_review:
    'تم استلام إيصالكِ وهو الآن قيد المراجعة. سنؤكد الحجز فور التحقق منه.',
  confirmed: 'تم تأكيد حجزكِ بنجاح. نتطلع لتوثيق يومكِ بكل عناية.',
  pre_event_engagement:
    'أضيفي تفاصيل مناسبتكِ (الموقع، الوقت، طلباتكِ الخاصة) وحدّدي موافقتكِ على النشر.',
  gallery_open:
    'معرض صوركِ جاهز الآن. اختاري صوركِ المفضّلة، ثم أكّدي اختياركِ النهائي ضمن عدد باقتكِ.',
  gallery_locked:
    'تم قفل معرض صوركِ باختياركِ النهائي. سنبدأ تجهيز ألبومكِ.',
  album_design: 'يجري الآن تصميم ألبومكِ.',
  album_printing: 'ألبومكِ الآن قيد الطباعة.',
  album_ready: 'ألبومكِ جاهز! احجزي موعد الاستلام أو التوصيل.',
  handover_scheduling:
    'اختاري الاستلام من موقعنا أو التوصيل، وحدّدي الموعد المناسب لكِ.',
  handover_day:
    'اليوم موعد استلام ألبومكِ. تواصلي معنا عبر واتساب لتأكيد التفاصيل الأخيرة.',
  completed_feedback: 'تم تسليم ألبومكِ بنجاح. يسعدنا سماع رأيكِ.',
  privacy_cleanup:
    'لأسباب تتعلق بالخصوصية، تُحذف معاينات معرض صوركِ تلقائيًا بعد فترة الاحتفاظ. صوركِ الأصلية بأمان لدينا ضمن ألبومكِ.',
}

/** After the event day and until her gallery opens (copy §5.5, first row). */
const AWAITING_PREVIEWS_GUIDANCE =
  'لم تُرفع صور مناسبتكِ إلى معرضكِ بعد. سنُعلمكِ فور جاهزيته.'

/** Warning = she has something to do; info = we do; success = settled. */
const stageTones: Readonly<Record<JourneyStageId, BookingTone>> = {
  pending_review: 'info',
  approved_hold: 'warning',
  terms_and_receipt_pending: 'warning',
  receipt_review: 'info',
  confirmed: 'success',
  pre_event_engagement: 'success',
  gallery_open: 'warning',
  gallery_locked: 'info',
  album_design: 'info',
  album_printing: 'info',
  album_ready: 'success',
  handover_scheduling: 'warning',
  handover_day: 'success',
  completed_feedback: 'success',
  privacy_cleanup: 'neutral',
}

function isJourneyBooking(
  booking: CustomerBooking,
): booking is CustomerBooking & { stage: JourneyStageId } {
  return booking.stage !== null && booking.stageSubState !== 'legacy_flow'
}

function isLegacyFlowBooking(booking: CustomerBooking): boolean {
  switch (booking.status) {
    case 'contract_pending':
    case 'contract_signed':
      return true
    case 'approved_hold':
    case 'payment_pending':
      return booking.flowVersion === 1
    default:
      return false
  }
}

/** What her booking card says about where the booking stands. */
export function getBookingPresentation(
  booking: CustomerBooking,
): BookingPresentation {
  if (isJourneyBooking(booking)) {
    const { stage } = booking

    return {
      mode: 'journey',
      stage,
      label: journeyStageLabels[stage],
      guidance:
        booking.stageSubState === 'awaiting_previews'
          ? AWAITING_PREVIEWS_GUIDANCE
          : stageGuidance[stage],
      tone: stageTones[stage],
      isLegacyFlow: false,
    }
  }

  const copy = legacyStatusCopy[booking.status]

  return {
    mode: 'legacy',
    stage: null,
    label: copy.label,
    guidance: copy.guidance,
    tone: copy.tone,
    isLegacyFlow: isLegacyFlowBooking(booking),
  }
}

// ---------------------------------------------------------------------------
// Next step (copy §4.2, third column)
// ---------------------------------------------------------------------------

type StageNextStepPlan =
  | { readonly kind: 'view'; readonly view: StageViewId; readonly label: string }
  | { readonly kind: 'whatsapp'; readonly label: string }
  | { readonly kind: 'none' }

const stageNextSteps: Readonly<Record<JourneyStageId, StageNextStepPlan>> = {
  // «عرض التفاصيل» is the card's own details button.
  pending_review: { kind: 'none' },
  approved_hold: { kind: 'view', view: 'complete', label: 'أكملي حجزكِ' },
  terms_and_receipt_pending: {
    kind: 'view',
    view: 'complete',
    label: 'الموافقة ورفع الإيصال',
  },
  receipt_review: { kind: 'none' },
  confirmed: { kind: 'view', view: 'details', label: 'إكمال تفاصيل يومكِ' },
  pre_event_engagement: {
    kind: 'view',
    view: 'details',
    label: 'إضافة/تعديل التفاصيل',
  },
  gallery_open: { kind: 'view', view: 'gallery', label: 'فتح معرض صوركِ' },
  gallery_locked: { kind: 'view', view: 'gallery', label: 'عرض الصور المختارة' },
  album_design: { kind: 'none' },
  album_printing: { kind: 'none' },
  album_ready: { kind: 'view', view: 'handover', label: 'احجزي موعد الاستلام' },
  handover_scheduling: { kind: 'view', view: 'handover', label: 'اختيار الموعد' },
  handover_day: { kind: 'whatsapp', label: 'تواصلي عبر واتساب' },
  completed_feedback: {
    kind: 'view',
    view: 'feedback',
    label: 'مشاركة رأيكِ (اختياري)',
  },
  privacy_cleanup: { kind: 'none' },
}

export const NO_ACTION_NEEDED_TEXT = 'لا يوجد إجراء مطلوب منكِ حاليًا.'

export type BookingNextStep =
  /** A stage view is registered and allowed: a link to `?booking=&view=`. */
  | { readonly kind: 'view'; readonly view: StageViewId; readonly label: string }
  /** Handover day: WhatsApp becomes her primary action (ADR-001 §2.5). */
  | { readonly kind: 'whatsapp'; readonly label: string }
  /** The step exists but is not online yet: name it and point to WhatsApp. */
  | { readonly kind: 'offline'; readonly text: string }
  /** Nothing for her to do right now. */
  | { readonly kind: 'none'; readonly text: string }

/**
 * Her next step at her current stage, or null for a legacy or terminal
 * booking (their guidance already says what happens next). A step whose view
 * is not registered yet (Run 3 registers none) is described in words and
 * pointed to WhatsApp, never shown as a button that leads nowhere.
 */
export function getBookingNextStep(
  booking: CustomerBooking,
  registry: StageViewRegistry = stageViews,
): BookingNextStep | null {
  if (!isJourneyBooking(booking)) {
    return null
  }

  if (booking.stageSubState === 'awaiting_previews') {
    return { kind: 'none', text: NO_ACTION_NEEDED_TEXT }
  }

  const plan = stageNextSteps[booking.stage]

  if (plan.kind === 'whatsapp') {
    return plan
  }

  if (plan.kind === 'view' && resolveStageView(plan.view, booking, registry) !== null) {
    return plan
  }

  // A view registered later for this stage under another id still gets a
  // button (e.g. a privacy view added by W8-2).
  const otherView = findStageViewForBooking(booking, registry)
  const otherEntry = otherView === null ? undefined : registry[otherView]

  if (otherView !== null && otherEntry !== undefined) {
    return { kind: 'view', view: otherView, label: otherEntry.title }
  }

  if (plan.kind === 'view') {
    return {
      kind: 'offline',
      text: `${plan.label} — تواصلي معنا عبر واتساب لإتمام هذه الخطوة.`,
    }
  }

  return { kind: 'none', text: NO_ACTION_NEEDED_TEXT }
}

// ---------------------------------------------------------------------------
// Order: the booking that needs her most comes first
// ---------------------------------------------------------------------------

/**
 * 0 — she must act, usually against a deadline.
 * 1 — confirmed and coming up, or a step she can take at her own pace.
 * 2 — waiting on the studio (including the manual flow-1 path).
 * 3 — delivered.
 * 4 — closed (rejected, cancelled, expired).
 */
const stageUrgencyTiers: Readonly<Record<JourneyStageId, number>> = {
  pending_review: 2,
  approved_hold: 0,
  terms_and_receipt_pending: 0,
  receipt_review: 2,
  confirmed: 1,
  pre_event_engagement: 1,
  gallery_open: 0,
  gallery_locked: 2,
  album_design: 2,
  album_printing: 2,
  album_ready: 1,
  handover_scheduling: 0,
  handover_day: 0,
  completed_feedback: 3,
  privacy_cleanup: 3,
}

const statusUrgencyTiers: Readonly<Record<CustomerBookingStatus, number>> = {
  pending_review: 2,
  approved_hold: 2,
  contract_pending: 2,
  contract_signed: 2,
  payment_pending: 2,
  confirmed: 1,
  rejected: 4,
  cancelled: 4,
  expired: 4,
}

/** From this tier on, the most recently updated booking comes first. */
const SETTLED_TIER = 3

export function getUrgencyTier(booking: CustomerBooking): number {
  if (!isJourneyBooking(booking)) {
    return statusUrgencyTiers[booking.status]
  }

  return booking.stageSubState === 'awaiting_previews'
    ? 2
    : stageUrgencyTiers[booking.stage]
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const SQLITE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** A `YYYY-MM-DD` key at UTC noon (its day in any formatter set to UTC). */
function dateKeyToUtcNoon(value: string): Date | null {
  const match = DATE_KEY_PATTERN.exec(value)

  if (match === null) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day, 12))

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null
}

/**
 * A stored timestamp: an ISO instant, or a legacy SQLite
 * `YYYY-MM-DD HH:MM:SS` (UTC) from rows written before Run 3.
 */
export function parseBookingTimestamp(value: string): Date | null {
  return parseInstant(
    SQLITE_TIMESTAMP_PATTERN.test(value) ? `${value.replace(' ', 'T')}Z` : value,
  )
}

function deadlineSortMs(booking: CustomerBooking): number | null {
  const deadline = isJourneyBooking(booking) ? booking.stageDeadline : null

  if (deadline === null) {
    return null
  }

  const instant =
    deadline.kind === 'instant'
      ? parseInstant(deadline.value)
      : dateKeyToUtcNoon(deadline.value)

  return instant === null ? null : instant.getTime()
}

function compareAscendingNullsLast(a: number | null, b: number | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1
  }

  return a - b
}

function compareDescendingNullsLast(a: number | null, b: number | null): number {
  if (a === null || b === null) {
    return a === b ? 0 : a === null ? 1 : -1
  }

  return b - a
}

interface UrgencyEntry {
  readonly booking: CustomerBooking
  readonly index: number
  readonly tier: number
  readonly deadlineMs: number | null
  readonly eventMs: number | null
  readonly updatedMs: number | null
}

/**
 * The hub's order (design §5.5, "most urgent first"): by tier; within an
 * open tier the nearest deadline, then the nearest event date; within the
 * settled tiers the latest update. Ties keep the server's order (newest
 * request first). Returns a new array; the input is not changed.
 */
export function sortBookingsByUrgency(
  bookings: readonly CustomerBooking[],
): CustomerBooking[] {
  const entries: UrgencyEntry[] = bookings.map((booking, index) => ({
    booking,
    index,
    tier: getUrgencyTier(booking),
    deadlineMs: deadlineSortMs(booking),
    eventMs: dateKeyToUtcNoon(booking.eventDate)?.getTime() ?? null,
    updatedMs: parseBookingTimestamp(booking.updatedAt)?.getTime() ?? null,
  }))

  entries.sort((a, b) => {
    if (a.tier !== b.tier) {
      return a.tier - b.tier
    }

    const byTime =
      a.tier >= SETTLED_TIER
        ? compareDescendingNullsLast(a.updatedMs, b.updatedMs)
        : compareAscendingNullsLast(a.deadlineMs, b.deadlineMs) ||
          compareAscendingNullsLast(a.eventMs, b.eventMs)

    return byTime || a.index - b.index
  })

  return entries.map((entry) => entry.booking)
}

/**
 * Moves the booking named by `?booking=` to the top, so a link from an email
 * lands on it; the rest keep their order.
 */
export function moveBookingToFront(
  bookings: readonly CustomerBooking[],
  bookingId: string | null,
): CustomerBooking[] {
  const selected =
    bookingId === null
      ? undefined
      : bookings.find((booking) => booking.id === bookingId)

  return selected === undefined
    ? [...bookings]
    : [selected, ...bookings.filter((booking) => booking !== selected)]
}

// ---------------------------------------------------------------------------
// Counted phrases and formatting (Western digits, Riyadh time)
// ---------------------------------------------------------------------------

/**
 * «{n} طلبات معروضة» with number agreement (copy §11.2): the adjective
 * follows the noun's form for each range.
 */
export function formatShownRequestCount(count: number): string {
  const value = Number.isSafeInteger(count) && count >= 0 ? count : 0

  if (value === 0) {
    return 'لا توجد طلبات معروضة'
  }

  if (value === 1) {
    return 'طلب واحد معروض'
  }

  if (value === 2) {
    return 'طلبان معروضان'
  }

  if (value <= 10) {
    return `${formatArabicCount(value, 'request')} معروضة`
  }

  if (value <= 99) {
    return `${formatArabicCount(value, 'request')} معروضًا`
  }

  return `${formatArabicCount(value, 'request')} معروض`
}

const currencyFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn', {
  style: 'currency',
  currency: 'SAR',
  maximumFractionDigits: 0,
})

const eventDateFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const timestampFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  dateStyle: 'medium',
  timeStyle: 'short',
})

const slotDateFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

const slotTimeFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
})

/** Riyals, Western digits, no decimals. */
export function formatSar(value: number): string {
  return currencyFormatter.format(value)
}

/** The event day (a Riyadh calendar date), e.g. «الخميس، 12 نوفمبر 2026». */
export function formatEventDate(dateKey: string): string {
  const date = dateKeyToUtcNoon(dateKey)
  return date === null ? dateKey : eventDateFormatter.format(date)
}

/** A stored timestamp in Riyadh time, or «غير متوفر». */
export function formatBookingTimestamp(value: string): string {
  const date = parseBookingTimestamp(value)
  return date === null ? 'غير متوفر' : timestampFormatter.format(date)
}

/** One line for the card: coverage, then the album if she added one. */
export function describePackage(snapshot: BookingPackageSnapshot | null): string {
  if (snapshot === null) {
    return 'تفاصيل الباقة غير متاحة'
  }

  const coverage = `تغطية ${formatArabicCount(snapshot.coverage.durationHours, 'hour')}`

  return snapshot.album === null
    ? coverage
    : `${coverage} · ${snapshot.album.name}`
}

export function describeExtra(extra: BookingSnapshotExtra): string {
  switch (extra.kind) {
    case 'individual_print':
      return `${extra.name} — ${extra.quantity} × ${formatSar(extra.unitPrice)}`
    case 'magazine':
      return `${extra.name} — ${formatArabicCount(extra.quantity, 'copy')}، ${formatArabicCount(extra.pageCount, 'page')} لكل نسخة`
    case 'wooden_enlargement':
      return `${extra.name} (${extra.dimensions}) — الكمية ${extra.quantity}`
  }
}

// ---------------------------------------------------------------------------
// WhatsApp (copy §7: her own voice, the reference always included)
// ---------------------------------------------------------------------------

/**
 * FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE (Unicode UAX #9). Written as
 * escapes so no invisible bidi control character sits in the source.
 */
const FIRST_STRONG_ISOLATE = '\u2068'
const POP_DIRECTIONAL_ISOLATE = '\u2069'

/**
 * Wraps a Latin or digit run (the reference, a time) in Unicode isolates so
 * the right-to-left message never reorders it (ADR-001 §2.5).
 */
function isolate(text: string): string {
  return `${FIRST_STRONG_ISOLATE}${text}${POP_DIRECTIONAL_ISOLATE}`
}

function slotParts(booking: CustomerBooking): { date: string; time: string } | null {
  const deadline = booking.stageDeadline
  const start =
    deadline !== null && deadline.kind === 'instant'
      ? parseInstant(deadline.value)
      : null

  return start === null
    ? null
    : {
        date: slotDateFormatter.format(start),
        time: isolate(slotTimeFormatter.format(start)),
      }
}

function journeyWhatsAppMessage(
  booking: CustomerBooking & { stage: JourneyStageId },
  reference: string,
): string {
  switch (booking.stage) {
    case 'pending_review':
      return `السلام عليكم، أرسلتُ طلب حجز رقم ${reference} وأحببتُ الاطمئنان على حالته.`
    case 'approved_hold':
      return `السلام عليكم، حجزي رقم ${reference} تم قبوله، وأحتاج مساعدة لإكمال باقي الخطوات.`
    case 'terms_and_receipt_pending':
      return `السلام عليكم، أواجه صعوبة في رفع إيصال العربون لحجزي رقم ${reference}، هل يمكن المساعدة؟`
    case 'receipt_review':
      return `السلام عليكم، رفعتُ إيصال حجزي رقم ${reference} وأحببتُ الاطمئنان على مراجعته.`
    case 'confirmed':
      return `السلام عليكم، حجزي رقم ${reference} مؤكد والحمد لله، ولدي استفسار بخصوص يوم التصوير.`
    case 'pre_event_engagement':
      return booking.stageSubState === 'awaiting_previews'
        ? `السلام عليكم، بخصوص طلبي رقم ${reference}، أحببتُ الاستفسار عن التفاصيل.`
        : `السلام عليكم، بخصوص حجزي رقم ${reference}، أحتاج مساعدة في تحديث تفاصيل يوم المناسبة.`
    case 'gallery_open':
      return `السلام عليكم، بخصوص حجزي رقم ${reference}، أواجه صعوبة في اختيار صوري من المعرض.`
    case 'gallery_locked':
      return `السلام عليكم، أكملتُ اختيار صوري لحجزي رقم ${reference}، متى يبدأ تجهيز الألبوم؟`
    case 'album_design':
    case 'album_printing':
      return `السلام عليكم، أحببتُ الاطمئنان على حالة تجهيز ألبوم حجزي رقم ${reference}.`
    case 'album_ready':
      return `السلام عليكم، علمتُ أن ألبوم حجزي رقم ${reference} جاهز، وأودّ تحديد موعد الاستلام.`
    case 'handover_scheduling': {
      const slot = booking.stageSubState === 'handover_missed' ? null : slotParts(booking)

      // The hub does not know whether she chose pickup or delivery, so the
      // booked-slot message says «تسليم» (covers both; copy §10).
      return slot === null
        ? `السلام عليكم، علمتُ أن ألبوم حجزي رقم ${reference} جاهز، وأودّ تحديد موعد الاستلام.`
        : `السلام عليكم، معي حجز رقم ${reference}، وأودّ تأكيد موعد تسليم الألبوم يوم ${slot.date} الساعة ${slot.time}.`
    }
    case 'handover_day': {
      const slot = slotParts(booking)

      return slot === null
        ? `مرحبًا، معي حجز رقم ${reference}، وموعدي اليوم.`
        : `مرحبًا، معي حجز رقم ${reference}، وموعدي اليوم الساعة ${slot.time}.`
    }
    case 'completed_feedback':
      return `السلام عليكم، استلمتُ ألبوم حجزي رقم ${reference}، وأحببتُ مشاركة رأيي.`
    case 'privacy_cleanup':
      return `السلام عليكم، لدي استفسار عن حذف صور معرض حجزي رقم ${reference}.`
  }
}

function legacyWhatsAppMessage(
  status: CustomerBookingStatus,
  reference: string,
): string {
  switch (status) {
    case 'pending_review':
      return `السلام عليكم، أرسلتُ طلب حجز رقم ${reference} وأحببتُ الاطمئنان على حالته.`
    case 'approved_hold':
    case 'contract_pending':
    case 'contract_signed':
    case 'payment_pending':
      return `السلام عليكم، حجزي رقم ${reference} تم قبوله، وأحتاج مساعدة لإكمال باقي الخطوات.`
    case 'confirmed':
      return `السلام عليكم، حجزي رقم ${reference} مؤكد والحمد لله، ولدي استفسار بخصوص يوم التصوير.`
    case 'rejected':
    case 'cancelled':
    case 'expired':
      return `السلام عليكم، بخصوص طلبي رقم ${reference}، أحببتُ الاستفسار عن التفاصيل.`
  }
}

/** The prefilled message for this booking's WhatsApp button (never auto-sent). */
export function buildBookingWhatsAppMessage(booking: CustomerBooking): string {
  const reference = isolate(booking.id)

  return isJourneyBooking(booking)
    ? journeyWhatsAppMessage(booking, reference)
    : legacyWhatsAppMessage(booking.status, reference)
}

export function getBookingWhatsAppUrl(booking: CustomerBooking): string {
  return buildWhatsAppUrl(buildBookingWhatsAppMessage(booking))
}
