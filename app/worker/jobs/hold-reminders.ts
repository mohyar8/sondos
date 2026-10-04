import {
  TIMING,
  addMsToInstant,
  isWithinSendWindow,
  parseInstant,
} from '../../shared/timing.js'
import { renderHoldReminderEmail, type HoldReminderKind } from '../emails/hold.js'
import {
  buildDedupeKey,
  isNotificationStatus,
  prepareOutboxRow,
  type NotificationStatus,
  type OutboxRow,
  type OutboxRowError,
} from '../notify/outbox.js'
import {
  getReceiptChannel,
  readHoldAutoExpiry,
  type ReceiptChannel,
} from '../settings/features.js'
import { ONLINE_CONFIRMATION_SWITCH_ON_SQL } from '../settings/settings-read.js'
import {
  JOB_LIMITS,
  JobFailure,
  type JobContext,
  type ScheduledJob,
} from './job-types.js'
import {
  LATEST_RECEIPT_STATUS_SQL,
  NOTICE_PROTECTED_COLUMN_SQL,
  NOTICE_PROTECTED_SQL,
  OWED_HOLD_PREDICATE_SQL,
  isCanonicalInstant,
  isRecord,
  readOwedHold,
  type OwedHold,
} from './hold-state.js'

/**
 * The `hold-reminders` job (ADR-001 §2.2, every 15 minutes, after
 * hold-expiry and before the outbox drain, so one tick sends what it queues;
 * plan 11 B1, H3, TM-15).
 *
 * While she still owes a receipt (hold-state.ts), two reminders are due
 * before `hold_expires_at`: 24 h and 6 h (TIMING.holdReminderOffsetsMs). A
 * reminder is queued only when its due time <= now < the deadline, and only
 * inside the 09:00–21:00 Riyadh send window (TIMING.sendWindowRiyadh).
 * - Reminders follow automatic expiry: they are queued only while AX = EM ∧
 *   OCe (worker/settings/features.ts). Without an email provider nothing
 *   could be sent; with the kill switch pulled the confirmation routes
 *   answer 503, so a reminder would send her to steps she cannot take, and
 *   the hold does not lapse on its own either. While AX is off, reminders
 *   already queued for the current deadline are superseded.
 * - A notice-protected hold (she has told us she transferred the deposit)
 *   gets no reminder, and any still pending is superseded (B1, UX-02).
 * - The copy names what she still owes (emails/hold.ts): accept the terms;
 *   transfer and send the receipt on WhatsApp; or upload the receipt, the
 *   last only while receipt uploads are open (PM, getReceiptChannel).
 * - If both are due (a missed tick, or a window that opened late), only the
 *   6 h one is sent and the 24 h one is recorded as `superseded`.
 * - A reminder that fell due before the current deadline was set by a
 *   receipt rejection or an extension is recorded as `superseded` too: the
 *   email that set the deadline already states it (for example, a rejection
 *   that leaves exactly 24 h would otherwise trigger the 24 h reminder at
 *   once).
 * - Dedupe keys are `<kind>:<bookingId>:<hold_expires_at>` (no personal
 *   data), so a new deadline re-arms both reminders, and a re-run never
 *   queues twice.
 * - The insert re-checks inside the same statement everything its copy and
 *   its sending depend on (TM-15): the status, the deadline, whether the
 *   terms are accepted, that she still owes a receipt, that no notice for
 *   this deadline exists and that the kill switch is on. A receipt, a
 *   notice or an acceptance meanwhile queues nothing; the next tick
 *   re-plans from the new state.
 *
 * Neither job claims rows: every write is a conditional statement keyed on
 * the state it read, so an overlapping tick changes nothing twice (the
 * outbox drain owns the claim, TM-15).
 *
 * Selection is by state (a deadline within the next 24 h), so a missed tick
 * catches up; bookings whose 6 h reminder is already recorded drop out, and
 * a protected hold (or any hold while AX is off) is selected only while one
 * of its reminders is still pending. Logs carry fixed codes and counts only.
 */

interface HoldReminderStep {
  readonly kind: HoldReminderKind
  readonly offsetMs: number
}

/** Least urgent first: 24 h, then 6 h before the deadline. */
export const HOLD_REMINDER_STEPS: readonly HoldReminderStep[] = [
  { kind: 'hold_reminder_24h', offsetMs: TIMING.holdReminderOffsetsMs[0] },
  { kind: 'hold_reminder_6h', offsetMs: TIMING.holdReminderOffsetsMs[1] },
]

