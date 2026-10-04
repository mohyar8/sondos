import {
  handoverSlotCreatedAudit,
  handoverSlotDeletedAudit,
  handoverSlotsGeneratedAudit,
  handoverSlotUpdatedAudit,
} from '../../shared/audit.js'
import {
  HANDOVER_SLOT_BODY_KEYS,
  HANDOVER_SLOT_BODY_MAX_BYTES,
  HANDOVER_SLOT_GENERATE_BODY_KEYS,
  HANDOVER_SLOT_GENERATE_BODY_MAX_BYTES,
  HANDOVER_SLOT_GENERATION_MAX,
  HANDOVER_SLOT_LIST_MAX,
  HANDOVER_SLOT_MAX_DURATION_MS,
  HANDOVER_SLOT_PATCH_BODY_KEYS,
  HANDOVER_SLOT_PATCH_BODY_MAX_BYTES,
  HANDOVER_SLOT_RANGE_MAX_DAYS,
  isCanonicalInstant,
  isHandoverSlotCapacity,
  isHandoverSlotId,
  isHandoverSlotMethod,
  parseHandoverSlotInput,
  parseHandoverSlotPatch,
  parseHandoverSlotRange,
  planHandoverSlotGeneration,
  type AdminHandoverSlot,
  type AdminHandoverSlotDeletedResponse,
  type AdminHandoverSlotResponse,
  type AdminHandoverSlotsGeneratedResponse,
  type AdminHandoverSlotsResponse,
  type HandoverInputError,
  type HandoverSlotPatch,
} from '../../shared/portal/handover.js'
import {
  addDaysToDateKey,
  riyadhDateKey,
  riyadhStartOfDay,
  riyadhTodayKey,
} from '../../shared/timing.js'
import {
  auditAfterWrite,
  auditStatement,
  type AdminAuditActor,
} from '../audit/admin-audit.js'
import { errorResponse, jsonResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import type { AdminPortalContext } from './admin-portal-routes.js'
import { readJsonBody } from './request.js'

/**
 * Handover slots for the admin (plan 11 §3.2 #28, §3.3 #28; TM-15, M2;
 * SB-4, SB-5, SB-10). Auth AD (the admin dispatcher's guard), gate 'open'.
 *
 * - GET    handover-slots?from&to: Riyadh date keys, at most 92 days apart;
 *   every slot starting in those Riyadh days, with bookedCount (scheduled
 *   handovers). Burst-limited per admin (RL_ADMIN_READ).
 * - POST   handover-slots: one slot. `INSERT … ON CONFLICT (starts_at,
 *   method) DO NOTHING`, so a duplicate is 409 SLOT_ALREADY_EXISTS and
 *   writes nothing (no audit row either).
 * - POST   handover-slots/generate: at most 200 slots from a Riyadh date
 *   range, weekdays and wall-clock times (riyadhLocalToInstant). The
 *   existing ones are read first and skipped; the rest go in ONE INSERT
 *   over a server-built JSON array, in the batch with the audit row that
 *   records those counts. A slot created by someone else in between fails
 *   the INSERT's unique index and the whole batch (409 SLOT_CHANGED), so
 *   the audit never records counts that did not happen.
 * - PATCH  handover-slots/{slotId}: capacity and/or isActive in ONE
 *   conditional UPDATE (TM-15): a capacity below the scheduled count, or a
 *   deactivation while any handover is scheduled, changes no row, and so
 *   does a value that is already set. The reason is read only afterwards,
 *   to choose the answer (409 CAPACITY_BELOW_BOOKED, 409 SLOT_HAS_BOOKINGS,
 *   or 200 unchanged).
 * - DELETE handover-slots/{slotId}: only a slot no handover ever referenced
 *   (the NOT EXISTS is in the DELETE; handovers.slot_id is also ON DELETE
 *   RESTRICT). Unknown or already deleted → 200 `{ deleted: false }`.
 *
 * Every create, update and delete goes through auditAfterWrite and the
 * generate batch through auditStatement (W1-09): the admin_audit_log row
 * exists exactly when the write changed a row, and never holds more than
 * ids, instants, methods and counts. The SQL is fixed text with bound
 * parameters only; instants are the Worker clock (server clock only).
 */

/** The admin's audit identity: these routes are AD, not AD+R, so no reauth_at. */
function auditActor(context: AdminPortalContext): AdminAuditActor {
  return { uid: context.admin.uid, reauthAt: null }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const INPUT_ERROR_MESSAGES: Readonly<Record<HandoverInputError, string>> = {
  INVALID_REQUEST_BODY: 'بيانات الطلب غير صحيحة.',
  MISSING_DATE_RANGE: 'يجب إرسال تاريخ البداية في from وتاريخ النهاية في to.',
  INVALID_DATE: 'يجب أن يكون التاريخان بصيغة YYYY-MM-DD وأن يمثلا تاريخين صحيحين.',
  INVALID_DATE_RANGE: 'يجب أن يكون تاريخ البداية قبل تاريخ النهاية أو مساويًا له.',
  DATE_RANGE_TOO_LARGE: `يجب ألا تتجاوز المدة المطلوبة ${HANDOVER_SLOT_RANGE_MAX_DAYS + 1} يومًا شاملة تاريخي البداية والنهاية.`,
  DATE_IN_PAST: 'لا يمكن إنشاء مواعيد لأيام مضت.',
  DATE_BEYOND_HORIZON: 'يمكن إضافة المواعيد لمدة أقصاها سنتان من اليوم.',
  INVALID_TIME_RANGE: `يجب أن يكون وقت نهاية الموعد بعد وقت بدايته في اليوم نفسه، وألا تزيد مدته على ${HANDOVER_SLOT_MAX_DURATION_MS / 3_600_000} ساعة.`,
  TOO_MANY_SLOTS: `يمكن إنشاء ${HANDOVER_SLOT_GENERATION_MAX} موعد كحد أقصى في المرة الواحدة. اختاري فترة أقصر أو أوقاتًا أقل.`,
}

/** 400 for an input the shared/portal/handover.ts parsers refused. */
export function handoverInputErrorResponse(code: HandoverInputError): Response {
  return errorResponse(400, code, INPUT_ERROR_MESSAGES[code])
}

export function slotNotFoundResponse(): Response {
  return errorResponse(404, 'SLOT_NOT_FOUND', 'لم يتم العثور على الموعد.')
}

function slotAlreadyExistsResponse(): Response {
  return errorResponse(
    409,
    'SLOT_ALREADY_EXISTS',
    'يوجد موعد بالطريقة نفسها في هذا الوقت.',
  )
}

function capacityBelowBookedResponse(): Response {
  return errorResponse(
    409,
    'CAPACITY_BELOW_BOOKED',
    'لا يمكن أن يقل عدد المواعيد المتاحة عن عدد الحجوزات القائمة في هذا الموعد.',
  )
}

function slotHasBookingsOnDeactivateResponse(): Response {
  return errorResponse(
    409,
    'SLOT_HAS_BOOKINGS',
    'لا يمكن إيقاف موعد لديه حجوزات قائمة. انقلي هذه الحجوزات إلى موعد آخر أولًا.',
  )
}

/** 07 §3.G.4 copy. */
function slotHasBookingsOnDeleteResponse(): Response {
  return errorResponse(
    409,
    'SLOT_HAS_BOOKINGS',
    'لا يمكن حذف موعد لديه حجوزات. يمكنكِ إلغاء تفعيله بدلاً من ذلك.',
  )
}

function slotChangedResponse(): Response {
  return errorResponse(
    409,
    'SLOT_CHANGED',
    'تغيّرت المواعيد أثناء الحفظ. حدّثي الصفحة ثم أعيدي المحاولة.',
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The columns every slot read selects; bookedCount counts scheduled handovers only. */
const SLOT_COLUMNS = `
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
  ) AS bookedCount
`

// ?1 slot id
const SELECT_SLOT_SQL = `
  SELECT ${SLOT_COLUMNS}
  FROM handover_slots AS s
  WHERE s.id = ?1
  LIMIT 1
`

// ?1 first instant (inclusive) | ?2 last instant (exclusive) | ?3 row limit
const LIST_SLOTS_SQL = `
  SELECT ${SLOT_COLUMNS}
  FROM handover_slots AS s
  WHERE s.starts_at >= ?1
    AND s.starts_at < ?2
  ORDER BY s.starts_at, s.method
  LIMIT ?3
`

/**
 * D1 rows are a trust boundary: a row of another shape throws a fixed code
 * without any row data, which worker/index.ts answers with 500.
 */
export function readSlotRow(row: Readonly<Record<string, unknown>>): AdminHandoverSlot {
  const {
    id,
    startsAt,
    endsAt,
    method,
    capacity,
    isActive,
    createdAt,
    updatedAt,
    bookedCount,
  } = row

  if (
    !isHandoverSlotId(id) ||
    !isCanonicalInstant(startsAt) ||
    !isCanonicalInstant(endsAt) ||
    !isHandoverSlotMethod(method) ||
    !isHandoverSlotCapacity(capacity) ||
    (isActive !== 0 && isActive !== 1) ||
    !isCanonicalInstant(createdAt) ||
    !isCanonicalInstant(updatedAt) ||
    typeof bookedCount !== 'number' ||
    !Number.isSafeInteger(bookedCount) ||
    bookedCount < 0
  ) {
    throw new Error('HANDOVER_SLOT_ROW_INVALID')
  }

  return {
    id,
    slotDate: riyadhDateKey(new Date(startsAt)),
    startsAt,
    endsAt,
    method,
    capacity,
    isActive: isActive === 1,
    bookedCount,
    createdAt,
    updatedAt,
  }
}

async function loadSlot(
  db: D1Database,
  slotId: string,
): Promise<AdminHandoverSlot | null> {
  const row = await db
    .prepare(SELECT_SLOT_SQL)
    .bind(slotId)
    .first<Record<string, unknown>>()

  return row ? readSlotRow(row) : null
}

/** The changes of statement `index` of a batch; a missing result counts as none. */
function changesAt(results: readonly D1Result[], index: number): number {
  return results[index]?.meta.changes ?? 0
}

// ---------------------------------------------------------------------------
// GET handover-slots
// ---------------------------------------------------------------------------

export async function listHandoverSlots(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, url, admin } = context

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const range = parseHandoverSlotRange(
    url.searchParams.get('from'),
    url.searchParams.get('to'),
  )

  if (!range.ok) {
    return handoverInputErrorResponse(range.code)
  }

  const { from, to } = range.value
  const dayAfterTo = addDaysToDateKey(to, 1)
  const firstInstant = riyadhStartOfDay(from)
  const endInstant = dayAfterTo === null ? null : riyadhStartOfDay(dayAfterTo)

  if (firstInstant === null || endInstant === null) {
    return handoverInputErrorResponse('INVALID_DATE')
  }

  const result = await env.DB.prepare(LIST_SLOTS_SQL)
    .bind(firstInstant, endInstant, HANDOVER_SLOT_LIST_MAX + 1)
    .all<Record<string, unknown>>()
  const rows = result.results
  const body: AdminHandoverSlotsResponse = {
    ok: true,
    range: { from, to },
    slots: rows.slice(0, HANDOVER_SLOT_LIST_MAX).map(readSlotRow),
    truncated: rows.length > HANDOVER_SLOT_LIST_MAX,
  }

  return jsonResponse(body)
}

// ---------------------------------------------------------------------------
// POST handover-slots
// ---------------------------------------------------------------------------

// ?1 id | ?2 starts_at | ?3 ends_at | ?4 method | ?5 capacity | ?6 now
const INSERT_SLOT_SQL = `
  INSERT INTO handover_slots (
    id,
    starts_at,
    ends_at,
    method,
    capacity,
    is_active,
    created_at,
    updated_at
  )
  VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)
  ON CONFLICT (starts_at, method) DO NOTHING
`

export async function createHandoverSlot(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, request } = context
  const read = await readJsonBody(request, {
    maxBytes: HANDOVER_SLOT_BODY_MAX_BYTES,
    requiredKeys: HANDOVER_SLOT_BODY_KEYS,
  })

  if (!read.ok) {
    return read.response
  }

  const now = new Date()
  const parsed = parseHandoverSlotInput(read.body, riyadhTodayKey(now))

  if (!parsed.ok) {
    return handoverInputErrorResponse(parsed.code)
  }

  const slot = parsed.value
  const slotId = crypto.randomUUID()
  const write = env.DB.prepare(INSERT_SLOT_SQL).bind(
    slotId,
    slot.startsAt,
    slot.endsAt,
    slot.method,
    slot.capacity,
    now.toISOString(),
  )
  const results = await env.DB.batch([
    ...auditAfterWrite(
      env.DB,
      write,
      auditActor(context),
      handoverSlotCreatedAudit(slotId, slot),
    ),
  ])
  const inserted = changesAt(results, 0)
  const audited = changesAt(results, 1)

  if (inserted === 0 && audited === 0) {
    return slotAlreadyExistsResponse()
  }

  if (inserted !== 1 || audited !== 1) {
    throw new Error('HANDOVER_SLOT_CREATE_INCOMPLETE')
  }

  const created = await loadSlot(env.DB, slotId)

  if (!created) {
    throw new Error('HANDOVER_SLOT_CREATE_INCOMPLETE')
  }

  const body: AdminHandoverSlotResponse = { ok: true, slot: created }

  return jsonResponse(body, 201)
}

// ---------------------------------------------------------------------------
// POST handover-slots/generate
// ---------------------------------------------------------------------------

// ?1 method | ?2 JSON array of starts_at instants (server-built)
const SELECT_EXISTING_STARTS_SQL = `
  SELECT s.starts_at AS startsAt
  FROM handover_slots AS s
  WHERE s.method = ?1
    AND s.starts_at IN (SELECT planned.value FROM json_each(?2) AS planned)
`

// ?1 method | ?2 capacity | ?3 now | ?4 JSON array of { id, startsAt, endsAt }
// (server-built from validated instants and crypto.randomUUID() ids). No
// conflict clause: a slot that appeared since the read fails the unique
// index and the whole batch, audit row included.
const INSERT_GENERATED_SLOTS_SQL = `
  INSERT INTO handover_slots (
    id,
    starts_at,
    ends_at,
    method,
    capacity,
    is_active,
    created_at,
    updated_at
  )
  SELECT
    json_extract(planned.value, '$.id'),
    json_extract(planned.value, '$.startsAt'),
    json_extract(planned.value, '$.endsAt'),
    ?1,
    ?2,
    1,
    ?3,
    ?3
  FROM json_each(?4) AS planned
`

const SLOT_UNIQUE_VIOLATION = 'UNIQUE constraint failed: handover_slots.'

export async function generateHandoverSlots(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, request } = context
  const read = await readJsonBody(request, {
    maxBytes: HANDOVER_SLOT_GENERATE_BODY_MAX_BYTES,
    requiredKeys: HANDOVER_SLOT_GENERATE_BODY_KEYS,
  })

  if (!read.ok) {
    return read.response
  }

  const now = new Date()
  const plan = planHandoverSlotGeneration(read.body, riyadhTodayKey(now))

  if (!plan.ok) {
    return handoverInputErrorResponse(plan.code)
  }

  const { fromDate, toDate, method, capacity, slots } = plan.value
  const existing = new Set<string>()

  if (slots.length > 0) {
    const result = await env.DB.prepare(SELECT_EXISTING_STARTS_SQL)
      .bind(method, JSON.stringify(slots.map((slot) => slot.startsAt)))
      .all<Record<string, unknown>>()

    for (const row of result.results) {
      if (!isCanonicalInstant(row.startsAt)) {
        throw new Error('HANDOVER_SLOT_ROW_INVALID')
      }

      existing.add(row.startsAt)
    }
  }

  const toCreate = slots
    .filter((slot) => !existing.has(slot.startsAt))
    .map((slot) => ({
      id: crypto.randomUUID(),
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    }))
  const created = toCreate.length
  const skipped = slots.length - created
  const audit = auditStatement(
    env.DB,
    auditActor(context),
    handoverSlotsGeneratedAudit({
      fromDate,
      toDate,
      method,
      capacity,
      created,
      skipped,
    }),
  )
  const statements =
    created === 0
      ? [audit]
      : [
          env.DB.prepare(INSERT_GENERATED_SLOTS_SQL).bind(
            method,
            capacity,
            now.toISOString(),
            JSON.stringify(toCreate),
          ),
          audit,
        ]
  let results: D1Result[]

  try {
    results = await env.DB.batch(statements)
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(SLOT_UNIQUE_VIOLATION)
    ) {
      return slotChangedResponse()
    }

    throw error
  }

  const insertedRows = created === 0 ? 0 : changesAt(results, 0)
  const auditedRows = changesAt(results, statements.length - 1)

  if (insertedRows !== created || auditedRows !== 1) {
    throw new Error('HANDOVER_SLOT_GENERATE_INCOMPLETE')
  }

  const body: AdminHandoverSlotsGeneratedResponse = {
    ok: true,
    created,
    skipped,
  }

  return jsonResponse(body)
}

