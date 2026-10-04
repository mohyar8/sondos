/**
 * GET /api/admin/calendar?month=YYYY-MM[&includeClosed=1] (plan 11 §3.2
 * #36, W2-11). Auth AD: the admin portal dispatcher has already run
 * authorizeAdminRequest before any handler here.
 *
 * One month of bookings by event date plus that month's blocked dates, read
 * in one D1 batch. Closed requests (rejected, cancelled, expired) are left
 * out unless includeClosed=1. At most CALENDAR_MAXIMUM_BOOKINGS bookings
 * are returned; `truncated` says when more exist.
 *
 * This module also owns the admin booking-stage read that
 * admin-customers.ts reuses: the same 1:1 LEFT JOINs as
 * journey-loader.ts, so deriveJourneyStage sees exactly the facts the
 * customer's own tracker sees. D1 rows are a trust boundary: every column
 * passes a runtime guard, and a row that fails is left out and counted.
 *
 * SB-4: every value is a bound parameter; the only SQL assembled at run
 * time is the choice between two constant WHERE fragments. SB-7: logs carry
 * fixed codes and counts, never names or dates.
 */

import { bookingStatuses, type BookingStatus } from '../../shared/admin.js'
import {
  deriveJourneyStage,
  isFlowVersion,
  isJourneyAlbumStage,
  isJourneyGalleryStatus,
  isJourneyHandoverStatus,
  isJourneyReceiptStatus,
  type JourneyGalleryFacts,
  type JourneyHandoverFacts,
  type JourneyStageId,
} from '../../shared/journey.js'
import {
  CALENDAR_MAXIMUM_BOOKINGS,
  calendarClosedStatuses,
  parseCalendarMonth,
  type AdminCalendarBlock,
  type AdminCalendarBooking,
  type AdminCalendarDay,
  type AdminCalendarResponse,
  type CalendarMonth,
} from '../../shared/portal/admin-directory.js'
import { isValidDateKey, riyadhDateKey } from '../../shared/timing.js'
import { errorResponse, jsonResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import type { AdminPortalContext } from './admin-portal-routes.js'

type Row = Record<string, unknown>

/** Longest package name taken from a stored snapshot. */
const MAXIMUM_PACKAGE_NAME_LENGTH = 120

// ---------------------------------------------------------------------------
// Shared admin booking-stage read (also used by admin-customers.ts)
// ---------------------------------------------------------------------------

/**
 * Columns for deriveJourneyStage plus the package name, for a query whose
 * booking alias is `b` and which appends ADMIN_BOOKING_STAGE_JOINS. The
 * package name is read only from a schema-1 snapshot (json_valid is a
 * CHECK on the column).
 */
export const ADMIN_BOOKING_STAGE_COLUMNS = `
    b.id AS id,
    b.event_date AS eventDate,
    b.status AS status,
    b.flow_version AS flowVersion,
    b.hold_expires_at AS holdExpiresAt,
    b.completed_at AS completedAt,
    CASE
      WHEN json_extract(b.package_snapshot, '$.schemaVersion') = 1
        THEN json_extract(b.package_snapshot, '$.package.name')
    END AS packageName,
    lr.status AS latestReceiptStatus,
    CASE WHEN ep.booking_id IS NULL THEN 0 ELSE 1 END AS hasEventProfile,
    g.status AS galleryStatus,
    g.selection_deadline AS gallerySelectionDeadline,
    g.submitted_at AS gallerySubmittedAt,
    ap.stage AS albumStage,
    h.status AS handoverStatus,
    s.starts_at AS handoverStartsAt,
    h.completed_at AS handoverCompletedAt`

/**
 * Every join is 1:1 with the booking (primary key or UNIQUE on booking_id;
 * the latest receipt by UNIQUE(booking_id, attempt_no)), so no row
 * multiplies and a LIMIT counts bookings.
 */
export const ADMIN_BOOKING_STAGE_JOINS = `
  LEFT JOIN booking_receipts AS lr
    ON lr.booking_id = b.id
   AND lr.attempt_no = (
     SELECT MAX(r.attempt_no)
     FROM booking_receipts AS r
     WHERE r.booking_id = b.id
   )
  LEFT JOIN event_profiles AS ep ON ep.booking_id = b.id
  LEFT JOIN galleries AS g ON g.booking_id = b.id
  LEFT JOIN album_production AS ap ON ap.booking_id = b.id
  LEFT JOIN handovers AS h ON h.booking_id = b.id
  LEFT JOIN handover_slots AS s ON s.id = h.slot_id`

export interface AdminBookingStageRecord {
  readonly id: string
  readonly eventDate: string
  readonly status: BookingStatus
  readonly stage: JourneyStageId | null
  readonly packageName: string | null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return bookingStatuses.some((status) => status === value)
}

function readGalleryFacts(row: Row): JourneyGalleryFacts | null | undefined {
  const { galleryStatus, gallerySelectionDeadline, gallerySubmittedAt } = row

  if (galleryStatus === null) {
    return null
  }

  if (
    !isJourneyGalleryStatus(galleryStatus) ||
    !isNullableString(gallerySelectionDeadline) ||
    !isNullableString(gallerySubmittedAt)
  ) {
    return undefined
  }

  return {
    status: galleryStatus,
    selectionDeadline: gallerySelectionDeadline,
    submittedAt: gallerySubmittedAt,
  }
}

function readHandoverFacts(row: Row): JourneyHandoverFacts | null | undefined {
  const { handoverStatus, handoverStartsAt, handoverCompletedAt } = row

  if (handoverStatus === null) {
    return null
  }

  if (
    !isJourneyHandoverStatus(handoverStatus) ||
    !isNullableString(handoverStartsAt) ||
    !isNullableString(handoverCompletedAt)
  ) {
    return undefined
  }

  return {
    status: handoverStatus,
    slotStartsAt: handoverStartsAt,
    completedAt: handoverCompletedAt,
  }
}

function readPackageName(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }

  if (typeof value !== 'string') {
    return undefined
  }

  return value.length > 0 && value.length <= MAXIMUM_PACKAGE_NAME_LENGTH
    ? value
    : null
}