const LARGEST_REMINDER_OFFSET_MS = Math.max(
  ...HOLD_REMINDER_STEPS.map((step) => step.offsetMs),
)

export const HOLD_REMINDER_LIMITS = {
  maxBookingsPerTick: JOB_LIMITS.maxRowsPerTick,
} as const

/** What the job knows about one hold's reminders for its current deadline. */
export interface HoldReminderFacts {
  readonly holdExpiresAtMs: number
  /** A `deposit_notice_sent` event exists for this deadline (B1). */
  readonly noticeProtected: boolean
  /**
   * When a receipt rejection or an extension last set the deadline (its own
   * email states the new deadline); null when the approval set it.
   */
  readonly deadlineSetAtMs: number | null
  /** notification_log status of each reminder for this deadline; null = no row. */
  readonly recorded: Readonly<Record<HoldReminderKind, NotificationStatus | null>>
}

/** What may be sent at this instant. */
export interface HoldReminderSendState {
  /** AX = EM ∧ OCe for this tick: reminders may be queued at all. */
  readonly remindersOn: boolean
  /** Inside the 09:00–21:00 Riyadh send window. */
  readonly inSendWindow: boolean
}

export interface HoldReminderPlan {
  /** The reminder to queue now, or null. */
  readonly send: HoldReminderKind | null
  /** Reminders to record as `superseded` (a new row, or a pending one). */
  readonly supersede: readonly HoldReminderKind[]
}

const NOTHING_TO_DO: HoldReminderPlan = { send: null, supersede: [] }

function isOpenStatus(status: NotificationStatus | null): boolean {
  return status === null || status === 'pending'
}

/**
 * Decides what to do for one hold at `nowMs` (pure). Only the most urgent
 * due reminder may be sent; every other due reminder that is still open is
 * superseded. Nothing is sent outside the send window or while reminders
 * are off, but superseding does not wait for either. A notice-protected
 * hold, or any hold while reminders are off, only has its pending
 * reminders superseded.
 */
export function planHoldReminder(
  facts: HoldReminderFacts,
  nowMs: number,
  sendState: HoldReminderSendState,
): HoldReminderPlan {
  if (facts.noticeProtected || !sendState.remindersOn) {
    const pending = HOLD_REMINDER_STEPS.filter(
      (step) => facts.recorded[step.kind] === 'pending',
    ).map((step) => step.kind)

    return pending.length === 0 ? NOTHING_TO_DO : { send: null, supersede: pending }
  }

  const remainingMs = facts.holdExpiresAtMs - nowMs

  if (
    !Number.isFinite(remainingMs) ||
    remainingMs <= 0 ||
    remainingMs > LARGEST_REMINDER_OFFSET_MS
  ) {
    return NOTHING_TO_DO
  }

  const dueSteps = HOLD_REMINDER_STEPS.filter(
    (step) => facts.holdExpiresAtMs - step.offsetMs <= nowMs,
  )
  const mostUrgent = dueSteps.at(-1)

  if (mostUrgent === undefined) {
    return NOTHING_TO_DO
  }

  const coveredByDeadlineEmail = (step: HoldReminderStep): boolean =>
    facts.deadlineSetAtMs !== null &&
    facts.holdExpiresAtMs - step.offsetMs <= facts.deadlineSetAtMs

  const supersede = dueSteps
    .filter(
      (step) =>
        (step !== mostUrgent || coveredByDeadlineEmail(step)) &&
        isOpenStatus(facts.recorded[step.kind]),
    )
    .map((step) => step.kind)

  const send =
    sendState.inSendWindow &&
    !coveredByDeadlineEmail(mostUrgent) &&
    facts.recorded[mostUrgent.kind] === null
      ? mostUrgent.kind
      : null

  return { send, supersede }
}

/** A selected hold plus the facts planHoldReminder needs. */
export interface HoldReminderCandidate {
  readonly hold: OwedHold
  readonly facts: HoldReminderFacts
}

function readRecordedStatus(value: unknown): NotificationStatus | null | undefined {
  if (value === null) {
    return null
  }

  return isNotificationStatus(value) ? value : undefined
}

/**
 * Reads one row of the candidate query. Null for anything that is not a
 * flow-2 hold still owing a receipt, or whose extra columns are malformed.
 */
