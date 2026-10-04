// W2-07 / 11 §3.3 #23: album production status on /api/admin/bookings/{id}/production
// (worker/portal/production.ts, shared/portal/production.ts, worker/emails/album.ts).
// The handlers run against a database built from the repository's own migrations (node:sqlite,
// foreign keys on, as in D1) through a small stand-in for the D1 API: prepare().bind(), first(),
// run(), and batch() as one transaction that rolls back on the first failure. Each case fails if
// its control is taken out: the stage enum and exact key set, the confirmed and Riyadh
// event-passed rules inside the write, the compare-and-swap, the event only after a write, the
// album_ready email only when email is configured and only once per booking, the escaped copy,
// the open gate while private media is closed, and the admin read limit.
//
// Binding note: node:sqlite binds every number as REAL, so the stand-in binds safe integers as
// BigInt, as D1 binds a whole JavaScript number as INTEGER.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import { journeyAlbumStages } from '../shared/journey.ts'
import {
  PRODUCTION_STAGES,
  hasEventDayPassed,
  isAdminProductionResponse,
  isProductionStage,
} from '../shared/portal/production.ts'
import { addDaysToDateKey, riyadhTodayKey } from '../shared/timing.ts'
import { renderAlbumReadyEmail } from '../worker/emails/album.ts'
import { adminPortalRoutes } from '../worker/portal/admin-portal-routes.ts'
import { effectiveRouteGate, isRouteGateOpen } from '../worker/portal/gates.ts'
import { handleGetProduction, handlePutProduction } from '../worker/portal/production.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/

const ADMIN = 'AdminUid0001'
const BRIDE = 'BrideUid0001'
const BOOKING_ID = '5eedb00c-0000-4000-8000-000000000001'
const OTHER_ID = '5eedb00c-0000-4000-8000-000000000002'
const RESEND = { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test' }

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
     VALUES (?, ?, ?, 'تجريبي', '+447700900000', ?, ?)`,
  )

  addUser.run(ADMIN, 'admin@example.test', 'مديرة', 'admin', '2026-01-01T00:00:00.000Z')
  addUser.run(BRIDE, 'bride@example.test', 'سارة', 'customer', '2026-01-01T00:00:00.000Z')

  return db
}

/** `beforeBatch` runs raw SQL between the handler's read and its batch (a concurrent writer). */
function createD1(db, { beforeBatch } = {}) {
  function execute(statement) {
    const info = db.prepare(statement.sql).run(...statement.values.map(sqlValue))

    return { success: true, meta: { changes: Number(info.changes) }, results: [] }
  }

  function statement(sql, values) {
    return {
      sql,
      values,
      bind: (...next) => statement(sql, next),
      run: async () => execute({ sql, values }),
      first: async () => db.prepare(sql).get(...values.map(sqlValue)) ?? null,
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

function addBooking(db, id, { status = 'confirmed', eventDate = pastDate(3), userId = BRIDE } = {}) {
  const at = '2026-01-02T00:00:00.000Z'

  db.prepare(
    `INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', 4000, ?, ?)`,
  ).run(id, userId, eventDate, status, at, at)
}

function pastDate(days) {
  return addDaysToDateKey(riyadhTodayKey(), -days)
}

function context(env, { method = 'GET', bookingId = BOOKING_ID, body, contentType = 'application/json' } = {}) {
  const url = new URL(`https://example.test/api/admin/bookings/${bookingId}/production`)
  const init = { method, headers: {} }

  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['Content-Type'] = contentType
  }

  return {
    request: new Request(url, init),
    env,
    ctx: {},
    url,
    admin: { uid: ADMIN, authTime: Math.floor(Date.now() / 1000), secondFactor: null },
    params: { bookingId },
  }
}

function put(env, stage, options = {}) {
  return handlePutProduction(context(env, { method: 'PUT', body: { stage }, ...options }))
}

function events(db) {
  return db
    .prepare(`SELECT booking_id, actor, actor_uid, event, details FROM booking_events WHERE event = 'album_stage_changed' ORDER BY id`)
    .all()
    .map((row) => ({ ...row, details: JSON.parse(row.details) }))
}

function outbox(db) {
  return db.prepare('SELECT dedupe_key, booking_id, kind, recipient, payload, status FROM notification_log ORDER BY dedupe_key').all()
}

function stage(db, id = BOOKING_ID) {
  return db.prepare('SELECT stage FROM album_production WHERE booking_id = ?').get(id)?.stage ?? null
}

