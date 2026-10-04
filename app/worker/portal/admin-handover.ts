import { bookingStatuses, type BookingStatus } from '../../shared/admin.js'
import {
  ADMIN_HANDOVER_BODY_MAX_BYTES,
  ADMIN_HANDOVER_BODY_OPTIONAL_KEYS,
  ADMIN_HANDOVER_BODY_REQUIRED_KEYS,
  isCanonicalInstant,
  isHandoverMethod,
  isHandoverSlotId,
  isHandoverSlotMethod,
  isHandoverStatus,
  parseAdminHandoverCommand,
  slotAcceptsMethod,
  type AdminHandover,
  type AdminHandoverCommand,
  type AdminHandoverResponse,
  type HandoverStatus,
} from '../../shared/portal/handover.js'
import { riyadhDateKey } from '../../shared/timing.js'
import { errorResponse, jsonResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import {
  handoverInputErrorResponse,
  readSlotRow,
  slotNotFoundResponse,
} from './admin-handover-slots.js'
import type { AdminPortalContext } from './admin-portal-routes.js'
import { readJsonBody } from './request.js'

/**
 * One booking's handover, for the admin (plan 11 §3.2 #24, §3.3 #24; TM-15;
 * SB-4, SB-5, SB-10). Auth AD (the admin dispatcher's guard), gate 'open'.
 *
 * - GET   bookings/{id}/handover: the booking's id, status and completedAt
 *   and its handover (null before she books one), with the delivery
 *   address for a delivery. Burst-limited per admin (RL_ADMIN_READ).
 * - PATCH bookings/{id}/handover:
 *   - `complete`: a scheduled handover of a confirmed booking →
 *     `completed`, stamping handovers.completed_at AND
 *     booking_requests.completed_at with the same instant in ONE batch,
 *     with the `handover_completed` and `booking_completed` events. A
 *     repeat is a no-op (200, nothing written).
 *   - `no_show`: a scheduled handover whose slot has started → `no_show`
 *     (`handover_no_show`); she can then book again, or the admin
 *     reassigns her.
 *   - `cancel`: a scheduled or missed handover → `cancelled`
 *     (`handover_cancelled`); its place in the slot is freed.
 *   - `reassign` + slotId: a handover that is not completed, of a confirmed
 *     booking, moves to an active, future, method-compatible slot and is
 *     scheduled again (`handover_rescheduled`). The capacity count sits
 *     inside the UPDATE and excludes the booking's own row (TM-15), and the
 *     UPDATE is a compare-and-swap on the slot and status it read, so the
 *     event's `fromSlotId` is the slot it really left.
 *
 * Every write is one conditional statement and a compare-and-swap on the
 * handover status it read, so an event's `fromStatus` is the status it
 * really left; its booking_events row follows
 * it in the same batch and is written only when that statement changed
 * exactly one row (the `CASE WHEN changes() = 1` guard of
 * worker/audit/admin-audit.ts: a second changed row fails NOT NULL and
 * rolls the batch back). The events carry the admin's uid (actor 'admin'),
 * ids and statuses only, and SQLite stamps their created_at (SB-10).
 * Nothing is decided from a pre-read: when a write changes nothing, the
 * state is read afterwards only to choose the answer.
 */

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** The same body as worker/admin.ts and owned-booking.ts. */
function bookingNotFoundResponse(): Response {
  return errorResponse(404, 'BOOKING_NOT_FOUND', 'لم يتم العثور على طلب الحجز.')
}

function handoverNotFoundResponse(): Response {
  return errorResponse(
    404,
    'HANDOVER_NOT_FOUND',
    'لم تحجز العروس موعدًا لتسليم الألبوم بعد.',
  )
}

function bookingNotConfirmedResponse(): Response {
  return errorResponse(
    409,
    'BOOKING_NOT_CONFIRMED',
    'هذا الحجز غير مؤكد، فلا يمكن إتمام التسليم أو تغيير موعده.',
  )
}

function handoverAlreadyCompletedResponse(): Response {
  return errorResponse(
    409,
    'HANDOVER_ALREADY_COMPLETED',
    'تم تسليم الألبوم لهذا الحجز، ولا يمكن تعديل موعد التسليم.',
  )
}

function handoverNotScheduledResponse(): Response {
  return errorResponse(
    409,
    'HANDOVER_NOT_SCHEDULED',
    'لا يوجد موعد تسليم قائم لهذا الحجز حاليًا. اختاري موعدًا جديدًا أولًا.',
  )
}

function handoverNotDueResponse(): Response {
  return errorResponse(
    409,
    'HANDOVER_NOT_DUE',
    'لم يبدأ موعد التسليم بعد، فلا يمكن تسجيل عدم الحضور.',
  )
}

/** 08-copy-ar.md §6.5, reused verbatim (11 §3.1). */
function slotUnavailableResponse(): Response {
  return errorResponse(
    409,
    'SLOT_UNAVAILABLE',
    'هذا الموعد لم يعد متاحًا، يرجى اختيار موعد آخر.',
  )
}

function slotFullResponse(): Response {
  return errorResponse(
    409,
    'SLOT_FULL',
    'اكتمل عدد الحجوزات في هذا الموعد. اختاري موعدًا آخر أو زيدي عدد المواعيد المتاحة فيه.',
  )
}

function handoverChangedResponse(): Response {
  return errorResponse(
    409,
    'HANDOVER_CHANGED',
    'تغيّرت بيانات موعد التسليم أثناء الحفظ. حدّثي الصفحة ثم أعيدي المحاولة.',
  )
}

// ---------------------------------------------------------------------------
// Reading the booking and its handover
// ---------------------------------------------------------------------------

// ?1 booking id
const SELECT_HANDOVER_SQL = `
  SELECT
    b.id AS bookingId,
    b.status AS bookingStatus,
    b.completed_at AS bookingCompletedAt,
    h.booking_id AS handoverBookingId,
    h.slot_id AS slotId,
    h.method AS method,
    h.status AS status,
    h.delivery_area_id AS deliveryAreaId,
    h.delivery_city AS deliveryCity,
    h.delivery_district AS deliveryDistrict,
    h.delivery_street AS deliveryStreet,
    h.delivery_landmark AS deliveryLandmark,
    h.delivery_fee AS deliveryFee,
    h.address_purged_at AS addressPurgedAt,
    h.created_at AS bookedAt,
    h.updated_at AS updatedAt,
    h.completed_at AS completedAt,
    s.starts_at AS slotStartsAt,
    s.ends_at AS slotEndsAt,
    s.method AS slotMethod
  FROM booking_requests AS b
  LEFT JOIN handovers AS h ON h.booking_id = b.id
  LEFT JOIN handover_slots AS s ON s.id = h.slot_id
  WHERE b.id = ?1
  LIMIT 1
`

interface HandoverState {
  readonly booking: {
    readonly id: string
    readonly status: BookingStatus
    readonly completedAt: string | null
  }
  readonly handover: AdminHandover | null
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return bookingStatuses.some((status) => status === value)
}

function isNullableText(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isCanonicalInstant(value)
}

/**
 * D1 rows are a trust boundary: a row of another shape throws a fixed code
 * without any row data, which worker/index.ts answers with 500.
 */
function readHandoverState(
  row: Readonly<Record<string, unknown>>,
  bookingId: string,
): HandoverState {
  const { bookingStatus, bookingCompletedAt } = row

  if (
    row.bookingId !== bookingId ||
    !isBookingStatus(bookingStatus) ||
    !isNullableText(bookingCompletedAt)
  ) {
    throw new Error('ADMIN_HANDOVER_ROW_INVALID')
  }

  const booking = {
    id: bookingId,
    status: bookingStatus,
    completedAt: bookingCompletedAt,
  }

  if (row.handoverBookingId === null) {
    return { booking, handover: null }
  }

  const {
    slotId,
    method,
    status,
    deliveryAreaId,
    deliveryCity,
    deliveryDistrict,
    deliveryStreet,
    deliveryLandmark,
    deliveryFee,
    addressPurgedAt,
    bookedAt,
    updatedAt,
    completedAt,
    slotStartsAt,
    slotEndsAt,
    slotMethod,
  } = row

  if (
    row.handoverBookingId !== bookingId ||
    !isHandoverSlotId(slotId) ||
    !isHandoverMethod(method) ||
    !isHandoverStatus(status) ||
    !isNullableText(deliveryAreaId) ||
    !isNullableText(deliveryCity) ||
    !isNullableText(deliveryDistrict) ||
    !isNullableText(deliveryStreet) ||
    !isNullableText(deliveryLandmark) ||
    !(deliveryFee === null || (typeof deliveryFee === 'number' && Number.isSafeInteger(deliveryFee))) ||
    !isNullableInstant(addressPurgedAt) ||
    !isCanonicalInstant(bookedAt) ||
    !isCanonicalInstant(updatedAt) ||
    !isNullableInstant(completedAt) ||
    !isCanonicalInstant(slotStartsAt) ||
    !isCanonicalInstant(slotEndsAt) ||
    !isHandoverSlotMethod(slotMethod)
  ) {
    throw new Error('ADMIN_HANDOVER_ROW_INVALID')
  }

  return {
    booking,
    handover: {
      method,
      status,
      slot: {
        id: slotId,
        slotDate: riyadhDateKey(new Date(slotStartsAt)),
        startsAt: slotStartsAt,
        endsAt: slotEndsAt,
        method: slotMethod,
      },
      delivery:
        method === 'pickup'
          ? null
          : {
              areaId: deliveryAreaId,
              areaName: deliveryCity,
              fee: deliveryFee,
              district: deliveryDistrict,
              street: deliveryStreet,
              landmark: deliveryLandmark,
              addressPurged: addressPurgedAt !== null,
            },
      bookedAt,
      updatedAt,
      completedAt,
    },
  }
}

async function loadHandoverState(
  db: D1Database,
  bookingId: string,
): Promise<HandoverState | null> {
  const row = await db
    .prepare(SELECT_HANDOVER_SQL)
    .bind(bookingId)
    .first<Record<string, unknown>>()

  return row ? readHandoverState(row, bookingId) : null
}

function stateResponse(state: HandoverState): Response {
  const body: AdminHandoverResponse = {
    ok: true,
    booking: state.booking,
    handover: state.handover,
  }

  return jsonResponse(body)
}

// ---------------------------------------------------------------------------
// GET bookings/{id}/handover
// ---------------------------------------------------------------------------

export async function getAdminHandover(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin, params } = context

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const state = await loadHandoverState(env.DB, params.bookingId)

  return state ? stateResponse(state) : bookingNotFoundResponse()
}

