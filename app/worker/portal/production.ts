import {
  PRODUCTION_BODY_KEYS,
  PRODUCTION_BODY_MAX_BYTES,
  hasEventDayPassed,
  isProductionStage,
  type AdminProductionResponse,
  type ProductionStage,
  type ProductionStatus,
} from '../../shared/portal/production.js'
import { riyadhTodayKey } from '../../shared/timing.js'
import { renderAlbumReadyEmail } from '../emails/album.js'
import { errorResponse, jsonResponse } from '../http.js'
import { prepareOutboxRow, type OutboxRow } from '../notify/outbox.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import { isEmailConfigured } from '../settings/features.js'
import type { AdminPortalContext } from './admin-portal-routes.js'
import { readJsonBody } from './request.js'

/**
 * Album production status (plan 11 §3.2 #23, §3.3 #23), on the path
 * `/api/admin/bookings/{bookingId}/production` (decision D1: no
 * private-media word, so it is open while private media is gated). Auth AD
 * is applied by the admin dispatcher before these handlers run.
 *
 * PUT `{ "stage" }` (stage enum, exact key set, 256-byte cap) sets the stage
 * of a `confirmed` booking whose event day has passed in Riyadh
 * (shared/portal/production.ts hasEventDayPassed; else 409
 * EVENT_NOT_YET_HELD). One D1 batch, every rule inside the writing statement
 * (SB-5):
 * 1. the write: the first stage is an INSERT … SELECT from the booking, a
 *    later one an UPDATE that is also a compare-and-swap on the stage read
 *    before it; both repeat the confirmed and event-passed conditions, with
 *    the server's Riyadh date key;
 * 2. `booking_events('album_stage_changed', {"from","to"})`, only when the
 *    write changed its one row (changes() = 1);
 * 3. moving to `ready` while email is configured (EM) and she has a
 *    verified, not-erased address: the `album_ready` email into the outbox
 *    under `album_ready:<bookingId>:once`, again only after the event row,
 *    so it is queued once per booking, ever (ON CONFLICT DO NOTHING), even
 *    if the stage later goes back and returns to `ready`.
 * Asking for the stage the booking already has is a no-op that answers 200
 * and records nothing. A write that changed nothing (a concurrent change,
 * a status change) is classified again from a fresh read.
 *
 * GET answers the stored stage or null, behind the admin read burst limit
 * (RL_ADMIN_READ). Foreign and unknown booking ids answer the same 404
 * BOOKING_NOT_FOUND. Logs carry fixed codes only: never ids, addresses or
 * names.
 */

/** decodePathParameters already refuses control characters and bad escapes. */
const MAXIMUM_BOOKING_ID_LENGTH = 128

// ?1 booking id
const READ_STATUS_SQL = `
  SELECT
    b.status AS status,
    b.event_date AS eventDate,
    ap.stage AS stage,
    ap.updated_at AS updatedAt
  FROM booking_requests AS b
  LEFT JOIN album_production AS ap ON ap.booking_id = b.id
  WHERE b.id = ?1
`

// The same, with what the album_ready email needs. The address only when
// the Worker took it from a verified token and the account is not erased.
// ?1 booking id
const READ_FOR_UPDATE_SQL = `
  SELECT
    b.status AS status,
    b.event_date AS eventDate,
    ap.stage AS stage,
    ap.updated_at AS updatedAt,
    CASE WHEN u.erased_at IS NULL AND u.email_verified_at IS NOT NULL THEN u.email END AS customerEmail,
    CASE WHEN u.erased_at IS NULL THEN u.first_name END AS customerFirstName
  FROM booking_requests AS b
  LEFT JOIN album_production AS ap ON ap.booking_id = b.id
  LEFT JOIN users AS u ON u.id = b.user_id
  WHERE b.id = ?1
`

// First stage. ?1 booking id | ?2 stage | ?3 now | ?4 Riyadh today key
const INSERT_STAGE_SQL = `
  INSERT INTO album_production (booking_id, stage, created_at, updated_at)
  SELECT b.id, ?2, ?3, ?3
  FROM booking_requests AS b
  WHERE b.id = ?1
    AND b.status = 'confirmed'
    AND b.event_date < ?4
  ON CONFLICT (booking_id) DO NOTHING
`

// Later stage, compare-and-swap on the stage read before.
// ?1 booking id | ?2 stage | ?3 now | ?4 Riyadh today key | ?5 stage read
const UPDATE_STAGE_SQL = `
  UPDATE album_production
  SET stage = ?2,
      updated_at = ?3
  WHERE booking_id = ?1
    AND stage = ?5
    AND stage <> ?2
    AND EXISTS (
      SELECT 1
      FROM booking_requests AS b
      WHERE b.id = ?1
        AND b.status = 'confirmed'
        AND b.event_date < ?4
    )
`

