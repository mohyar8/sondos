import type { JourneyDeadline, JourneyStageId } from '../../../shared/journey'
import {
  RIYADH_TIME_ZONE,
  TIMING,
  daysBetweenDateKeys,
  isValidDateKey,
  parseInstant,
  riyadhDateKey,
} from '../../../shared/timing'
import { formatArabicCount } from './arabic-count'

/**
 * The countdown's pure model (ADR-001 W3-7 T2, design §4.9, copy §4.3):
 * which deadline a stage counts down to, what it says at each moment, and
 * when the display next needs to change. Countdown.tsx only renders it.
 *
 * "Now" is always the SERVER's clock: the device clock plus the offset
 * measured when /api/bookings/me answered (serverClockOffsetMs), so a phone
 * set to the wrong time still shows the right countdown.
 */

/** The display ticks at most every 30 s (it shows minutes, never seconds). */
export const COUNTDOWN_TICK_MS = 30_000

/** Below this share of its window, a hold or selection countdown turns urgent. */
const URGENT_WINDOW_SHARE = 0.1

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Lands the tick just after a deadline, so expiry shows without delay. */
const DEADLINE_TICK_MARGIN_MS = 250
const MINIMUM_TICK_MS = 1_000

export type CountdownPurpose = 'hold' | 'selection' | 'event' | 'handover' | 'purge'

/** Which deadline each stage counts down to (ADR-001 §2.1 "Deadline shown"). */
const stageCountdownPurposes: Readonly<
  Record<JourneyStageId, CountdownPurpose | null>
> = {
  pending_review: null,
  approved_hold: 'hold',
  terms_and_receipt_pending: 'hold',
  receipt_review: null,
  confirmed: 'event',
  pre_event_engagement: 'event',
  gallery_open: 'selection',
  gallery_locked: null,
  album_design: null,
  album_printing: null,
  album_ready: null,
  handover_scheduling: 'handover',
  handover_day: 'handover',
  completed_feedback: 'purge',
  privacy_cleanup: null,
}

export function getCountdownPurpose(stage: JourneyStageId): CountdownPurpose | null {
  return stageCountdownPurposes[stage]
}

/**
 * - `running`: time is left.
 * - `urgent`: under 10% of a hold or selection window is left.
 * - `today`: the event or the handover is today (Riyadh).
 * - `expired`: the deadline has passed.
 */
export type CountdownStatus = 'running' | 'urgent' | 'today' | 'expired'

/** Maps to the semantic tokens (warning, danger, info) or the neutral line. */
export type CountdownTone = 'warning' | 'danger' | 'info' | 'neutral'

export interface CountdownView {
  readonly purpose: CountdownPurpose
  readonly status: CountdownStatus
  readonly tone: CountdownTone
  /** «الوقت المتبقي …:» — null when only a message is shown. */
  readonly label: string | null
  /** The time left, e.g. «يوم واحد و5 ساعات» (Western digits). */
  readonly value: string | null
  /** The urgent, today or expired sentence (copy §4.3), if any. */
  readonly message: string | null
  readonly deadlineLabel: string
  /** The deadline in Riyadh time, e.g. «الجمعة، 25 سبتمبر 2026 في 3:00 م». */
  readonly deadlineText: string
  /** Machine-readable deadline for <time dateTime>. */
  readonly deadlineDateTime: string
  /** What a screen reader hears when the status changes while she watches. */
  readonly announcement: string
}

interface PurposeCopy {
  readonly label: string
  readonly urgent: string | null
  readonly today: string | null
  readonly expired: string
  readonly deadlineLabel: string
}

/**
 * Copy §4.3 for hold, selection and handover. The event and purge
 * countdowns and the deadline labels have no §4.3 text yet (new strings,
 * reported for the copywriter's review).
 */