// ---------------------------------------------------------------------------
// PATCH bookings/{id}/handover: the statements
// ---------------------------------------------------------------------------

/**
 * The booking_events row of a handover write, batched right after it.
 * changes() still describes that write while this INSERT runs: no row when
 * it changed none; event NULL (NOT NULL fails, the batch rolls back) when
 * it changed more than one. The subject is the handover's slot as it is
 * after the write.
 * ?1 booking id | ?2 admin uid | ?3 event kind | ?4 details JSON
 */
const HANDOVER_EVENT_SQL = `
  INSERT INTO booking_events (
    booking_id,
    actor,
    actor_uid,
    event,
    subject_id,
    details,
    note,
    created_at
  )
  SELECT
    ?1,
    'admin',
    ?2,
    CASE WHEN changes() = 1 THEN ?3 END,
    (SELECT h.slot_id FROM handovers AS h WHERE h.booking_id = ?1),
    ?4,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE changes() <> 0
`

// ?1 booking id | ?2 now | ?3 status read
const COMPLETE_HANDOVER_SQL = `
  UPDATE handovers
  SET status = 'completed',
      completed_at = ?2,
      updated_at = ?2
  WHERE booking_id = ?1
    AND status = 'scheduled'
    AND status = ?3
    AND EXISTS (
      SELECT 1
      FROM booking_requests AS b
      WHERE b.id = ?1
        AND b.status = 'confirmed'
        AND b.completed_at IS NULL
    )
`

