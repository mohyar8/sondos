import type {
  EmailDeliveryResult,
  EmailMessageInput,
  EmailTemplate,
} from '../../shared/notifications.js'
import { addMsToInstant, parseInstant } from '../../shared/timing.js'
import { sendEmail } from '../email.js'
import {
  JOB_LIMITS,
  JobFailure,
  type JobContext,
  type ScheduledJob,
} from '../jobs/job-types.js'

/**
 * The email outbox: `notification_log` (ADR-001 §2.2, 06-data-model §3.6 and
 * §4.6).
 *
 * Queueing. A portal email is rendered when it is queued and stored as a JSON
 * payload `{ "subject", "html", "text" }` with its recipient, under the
 * primary key `dedupe_key = '<kind>:<bookingId>:<anchor>'` (the entity is
 * always the booking; the anchor is the deadline itself, a receipt or gallery
 * id, or `once`). The same key is Resend's Idempotency-Key, so a re-queue is
 * a no-op (`ON CONFLICT DO NOTHING`) and a re-send inside Resend's 24 h
 * window never delivers twice. A new anchor (an extended hold) is a new key,
 * which re-arms the reminders.
 * - enqueueEmail(): one row on its own.
 * - prepareOutboxRow() + outboxInsertStatement(): the same row as one
 *   statement of a caller's own D1 batch, so the email commits or rolls back
 *   with the state change. A batch that writes its own INSERT must still bind
 *   the fields prepareOutboxRow() returns; the drain accepts no other payload.
 *
 * Draining. The `outbox-drain` job (every 15 minutes, last in its group):
 * 1. in one batch, gives up on up to 50 rows past 3 attempts or 24 h old
 *    (`failed`, GAVE_UP; a larger backlog is given up over the next ticks),
 *    claims up to 40 rows (`pending`, or `sending` claimed more than 30 min
 *    ago, and in both cases under 3 attempts and inside the 24 h window) with
 *    a conditional UPDATE, and reads them back. The claim never depends on
 *    the give-up having reached every such row;
 * 2. sends them one after another through worker/email.ts, paced below
 *    Resend's default rate, while the tick budget lasts;
 * 3. finishes each row: `sent`; `skipped` (Resend not configured, terminal);
 *    `failed` (a message that can never be sent); or back to `pending` for a
 *    transient failure, until the 3rd attempt, which ends as `failed`;
 * 4. hands every claimed row it did not reach back to `pending`, the unused
 *    attempt refunded.
 * `recipient` and `payload` become NULL at every terminal status (data
 * minimisation; a CHECK in the schema enforces it).
 *
 * The booking emails that exist today keep their direct path (bookings.ts,
 * admin.ts) and do not use the outbox. Logs carry fixed codes and counts
 * only: never recipients, subjects, keys or message bodies.
 */

/** notification_kinds, as seeded by migrations/0005_portal_schema.sql. */
export const notificationKinds = [
  'hold_reminder_24h',
  'hold_reminder_6h',
  'hold_expired',
  'hold_extended',
  'receipt_submitted_admin',
  'receipt_rejected',
  'event_reminder_7d',
  'event_reminder_1d',
  'gallery_opened',
  'selection_reminder_7d',
  'selection_reminder_2d',
  'selection_overdue',
  'album_ready',
  'handover_reminder_1d',
  'feedback_request',
  'preview_deletion_notice',
] as const

export type NotificationKind = (typeof notificationKinds)[number]

/** notification_log.status, as checked by migrations/0005_portal_schema.sql. */
export const notificationStatuses = [
  'pending',
  'sending',
  'sent',
  'skipped',
  'failed',
  'superseded',
] as const

export type NotificationStatus = (typeof notificationStatuses)[number]

export function isNotificationStatus(
  value: unknown,
): value is NotificationStatus {
  return notificationStatuses.some((status) => status === value)
}

