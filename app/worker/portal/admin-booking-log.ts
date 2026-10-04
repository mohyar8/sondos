import { bookingStatuses, type BookingStatus } from '../../shared/admin.js'
import { isAuditInstant } from '../../shared/audit.js'
import { errorResponse, jsonResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import type { AdminPortalContext } from './admin-portal-routes.js'
import { readJsonBody } from './request.js'

/**
 * The admin booking timeline and contact log (plan 11 §3.2 #20, #21; §3.3;
 * UX-06, SB-2, SB-7, SB-13). Both routes sit behind the admin guard of
 * admin-portal-routes.ts (AD), so only the one admin reaches them; the
 * handlers add nothing to the guard and never log anything.
 *
 * GET `bookings/{id}/timeline`: newest first, at most TIMELINE_MAX_ENTRIES,
 * merged from three sources, each read with explicit columns only:
 * - booking_status_history: from, to, who (customer, admin or system; never
 *   a uid) and the note;
 * - booking_events: actor, event, subject id, the details through the key
 *   allowlist below (anything else in the stored JSON is dropped), and the
 *   note unless the row was redacted (then `note` is null and `redacted`
 *   true; the DB CHECK already keeps a redacted row's note NULL);
 * - notification_log: kind, status, created and finished instants. The
 *   recipient and the payload are never selected, so no address or email
 *   body can reach the answer (the terminal rows no longer hold them anyway).
 *
 * POST `bookings/{id}/contact-log`: body exactly `{ template, outcome }`.
 * The template id comes from the closed list the admin's WhatsApp messages
 * use (W2-14); the outcome maps to one booking_events kind:
 * opened → admin_whatsapp_opened, sent → admin_whatsapp_sent, dismissed →
 * admin_queue_dismissed, with details `{"template"}` and nothing else. An
 * `opened` row never takes an item off the work queue; only `sent`,
 * `dismissed` or a state change do (UX-06, W2-10). The INSERT carries its own
 * cap (CONTACT_LOG_MAX_PER_HOUR rows per booking within an hour), because
 * booking_events is append-only and a runaway client or a stolen session
 * must not be able to fill it; the row's created_at is SQLite's clock.
 */

/** #20: the most entries one timeline answer holds. */
export const TIMELINE_MAX_ENTRIES = 300

/** #21: contact-log rows one booking may gain within CONTACT_LOG_WINDOW_SECONDS. */
export const CONTACT_LOG_MAX_PER_HOUR = 30
const CONTACT_LOG_WINDOW_SECONDS = 60 * 60
/** #21: `{"template":"event_details_request","outcome":"dismissed"}` is 60 bytes. */
const CONTACT_LOG_BODY_MAX_BYTES = 256

/**
 * The closed list of admin-to-customer WhatsApp template ids (W2-14,
 * src/features/admin-contact/whatsapp-templates.ts). The Worker cannot
 * import the SPA module, so the list is repeated here; a test keeps the two
 * equal once both exist. Only these ids are ever stored.
 */
export const adminContactTemplateIds = [
  'request_received',
  'approved_online',
  'approved_legacy',
  'hold_reminder',
  'terms_reminder',
  'deposit_recorded',
  'event_details_request',
  'event_reminder',
  'production_update',
  'album_ready',
  'handover_confirmation',
  'handover_day',
  'feedback_request',
  'offline_selection',
] as const

export type AdminContactTemplateId = (typeof adminContactTemplateIds)[number]

/** #21 outcomes and the booking_events kind each one writes. */
export const contactLogEventByOutcome = Object.freeze({
  opened: 'admin_whatsapp_opened',
  sent: 'admin_whatsapp_sent',
  dismissed: 'admin_queue_dismissed',
} as const)

export type ContactLogOutcome = keyof typeof contactLogEventByOutcome

const templateIdSet: ReadonlySet<string> = new Set(adminContactTemplateIds)
const bookingStatusSet: ReadonlySet<string> = new Set(bookingStatuses)
const eventActors = ['customer', 'admin', 'system'] as const
const notificationStatuses = [
  'pending',
  'sending',
  'sent',
  'skipped',
  'failed',
  'superseded',
] as const

type EventActor = (typeof eventActors)[number]
type NotificationStatus = (typeof notificationStatuses)[number]
type StatusChangedBy = 'customer' | 'admin' | 'system'

export function isAdminContactTemplateId(
  value: unknown,
): value is AdminContactTemplateId {
  return typeof value === 'string' && templateIdSet.has(value)
}

export function isContactLogOutcome(
  value: unknown,
): value is ContactLogOutcome {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(contactLogEventByOutcome, value)
  )
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && bookingStatusSet.has(value)
}

function isEventActor(value: unknown): value is EventActor {
  return eventActors.some((actor) => actor === value)
}

