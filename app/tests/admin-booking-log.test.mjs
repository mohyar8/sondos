// W2-05 / TM-07, UX-06, SB-2, SB-7, SB-13, SB-18: the admin booking timeline
// and contact log (worker/portal/admin-booking-log.ts, #20, #21) and the
// audit log, session and sign-out-everywhere routes
// (worker/audit/admin-audit-handlers.ts, #39, #40, #44).
//
// The handlers run against a database built from the repository's own
// migrations (node:sqlite, foreign keys on, as in D1) through a small
// stand-in for the D1 API: prepare().bind(), first(), all(), run(), and
// batch() as one transaction that rolls back on the first failure. The
// admin guard itself (AD) is the dispatcher's and is covered by
// tests/portal-routes.test.mjs; here the handlers get an admin the guard
// would have let through, and the revocation is checked against the guard's
// own predicate (worker/admin-auth.ts readAdminBinding).
//
// Binding note: node:sqlite binds every number as REAL, so the stand-in binds
// safe integers as BigInt, as D1 binds a whole JavaScript number as INTEGER.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'

import { SignJWT, exportJWK, generateKeyPair } from 'jose'

import { ADMIN_SESSION_MAX_AGE_SECONDS, RECENT_SIGN_IN_GUARD_SECONDS } from '../shared/admin-session.ts'
import {
  ADMIN_ACCOUNT_SQL,
  AUDIT_LOG_MAX_LIMIT,
  handleAdminAuditLog,
  handleAdminSession,
  handleRevokeAllSessions,
  parseAuditLogQuery,
} from '../worker/audit/admin-audit-handlers.ts'
import {
  BOOKING_LOG_SQL,
  CONTACT_LOG_MAX_PER_HOUR,
  TIMELINE_MAX_ENTRIES,
  adminContactTemplateIds,
  contactLogEventByOutcome,
  filterEventDetails,
  handleAdminContactLog,
  handleAdminTimeline,
} from '../worker/portal/admin-booking-log.ts'
import { dispatchAdminPortalRequest } from '../worker/portal/admin-portal-routes.ts'
import { adminAuditRoutes } from '../worker/portal/slots/admin-audit.ts'
import { adminBookingLogRoutes } from '../worker/portal/slots/admin-booking-log.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

const ADMIN = 'AdminUid0001'
const CUSTOMER = 'CustomerUid0001'
const BOOKING_ID = '5eedb00c-0000-4000-8000-000000000001'
const OTHER_BOOKING_ID = '5eedb00c-0000-4000-8000-000000000002'
const RECEIPT_ID = '5eed4ece-0000-4000-8000-000000000001'
const MINUTE = 60

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

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

  const addBooking = db.prepare(
    `INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total)
     VALUES (?, ?, ?, 'pending_review', '{}', 4000)`,
  )

  addBooking.run(BOOKING_ID, CUSTOMER, '2026-11-20')
  addBooking.run(OTHER_BOOKING_ID, CUSTOMER, '2026-11-21')

  return db
}

function returnsRows(sql) {
  return /^\s*SELECT\b/i.test(sql) || /\bRETURNING\b/i.test(sql)
}

function createD1(db) {
  function execute(statement) {
    const prepared = db.prepare(statement.sql)
    const values = statement.values.map(sqlValue)

    if (returnsRows(statement.sql)) {
      const results = prepared.all(...values)
      return { success: true, results, meta: { changes: results.length } }
    }

    const info = prepared.run(...values)
    return { success: true, results: [], meta: { changes: Number(info.changes) } }
  }

  function statement(sql, values) {
    const prepared = {
      sql,
      values,
      bind: (...next) => statement(sql, next),
      async run() {
        return execute(prepared)
      },
      async all() {
        return execute(prepared)
      },
      async first(column) {
        const row = returnsRows(sql)
          ? db.prepare(sql).get(...prepared.values.map(sqlValue))
          : execute(prepared).results[0]

        if (row === undefined) {
          return null
        }

        return column === undefined ? { ...row } : row[column]
      },
    }

    return prepared
  }

  return {
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
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

/** A `ratelimits` binding stand-in that records its keys. */
function limiter(success = true) {
  const keys = []
  return {
    keys,
    async limit({ key }) {
      keys.push(key)
      return { success }
    },
  }
}

function context(db, { path = '/api/admin/audit-log', params = {}, request, admin, rateLimit } = {}) {
  const url = new URL(`https://example.test${path}`)

  return {
    request: request ?? new Request(url),
    env: { DB: createD1(db), RL_ADMIN_READ: rateLimit ?? limiter() },
    ctx: { waitUntil() {}, passThroughOnException() {} },
    url,
    admin: admin ?? { uid: ADMIN, authTime: nowSeconds() - MINUTE, secondFactor: null },
    params,
  }
}

async function body(response) {
  return JSON.parse(await response.text())
}

function postJson(path, value, headers = {}) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof value === 'string' ? value : JSON.stringify(value),
  })
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