export const OUTBOX_LIMITS = {
  /** Emails sent per tick at most (ADR §2.2). */
  maxSendsPerTick: JOB_LIMITS.maxEmailsPerTick,
  /** Rows given up (`failed`, GAVE_UP) per tick at most (ADR §2.2 row cap). */
  maxGiveUpsPerTick: JOB_LIMITS.maxRowsPerTick,
  /** Send attempts per row; the CHECK on notification_log.attempts allows 0–3. */
  maxAttempts: 3,
  /** A `sending` row claimed longer ago than this is claimed again. */
  staleClaimMs: 30 * 60 * 1_000,
  /** Resend keeps idempotency keys for 24 h; no send is attempted after it. */
  idempotencyWindowMs: 24 * 60 * 60 * 1_000,
  /**
   * Gap between two calls to Resend. Assumes Resend's default limit of
   * 2 requests per second; 600 ms keeps the drain below it.
   */
  minSendIntervalMs: 600,
  /** notification_log.dedupe_key CHECK (Resend allows 256). */
  maxDedupeKeyLength: 200,
  /** notification_log.payload CHECK, in characters. */
  maxPayloadLength: 100_000,
  /** worker/email.ts subject limit. */
  maxSubjectLength: 998,
} as const

/** One portal email to queue. */
export interface OutboxEmail extends EmailTemplate {
  readonly kind: NotificationKind
  /** booking_requests.id: the key's entity and the row's foreign key. */
  readonly bookingId: string
  /** The deadline instant, a receipt or gallery id, or 'once'. */
  readonly anchor: string
  readonly recipient: string
}

/** A validated notification_log row, ready to bind. */
export interface OutboxRow {
  readonly dedupeKey: string
  readonly bookingId: string
  readonly kind: NotificationKind
  readonly recipient: string
  /** JSON `{ "subject", "html", "text" }`. */
  readonly payload: string
}

export type OutboxRowError =
  | 'INVALID_DEDUPE_KEY'
  | 'INVALID_RECIPIENT'
  | 'INVALID_SUBJECT'
  | 'INVALID_CONTENT'
  | 'PAYLOAD_TOO_LARGE'

export type OutboxRowResult =
  | { readonly ok: true; readonly row: OutboxRow }
  | { readonly ok: false; readonly code: OutboxRowError }

export type EnqueueResult =
  | { readonly status: 'queued'; readonly dedupeKey: string }
  | { readonly status: 'duplicate'; readonly dedupeKey: string }
  | { readonly status: 'invalid'; readonly code: OutboxRowError }

export type OutboxSender = (
  env: Env,
  input: EmailMessageInput,
) => Promise<EmailDeliveryResult>

/** Why a drain stopped before it had handled every claimed row. */
export type OutboxDrainHalt =
  | 'TICK_BUDGET_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'INVALID_CONFIGURATION'

export interface OutboxDrainOptions {
  /** The job's start instant (`toISOString()`); also this drain's claim mark. */
  readonly nowIso: string
  /** Aborts when the tick budget is spent. */
  readonly signal: AbortSignal
  /** Injected for tests; defaults to worker/email.ts sendEmail. */
  readonly send?: OutboxSender
  readonly maxSends?: number
}

export interface OutboxDrainSummary {
  /** Rows moved to `failed` (GAVE_UP) before claiming; at most maxGiveUpsPerTick. */
  readonly gaveUp: number
  readonly claimed: number
  readonly sent: number
  readonly skipped: number
  /** Transient failures put back to `pending` for another attempt. */
  readonly retried: number
  readonly failed: number
  /** Claimed rows not reached this tick, handed back to `pending`. */
  readonly released: number
  readonly halt: OutboxDrainHalt | null
}

type FinishOutcome =
  | { readonly status: 'sent'; readonly providerMessageId: string | null }
  | { readonly status: 'skipped'; readonly code: string }
  | { readonly status: 'failed'; readonly code: string }
  | { readonly status: 'retry'; readonly code: string }

interface ClaimedRow {
  readonly dedupeKey: string
  readonly recipient: unknown
  readonly payload: unknown
}

interface StoredEmail extends EmailTemplate {
  readonly recipient: string
}

