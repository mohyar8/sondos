import { isValidDateKey, parseInstant } from '../../shared/timing.js'
import { renderHoldExpiredEmail } from '../emails/hold.js'
import {
  outboxInsertStatement,
  prepareOutboxRow,
  type OutboxRow,
  type OutboxRowError,
} from '../notify/outbox.js'
import {
  JOB_LIMITS,
  JobFailure,
  type JobContext,
  type ScheduledJob,
} from './job-types.js'
import {
  LATEST_RECEIPT_STATUS_SQL,
  OWED_HOLD_PREDICATE_SQL,
  readOwedHold,
  type OwedHold,
} from './hold-state.js'

/**
 * The `hold-expiry` job (ADR-001 §2.2, every 15 minutes, before the
 * reminders and the outbox drain).
 *
 * It selects by STATE, not by time window, so a missed tick simply catches
 * up: every flow-2 booking whose customer still owes a receipt (see
 * hold-state.ts) and whose `hold_expires_at` <= now, oldest deadline first,
 * at most 50 per tick. Each booking then expires in ONE D1 batch (one
 * transaction):
 * 1. the guarded UPDATE to `expired`, re-checking the state it was selected
 *    in (status, deadline, flow 2, receipt still owed);
 * 2. the status-history row, `changed_by` NULL (the system), whose
 *    `CASE WHEN changes() = 1` guard rolls the whole batch back when the
 *    booking changed after it was selected (a receipt uploaded, an extension,
 *    a cancel);
 * 3. a `booking_events` row with actor `system` — written only once the
 *    `hold_expired` event kind is seeded (migration 0005 does not seed it);
 * 4. its pending hold reminders superseded;
 * 5. the `hold_expired` email queued in the outbox, keyed on the deadline.
 *
 * Legacy flow-1 rows are never selected. Logs carry fixed codes and counts
 * only.
 */

export const HOLD_EXPIRY_LIMITS = {
  maxBookingsPerTick: JOB_LIMITS.maxRowsPerTick,
} as const

export interface HoldExpirySummary {
  readonly selected: number
  readonly expired: number
  /** Expired without an email: no usable address, erased data, or an unusable deadline. */
  readonly expiredWithoutEmail: number
  /** Changed between the select and the batch; nothing written. */
  readonly raced: number
  readonly failed: number
  /** True when the tick budget ran out before every selected booking was handled. */
  readonly halted: boolean
}

export interface HoldExpiryOptions {
  readonly nowIso: string
  readonly signal: AbortSignal
  readonly appBaseUrl: string | undefined
  readonly maxBookings?: number
  /**
   * Only holds for this Riyadh date (`YYYY-MM-DD`): the targeted sweep the
   * approve path runs first, so a hold that has just expired never causes a
   * false DATE_UNAVAILABLE (ADR §2.1). Omitted by the cron job.
   */
  readonly eventDate?: string
}

type ExpireOutcome = 'expired' | 'expired_without_email' | 'raced' | 'failed'

// ?1 now | ?2 max rows | ?3 event_date filter, or NULL for every date
const SELECT_DUE_SQL = `
  SELECT
    b.id,
    b.flow_version,
    b.status,
    b.event_date,
    b.hold_expires_at,
    ${LATEST_RECEIPT_STATUS_SQL} AS latest_receipt_status,
    CASE WHEN u.erased_at IS NULL AND u.email_verified_at IS NOT NULL THEN u.email END AS customer_email,
    CASE WHEN u.erased_at IS NULL THEN u.first_name END AS customer_first_name
  FROM booking_requests AS b
  LEFT JOIN users AS u ON u.id = b.user_id
  WHERE ${OWED_HOLD_PREDICATE_SQL}
    AND b.hold_expires_at <= ?1
    AND (?3 IS NULL OR b.event_date = ?3)
  ORDER BY b.hold_expires_at, b.id
  LIMIT ?2
`

// ?1 booking id | ?2 status it was selected in | ?3 its deadline | ?4 now
const EXPIRE_SQL = `
  UPDATE booking_requests AS b
  SET status = 'expired',
      updated_at = ?4
  WHERE b.id = ?1
    AND b.status = ?2
    AND b.hold_expires_at = ?3
    AND b.hold_expires_at <= ?4
    AND ${OWED_HOLD_PREDICATE_SQL}
`

