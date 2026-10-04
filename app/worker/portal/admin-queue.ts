/**
 * GET /api/admin/queue (plan 11 §3.2 #35, W2-10; B1, UX-02, UX-03, UX-05,
 * UX-06, TM-03, GAP-04). Auth AD: the admin portal dispatcher has already
 * run authorizeAdminRequest before the handler here; the route takes no
 * parameters and refuses any query string.
 *
 * The queue is read as one D1 batch (every section from the same database
 * state) plus the settings snapshot the alerts and the feature flags need.
 * Each section is one statement over booking alias `b`, the same 1:1 joins
 * as the admin calendar (admin-calendar.ts), so deriveJourneyStage sees the
 * facts the customer's own tracker sees. The hold predicates are the ones
 * the cron and the approve sweep use (jobs/hold-state.ts), so the queue and
 * the jobs can never disagree about a hold (B1). The bank rule is
 * settings-read.ts effectiveRevisionIdSql, the one definition of "effective".
 *
 * UX-06 in SQL: a booking stays in a section until a `sent` or `dismissed`
 * contact-log row for the section's template is newer than the booking's
 * last change (its status history, its non-contact events, its own
 * updated_at and those of its event profile, gallery, album production,
 * handover and latest receipt). Anything that changes afterwards brings the
 * item back; an `opened` row never removes it.
 *
 * D1 rows are a trust boundary: every column passes a runtime guard, a row
 * that fails is left out and counted, and `waDigits` is re-derived from the
 * stored phone through the settings normaliser and the #35 pattern, never
 * echoed as stored. SB-4: every value is a bound parameter; the SQL text is
 * assembled only from constant fragments. SB-7: logs carry fixed codes and
 * counts, never a name, number or date. SB-13: only what the shared
 * contract's minimisation note lists leaves this module.
 */

import {
  isAdminQueueWaDigits,
  ADMIN_QUEUE_CRON_STALE_MINUTES,
  ADMIN_QUEUE_EVENT_SOON_DAYS,
  ADMIN_QUEUE_FEEDBACK_DUE_DAYS,
  ADMIN_QUEUE_HOLD_EXPIRING_HOURS,
  ADMIN_QUEUE_OUTBOX_FAILED_DAYS,
  ADMIN_QUEUE_OUTBOX_SKIPPED_HOURS,
  ADMIN_QUEUE_RECEIPT_REVIEW_HOURS,
  ADMIN_QUEUE_REPEAT_HOLD_DAYS,
  ADMIN_QUEUE_REPEAT_HOLD_FLAG_COUNT,
  ADMIN_QUEUE_REQUEST_SLA_HOURS,
  ADMIN_QUEUE_SECTION_IDS,
  ADMIN_QUEUE_SECTION_MAX_ITEMS,
  ADMIN_QUEUE_TERMS_PENDING_HOURS,
  adminQueuePrivateMediaSections,
  adminQueueSectionOrder,
  adminQueueSectionTemplates,
  type AdminQueueAlert,
  type AdminQueueHealth,
  type AdminQueueItem,
  type AdminQueueLastContact,
  type AdminQueueResponse,
  type AdminQueueSection,
  type AdminQueueSectionId,
  type AdminQueueTemplateId,
} from '../../shared/portal/admin-queue.js'
import { normalizeWhatsappNumber } from '../../shared/settings.js'
import {
  TIMING,
  addDaysToDateKey,
  addMsToInstant,
  isValidLocalTime,
  riyadhDateKey,
  riyadhLocalToInstant,
  riyadhStartOfDay,
} from '../../shared/timing.js'
import { errorResponse, jsonResponse } from '../http.js'
import {
  NOTICE_PROTECTED_SQL,
  OWED_HOLD_PREDICATE_SQL,
  isCanonicalInstant,
} from '../jobs/hold-state.js'
import { CRON_SCHEDULES } from '../jobs/job-types.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import {
  isEmailConfigured,
  onlineConfirmationUnavailableReason,
  resolveFeatures,
} from '../settings/features.js'
import {
  effectiveRevisionIdSql,
  readSettingsSnapshot,
  type SettingsSnapshot,
} from '../settings/settings-read.js'
import {
  ADMIN_BOOKING_STAGE_COLUMNS,
  ADMIN_BOOKING_STAGE_JOINS,
  readAdminBookingStageRow,
} from './admin-calendar.js'
import type { AdminPortalContext } from './admin-portal-routes.js'
import { isPrivateMediaAllowed } from './gates.js'

type Row = Record<string, unknown>

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** The hold window, in hours, for a hold with no approval row in its history. */
const HOLD_WINDOW_HOURS = TIMING.holdWindowMs / HOUR_MS

/** The heartbeat row `health.cronLastOkAt` reads (jobs/job-types.ts). */
const CRON_HEARTBEAT_JOB = CRON_SCHEDULES['quarter-hourly'].heartbeatJob

