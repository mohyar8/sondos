/**
 * Admin calendar and customers directory (plan 11 §3.2 #36–#37, W2-11):
 * the wire contract shared by the Worker (worker/portal/admin-calendar.ts,
 * worker/portal/admin-customers.ts) and the admin SPA tabs (W3-06, W3-09),
 * plus the pure parsers both sides use. No I/O.
 *
 * Admin-only data (SB-13): the customers directory returns the full name,
 * email and phone of each customer; the calendar returns first names only.
 * Erased customers (users.erased_at set) never appear in the directory, and
 * their bookings show on the calendar without a name.
 *
 * Neither route takes free text: search is POST /api/admin/search/* (#41,
 * #42, TM-17), so no name, phone or email ever travels in a URL.
 */

import type { BookingStatus } from '../admin.js'
import type { JourneyStageId } from '../journey.js'

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** #36: at most this many bookings in one calendar month answer. */
export const CALENDAR_MAXIMUM_BOOKINGS = 500

/** #37: customers per page when `limit` is absent, and its ceiling. */
export const CUSTOMERS_DEFAULT_LIMIT = 50
export const CUSTOMERS_MAXIMUM_LIMIT = 100

/** #37 detail: at most this many booking summaries for one customer. */
export const CUSTOMER_MAXIMUM_BOOKINGS = 100

/** The calendar accepts months of these years only. */
export const CALENDAR_FIRST_YEAR = 2000
export const CALENDAR_LAST_YEAR = 2100

/**
 * The booking statuses the calendar leaves out unless `includeClosed=1`:
 * a closed request no longer occupies its date.
 */
export const calendarClosedStatuses = [
  'rejected',
  'cancelled',
  'expired',
] as const satisfies readonly BookingStatus[]

// ---------------------------------------------------------------------------
// #36 GET /api/admin/calendar?month=YYYY-MM[&includeClosed=1]
// ---------------------------------------------------------------------------

export interface AdminCalendarBooking {
  readonly id: string
  readonly status: BookingStatus
  /** Derived journey stage; null for legacy and closed statuses. */
  readonly stage: JourneyStageId | null
  /** Null once the customer's data was erased. */
  readonly customerFirstName: string | null
  /** From the stored package snapshot; null when it has none. */
  readonly packageName: string | null
}

export interface AdminCalendarBlock {
  /** The admin's own note on the blocked date; null when she left none. */
  readonly reason: string | null
}

export interface AdminCalendarDay {
  /** `YYYY-MM-DD`. */
  readonly date: string
  readonly blocked: AdminCalendarBlock | null
  /** Oldest request first. */
  readonly bookings: readonly AdminCalendarBooking[]
}

export interface AdminCalendarResponse {
  readonly ok: true
  /** `YYYY-MM`, the month answered. */
  readonly month: string
  readonly includeClosed: boolean
  /** Every day of the month, in order. */
  readonly days: readonly AdminCalendarDay[]
  /**
   * True when the month held more than CALENDAR_MAXIMUM_BOOKINGS bookings
   * and the later ones (by date) were left out.
   */
  readonly truncated: boolean
}

export interface CalendarMonth {
  /** `YYYY-MM`. */
  readonly month: string
  /** `YYYY-MM-01`. */
  readonly firstDate: string
  /** The month's last day, `YYYY-MM-DD`. */
  readonly lastDate: string
  /** Every date of the month, in order. */
  readonly dates: readonly string[]
}

const CALENDAR_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/

/**
 * Strict `YYYY-MM` (ASCII digits, month 01–12, year within
 * CALENDAR_FIRST_YEAR…CALENDAR_LAST_YEAR); null for anything else,
 * including surrounding spaces, other digit scripts or a day part.
 */
export function parseCalendarMonth(value: string): CalendarMonth | null {
  const match = CALENDAR_MONTH_PATTERN.exec(value)

  if (!match) {
    return null
  }

  const year = Number(match[1])
  const monthNumber = Number(match[2])

  if (year < CALENDAR_FIRST_YEAR || year > CALENDAR_LAST_YEAR) {
    return null
  }

  // Day 0 of the next month is the last day of this one (UTC, no DST).
  const dayCount = new Date(Date.UTC(year, monthNumber, 0, 12)).getUTCDate()
  const dates: string[] = []

  for (let day = 1; day <= dayCount; day += 1) {
    dates.push(`${value}-${String(day).padStart(2, '0')}`)
  }

  return {
    month: value,
    firstDate: `${value}-01`,
    lastDate: `${value}-${String(dayCount).padStart(2, '0')}`,
    dates,
  }
}

// ---------------------------------------------------------------------------
// #37 GET /api/admin/customers?cursor=&limit=, GET /api/admin/customers/{id}
// ---------------------------------------------------------------------------

export interface AdminDirectoryCustomer {
  readonly id: string
  readonly firstName: string
  readonly lastName: string
  readonly email: string
  readonly phone: string
  /** ISO-8601 UTC instant (`…T…Z`), converted from the stored value. */
  readonly createdAt: string
  /** ISO-8601 UTC instant of her last phone/email change (TM-08), or null. */
  readonly contactChangedAt: string | null
  /** All her booking requests, closed ones included. */
  readonly bookingCount: number
  /** The latest event date among those requests, `YYYY-MM-DD`, or null. */
  readonly lastEventDate: string | null
}

export interface AdminCustomersResponse {
  readonly ok: true
  /** Newest first. */
  readonly customers: readonly AdminDirectoryCustomer[]
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null
}

export interface AdminCustomerBookingSummary {
  readonly id: string
  /** `YYYY-MM-DD`. */
  readonly eventDate: string
  readonly status: BookingStatus
  readonly stage: JourneyStageId | null
  readonly packageName: string | null
  readonly estimatedTotal: number
  /** As stored on the booking. */
  readonly createdAt: string
}

export interface AdminCustomerDetailResponse {
  readonly ok: true
  readonly customer: AdminDirectoryCustomer
  /** Newest request first. */
  readonly bookings: readonly AdminCustomerBookingSummary[]
  /** True when she has more than CUSTOMER_MAXIMUM_BOOKINGS requests. */
  readonly bookingsTruncated: boolean
}

// ---------------------------------------------------------------------------
// users.created_at: the SQLite CURRENT_TIMESTAMP format
// ---------------------------------------------------------------------------

const CURRENT_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/**
 * True for a real UTC instant written exactly as SQLite's CURRENT_TIMESTAMP
 * and datetime() write it: `YYYY-MM-DD HH:MM:SS` (ASCII digits, a space, no
 * fraction, no zone). users.created_at has that format, unlike the ISO-8601
 * instants of the portal tables, so the customers cursor checks it here and
 * never with an ISO validator.
 */
export function isCurrentTimestampText(value: string): boolean {
  const match = CURRENT_TIMESTAMP_PATTERN.exec(value)

  if (!match) {
    return false
  }

  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second))

  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day &&
    probe.getUTCHours() === hour &&
    probe.getUTCMinutes() === minute &&
    probe.getUTCSeconds() === second
  )
}

/**
 * `YYYY-MM-DD HH:MM:SS` (UTC) → `YYYY-MM-DDTHH:MM:SS.000Z`, so no browser
 * reads the stored text as local time; null when the text is not in that
 * format.
 */
export function currentTimestampToIso(value: string): string | null {
  return isCurrentTimestampText(value)
    ? `${value.slice(0, 10)}T${value.slice(11)}.000Z`
    : null
}