function isNotificationStatus(value: unknown): value is NotificationStatus {
  return notificationStatuses.some((status) => status === value)
}

// ---------------------------------------------------------------------------
// Details allowlist (SB-13)
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A fixed code: a status, a stage, a channel, a method, a field name. */
const CODE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/
const TERMS_VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MAXIMUM_DETAIL_NUMBER = 1_000_000
const MAXIMUM_DETAIL_LIST_LENGTH = 10

type DetailValue = string | number | boolean | readonly string[]
type DetailGuard = (value: unknown) => value is DetailValue

function isCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isDetailNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAXIMUM_DETAIL_NUMBER
  )
}

function isCodeList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAXIMUM_DETAIL_LIST_LENGTH &&
    value.every(isCode)
  )
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function matches(pattern: RegExp): DetailGuard {
  return (value: unknown): value is string =>
    typeof value === 'string' && pattern.test(value)
}

/**
 * The only booking_events details keys the timeline returns, each with the
 * one shape it may have: ids, counts and amounts, instants, versions, hashes
 * and fixed codes. None of them can carry free text (a code has no spaces
 * and at most 40 characters), so a name, phone number, address or note that
 * a writer put into details by mistake never reaches the answer.
 */
const detailGuards: ReadonlyMap<string, DetailGuard> = new Map<
  string,
  DetailGuard