// ?1 booking id | ?2 now: only right after this batch completed its handover.
const COMPLETE_BOOKING_SQL = `
  UPDATE booking_requests
  SET completed_at = ?2,
      updated_at = ?2
  WHERE id = ?1
    AND completed_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM handovers AS h
      WHERE h.booking_id = ?1
        AND h.status = 'completed'
        AND h.completed_at = ?2
    )
`

/**
 * `booking_completed`, and the guard that both completed_at columns were
 * stamped together: once this batch completed the handover (its
 * completed_at is ?3), the booking UPDATE right before must have changed
 * exactly one row, or the event is NULL and the whole batch rolls back.
 * ?1 booking id | ?2 admin uid | ?3 now
 */
const BOOKING_COMPLETED_EVENT_SQL = `
  INSERT INTO booking_events (
    booking_id,
    actor,
    actor_uid,
    event,
    subject_id,
    details,
    note,
    created_at
  )
  SELECT
    ?1,
    'admin',
    ?2,
    CASE WHEN changes() = 1 THEN 'booking_completed' END,
    NULL,
    NULL,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (
    SELECT 1
    FROM handovers AS h
    WHERE h.booking_id = ?1
      AND h.status = 'completed'
      AND h.completed_at = ?3
  )
`

// ?1 booking id | ?2 now | ?3 status read: only once the slot has started
// (server clock).
const NO_SHOW_SQL = `
  UPDATE handovers
  SET status = 'no_show',
      updated_at = ?2
  WHERE booking_id = ?1
    AND status = 'scheduled'
    AND status = ?3
    AND EXISTS (
      SELECT 1
      FROM handover_slots AS s
      WHERE s.id = handovers.slot_id
        AND s.starts_at <= ?2
    )
`