describe('slot registrations (W2-05)', () => {
  test('the booking-log slot registers exactly #20 and #21, open gate', () => {
    assert.deepEqual(
      adminBookingLogRoutes.map((route) => [route.path.join('/'), route.gate, Object.keys(route.handlers)]),
      [
        ['bookings/:bookingId/timeline', 'open', ['GET']],
        ['bookings/:bookingId/contact-log', 'open', ['POST']],
      ],
    )
  })

  test('the audit slot registers exactly #39, #40 and #44, open gate', () => {
    assert.deepEqual(
      adminAuditRoutes.map((route) => [route.path.join('/'), route.gate, Object.keys(route.handlers)]),
      [
        ['audit-log', 'open', ['GET']],
        ['session', 'open', ['GET']],
        ['session/revoke-all', 'open', ['POST']],
      ],
    )
  })
})

// ---------------------------------------------------------------------------
// #20 timeline
// ---------------------------------------------------------------------------

function seedTimeline(db) {
  db.prepare(
    `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
     VALUES (?, NULL, 'pending_review', ?, NULL, '2026-10-01 09:00:00')`,
  ).run(BOOKING_ID, CUSTOMER)
  db.prepare(
    `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
     VALUES (?, 'pending_review', 'approved_hold', ?, 'تمت الموافقة', '2026-10-02T10:00:00.000Z')`,
  ).run(BOOKING_ID, ADMIN)
  db.prepare(
    `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
     VALUES (?, 'approved_hold', 'expired', NULL, NULL, '2026-10-05T10:00:00.000Z')`,
  ).run(BOOKING_ID)

  const addEvent = db.prepare(
    `INSERT INTO booking_events (booking_id, actor, actor_uid, event, subject_id, details, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  // Details with keys outside the allowlist and free text in allowed keys.
  addEvent.run(
    BOOKING_ID,
    'customer',
    null,
    'receipt_submitted',
    RECEIPT_ID,
    JSON.stringify({ receiptId: RECEIPT_ID, name: 'سارة', phone: '+966500000000', stage: 'حي الملقا' }),
    null,
    '2026-10-03T10:00:00.000Z',
  )
  addEvent.run(
    BOOKING_ID,
    'admin',
    ADMIN,
    'deposit_recorded',
    null,
    JSON.stringify({ amount: 1000, channel: 'whatsapp', __proto__x: 1 }),
    'ملاحظة داخلية',
    '2026-10-04T10:00:00.000Z',
  )
  addEvent.run(
    BOOKING_ID,
    'admin',
    ADMIN,
    'internal_notes_updated',
    null,
    null,
    'ملاحظة ستُحجب',
    '2026-10-04T11:00:00.000Z',
  )
  db.prepare(
    `UPDATE booking_events SET note = NULL, redacted_at = '2026-10-06T00:00:00.000Z'
     WHERE event = 'internal_notes_updated'`,
  ).run()
  // Another booking's event never shows.
  addEvent.run(OTHER_BOOKING_ID, 'system', null, 'hold_extended', null, null, null, '2026-10-04T12:00:00.000Z')

  db.prepare(
    `INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, created_at, updated_at, finished_at)
     VALUES ('hold_reminder_24h:a', ?, 'hold_reminder_24h', NULL, NULL, 'sent',
             '2026-10-04T09:00:00.000Z', '2026-10-04T09:01:00.000Z', '2026-10-04T09:01:00.000Z')`,
  ).run(BOOKING_ID)
  db.prepare(
    `INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, created_at, updated_at)
     VALUES ('hold_expired:a', ?, 'hold_expired', 'bride@example.test', '{"subject":"secret payload"}', 'pending',
             '2026-10-05T10:00:01.000Z', '2026-10-05T10:00:01.000Z')`,
  ).run(BOOKING_ID)
}

describe('GET /api/admin/bookings/{id}/timeline (#20)', () => {
  test('merges status history, events and notifications, newest first', async () => {
    const db = openDatabase()
    seedTimeline(db)

    const response = await handleAdminTimeline(context(db, { params: { bookingId: BOOKING_ID } }))
    const answer = await body(response)

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual(
      answer.entries.map((entry) => [entry.source, entry.at]),
      [
        ['notification', '2026-10-05T10:00:01.000Z'],
        ['status', '2026-10-05T10:00:00.000Z'],
        ['event', '2026-10-04T11:00:00.000Z'],
        ['event', '2026-10-04T10:00:00.000Z'],
        ['notification', '2026-10-04T09:00:00.000Z'],
        ['event', '2026-10-03T10:00:00.000Z'],
        ['status', '2026-10-02T10:00:00.000Z'],
        ['status', '2026-10-01T09:00:00.000Z'],
      ],
    )

    const statuses = answer.entries.filter((entry) => entry.source === 'status')
    assert.deepEqual(
      statuses.map((entry) => [entry.fromStatus, entry.toStatus, entry.by, entry.note]),
      [
        ['approved_hold', 'expired', 'system', null],
        ['pending_review', 'approved_hold', 'admin', 'تمت الموافقة'],
        [null, 'pending_review', 'customer', null],
      ],
    )
  })

  test('never returns a recipient, a payload, a uid or a non-allowlisted detail', async () => {
    const db = openDatabase()
    seedTimeline(db)

    const text = await (await handleAdminTimeline(context(db, { params: { bookingId: BOOKING_ID } }))).text()

    for (const secret of ['bride@example.test', 'secret payload', 'recipient', 'payload', ADMIN, CUSTOMER, 'سارة', '+966500000000', 'حي الملقا', '__proto__x']) {
      assert.equal(text.includes(secret), false, secret)
    }

    const entries = JSON.parse(text).entries
    const receipt = entries.find((entry) => entry.event === 'receipt_submitted')
    assert.deepEqual(receipt.details, { receiptId: RECEIPT_ID })
    assert.equal(receipt.subjectId, RECEIPT_ID)
    assert.deepEqual(entries.find((entry) => entry.event === 'deposit_recorded').details, { amount: 1000, channel: 'whatsapp' })

    const notification = entries.find((entry) => entry.kind === 'hold_reminder_24h')
    assert.deepEqual(Object.keys(notification).sort(), ['at', 'finishedAt', 'kind', 'source', 'status'])
  })

  test('a redacted note stays hidden; an unredacted event note is shown', async () => {
    const db = openDatabase()
    seedTimeline(db)

    const { entries } = await body(await handleAdminTimeline(context(db, { params: { bookingId: BOOKING_ID } })))
    const redacted = entries.find((entry) => entry.event === 'internal_notes_updated')

    assert.equal(redacted.note, null)
    assert.equal(redacted.redacted, true)
    assert.equal(entries.find((entry) => entry.event === 'deposit_recorded').note, 'ملاحظة داخلية')
  })

  test('the SQL never selects recipient or payload', () => {
    assert.doesNotMatch(BOOKING_LOG_SQL.notifications, /recipient|payload/)
    assert.doesNotMatch(BOOKING_LOG_SQL.events, /actor_uid/)
  })

  test('at most 300 entries, the newest ones', async () => {
    const db = openDatabase()
    const addEvent = db.prepare(
      `INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, created_at)
       VALUES (?, 'admin', ?, 'admin_whatsapp_opened', '{"template":"hold_reminder"}', ?)`,
    )

    db.exec('BEGIN')
    for (let index = 0; index < 250; index += 1) {
      addEvent.run(BOOKING_ID, ADMIN, new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString())
    }
    const addHistory = db.prepare(
      `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, created_at)
       VALUES (?, 'pending_review', 'pending_review', ?, ?)`,
    )
    for (let index = 0; index < 250; index += 1) {
      addHistory.run(BOOKING_ID, ADMIN, new Date(Date.UTC(2026, 9, 1) + index * 60_000 + 30_000).toISOString())
    }
    db.exec('COMMIT')

    const { entries } = await body(await handleAdminTimeline(context(db, { params: { bookingId: BOOKING_ID } })))

    assert.equal(entries.length, TIMELINE_MAX_ENTRIES)
    assert.equal(entries[0].at, new Date(Date.UTC(2026, 9, 1) + 249 * 60_000 + 30_000).toISOString())
    const sorted = [...entries].sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0))
    assert.deepEqual(entries.map((entry) => entry.at), sorted.map((entry) => entry.at))
    // 500 rows exist; the oldest 200 are left out.
    assert.equal(entries.at(-1).at, new Date(Date.UTC(2026, 9, 1) + 100 * 60_000).toISOString())
  })

  test('an unknown booking is 404 BOOKING_NOT_FOUND', async () => {
    const db = openDatabase()
    const response = await handleAdminTimeline(context(db, { params: { bookingId: 'no-such-booking' } }))

    assert.equal(response.status, 404)
    assert.equal((await body(response)).error.code, 'BOOKING_NOT_FOUND')
  })

  test('the admin read burst is keyed by the admin uid and answers 429', async () => {
    const db = openDatabase()
    const rateLimit = limiter(false)
    const response = await handleAdminTimeline(context(db, { params: { bookingId: BOOKING_ID }, rateLimit }))

    assert.equal(response.status, 429)
    assert.equal(response.headers.get('Retry-After'), '60')
    assert.deepEqual(rateLimit.keys, [ADMIN])
  })
})

describe('filterEventDetails (key allowlist)', () => {
  test('keeps only allowlisted keys with their shape', () => {
    assert.deepEqual(
      filterEventDetails(
        JSON.stringify({
          template: 'hold_reminder',
          from: 'design',
          to: 'printing',
          amount: 1500,
          holdExpiresAt: '2026-10-05T10:00:00.000Z',
          termsVersion: 'v2',
          changed: ['venueName', 'startTime'],
        }),
      ),
      {
        template: 'hold_reminder',
        from: 'design',
        to: 'printing',
        amount: 1500,
        holdExpiresAt: '2026-10-05T10:00:00.000Z',
        termsVersion: 'v2',
        changed: ['venueName', 'startTime'],
      },
    )
  })

  test('drops free text, bad shapes and unknown keys', () => {
    assert.equal(
      filterEventDetails(
        JSON.stringify({
          template: 'not_a_template',
          from: 'two words',
          amount: -1,
          holdExpiresAt: '2026-10-05',
          changed: ['ok', 'not ok'],
          venueName: 'قاعة',
          note: 'hello',
        }),
      ),
      null,
    )
    assert.equal(filterEventDetails('{"__proto__":{"template":"hold_reminder"}}'), null)
    assert.equal(filterEventDetails('[1,2]'), null)
    assert.equal(filterEventDetails('not json'), null)
    assert.equal(filterEventDetails(null), null)
  })
})

// ---------------------------------------------------------------------------
// #21 contact log
// ---------------------------------------------------------------------------

function contactRequest(value, headers) {
  return postJson(`/api/admin/bookings/${BOOKING_ID}/contact-log`, value, headers)
}

function contactContext(db, value, options = {}) {
  return context(db, {
    params: { bookingId: options.bookingId ?? BOOKING_ID },
    request: contactRequest(value, options.headers),
  })
}

describe('POST /api/admin/bookings/{id}/contact-log (#21)', () => {
  test('each outcome writes its event with {"template"} only, by the admin, on the SQL clock', async () => {
    for (const [outcome, event] of Object.entries(contactLogEventByOutcome)) {
      const db = openDatabase()
      const before = new Date().toISOString()
      const response = await handleAdminContactLog(contactContext(db, { template: 'hold_reminder', outcome }))
      const answer = await body(response)

      assert.equal(response.status, 200, outcome)
      assert.equal(answer.contact.event, event)
      assert.equal(answer.contact.outcome, outcome)

      const rows = db.prepare('SELECT * FROM booking_events').all()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].event, event)
      assert.equal(rows[0].actor, 'admin')
      assert.equal(rows[0].actor_uid, ADMIN)
      assert.equal(rows[0].booking_id, BOOKING_ID)
      assert.equal(rows[0].details, '{"template":"hold_reminder"}')
      assert.equal(rows[0].note, null)
      assert.equal(rows[0].created_at, answer.contact.recordedAt)
      assert.ok(rows[0].created_at >= before.slice(0, 19))
    }
  })

  test('the outcome map is exactly the plan\'s (UX-06)', () => {
    assert.deepEqual({ ...contactLogEventByOutcome }, {
      opened: 'admin_whatsapp_opened',
      sent: 'admin_whatsapp_sent',
      dismissed: 'admin_queue_dismissed',
    })
  })

  test('refuses unknown templates, outcomes, extra or missing keys and non-JSON', async () => {
    const cases = [
      { template: 'free text', outcome: 'sent' },
      { template: 'hold_reminder', outcome: 'deleted' },
      { template: 'hold_reminder', outcome: 'sent', note: 'x' },
      { template: 'hold_reminder' },
      { template: ['hold_reminder'], outcome: 'sent' },
      { template: 'constructor', outcome: 'toString' },
      '[]',
      'not json',
    ]

    for (const value of cases) {
      const db = openDatabase()
      const response = await handleAdminContactLog(contactContext(db, value))

      assert.equal(response.status, 400, JSON.stringify(value))
      assert.equal((await body(response)).error.code, 'INVALID_REQUEST_BODY')
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_events').get().n, 0)
    }

    const db = openDatabase()
    const wrongType = await handleAdminContactLog(
      contactContext(db, { template: 'hold_reminder', outcome: 'sent' }, { headers: { 'Content-Type': 'text/plain' } }),
    )
    assert.equal(wrongType.status, 415)

    const oversized = await handleAdminContactLog(
      contactContext(db, { template: 'hold_reminder', outcome: 'sent', pad: 'x'.repeat(400) }),
    )
    assert.equal(oversized.status, 400)
  })

  test('an unknown booking is 404 and writes nothing', async () => {
    const db = openDatabase()
    const response = await handleAdminContactLog(
      contactContext(db, { template: 'hold_reminder', outcome: 'sent' }, { bookingId: 'no-such-booking' }),
    )

    assert.equal(response.status, 404)
    assert.equal((await body(response)).error.code, 'BOOKING_NOT_FOUND')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_events').get().n, 0)
  })

  test('the per-booking cap inside the INSERT answers 429 and writes nothing more', async () => {
    const db = openDatabase()

    for (let index = 0; index < CONTACT_LOG_MAX_PER_HOUR; index += 1) {
      const response = await handleAdminContactLog(contactContext(db, { template: 'hold_reminder', outcome: 'opened' }))
      assert.equal(response.status, 200)
    }

    const refused = await handleAdminContactLog(contactContext(db, { template: 'hold_reminder', outcome: 'sent' }))
    assert.equal(refused.status, 429)
    assert.equal(refused.headers.get('Retry-After'), '3600')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_events').get().n, CONTACT_LOG_MAX_PER_HOUR)

    // Another booking has its own allowance; rows older than an hour do not count.
    const other = await handleAdminContactLog(
      contactContext(db, { template: 'hold_reminder', outcome: 'sent' }, { bookingId: OTHER_BOOKING_ID }),
    )
    assert.equal(other.status, 200)
  })

  test('rows older than the window do not count toward the cap', async () => {
    const db = openDatabase()
    const old = db.prepare(
      `INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, created_at)
       VALUES (?, 'admin', ?, 'admin_whatsapp_opened', '{"template":"hold_reminder"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'))`,
    )
    for (let index = 0; index < CONTACT_LOG_MAX_PER_HOUR; index += 1) {
      old.run(BOOKING_ID, ADMIN)
    }

    const response = await handleAdminContactLog(contactContext(db, { template: 'hold_reminder', outcome: 'sent' }))
    assert.equal(response.status, 200)
  })

  test('the template list is W2-14\'s closed list', () => {
    assert.deepEqual([...adminContactTemplateIds].sort(), [
      'album_ready',
      'approved_legacy',
      'approved_online',
      'deposit_recorded',
      'event_details_request',
      'event_reminder',
      'feedback_request',
      'handover_confirmation',
      'handover_day',
      'hold_reminder',
      'offline_selection',
      'production_update',
      'request_received',
      'terms_reminder',
    ])

    const spa = new URL('../src/features/admin-contact/whatsapp-templates.ts', import.meta.url)

    if (existsSync(spa)) {
      const source = readFileSync(spa, 'utf8')

      for (const id of adminContactTemplateIds) {
        assert.ok(source.includes(`'${id}'`) || source.includes(`${id}:`), id)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// #39 audit log
// ---------------------------------------------------------------------------

function seedAudit(db, count) {
  const add = db.prepare(
    `INSERT INTO admin_audit_log (actor_uid, action, target_id, details, reauth_at, created_at)
     VALUES (?, 'bookings_exported', NULL, '{"from":"2026-10-01","to":"2026-10-31","status":null,"rows":3}', NULL, ${SQL_NOW})`,
  )
  for (let index = 0; index < count; index += 1) {
    add.run(ADMIN)
  }
}

describe('GET /api/admin/audit-log (#39)', () => {
  test('newest first with a keyset cursor over the id, no actor uid', async () => {
    const db = openDatabase()
    seedAudit(db, 5)

    const first = await body(await handleAdminAuditLog(context(db, { path: '/api/admin/audit-log?limit=2' })))
    assert.deepEqual(first.entries.map((entry) => entry.id), [5, 4])
    assert.equal(first.nextCursor, '4')
    assert.deepEqual(Object.keys(first.entries[0]).sort(), ['action', 'createdAt', 'details', 'id', 'reauthAt', 'targetId'])
    assert.deepEqual(first.entries[0].details, { from: '2026-10-01', to: '2026-10-31', status: null, rows: 3 })

    const second = await body(await handleAdminAuditLog(context(db, { path: '/api/admin/audit-log?limit=2&cursor=4' })))
    assert.deepEqual(second.entries.map((entry) => entry.id), [3, 2])

    const last = await body(await handleAdminAuditLog(context(db, { path: '/api/admin/audit-log?limit=2&cursor=2' })))
    assert.deepEqual(last.entries.map((entry) => entry.id), [1])
    assert.equal(last.nextCursor, null)

    const all = await body(await handleAdminAuditLog(context(db)))
    assert.equal(all.entries.length, 5)
    assert.equal(all.nextCursor, null)
  })

  test('validates the cursor, the limit and the query keys before any SQL', async () => {
    const invalid = {
      'cursor=0': 'INVALID_CURSOR',
      'cursor=-1': 'INVALID_CURSOR',
      'cursor=01': 'INVALID_CURSOR',
      'cursor=1.5': 'INVALID_CURSOR',
      'cursor=1e3': 'INVALID_CURSOR',
      'cursor=9999999999999999': 'INVALID_CURSOR',
      'cursor=': 'INVALID_CURSOR',
      'cursor=%20%31': 'INVALID_CURSOR',
      'limit=0': 'INVALID_LIMIT',
      [`limit=${AUDIT_LOG_MAX_LIMIT + 1}`]: 'INVALID_LIMIT',
      'limit=abc': 'INVALID_LIMIT',
      'limit=': 'INVALID_LIMIT',
      'cursor=1&cursor=2': 'INVALID_QUERY',
      'offset=5': 'INVALID_QUERY',
    }

    for (const [query, code] of Object.entries(invalid)) {
      const parsed = parseAuditLogQuery(new URL(`https://example.test/api/admin/audit-log?${query}`))
      assert.equal(parsed.ok, false, query)
      assert.equal(parsed.response.status, 400, query)
      assert.equal((await body(parsed.response)).error.code, code, query)
    }

    assert.deepEqual(parseAuditLogQuery(new URL('https://example.test/x?limit=100&cursor=42')), {
      ok: true,
      query: { cursor: 42, limit: 100 },
    })
  })

  test('the admin read burst answers 429', async () => {
    const db = openDatabase()
    const response = await handleAdminAuditLog(context(db, { rateLimit: limiter(false) }))
    assert.equal(response.status, 429)
  })
})

