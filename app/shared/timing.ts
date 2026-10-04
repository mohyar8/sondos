/**
 * Timing rules for the booking journey — decision D5 (owner-approved
 * 2026-09-24). One source of truth for the Worker (jobs, emails, guards) and
 * the SPA (countdowns, journey tracker). Change a number here, nowhere else.
 *
 * Time model (ADR-001 §2.2):
 * - Instants are ISO-8601 UTC strings produced by `new Date().toISOString()`.
 * - Calendar dates (`event_date`, `slot_date`) are `YYYY-MM-DD` in
 *   Asia/Riyadh. The offset is never hard-coded in business logic; the UTC+3
 *   fallback below is used only if `Intl` returns unusable parts.
 */

export const RIYADH_TIME_ZONE = 'Asia/Riyadh'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export const TIMING = {
  /** Admin response SLA for a new request (badge only; never blocks an action). */
  adminResponseSlaMs: 24 * HOUR_MS,
  /** Hold window from approval to deadline (flow 2). */
  holdWindowMs: 48 * HOUR_MS,
  /** Hold reminders, measured back from `hold_expires_at`. */
  holdReminderOffsetsMs: [24 * HOUR_MS, 6 * HOUR_MS],
  /** Admin verification SLA for a submitted receipt (badge only). */
  receiptReviewSlaMs: 24 * HOUR_MS,
  /** Added to the hold when a receipt is rejected or the admin extends it. */
  holdExtensionMs: 24 * HOUR_MS,
  /** Pre-event reminders, in Riyadh calendar days before `event_date`. */
  eventReminderDaysBefore: [7, 1],
  /** Gallery selection window after the gallery opens. */
  selectionWindowMs: 14 * DAY_MS,
  /** Selection reminders, in days before the selection deadline. */
  selectionReminderDaysBefore: [7, 2],
  /** Handover reminder, in Riyadh calendar days before `slot_date`. */
  handoverReminderDaysBefore: 1,
  /** Feedback request, in days after the handover is completed. */
  feedbackRequestDaysAfter: 2,
  /** Gallery previews are purged this long after the handover completes. */
  previewRetentionMs: 30 * DAY_MS,
  /** Reminder emails are only sent between these Riyadh hours [start, end). */
  sendWindowRiyadh: { startHour: 9, endHour: 21 },
} as const

/**
 * Booking horizon (audit SEC-03): the latest event date a customer may
 * request is today in Asia/Riyadh plus this many days. The Worker refuses a
 * later date (400 BOOKING_TOO_FAR_AHEAD) and the SPA calendar stops there.
 */
export const BOOKING_HORIZON_DAYS = 730

/**
 * B1: `confirm_payment` and `extend_hold` stay allowed this long after a
 * flow-2 hold's deadline while the row is still `approved_hold`, never past
 * riyadhStartOfDay(event_date).
 */
export const HOLD_GRACE_HOURS = 72

/**
 * C-1 / TM-07: an admin request needs a sign-in (`auth_time`) at most this
 * old; older answers 403 REAUTH_REQUIRED.
 */
export const ADMIN_SESSION_MAX_HOURS = 12

/**
 * TM-08 / SB-14: a "recent sign-in" (AD+R, AD+S, CO+R routes) is an
 * `auth_time` at most this many seconds old.
 */
export const RECENT_SIGN_IN_SECONDS = 600

/**
 * TM-03: a change to an existing bank or contact revision reaches customers
 * this long after it is saved (the first entry is immediate).
 */
export const SETTINGS_DELAY_HOURS = 24

const RIYADH_UTC_OFFSET_MS = 3 * HOUR_MS
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
/** A 24-hour wall-clock time, `HH:MM`, ASCII digits only. */
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const TWO_DIGITS = /^\d{2}$/

const riyadhPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: RIYADH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