const purposeCopy: Readonly<Record<CountdownPurpose, PurposeCopy>> = {
  hold: {
    label: 'الوقت المتبقي لإكمال حجزكِ:',
    urgent: 'تنتهي مهلة حجزكِ قريبًا — أكملي الآن لتفادي إلغاء الحجز المبدئي',
    today: null,
    expired:
      'انتهت مهلة حجزكِ المبدئي، وأصبح التاريخ متاحًا للطلبات الأخرى. يمكنكِ التواصل عبر واتساب أو إرسال طلب جديد.',
    deadlineLabel: 'آخر موعد لإكمال حجزكِ:',
  },
  selection: {
    label: 'الوقت المتبقي لاختيار صوركِ:',
    urgent: 'تبقّى وقت قصير لاختيار صوركِ — أكملي اختيارك قبل انتهاء المهلة',
    today: null,
    expired:
      'تجاوزنا الموعد المقترح لاختيار صوركِ دون اختيار نهائي منكِ. تواصلي معنا عبر واتساب وسنرتّب معكِ وقتًا إضافيًا.',
    deadlineLabel: 'الموعد المقترح لإنهاء اختياركِ:',
  },
  event: {
    label: 'موعد مناسبتكِ بعد:',
    urgent: null,
    today: 'اليوم موعد مناسبتكِ.',
    expired: 'مضى موعد مناسبتكِ.',
    deadlineLabel: 'تاريخ المناسبة:',
  },
  handover: {
    label: 'موعدكِ بعد:',
    urgent: null,
    today: 'موعدكِ اليوم',
    expired:
      'مضى موعد الاستلام المحدد. تواصلي معنا عبر واتساب لترتيب موعد جديد.',
    deadlineLabel: 'موعد الاستلام:',
  },
  purge: {
    label: 'تُحذف معاينات صوركِ تلقائيًا بعد:',
    urgent: null,
    today: null,
    expired: 'حُذفت معاينات صوركِ تلقائيًا حفاظًا على خصوصيتكِ.',
    deadlineLabel: 'موعد الحذف التلقائي:',
  },
}

/** The full window each duration countdown is measured against. */
const purposeWindowMs: Readonly<Record<'hold' | 'selection', number>> = {
  hold: TIMING.holdWindowMs,
  selection: TIMING.selectionWindowMs,
}

// Western digits (nu-latn) and the Gregorian calendar, in Riyadh time
// (03-design-system §2.3).
const instantFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const dateFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})

const timeFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  timeZone: RIYADH_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
})

/** A `YYYY-MM-DD` key at UTC noon, so formatting it in UTC keeps its day. */
function dateKeyToUtcNoon(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)

  if (match === null) {
    return null
  }

  const noon = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12),
  )
  return Number.isNaN(noon.getTime()) ? null : noon
}

/**
 * Time left, in at most two units: «يوم واحد و5 ساعات», «5 ساعات و12
 * دقيقة», «12 دقيقة», or «أقل من دقيقة». Minutes are rounded down.
 */
export function formatRemainingDuration(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs < MINUTE_MS) {
    return 'أقل من دقيقة'
  }

  const totalMinutes = Math.floor(remainingMs / MINUTE_MS)
  const days = Math.floor(totalMinutes / (DAY_MS / MINUTE_MS))
  const hours = Math.floor((totalMinutes % (DAY_MS / MINUTE_MS)) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) {
    return hours > 0
      ? `${formatArabicCount(days, 'day')} و${formatArabicCount(hours, 'hour')}`
      : formatArabicCount(days, 'day')
  }

  if (hours > 0) {
    return minutes > 0
      ? `${formatArabicCount(hours, 'hour')} و${formatArabicCount(minutes, 'minute')}`
      : formatArabicCount(hours, 'hour')
  }

  return formatArabicCount(minutes, 'minute')
}

function announcementFor(
  label: string | null,
  value: string | null,
  message: string | null,
): string {
  if (message !== null) {
    return message
  }

  return label !== null && value !== null ? `${label} ${value}` : ''
}