// ---------------------------------------------------------------------------
// #40 session
// ---------------------------------------------------------------------------

describe('GET /api/admin/session (#40)', () => {
  test('reports the session windows from auth_time, idleMinutes 30', async () => {
    const db = openDatabase()
    const authTime = nowSeconds() - 5 * MINUTE
    const answer = await body(
      await handleAdminSession(context(db, { admin: { uid: ADMIN, authTime, secondFactor: 'totp' } })),
    )

    assert.equal(answer.ok, true)
    assert.deepEqual(answer.admin, {
      uid: ADMIN,
      authTime: new Date(authTime * 1000).toISOString(),
      reauthFreshUntil: new Date((authTime + RECENT_SIGN_IN_GUARD_SECONDS) * 1000).toISOString(),
      sessionFreshUntil: new Date((authTime + ADMIN_SESSION_MAX_AGE_SECONDS) * 1000).toISOString(),
      secondFactor: 'totp',
    })
    assert.equal(answer.idleMinutes, 30)
    assert.ok(Math.abs(Date.parse(answer.serverTime) - Date.now()) < 5_000)
  })

  test('an unknown second-factor claim is reported as null', async () => {
    const db = openDatabase()
    const answer = await body(
      await handleAdminSession(
        context(db, { admin: { uid: ADMIN, authTime: nowSeconds(), secondFactor: 'webauthn' } }),
      ),
    )
    assert.equal(answer.admin.secondFactor, null)
  })
})