/** Longest venue area taken from a stored event profile (0005 CHECK). */
const MAXIMUM_VENUE_AREA_LENGTH = 120

/** The contact-log kinds (admin-booking-log.ts) and the outcome each records. */
const contactOutcomeByEvent: ReadonlyMap<string, AdminQueueLastContact['outcome']> =
  new Map([
    ['admin_whatsapp_opened', 'opened'],
    ['admin_whatsapp_sent', 'sent'],
    ['admin_queue_dismissed', 'dismissed'],
  ])

// ---------------------------------------------------------------------------
// SQL: constant fragments only; every value is bound (SB-4)
// ---------------------------------------------------------------------------

const CONTACT_LOG_KINDS = `('admin_whatsapp_opened', 'admin_whatsapp_sent', 'admin_queue_dismissed')`

/**
 * The instant the booking last changed, as datetime() text: the newest of
 * its own updated_at, its status history, its non-contact events and the
 * updated_at of each joined journey row. COALESCE keeps SQLite's multi-arg
 * max from answering NULL when one source is empty.
 */
const LAST_CHANGE_SQL = `MAX(
      COALESCE(datetime(b.updated_at), ''),
      COALESCE((
        SELECT MAX(datetime(sh.created_at))
        FROM booking_status_history AS sh
        WHERE sh.booking_id = b.id
      ), ''),
      COALESCE((
        SELECT MAX(datetime(ev.created_at))
        FROM booking_events AS ev
        WHERE ev.booking_id = b.id
          AND ev.event NOT IN ${CONTACT_LOG_KINDS}
      ), ''),
      COALESCE(datetime(ep.updated_at), ''),
      COALESCE(datetime(g.updated_at), ''),
      COALESCE(datetime(ap.updated_at), ''),
      COALESCE(datetime(h.updated_at), ''),
      COALESCE(datetime(lr.updated_at), '')
    )`

/**
 * UX-06: no `sent` or `dismissed` contact-log row for the section's
 * template (?1) since the booking last changed.
 */
const UNRESOLVED_FOR_TEMPLATE_SQL = `NOT EXISTS (
      SELECT 1
      FROM booking_events AS done
      WHERE done.booking_id = b.id
        AND done.event IN ('admin_whatsapp_sent', 'admin_queue_dismissed')
        AND json_extract(done.details, '$.template') = ?1
        AND datetime(done.created_at) >= ${LAST_CHANGE_SQL}
    )`

/** The latest contact-log row for the section's template (?1), as two columns. */
const LAST_CONTACT_EVENT_SQL = `(
      SELECT lc.event
      FROM booking_events AS lc
      WHERE lc.booking_id = b.id
        AND lc.event IN ${CONTACT_LOG_KINDS}
        AND json_extract(lc.details, '$.template') = ?1
      ORDER BY lc.id DESC
      LIMIT 1
    )`

const LAST_CONTACT_AT_SQL = `(
      SELECT lc.created_at
      FROM booking_events AS lc
      WHERE lc.booking_id = b.id
        AND lc.event IN ${CONTACT_LOG_KINDS}
        AND json_extract(lc.details, '$.template') = ?1
      ORDER BY lc.id DESC
      LIMIT 1
    )`

/**
 * GAP-04, over every booking of the customer since ?4: holds that expired,
 * and holds cancelled while she still owed the deposit.
 */
const REPEAT_EXPIRED_SQL = `(
      SELECT COUNT(*)
      FROM booking_requests AS rb
      INNER JOIN booking_status_history AS rh ON rh.booking_id = rb.id
      WHERE rb.user_id = b.user_id
        AND rh.to_status = 'expired'
        AND datetime(rh.created_at) >= datetime(?4)
    )`

const REPEAT_ABANDONED_SQL = `(
      SELECT COUNT(*)
      FROM booking_requests AS rb
      INNER JOIN booking_status_history AS rh ON rh.booking_id = rb.id
      WHERE rb.user_id = b.user_id
        AND rh.from_status IN ('approved_hold', 'payment_pending')
        AND rh.to_status = 'cancelled'
        AND datetime(rh.created_at) >= datetime(?4)
    )`

/**
 * The columns of one item. ?1 template | ?4 repeat-hold cutoff. The
 * customer's name and phone are read only while her data is not erased;
 * the phone is never selected as anything but the source of `waDigits`.
 */