async function errorCode(response) {
  return (await response.json()).error.code
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('shared contract', () => {
  test('the stage enum is the journey album stages and the 0005 CHECK list', () => {
    assert.deepEqual([...PRODUCTION_STAGES], [...journeyAlbumStages])
    const schema = readFileSync(new URL('0005_portal_schema.sql', MIGRATIONS), 'utf8')
    assert.match(schema, /stage TEXT NOT NULL CHECK \(stage IN \('design', 'printing', 'ready'\)\)/)
    assert.equal(isProductionStage('ready'), true)
    assert.equal(isProductionStage('Ready'), false)
    assert.equal(isProductionStage('shipped'), false)
  })

  test('the event day has passed only after the Riyadh date of the event (N-59)', () => {
    // 21:30 UTC on 30 September is 00:30 on 1 October in Riyadh: the UTC date lags a day.
    const lateEvening = new Date('2026-09-30T21:30:00.000Z')
    assert.equal(riyadhTodayKey(lateEvening), '2026-10-01')
    assert.equal(hasEventDayPassed('2026-09-30', riyadhTodayKey(lateEvening)), true)
    assert.equal(hasEventDayPassed('2026-10-01', riyadhTodayKey(lateEvening)), false)
    assert.equal(hasEventDayPassed('2026-10-02', '2026-10-01'), false)
    assert.equal(hasEventDayPassed('not-a-date', '2026-10-01'), false)
  })

  test('the client guard accepts only a #23 success body', () => {
    assert.equal(isAdminProductionResponse({ ok: true, production: null }), true)
    assert.equal(
      isAdminProductionResponse({ ok: true, production: { stage: 'design', updatedAt: '2026-10-01T10:00:00.000Z' } }),
      true,
    )
    assert.equal(isAdminProductionResponse({ ok: true, production: { stage: 'x', updatedAt: '2026-10-01T10:00:00.000Z' } }), false)
    assert.equal(isAdminProductionResponse({ ok: true }), false)
    assert.equal(isAdminProductionResponse({ ok: false, production: null }), false)
  })
})

describe('route', () => {
  test('GET and PUT are registered on the production path, open while private media is gated', () => {
    const route = adminPortalRoutes.find((entry) => entry.path.join('/') === 'bookings/:bookingId/production')

    assert.ok(route)
    assert.equal(route.gate, 'open')
    assert.deepEqual(Object.keys(route.handlers).sort(), ['GET', 'PUT'])

    const gate = effectiveRouteGate(route, ['bookings', BOOKING_ID, 'production'])
    assert.equal(gate, 'open')
    // Production at go-live: online confirmation on, no PDPL sign-off, no bucket.
    assert.equal(isRouteGateOpen({ ONLINE_CONFIRMATION: 'on' }, gate), true)
  })
})

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

describe('PUT production', () => {
  test('the first stage creates the row and one album_stage_changed event; no email', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const env = { DB: createD1(db), ...RESEND }

    const response = await put(env, 'design')
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.production.stage, 'design')
    assert.equal(isAdminProductionResponse(body), true)
    assert.equal(stage(db), 'design')
    assert.deepEqual(events(db), [
      { booking_id: BOOKING_ID, actor: 'admin', actor_uid: ADMIN, event: 'album_stage_changed', details: { from: null, to: 'design' } },
    ])
    assert.deepEqual(outbox(db), [])
  })

  test('the same stage again is a no-op: 200, no event', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const env = { DB: createD1(db) }

    await put(env, 'printing')
    const first = events(db).length
    const response = await put(env, 'printing')

    assert.equal(response.status, 200)
    assert.equal((await response.json()).production.stage, 'printing')
    assert.equal(events(db).length, first)
  })

  test('a backward correction is allowed and recorded with its from and to', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const env = { DB: createD1(db) }

    await put(env, 'printing')
    const response = await put(env, 'design')

    assert.equal(response.status, 200)
    assert.deepEqual(events(db).map((row) => row.details), [
      { from: null, to: 'printing' },
      { from: 'printing', to: 'design' },
    ])
  })

  test('ready with email configured queues album_ready once, ever, under album_ready:<id>:once', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const env = { DB: createD1(db), ...RESEND, APP_BASE_URL: 'https://sundus.example' }

    await put(env, 'design')
    assert.equal((await put(env, 'ready')).status, 200)
    await put(env, 'printing')
    assert.equal((await put(env, 'ready')).status, 200)

    const rows = outbox(db)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].dedupe_key, `album_ready:${BOOKING_ID}:once`)
    assert.equal(rows[0].kind, 'album_ready')
    assert.equal(rows[0].status, 'pending')
    assert.equal(rows[0].recipient, 'bride@example.test')
    const payload = JSON.parse(rows[0].payload)
    assert.match(payload.subject, /ألبومكِ جاهز/)
    assert.match(payload.html, /my-bookings\?booking=5eedb00c/)
    assert.equal(events(db).length, 4)
  })

  test('ready without email configured (EM off) queues nothing but still records the change', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)

    assert.equal((await put({ DB: createD1(db) }, 'ready')).status, 200)
    assert.equal((await put({ DB: createD1(db), RESEND_API_KEY: 're_x', EMAIL_FROM: 'not an address' }, 'design')).status, 200)
    assert.equal((await put({ DB: createD1(db), RESEND_API_KEY: 're_x', EMAIL_FROM: 'not an address' }, 'ready')).status, 200)

    assert.deepEqual(outbox(db), [])
    assert.equal(events(db).length, 3)
  })

  test('no email to an address the Worker never verified', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    db.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').run(BRIDE)

    assert.equal((await put({ DB: createD1(db), ...RESEND }, 'ready')).status, 200)
    assert.deepEqual(outbox(db), [])
  })

  test('design and printing never queue an email', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const env = { DB: createD1(db), ...RESEND }

    await put(env, 'design')
    await put(env, 'printing')
    assert.deepEqual(outbox(db), [])
  })

  test('a booking that is not confirmed: 409 BOOKING_NOT_CONFIRMED, nothing written', async () => {
    for (const status of ['pending_review', 'approved_hold', 'cancelled', 'expired', 'rejected']) {
      const db = openDatabase()
      addBooking(db, BOOKING_ID, { status })

      const response = await put({ DB: createD1(db), ...RESEND }, 'ready')

      assert.equal(response.status, 409, status)
      assert.equal(await errorCode(response), 'BOOKING_NOT_CONFIRMED')
      assert.equal(stage(db), null)
      assert.deepEqual(events(db), [])
      assert.deepEqual(outbox(db), [])
    }
  })

  test('on the event day and before it (Riyadh date key): 409 EVENT_NOT_YET_HELD', async () => {
    for (const eventDate of [riyadhTodayKey(), addDaysToDateKey(riyadhTodayKey(), 5)]) {
      const db = openDatabase()
      addBooking(db, BOOKING_ID, { eventDate })

      const response = await put({ DB: createD1(db) }, 'design')

      assert.equal(response.status, 409)
      assert.equal(await errorCode(response), 'EVENT_NOT_YET_HELD')
      assert.equal(stage(db), null)
      assert.deepEqual(events(db), [])
    }
  })

  test('an unknown booking: 404 BOOKING_NOT_FOUND, the same body as a malformed id', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const env = { DB: createD1(db) }

    const unknown = await put(env, 'design', { bookingId: OTHER_ID })
    const tooLong = await put(env, 'design', { bookingId: 'a'.repeat(129) })

    assert.equal(unknown.status, 404)
    assert.equal(tooLong.status, 404)
    assert.deepEqual(await unknown.json(), await tooLong.json())
    assert.deepEqual(events(db), [])
  })

  test('the body: stage enum and exact key set (400), JSON only (415)', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const env = { DB: createD1(db) }

    for (const body of [{ stage: 'shipped' }, { stage: 'READY' }, { stage: 1 }, { stage: null }, {}, { stage: 'ready', note: 'x' }, []]) {
      const response = await handlePutProduction(context(env, { method: 'PUT', body }))
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal(await errorCode(response), 'INVALID_REQUEST_BODY')
    }

    const oversized = await handlePutProduction(
      context(env, { method: 'PUT', body: JSON.stringify({ stage: `ready${' '.repeat(400)}` }) }),
    )
    assert.equal(oversized.status, 400)

    const text = await handlePutProduction(context(env, { method: 'PUT', body: '{"stage":"ready"}', contentType: 'text/plain' }))
    assert.equal(text.status, 415)
    assert.equal(stage(db), null)
    assert.deepEqual(events(db), [])
  })

  test('a concurrent stage change between the read and the write: 409, no event, no email', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    await put({ DB: createD1(db) }, 'design')

    const racing = createD1(db, {
      beforeBatch: (raw) => raw.prepare("UPDATE album_production SET stage = 'printing' WHERE booking_id = ?").run(BOOKING_ID),
    })
    const response = await put({ DB: racing, ...RESEND }, 'ready')

    assert.equal(response.status, 409)
    assert.equal(await errorCode(response), 'PRODUCTION_STAGE_CHANGED')
    assert.equal(stage(db), 'printing')
    assert.equal(events(db).length, 1)
    assert.deepEqual(outbox(db), [])
  })

  test('a first stage racing another first stage: the loser changes nothing', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const now = new Date().toISOString()

    const racing = createD1(db, {
      beforeBatch: (raw) =>
        raw
          .prepare("INSERT INTO album_production (booking_id, stage, created_at, updated_at) VALUES (?, 'printing', ?, ?)")
          .run(BOOKING_ID, now, now),
    })
    const response = await put({ DB: racing, ...RESEND }, 'ready')

    assert.equal(response.status, 409)
    assert.equal(await errorCode(response), 'PRODUCTION_STAGE_CHANGED')
    assert.equal(stage(db), 'printing')
    assert.deepEqual(events(db), [])
    assert.deepEqual(outbox(db), [])
  })

  test('a status change between the read and the write is caught inside the statement', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    await put({ DB: createD1(db) }, 'design')

    const racing = createD1(db, {
      beforeBatch: (raw) => raw.prepare("UPDATE booking_requests SET status = 'cancelled' WHERE id = ?").run(BOOKING_ID),
    })
    const response = await put({ DB: racing, ...RESEND }, 'ready')

    assert.equal(response.status, 409)
    assert.equal(await errorCode(response), 'BOOKING_NOT_CONFIRMED')
    assert.equal(stage(db), 'design')
    assert.equal(events(db).length, 1)
    assert.deepEqual(outbox(db), [])
  })

  test('the same stage set concurrently answers 200 without a second event', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    await put({ DB: createD1(db) }, 'design')

    const racing = createD1(db, {
      beforeBatch: (raw) => raw.prepare("UPDATE album_production SET stage = 'printing' WHERE booking_id = ?").run(BOOKING_ID),
    })
    const response = await put({ DB: racing }, 'printing')

    assert.equal(response.status, 200)
    assert.equal((await response.json()).production.stage, 'printing')
    assert.equal(events(db).length, 1)
  })
})