// The guard: to_status is NULL when the UPDATE changed nothing, which fails
// NOT NULL and rolls the whole batch back (admin-workflow.ts pattern).
const HISTORY_SQL = `
  INSERT INTO booking_status_history (
    booking_id,
    from_status,
    to_status,
    changed_by,
    note,
    created_at
  )
  VALUES (?1, ?2, CASE WHEN changes() = 1 THEN 'expired' END, NULL, NULL, ?4)
`

// Selecting the kind from event_kinds keeps this a no-op (never a foreign-key
// failure) until a migration seeds 'hold_expired'.
const SYSTEM_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, event, details, created_at)
  SELECT ?1, 'system', k.kind, json_object('fromStatus', ?2, 'holdExpiresAt', ?3), ?4
  FROM event_kinds AS k
  WHERE k.kind = 'hold_expired'
`

const SUPERSEDE_REMINDERS_SQL = `
  UPDATE notification_log
  SET status = 'superseded',
      recipient = NULL,
      payload = NULL,
      finished_at = ?4,
      updated_at = ?4
  WHERE booking_id = ?1
    AND status = 'pending'
    AND kind IN ('hold_reminder_24h', 'hold_reminder_6h')
`

// ?1 booking id | ?2 status it was selected in | ?3 its deadline | ?4 now
const RECHECK_SQL = `
  SELECT 1 AS still_due
  FROM booking_requests AS b
  WHERE b.id = ?1
    AND b.status = ?2
    AND b.hold_expires_at = ?3
    AND b.hold_expires_at <= ?4
    AND ${OWED_HOLD_PREDICATE_SQL}
