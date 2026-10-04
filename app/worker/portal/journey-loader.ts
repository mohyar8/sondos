/**
 * Journey loader (ADR-001 W3-5, 06-data-model §5.3 `journey_loader`).
 *
 * Reads, for the signed-in customer's own bookings only, every fact
 * `deriveJourneyStage` (shared/journey.ts) needs, in ONE bounded query: the
 * booking row plus LEFT JOINs to the 0005 child tables. Every child join is
 * 1:1 with the booking (primary key or UNIQUE on booking_id; the latest
 * receipt by UNIQUE(booking_id, attempt_no)), so no row multiplies and the
 * LIMIT counts bookings. Ownership is enforced inside the SQL
 * (`b.user_id = ?1`), never by an earlier read.
 *
 * D1 rows are a trust boundary: every column passes a runtime guard before
 * it becomes a typed record. A row that fails is left out and counted.
 */

import { bookingStatuses, type BookingStatus } from '../../shared/admin.js'
import {
  isFlowVersion,
  isJourneyAlbumStage,
  isJourneyGalleryStatus,
  isJourneyHandoverStatus,
  isJourneyReceiptStatus,
  type FlowVersion,
  type JourneyFacts,
  type JourneyGalleryFacts,
  type JourneyHandoverFacts,
} from '../../shared/journey.js'

/** Hard cap on rows per read; GET /api/bookings/me asks for exactly this. */
export const MAXIMUM_JOURNEY_ROWS = 50

export interface CustomerBookingRecord {
  readonly id: string
  readonly eventDate: string
  readonly status: BookingStatus
  /** Stored JSON text; the caller parses and validates it. */
  readonly packageSnapshot: string
  readonly estimatedTotal: number
  readonly holdExpiresAt: string | null
  readonly confirmedAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly flowVersion: FlowVersion
  readonly depositAmount: number | null
  readonly journeyFacts: JourneyFacts
}

export interface CustomerBookingRecords {
  readonly records: readonly CustomerBookingRecord[]
  /** Rows that failed validation and were left out. */
  readonly skippedCount: number
}

type Row = Record<string, unknown>

// ?1 caller uid (from the verified token) | ?2 row cap
const JOURNEY_LOADER_SQL = `
  SELECT
    b.id AS id,
    b.event_date AS eventDate,
    b.status AS status,
    b.package_snapshot AS packageSnapshot,
    b.estimated_total AS estimatedTotal,
    b.hold_expires_at AS holdExpiresAt,
    b.confirmed_at AS confirmedAt,
    b.created_at AS createdAt,
    b.updated_at AS updatedAt,
    b.flow_version AS flowVersion,
    b.deposit_amount AS depositAmount,
    b.completed_at AS completedAt,
    lr.status AS latestReceiptStatus,
    CASE WHEN ep.booking_id IS NULL THEN 0 ELSE 1 END AS hasEventProfile,
    g.status AS galleryStatus,
    g.selection_deadline AS gallerySelectionDeadline,
    g.submitted_at AS gallerySubmittedAt,
    ap.stage AS albumStage,
    h.status AS handoverStatus,
    s.starts_at AS handoverStartsAt,
    h.completed_at AS handoverCompletedAt
  FROM booking_requests AS b
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
  LEFT JOIN handover_slots AS s ON s.id = h.slot_id
  WHERE b.user_id = ?1
  ORDER BY datetime(b.created_at) DESC, b.created_at DESC, b.id DESC
  LIMIT ?2
`

/**
 * Rollout safety only: the same read against a database that does not have
 * migration 0005 yet. No child rows can exist there, and every row is on the
 * default flow 1, so the facts below are exactly what 0005 would report.
 */