describe('GET production', () => {
  test('null before the first stage, then the stored stage', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const env = { DB: createD1(db) }

    const before = await handleGetProduction(context(env))
    assert.equal(before.status, 200)
    assert.deepEqual(await before.json(), { ok: true, production: null })

    await put(env, 'printing')
    const after = await (await handleGetProduction(context(env))).json()
    assert.equal(after.production.stage, 'printing')
    assert.equal(isAdminProductionResponse(after), true)
  })

  test('an unknown booking answers 404 BOOKING_NOT_FOUND', async () => {
    const db = openDatabase()
    const response = await handleGetProduction(context({ DB: createD1(db) }, { bookingId: OTHER_ID }))

    assert.equal(response.status, 404)
    assert.equal(await errorCode(response), 'BOOKING_NOT_FOUND')
  })

  test('behind the admin read burst limit (RL_ADMIN_READ)', async () => {
    const db = openDatabase()
    addBooking(db, BOOKING_ID)
    const keys = []
    const limiter = { limit: async ({ key }) => (keys.push(key), { success: false }) }

    const response = await handleGetProduction(context({ DB: createD1(db), RL_ADMIN_READ: limiter }))

    assert.equal(response.status, 429)
    assert.equal(await errorCode(response), 'RATE_LIMITED')
    assert.deepEqual(keys, [ADMIN])
  })
})

