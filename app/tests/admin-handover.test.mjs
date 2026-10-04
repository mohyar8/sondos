// W2-08 / TM-15, M2, SB-4, SB-5, SB-10: handover slots and the admin
// handover (plan 11 §3.2 #24, #28). The pure parsers of
// shared/portal/handover.ts, then every handler of
// worker/portal/admin-handover-slots.ts and worker/portal/admin-handover.ts
// against a database built from the repository's own migrations (node:sqlite,
// foreign keys on, as in D1) through a small stand-in for the D1 API:
// prepare().bind(), first(), all(), run(), and batch() as one transaction
// that rolls back on the first failure.
//
// The race cases use the stand-in's `beforeBatch` hook, which runs right
// before the handler's writing batch: a check done on a pre-read instead of
// inside the writing statement lets the planted row through and the case
// fails (TM-15).
//
// Binding note: node:sqlite binds every number as REAL, so the stand-in binds
// safe integers as BigInt, as D1 binds a whole JavaScript number as INTEGER.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import {
  HANDOVER_SLOT_GENERATION_MAX,
  parseAdminHandoverCommand,
  parseHandoverSlotInput,
  parseHandoverSlotPatch,
  parseHandoverSlotRange,
  planHandoverSlotGeneration,
} from '../shared/portal/handover.ts'
import { addDaysToDateKey, riyadhTodayKey } from '../shared/timing.ts'
import { adminHandoverRoutes } from '../worker/portal/slots/admin-handover.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/

const ADMIN = 'AdminUid0001'
const CUSTOMER = 'CustomerUid0001'
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// ---------------------------------------------------------------------------
// Database and D1 stand-in
// ---------------------------------------------------------------------------

function sqlValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

function openDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => MIGRATION_FILE.test(file)).sort()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
  }

  const addUser = db.prepare(
    `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
     VALUES (?, ?, 'اسم', 'تجريبي', '+447700900000', ?, '2026-01-01T00:00:00.000Z')`,
  )

  addUser.run(ADMIN, 'admin@example.test', 'admin')
  addUser.run(CUSTOMER, 'customer@example.test', 'customer')

  return db
}