/**
 * Guards the ADMIN_BOOKING_STAGE_COLUMNS of one row and derives its stage
 * against `now`; null when any column has an unexpected shape.
 */
export function readAdminBookingStageRow(
  row: Row,
  now: Date,
): AdminBookingStageRecord | null {
  const {
    id,
    eventDate,
    status,
    flowVersion,
    holdExpiresAt,
    completedAt,
    latestReceiptStatus,
    hasEventProfile,
    albumStage,
  } = row
  const packageName = readPackageName(row.packageName)
  const gallery = readGalleryFacts(row)
  const handover = readHandoverFacts(row)

  if (
    !isNonEmptyString(id) ||
    typeof eventDate !== 'string' ||
    !isValidDateKey(eventDate) ||
    !isBookingStatus(status) ||
    !isFlowVersion(flowVersion) ||
    !isNullableString(holdExpiresAt) ||
    !isNullableString(completedAt) ||
    !(latestReceiptStatus === null || isJourneyReceiptStatus(latestReceiptStatus)) ||
    !(hasEventProfile === 0 || hasEventProfile === 1) ||
    !(albumStage === null || isJourneyAlbumStage(albumStage)) ||
    packageName === undefined ||
    gallery === undefined ||
    handover === undefined
  ) {
    return null
  }

  const { stage } = deriveJourneyStage(
    {
      status,
      flowVersion,
      eventDate,
      holdExpiresAt,
      completedAt,
      latestReceiptStatus,
      hasEventProfile: hasEventProfile === 1,
      gallery,
      albumStage,
      handover,
    },
    now,
  )

  return { id, eventDate, status, stage, packageName }
}

// ---------------------------------------------------------------------------
// #36 calendar
// ---------------------------------------------------------------------------

const calendarQueryKeys: ReadonlySet<string> = new Set([
  'month',
  'includeClosed',
])

// The closed statuses come from calendarClosedStatuses as constant text,
// never from the request.
const OPEN_STATUSES_ONLY = `AND b.status NOT IN (${calendarClosedStatuses
  .map((status) => `'${status}'`)
  .join(', ')})`

/** ?1 first date | ?2 last date | ?3 row cap (one more than the answer). */
function calendarBookingsSql(includeClosed: boolean): string {
  return `
  SELECT
    ${ADMIN_BOOKING_STAGE_COLUMNS},
    CASE WHEN u.erased_at IS NULL THEN u.first_name END AS customerFirstName
  FROM booking_requests AS b
  INNER JOIN users AS u ON u.id = b.user_id
  ${ADMIN_BOOKING_STAGE_JOINS}
  WHERE b.event_date >= ?1
    AND b.event_date <= ?2
    ${includeClosed ? '' : OPEN_STATUSES_ONLY}
  ORDER BY b.event_date ASC, b.created_at ASC, b.id ASC
  LIMIT ?3
`
}

/** ?1 first date | ?2 last date. At most 31 rows (event_date is the key). */
const CALENDAR_BLOCKED_DATES_SQL = `
  SELECT event_date AS date, reason
  FROM blocked_dates
  WHERE event_date >= ?1
    AND event_date <= ?2
  ORDER BY event_date ASC
`

type CalendarQuery =
  | { readonly ok: true; readonly month: CalendarMonth; readonly includeClosed: boolean }
  | { readonly ok: false; readonly response: Response }