// ---------------------------------------------------------------------------
// PATCH handover-slots/{slotId}
// ---------------------------------------------------------------------------

// ?1 new capacity or NULL | ?2 new is_active (0/1) or NULL | ?3 now | ?4 slot id
// One statement (TM-15): the capacity may not drop below the scheduled
// handovers, and a slot with a scheduled handover may not be deactivated,
// both counted inside this UPDATE; a value already set changes nothing.
const UPDATE_SLOT_SQL = `
  UPDATE handover_slots
  SET capacity = coalesce(?1, capacity),
      is_active = coalesce(?2, is_active),
      updated_at = ?3
  WHERE id = ?4
    AND (
      capacity IS NOT coalesce(?1, capacity)
      OR is_active IS NOT coalesce(?2, is_active)
    )
    AND (
      ?1 IS NULL
      OR ?1 >= (
        SELECT COUNT(*)
        FROM handovers AS h
        WHERE h.slot_id = handover_slots.id
          AND h.status = 'scheduled'
      )
    )
    AND (
      ?2 IS NULL
      OR ?2 = 1
      OR NOT EXISTS (
        SELECT 1
        FROM handovers AS h
        WHERE h.slot_id = handover_slots.id
          AND h.status = 'scheduled'
      )
    )
`

/** Why a PATCH changed nothing, read after the UPDATE (never instead of it). */
function unchangedSlotResponse(
  slot: AdminHandoverSlot | null,
  patch: HandoverSlotPatch,
): Response {
  if (!slot) {
    return slotNotFoundResponse()
  }

  const capacityHolds =
    patch.capacity === undefined || patch.capacity === slot.capacity
  const activeHolds =
    patch.isActive === undefined || patch.isActive === slot.isActive

  if (capacityHolds && activeHolds) {
    const body: AdminHandoverSlotResponse = { ok: true, slot }

    return jsonResponse(body)
  }

  if (patch.capacity !== undefined && patch.capacity < slot.bookedCount) {
    return capacityBelowBookedResponse()
  }

  if (patch.isActive === false && slot.bookedCount > 0) {
    return slotHasBookingsOnDeactivateResponse()
  }

  return slotChangedResponse()
}