// ?1 booking id | ?2 now | ?3 status read
const CANCEL_SQL = `
  UPDATE handovers
  SET status = 'cancelled',
      updated_at = ?2
  WHERE booking_id = ?1
    AND status IN ('scheduled', 'no_show')
    AND status = ?3
`

/**
 * TM-15: every condition inside the UPDATE. The slot the admin chose must
 * be active, still ahead (server clock), able to host this handover's
 * method, and have room: the scheduled handovers in it, NOT counting this
 * booking's own row, below its capacity. Compare-and-swap on the slot and
 * status read (?4, ?5). Moving to the slot it already holds while
 * scheduled is not a write.
 * ?1 booking id | ?2 target slot id | ?3 now | ?4 slot read | ?5 status read
 */
const REASSIGN_SQL = `
  UPDATE handovers
  SET slot_id = ?2,
      status = 'scheduled',
      updated_at = ?3
  WHERE booking_id = ?1
    AND slot_id = ?4
    AND status = ?5
    AND status IN ('scheduled', 'no_show', 'cancelled')
    AND NOT (slot_id = ?2 AND status = 'scheduled')
    AND EXISTS (
      SELECT 1
      FROM booking_requests AS b
      WHERE b.id = ?1
        AND b.status = 'confirmed'
        AND b.completed_at IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM handover_slots AS s
      WHERE s.id = ?2
        AND s.is_active = 1
        AND s.starts_at > ?3
        AND (s.method = 'both' OR s.method = handovers.method)
        AND (
          SELECT COUNT(*)
          FROM handovers AS other
          WHERE other.slot_id = s.id
            AND other.status = 'scheduled'
            AND other.booking_id <> ?1
        ) < s.capacity
    )
`