// Only after the write changed its one row.
// ?1 booking id | ?2 admin uid | ?3 from (NULL for the first stage) | ?4 to | ?5 now
const INSERT_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, created_at)
  SELECT ?1, 'admin', ?2, 'album_stage_changed', json_object('from', ?3, 'to', ?4), ?5
  WHERE changes() = 1
`

// Only after the event row, and only while the album is ready. Binds the
// prepareOutboxRow() fields. ?1 dedupe key | ?2 booking id | ?3 kind |
// ?4 recipient | ?5 payload | ?6 now
const QUEUE_ALBUM_READY_SQL = `
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
  SELECT ?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6
  WHERE changes() = 1
    AND EXISTS (
      SELECT 1
      FROM album_production AS ap
      WHERE ap.booking_id = ?2
        AND ap.stage = 'ready'
    )
  ON CONFLICT (dedupe_key) DO NOTHING
`

/** One booking as READ_STATUS_SQL returns it, still unchecked. */
interface StatusRow {
  readonly status: unknown
  readonly eventDate: unknown
  readonly stage: unknown
  readonly updatedAt: unknown
}

interface UpdateRow extends StatusRow {
  readonly customerEmail: unknown
  readonly customerFirstName: unknown
}

/** A booking's state as the rules read it. */
interface BookingProductionState {
  readonly status: string
  readonly eventDate: string
  readonly production: ProductionStatus | null
}

type StateCheck =
  | { readonly kind: 'writable'; readonly current: ProductionStatus | null }
  | { readonly kind: 'unchanged'; readonly current: ProductionStatus }
  | { readonly kind: 'refused'; readonly response: Response }

function bookingNotFoundResponse(): Response {
  return errorResponse(404, 'BOOKING_NOT_FOUND', 'لم يتم العثور على طلب الحجز.')
}

function invalidBodyResponse(): Response {
  return errorResponse(400, 'INVALID_REQUEST_BODY', 'بيانات الطلب غير صحيحة.')
}

function bookingNotConfirmedResponse(): Response {
  return errorResponse(
    409,
    'BOOKING_NOT_CONFIRMED',
    'لا يمكن تحديث حالة الألبوم قبل تأكيد الحجز.',
  )
}

function eventNotYetHeldResponse(): Response {
  return errorResponse(409, 'EVENT_NOT_YET_HELD', 'لم يحن موعد المناسبة بعد.')
}

function stageChangedResponse(): Response {
  return errorResponse(
    409,
    'PRODUCTION_STAGE_CHANGED',
    'تغيّرت حالة الألبوم أثناء الحفظ. حدّثي الصفحة ثم أعيدي المحاولة.',
  )
}

function productionResponse(production: ProductionStatus | null): Response {
  const body: AdminProductionResponse = { ok: true, production }

  return jsonResponse(body)
}

function readBookingId(context: AdminPortalContext): string | null {
  const bookingId = context.params.bookingId

  return typeof bookingId === 'string' &&
    bookingId.length > 0 &&
    bookingId.length <= MAXIMUM_BOOKING_ID_LENGTH
    ? bookingId
    : null
}

/**
 * The stored production row, or null when there is none. A row the schema
 * would never hold (it CHECKs both columns) is an invariant breach, thrown.
 */
function toProductionStatus(row: StatusRow): ProductionStatus | null {
  if (row.stage === null && row.updatedAt === null) {
    return null
  }

  if (!isProductionStage(row.stage) || typeof row.updatedAt !== 'string') {
    throw new TypeError('PRODUCTION_ROW_INVALID')
  }

  return { stage: row.stage, updatedAt: row.updatedAt }
}

function toBookingState(row: StatusRow): BookingProductionState {
  if (typeof row.status !== 'string' || typeof row.eventDate !== 'string') {
    throw new TypeError('PRODUCTION_BOOKING_ROW_INVALID')
  }

  return {
    status: row.status,
    eventDate: row.eventDate,
    production: toProductionStatus(row),
  }
}

/** The rules of #23, in the contract's order, for one requested stage. */
function checkState(
  state: BookingProductionState,
  requested: ProductionStage,
  todayKey: string,
): StateCheck {
  if (state.status !== 'confirmed') {
    return { kind: 'refused', response: bookingNotConfirmedResponse() }
  }

  if (!hasEventDayPassed(state.eventDate, todayKey)) {
    return { kind: 'refused', response: eventNotYetHeldResponse() }
  }

  if (state.production?.stage === requested) {
    return { kind: 'unchanged', current: state.production }
  }

  return { kind: 'writable', current: state.production }
}

async function readStatus(
  env: Env,
  bookingId: string,
): Promise<BookingProductionState | null> {
  const row = await env.DB.prepare(READ_STATUS_SQL)
    .bind(bookingId)
    .first<StatusRow>()

  return row === null ? null : toBookingState(row)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The album_ready outbox row, or null when none is to be queued: another
 * stage, email not configured (EM off), no verified address, or a row the
 * outbox refuses (logged by its fixed code).
 */
function albumReadyOutboxRow(
  env: Env,
  bookingId: string,
  eventDate: string,
  row: UpdateRow,
): OutboxRow | null {
  if (!isEmailConfigured(env)) {
    return null
  }

  const recipient = nullableString(row.customerEmail)

  if (recipient === null) {
    console.warn('ALBUM_READY_NOT_QUEUED code=NO_RECIPIENT')
    return null
  }

  const template = renderAlbumReadyEmail({
    customerFirstName: nullableString(row.customerFirstName) ?? '',
    bookingId,
    eventDate,
    appBaseUrl: env.APP_BASE_URL,
  })
  const prepared = prepareOutboxRow({
    ...template,
    kind: 'album_ready',
    bookingId,
    anchor: 'once',
    recipient,
  })

  if (!prepared.ok) {
    console.warn(`ALBUM_READY_NOT_QUEUED code=${prepared.code}`)
    return null
  }

  return prepared.row
}

/** GET …/production (AD): the stored stage, or null. */
export async function handleGetProduction(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin } = context

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const bookingId = readBookingId(context)

  if (bookingId === null) {
    return bookingNotFoundResponse()
  }

  const state = await readStatus(env, bookingId)

  return state === null
    ? bookingNotFoundResponse()
    : productionResponse(state.production)
}

/** PUT …/production (AD): `{ "stage" }`. */
export async function handlePutProduction(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin, request } = context
  const bookingId = readBookingId(context)

  if (bookingId === null) {
    return bookingNotFoundResponse()
  }

  const body = await readJsonBody(request, {
    maxBytes: PRODUCTION_BODY_MAX_BYTES,
    requiredKeys: PRODUCTION_BODY_KEYS,
  })

  if (!body.ok) {
    return body.response
  }

  const requested = body.body.stage

  if (!isProductionStage(requested)) {
    return invalidBodyResponse()
  }

  const now = new Date()
  const nowIso = now.toISOString()
  const todayKey = riyadhTodayKey(now)
  const row = await env.DB.prepare(READ_FOR_UPDATE_SQL)
    .bind(bookingId)
    .first<UpdateRow>()

  if (row === null) {
    return bookingNotFoundResponse()
  }

  const state = toBookingState(row)
  const check = checkState(state, requested, todayKey)

  if (check.kind === 'refused') {
    return check.response
  }

  if (check.kind === 'unchanged') {
    return productionResponse(check.current)
  }

  const from = check.current?.stage ?? null
  const write =
    from === null
      ? env.DB.prepare(INSERT_STAGE_SQL).bind(
          bookingId,
          requested,
          nowIso,
          todayKey,
        )
      : env.DB.prepare(UPDATE_STAGE_SQL).bind(
          bookingId,
          requested,
          nowIso,
          todayKey,
          from,
        )
  const statements: D1PreparedStatement[] = [
    write,
    env.DB.prepare(INSERT_EVENT_SQL).bind(
      bookingId,
      admin.uid,
      from,
      requested,
      nowIso,
    ),
  ]
  const email =
    requested === 'ready'
      ? albumReadyOutboxRow(env, bookingId, state.eventDate, row)
      : null

  if (email !== null) {
    statements.push(
      env.DB.prepare(QUEUE_ALBUM_READY_SQL).bind(
        email.dedupeKey,
        email.bookingId,
        email.kind,
        email.recipient,
        email.payload,
        nowIso,
      ),
    )
  }

  const results = await env.DB.batch(statements)

  if (results[0]?.meta.changes === 1) {
    if (results[1]?.meta.changes !== 1) {
      // Unreachable: the event row follows its write in the same batch.
      throw new Error('PRODUCTION_EVENT_NOT_RECORDED')
    }

    return productionResponse({ stage: requested, updatedAt: nowIso })
  }

  // The write's own conditions refused it: say why, from a fresh read.
  const latest = await readStatus(env, bookingId)

  if (latest === null) {
    return bookingNotFoundResponse()
  }

  const recheck = checkState(latest, requested, todayKey)

  switch (recheck.kind) {
    case 'refused':
      return recheck.response
    case 'unchanged':
      return productionResponse(recheck.current)
    case 'writable':
      return stageChangedResponse()
  }
}