export async function updateHandoverSlot(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, request, params } = context
  const slotId = params.slotId

  if (!isHandoverSlotId(slotId)) {
    return slotNotFoundResponse()
  }

  const read = await readJsonBody(request, {
    maxBytes: HANDOVER_SLOT_PATCH_BODY_MAX_BYTES,
    requiredKeys: [],
    optionalKeys: HANDOVER_SLOT_PATCH_BODY_KEYS,
  })

  if (!read.ok) {
    return read.response
  }

  const parsed = parseHandoverSlotPatch(read.body)

  if (!parsed.ok) {
    return handoverInputErrorResponse(parsed.code)
  }

  const patch = parsed.value
  const isActive =
    patch.isActive === undefined ? null : patch.isActive ? 1 : 0
  const write = env.DB.prepare(UPDATE_SLOT_SQL).bind(
    patch.capacity ?? null,
    isActive,
    new Date().toISOString(),
    slotId,
  )
  const results = await env.DB.batch([
    ...auditAfterWrite(
      env.DB,
      write,
      auditActor(context),
      handoverSlotUpdatedAudit(slotId, patch),
    ),
  ])
  const updated = changesAt(results, 0)
  const audited = changesAt(results, 1)

  if (updated === 0 && audited === 0) {
    return unchangedSlotResponse(await loadSlot(env.DB, slotId), patch)
  }

  if (updated !== 1 || audited !== 1) {
    throw new Error('HANDOVER_SLOT_UPDATE_INCOMPLETE')
  }

  const slot = await loadSlot(env.DB, slotId)

  if (!slot) {
    throw new Error('HANDOVER_SLOT_UPDATE_INCOMPLETE')
  }

  const body: AdminHandoverSlotResponse = { ok: true, slot }

  return jsonResponse(body)
}