const ITEM_COLUMNS = `
    ${ADMIN_BOOKING_STAGE_COLUMNS},
    b.created_at AS createdAt,
    b.deposit_amount AS depositAmount,
    b.deposit_received_amount AS depositReceivedAmount,
    CASE WHEN u.erased_at IS NULL THEN u.first_name END AS customerFirstName,
    CASE WHEN u.erased_at IS NULL THEN u.phone END AS customerPhone,
    h.method AS handoverMethod,
    ep.event_start_time AS eventStartTime,
    ep.venue_area AS venueArea,
    lr.created_at AS latestReceiptCreatedAt,
    ${LAST_CONTACT_EVENT_SQL} AS lastContactEvent,
    ${LAST_CONTACT_AT_SQL} AS lastContactAt,
    ${REPEAT_EXPIRED_SQL} AS repeatExpired,
    ${REPEAT_ABANDONED_SQL} AS repeatAbandoned,
    COUNT(*) OVER () AS sectionTotal`

/**
 * One section's statement: ?1 template | ?2 now | ?3 row cap | ?4
 * repeat-hold cutoff | ?5, ?6 the section's own bounds. `sectionTotal` is
 * counted before the LIMIT, so `total` is the true number of matches.
 */
function sectionSql(condition: string, orderBy: string): string {
  return `
  SELECT ${ITEM_COLUMNS}
  FROM booking_requests AS b
  INNER JOIN users AS u ON u.id = b.user_id
  ${ADMIN_BOOKING_STAGE_JOINS}
  WHERE (${condition})
    AND ${UNRESOLVED_FOR_TEMPLATE_SQL}
  ORDER BY ${orderBy}, b.id ASC
  LIMIT ?3`
}

/** The approval instant: the latest move into approved_hold, else the hold window back from the deadline. */
const APPROVED_AT_SQL = `COALESCE(
      (
        SELECT MAX(datetime(sh.created_at))
        FROM booking_status_history AS sh
        WHERE sh.booking_id = b.id
          AND sh.to_status = 'approved_hold'
      ),
      datetime(b.hold_expires_at, '-${HOLD_WINDOW_HOURS} hours')
    )`

/** Sections that need private media (their statements are skipped while it is closed). */
const privateMediaSections: ReadonlySet<AdminQueueSectionId> = new Set(
  adminQueuePrivateMediaSections,
)

/** How `dueAt` is read from a row of the section. */
type DueRule =
  | 'hold-deadline'
  | 'request-sla'
  | 'event-start'
  | 'handover-slot'
  | 'receipt-sla'
  | 'selection-deadline'
  | 'feedback-due'
  | 'none'

interface SectionSpec {
  readonly id: AdminQueueSectionId
  readonly sql: string
  readonly due: DueRule
  /** Whether items carry `startTime` and `venueArea` (events_today_tomorrow only). */
  readonly eventDetails: boolean
}

/** The bounds one request binds, computed once from `now`. */
interface QueueClock {
  readonly now: Date
  readonly nowIso: string
  readonly today: string
  readonly tomorrow: string
  readonly soonKey: string
  readonly yesterday: string
  readonly startOfToday: string
  readonly startOfTomorrow: string
  readonly startOfDayAfterTomorrow: string
  readonly holdExpiringUntil: string
  readonly requestSlaCutoff: string
  readonly termsPendingCutoff: string
  readonly feedbackDueCutoff: string
  readonly repeatHoldCutoff: string
  readonly outboxFailedCutoff: string
  readonly outboxSkippedCutoff: string
  readonly cronStaleCutoff: string
}

/** ?5, ?6 of each section, from the clock and the AX flag. */
type SectionBounds = (clock: QueueClock, holdAutoExpiry: boolean) => readonly (string | number)[]

const sectionSpecById: Readonly<
  Record<AdminQueueSectionId, SectionSpec & { readonly bounds: SectionBounds }>