const ENTITY_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/
const ANCHOR_PATTERN = /^[0-9A-Za-z][0-9A-Za-z:._-]{0,63}$/
const PROVIDER_MESSAGE_ID_PATTERN = /^[0-9A-Za-z._-]{1,128}$/
const MAXIMUM_RECIPIENT_LENGTH = 254

const INSERT_ROW_SQL = `
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
  VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6)
  ON CONFLICT (dedupe_key) DO NOTHING
`

// ?1 now | ?2 stale-claim cutoff | ?3 idempotency horizon | ?4 max attempts
// ?5 max rows. Bounded like every other per-tick write (ADR §2.2); the rest
// of a backlog is given up on the next ticks. CLAIM_SQL excludes exactly
// these rows, so none of them is sent in the meantime.
const GIVE_UP_SQL = `
  UPDATE notification_log
  SET status = 'failed',
      recipient = NULL,
      payload = NULL,
      finished_at = ?1,
      updated_at = ?1,
      last_error_code = 'GAVE_UP'
  WHERE dedupe_key IN (
    SELECT dedupe_key
    FROM notification_log
    WHERE (status = 'pending' AND (attempts >= ?4 OR created_at <= ?3))
       OR (
         status = 'sending'
         AND claimed_at <= ?2
         AND (attempts >= ?4 OR created_at <= ?3)
       )
    ORDER BY created_at, dedupe_key
    LIMIT ?5
  )
`

// ?1 now (the claim mark) | ?2 stale-claim cutoff | ?3 max rows
// ?4 max attempts | ?5 idempotency horizon. A row GIVE_UP_SQL would give up
// (attempts spent, or outside Resend's idempotency window) is never claimed,
// even when the capped give-up has not reached it yet.
const CLAIM_SQL = `
  UPDATE notification_log
  SET status = 'sending',
      claimed_at = ?1,
      attempts = attempts + 1,
      updated_at = ?1
  WHERE dedupe_key IN (
    SELECT dedupe_key
    FROM notification_log
    WHERE (status = 'pending' OR (status = 'sending' AND claimed_at <= ?2))
      AND attempts < ?4
      AND created_at > ?5
    ORDER BY created_at, dedupe_key
    LIMIT ?3
  )
`

// ?1 the claim mark
const SELECT_CLAIMED_SQL = `
  SELECT dedupe_key, recipient, payload
  FROM notification_log
  WHERE status = 'sending' AND claimed_at = ?1
  ORDER BY created_at, dedupe_key
`

// ?1 key | ?2 now | ?3 'sent' | 'skipped' | 'failed' | 'retry'
// ?4 provider message id or NULL | ?5 fixed error code or NULL
// ?6 the claim mark | ?7 max attempts
const FINISH_SQL = `
  UPDATE notification_log
  SET status = CASE
        WHEN ?3 = 'retry' AND attempts < ?7 THEN 'pending'
        WHEN ?3 = 'retry' THEN 'failed'
        ELSE ?3
      END,
      recipient = CASE WHEN ?3 = 'retry' AND attempts < ?7 THEN recipient END,
      payload = CASE WHEN ?3 = 'retry' AND attempts < ?7 THEN payload END,
      finished_at = CASE WHEN ?3 = 'retry' AND attempts < ?7 THEN NULL ELSE ?2 END,
      provider_message_id = ?4,
      last_error_code = ?5,
      updated_at = ?2
  WHERE dedupe_key = ?1 AND status = 'sending' AND claimed_at = ?6
`

// ?1 the claim mark | ?2 now. The attempt was never made, so it is refunded.
const RELEASE_SQL = `
  UPDATE notification_log
  SET status = 'pending',
      attempts = attempts - 1,
      updated_at = ?2
  WHERE status = 'sending' AND claimed_at = ?1 AND attempts > 0
`

export function isNotificationKind(value: unknown): value is NotificationKind {
  return notificationKinds.some((kind) => kind === value)
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index)

    if (
      characterCode <= 0x1f ||
      (characterCode >= 0x7f && characterCode <= 0x9f)
    ) {
      return true
    }
  }

  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `'<kind>:<bookingId>:<anchor>'`, or null when a part is outside the key
 * alphabet (the notification_log CHECK: 0-9 A-Z a-z : . _ -) or the key would
 * be longer than 200 characters. The booking id may not contain ':'.
 */