// ---------------------------------------------------------------------------
// Email copy
// ---------------------------------------------------------------------------

describe('album_ready email', () => {
  test('her name and the reference are escaped and bidi-isolated; the date is formatted', () => {
    const email = renderAlbumReadyEmail({
      customerFirstName: '<img src=x onerror=alert(1)>‮سارة',
      bookingId: BOOKING_ID,
      eventDate: '2026-09-20',
      appBaseUrl: 'https://sundus.example',
    })

    assert.doesNotMatch(email.html, /<img/)
    assert.match(email.html, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.doesNotMatch(email.html, /‮/)
    assert.doesNotMatch(email.text, /‮/)
    assert.match(email.text, /⁨.*سارة⁩/)
    assert.match(email.subject, new RegExp(`^ألبومكِ جاهز! احجزي موعد الاستلام — ${BOOKING_ID}$`))
    assert.match(email.text, /2026/)
    assert.doesNotMatch(email.text, /2026-09-20/)
  })

  test('without APP_BASE_URL the email is complete, with no button', () => {
    const email = renderAlbumReadyEmail({
      customerFirstName: '',
      bookingId: BOOKING_ID,
      eventDate: '2026-09-20',
      appBaseUrl: undefined,
    })

    assert.doesNotMatch(email.html, /<a href=/)
    assert.match(email.text, /^أهلًا، ألبومكِ أصبح جاهزًا/m)
    assert.match(email.text, /صفحة حجوزاتي في موقعنا/)
  })
})