> = {
  decide_now: {
    id: 'decide_now',
    // ?5 AX: an unprotected overdue hold waits for the admin only while
    // automatic expiry is off (B1 #4); a protected one always does.
    sql: sectionSql(
      `${OWED_HOLD_PREDICATE_SQL}
        AND b.hold_expires_at <= ?2
        AND (${NOTICE_PROTECTED_SQL} OR ?5 = 0)`,
      'b.hold_expires_at ASC',
    ),
    due: 'hold-deadline',
    eventDetails: false,
    bounds: (_clock, holdAutoExpiry) => [holdAutoExpiry ? 1 : 0],
  },
  holds_expiring: {
    id: 'holds_expiring',
    sql: sectionSql(
      `${OWED_HOLD_PREDICATE_SQL}
        AND NOT ${NOTICE_PROTECTED_SQL}
        AND b.hold_expires_at > ?2
        AND b.hold_expires_at <= ?5`,
      'b.hold_expires_at ASC',
    ),
    due: 'hold-deadline',
    eventDetails: false,
    bounds: (clock) => [clock.holdExpiringUntil],
  },
  deposit_notices: {
    id: 'deposit_notices',
    sql: sectionSql(
      `${OWED_HOLD_PREDICATE_SQL}
        AND ${NOTICE_PROTECTED_SQL}
        AND b.hold_expires_at > ?2`,
      'b.hold_expires_at ASC',
    ),
    due: 'hold-deadline',
    eventDetails: false,
    bounds: () => [],
  },
  requests_over_sla: {
    id: 'requests_over_sla',
    sql: sectionSql(
      `b.status = 'pending_review'
        AND datetime(b.created_at) <= datetime(?5)`,
      'datetime(b.created_at) ASC',
    ),
    due: 'request-sla',
    eventDetails: false,
    bounds: (clock) => [clock.requestSlaCutoff],
  },
  events_today_tomorrow: {
    id: 'events_today_tomorrow',
    sql: sectionSql(
      `b.status = 'confirmed'
        AND b.completed_at IS NULL
        AND b.event_date IN (?5, ?6)`,
      'b.event_date ASC, ep.event_start_time ASC',
    ),
    due: 'event-start',
    eventDetails: true,
    bounds: (clock) => [clock.today, clock.tomorrow],
  },
  handovers_today_tomorrow: {
    id: 'handovers_today_tomorrow',
    sql: sectionSql(
      `h.status = 'scheduled'
        AND s.starts_at >= ?5
        AND s.starts_at < ?6`,
      's.starts_at ASC',
    ),
    due: 'handover-slot',
    eventDetails: false,
    bounds: (clock) => [clock.startOfToday, clock.startOfDayAfterTomorrow],
  },
  terms_pending: {
    id: 'terms_pending',
    sql: sectionSql(
      `b.status = 'approved_hold'
        AND b.flow_version = 2
        AND b.terms_accepted_at IS NULL
        AND b.hold_expires_at > ?2
        AND ${APPROVED_AT_SQL} <= datetime(?5)`,
      'b.hold_expires_at ASC',
    ),
    due: 'hold-deadline',
    eventDetails: false,
    bounds: (clock) => [clock.termsPendingCutoff],
  },
  bank_mismatch: {
    id: 'bank_mismatch',
    // IS NOT: a booking whose accepted revision differs from the effective
    // one, including when no bank revision is effective any more.
    sql: sectionSql(
      `b.flow_version = 2
        AND b.status IN ('approved_hold', 'payment_pending')
        AND b.bank_revision_id IS NOT NULL
        AND b.bank_revision_id IS NOT ${effectiveRevisionIdSql('bank', '?2')}`,
      'b.hold_expires_at ASC',
    ),
    due: 'hold-deadline',
    eventDetails: false,
    bounds: () => [],
  },
  receipts_pending: {
    id: 'receipts_pending',
    sql: sectionSql(
      `b.status = 'payment_pending'
        AND lr.status = 'pending'`,
      'lr.created_at ASC',
    ),
    due: 'receipt-sla',
    eventDetails: false,
    bounds: () => [],
  },
  events_soon_without_details: {
    id: 'events_soon_without_details',
    sql: sectionSql(
      `b.status = 'confirmed'
        AND ep.booking_id IS NULL
        AND b.event_date >= ?5
        AND b.event_date <= ?6`,
      'b.event_date ASC',
    ),
    due: 'event-start',
    eventDetails: false,
    bounds: (clock) => [clock.today, clock.soonKey],
  },
  awaiting_production: {
    id: 'awaiting_production',
    sql: sectionSql(
      `b.status = 'confirmed'
        AND b.completed_at IS NULL
        AND b.event_date < ?5
        AND ap.booking_id IS NULL
        AND (g.booking_id IS NULL OR g.status <> 'open')`,
      'b.event_date ASC',
    ),
    due: 'none',
    eventDetails: false,
    bounds: (clock) => [clock.today],
  },
  selection_overdue: {
    id: 'selection_overdue',
    sql: sectionSql(
      `b.status = 'confirmed'
        AND g.status = 'open'
        AND g.selection_deadline < ?2`,
      'g.selection_deadline ASC',
    ),
    due: 'selection-deadline',
    eventDetails: false,
    bounds: () => [],
  },
  ready_without_handover: {
    id: 'ready_without_handover',
    sql: sectionSql(
      `b.status = 'confirmed'
        AND b.completed_at IS NULL
        AND ap.stage = 'ready'
        AND (h.booking_id IS NULL OR h.status = 'cancelled')`,
      'ap.updated_at ASC',
    ),
    due: 'none',
    eventDetails: false,
    bounds: () => [],
  },
  handover_no_show: {
    id: 'handover_no_show',
    sql: sectionSql(
      `b.status = 'confirmed'
        AND b.completed_at IS NULL
        AND h.status = 'no_show'`,
      'h.updated_at ASC',
    ),
    due: 'none',
    eventDetails: false,
    bounds: () => [],
  },
  feedback_due: {
    id: 'feedback_due',
    sql: sectionSql(
      `b.completed_at IS NOT NULL
        AND b.completed_at <= ?5
        AND NOT EXISTS (
          SELECT 1 FROM feedback AS f WHERE f.booking_id = b.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM notification_log AS n
          WHERE n.booking_id = b.id
            AND n.kind = 'feedback_request'
            AND n.status IN ('pending', 'sending', 'sent')
        )`,
      'b.completed_at ASC',
    ),
    due: 'feedback-due',
    eventDetails: false,
    bounds: (clock) => [clock.feedbackDueCutoff],
  },
}