const PRE_PORTAL_SCHEMA_SQL = `
  SELECT
    id,
    event_date AS eventDate,
    status,
    package_snapshot AS packageSnapshot,
    estimated_total AS estimatedTotal,
    hold_expires_at AS holdExpiresAt,
    confirmed_at AS confirmedAt,
    created_at AS createdAt,
    updated_at AS updatedAt,
    1 AS flowVersion,
    NULL AS depositAmount,
    NULL AS completedAt,
    NULL AS latestReceiptStatus,
    0 AS hasEventProfile,
    NULL AS galleryStatus,
    NULL AS gallerySelectionDeadline,
    NULL AS gallerySubmittedAt,
    NULL AS albumStage,
    NULL AS handoverStatus,
    NULL AS handoverStartsAt,
    NULL AS handoverCompletedAt
  FROM booking_requests
  WHERE user_id = ?1
  ORDER BY datetime(created_at) DESC, created_at DESC, id DESC
  LIMIT ?2
`

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
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

/** Guards one D1 row; `null` when any column has an unexpected shape. */
function parseRecord(row: Row): CustomerBookingRecord | null {
  const {
    id,
    eventDate,
    status,
    packageSnapshot,
    estimatedTotal,
    holdExpiresAt,
    confirmedAt,
    createdAt,
    updatedAt,
    flowVersion,
    depositAmount,
    completedAt,
    latestReceiptStatus,
    hasEventProfile,
    albumStage,
  } = row

  if (
    !isNonEmptyString(id) ||
    typeof eventDate !== 'string' ||
    !isBookingStatus(status) ||
    typeof packageSnapshot !== 'string' ||
    !isNonNegativeSafeInteger(estimatedTotal) ||
    !isNullableString(holdExpiresAt) ||
    !isNullableString(confirmedAt) ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    !isFlowVersion(flowVersion) ||
    !(depositAmount === null || isNonNegativeSafeInteger(depositAmount)) ||
    !isNullableString(completedAt) ||
    !(latestReceiptStatus === null || isJourneyReceiptStatus(latestReceiptStatus)) ||
    !(hasEventProfile === 0 || hasEventProfile === 1) ||
    !(albumStage === null || isJourneyAlbumStage(albumStage))
  ) {
    return null
  }

  const gallery = readGalleryFacts(row)
  const handover = readHandoverFacts(row)

  if (gallery === undefined || handover === undefined) {
    return null
  }

  return {
    id,
    eventDate,
    status,
    packageSnapshot,
    estimatedTotal,
    holdExpiresAt,
    confirmedAt,
    createdAt,
    updatedAt,
    flowVersion,
    depositAmount,
    journeyFacts: {
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
  }
}

/**
 * D1 reports a missing table or column as an Error whose message contains
 * SQLite's own text ("no such table: …" / "no such column: …").
 */
function isMissingPortalSchemaError(error: unknown): boolean {
  return (
    error instanceof Error && /no such (?:table|column)/i.test(error.message)
  )
}

async function readRows(
  db: D1Database,
  uid: string,
  limit: number,
): Promise<readonly Row[]> {
  try {
    const result = await db
      .prepare(JOURNEY_LOADER_SQL)
      .bind(uid, limit)
      .all<Row>()

    return result.results
  } catch (error) {
    if (!isMissingPortalSchemaError(error)) {
      throw error
    }

    console.error('JOURNEY_SCHEMA_UNAVAILABLE')

    const result = await db
      .prepare(PRE_PORTAL_SCHEMA_SQL)
      .bind(uid, limit)
      .all<Row>()

    return result.results
  }
}

/**
 * Loads the customer's bookings (newest first, at most
 * `MAXIMUM_JOURNEY_ROWS`) together with their journey facts.
 */
export async function loadCustomerBookingRecords(
  db: D1Database,
  uid: string,
  limit: number = MAXIMUM_JOURNEY_ROWS,
): Promise<CustomerBookingRecords> {
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.min(Math.max(limit, 1), MAXIMUM_JOURNEY_ROWS)
    : MAXIMUM_JOURNEY_ROWS
  const rows = await readRows(db, uid, boundedLimit)
  const records: CustomerBookingRecord[] = []
  let skippedCount = 0

  for (const row of rows) {
    const record = parseRecord(row)

    if (record === null) {
      skippedCount += 1
    } else {
      records.push(record)
    }
  }

  if (skippedCount > 0) {
    console.error('MY_BOOKINGS_ROW_INVALID')
  }

  return { records, skippedCount }
}