// ?1 slot id
const SELECT_TARGET_SLOT_SQL = `
  SELECT
    s.id AS id,
    s.starts_at AS startsAt,
    s.ends_at AS endsAt,
    s.method AS method,
    s.capacity AS capacity,
    s.is_active AS isActive,
    s.created_at AS createdAt,
    s.updated_at AS updatedAt,
    (
      SELECT COUNT(*)
      FROM handovers AS h
      WHERE h.slot_id = s.id
        AND h.status = 'scheduled'
        AND h.booking_id <> ?2
    ) AS bookedCount
  FROM handover_slots AS s
  WHERE s.id = ?1
  LIMIT 1
`

// ---------------------------------------------------------------------------
// PATCH bookings/{id}/handover: the answer when nothing changed
// ---------------------------------------------------------------------------

/** complete, no_show, cancel: read after the write changed no row. */
function unchangedStatusResponse(
  command: AdminHandoverCommand,
  state: HandoverState,
): Response {
  const { handover, booking } = state

  if (!handover) {
    return handoverNotFoundResponse()
  }

  switch (command.action) {
    case 'complete':
      if (handover.status === 'completed') {
        return stateResponse(state)
      }

      if (handover.status !== 'scheduled') {
        return handoverNotScheduledResponse()
      }

      return booking.status !== 'confirmed'
        ? bookingNotConfirmedResponse()
        : handoverChangedResponse()
    case 'no_show':
      if (handover.status === 'no_show') {
        return stateResponse(state)
      }

      if (handover.status === 'completed') {
        return handoverAlreadyCompletedResponse()
      }

      if (handover.status !== 'scheduled') {
        return handoverNotScheduledResponse()
      }

      return Date.parse(handover.slot.startsAt) > Date.now()
        ? handoverNotDueResponse()
        : handoverChangedResponse()
    case 'cancel':
      if (handover.status === 'cancelled') {
        return stateResponse(state)
      }

      return handover.status === 'completed'
        ? handoverAlreadyCompletedResponse()
        : handoverChangedResponse()
    case 'reassign':
      return handoverChangedResponse()
  }
}

/** reassign: read after the write changed no row. */
async function unchangedReassignResponse(
  db: D1Database,
  bookingId: string,
  slotId: string,
  state: HandoverState,
): Promise<Response> {
  const { handover, booking } = state

  if (!handover) {
    return handoverNotFoundResponse()
  }

  if (handover.status === 'completed') {
    return handoverAlreadyCompletedResponse()
  }

  if (handover.status === 'scheduled' && handover.slot.id === slotId) {
    return stateResponse(state)
  }

  const row = await db
    .prepare(SELECT_TARGET_SLOT_SQL)
    .bind(slotId, bookingId)
    .first<Record<string, unknown>>()

  if (!row) {
    return slotNotFoundResponse()
  }

  const target = readSlotRow(row)

  if (
    !target.isActive ||
    Date.parse(target.startsAt) <= Date.now() ||
    !slotAcceptsMethod(target.method, handover.method)
  ) {
    return slotUnavailableResponse()
  }

  if (target.bookedCount >= target.capacity) {
    return slotFullResponse()
  }

  if (booking.status !== 'confirmed') {
    return bookingNotConfirmedResponse()
  }

  return handoverChangedResponse()
}

// ---------------------------------------------------------------------------
// PATCH bookings/{id}/handover
// ---------------------------------------------------------------------------

/** The changes of statement `index` of a batch; a missing result counts as none. */
function changesAt(results: readonly D1Result[], index: number): number {
  return results[index]?.meta.changes ?? 0
}