/** The specs in the fixed order (UX-05): the shared list decides, never this file. */
const sectionSpecs: readonly (SectionSpec & { readonly bounds: SectionBounds })[] =
  ADMIN_QUEUE_SECTION_IDS.map((id) => sectionSpecById[id])

/** ?1 today's date key. */
const EVENTS_TODAY_SQL = `
  SELECT COUNT(*) AS total
  FROM booking_requests
  WHERE status = 'confirmed'
    AND event_date = ?1`

/** ?1 start of today | ?2 start of tomorrow (instants). */
const HANDOVERS_TODAY_SQL = `
  SELECT COUNT(*) AS total
  FROM handovers AS h
  INNER JOIN handover_slots AS s ON s.id = h.slot_id
  WHERE h.status = 'scheduled'
    AND s.starts_at >= ?1
    AND s.starts_at < ?2`

/** ?1 heartbeat job name. */
const CRON_HEARTBEAT_SQL = `
  SELECT last_ok_at AS lastOkAt
  FROM job_runs
  WHERE job = ?1`

/** ?1 failed cutoff (the earlier one) | ?2 skipped cutoff. Terminal rows only. */
const OUTBOX_HEALTH_SQL = `
  SELECT
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status = 'skipped' AND finished_at >= ?2 THEN 1 ELSE 0 END) AS skipped
  FROM notification_log
  WHERE status IN ('failed', 'skipped')
    AND finished_at >= ?1`

/** ?1 today | ?2 yesterday (Riyadh day keys, as csp-report.ts writes them). */
const CSP_VIOLATIONS_SQL = `
  SELECT COALESCE(SUM(count), 0) AS total
  FROM csp_report_counts
  WHERE day IN (?1, ?2)`

/** Every statement this module prepares (tests prepare each one), sections by id. */
export const ADMIN_QUEUE_SQL = Object.freeze({
  sections: Object.freeze(
    Object.fromEntries(sectionSpecs.map((spec) => [spec.id, spec.sql])),
  ),
  eventsToday: EVENTS_TODAY_SQL,
  handoversToday: HANDOVERS_TODAY_SQL,
  cronHeartbeat: CRON_HEARTBEAT_SQL,
  outboxHealth: OUTBOX_HEALTH_SQL,
  cspViolations: CSP_VIOLATIONS_SQL,
})

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

function requireDateKey(value: string | null, code: string): string {
  if (value === null) {
    // Unreachable for a valid clock: every key derives from riyadhDateKey.
    throw new Error(code)
  }

  return value
}

function buildClock(now: Date): QueueClock {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('Invalid queue instant')
  }

  const today = riyadhDateKey(now)
  const tomorrow = requireDateKey(addDaysToDateKey(today, 1), 'QUEUE_DATE_KEY')
  const dayAfterTomorrow = requireDateKey(addDaysToDateKey(today, 2), 'QUEUE_DATE_KEY')

  return {
    now,
    nowIso: now.toISOString(),
    today,
    tomorrow,
    soonKey: requireDateKey(
      addDaysToDateKey(today, ADMIN_QUEUE_EVENT_SOON_DAYS),
      'QUEUE_DATE_KEY',
    ),
    yesterday: requireDateKey(addDaysToDateKey(today, -1), 'QUEUE_DATE_KEY'),
    startOfToday: requireDateKey(riyadhStartOfDay(today), 'QUEUE_START_OF_DAY'),
    startOfTomorrow: requireDateKey(riyadhStartOfDay(tomorrow), 'QUEUE_START_OF_DAY'),
    startOfDayAfterTomorrow: requireDateKey(
      riyadhStartOfDay(dayAfterTomorrow),
      'QUEUE_START_OF_DAY',
    ),
    holdExpiringUntil: addMsToInstant(now, ADMIN_QUEUE_HOLD_EXPIRING_HOURS * HOUR_MS),
    requestSlaCutoff: addMsToInstant(now, -ADMIN_QUEUE_REQUEST_SLA_HOURS * HOUR_MS),
    termsPendingCutoff: addMsToInstant(now, -ADMIN_QUEUE_TERMS_PENDING_HOURS * HOUR_MS),
    feedbackDueCutoff: addMsToInstant(now, -ADMIN_QUEUE_FEEDBACK_DUE_DAYS * DAY_MS),
    repeatHoldCutoff: addMsToInstant(now, -ADMIN_QUEUE_REPEAT_HOLD_DAYS * DAY_MS),
    outboxFailedCutoff: addMsToInstant(now, -ADMIN_QUEUE_OUTBOX_FAILED_DAYS * DAY_MS),
    outboxSkippedCutoff: addMsToInstant(now, -ADMIN_QUEUE_OUTBOX_SKIPPED_HOURS * HOUR_MS),
    cronStaleCutoff: addMsToInstant(now, -ADMIN_QUEUE_CRON_STALE_MINUTES * MINUTE_MS),
  }
}