function createD1(db, { beforeBatch } = {}) {
  function execute(statement) {
    const info = db.prepare(statement.sql).run(...statement.values.map(sqlValue))

    return { success: true, meta: { changes: Number(info.changes) } }
  }

  function statement(sql, values) {
    return {
      sql,
      values,
      bind: (...next) => statement(sql, next),
      async run() {
        return execute({ sql, values })
      },
      async first() {
        return db.prepare(sql).get(...values.map(sqlValue)) ?? null
      },
      async all() {
        return { results: db.prepare(sql).all(...values.map(sqlValue)) }
      },
    }
  }

  return {
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      beforeBatch?.(db)
      db.exec('BEGIN')

      try {
        const results = statements.map(execute)
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

const allowAll = { limit: async () => ({ success: true }) }

function context(db, method, path, { body, params = {}, beforeBatch, rateLimit = allowAll } = {}) {
  const url = new URL(`https://example.test/api/admin/${path}`)
  const request = new Request(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  return {
    request,
    url,
    env: { DB: createD1(db, { beforeBatch }), RL_ADMIN_READ: rateLimit },
    ctx: {},
    admin: { uid: ADMIN, authTime: Math.floor(Date.now() / 1000), secondFactor: null },
    params,
  }
}

function route(path) {
  const found = adminHandoverRoutes.find((candidate) => candidate.path.join('/') === path)
  assert.ok(found, path)
  return found
}

async function call(db, method, template, options = {}) {
  const concrete = template.replace(/:([A-Za-z]+)/g, (_, name) => options.params[name])
  const response = await route(template).handlers[method](context(db, method, concrete, options))

  return { status: response.status, body: await response.json() }
}

let counter = 0

function uuid(prefix) {
  counter += 1
  return `${prefix}-0000-4000-8000-${String(counter).padStart(12, '0')}`
}

function addSlot(db, { startsAt, hours = 1, method = 'pickup', capacity = 1, active = 1 }) {
  const id = uuid('5eed5107')
  const endsAt = new Date(Date.parse(startsAt) + hours * HOUR_MS).toISOString()
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO handover_slots (id, starts_at, ends_at, method, capacity, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, startsAt, endsAt, method, BigInt(capacity), BigInt(active), now, now)

  return id
}

let dayOffset = 0

function addBooking(db, { status = 'confirmed' } = {}) {
  const id = uuid('5eedb00c')
  dayOffset += 1
  const eventDate = new Date(Date.UTC(2026, 0, 1) + dayOffset * DAY_MS).toISOString().slice(0, 10)

  db.prepare(
    `INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total)
     VALUES (?, ?, ?, ?, '{}', 5000)`,
  ).run(id, CUSTOMER, eventDate, status)

  return id
}

function addHandover(db, bookingId, slotId, { status = 'scheduled', method = 'pickup' } = {}) {
  const now = new Date().toISOString()
  const completedAt = status === 'completed' ? now : null

  if (method === 'pickup') {
    db.prepare(
      `INSERT INTO handovers (booking_id, slot_id, method, status, created_at, updated_at, completed_at)
       VALUES (?, ?, 'pickup', ?, ?, ?, ?)`,
    ).run(bookingId, slotId, status, now, now, completedAt)
    return
  }

  const areaId = uuid('5eedaa00')
  db.prepare(
    `INSERT INTO delivery_areas (id, name, fee, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, 150, 1, 0, ?, ?)`,
  ).run(areaId, `حي ${areaId.slice(-4)}`, now, now)
  db.prepare(
    `INSERT INTO handovers (booking_id, slot_id, method, delivery_city, delivery_district, delivery_street,
       status, created_at, updated_at, completed_at, delivery_area_id, delivery_fee)
     VALUES (?, ?, 'delivery', 'الرياض', 'الملقا', 'شارع تجريبي', ?, ?, ?, ?, ?, 150)`,
  ).run(bookingId, slotId, status, now, now, completedAt, areaId)
}

function inHours(hours) {
  const instant = new Date(Date.now() + hours * HOUR_MS)
  instant.setUTCSeconds(0, 0)
  return instant.toISOString()
}

function rows(db, sql, ...values) {
  return db.prepare(sql).all(...values)
}

function count(db, sql, ...values) {
  return Number(Object.values(db.prepare(sql).get(...values))[0])
}

function auditRows(db) {
  return rows(db, 'SELECT action, target_id AS targetId, details FROM admin_audit_log ORDER BY id')
}

function events(db, bookingId) {
  return rows(
    db,
    'SELECT actor, actor_uid AS actorUid, event, subject_id AS subjectId, details FROM booking_events WHERE booking_id = ? ORDER BY id',
    bookingId,
  )
}

// ---------------------------------------------------------------------------
// Parsers (shared/portal/handover.ts)
// ---------------------------------------------------------------------------

describe('handover parsers', () => {
  test('a listing range is at most 92 days apart', () => {
    assert.deepEqual(parseHandoverSlotRange('2026-10-01', '2027-01-01'), {
      ok: true,
      value: { from: '2026-10-01', to: '2027-01-01' },
    })
    assert.deepEqual(parseHandoverSlotRange('2026-10-01', '2027-01-02'), { ok: false, code: 'DATE_RANGE_TOO_LARGE' })
    assert.deepEqual(parseHandoverSlotRange(null, '2026-10-01'), { ok: false, code: 'MISSING_DATE_RANGE' })
    assert.deepEqual(parseHandoverSlotRange('2026-10-02', '2026-10-01'), { ok: false, code: 'INVALID_DATE_RANGE' })
    assert.deepEqual(parseHandoverSlotRange('2026-02-30', '2026-03-01'), { ok: false, code: 'INVALID_DATE' })
    // UX-07: Arabic-Indic digits are normalised.
    assert.deepEqual(parseHandoverSlotRange('٢٠٢٦-١٠-٠١', '2026-10-05'), {
      ok: true,
      value: { from: '2026-10-01', to: '2026-10-05' },
    })
  })

  const generation = (overrides = {}) => ({
    fromDate: '2026-10-04',
    toDate: '2026-10-10',
    weekdays: [0, 3],
    times: [{ start: '16:00', end: '17:00' }],
    method: 'pickup',
    capacity: 2,
    ...overrides,
  })

  test('generation converts Riyadh wall-clock times to UTC instants', () => {
    const plan = planHandoverSlotGeneration(generation(), '2026-10-01')

    assert.equal(plan.ok, true)
    // 2026-10-04 is a Sunday (0), 2026-10-07 a Wednesday (3); 16:00 Riyadh is 13:00 UTC.
    assert.deepEqual(plan.value.slots, [
      { startsAt: '2026-10-04T13:00:00.000Z', endsAt: '2026-10-04T14:00:00.000Z' },
      { startsAt: '2026-10-07T13:00:00.000Z', endsAt: '2026-10-07T14:00:00.000Z' },
    ])
    const arabic = planHandoverSlotGeneration(
      generation({ times: [{ start: '١٦:٠٠', end: '١٧:٠٠' }] }),
      '2026-10-01',
    )
    assert.deepEqual(arabic.value.slots, plan.value.slots)
  })

  test('generation bounds: 200 slots, 92 days, validated times, no past days', () => {
    const everyDay = [0, 1, 2, 3, 4, 5, 6]
    const times = (n) =>
      Array.from({ length: n }, (_, index) => ({
        start: `${String(8 + index).padStart(2, '0')}:00`,
        end: `${String(8 + index).padStart(2, '0')}:30`,
      }))
    // 50 days × 4 times = 200: allowed; 51 days × 4 = 204: refused as a whole.
    const at200 = planHandoverSlotGeneration(
      generation({ fromDate: '2026-10-01', toDate: '2026-11-19', weekdays: everyDay, times: times(4) }),
      '2026-10-01',
    )
    assert.equal(at200.ok, true)
    assert.equal(at200.value.slots.length, HANDOVER_SLOT_GENERATION_MAX)
    assert.deepEqual(
      planHandoverSlotGeneration(
        generation({ fromDate: '2026-10-01', toDate: '2026-11-20', weekdays: everyDay, times: times(4) }),
        '2026-10-01',
      ),
      { ok: false, code: 'TOO_MANY_SLOTS' },
    )
    assert.deepEqual(
      planHandoverSlotGeneration(generation({ fromDate: '2026-10-01', toDate: '2027-01-02' }), '2026-10-01'),
      { ok: false, code: 'DATE_RANGE_TOO_LARGE' },
    )

    for (const bad of [
      [{ start: '17:00', end: '16:00' }],
      [{ start: '16:00', end: '16:00' }],
      [{ start: '06:00', end: '18:01' }],
    ]) {
      assert.deepEqual(planHandoverSlotGeneration(generation({ times: bad }), '2026-10-01'), {
        ok: false,
        code: 'INVALID_TIME_RANGE',
      })
    }

    for (const bad of [
      [{ start: '24:00', end: '24:30' }],
      [{ start: '4:00', end: '5:00' }],
      [{ start: '16:00' }],
      [{ start: '16:00', end: '17:00', note: 'x' }],
      [{ start: '16:00', end: '17:00' }, { start: '16:00', end: '16:30' }],
      [],
    ]) {
      assert.deepEqual(planHandoverSlotGeneration(generation({ times: bad }), '2026-10-01'), {
        ok: false,
        code: 'INVALID_REQUEST_BODY',
      })
    }

    for (const weekdays of [[], [7], [1, 1], [0.5]]) {
      assert.equal(planHandoverSlotGeneration(generation({ weekdays }), '2026-10-01').code, 'INVALID_REQUEST_BODY')
    }

    assert.equal(planHandoverSlotGeneration(generation({ capacity: 21 }), '2026-10-01').code, 'INVALID_REQUEST_BODY')
    assert.equal(planHandoverSlotGeneration(generation({ method: 'mail' }), '2026-10-01').code, 'INVALID_REQUEST_BODY')
  })

  test('N-59: between 21:00 and 24:00 Riyadh, "today" is already the next Riyadh date', () => {
    // 2026-10-01T21:30Z is 00:30 on 2 October in Riyadh.
    const today = riyadhTodayKey(new Date('2026-10-01T21:30:00.000Z'))
    assert.equal(today, '2026-10-02')
    assert.deepEqual(
      planHandoverSlotGeneration(generation({ fromDate: '2026-10-01', toDate: '2026-10-03' }), today),
      { ok: false, code: 'DATE_IN_PAST' },
    )
    assert.equal(
      planHandoverSlotGeneration(generation({ fromDate: '2026-10-02', toDate: '2026-10-03' }), today).ok,
      true,
    )
  })

  test('a single slot: canonical instants, end after start, at most 12 hours', () => {
    const body = {
      startsAt: '2026-10-04T13:00:00.000Z',
      endsAt: '2026-10-04T14:00:00.000Z',
      method: 'both',
      capacity: 3,
    }
    assert.equal(parseHandoverSlotInput(body, '2026-10-01').ok, true)
    assert.equal(parseHandoverSlotInput({ ...body, endsAt: body.startsAt }, '2026-10-01').code, 'INVALID_TIME_RANGE')
    assert.equal(
      parseHandoverSlotInput({ ...body, endsAt: '2026-10-05T01:00:01.000Z' }, '2026-10-01').code,
      'INVALID_TIME_RANGE',
    )
    assert.equal(parseHandoverSlotInput({ ...body, startsAt: '2026-10-04T13:00:00Z' }, '2026-10-01').code, 'INVALID_REQUEST_BODY')
    assert.equal(parseHandoverSlotInput({ ...body, capacity: 1.5 }, '2026-10-01').code, 'INVALID_REQUEST_BODY')
    assert.equal(
      parseHandoverSlotInput({ ...body, startsAt: '2029-10-04T13:00:00.000Z', endsAt: '2029-10-04T14:00:00.000Z' }, '2026-10-01').code,
      'DATE_BEYOND_HORIZON',
    )
  })

  test('patch and command bodies', () => {
    assert.deepEqual(parseHandoverSlotPatch({ capacity: 2 }), { ok: true, value: { capacity: 2 } })
    assert.deepEqual(parseHandoverSlotPatch({ isActive: false }), { ok: true, value: { isActive: false } })
    assert.equal(parseHandoverSlotPatch({}).ok, false)
    assert.equal(parseHandoverSlotPatch({ isActive: 0 }).ok, false)
    assert.equal(parseHandoverSlotPatch({ capacity: 0 }).ok, false)

    assert.deepEqual(parseAdminHandoverCommand({ action: 'complete' }), { ok: true, value: { action: 'complete' } })
    assert.equal(parseAdminHandoverCommand({ action: 'complete', slotId: uuid('5eed5107') }).ok, false)
    assert.equal(parseAdminHandoverCommand({ action: 'reassign' }).ok, false)
    assert.equal(parseAdminHandoverCommand({ action: 'reassign', slotId: 'ABC' }).ok, false)
    assert.equal(parseAdminHandoverCommand({ action: 'delete' }).ok, false)
  })
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('the slot registers #24 and #28 as open admin routes, generate before :slotId', () => {
  assert.deepEqual(
    adminHandoverRoutes.map((entry) => [entry.path.join('/'), entry.gate, Object.keys(entry.handlers).sort()]),
    [
      ['bookings/:bookingId/handover', 'open', ['GET', 'PATCH']],
      ['handover-slots', 'open', ['GET', 'POST']],
      ['handover-slots/generate', 'open', ['POST']],
      ['handover-slots/:slotId', 'open', ['DELETE', 'PATCH']],
    ],
  )
})

// ---------------------------------------------------------------------------
// #28 handover slots
// ---------------------------------------------------------------------------

describe('#28 handover slots', () => {
  test('GET lists the Riyadh days asked for, with scheduled bookings only in bookedCount', async () => {
    const db = openDatabase()
    // 2026-10-04 00:00 Riyadh is 2026-10-03T21:00Z: inside; 21:00Z on 10-04 is 10-05 in Riyadh: outside.
    const inside = addSlot(db, { startsAt: '2026-10-03T21:00:00.000Z', capacity: 3 })
    addSlot(db, { startsAt: '2026-10-04T21:00:00.000Z' })
    addSlot(db, { startsAt: '2026-10-03T20:59:00.000Z' })
    addHandover(db, addBooking(db), inside)
    addHandover(db, addBooking(db), inside, { status: 'cancelled' })

    const { status, body } = await call(db, 'GET', 'handover-slots', {})
    assert.equal(status, 400)
    assert.equal(body.error.code, 'MISSING_DATE_RANGE')

    const listing = await route('handover-slots').handlers.GET({
      ...context(db, 'GET', 'handover-slots?from=2026-10-04&to=2026-10-04'),
    })
    const listed = await listing.json()
    assert.equal(listing.status, 200)
    assert.deepEqual(
      listed.slots.map((slot) => [slot.id, slot.slotDate, slot.bookedCount, slot.capacity, slot.isActive]),
      [[inside, '2026-10-04', 1, 3, true]],
    )
    assert.equal(listed.truncated, false)
  })

  test('GET is burst-limited per admin (RL_ADMIN_READ)', async () => {
    const db = openDatabase()
    const keys = []
    const limited = { limit: async ({ key }) => (keys.push(key), { success: false }) }
    const response = await route('handover-slots').handlers.GET(
      context(db, 'GET', 'handover-slots?from=2026-10-04&to=2026-10-04', { rateLimit: limited }),
    )
    assert.equal(response.status, 429)
    assert.deepEqual(keys, [ADMIN])
  })

  test('POST creates one slot with an audit row; the same start and method is 409 with no row', async () => {
    const db = openDatabase()
    const body = { startsAt: inHours(48), endsAt: inHours(49), method: 'pickup', capacity: 2 }
    const created = await call(db, 'POST', 'handover-slots', { body })
    assert.equal(created.status, 201)
    assert.equal(created.body.slot.capacity, 2)
    assert.equal(created.body.slot.bookedCount, 0)

    const again = await call(db, 'POST', 'handover-slots', { body })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'SLOT_ALREADY_EXISTS')
    assert.equal(count(db, 'SELECT COUNT(*) FROM handover_slots'), 1)

    const audit = auditRows(db)
    assert.equal(audit.length, 1)
    assert.equal(audit[0].action, 'handover_slot_created')
    assert.equal(audit[0].targetId, created.body.slot.id)
    assert.deepEqual(JSON.parse(audit[0].details), { ...body })

    const extraKey = await call(db, 'POST', 'handover-slots', { body: { ...body, isActive: true } })
    assert.equal(extraKey.status, 400)
  })

  function generateBody(overrides = {}) {
    const from = addDaysToDateKey(riyadhTodayKey(), 1)
    return {
      fromDate: from,
      toDate: addDaysToDateKey(from, 13),
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      times: [{ start: '16:00', end: '17:00' }, { start: '18:00', end: '19:00' }],
      method: 'pickup',
      capacity: 2,
      ...overrides,
    }
  }

  test('generate creates the new slots, skips the existing ones, and audits the counts once', async () => {
    const db = openDatabase()
    const body = generateBody()
    const first = await call(db, 'POST', 'handover-slots/generate', { body })
    assert.deepEqual([first.status, first.body], [200, { ok: true, created: 28, skipped: 0 }])

    const second = await call(db, 'POST', 'handover-slots/generate', {
      body: { ...body, toDate: addDaysToDateKey(body.fromDate, 14) },
    })
    assert.deepEqual(second.body, { ok: true, created: 2, skipped: 28 })
    assert.equal(count(db, 'SELECT COUNT(*) FROM handover_slots'), 30)
    assert.equal(count(db, "SELECT COUNT(*) FROM handover_slots WHERE capacity = 2 AND method = 'pickup'"), 30)

    const audit = auditRows(db)
    assert.deepEqual(
      audit.map((row) => [row.action, row.targetId, JSON.parse(row.details).created, JSON.parse(row.details).skipped]),
      [
        ['handover_slots_generated', null, 28, 0],
        ['handover_slots_generated', null, 2, 28],
      ],
    )
  })

  test('generate refuses more than 200 slots and writes nothing', async () => {
    const db = openDatabase()
    const times = Array.from({ length: 4 }, (_, index) => ({
      start: `${10 + index}:00`,
      end: `${10 + index}:30`,
    }))
    const body = generateBody({ times, toDate: addDaysToDateKey(generateBody().fromDate, 50) })
    const refused = await call(db, 'POST', 'handover-slots/generate', { body })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'TOO_MANY_SLOTS')
    assert.equal(count(db, 'SELECT COUNT(*) FROM handover_slots'), 0)
    assert.equal(auditRows(db).length, 0)
  })

  test('generate: a slot created after the read fails the whole batch, audit row included', async () => {
    const db = openDatabase()
    const body = generateBody({ toDate: generateBody().fromDate, times: [{ start: '16:00', end: '17:00' }] })
    const plan = planHandoverSlotGeneration(body, riyadhTodayKey())
    const planted = plan.value.slots[0].startsAt
    const result = await call(db, 'POST', 'handover-slots/generate', {
      body,
      beforeBatch: (database) => addSlot(database, { startsAt: planted }),
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.error.code, 'SLOT_CHANGED')
    assert.equal(count(db, 'SELECT COUNT(*) FROM handover_slots'), 1)
    assert.equal(auditRows(db).length, 0)
  })

  test('PATCH: a capacity decrease below the scheduled count changes nothing (counted inside the UPDATE)', async () => {
    const db = openDatabase()
    const slotId = addSlot(db, { startsAt: inHours(48), capacity: 3 })
    addHandover(db, addBooking(db), slotId)
    addHandover(db, addBooking(db), slotId, { status: 'no_show' })

    // A booking lands between any pre-read and the write: 2 scheduled now.
    const raced = await call(db, 'PATCH', 'handover-slots/:slotId', {
      params: { slotId },
      body: { capacity: 1 },
      beforeBatch: (database) => addHandover(database, addBooking(database), slotId),
    })
    assert.equal(raced.status, 409)
    assert.equal(raced.body.error.code, 'CAPACITY_BELOW_BOOKED')
    assert.equal(count(db, 'SELECT capacity FROM handover_slots WHERE id = ?', slotId), 3)
    assert.equal(auditRows(db).length, 0)

    const lowered = await call(db, 'PATCH', 'handover-slots/:slotId', {
      params: { slotId },
      body: { capacity: 2 },
    })
    assert.equal(lowered.status, 200)
    assert.deepEqual([lowered.body.slot.capacity, lowered.body.slot.bookedCount], [2, 2])

    const same = await call(db, 'PATCH', 'handover-slots/:slotId', { params: { slotId }, body: { capacity: 2 } })
    assert.equal(same.status, 200)

    const audit = auditRows(db)
    assert.deepEqual(
      audit.map((row) => [row.action, row.targetId, row.details]),
      [['handover_slot_updated', slotId, '{"capacity":2}']],
    )
  })

  test('PATCH: deactivation is refused while a handover is scheduled (inside the UPDATE)', async () => {
    const db = openDatabase()
    const slotId = addSlot(db, { startsAt: inHours(48), capacity: 2 })
    const refused = await call(db, 'PATCH', 'handover-slots/:slotId', {
      params: { slotId },
      body: { isActive: false },
      beforeBatch: (database) => addHandover(database, addBooking(database), slotId),
    })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'SLOT_HAS_BOOKINGS')
    assert.equal(count(db, 'SELECT is_active FROM handover_slots WHERE id = ?', slotId), 1)

    db.prepare("UPDATE handovers SET status = 'cancelled' WHERE slot_id = ?").run(slotId)
    const deactivated = await call(db, 'PATCH', 'handover-slots/:slotId', {
      params: { slotId },
      body: { isActive: false },
    })
    assert.equal(deactivated.status, 200)
    assert.equal(deactivated.body.slot.isActive, false)
    assert.deepEqual(auditRows(db).map((row) => row.details), ['{"isActive":false}'])

    const missing = await call(db, 'PATCH', 'handover-slots/:slotId', {
      params: { slotId: uuid('5eed5107') },
      body: { isActive: true },
    })
    assert.equal(missing.body.error.code, 'SLOT_NOT_FOUND')
  })

  test('DELETE removes only a slot no handover ever referenced', async () => {
    const db = openDatabase()
    const free = addSlot(db, { startsAt: inHours(48) })
    const used = addSlot(db, { startsAt: inHours(72) })
    addHandover(db, addBooking(db), used, { status: 'cancelled' })

    const refused = await call(db, 'DELETE', 'handover-slots/:slotId', { params: { slotId: used } })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'SLOT_HAS_BOOKINGS')

    const deleted = await call(db, 'DELETE', 'handover-slots/:slotId', { params: { slotId: free } })
    assert.deepEqual(deleted.body, { ok: true, deleted: true })
    const again = await call(db, 'DELETE', 'handover-slots/:slotId', { params: { slotId: free } })
    assert.deepEqual(again.body, { ok: true, deleted: false })
    const malformed = await call(db, 'DELETE', 'handover-slots/:slotId', { params: { slotId: 'nope' } })
    assert.deepEqual(malformed.body, { ok: true, deleted: false })

    assert.deepEqual(auditRows(db).map((row) => [row.action, row.targetId]), [['handover_slot_deleted', free]])
    assert.equal(count(db, 'SELECT COUNT(*) FROM handover_slots'), 1)
  })
})

// ---------------------------------------------------------------------------
// #24 admin handover
// ---------------------------------------------------------------------------

describe('#24 admin handover', () => {
  test('GET returns the booking and its handover with the delivery snapshot', async () => {
    const db = openDatabase()
    const bookingId = addBooking(db)
    const slotId = addSlot(db, { startsAt: inHours(24), method: 'both' })

    const none = await call(db, 'GET', 'bookings/:bookingId/handover', { params: { bookingId } })
    assert.deepEqual(none.body.handover, null)
    assert.equal(none.body.booking.status, 'confirmed')

    addHandover(db, bookingId, slotId, { method: 'delivery' })
    const { body } = await call(db, 'GET', 'bookings/:bookingId/handover', { params: { bookingId } })
    assert.equal(body.handover.method, 'delivery')
    assert.equal(body.handover.slot.id, slotId)
    assert.deepEqual(
      [body.handover.delivery.areaName, body.handover.delivery.fee, body.handover.delivery.addressPurged],
      ['الرياض', 150, false],
    )

    const unknown = await call(db, 'GET', 'bookings/:bookingId/handover', { params: { bookingId: 'unknown' } })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.body.error.code, 'BOOKING_NOT_FOUND')
  })

  test('complete stamps both completed_at columns with one instant in one batch; a repeat is a no-op', async () => {
    const db = openDatabase()
    const bookingId = addBooking(db)
    const slotId = addSlot(db, { startsAt: inHours(-1) })
    addHandover(db, bookingId, slotId)

    const done = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId },
      body: { action: 'complete' },
    })
    assert.equal(done.status, 200)
    assert.equal(done.body.handover.status, 'completed')
    const stamps = db
      .prepare(
        `SELECT h.completed_at AS handover, b.completed_at AS booking
         FROM handovers AS h JOIN booking_requests AS b ON b.id = h.booking_id WHERE b.id = ?`,
      )
      .get(bookingId)
    assert.ok(stamps.handover)
    assert.equal(stamps.handover, stamps.booking)
    assert.equal(done.body.booking.completedAt, stamps.booking)
    assert.deepEqual(
      events(db, bookingId).map((row) => [row.actor, row.actorUid, row.event]),
      [
        ['admin', ADMIN, 'handover_completed'],
        ['admin', ADMIN, 'booking_completed'],
      ],
    )
    assert.equal(events(db, bookingId)[0].subjectId, slotId)

    const repeat = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId },
      body: { action: 'complete' },
    })
    assert.equal(repeat.status, 200)
    assert.equal(repeat.body.handover.completedAt, stamps.handover)
    assert.equal(events(db, bookingId).length, 2)

    const moved = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId },
      body: { action: 'reassign', slotId: addSlot(db, { startsAt: inHours(30) }) },
    })
    assert.equal(moved.body.error.code, 'HANDOVER_ALREADY_COMPLETED')
  })

  test('complete refuses a booking that is not confirmed and writes nothing', async () => {
    const db = openDatabase()
    const bookingId = addBooking(db)
    addHandover(db, bookingId, addSlot(db, { startsAt: inHours(-1) }))
    db.prepare("UPDATE booking_requests SET status = 'cancelled' WHERE id = ?").run(bookingId)

    const refused = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId },
      body: { action: 'complete' },
    })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'BOOKING_NOT_CONFIRMED')
    assert.equal(count(db, 'SELECT COUNT(*) FROM booking_requests WHERE completed_at IS NOT NULL'), 0)
    assert.equal(events(db, bookingId).length, 0)
  })

  test('no_show only once the slot has started; cancel frees the place', async () => {
    const db = openDatabase()
    const early = addBooking(db)
    addHandover(db, early, addSlot(db, { startsAt: inHours(5) }))
    const tooEarly = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId: early },
      body: { action: 'no_show' },
    })
    assert.equal(tooEarly.body.error.code, 'HANDOVER_NOT_DUE')
    assert.equal(events(db, early).length, 0)

    const missed = addBooking(db)
    addHandover(db, missed, addSlot(db, { startsAt: inHours(-2) }))
    const noShow = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId: missed },
      body: { action: 'no_show' },
    })
    assert.equal(noShow.body.handover.status, 'no_show')
    assert.deepEqual(events(db, missed).map((row) => [row.event, row.details]), [
      ['handover_no_show', '{"fromStatus":"scheduled"}'],
    ])

    const cancelled = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId: early },
      body: { action: 'cancel' },
    })
    assert.equal(cancelled.body.handover.status, 'cancelled')
    assert.deepEqual(events(db, early).map((row) => row.event), ['handover_cancelled'])

    const none = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId: addBooking(db) },
      body: { action: 'cancel' },
    })
    assert.equal(none.body.error.code, 'HANDOVER_NOT_FOUND')
  })

  test('reassign: the capacity count is inside the UPDATE and excludes the booking itself', async () => {
    const db = openDatabase()
    const bookingId = addBooking(db)
    const from = addSlot(db, { startsAt: inHours(-3) })
    addHandover(db, bookingId, from, { status: 'no_show' })
    const target = addSlot(db, { startsAt: inHours(24), capacity: 1 })

    // Another bride takes the last place between any pre-read and the write.
    const raced = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId },
      body: { action: 'reassign', slotId: target },
      beforeBatch: (database) => addHandover(database, addBooking(database), target),
    })
    assert.equal(raced.status, 409)
    assert.equal(raced.body.error.code, 'SLOT_FULL')
    assert.equal(count(db, "SELECT COUNT(*) FROM handovers WHERE slot_id = ? AND status = 'scheduled'", target), 1)
    assert.equal(events(db, bookingId).length, 0)

    const roomy = addSlot(db, { startsAt: inHours(26), capacity: 1 })
    const moved = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId },
      body: { action: 'reassign', slotId: roomy },
    })
    assert.equal(moved.status, 200)
    assert.deepEqual([moved.body.handover.status, moved.body.handover.slot.id], ['scheduled', roomy])
    assert.deepEqual(events(db, bookingId).map((row) => [row.event, row.subjectId, JSON.parse(row.details)]), [
      ['handover_rescheduled', roomy, { fromSlotId: from, toSlotId: roomy, fromStatus: 'no_show' }],
    ])

    // Its own row is in the (full, capacity 1) slot: asking again is a no-op, not SLOT_FULL.
    const same = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId },
      body: { action: 'reassign', slotId: roomy },
    })
    assert.equal(same.status, 200)
    assert.equal(events(db, bookingId).length, 1)
  })

  test('reassign refuses an inactive, past, method-incompatible or unknown slot', async () => {
    const db = openDatabase()
    const bookingId = addBooking(db)
    addHandover(db, bookingId, addSlot(db, { startsAt: inHours(10), method: 'both' }), { method: 'delivery' })
    const cases = [
      [addSlot(db, { startsAt: inHours(30), active: 0 }), 'SLOT_UNAVAILABLE'],
      [addSlot(db, { startsAt: inHours(-30) }), 'SLOT_UNAVAILABLE'],
      [addSlot(db, { startsAt: inHours(40), method: 'pickup' }), 'SLOT_UNAVAILABLE'],
      [uuid('5eed5107'), 'SLOT_NOT_FOUND'],
    ]

    for (const [slotId, code] of cases) {
      const refused = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
        params: { bookingId },
        body: { action: 'reassign', slotId },
      })
      assert.equal(refused.body.error.code, code)
    }

    assert.equal(events(db, bookingId).length, 0)
    const ok = await call(db, 'PATCH', 'bookings/:bookingId/handover', {
      params: { bookingId },
      body: { action: 'reassign', slotId: addSlot(db, { startsAt: inHours(50), method: 'delivery' }) },
    })
    assert.equal(ok.status, 200)
  })
})