function invalidMonthResponse(): Response {
  return errorResponse(
    400,
    'INVALID_MONTH',
    'يجب أن يكون الشهر بصيغة YYYY-MM وأن يمثل شهرًا صحيحًا.',
  )
}

function invalidQueryResponse(): Response {
  return errorResponse(
    400,
    'INVALID_QUERY',
    'معاملات الطلب غير صحيحة.',
  )
}

/**
 * Strict: only `month` and `includeClosed`, each at most once. `month` is
 * `YYYY-MM` and defaults to the current Asia/Riyadh month; `includeClosed`
 * is exactly `0` or `1`.
 */
export function parseCalendarQuery(url: URL, now: Date): CalendarQuery {
  const params = url.searchParams

  for (const key of params.keys()) {
    if (!calendarQueryKeys.has(key) || params.getAll(key).length !== 1) {
      return { ok: false, response: invalidQueryResponse() }
    }
  }

  const monthValue = params.get('month') ?? riyadhDateKey(now).slice(0, 7)
  const month = parseCalendarMonth(monthValue)

  if (!month) {
    return { ok: false, response: invalidMonthResponse() }
  }

  const includeClosedValue = params.get('includeClosed')

  if (
    includeClosedValue !== null &&
    includeClosedValue !== '0' &&
    includeClosedValue !== '1'
  ) {
    return { ok: false, response: invalidQueryResponse() }
  }

  return { ok: true, month, includeClosed: includeClosedValue === '1' }
}

function readBlock(row: Row): { date: string; block: AdminCalendarBlock } | null {
  const { date, reason } = row

  if (typeof date !== 'string' || !isValidDateKey(date) || !isNullableString(reason)) {
    return null
  }

  return { date, block: { reason } }
}

function readCalendarBooking(row: Row, now: Date): AdminCalendarBooking & { eventDate: string } | null {
  const record = readAdminBookingStageRow(row, now)
  const { customerFirstName } = row

  if (record === null || !isNullableString(customerFirstName)) {
    return null
  }

  return {
    id: record.id,
    status: record.status,
    stage: record.stage,
    customerFirstName,
    packageName: record.packageName,
    eventDate: record.eventDate,
  }
}

/** Groups the rows into every day of the month. Exported for the tests. */
export function buildCalendarDays(
  month: CalendarMonth,
  bookingRows: readonly Row[],
  blockedRows: readonly Row[],
  now: Date,
): { days: AdminCalendarDay[]; skippedCount: number } {
  const bookingsByDate = new Map<string, AdminCalendarBooking[]>()
  const blocksByDate = new Map<string, AdminCalendarBlock>()
  let skippedCount = 0

  for (const row of blockedRows) {
    const blocked = readBlock(row)

    if (blocked === null) {
      skippedCount += 1
    } else {
      blocksByDate.set(blocked.date, blocked.block)
    }
  }

  for (const row of bookingRows) {
    const booking = readCalendarBooking(row, now)

    if (booking === null) {
      skippedCount += 1
      continue
    }

    const { eventDate, ...entry } = booking
    const dayBookings = bookingsByDate.get(eventDate)

    if (dayBookings) {
      dayBookings.push(entry)
    } else {
      bookingsByDate.set(eventDate, [entry])
    }
  }

  const days = month.dates.map((date) => ({
    date,
    blocked: blocksByDate.get(date) ?? null,
    bookings: bookingsByDate.get(date) ?? [],
  }))

  return { days, skippedCount }
}

export async function handleAdminCalendar(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, url, admin } = context

  // RL_ADMIN_READ (§3.1): slows a scripted scrape with a stolen session.
  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const now = new Date()
  const query = parseCalendarQuery(url, now)

  if (!query.ok) {
    return query.response
  }

  const { month, includeClosed } = query
  const [bookingResult, blockedResult] = await env.DB.batch<Row>([
    env.DB.prepare(calendarBookingsSql(includeClosed)).bind(
      month.firstDate,
      month.lastDate,
      CALENDAR_MAXIMUM_BOOKINGS + 1,
    ),
    env.DB.prepare(CALENDAR_BLOCKED_DATES_SQL).bind(
      month.firstDate,
      month.lastDate,
    ),
  ])
  const bookingRows = bookingResult?.results ?? []
  const blockedRows = blockedResult?.results ?? []
  const truncated = bookingRows.length > CALENDAR_MAXIMUM_BOOKINGS
  const { days, skippedCount } = buildCalendarDays(
    month,
    bookingRows.slice(0, CALENDAR_MAXIMUM_BOOKINGS),
    blockedRows,
    now,
  )

  if (skippedCount > 0) {
    console.error(`ADMIN_CALENDAR_ROW_INVALID count=${skippedCount}`)
  }

  const response: AdminCalendarResponse = {
    ok: true,
    month: month.month,
    includeClosed,
    days,
    truncated,
  }

  return jsonResponse(response)
}