// ---------------------------------------------------------------------------
// Row guards
// ---------------------------------------------------------------------------

/** SQLite's CURRENT_TIMESTAMP text, as legacy booking rows may hold it. */
const SQLITE_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** A stored instant in canonical form; a legacy `YYYY-MM-DD HH:MM:SS` (UTC) is converted. */
function readStoredInstant(value: unknown): string | null {
  if (isCanonicalInstant(value)) {
    return value
  }

  if (typeof value !== 'string') {
    return null
  }

  const legacy = SQLITE_TIMESTAMP_PATTERN.exec(value)
  const candidate = legacy ? `${legacy[1]}T${legacy[2]}.000Z` : null

  return isCanonicalInstant(candidate) ? candidate : null
}

function readNullableCanonicalInstant(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }

  return isCanonicalInstant(value) ? value : undefined
}

function readNullableCount(value: unknown): number | null | undefined {
  if (value === null) {
    return null
  }

  return isCount(value) ? value : undefined
}

/**
 * `waDigits` from the stored phone: the settings normaliser (the same rules
 * as the SPA's wa.me builder) and then the #35 pattern. A phone that does
 * not normalise, or an erased customer, gives null: the SPA then shows the
 * disabled button, never a link to the wrong chat.
 */
function toWaDigits(phone: unknown): string | null {
  if (phone === null || phone === undefined) {
    return null
  }

  const digits = normalizeWhatsappNumber(phone)

  return digits !== null && isAdminQueueWaDigits(digits) ? digits : null
}

function readLastContact(
  row: Row,
  template: AdminQueueTemplateId,
): AdminQueueLastContact | null | undefined {
  const { lastContactEvent, lastContactAt } = row

  if (lastContactEvent === null && lastContactAt === null) {
    return null
  }

  const outcome =
    typeof lastContactEvent === 'string'
      ? contactOutcomeByEvent.get(lastContactEvent)
      : undefined

  if (outcome === undefined || !isCanonicalInstant(lastContactAt)) {
    return undefined
  }

  return { template, outcome, at: lastContactAt }
}

/** `dueAt` for one row under the section's rule; undefined when a needed column is malformed. */
function readDueAt(rule: DueRule, row: Row, eventDate: string): string | null | undefined {
  switch (rule) {
    case 'hold-deadline':
      return readNullableCanonicalInstant(row.holdExpiresAt)
    case 'request-sla': {
      const createdAt = readStoredInstant(row.createdAt)

      return createdAt === null
        ? undefined
        : addMsToInstant(new Date(createdAt), ADMIN_QUEUE_REQUEST_SLA_HOURS * HOUR_MS)
    }
    case 'event-start': {
      const startTime = row.eventStartTime

      if (typeof startTime === 'string' && isValidLocalTime(startTime)) {
        return riyadhLocalToInstant(eventDate, startTime) ?? riyadhStartOfDay(eventDate)
      }

      return riyadhStartOfDay(eventDate)
    }
    case 'handover-slot':
      return readNullableCanonicalInstant(row.handoverStartsAt)
    case 'receipt-sla': {
      const uploadedAt = readNullableCanonicalInstant(row.latestReceiptCreatedAt)

      return uploadedAt === null || uploadedAt === undefined
        ? uploadedAt
        : addMsToInstant(new Date(uploadedAt), ADMIN_QUEUE_RECEIPT_REVIEW_HOURS * HOUR_MS)
    }
    case 'selection-deadline':
      return readNullableCanonicalInstant(row.gallerySelectionDeadline)
    case 'feedback-due': {
      const completedAt = readNullableCanonicalInstant(row.completedAt)

      return completedAt === null || completedAt === undefined
        ? completedAt
        : addMsToInstant(new Date(completedAt), ADMIN_QUEUE_FEEDBACK_DUE_DAYS * DAY_MS)
    }
    case 'none':
      return null
  }
}

/**
 * Guards one row of a section and builds its item; null when any column
 * has an unexpected shape (the row is then counted, never half-shown).
 */