function buildView(
  purpose: CountdownPurpose,
  status: CountdownStatus,
  tone: CountdownTone,
  parts: {
    readonly value: string | null
    readonly message: string | null
    readonly deadlineText: string
    readonly deadlineDateTime: string
  },
): CountdownView {
  const copy = purposeCopy[purpose]
  const label = parts.value === null ? null : copy.label

  return {
    purpose,
    status,
    tone,
    label,
    value: parts.value,
    message: parts.message,
    deadlineLabel: copy.deadlineLabel,
    deadlineText: parts.deadlineText,
    deadlineDateTime: parts.deadlineDateTime,
    announcement: announcementFor(label, parts.value, parts.message),
  }
}

/** Hold, selection and purge: a duration down to an instant. */
function computeDurationView(
  purpose: 'hold' | 'selection' | 'purge',
  deadline: JourneyDeadline,
  nowMs: number,
): CountdownView | null {
  if (deadline.kind !== 'instant') {
    return null
  }

  const target = parseInstant(deadline.value)

  if (target === null) {
    return null
  }

  const copy = purposeCopy[purpose]
  const remainingMs = target.getTime() - nowMs
  const deadlineParts = {
    deadlineText: instantFormatter.format(target),
    deadlineDateTime: target.toISOString(),
  }

  if (remainingMs <= 0) {
    const tone: CountdownTone =
      purpose === 'hold' ? 'danger' : purpose === 'selection' ? 'warning' : 'neutral'
    return buildView(purpose, 'expired', tone, {
      value: null,
      message: copy.expired,
      ...deadlineParts,
    })
  }

  const value = formatRemainingDuration(remainingMs)

  if (purpose === 'purge') {
    return buildView(purpose, 'running', 'neutral', {
      value,
      message: null,
      ...deadlineParts,
    })
  }

  const isUrgent = remainingMs < purposeWindowMs[purpose] * URGENT_WINDOW_SHARE

  return isUrgent
    ? buildView(purpose, 'urgent', 'danger', {
        value,
        message: copy.urgent,
        ...deadlineParts,
      })
    : buildView(purpose, 'running', 'warning', {
        value,
        message: null,
        ...deadlineParts,
      })
}

/** Event and handover: whole Riyadh calendar days down to a day. */
function computeDayView(
  purpose: 'event' | 'handover',
  deadline: JourneyDeadline,
  nowMs: number,
): CountdownView | null {
  const instant = deadline.kind === 'instant' ? parseInstant(deadline.value) : null

  if (deadline.kind === 'instant' && instant === null) {
    return null
  }

  const dateKey = instant === null ? deadline.value : riyadhDateKey(instant)

  if (!isValidDateKey(dateKey)) {
    return null
  }

  const days = daysBetweenDateKeys(riyadhDateKey(new Date(nowMs)), dateKey)

  if (days === null) {
    return null
  }

  const copy = purposeCopy[purpose]
  const dateNoon = instant === null ? dateKeyToUtcNoon(dateKey) : null
  let deadlineParts: { readonly deadlineText: string; readonly deadlineDateTime: string }

  if (instant !== null) {
    deadlineParts = {
      deadlineText: instantFormatter.format(instant),
      deadlineDateTime: instant.toISOString(),
    }
  } else if (dateNoon !== null) {
    deadlineParts = {
      deadlineText: dateFormatter.format(dateNoon),
      deadlineDateTime: dateKey,
    }
  } else {
    return null
  }

  if (days < 0) {
    return buildView(purpose, 'expired', purpose === 'handover' ? 'warning' : 'neutral', {
      value: null,
      message: copy.expired,
      ...deadlineParts,
    })
  }

  if (days === 0) {
    const todayMessage =
      purpose === 'handover' && instant !== null
        ? `${copy.today ?? ''} الساعة ${timeFormatter.format(instant)}`
        : copy.today

    return buildView(purpose, 'today', 'info', {
      value: null,
      message: todayMessage,
      ...deadlineParts,
    })
  }

  return buildView(purpose, 'running', 'info', {
    value: formatArabicCount(days, 'day'),
    message: null,
    ...deadlineParts,
  })
}