// ---------------------------------------------------------------------------
// #44 revoke-all
// ---------------------------------------------------------------------------

/** worker/admin-auth.ts readAdminBinding's revocation predicate, verbatim. */
function signedInAfterRevocation(db, authTime) {
  return db
    .prepare(
      'SELECT (tokens_valid_after IS NULL OR tokens_valid_after <= ?) AS ok FROM users WHERE id = ?',
    )
    .get(BigInt(authTime), ADMIN).ok
}

function revokeContext(db, authTime) {
  return context(db, {
    path: '/api/admin/session/revoke-all',
    request: new Request('https://example.test/api/admin/session/revoke-all', { method: 'POST' }),
    admin: { uid: ADMIN, authTime, secondFactor: null },
  })
}

describe('POST /api/admin/session/revoke-all (#44)', () => {
  test('stamps tokens_valid_after from SQL now and writes admin_sessions_revoked', async () => {
    const db = openDatabase()
    const authTime = nowSeconds() - 2 * MINUTE
    assert.equal(signedInAfterRevocation(db, authTime), 1)

    const response = await handleRevokeAllSessions(revokeContext(db, authTime))
    assert.equal(response.status, 200)
    assert.deepEqual(await body(response), { ok: true, revoked: true })

    const { tokens_valid_after: mark, sqlNow } = db
      .prepare('SELECT tokens_valid_after, unixepoch() AS sqlNow FROM users WHERE id = ?')
      .get(ADMIN)
    assert.ok(mark >= sqlNow - 2 && mark <= sqlNow, 'the mark is D1 now')

    // The caller's own token (and every earlier sign-in) is refused by the guard's predicate.
    assert.equal(signedInAfterRevocation(db, authTime), 0)
    assert.equal(signedInAfterRevocation(db, mark), 1)

    const audit = db.prepare('SELECT * FROM admin_audit_log').all()
    assert.equal(audit.length, 1)
    assert.equal(audit[0].action, 'admin_sessions_revoked')
    assert.equal(audit[0].actor_uid, ADMIN)
    assert.equal(audit[0].target_id, null)
    assert.equal(audit[0].details, null)
    assert.equal(audit[0].reauth_at, new Date(authTime * 1000).toISOString())
  })

  test('refuses the caller\'s token even when its sign-in is in the same second as D1 now', async () => {
    const db = openDatabase()
    const authTime = db.prepare('SELECT unixepoch() AS now').get().now

    assert.equal((await handleRevokeAllSessions(revokeContext(db, authTime))).status, 200)
    assert.equal(signedInAfterRevocation(db, authTime), 0)
  })

  test('never moves the mark back', async () => {
    const db = openDatabase()
    const future = nowSeconds() + 3600
    db.prepare('UPDATE users SET tokens_valid_after = ? WHERE id = ?').run(BigInt(future), ADMIN)

    assert.equal((await handleRevokeAllSessions(revokeContext(db, nowSeconds() - MINUTE))).status, 200)
    assert.equal(db.prepare('SELECT tokens_valid_after AS t FROM users WHERE id = ?').get(ADMIN).t, future)
  })

  test('AD+R: a sign-in older than the recent window gets 403 REAUTH_REQUIRED and changes nothing', async () => {
    const db = openDatabase()
    const response = await handleRevokeAllSessions(revokeContext(db, nowSeconds() - RECENT_SIGN_IN_GUARD_SECONDS - 5))

    assert.equal(response.status, 403)
    assert.equal((await body(response)).error.code, 'REAUTH_REQUIRED')
    assert.equal(db.prepare('SELECT tokens_valid_after AS t FROM users WHERE id = ?').get(ADMIN).t, null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_audit_log').get().n, 0)
  })

  test('a row that is no longer the admin writes nothing and answers 403 FORBIDDEN', async () => {
    const db = openDatabase()
    db.prepare("UPDATE users SET role = 'customer' WHERE id = ?").run(ADMIN)

    const response = await handleRevokeAllSessions(revokeContext(db, nowSeconds() - MINUTE))
    assert.equal(response.status, 403)
    assert.equal((await body(response)).error.code, 'FORBIDDEN')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_audit_log').get().n, 0)
  })

  test('the SQL stamps from unixepoch() and never lowers the mark', () => {
    assert.match(ADMIN_ACCOUNT_SQL.revokeAllSessions, /MAX\(\s*COALESCE\(tokens_valid_after, 0\),\s*unixepoch\(\)/)
  })
})

// ---------------------------------------------------------------------------
// Through the admin dispatcher with signed tokens (the §6.3 runtime check:
// revoke-all → the next request is 403 REAUTH_REQUIRED)
// ---------------------------------------------------------------------------

describe('through the admin guard (AD) with signed tokens', () => {
  const PROJECT_ID = 'sundus-yar-w2-05-test'
  const KEY_ID = 'w2-05-test-key'
  const originalFetch = globalThis.fetch
  const routes = [...adminBookingLogRoutes, ...adminAuditRoutes]
  let signingKey

  before(async () => {
    const keyPair = await generateKeyPair('RS256', { extractable: true })
    const publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }

    signingKey = keyPair.privateKey
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))

      if (url.hostname === 'www.googleapis.com' && url.pathname.includes('securetoken')) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error('Tests have no network access.')
    }
  })

  after(() => {
    globalThis.fetch = originalFetch
  })

  async function mintToken(uid, email, signedInSecondsAgo) {
    const now = Math.floor(Date.now() / 1000)

    return new SignJWT({
      email,
      email_verified: true,
      auth_time: now - signedInSecondsAgo,
      firebase: { sign_in_provider: 'password', identities: { email: [email] } },
    })
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
      .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
      .setAudience(PROJECT_ID)
      .setSubject(uid)
      .setIssuedAt(now - 1)
      .setExpirationTime(now + 3600)
      .sign(signingKey)
  }

  function dispatcher(db) {
    const env = { DB: createD1(db), FIREBASE_PROJECT_ID: PROJECT_ID, RL_ADMIN_READ: limiter() }

    return (path, { method = 'GET', token, json } = {}) => {
      const url = new URL(`https://example.test/api/admin/${path}`)
      const headers = token ? { Authorization: `Bearer ${token}` } : {}
      const init = json === undefined
        ? { method, headers }
        : { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(json) }

      return dispatchAdminPortalRequest(new Request(url, init), env, url, { waitUntil() {}, passThroughOnException() {} }, routes)
    }
  }

  test('the admin reaches every route; a customer and no token do not', async () => {
    const db = openDatabase()
    const dispatch = dispatcher(db)
    const adminToken = await mintToken(ADMIN, 'admin@example.test', 60)
    const customerToken = await mintToken(CUSTOMER, 'customer@example.test', 60)

    assert.equal((await dispatch('session', { token: adminToken })).status, 200)
    assert.equal((await dispatch('audit-log', { token: adminToken })).status, 200)
    assert.equal((await dispatch(`bookings/${BOOKING_ID}/timeline`, { token: adminToken })).status, 200)
    assert.equal(
      (await dispatch(`bookings/${BOOKING_ID}/contact-log`, {
        method: 'POST',
        token: adminToken,
        json: { template: 'hold_reminder', outcome: 'opened' },
      })).status,
      200,
    )

    for (const [path, method] of [
      ['session', 'GET'],
      ['audit-log', 'GET'],
      ['session/revoke-all', 'POST'],
      [`bookings/${BOOKING_ID}/timeline`, 'GET'],
      [`bookings/${BOOKING_ID}/contact-log`, 'POST'],
    ]) {
      const asCustomer = await dispatch(path, { method, token: customerToken })
      const anonymous = await dispatch(path, { method })

      assert.equal(asCustomer.status, 403, path)
      assert.equal((await body(asCustomer)).error.code, 'FORBIDDEN', path)
      assert.equal(anonymous.status, 401, path)
    }

    // Only the admin's one opened row was written.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_events').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_audit_log').get().n, 0)
  })

  test('revoke-all: the caller and every earlier sign-in get 403 REAUTH_REQUIRED next; a new sign-in passes', async () => {
    const db = openDatabase()
    const dispatch = dispatcher(db)
    const caller = await mintToken(ADMIN, 'admin@example.test', 60)
    const otherDevice = await mintToken(ADMIN, 'admin@example.test', 3 * 60 * 60)

    assert.equal((await dispatch('session', { token: otherDevice })).status, 200)

    const staleCaller = await mintToken(ADMIN, 'admin@example.test', RECENT_SIGN_IN_GUARD_SECONDS + 10)
    const refused = await dispatch('session/revoke-all', { method: 'POST', token: staleCaller })
    assert.equal(refused.status, 403)
    assert.equal((await body(refused)).error.code, 'REAUTH_REQUIRED')

    const revoked = await dispatch('session/revoke-all', { method: 'POST', token: caller })
    assert.equal(revoked.status, 200)

    for (const token of [caller, otherDevice]) {
      const next = await dispatch('session', { token })
      assert.equal(next.status, 403)
      assert.equal((await body(next)).error.code, 'REAUTH_REQUIRED')
    }

    const mark = db.prepare('SELECT tokens_valid_after AS t FROM users WHERE id = ?').get(ADMIN).t
    const fresh = await mintToken(ADMIN, 'admin@example.test', Math.floor(Date.now() / 1000) - mark)
    assert.equal((await dispatch('session', { token: fresh })).status, 200)

    const log = await body(await dispatch('audit-log', { token: fresh }))
    assert.deepEqual(log.entries.map((entry) => entry.action), ['admin_sessions_revoked'])
  })
})