export function readAdminQueueItem(
  spec: SectionSpec,
  row: Row,
  now: Date,
): AdminQueueItem | null {
  const record = readAdminBookingStageRow(row, now)

  if (record === null) {
    return null
  }

  const template = adminQueueSectionTemplates[spec.id]
  const holdExpiresAt = readNullableCanonicalInstant(row.holdExpiresAt)
  const slotStartsAt = readNullableCanonicalInstant(row.handoverStartsAt)
  const depositAmount = readNullableCount(row.depositAmount)
  const depositReceivedAmount = readNullableCount(row.depositReceivedAmount)
  const repeatExpired = row.repeatExpired
  const repeatAbandoned = row.repeatAbandoned
  const lastContact = readLastContact(row, template)
  const dueAt = readDueAt(spec.due, row, record.eventDate)
  const { customerFirstName, handoverMethod, eventStartTime, venueArea, albumStage } = row

  if (
    holdExpiresAt === undefined ||
    slotStartsAt === undefined ||
    depositAmount === undefined ||
    depositReceivedAmount === undefined ||
    !isCount(repeatExpired) ||
    !isCount(repeatAbandoned) ||
    lastContact === undefined ||
    dueAt === undefined ||
    !isNullableString(customerFirstName) ||
    !(handoverMethod === null || handoverMethod === 'pickup' || handoverMethod === 'delivery') ||
    !(eventStartTime === null || (typeof eventStartTime === 'string' && isValidLocalTime(eventStartTime))) ||
    !(venueArea === null || (typeof venueArea === 'string' && venueArea.length <= MAXIMUM_VENUE_AREA_LENGTH))
  ) {
    return null
  }

  return {
    bookingId: record.id,
    reference: record.id,
    eventDate: record.eventDate,
    customerFirstName: customerFirstName === '' ? null : customerFirstName,
    status: record.status,
    stage: record.stage,
    dueAt,
    suggestedTemplate: template,
    waDigits: toWaDigits(row.customerPhone),
    templateInputs: {
      amount: depositReceivedAmount ?? depositAmount,
      holdExpiresAt,
      slotStartsAt,
      method: handoverMethod,
      productionStage:
        albumStage === 'design' || albumStage === 'printing' ? albumStage : null,
    },
    // SB-13: her event details leave only with the section that needs them.
    startTime: spec.eventDetails ? eventStartTime : null,
    venueArea: spec.eventDetails ? venueArea : null,
    lastContact,
    repeatHolds: {
      expired: repeatExpired,
      abandoned: repeatAbandoned,
      flagged: repeatExpired + repeatAbandoned >= ADMIN_QUEUE_REPEAT_HOLD_FLAG_COUNT,
    },
  }
}

function readTotal(rows: readonly Row[]): number {
  const first = rows.at(0)

  return first !== undefined && isCount(first.sectionTotal) ? first.sectionTotal : rows.length
}

function readCountRow(rows: readonly Row[], column: string): number {
  const value = rows.at(0)?.[column]

  return isCount(value) ? value : 0
}

// ---------------------------------------------------------------------------
// Alerts and health
// ---------------------------------------------------------------------------

function isBefore(instant: string, cutoff: string): boolean {
  return Date.parse(instant) < Date.parse(cutoff)
}

/**
 * The standing alerts in ADMIN_QUEUE_ALERT_CODES order, from the settings
 * snapshot (TM-03, H3) and the health just read.
 */
function buildAlerts(
  snapshot: SettingsSnapshot,
  offeredReason: string | null,
  health: AdminQueueHealth,
): AdminQueueAlert[] {
  const alerts: AdminQueueAlert[] = []
  const recentBankChange = snapshot.recentSensitiveChanges.find(
    (change) => change.section === 'bank',
  )

  if (recentBankChange !== undefined) {
    alerts.push({
      code: 'BANK_DETAILS_CHANGED_RECENTLY',
      at: recentBankChange.at,
      detail: null,
    })
  }

  // One alert for the change that takes effect first; `detail` names its section.
  const pendingActivations = (['bank', 'contact'] as const)
    .flatMap((section) => {
      const revision = snapshot.pending[section]

      return revision === null ? [] : [{ section, at: revision.activeFrom }]
    })
    .sort((left, right) => left.at.localeCompare(right.at))
  const firstPending = pendingActivations.at(0)

  if (firstPending !== undefined) {
    alerts.push({
      code: 'SETTINGS_CHANGE_PENDING',
      at: firstPending.at,
      detail: firstPending.section,
    })
  }

  if (offeredReason !== null) {
    alerts.push({
      code: 'ONLINE_CONFIRMATION_NOT_OFFERED',
      at: null,
      detail: offeredReason,
    })
  }

  if (snapshot.killSwitch.state === 'off') {
    alerts.push({
      code: 'KILL_SWITCH_OFF',
      at: snapshot.killSwitch.changedAt,
      detail: null,
    })
  }

  if (health.cronStale) {
    alerts.push({ code: 'CRON_STALE', at: health.cronLastOkAt, detail: null })
  }

  if (health.cspViolations24h > 0) {
    alerts.push({ code: 'CSP_VIOLATIONS', at: null, detail: null })
  }

  return alerts
}