export function readHoldReminderCandidate(
  value: unknown,
): HoldReminderCandidate | null {
  const hold = readOwedHold(value)

  if (hold === null || !isRecord(value)) {
    return null
  }

  const deadlineSetAt = value.deadline_set_at
  const reminder24h = readRecordedStatus(value.reminder_24h_status)
  const reminder6h = readRecordedStatus(value.reminder_6h_status)

  if (
    (deadlineSetAt !== null && !isCanonicalInstant(deadlineSetAt)) ||
    reminder24h === undefined ||
    reminder6h === undefined
  ) {
    return null
  }

  return {
    hold,
    facts: {
      holdExpiresAtMs: hold.holdExpiresAtMs,
      noticeProtected: hold.noticeProtected,
      deadlineSetAtMs: deadlineSetAt === null ? null : Date.parse(deadlineSetAt),
      recorded: {
        hold_reminder_24h: reminder24h,
        hold_reminder_6h: reminder6h,
      },
    },
  }
}

export type HoldReminderRowResult =
  | { readonly ok: true; readonly row: OutboxRow }
  | { readonly ok: false; readonly code: OutboxRowError | 'NO_RECIPIENT' | 'UNRENDERABLE' }

/**
 * The outbox row for one reminder, anchored on the hold's deadline, in the
 * copy for what she still owes and where her receipt goes.
 */
export function buildHoldReminderOutboxRow(
  hold: OwedHold,
  kind: HoldReminderKind,
  appBaseUrl: string | undefined,
  receiptChannel: ReceiptChannel,
): HoldReminderRowResult {
  if (hold.customerEmail === null) {
    return { ok: false, code: 'NO_RECIPIENT' }
  }

  const template = renderHoldReminderEmail({
    kind,
    customerFirstName: hold.customerFirstName,
    bookingId: hold.bookingId,
    eventDate: hold.eventDate,
    holdExpiresAt: hold.holdExpiresAt,
    owedStep: hold.owedStep,
    receiptChannel,
    appBaseUrl,
  })

  if (template === null) {
    return { ok: false, code: 'UNRENDERABLE' }
  }

  const prepared = prepareOutboxRow({
    ...template,
    kind,
    bookingId: hold.bookingId,
    anchor: hold.holdExpiresAt,
    recipient: hold.customerEmail,
  })

  return prepared.ok ? { ok: true, row: prepared.row } : prepared
}

export interface HoldReminderSummary {
  /** AX was on for this tick (reminders may be queued). */
  readonly remindersOn: boolean
  readonly selected: number
  readonly queued: number
  readonly superseded: number
  /** A reminder was due but could not be queued (no address, invalid row). */
  readonly notQueued: number
  readonly failed: number
  readonly halted: boolean
}

export interface HoldReminderOptions {
  readonly nowIso: string
  readonly signal: AbortSignal
  readonly appBaseUrl: string | undefined
  readonly maxBookings?: number
}

// The reminder rows for the CURRENT deadline, looked up by primary key. The
// key is '<kind>:<bookingId>:<hold_expires_at>' (outbox.ts buildDedupeKey);
// the lookup only avoids repeated work, the primary key is what dedupes.
// While reminders are on, an unprotected hold is selected until its 6 h
// reminder is recorded; a protected hold, or any hold while they are off,
// only while one of its reminders is still pending (to supersede it).
// ?1 now | ?2 now + 24 h | ?3 max rows | ?4 reminders on (1) or off (0)
const SELECT_CANDIDATES_SQL = `
  SELECT
    b.id,
    b.flow_version,
    b.status,
    b.event_date,
    b.hold_expires_at,
    b.terms_accepted_at,
    ${LATEST_RECEIPT_STATUS_SQL} AS latest_receipt_status,
    ${NOTICE_PROTECTED_COLUMN_SQL} AS notice_protected,
    (
      SELECT MAX(e.created_at)
      FROM booking_events AS e
      WHERE e.booking_id = b.id
        AND e.event IN ('receipt_rejected', 'hold_extended')
    ) AS deadline_set_at,
    (
      SELECT n.status
      FROM notification_log AS n
      WHERE n.dedupe_key = 'hold_reminder_24h:' || b.id || ':' || b.hold_expires_at
    ) AS reminder_24h_status,
    (
      SELECT n.status
      FROM notification_log AS n
      WHERE n.dedupe_key = 'hold_reminder_6h:' || b.id || ':' || b.hold_expires_at
    ) AS reminder_6h_status,
    CASE WHEN u.erased_at IS NULL AND u.email_verified_at IS NOT NULL THEN u.email END AS customer_email,
    CASE WHEN u.erased_at IS NULL THEN u.first_name END AS customer_first_name
  FROM booking_requests AS b
  LEFT JOIN users AS u ON u.id = b.user_id
  WHERE ${OWED_HOLD_PREDICATE_SQL}
    AND b.hold_expires_at > ?1
    AND b.hold_expires_at <= ?2
    AND CASE
      WHEN ?4 = 1 AND NOT ${NOTICE_PROTECTED_SQL} THEN NOT EXISTS (
        SELECT 1
        FROM notification_log AS n6
        WHERE n6.dedupe_key = 'hold_reminder_6h:' || b.id || ':' || b.hold_expires_at
      )
      ELSE EXISTS (
        SELECT 1
        FROM notification_log AS np
        WHERE np.dedupe_key IN (
            'hold_reminder_24h:' || b.id || ':' || b.hold_expires_at,
            'hold_reminder_6h:' || b.id || ':' || b.hold_expires_at
          )
          AND np.status = 'pending'
      )
    END
  ORDER BY b.hold_expires_at, b.id
  LIMIT ?3
`