interface RiyadhParts {
  readonly dateKey: string
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** A two-digit part within [0, maximum], or null (a missing part is not 0). */
function readTwoDigitPart(value: string, maximum: number): number | null {
  if (!TWO_DIGITS.test(value)) {
    return null
  }

  const parsed = Number(value)
  return parsed <= maximum ? parsed : null
}

function readRiyadhParts(instant: Date): RiyadhParts {
  const parts = riyadhPartsFormatter.formatToParts(instant)
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''

  const dateKey = `${pick('year')}-${pick('month')}-${pick('day')}`
  const hour = readTwoDigitPart(pick('hour'), 23)
  const minute = readTwoDigitPart(pick('minute'), 59)
  const second = readTwoDigitPart(pick('second'), 59)

  if (isValidDateKey(dateKey) && hour !== null && minute !== null && second !== null) {
    return { dateKey, hour, minute, second }
  }

  // Fallback: Riyadh has no daylight saving time, so a fixed offset is exact.
  const shifted = new Date(instant.getTime() + RIYADH_UTC_OFFSET_MS)
  return {
    dateKey: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

/** True for a real calendar date written as `YYYY-MM-DD`. */
export function isValidDateKey(value: string): boolean {
  const match = DATE_KEY_PATTERN.exec(value)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day, 12))

  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

/** The Asia/Riyadh calendar date of an instant, as `YYYY-MM-DD`. */
export function riyadhDateKey(instant: Date = new Date()): string {
  return readRiyadhParts(instant).dateKey
}

/**
 * Today's date in Asia/Riyadh, `YYYY-MM-DD` (M2). Every "today" in a rule
 * (event passed, handover day, production) is this key, computed in the
 * Worker and bound as a parameter; never SQL `date('now')`, which is the
 * UTC date and still yesterday between 00:00 and 03:00 Riyadh.
 */
export function riyadhTodayKey(now: Date = new Date()): string {
  return readRiyadhParts(now).dateKey
}

/** The Asia/Riyadh hour (0–23) of an instant. */
export function riyadhHour(instant: Date = new Date()): number {
  return readRiyadhParts(instant).hour
}

/**
 * True for a 24-hour wall-clock time written as `HH:MM` with ASCII digits
 * (00:00–23:59). Run toAsciiDigits (shared/text.ts) on input first.
 */
export function isValidLocalTime(value: string): boolean {
  return LOCAL_TIME_PATTERN.test(value)
}

/** Asia/Riyadh's offset from UTC at an instant, in ms (whole seconds). */
function riyadhOffsetMs(instant: Date): number {
  const parts = readRiyadhParts(instant)
  const [year, month, day] = parts.dateKey.split('-').map(Number)
  const wallClockAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    parts.hour,
    parts.minute,
    parts.second,
  )

  return wallClockAsUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * The instant, as an ISO-8601 UTC string, of a Riyadh wall-clock time on a
 * Riyadh date: `riyadhLocalToInstant('2026-10-01', '16:00')` is
 * '2026-10-01T13:00:00.000Z'. The offset comes from the time-zone database,
 * and the result is read back and must show the same date and time, so a
 * wrong database fails closed instead of moving a slot. Null for an invalid
 * date key or time (ASCII `HH:MM` only).
 */
export function riyadhLocalToInstant(
  dateKey: string,
  localTime: string,
): string | null {
  const time = LOCAL_TIME_PATTERN.exec(localTime)

  if (!isValidDateKey(dateKey) || !time) {
    return null
  }

  const hour = Number(time[1])
  const minute = Number(time[2])
  const [year, month, day] = dateKey.split('-').map(Number)
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute)
  const instant = new Date(
    wallClockAsUtc - riyadhOffsetMs(new Date(wallClockAsUtc)),
  )
  const check = readRiyadhParts(instant)

  if (
    check.dateKey !== dateKey ||
    check.hour !== hour ||
    check.minute !== minute ||
    check.second !== 0
  ) {
    return null
  }

  return instant.toISOString()
}

/**
 * 00:00 Asia/Riyadh on a date, as an ISO-8601 UTC string (21:00 UTC the day
 * before): the "event start" for grace and deadline rules. Null for an
 * invalid date key.
 */
export function riyadhStartOfDay(dateKey: string): string | null {
  return riyadhLocalToInstant(dateKey, '00:00')
}

/** True while reminder emails may be sent (09:00–21:00 Riyadh). */
export function isWithinSendWindow(instant: Date = new Date()): boolean {
  const hour = riyadhHour(instant)
  return hour >= TIMING.sendWindowRiyadh.startHour && hour < TIMING.sendWindowRiyadh.endHour
}

/**
 * Adds whole days to a `YYYY-MM-DD` key using UTC-noon arithmetic, so no time
 * zone or daylight-saving shift can move the result. Returns null for an
 * invalid key or a non-integer day count.
 */
export function addDaysToDateKey(dateKey: string, days: number): string | null {
  if (!isValidDateKey(dateKey) || !Number.isInteger(days)) {
    return null
  }

  const [year, month, day] = dateKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12))
  return shifted.toISOString().slice(0, 10)
}

/**
 * The latest bookable event date, `YYYY-MM-DD`: the Riyadh date of `instant`
 * plus BOOKING_HORIZON_DAYS. The same computation for the Worker's check and
 * the calendar's maximum date.
 */
export function latestBookableDateKey(instant: Date = new Date()): string {
  const latest = addDaysToDateKey(riyadhDateKey(instant), BOOKING_HORIZON_DAYS)

  if (latest === null) {
    throw new Error('Booking horizon date could not be computed')
  }

  return latest
}

/**
 * Whole calendar days from `fromKey` to `toKey` (negative when `toKey` is
 * earlier). Returns null if either key is invalid.
 */
export function daysBetweenDateKeys(fromKey: string, toKey: string): number | null {
  if (!isValidDateKey(fromKey) || !isValidDateKey(toKey)) {
    return null
  }

  const toUtcNoon = (key: string): number => {
    const [year, month, day] = key.split('-').map(Number)
    return Date.UTC(year, month - 1, day, 12)
  }

  return Math.round((toUtcNoon(toKey) - toUtcNoon(fromKey)) / DAY_MS)
}

/** Parses an ISO-8601 instant; returns null instead of an invalid Date. */
export function parseInstant(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** An instant `ms` milliseconds after `instant`, as an ISO string. */
export function addMsToInstant(instant: Date, ms: number): string {
  return new Date(instant.getTime() + ms).toISOString()
}