export function buildDedupeKey(
  kind: NotificationKind,
  bookingId: string,
  anchor: string,
): string | null {
  if (
    !isNotificationKind(kind) ||
    !ENTITY_ID_PATTERN.test(bookingId) ||
    !ANCHOR_PATTERN.test(anchor)
  ) {
    return null
  }

  const dedupeKey = `${kind}:${bookingId}:${anchor}`

  return dedupeKey.length <= OUTBOX_LIMITS.maxDedupeKeyLength
    ? dedupeKey
    : null
}

function isStorableRecipient(value: string): boolean {
  const atIndex = value.indexOf('@')

  return (
    value.length >= 3 &&
    value.length <= MAXIMUM_RECIPIENT_LENGTH &&
    atIndex > 0 &&
    atIndex < value.length - 1 &&
    !/\s/.test(value) &&
    !containsControlCharacter(value)
  )
}

/**
 * Validates one email against the notification_log CHECKs and the sender's
 * own rules, and renders its stored payload. Nothing is written.
 */
export function prepareOutboxRow(email: OutboxEmail): OutboxRowResult {
  const dedupeKey = buildDedupeKey(email.kind, email.bookingId, email.anchor)

  if (dedupeKey === null) {
    return { ok: false, code: 'INVALID_DEDUPE_KEY' }
  }

  const recipient = email.recipient.trim()

  if (!isStorableRecipient(recipient)) {
    return { ok: false, code: 'INVALID_RECIPIENT' }
  }

  const subject = email.subject.trim()

  if (
    subject.length === 0 ||
    subject.length > OUTBOX_LIMITS.maxSubjectLength ||
    containsControlCharacter(subject)
  ) {
    return { ok: false, code: 'INVALID_SUBJECT' }
  }

  if (email.html.length === 0 || email.text.length === 0) {
    return { ok: false, code: 'INVALID_CONTENT' }
  }

  // String length counts UTF-16 units, never fewer than SQLite's characters.
  const payload = JSON.stringify({
    subject,
    html: email.html,
    text: email.text,
  })

  if (payload.length > OUTBOX_LIMITS.maxPayloadLength) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE' }
  }

  return {
    ok: true,
    row: {
      dedupeKey,
      bookingId: email.bookingId,
      kind: email.kind,
      recipient,
      payload,
    },
  }
}

/**
 * The INSERT for one prepared row, for use inside a caller's D1 batch. It
 * changes 0 rows when the key already exists. `nowIso` is the batch's
 * `new Date().toISOString()`. The booking must exist (foreign key).
 */
export function outboxInsertStatement(
  db: D1Database,
  row: OutboxRow,
  nowIso: string,
): D1PreparedStatement {
  return db
    .prepare(INSERT_ROW_SQL)
    .bind(
      row.dedupeKey,
      row.bookingId,
      row.kind,
      row.recipient,
      row.payload,
      nowIso,
    )
}

/**
 * Queues one email on its own. 'duplicate' means the key was already queued
 * (or sent); the stored row is left untouched. A D1 error (for example a
 * booking id that does not exist) is thrown to the caller.
 */
export async function enqueueEmail(
  env: Env,
  email: OutboxEmail,
  nowIso: string = new Date().toISOString(),
): Promise<EnqueueResult> {
  const prepared = prepareOutboxRow(email)

  if (!prepared.ok) {
    return { status: 'invalid', code: prepared.code }
  }

  const result = await outboxInsertStatement(env.DB, prepared.row, nowIso).run()

  return {
    status: result.meta.changes === 1 ? 'queued' : 'duplicate',
    dedupeKey: prepared.row.dedupeKey,
  }
}

function readClaimedRow(value: unknown): ClaimedRow | null {
  if (!isRecord(value) || typeof value.dedupe_key !== 'string') {
    return null
  }

  return {
    dedupeKey: value.dedupe_key,
    recipient: value.recipient,
    payload: value.payload,
  }
}