/**
 * What the countdown shows at `nowMs` (server-corrected epoch ms), or null
 * when the deadline cannot be read — the caller then renders nothing rather
 * than a wrong or NaN value.
 */
export function computeCountdown(
  purpose: CountdownPurpose,
  deadline: JourneyDeadline,
  nowMs: number,
): CountdownView | null {
  if (!Number.isFinite(nowMs)) {
    return null
  }

  switch (purpose) {
    case 'hold':
    case 'selection':
    case 'purge':
      return computeDurationView(purpose, deadline, nowMs)
    case 'event':
    case 'handover':
      return computeDayView(purpose, deadline, nowMs)
  }
}

/**
 * Milliseconds until the display may next change, or null once it never
 * will (expired or unreadable): at most every 30 s, and just after the
 * deadline itself so expiry shows promptly.
 */
export function getNextCountdownTickMs(
  purpose: CountdownPurpose,
  deadline: JourneyDeadline,
  nowMs: number,
): number | null {
  const view = computeCountdown(purpose, deadline, nowMs)

  if (view === null || view.status === 'expired') {
    return null
  }

  const target = deadline.kind === 'instant' ? parseInstant(deadline.value) : null

  if (target === null || view.purpose === 'event' || view.purpose === 'handover') {
    return COUNTDOWN_TICK_MS
  }

  const untilDeadline = target.getTime() - nowMs + DEADLINE_TICK_MARGIN_MS
  return Math.max(MINIMUM_TICK_MS, Math.min(COUNTDOWN_TICK_MS, untilDeadline))
}

/** A usable clock offset: finite, else 0 (the device clock). */
export function normalizeClockOffset(offsetMs: number | null | undefined): number {
  return typeof offsetMs === 'number' && Number.isFinite(offsetMs) ? offsetMs : 0
}

export interface CountdownClockState {
  /** Device-clock epoch ms of the last tick. */
  readonly nowMs: number
  /** The live-region text; changes only when the status changes on a tick. */
  readonly announcement: string
}

/**
 * The next clock state for a tick at `nowMs`. The announcement changes only
 * when a tick moves the countdown to another status (e.g. running → urgent
 * → expired), so a screen reader is told about thresholds, not every minute.
 */
export function advanceCountdownClock(
  previous: CountdownClockState,
  nowMs: number,
  purpose: CountdownPurpose,
  deadline: JourneyDeadline,
  offsetMs: number,
): CountdownClockState {
  const before = computeCountdown(purpose, deadline, previous.nowMs + offsetMs)
  const after = computeCountdown(purpose, deadline, nowMs + offsetMs)
  const announcement =
    before !== null && after !== null && before.status !== after.status
      ? after.announcement
      : previous.announcement

  return { nowMs, announcement }
}

/** The part of `document` the clock needs (a fake in tests). */
export interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

interface CountdownClockOptions {
  readonly visibility: VisibilitySource
  /** Delay until the next tick (getNextCountdownTickMs), or null to stop. */
  readonly getDelayMs: () => number | null
  readonly onTick: () => void
}

/**
 * Runs the countdown's timer: one pending setTimeout at a time, none while
 * the tab is hidden, an immediate tick when it becomes visible again, and
 * nothing left behind after the returned cleanup runs.
 */
export function subscribeToCountdownClock({
  visibility,
  getDelayMs,
  onTick,
}: CountdownClockOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let isActive = true

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const schedule = () => {
    clearTimer()

    if (!isActive || visibility.hidden) {
      return
    }

    const delayMs = getDelayMs()

    if (delayMs === null) {
      return
    }

    timer = setTimeout(() => {
      timer = null
      onTick()
      schedule()
    }, delayMs)
  }

  const handleVisibilityChange = () => {
    if (visibility.hidden) {
      clearTimer()
      return
    }

    // Catch up at once: time kept passing while the tab was hidden.
    onTick()
    schedule()
  }

  visibility.addEventListener('visibilitychange', handleVisibilityChange)
  schedule()

  return () => {
    isActive = false
    clearTimer()
    visibility.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}