// ---------------------------------------------------------------------------
// DELETE handover-slots/{slotId}
// ---------------------------------------------------------------------------

// ?1 slot id | ?2 starts_at read | ?3 method read. The audit row records
// the start and method read before the DELETE; the DELETE removes the slot
// only while it still has them and no handover ever referenced it.
const DELETE_SLOT_SQL = `
  DELETE FROM handover_slots
  WHERE id = ?1
    AND starts_at = ?2
    AND method = ?3
    AND NOT EXISTS (
      SELECT 1
      FROM handovers AS h
      WHERE h.slot_id = ?1
    )
`

// ?1 slot id
const SLOT_REFERENCED_SQL = `
  SELECT 1 AS referenced
  FROM handovers AS h
  WHERE h.slot_id = ?1
  LIMIT 1
`

function deletedResponse(deleted: boolean): Response {
  const body: AdminHandoverSlotDeletedResponse = { ok: true, deleted }

  return jsonResponse(body)
}

export async function deleteHandoverSlot(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, params } = context
  const slotId = params.slotId

  // 07 §3.G.4: never 404; an id that cannot exist was never there.
  if (!isHandoverSlotId(slotId)) {
    return deletedResponse(false)
  }

  const slot = await loadSlot(env.DB, slotId)

  if (!slot) {
    return deletedResponse(false)
  }

  const write = env.DB.prepare(DELETE_SLOT_SQL).bind(
    slotId,
    slot.startsAt,
    slot.method,
  )
  const results = await env.DB.batch([
    ...auditAfterWrite(
      env.DB,
      write,
      auditActor(context),
      handoverSlotDeletedAudit(slotId, {
        startsAt: slot.startsAt,
        method: slot.method,
      }),
    ),
  ])
  const deleted = changesAt(results, 0)
  const audited = changesAt(results, 1)

  if (deleted === 1 && audited === 1) {
    return deletedResponse(true)
  }

  if (deleted !== 0 || audited !== 0) {
    throw new Error('HANDOVER_SLOT_DELETE_INCOMPLETE')
  }

  const referenced = await env.DB.prepare(SLOT_REFERENCED_SQL)
    .bind(slotId)
    .first<Record<string, unknown>>()

  if (referenced) {
    return slotHasBookingsOnDeleteResponse()
  }

  return (await loadSlot(env.DB, slotId))
    ? slotChangedResponse()
    : deletedResponse(false)
}