function statusStatements(
  db: D1Database,
  command: Exclude<AdminHandoverCommand, { action: 'reassign' }>,
  bookingId: string,
  adminUid: string,
  now: string,
  fromStatus: HandoverStatus,
): D1PreparedStatement[] {
  const event = (kind: string): D1PreparedStatement =>
    db
      .prepare(HANDOVER_EVENT_SQL)
      .bind(bookingId, adminUid, kind, JSON.stringify({ fromStatus }))

  switch (command.action) {
    case 'complete':
      return [
        db.prepare(COMPLETE_HANDOVER_SQL).bind(bookingId, now, fromStatus),
        event('handover_completed'),
        db.prepare(COMPLETE_BOOKING_SQL).bind(bookingId, now),
        db
          .prepare(BOOKING_COMPLETED_EVENT_SQL)
          .bind(bookingId, adminUid, now),
      ]
    case 'no_show':
      return [
        db.prepare(NO_SHOW_SQL).bind(bookingId, now, fromStatus),
        event('handover_no_show'),
      ]
    case 'cancel':
      return [
        db.prepare(CANCEL_SQL).bind(bookingId, now, fromStatus),
        event('handover_cancelled'),
      ]
  }
}

export async function patchAdminHandover(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, request, admin, params } = context
  const bookingId = params.bookingId
  const read = await readJsonBody(request, {
    maxBytes: ADMIN_HANDOVER_BODY_MAX_BYTES,
    requiredKeys: ADMIN_HANDOVER_BODY_REQUIRED_KEYS,
    optionalKeys: ADMIN_HANDOVER_BODY_OPTIONAL_KEYS,
  })

  if (!read.ok) {
    return read.response
  }

  const parsed = parseAdminHandoverCommand(read.body)

  if (!parsed.ok) {
    return handoverInputErrorResponse(parsed.code)
  }

  const command = parsed.value
  const before = await loadHandoverState(env.DB, bookingId)

  if (!before) {
    return bookingNotFoundResponse()
  }

  const { handover } = before

  if (!handover) {
    return handoverNotFoundResponse()
  }

  const now = new Date().toISOString()

  if (command.action === 'reassign') {
    // The one no-op decided before writing: already scheduled in that slot.
    if (handover.status === 'scheduled' && handover.slot.id === command.slotId) {
      return stateResponse(before)
    }

    const details = JSON.stringify({
      fromSlotId: handover.slot.id,
      toSlotId: command.slotId,
      fromStatus: handover.status,
    })
    const results = await env.DB.batch([
      env.DB.prepare(REASSIGN_SQL).bind(
        bookingId,
        command.slotId,
        now,
        handover.slot.id,
        handover.status,
      ),
      env.DB
        .prepare(HANDOVER_EVENT_SQL)
        .bind(bookingId, admin.uid, 'handover_rescheduled', details),
    ])
    const moved = changesAt(results, 0)
    const recorded = changesAt(results, 1)

    if (moved === 0 && recorded === 0) {
      const after = await loadHandoverState(env.DB, bookingId)

      return after
        ? unchangedReassignResponse(env.DB, bookingId, command.slotId, after)
        : bookingNotFoundResponse()
    }

    if (moved !== 1 || recorded !== 1) {
      throw new Error('ADMIN_HANDOVER_REASSIGN_INCOMPLETE')
    }
  } else {
    const statements = statusStatements(
      env.DB,
      command,
      bookingId,
      admin.uid,
      now,
      handover.status,
    )
    const results = await env.DB.batch(statements)
    const changed = changesAt(results, 0)
    const recorded = changesAt(results, 1)

    if (changed === 0 && recorded === 0) {
      const after = await loadHandoverState(env.DB, bookingId)

      return after
        ? unchangedStatusResponse(command, after)
        : bookingNotFoundResponse()
    }

    if (
      changed !== 1 ||
      recorded !== 1 ||
      (command.action === 'complete' &&
        (changesAt(results, 2) !== 1 || changesAt(results, 3) !== 1))
    ) {
      throw new Error('ADMIN_HANDOVER_UPDATE_INCOMPLETE')
    }
  }

  const after = await loadHandoverState(env.DB, bookingId)

  if (!after) {
    throw new Error('ADMIN_HANDOVER_UPDATE_INCOMPLETE')
  }

  return stateResponse(after)
}
