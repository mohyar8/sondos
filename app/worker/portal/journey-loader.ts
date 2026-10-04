/**
 * Journey loader (ADR-001 W3-5, 06-data-model §5.3 `journey_loader`).
 *
 * Reads every fact `deriveJourneyStage` (shared/journey.ts) needs, in ONE
 * bounded query: the booking row plus LEFT JOINs to the 0005 child tables.
 * Every child join is 1:1 with the booking (primary key or UNIQUE on
 * booking_id; the latest receipt by UNIQUE(booking_id, attempt_no)), so no
 * row multiplies and the LIMIT counts bookings. The v2 facts (plan 11 §3.3
 * #1: the accepted terms, the notice for the current hold deadline and the
 * stage times) are correlated scalar subqueries on the same row.
 *
 * Two readers share the SELECT and the joins and differ only in the WHERE:
 * - loadCustomerBookingRecords, for the signed-in customer's own bookings.
 *   Ownership is enforced inside the SQL (`b.user_id = ?1`), never by an
 *   earlier read (SB-2).
 * - loadJourneyRecordsByBookingIds, ADMIN-ONLY: bookings of any customer by
 *   id, for the admin readers that already hold a bounded list of ids (the
 *   queue, the calendar, the export). It carries no ownership clause, so it
 *   may be called only after authorizeAdminRequest, from admin modules; a
 *   test keeps it out of every customer route.
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
  type JourneyStageTimes,
} from '../../shared/journey.js'

/** Hard cap on rows per read; GET /api/bookings/me asks for exactly this. */
export const MAXIMUM_JOURNEY_ROWS = 50

/**
 * Most booking ids one admin read may ask for. Also D1's cap on bound
 * parameters per statement (100): the id list is the statement's only
 * parameters, so a longer list could not be bound at all.
 */
export const MAXIMUM_JOURNEY_IDS = 100

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
  /** `booking_requests.terms_accepted_at` (flow 2), as stored. */
  readonly termsAcceptedAt: string | null
  readonly journeyFacts: JourneyFacts
}

export interface CustomerBookingRecords {
  readonly records: readonly CustomerBookingRecord[]
  /** Rows that failed validation and were left out. */
  readonly skippedCount: number
}

/** A booking read by id for the admin: the customer record plus its owner. */
export interface JourneyBookingRecord extends CustomerBookingRecord {
  readonly userId: string
}

export interface JourneyRecordsByBookingId {
  /** Keyed by booking id; an id with no row, or a bad row, is absent. */
  readonly records: ReadonlyMap<string, JourneyBookingRecord>
  /** Rows that failed validation and were left out. */
  readonly skippedCount: number
}

type Row = Record<string, unknown>

/**
 * A `deposit_notice_sent` event for the CURRENT deadline of booking alias
 * `b`: the one definition the hold jobs (worker/jobs/hold-state.ts
 * NOTICE_PROTECTED_SQL), the confirmation API and the queue use (B1,
 * UX-02). Only a text `holdExpiresAt` equal to the stored deadline counts;
 * a notice for an earlier deadline protects nothing.
 */
const CURRENT_NOTICE_CONDITION = `
      notice.booking_id = b.id
      AND notice.event = 'deposit_notice_sent'
      AND json_type(notice.details, '$.holdExpiresAt') = 'text'
      AND json_extract(notice.details, '$.holdExpiresAt') = b.hold_expires_at`

/**
 * The SELECT list and joins both readers share. Constant text only: the
 * readers append their own constant WHERE (SB-4).
 */
const JOURNEY_SELECT_SQL = `
  SELECT
    b.id AS id,
    b.user_id AS userId,
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
    b.terms_accepted_at AS termsAcceptedAt,
    lr.status AS latestReceiptStatus,
    CASE WHEN ep.booking_id IS NULL THEN 0 ELSE 1 END AS hasEventProfile,
    g.status AS galleryStatus,
    g.selection_deadline AS gallerySelectionDeadline,
    g.submitted_at AS gallerySubmittedAt,
    ap.stage AS albumStage,
    h.status AS handoverStatus,
    s.starts_at AS handoverStartsAt,
    h.completed_at AS handoverCompletedAt,
    EXISTS (
      SELECT 1
      FROM booking_events AS notice
      WHERE ${CURRENT_NOTICE_CONDITION}
    ) AS noticeForCurrentDeadline,
    (
      SELECT MAX(notice.created_at)
      FROM booking_events AS notice
      WHERE ${CURRENT_NOTICE_CONDITION}
    ) AS depositNoticeSentAt,
    (
      SELECT sh.created_at
      FROM booking_status_history AS sh
      WHERE sh.booking_id = b.id
        AND sh.to_status = b.status
      ORDER BY sh.id DESC
      LIMIT 1
    ) AS statusChangedAt,
    COALESCE(lr.reviewed_at, lr.created_at) AS latestReceiptAt,
    ep.created_at AS eventProfileCreatedAt,
    g.opened_at AS galleryOpenedAt,
    g.purged_at AS galleryPurgedAt,
    ap.updated_at AS albumStageChangedAt,
    h.updated_at AS handoverChangedAt
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
  LEFT JOIN handover_slots AS s ON s.id = h.slot_id`

// ?1 caller uid (from the verified token) | ?2 row cap
const JOURNEY_LOADER_SQL = `${JOURNEY_SELECT_SQL}
  WHERE b.user_id = ?1
  ORDER BY datetime(b.created_at) DESC, b.created_at DESC, b.id DESC
  LIMIT ?2
`