>([
  ['template', isAdminContactTemplateId],
  ['from', isCode],
  ['to', isCode],
  ['fromStatus', isBookingStatus],
  ['toStatus', isBookingStatus],
  ['stage', isCode],
  ['channel', isCode],
  ['method', isCode],
  ['changed', isCodeList],
  ['amount', isDetailNumber],
  ['extendHours', isDetailNumber],
  ['hours', isDetailNumber],
  ['count', isDetailNumber],
  ['photos', isDetailNumber],
  ['receipts', isDetailNumber],
  ['attemptNo', isDetailNumber],
  ['rating', isDetailNumber],
  ['protected', isBoolean],
  ['termsVersion', matches(TERMS_VERSION_PATTERN)],
  ['bodySha256', matches(SHA256_PATTERN)],
  ['holdExpiresAt', isAuditInstant],
  ['previousHoldExpiresAt', isAuditInstant],
  ['startsAt', isAuditInstant],
  ['endsAt', isAuditInstant],
  ['deadline', isAuditInstant],
  ['receiptId', isUuid],
  ['slotId', isUuid],
  ['galleryId', isUuid],
  ['areaId', isUuid],
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The allowlisted part of a stored details JSON, or null when nothing is
 * left (or the text is not a JSON object, which the DB CHECK refuses).
 */
export function filterEventDetails(
  stored: unknown,
): Readonly<Record<string, DetailValue>> | null {
  if (typeof stored !== 'string') {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(stored)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }

  if (!isPlainObject(parsed)) {
    return null
  }

  const kept: [string, DetailValue][] = []

  for (const key of Object.keys(parsed)) {
    const guard = detailGuards.get(key)
    const value = parsed[key]

    if (guard?.(value)) {
      kept.push([key, value])
    }
  }

  return kept.length === 0 ? null : Object.fromEntries(kept)
}

// ---------------------------------------------------------------------------
// Timeline (#20)
// ---------------------------------------------------------------------------

export interface TimelineStatusEntry {
  readonly source: 'status'
  readonly at: string
  readonly id: number
  readonly fromStatus: BookingStatus | null
  readonly toStatus: BookingStatus | null
  readonly by: StatusChangedBy
  readonly note: string | null
}

export interface TimelineEventEntry {
  readonly source: 'event'
  readonly at: string
  readonly id: number
  readonly actor: EventActor
  readonly event: string
  readonly subjectId: string | null
  readonly details: Readonly<Record<string, DetailValue>> | null
  readonly note: string | null
  readonly redacted: boolean
}

export interface TimelineNotificationEntry {
  readonly source: 'notification'
  readonly at: string
  readonly kind: string
  readonly status: NotificationStatus
  readonly finishedAt: string | null
}

export type TimelineEntry =
  | TimelineStatusEntry
  | TimelineEventEntry
  | TimelineNotificationEntry

interface BookingOwnerRow {
  readonly userId: unknown
}

/** A row as D1 returns it: every column still untrusted. */
type StoredRow = Readonly<Record<string, unknown>>

/** Every SQL text of this module, fixed; every value is bound (SB-4). */
export const BOOKING_LOG_SQL = Object.freeze({
  bookingOwner: `
    SELECT user_id AS userId
    FROM booking_requests
    WHERE id = ?
    LIMIT 1
  `,
  statusHistory: `
    SELECT
      id,
      from_status AS fromStatus,
      to_status AS toStatus,
      changed_by AS changedBy,
      note,
      created_at AS createdAt
    FROM booking_status_history
    WHERE booking_id = ?
    ORDER BY id DESC
    LIMIT ?
  `,
  events: `
    SELECT
      id,
      actor,
      event,
      subject_id AS subjectId,
      details,
      CASE WHEN redacted_at IS NULL THEN note END AS note,
      redacted_at AS redactedAt,
      created_at AS createdAt
    FROM booking_events
    WHERE booking_id = ?
    ORDER BY id DESC
    LIMIT ?
  `,
  // recipient and payload are deliberately absent (SB-13).
  notifications: `
    SELECT
      kind,
      status,
      created_at AS createdAt,
      finished_at AS finishedAt
    FROM notification_log
    WHERE booking_id = ?
    ORDER BY created_at DESC, dedupe_key DESC
    LIMIT ?
  `,
  /**
   * One contact-log row, only for an existing booking and while fewer than
   * the cap were written for it within the window (created_at is always a
   * toISOString() instant, so the text comparison is exact). Binds: actor
   * uid, event kind, template, booking id, booking id, window modifier, cap.
   */
  insertContactLog: `
    INSERT INTO booking_events (
      booking_id,
      actor,
      actor_uid,
      event,
      details,
      created_at
    )
    SELECT
      b.id,
      'admin',
      ?,
      ?,
      json_object('template', ?),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM booking_requests AS b
    WHERE b.id = ?
      AND (
        SELECT COUNT(*)
        FROM booking_events AS e
        WHERE e.booking_id = ?
          AND e.event IN (
            'admin_whatsapp_opened',
            'admin_whatsapp_sent',
            'admin_queue_dismissed'
          )
          AND e.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
      ) < ?
    RETURNING created_at AS recordedAt
  `,
})

/** SQLite's CURRENT_TIMESTAMP text, as legacy rows of 0003 may hold it. */
const SQLITE_TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/

/**
 * A stored instant as a toISOString() instant: the current form as it is, a
 * legacy `YYYY-MM-DD HH:MM:SS` (UTC) with `T`, `.000` and `Z`. null for
 * anything else.
 */
function toInstant(value: unknown): string | null {
  if (isAuditInstant(value)) {
    return value
  }

  if (typeof value !== 'string') {
    return null
  }

  const legacy = SQLITE_TIMESTAMP_PATTERN.exec(value)
  const candidate = legacy ? `${legacy[1]}T${legacy[2]}.000Z` : null

  return isAuditInstant(candidate) ? candidate : null
}

function toRowId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

function toNote(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function changedByRole(changedBy: unknown, ownerId: unknown): StatusChangedBy {
  if (changedBy === null || changedBy === undefined) {
    return 'system'
  }

  return changedBy === ownerId ? 'customer' : 'admin'
}

function toStatusEntry(
  row: StoredRow,
  ownerId: unknown,
): TimelineStatusEntry | null {
  const id = toRowId(row.id)
  const at = toInstant(row.createdAt)

  if (id === null || at === null) {
    return null
  }

  return {
    source: 'status',
    at,
    id,
    fromStatus: isBookingStatus(row.fromStatus) ? row.fromStatus : null,
    toStatus: isBookingStatus(row.toStatus) ? row.toStatus : null,
    by: changedByRole(row.changedBy, ownerId),
    note: toNote(row.note),
  }
}

function toEventEntry(row: StoredRow): TimelineEventEntry | null {
  const id = toRowId(row.id)
  const at = toInstant(row.createdAt)

  if (id === null || at === null || !isEventActor(row.actor) || !isCode(row.event)) {
    return null
  }

  const redacted = row.redactedAt !== null && row.redactedAt !== undefined

  return {
    source: 'event',
    at,
    id,
    actor: row.actor,
    event: row.event,
    subjectId: isUuid(row.subjectId) ? row.subjectId : null,
    details: filterEventDetails(row.details),
    note: redacted ? null : toNote(row.note),
    redacted,
  }
}

function toNotificationEntry(
  row: StoredRow,
): TimelineNotificationEntry | null {
  const at = toInstant(row.createdAt)

  if (at === null || !isCode(row.kind) || !isNotificationStatus(row.status)) {
    return null
  }

  return {
    source: 'notification',
    at,
    kind: row.kind,
    status: row.status,
    finishedAt: toInstant(row.finishedAt),
  }
}

const sourceOrder: Readonly<Record<TimelineEntry['source'], number>> = {
  status: 0,
  event: 1,
  notification: 2,
}

/** Newest first; at the same instant: status, event, notification, then the higher id. */
function compareNewestFirst(left: TimelineEntry, right: TimelineEntry): number {
  if (left.at !== right.at) {
    return left.at < right.at ? 1 : -1
  }

  if (left.source !== right.source) {
    return sourceOrder[left.source] - sourceOrder[right.source]
  }

  const leftId = left.source === 'notification' ? 0 : left.id
  const rightId = right.source === 'notification' ? 0 : right.id

  return rightId - leftId
}

/**
 * Merges already-mapped entries of the three sources into one list, newest
 * first, at most TIMELINE_MAX_ENTRIES long.
 */
export function mergeTimeline(
  entries: readonly TimelineEntry[],
): TimelineEntry[] {
  return [...entries].sort(compareNewestFirst).slice(0, TIMELINE_MAX_ENTRIES)
}

function keepMapped<Row, Entry>(
  rows: readonly Row[],
  map: (row: Row) => Entry | null,
): Entry[] {
  const entries: Entry[] = []

  for (const row of rows) {
    const entry = map(row)

    if (entry !== null) {
      entries.push(entry)
    }
  }

  return entries
}

function bookingNotFoundResponse(): Response {
  return errorResponse(
    404,
    'BOOKING_NOT_FOUND',
    'لم يتم العثور على طلب الحجز.',
  )
}

/** GET /api/admin/bookings/{bookingId}/timeline (#20; AD). */
export async function handleAdminTimeline(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin, params } = context

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const bookingId = params.bookingId

  if (bookingId === undefined) {
    return bookingNotFoundResponse()
  }

  const owner = await env.DB.prepare(BOOKING_LOG_SQL.bookingOwner)
    .bind(bookingId)
    .first<BookingOwnerRow>()

  if (owner === null) {
    return bookingNotFoundResponse()
  }

  // Each source is read newest first up to the answer's cap, so the merge
  // below can never miss an entry that belongs in the newest 300.
  const [history, events, notifications] = await env.DB.batch<StoredRow>([
    env.DB.prepare(BOOKING_LOG_SQL.statusHistory).bind(
      bookingId,
      TIMELINE_MAX_ENTRIES,
    ),
    env.DB.prepare(BOOKING_LOG_SQL.events).bind(bookingId, TIMELINE_MAX_ENTRIES),
    env.DB.prepare(BOOKING_LOG_SQL.notifications).bind(
      bookingId,
      TIMELINE_MAX_ENTRIES,
    ),
  ])

  const entries = mergeTimeline([
    ...keepMapped<StoredRow, TimelineEntry>(
      history?.results ?? [],
      (row) => toStatusEntry(row, owner.userId),
    ),
    ...keepMapped<StoredRow, TimelineEntry>(events?.results ?? [], toEventEntry),
    ...keepMapped<StoredRow, TimelineEntry>(
      notifications?.results ?? [],
      toNotificationEntry,
    ),
  ])

  return jsonResponse({ ok: true, entries })
}

// ---------------------------------------------------------------------------
// Contact log (#21)
// ---------------------------------------------------------------------------

interface ContactLogInsertRow {
  readonly recordedAt: unknown
}

/** POST /api/admin/bookings/{bookingId}/contact-log (#21; AD). */
export async function handleAdminContactLog(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin, params, request } = context
  const bookingId = params.bookingId

  if (bookingId === undefined) {
    return bookingNotFoundResponse()
  }

  const body = await readJsonBody(request, {
    maxBytes: CONTACT_LOG_BODY_MAX_BYTES,
    requiredKeys: ['template', 'outcome'],
  })

  if (!body.ok) {
    return body.response
  }

  const { template, outcome } = body.body

  if (!isAdminContactTemplateId(template) || !isContactLogOutcome(outcome)) {
    return errorResponse(
      400,
      'INVALID_REQUEST_BODY',
      'بيانات الطلب غير صحيحة.',
    )
  }

  const event = contactLogEventByOutcome[outcome]
  const inserted = await env.DB.prepare(BOOKING_LOG_SQL.insertContactLog)
    .bind(
      admin.uid,
      event,
      template,
      bookingId,
      bookingId,
      `-${CONTACT_LOG_WINDOW_SECONDS} seconds`,
      CONTACT_LOG_MAX_PER_HOUR,
    )
    .first<ContactLogInsertRow>()

  if (inserted === null) {
    // Nothing written: either no such booking, or the cap refused the row.
    const owner = await env.DB.prepare(BOOKING_LOG_SQL.bookingOwner)
      .bind(bookingId)
      .first<BookingOwnerRow>()

    return owner === null
      ? bookingNotFoundResponse()
      : rateLimitedResponse(CONTACT_LOG_WINDOW_SECONDS)
  }

  const recordedAt = toInstant(inserted.recordedAt)

  if (recordedAt === null) {
    throw new Error('CONTACT_LOG_TIMESTAMP_INVALID')
  }

  return jsonResponse({
    ok: true,
    contact: {
      event,
      template,
      outcome,
      recordedAt,
    },
  })
}