// Records one reminder as superseded: a new terminal row, or a pending row
// moved to superseded. A row already sending or finished is left alone.
// ?1 dedupe key | ?2 booking id | ?3 kind | ?4 now
const SUPERSEDE_SQL = `
  INSERT INTO notification_log (
    dedupe_key,
    booking_id,
    kind,
    recipient,
    payload,
    status,
    attempts,
    created_at,
    updated_at,
    finished_at
  )
  VALUES (?1, ?2, ?3, NULL, NULL, 'superseded', 0, ?4, ?4, ?4)
  ON CONFLICT (dedupe_key) DO UPDATE SET
    status = 'superseded',
    recipient = NULL,
    payload = NULL,
    finished_at = excluded.finished_at,
    updated_at = excluded.updated_at
  WHERE notification_log.status = 'pending'
`

// Queues one reminder only while, in the same statement, the booking is in
// the state its copy was written for: the same status and deadline, terms
// accepted or not as read, still owing a receipt, no notice for this
// deadline, and the kill switch on (TM-15). Binds the prepareOutboxRow()
// fields.
// ?1 dedupe key | ?2 booking id | ?3 kind | ?4 recipient | ?5 payload
// ?6 now | ?7 the deadline the reminder is for | ?8 status it was read in
// ?9 terms accepted when read (1) or not (0)
const QUEUE_SQL = `
  INSERT INTO notification_log (
    dedupe_key,
    booking_id,
    kind,
    recipient,
    payload,
    status,
    attempts,
    created_at,
    updated_at
  )
  SELECT ?1, b.id, ?3, ?4, ?5, 'pending', 0, ?6, ?6
  FROM booking_requests AS b
  WHERE b.id = ?2
    AND b.hold_expires_at = ?7
    AND b.hold_expires_at > ?6
    AND b.status = ?8
    AND (CASE WHEN b.terms_accepted_at IS NULL THEN 0 ELSE 1 END) = ?9
    AND ${OWED_HOLD_PREDICATE_SQL}
    AND NOT ${NOTICE_PROTECTED_SQL}
    AND ${ONLINE_CONFIRMATION_SWITCH_ON_SQL}
  ON CONFLICT (dedupe_key) DO NOTHING
`

interface ReminderBatchResult {
  readonly queued: number
  readonly superseded: number
  readonly notQueued: number
  readonly failed: number
}