function parseStoredPayload(payload: string): unknown {
  try {
    return JSON.parse(payload)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

/** The stored email of a claimed row, or null when it is unusable. */
function readStoredEmail(row: ClaimedRow): StoredEmail | null {
  if (typeof row.recipient !== 'string' || typeof row.payload !== 'string') {
    return null
  }

  const payload = parseStoredPayload(row.payload)

  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== 3 ||
    typeof payload.subject !== 'string' ||
    typeof payload.html !== 'string' ||
    typeof payload.text !== 'string'
  ) {
    return null
  }

  return {
    recipient: row.recipient,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  }
}

/** Maps a delivery result to how the row finishes. */
function toFinishOutcome(result: EmailDeliveryResult): FinishOutcome {
  switch (result.status) {
    case 'sent':
      return {
        status: 'sent',
        providerMessageId: PROVIDER_MESSAGE_ID_PATTERN.test(
          result.providerMessageId,
        )
          ? result.providerMessageId
          : null,
      }
    case 'skipped':
      return { status: 'skipped', code: result.reason }
    case 'failed':
      // A message the sender refuses will never become valid. Every other
      // failure may pass on a later attempt, and the idempotency key makes a
      // repeat safe even when the first attempt did reach Resend.
      return result.reason === 'INVALID_MESSAGE'
        ? { status: 'failed', code: result.reason }
        : { status: 'retry', code: result.reason }
  }
}

/** A result after which the rest of this tick's rows must wait. */
function haltAfter(result: EmailDeliveryResult): OutboxDrainHalt | null {
  if (result.status !== 'failed') {
    return null
  }

  if (result.reason === 'RATE_LIMITED') {
    return 'RATE_LIMITED'
  }

  return result.reason === 'INVALID_CONFIGURATION'
    ? 'INVALID_CONFIGURATION'
    : null
}

/** True when the sender made a request to Resend (so pacing applies). */
function reachedProvider(result: EmailDeliveryResult): boolean {
  if (result.status === 'sent') {
    return true
  }

  return (
    result.status === 'failed' &&
    result.reason !== 'INVALID_CONFIGURATION' &&
    result.reason !== 'INVALID_MESSAGE'
  )
}

/**
 * Waits `milliseconds` unless the signal aborts first. Resolves true when the
 * wait completed, false when it was aborted. The timer and the listener are
 * always removed.
 */
function waitUnlessAborted(
  milliseconds: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }

  if (milliseconds <= 0) {
    return Promise.resolve(true)
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, milliseconds)

    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function finishRow(
  env: Env,
  dedupeKey: string,
  claimMark: string,
  outcome: FinishOutcome,
): Promise<void> {
  await env.DB.prepare(FINISH_SQL)
    .bind(
      dedupeKey,
      new Date().toISOString(),
      outcome.status,
      outcome.status === 'sent' ? outcome.providerMessageId : null,
      outcome.status === 'sent' ? null : outcome.code,
      claimMark,
      OUTBOX_LIMITS.maxAttempts,
    )
    .run()
}

async function releaseUnsentRows(env: Env, claimMark: string): Promise<number> {
  const result = await env.DB.prepare(RELEASE_SQL)
    .bind(claimMark, new Date().toISOString())
    .run()

  return result.meta.changes
}

/**
 * One bounded drain of the outbox. Rows are claimed with the mark `nowIso`,
 * so two overlapping drains never send the same row. Throws on a D1 error;
 * even then, rows it claimed but did not finish are handed back.
 */
export async function drainOutbox(
  env: Env,
  options: OutboxDrainOptions,
): Promise<OutboxDrainSummary> {
  const now = parseInstant(options.nowIso)

  if (now === null || now.toISOString() !== options.nowIso) {
    throw new JobFailure('OUTBOX_INVALID_CLOCK')
  }

  const send = options.send ?? sendEmail
  const maxSends = Math.max(
    0,
    Math.min(
      Math.trunc(options.maxSends ?? OUTBOX_LIMITS.maxSendsPerTick),
      OUTBOX_LIMITS.maxSendsPerTick,
    ),
  )
  const claimMark = options.nowIso
  const staleClaimCutoff = addMsToInstant(now, -OUTBOX_LIMITS.staleClaimMs)
  const idempotencyHorizon = addMsToInstant(
    now,
    -OUTBOX_LIMITS.idempotencyWindowMs,
  )

  const [gaveUpResult, , claimedResult] = await env.DB.batch<unknown>([
    env.DB.prepare(GIVE_UP_SQL).bind(
      claimMark,
      staleClaimCutoff,
      idempotencyHorizon,
      OUTBOX_LIMITS.maxAttempts,
      OUTBOX_LIMITS.maxGiveUpsPerTick,
    ),
    env.DB.prepare(CLAIM_SQL).bind(
      claimMark,
      staleClaimCutoff,
      maxSends,
      OUTBOX_LIMITS.maxAttempts,
      idempotencyHorizon,
    ),
    env.DB.prepare(SELECT_CLAIMED_SQL).bind(claimMark),
  ])

  const claimedRows = (claimedResult?.results ?? [])
    .map(readClaimedRow)
    .filter((row) => row !== null)

  let sent = 0
  let skipped = 0
  let retried = 0
  let failed = 0
  let released: number
  let halt: OutboxDrainHalt | null = null
  let lastProviderCallAt: number | null = null

  try {
    for (const row of claimedRows) {
      if (options.signal.aborted) {
        halt = 'TICK_BUDGET_EXHAUSTED'
        break
      }

      const email = readStoredEmail(row)

      if (email === null) {
        await finishRow(env, row.dedupeKey, claimMark, {
          status: 'failed',
          code: 'INVALID_PAYLOAD',
        })
        failed += 1
        continue
      }

      if (lastProviderCallAt !== null) {
        const elapsed = Date.now() - lastProviderCallAt
        const paced = await waitUnlessAborted(
          OUTBOX_LIMITS.minSendIntervalMs - elapsed,
          options.signal,
        )

        if (!paced) {
          halt = 'TICK_BUDGET_EXHAUSTED'
          break
        }
      }

      const startedAt = Date.now()
      const result = await send(env, {
        to: email.recipient,
        subject: email.subject,
        html: email.html,
        text: email.text,
        idempotencyKey: row.dedupeKey,
      })

      if (reachedProvider(result)) {
        lastProviderCallAt = startedAt
      }

      const outcome = toFinishOutcome(result)

      await finishRow(env, row.dedupeKey, claimMark, outcome)

      switch (outcome.status) {
        case 'sent':
          sent += 1
          break
        case 'skipped':
          skipped += 1
          break
        case 'failed':
          failed += 1
          break
        case 'retry':
          retried += 1
          break
      }

      halt = haltAfter(result)

      if (halt !== null) {
        break
      }
    }
  } finally {
    released = await releaseUnsentRows(env, claimMark)
  }

  return {
    gaveUp: gaveUpResult?.meta.changes ?? 0,
    claimed: claimedRows.length,
    sent,
    skipped,
    retried,
    failed,
    released,
    halt,
  }
}

async function runOutboxDrainJob(context: JobContext): Promise<void> {
  const summary = await drainOutbox(context.env, {
    nowIso: context.nowIso,
    signal: context.signal,
  })

  if (summary.gaveUp > 0) {
    console.warn(`OUTBOX_GAVE_UP count=${summary.gaveUp}`)
  }

  if (summary.halt === 'INVALID_CONFIGURATION') {
    // Recorded in job_runs so the admin queue shows it.
    throw new JobFailure('EMAIL_INVALID_CONFIGURATION')
  }

  if (summary.halt !== null) {
    console.warn(
      `OUTBOX_DRAIN_HALTED code=${summary.halt} released=${summary.released}`,
    )
  }
}

/** Registered last in the quarter-hourly group of worker/jobs/registry.ts. */
export const outboxDrainJob: ScheduledJob = {
  name: 'outbox-drain',
  schedule: 'quarter-hourly',
  run: runOutboxDrainJob,
}