`

/**
 * True when `hold` is past its deadline at `now` (the deadline itself counts
 * as passed, matching `hold_expires_at <= now`).
 */
export function isHoldExpiryDue(hold: OwedHold, now: Date): boolean {
  return hold.holdExpiresAtMs <= now.getTime()
}

/**
 * The selected rows that may expire now: flow-2 holds that still owe a
 * receipt and whose deadline has passed, in deadline order, at most `limit`.
 * Anything else (a legacy row, a pending receipt, a future deadline, a
 * malformed row) is dropped.
 */
export function selectExpirableHolds(
  rows: readonly unknown[],
  now: Date,
  limit: number = HOLD_EXPIRY_LIMITS.maxBookingsPerTick,
): OwedHold[] {
  return rows
    .map(readOwedHold)
    .filter((hold): hold is OwedHold => hold !== null && isHoldExpiryDue(hold, now))
    .sort(
      (left, right) =>
        left.holdExpiresAtMs - right.holdExpiresAtMs ||
        (left.bookingId < right.bookingId ? -1 : left.bookingId > right.bookingId ? 1 : 0),
    )
    .slice(0, Math.max(0, limit))
}

export type HoldExpiredEmailResult =
  | { readonly ok: true; readonly row: OutboxRow }
  | { readonly ok: false; readonly code: OutboxRowError | 'NO_RECIPIENT' | 'UNRENDERABLE' }

/** The outbox row for the `hold_expired` email, anchored on the deadline. */
export function buildHoldExpiredOutboxRow(
  hold: OwedHold,
  appBaseUrl: string | undefined,
): HoldExpiredEmailResult {
  if (hold.customerEmail === null) {
    return { ok: false, code: 'NO_RECIPIENT' }
  }

  const template = renderHoldExpiredEmail({
    customerFirstName: hold.customerFirstName,
    bookingId: hold.bookingId,
    eventDate: hold.eventDate,
    holdExpiresAt: hold.holdExpiresAt,
    appBaseUrl,
  })

  if (template === null) {
    return { ok: false, code: 'UNRENDERABLE' }
  }

  const prepared = prepareOutboxRow({
    ...template,
    kind: 'hold_expired',
    bookingId: hold.bookingId,
    anchor: hold.holdExpiresAt,
    recipient: hold.customerEmail,
  })

  return prepared.ok ? { ok: true, row: prepared.row } : prepared
}

async function isStillDue(
  env: Env,
  hold: OwedHold,
  nowIso: string,
): Promise<boolean> {
  const row = await env.DB.prepare(RECHECK_SQL)
    .bind(hold.bookingId, hold.status, hold.holdExpiresAt, nowIso)
    .first<unknown>()

  return row !== null
}

async function expireHold(
  env: Env,
  hold: OwedHold,
  nowIso: string,
  appBaseUrl: string | undefined,
): Promise<ExpireOutcome> {
  const email = buildHoldExpiredOutboxRow(hold, appBaseUrl)
  const params = [hold.bookingId, hold.status, hold.holdExpiresAt, nowIso] as const
  const statements = [
    env.DB.prepare(EXPIRE_SQL).bind(...params),
    env.DB.prepare(HISTORY_SQL).bind(...params),
    env.DB.prepare(SYSTEM_EVENT_SQL).bind(...params),
    env.DB.prepare(SUPERSEDE_REMINDERS_SQL).bind(...params),
  ]

  if (email.ok) {
    statements.push(outboxInsertStatement(env.DB, email.row, nowIso))
  } else {
    console.warn(`HOLD_EXPIRED_EMAIL_NOT_QUEUED code=${email.code}`)
  }

  try {
    const [expireResult, historyResult] = await env.DB.batch(statements)

    if (expireResult?.meta.changes !== 1 || historyResult?.meta.changes !== 1) {
      // Unreachable while the guard holds; never count it as expired.
      return 'failed'
    }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }

    // The batch rolled back as one transaction. Either the guard fired
    // because the booking changed after it was selected (benign), or D1
    // failed (counted, and the job reports it). A failing re-read throws.
    return (await isStillDue(env, hold, nowIso)) ? 'failed' : 'raced'
  }

  return email.ok ? 'expired' : 'expired_without_email'
}

/**
 * One bounded expiry pass: the cron job's, or (with `eventDate`) the approve
 * path's targeted sweep. Throws JobFailure for an unusable clock or date and
 * lets a D1 error on the initial select (or on a re-read) propagate.
 */
export async function expireOverdueHolds(
  env: Env,
  options: HoldExpiryOptions,
): Promise<HoldExpirySummary> {
  const now = parseInstant(options.nowIso)

  if (now === null || now.toISOString() !== options.nowIso) {
    throw new JobFailure('HOLD_EXPIRY_INVALID_CLOCK')
  }

  if (options.eventDate !== undefined && !isValidDateKey(options.eventDate)) {
    throw new JobFailure('HOLD_EXPIRY_INVALID_DATE')
  }

  const limit = Math.max(
    0,
    Math.min(
      Math.trunc(options.maxBookings ?? HOLD_EXPIRY_LIMITS.maxBookingsPerTick),
      HOLD_EXPIRY_LIMITS.maxBookingsPerTick,
    ),
  )
  const selectedRows = await env.DB.prepare(SELECT_DUE_SQL)
    .bind(options.nowIso, limit, options.eventDate ?? null)
    .all<unknown>()
  const holds = selectExpirableHolds(selectedRows.results, now, limit)

  let expired = 0
  let expiredWithoutEmail = 0
  let raced = 0
  let failed = 0
  let halted = false

  for (const hold of holds) {
    if (options.signal.aborted) {
      halted = true
      break
    }

    const outcome = await expireHold(env, hold, options.nowIso, options.appBaseUrl)

    switch (outcome) {
      case 'expired':
        expired += 1
        break
      case 'expired_without_email':
        expiredWithoutEmail += 1
        break
      case 'raced':
        raced += 1
        break
      case 'failed':
        failed += 1
        break
    }
  }

  return {
    selected: holds.length,
    expired,
    expiredWithoutEmail,
    raced,
    failed,
    halted,
  }
}

async function runHoldExpiryJob(context: JobContext): Promise<void> {
  const summary = await expireOverdueHolds(context.env, {
    nowIso: context.nowIso,
    signal: context.signal,
    appBaseUrl: context.env.APP_BASE_URL,
  })

  if (summary.expired + summary.expiredWithoutEmail > 0) {
    console.log(
      `HOLD_EXPIRY_DONE expired=${summary.expired + summary.expiredWithoutEmail} without_email=${summary.expiredWithoutEmail}`,
    )
  }

  if (summary.halted) {
    console.warn('HOLD_EXPIRY_HALTED code=TICK_BUDGET_EXHAUSTED')
  }

  if (summary.failed > 0) {
    // Recorded in job_runs; the next tick retries, because it selects by state.
    throw new JobFailure('HOLD_EXPIRY_BATCH_FAILED')
  }
}

/** Registered first in the quarter-hourly group of worker/jobs/registry.ts. */
export const holdExpiryJob: ScheduledJob = {
  name: 'hold-expiry',
  schedule: 'quarter-hourly',
  run: runHoldExpiryJob,
}