async function applyPlan(
  env: Env,
  candidate: HoldReminderCandidate,
  plan: HoldReminderPlan,
  nowIso: string,
  appBaseUrl: string | undefined,
  receiptChannel: ReceiptChannel,
): Promise<ReminderBatchResult> {
  const { hold } = candidate
  const statements: D1PreparedStatement[] = []
  let notQueued = 0

  for (const kind of plan.supersede) {
    const dedupeKey = buildDedupeKey(kind, hold.bookingId, hold.holdExpiresAt)

    if (dedupeKey === null) {
      console.warn('HOLD_REMINDER_NOT_SUPERSEDED code=INVALID_DEDUPE_KEY')
      continue
    }

    statements.push(
      env.DB.prepare(SUPERSEDE_SQL).bind(dedupeKey, hold.bookingId, kind, nowIso),
    )
  }

  const supersedeCount = statements.length
  let queueIndex: number | null = null

  if (plan.send !== null) {
    const email = buildHoldReminderOutboxRow(
      hold,
      plan.send,
      appBaseUrl,
      receiptChannel,
    )

    if (email.ok) {
      queueIndex = statements.length
      statements.push(
        env.DB.prepare(QUEUE_SQL).bind(
          email.row.dedupeKey,
          email.row.bookingId,
          email.row.kind,
          email.row.recipient,
          email.row.payload,
          nowIso,
          hold.holdExpiresAt,
          hold.status,
          hold.termsAccepted ? 1 : 0,
        ),
      )
    } else {
      notQueued = 1
      console.warn(`HOLD_REMINDER_NOT_QUEUED code=${email.code}`)
    }
  }

  if (statements.length === 0) {
    return { queued: 0, superseded: 0, notQueued, failed: 0 }
  }

  try {
    const results = await env.DB.batch(statements)
    const superseded = results
      .slice(0, supersedeCount)
      .reduce((total, result) => total + result.meta.changes, 0)
    const queued =
      queueIndex === null ? 0 : (results[queueIndex]?.meta.changes ?? 0)

    return { queued, superseded, notQueued, failed: 0 }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }

    // Nothing here is expected to fail (no guard aborts this batch), so a
    // failure is a D1 problem: counted and reported by the job. The whole
    // batch rolled back; the next tick retries from state.
    return { queued: 0, superseded: 0, notQueued, failed: 1 }
  }
}

/**
 * One bounded reminder pass. Throws JobFailure for an unusable clock and lets
 * a D1 error on the switch read or the select propagate.
 */
export async function queueDueHoldReminders(
  env: Env,
  options: HoldReminderOptions,
): Promise<HoldReminderSummary> {
  const now = parseInstant(options.nowIso)

  if (now === null || now.toISOString() !== options.nowIso) {
    throw new JobFailure('HOLD_REMINDERS_INVALID_CLOCK')
  }

  const limit = Math.max(
    0,
    Math.min(
      Math.trunc(options.maxBookings ?? HOLD_REMINDER_LIMITS.maxBookingsPerTick),
      HOLD_REMINDER_LIMITS.maxBookingsPerTick,
    ),
  )
  const remindersOn = await readHoldAutoExpiry(env, env.DB)
  const receiptChannel = getReceiptChannel(env)
  const selected = await env.DB.prepare(SELECT_CANDIDATES_SQL)
    .bind(
      options.nowIso,
      addMsToInstant(now, LARGEST_REMINDER_OFFSET_MS),
      limit,
      remindersOn ? 1 : 0,
    )
    .all<unknown>()
  const candidates = selected.results
    .map(readHoldReminderCandidate)
    .filter((candidate) => candidate !== null)
  const sendState: HoldReminderSendState = {
    remindersOn,
    inSendWindow: isWithinSendWindow(now),
  }

  let queued = 0
  let superseded = 0
  let notQueued = 0
  let failed = 0
  let halted = false

  for (const candidate of candidates) {
    if (options.signal.aborted) {
      halted = true
      break
    }

    const plan = planHoldReminder(candidate.facts, now.getTime(), sendState)

    if (plan.send === null && plan.supersede.length === 0) {
      continue
    }

    const result = await applyPlan(
      env,
      candidate,
      plan,
      options.nowIso,
      options.appBaseUrl,
      receiptChannel,
    )

    queued += result.queued
    superseded += result.superseded
    notQueued += result.notQueued
    failed += result.failed
  }

  return {
    remindersOn,
    selected: candidates.length,
    queued,
    superseded,
    notQueued,
    failed,
    halted,
  }
}

async function runHoldRemindersJob(context: JobContext): Promise<void> {
  const summary = await queueDueHoldReminders(context.env, {
    nowIso: context.nowIso,
    signal: context.signal,
    appBaseUrl: context.env.APP_BASE_URL,
  })

  if (summary.queued > 0) {
    console.log(`HOLD_REMINDERS_QUEUED count=${summary.queued}`)
  }

  if (summary.superseded > 0) {
    console.log(`HOLD_REMINDERS_SUPERSEDED count=${summary.superseded}`)
  }

  if (summary.halted) {
    console.warn('HOLD_REMINDERS_HALTED code=TICK_BUDGET_EXHAUSTED')
  }

  if (summary.failed > 0) {
    throw new JobFailure('HOLD_REMINDERS_BATCH_FAILED')
  }
}

/** Registered after hold-expiry and before outbox-drain in worker/jobs/registry.ts. */
export const holdRemindersJob: ScheduledJob = {
  name: 'hold-reminders',
  schedule: 'quarter-hourly',
  run: runHoldRemindersJob,
}