/**
 * Admin read by id. The WHERE is completed at run time with one `?` per
 * id: a placeholder list built from a count, never from the ids (SB-4).
 */
const JOURNEY_BY_IDS_SQL_PREFIX = `${JOURNEY_SELECT_SQL}
  WHERE b.id IN (`

/**
 * Rollout safety only: the same read against a database that does not have
 * migration 0005 yet. No child rows can exist there, and every row is on the
 * default flow 1, so the facts below are exactly what 0005 would report.
 * The v2 facts are unknown there (NULL), except that no notice can exist.
 */
const PRE_PORTAL_SCHEMA_SQL = `
  SELECT
    id,
    user_id AS userId,
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
    NULL AS termsAcceptedAt,
    NULL AS latestReceiptStatus,
    0 AS hasEventProfile,
    NULL AS galleryStatus,
    NULL AS gallerySelectionDeadline,
    NULL AS gallerySubmittedAt,
    NULL AS albumStage,
    NULL AS handoverStatus,
    NULL AS handoverStartsAt,
    NULL AS handoverCompletedAt,
    0 AS noticeForCurrentDeadline,
    NULL AS depositNoticeSentAt,
    NULL AS statusChangedAt,
    NULL AS latestReceiptAt,
    NULL AS eventProfileCreatedAt,
    NULL AS galleryOpenedAt,
    NULL AS galleryPurgedAt,
    NULL AS albumStageChangedAt,
    NULL AS handoverChangedAt
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

/** A value that can be a stored booking id; only such ids reach the SQL. */
function isBookingIdShape(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
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

/**
 * The stage times (UX-14), each a nullable stored string; whether one is a
 * usable instant is decided by deriveJourneyStage, not here.
 */
function readStageTimes(row: Row): JourneyStageTimes | undefined {
  const {
    statusChangedAt,
    depositNoticeSentAt,
    latestReceiptAt,
    eventProfileCreatedAt,
    galleryOpenedAt,
    galleryPurgedAt,
    albumStageChangedAt,
    handoverChangedAt,
  } = row

  if (
    !isNullableString(statusChangedAt) ||
    !isNullableString(depositNoticeSentAt) ||
    !isNullableString(latestReceiptAt) ||
    !isNullableString(eventProfileCreatedAt) ||
    !isNullableString(galleryOpenedAt) ||
    !isNullableString(galleryPurgedAt) ||
    !isNullableString(albumStageChangedAt) ||
    !isNullableString(handoverChangedAt)
  ) {
    return undefined
  }

  return {
    statusChangedAt,
    depositNoticeSentAt,
    latestReceiptAt,
    eventProfileCreatedAt,
    galleryOpenedAt,
    galleryPurgedAt,
    albumStageChangedAt,
    handoverChangedAt,
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
    termsAcceptedAt,
    latestReceiptStatus,
    hasEventProfile,
    albumStage,
    noticeForCurrentDeadline,
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
    !isNullableString(termsAcceptedAt) ||
    !(latestReceiptStatus === null || isJourneyReceiptStatus(latestReceiptStatus)) ||
    !(hasEventProfile === 0 || hasEventProfile === 1) ||
    !(albumStage === null || isJourneyAlbumStage(albumStage)) ||
    !(noticeForCurrentDeadline === 0 || noticeForCurrentDeadline === 1)
  ) {
    return null
  }

  const gallery = readGalleryFacts(row)
  const handover = readHandoverFacts(row)
  const stageUpdatedAt = readStageTimes(row)

  if (gallery === undefined || handover === undefined || stageUpdatedAt === undefined) {
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
    termsAcceptedAt,
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
      termsAcceptedAt,
      noticeForCurrentDeadline: noticeForCurrentDeadline === 1,
      stageUpdatedAt,
    },
  }
}

/**
 * D1 reports a missing table or column as an Error whose message contains
 * SQLite's own text ("no such table: …" / "no such column: …").
 */
export function isMissingPortalSchemaError(error: unknown): boolean {
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

/**
 * ADMIN-ONLY (see the module comment): the journey records of up to
 * `MAXIMUM_JOURNEY_IDS` bookings of any customer, keyed by id, in one
 * statement. Ids are deduplicated first, and a value that cannot be a
 * booking id is dropped rather than bound; more distinct ids than the bound
 * is a caller error (RangeError), since the callers page at 100 or fewer.
 * An empty list reads nothing.
 */
export async function loadJourneyRecordsByBookingIds(
  env: Pick<Env, 'DB'>,
  ids: readonly string[],
): Promise<JourneyRecordsByBookingId> {
  const distinctIds = [...new Set(ids.filter(isBookingIdShape))]

  if (distinctIds.length > MAXIMUM_JOURNEY_IDS) {
    throw new RangeError('Journey read asked for more ids than the bound')
  }

  const records = new Map<string, JourneyBookingRecord>()

  if (distinctIds.length === 0) {
    return { records, skippedCount: 0 }
  }

  const placeholders = distinctIds.map(() => '?').join(', ')
  const { results } = await env.DB.prepare(
    `${JOURNEY_BY_IDS_SQL_PREFIX}${placeholders})`,
  )
    .bind(...distinctIds)
    .all<Row>()
  let skippedCount = 0

  for (const row of results) {
    const record = parseRecord(row)
    const { userId } = row

    if (record === null || !isNonEmptyString(userId)) {
      skippedCount += 1
    } else {
      records.set(record.id, { ...record, userId })
    }
  }

  if (skippedCount > 0) {
    console.error('JOURNEY_ROW_INVALID')
  }

  return { records, skippedCount }
}