// ---------------------------------------------------------------------------
// Loader and handler
// ---------------------------------------------------------------------------

/**
 * The whole #35 answer at `now`, from one D1 batch plus the settings
 * snapshot. Exported so the tests can fix the clock; the handler passes
 * the Worker's.
 */
export async function loadAdminQueue(env: Env, now: Date): Promise<AdminQueueResponse> {
  const db = env.DB
  const clock = buildClock(now)
  const snapshot = await readSettingsSnapshot(db, now)
  const features = resolveFeatures(env, snapshot)
  const privateMediaOpen = isPrivateMediaAllowed(env)
  const activeSpecs = sectionSpecs.filter(
    (spec) => privateMediaOpen || !privateMediaSections.has(spec.id),
  )
  const results = await db.batch<Row>([
    ...activeSpecs.map((spec) =>
      db
        .prepare(spec.sql)
        .bind(
          adminQueueSectionTemplates[spec.id],
          clock.nowIso,
          ADMIN_QUEUE_SECTION_MAX_ITEMS,
          clock.repeatHoldCutoff,
          ...spec.bounds(clock, features.holdAutoExpiry),
        ),
    ),
    db.prepare(EVENTS_TODAY_SQL).bind(clock.today),
    db.prepare(HANDOVERS_TODAY_SQL).bind(clock.startOfToday, clock.startOfTomorrow),
    db.prepare(CRON_HEARTBEAT_SQL).bind(CRON_HEARTBEAT_JOB),
    db.prepare(OUTBOX_HEALTH_SQL).bind(clock.outboxFailedCutoff, clock.outboxSkippedCutoff),
    db.prepare(CSP_VIOLATIONS_SQL).bind(clock.today, clock.yesterday),
  ])
  const rowsAt = (index: number): Row[] => results[index]?.results ?? []
  const eventsToday = rowsAt(activeSpecs.length)
  const handoversToday = rowsAt(activeSpecs.length + 1)
  const heartbeat = rowsAt(activeSpecs.length + 2)
  const outbox = rowsAt(activeSpecs.length + 3)
  const csp = rowsAt(activeSpecs.length + 4)

  const sections: AdminQueueSection[] = []
  let dueToday = 0
  let decideNow = 0

  activeSpecs.forEach((spec, index) => {
    const rows = rowsAt(index)
    const items: AdminQueueItem[] = []
    let skippedCount = 0

    for (const row of rows) {
      const item = readAdminQueueItem(spec, row, now)

      if (item === null) {
        skippedCount += 1
        continue
      }

      items.push(item)

      if (item.dueAt !== null && riyadhDateKey(new Date(item.dueAt)) === clock.today) {
        dueToday += 1
      }
    }

    if (skippedCount > 0) {
      console.error(`ADMIN_QUEUE_ROW_INVALID section=${spec.id} count=${skippedCount}`)
    }

    const total = readTotal(rows)

    if (spec.id === 'decide_now') {
      decideNow = total
    }

    // UX-05: an empty section is omitted.
    if (items.length > 0) {
      sections.push({
        id: spec.id,
        order: adminQueueSectionOrder(spec.id),
        total: Math.max(total, items.length),
        items,
      })
    }
  })

  const lastOkAtValue = heartbeat.at(0)?.lastOkAt
  const cronLastOkAt = isCanonicalInstant(lastOkAtValue) ? lastOkAtValue : null
  const health: AdminQueueHealth = {
    cronLastOkAt,
    cronStale: cronLastOkAt === null || isBefore(cronLastOkAt, clock.cronStaleCutoff),
    emailConfigured: isEmailConfigured(env),
    outboxFailed: readCountRow(outbox, 'failed'),
    outboxSkipped24h: readCountRow(outbox, 'skipped'),
    cspViolations24h: readCountRow(csp, 'total'),
  }

  return {
    ok: true,
    summary: {
      decideNow,
      dueToday,
      eventsToday: readCountRow(eventsToday, 'total'),
      handoversToday: readCountRow(handoversToday, 'total'),
    },
    health,
    alerts: buildAlerts(
      snapshot,
      onlineConfirmationUnavailableReason(features.onlineConfirmation),
      health,
    ),
    sections,
    serverTime: clock.nowIso,
  }
}

function invalidQueryResponse(): Response {
  return errorResponse(400, 'INVALID_QUERY', 'معاملات الطلب غير صحيحة.')
}

/** GET /api/admin/queue (#35; AD). */
export async function handleAdminQueue(context: AdminPortalContext): Promise<Response> {
  const { env, url, admin } = context

  // RL_ADMIN_READ (§3.1): slows a scripted scrape with a stolen session.
  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  // Filter-free route: any query string is refused before a read.
  if ([...url.searchParams.keys()].length > 0) {
    return invalidQueryResponse()
  }

  return jsonResponse(await loadAdminQueue(env, new Date()))
}
