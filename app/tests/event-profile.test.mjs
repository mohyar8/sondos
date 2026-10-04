// W2-06 / TM-06, TM-08, TM-11, TM-12, N-39, N-40, SB-2, SB-3, SB-13, SB-15,
// SB-16: event profile and publishing consent (#6–#8) and the admin view
// (#22): shared/portal/event-profile.ts, worker/portal/event-profile.ts and
// the two slot files.
//
// The handlers run against a database built from the repository's own
// migrations (node:sqlite, foreign keys on, as in D1) through a small
// stand-in for the D1 API: prepare().bind(), first(), and batch() as one
// transaction that rolls back on the first failure, answering each SELECT
// with its rows and each write with meta.changes. The dispatcher has already
// run for every call here (token, verified email, ownership); each case
// hands the handler the context the dispatcher would build, and the
// ownership case hands it a forged one to show the statements bind the uid
// themselves.
//
// Binding note: node:sqlite binds every number as REAL, so the stand-in binds
// safe integers as BigInt, as D1 binds a whole JavaScript number as INTEGER.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, test } from 'node:test'

import { WINDOWED_CAPS } from '../shared/limits.ts'
import {
  CONSENT_TEXT_VERSION,
  EVENT_PROFILE_TEXT_RULES,
  isEventProfileEditable,
  parseConsentUpdateInput,
  parseEventProfileInput,
} from '../shared/portal/event-profile.ts'
import { addDaysToDateKey, riyadhTodayKey } from '../shared/timing.ts'
import {
  handleAdminGetEventProfile,
  handleGetEventProfile,
  handlePutConsent,
  handlePutEventProfile,
} from '../worker/portal/event-profile.ts'
import { adminEventProfileRoutes } from '../worker/portal/slots/admin-event-profile.ts'
import { eventProfileRoutes } from '../worker/portal/slots/event-profile.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const UID = 'CustomerUid0001'
const OTHER_UID = 'CustomerUid0002'
const ADMIN = 'AdminUid0001'
const DAY_MS = 24 * 60 * 60 * 1000

const VENUE = 'قاعة الياسمين'
const AREA = 'حي النرجس، الرياض'
const REQUESTS = 'تصوير لحظة دخول العروس\nمع لقطات للعائلة'

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

  addUser.run(UID, 'bride@example.test', 'customer')
  addUser.run(OTHER_UID, 'other@example.test', 'customer')
  addUser.run(ADMIN, 'admin@example.test', 'admin')

  return db
}

function createD1(db) {
  function execute(statement) {
    const prepared = db.prepare(statement.sql)
    const values = statement.values.map(sqlValue)

    if (/^\s*SELECT\b/i.test(statement.sql)) {
      return { success: true, meta: { changes: 0 }, results: prepared.all(...values) }
    }

    const info = prepared.run(...values)

    return { success: true, meta: { changes: Number(info.changes) }, results: [] }
  }

  function statement(sql, values) {
    const prepared = {
      sql,
      values,
      bind: (...next) => statement(sql, next),
      async first() {
        return execute(prepared).results[0] ?? null
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

/** A `ratelimits` binding that allows `allowance` calls, then limits. */
function limiter(allowance = Number.POSITIVE_INFINITY) {
  const keys = []

  return {
    keys,
    async limit({ key }) {
      keys.push(key)
      return { success: keys.length <= allowance }
    },
  }
}

let sequence = 0

function uuid() {
  sequence += 1
  return `5eedb00c-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

function today() {
  return riyadhTodayKey(new Date())
}

function dayFromToday(days) {
  return addDaysToDateKey(today(), days)
}

let nextEventDay = 10

/** One booking per (customer, event date): each default date is new. */
function addBooking(db, { userId = UID, status = 'confirmed', eventDate } = {}) {
  const id = uuid()

  if (eventDate === undefined) {
    nextEventDay += 1
    eventDate = dayFromToday(nextEventDay)
  }

  const at = new Date(Date.now() - 30 * DAY_MS).toISOString()

  db.prepare(
    `INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', 4000, ?, ?)`,
  ).run(id, userId, eventDate, status, at, at)

  return { id, status, flowVersion: 1, eventDate, holdExpiresAt: null }
}

/** Plain objects: node:sqlite rows have a null prototype. */
function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params.map(sqlValue)).map((row) => ({ ...row }))
}

function events(db, bookingId) {
  return rows(db, 'SELECT event, details, actor, actor_uid AS actorUid FROM booking_events WHERE booking_id = ? ORDER BY id', bookingId)
}

function consentRow(db, bookingId) {
  return rows(db, "SELECT granted, text_version AS textVersion FROM booking_consents WHERE booking_id = ? AND purpose = 'publish_photos'", bookingId)[0] ?? null
}

function addConsentEvents(db, bookingId, count, ageMs = 60 * 60 * 1000) {
  const at = new Date(Date.now() - ageMs).toISOString()

  for (let index = 0; index < count; index += 1) {
    db.prepare("INSERT INTO booking_events (booking_id, actor, event, created_at) VALUES (?, 'customer', ?, ?)").run(
      bookingId,
      index % 2 === 0 ? 'consent_granted' : 'consent_withdrawn',
      at,
    )
  }
}

// ---------------------------------------------------------------------------
// Contexts, as the dispatchers build them
// ---------------------------------------------------------------------------

function nowSeconds() {
  return Date.now() / 1000
}

function customer(uid = UID, signInAgeSeconds = 60) {
  return { uid, email: 'bride@example.test', emailVerified: true, authTime: nowSeconds() - signInAgeSeconds, secondFactor: null }
}

function environment(db, overrides = {}) {
  return { DB: createD1(db), RL_CUSTOMER_WRITE: limiter(), RL_ADMIN_READ: limiter(), ...overrides }
}

function jsonRequest(path, method, body) {
  return new Request(`https://sundus.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function customerContext(env, booking, { who = customer(), method = 'GET', resource = 'event-profile', body } = {}) {
  const path = `/api/bookings/${booking.id}/${resource}`
  const request = method === 'GET' ? new Request(`https://sundus.test${path}`) : jsonRequest(path, method, body)

  return {
    request,
    env,
    ctx: {},
    url: new URL(request.url),
    customer: who,
    bookingId: booking.id,
    booking,
    params: {},
  }
}

function adminContext(env, bookingId) {
  const request = new Request(`https://sundus.test/api/admin/bookings/${bookingId}/event-profile`)

  return {
    request,
    env,
    ctx: {},
    url: new URL(request.url),
    admin: { uid: ADMIN, authTime: nowSeconds() - 60, secondFactor: null },
    params: { bookingId },
  }
}

function profileBody(overrides = {}) {
  return { venueName: VENUE, venueArea: AREA, startTime: '16:30', specialRequests: REQUESTS, ...overrides }
}

function consentBody(granted, textVersion = CONSENT_TEXT_VERSION) {
  return { purpose: 'publish_photos', granted, textVersion }
}

async function send(handler, context) {
  const response = await handler(context)

  return { status: response.status, headers: response.headers, body: await response.json() }
}

/** Every console line written while the handlers run (SB-7: none). */
const consoleLines = []
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug']
const originalConsole = new Map()

beforeEach(() => {
  consoleLines.length = 0

  for (const method of consoleMethods) {
    originalConsole.set(method, console[method])
    console[method] = (...parts) => consoleLines.push(parts.join(' '))
  }
})

afterEach(() => {
  for (const method of consoleMethods) {
    console[method] = originalConsole.get(method)
  }

  assert.deepEqual(consoleLines, [])
})

// ---------------------------------------------------------------------------
// Shared contracts
// ---------------------------------------------------------------------------

describe('parseEventProfileInput (SB-3, SB-16, TM-12)', () => {
  test('accepts the four keys, normalises text and Arabic-Indic digits, and clears blanks to null', () => {
    const result = parseEventProfileInput(profileBody({ venueArea: '   ', startTime: '١٦:٣٠', specialRequests: 'سطر\r\nثانٍ' }))

    assert.deepEqual(result, {
      ok: true,
      value: { venueName: VENUE, venueArea: null, startTime: '16:30', specialRequests: 'سطر\nثانٍ' },
    })
    assert.deepEqual(parseEventProfileInput(profileBody({ venueName: null, startTime: '' })).value.startTime, null)
  })

  test('limits equal the event_profiles CHECKs (120/120/HH:MM/1000 code points)', () => {
    assert.equal(EVENT_PROFILE_TEXT_RULES.venueName.maxCodePoints, 120)
    assert.equal(EVENT_PROFILE_TEXT_RULES.venueArea.maxCodePoints, 120)
    assert.equal(EVENT_PROFILE_TEXT_RULES.specialRequests.maxCodePoints, 1000)
    assert.equal(parseEventProfileInput(profileBody({ venueName: 'ق'.repeat(120) })).ok, true)
    assert.deepEqual(parseEventProfileInput(profileBody({ venueName: 'ق'.repeat(121) })), {
      ok: false, code: 'FIELD_TOO_LONG', field: 'venueName', issue: 'TOO_LONG',
    })
    assert.equal(parseEventProfileInput(profileBody({ specialRequests: '😀'.repeat(1000) })).ok, true)
    assert.equal(parseEventProfileInput(profileBody({ specialRequests: '😀'.repeat(1001) })).code, 'FIELD_TOO_LONG')
  })

  test('bidi controls, invisible format characters and line breaks in one-line fields are INVALID_TEXT', () => {
    for (const value of ['قاعة ‮أ', 'قاعة​', '﻿قاعة', 'قاعة⁦x⁩', 'سطر\nثانٍ']) {
      assert.deepEqual(parseEventProfileInput(profileBody({ venueName: value })), {
        ok: false, code: 'INVALID_TEXT', field: 'venueName', issue: 'INVALID_TEXT',
      }, JSON.stringify(value))
    }

    assert.equal(parseEventProfileInput(profileBody({ specialRequests: 'طلب‮' })).code, 'INVALID_TEXT')
  })

  test('start time: HH:MM 00:00–23:59 only', () => {
    for (const value of ['00:00', '09:05', '23:59', '۲۳:۵۹']) {
      assert.equal(parseEventProfileInput(profileBody({ startTime: value })).ok, true, value)
    }

    for (const value of ['24:00', '9:30', '16:60', '16.30', '4 PM', '16:30:00', 'x'.repeat(40)]) {
      assert.deepEqual(parseEventProfileInput(profileBody({ startTime: value })), {
        ok: false, code: 'INVALID_TIME_FORMAT', field: 'startTime', issue: 'INVALID_TIME',
      }, value)
    }
  })

  test('a wrong type, a missing key or an extra key is INVALID_REQUEST_BODY for the whole body', () => {
    const wholeBody = { ok: false, code: 'INVALID_REQUEST_BODY', field: null, issue: null }

    assert.deepEqual(parseEventProfileInput(profileBody({ startTime: 1630 })), wholeBody)
    assert.deepEqual(parseEventProfileInput(profileBody({ venueName: ['قاعة'] })), wholeBody)
    assert.deepEqual(parseEventProfileInput({ venueName: VENUE, venueArea: AREA, startTime: null }), wholeBody)
    assert.deepEqual(parseEventProfileInput({ ...profileBody(), publishingConsent: true }), wholeBody)
    assert.deepEqual(parseEventProfileInput(null), wholeBody)
    assert.deepEqual(parseEventProfileInput([]), wholeBody)
  })
})

describe('parseConsentUpdateInput and isEventProfileEditable', () => {
  test('exact keys, the one purpose, a boolean and a well-formed version', () => {
    assert.deepEqual(parseConsentUpdateInput(consentBody(true)), {
      ok: true, value: { purpose: 'publish_photos', granted: true, textVersion: CONSENT_TEXT_VERSION },
    })

    for (const body of [
      { ...consentBody(true), purpose: 'publish_testimonial' },
      { ...consentBody(true), granted: 'true' },
      { ...consentBody(true), granted: 1 },
      { ...consentBody(true), textVersion: 'consent v1' },
      { ...consentBody(true), textVersion: 'v'.repeat(33) },
      { ...consentBody(true), extra: 1 },
      { purpose: 'publish_photos', granted: true },
    ]) {
      assert.deepEqual(parseConsentUpdateInput(body), { ok: false, code: 'INVALID_REQUEST_BODY' }, JSON.stringify(body))
    }
  })

  test('editable only while confirmed and the Riyadh event day has not passed', () => {
    assert.equal(isEventProfileEditable('confirmed', '2026-10-01', '2026-10-01'), true)
    assert.equal(isEventProfileEditable('confirmed', '2026-10-01', '2026-10-02'), false)
    assert.equal(isEventProfileEditable('completed', '2026-10-05', '2026-10-01'), false)
    assert.equal(isEventProfileEditable('approved_hold', '2026-10-05', '2026-10-01'), false)
  })
})

describe('slots', () => {
  test('#6–#8 and #22 are registered on the open gate with exactly their methods', () => {
    assert.deepEqual(
      eventProfileRoutes.map((route) => [route.path.join('/'), route.gate, Object.keys(route.handlers).sort()]),
      [['event-profile', 'open', ['GET', 'PUT']], ['consent', 'open', ['PUT']]],
    )
    assert.deepEqual(
      adminEventProfileRoutes.map((route) => [route.path.join('/'), route.gate, Object.keys(route.handlers)]),
      [['bookings/:bookingId/event-profile', 'open', ['GET']]],
    )
  })
})

// ---------------------------------------------------------------------------
// #6 / #7
// ---------------------------------------------------------------------------

describe('#6 GET event-profile', () => {
  test('no profile yet: null, consent NO by default, editable while confirmed', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const { status, body } = await send(handleGetEventProfile, customerContext(environment(db), booking))

    assert.equal(status, 200)
    assert.deepEqual(body, {
      ok: true,
      eventProfile: null,
      consent: { publishPhotos: { granted: false, textVersion: CONSENT_TEXT_VERSION, updatedAt: null } },
      editable: true,
      eventDate: booking.eventDate,
    })
  })

  test('not editable before confirmation or after the event day', async () => {
    const db = openDatabase()

    for (const booking of [addBooking(db, { status: 'approved_hold' }), addBooking(db, { eventDate: dayFromToday(-1) })]) {
      const { body } = await send(handleGetEventProfile, customerContext(environment(db), booking))

      assert.equal(body.editable, false)
    }
  })
})

describe('#7 PUT event-profile', () => {
  test('saves once, and writes event_profile_saved only when a value changes (TM-11, N-40)', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const env = environment(db)
    const first = await send(handlePutEventProfile, customerContext(env, booking, { method: 'PUT', body: profileBody({ startTime: '١٦:٣٠' }) }))

    assert.equal(first.status, 200)
    assert.deepEqual(
      { ...first.body.eventProfile, updatedAt: 'x' },
      { venueName: VENUE, venueArea: AREA, startTime: '16:30', specialRequests: REQUESTS, updatedAt: 'x' },
    )
    assert.equal(first.body.editable, true)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const again = await send(handlePutEventProfile, customerContext(env, booking, { method: 'PUT', body: profileBody() }))

      assert.equal(again.status, 200)
      assert.equal(again.body.eventProfile.updatedAt, first.body.eventProfile.updatedAt)
    }

    assert.deepEqual(events(db, booking.id), [{ event: 'event_profile_saved', details: null, actor: 'customer', actorUid: null }])

    const changed = await send(handlePutEventProfile, customerContext(env, booking, { method: 'PUT', body: profileBody({ specialRequests: null }) }))

    assert.equal(changed.status, 200)
    assert.equal(changed.body.eventProfile.specialRequests, null)
    assert.equal(events(db, booking.id).length, 2)
  })

  test('no free text reaches booking_events (SB-13)', async () => {
    const db = openDatabase()
    const booking = addBooking(db)

    await send(handlePutEventProfile, customerContext(environment(db), booking, { method: 'PUT', body: profileBody() }))

    const stored = JSON.stringify(rows(db, 'SELECT * FROM booking_events'))

    assert.equal(stored.includes(VENUE) || stored.includes(AREA) || stored.includes('العروس'), false)
  })

  test('409 BOOKING_NOT_CONFIRMED and 409 EVENT_DATE_PASSED write nothing; the event day itself is allowed (M2)', async () => {
    const db = openDatabase()
    const env = environment(db)
    const cases = [
      [addBooking(db, { status: 'approved_hold' }), 409, 'BOOKING_NOT_CONFIRMED'],
      [addBooking(db, { status: 'cancelled' }), 409, 'BOOKING_NOT_CONFIRMED'],
      [addBooking(db, { eventDate: dayFromToday(-1) }), 409, 'EVENT_DATE_PASSED'],
      [addBooking(db, { eventDate: today() }), 200, null],
    ]

    for (const [booking, expectedStatus, code] of cases) {
      const { status, body } = await send(handlePutEventProfile, customerContext(env, booking, { method: 'PUT', body: profileBody() }))

      assert.equal(status, expectedStatus, booking.status)
      assert.equal(body.ok ? null : body.error.code, code)
      assert.equal(rows(db, 'SELECT 1 FROM event_profiles WHERE booking_id = ?', booking.id).length, code ? 0 : 1)
      assert.equal(events(db, booking.id).length, code ? 0 : 1)
    }
  })

  test('the status is re-checked inside the write, not taken from the dispatcher snapshot (SB-5)', async () => {
    const db = openDatabase()
    const booking = addBooking(db)

    db.prepare("UPDATE booking_requests SET status = 'cancelled' WHERE id = ?").run(booking.id)

    const { status, body } = await send(handlePutEventProfile, customerContext(environment(db), booking, { method: 'PUT', body: profileBody() }))

    assert.equal(status, 409)
    assert.equal(body.error.code, 'BOOKING_NOT_CONFIRMED')
    assert.equal(rows(db, 'SELECT 1 FROM event_profiles').length, 0)
  })

  test('a purged profile is never written again', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const at = new Date().toISOString()

    db.prepare(
      'INSERT INTO event_profiles (booking_id, created_at, updated_at, text_purged_at) VALUES (?, ?, ?, ?)',
    ).run(booking.id, at, at, at)

    const { status, body } = await send(handlePutEventProfile, customerContext(environment(db), booking, { method: 'PUT', body: profileBody() }))

    assert.equal(status, 409)
    assert.equal(body.error.code, 'EVENT_DATE_PASSED')
    assert.deepEqual(rows(db, 'SELECT venue_name AS venueName FROM event_profiles'), [{ venueName: null }])
    assert.equal(events(db, booking.id).length, 0)
  })

  test('400 answers name the field and never echo its value', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const env = environment(db)
    const cases = [
      [profileBody({ venueName: 'ق'.repeat(121) }), 'FIELD_TOO_LONG', [{ field: 'venueName', issue: 'TOO_LONG' }]],
      [profileBody({ startTime: '25:00' }), 'INVALID_TIME_FORMAT', [{ field: 'startTime', issue: 'INVALID_TIME' }]],
      [profileBody({ venueArea: 'حي‮سري' }), 'INVALID_TEXT', [{ field: 'venueArea', issue: 'INVALID_TEXT' }]],
      [{ ...profileBody(), extra: null }, 'INVALID_REQUEST_BODY', undefined],
      ['{"venueName":', 'INVALID_REQUEST_BODY', undefined],
      [JSON.stringify(profileBody({ specialRequests: 'ط'.repeat(20_000) })), 'FIELD_TOO_LONG', undefined],
    ]

    for (const [body, code, details] of cases) {
      const response = await send(handlePutEventProfile, customerContext(env, booking, { method: 'PUT', body }))

      assert.equal(response.status, 400, code)
      assert.equal(response.body.error.code, code)
      assert.deepEqual(response.body.error.details, details)
      assert.equal(JSON.stringify(response.body).includes('سري'), false)
    }

    assert.equal(rows(db, 'SELECT 1 FROM event_profiles').length, 0)
  })

  test('the uid is bound in the write itself: a forged context for another customer writes nothing (TM-06)', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const forged = customerContext(environment(db), booking, { who: customer(OTHER_UID), method: 'PUT', body: profileBody() })
    const { status, body } = await send(handlePutEventProfile, forged)

    assert.equal(status, 404)
    assert.equal(body.error.code, 'BOOKING_NOT_FOUND')
    assert.equal(rows(db, 'SELECT 1 FROM event_profiles').length, 0)
    assert.equal(events(db, booking.id).length, 0)

    const read = await send(handleGetEventProfile, customerContext(environment(db), booking, { who: customer(OTHER_UID) }))

    assert.equal(read.status, 404)
  })

  test('the burst limit (RL_CUSTOMER_WRITE, keyed by uid) answers 429 before reading or writing (SB-15)', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const binding = limiter(10)
    const env = environment(db, { RL_CUSTOMER_WRITE: binding })
    const statuses = []

    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await send(handlePutEventProfile, customerContext(env, booking, { method: 'PUT', body: profileBody() }))).status)
    }

    assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429])
    assert.deepEqual(new Set(binding.keys), new Set([UID]))
    assert.equal(events(db, booking.id).length, 1)

    const limited = await handlePutEventProfile(customerContext(env, booking, { method: 'PUT', body: profileBody() }))

    assert.equal(limited.headers.get('Retry-After'), '60')
    assert.equal((await limited.json()).error.code, 'RATE_LIMITED')
  })
})

// ---------------------------------------------------------------------------
// #8
// ---------------------------------------------------------------------------

describe('#8 PUT consent', () => {
  test('a grant needs a sign-in at most 10 minutes old; a withdrawal never does (TM-08, N-39)', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const env = environment(db)
    const stale = customer(UID, 11 * 60)
    const refused = await send(handlePutConsent, customerContext(env, booking, { who: stale, method: 'PUT', resource: 'consent', body: consentBody(true) }))

    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'REAUTH_REQUIRED')
    assert.equal(consentRow(db, booking.id), null)
    assert.equal(events(db, booking.id).length, 0)

    const granted = await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(true) }))

    assert.equal(granted.status, 200)
    assert.equal(granted.body.consent.publishPhotos.granted, true)
    assert.equal(granted.body.consent.publishPhotos.textVersion, CONSENT_TEXT_VERSION)
    assert.deepEqual(consentRow(db, booking.id), { granted: 1, textVersion: CONSENT_TEXT_VERSION })

    const withdrawn = await send(handlePutConsent, customerContext(env, booking, { who: stale, method: 'PUT', resource: 'consent', body: consentBody(false) }))

    assert.equal(withdrawn.status, 200)
    assert.equal(withdrawn.body.consent.publishPhotos.granted, false)
    assert.deepEqual(consentRow(db, booking.id), { granted: 0, textVersion: CONSENT_TEXT_VERSION })
    assert.deepEqual(events(db, booking.id).map((row) => row.event), ['consent_granted', 'consent_withdrawn'])
  })

  test('events only on change: repeated grants and withdrawals write nothing more (TM-11)', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const env = environment(db)
    const put = (granted) => send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(granted) }))

    assert.equal((await put(false)).status, 200)
    assert.equal(consentRow(db, booking.id), null, 'a withdrawal never creates a row: no row is already NO')

    for (const granted of [true, true, true, false, false, true]) {
      assert.equal((await put(granted)).status, 200)
    }

    assert.deepEqual(events(db, booking.id).map((row) => row.event), ['consent_granted', 'consent_withdrawn', 'consent_granted'])
    assert.equal(events(db, booking.id).every((row) => row.details === null && row.actor === 'customer'), true)
  })

  test('a grant for an older consent text is 409 CONSENT_TEXT_OUTDATED; a withdrawal with it still works', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const env = environment(db)
    const outdated = await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(true, 'consent-v0') }))

    assert.equal(outdated.status, 409)
    assert.equal(outdated.body.error.code, 'CONSENT_TEXT_OUTDATED')
    assert.equal(consentRow(db, booking.id), null)

    await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(true) }))

    const withdrawn = await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(false, 'consent-v0') }))

    assert.equal(withdrawn.status, 200)
    assert.equal(consentRow(db, booking.id).granted, 0)
  })

  test('granting needs a confirmed booking (snapshot and statement); withdrawing works in every status', async () => {
    const db = openDatabase()
    const env = environment(db)
    const pending = addBooking(db, { status: 'approved_hold' })
    const refused = await send(handlePutConsent, customerContext(env, pending, { method: 'PUT', resource: 'consent', body: consentBody(true) }))

    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'BOOKING_NOT_CONFIRMED')

    // Cancelled after the dispatcher's snapshot: the INSERT refuses it.
    const raced = addBooking(db)
    db.prepare("UPDATE booking_requests SET status = 'cancelled' WHERE id = ?").run(raced.id)
    const racedGrant = await send(handlePutConsent, customerContext(env, raced, { method: 'PUT', resource: 'consent', body: consentBody(true) }))

    assert.equal(racedGrant.status, 409)
    assert.equal(consentRow(db, raced.id), null)

    // Granted while confirmed, withdrawn after the booking was cancelled.
    const done = addBooking(db)
    await send(handlePutConsent, customerContext(env, done, { method: 'PUT', resource: 'consent', body: consentBody(true) }))
    db.prepare("UPDATE booking_requests SET status = 'cancelled' WHERE id = ?").run(done.id)
    const withdrawn = await send(
      handlePutConsent,
      customerContext(env, { ...done, status: 'cancelled' }, { method: 'PUT', resource: 'consent', body: consentBody(false) }),
    )

    assert.equal(withdrawn.status, 200)
    assert.equal(consentRow(db, done.id).granted, 0)
  })

  test('at most 10 consent changes a day: grants stop, a withdrawal always goes through (N-40)', async () => {
    const db = openDatabase()
    const { max, windowSeconds } = WINDOWED_CAPS.consentChangesPerBooking
    const booking = addBooking(db)
    const env = environment(db)
    const put = (granted) => send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(granted) }))
    const statuses = []

    // 20 toggles in a row.
    for (let index = 0; index < 20; index += 1) {
      statuses.push((await put(index % 2 === 0)).status)
    }

    const changes = events(db, booking.id).length

    assert.equal(changes, max)
    assert.deepEqual(statuses.slice(0, max), Array(max).fill(200))
    assert.deepEqual([...new Set(statuses.slice(max).filter((_, index) => index % 2 === 0))], [429])
    assert.equal(consentRow(db, booking.id).granted, 0)

    const capped = await handlePutConsent(customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(true) }))

    assert.equal(capped.status, 429)
    assert.equal(capped.headers.get('Retry-After'), String(windowSeconds))
  })

  test('the cap counts only this booking\'s consent events of the last 24 hours, and never blocks a withdrawal', async () => {
    const db = openDatabase()
    const { max } = WINDOWED_CAPS.consentChangesPerBooking
    const env = environment(db)
    const put = (booking, granted) =>
      send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(granted) }))

    const old = addBooking(db)
    addConsentEvents(db, old.id, 30, DAY_MS + 60_000)
    assert.equal((await put(old, true)).status, 200)

    const busy = addBooking(db)
    addConsentEvents(db, busy.id, max - 2)
    assert.equal((await put(busy, true)).status, 200)
    assert.equal((await put(busy, false)).status, 200)
    assert.equal((await put(busy, true)).status, 429)

    // Granted before a burst of events elsewhere in the log: still withdrawable.
    const granted = addBooking(db)
    assert.equal((await put(granted, true)).status, 200)
    addConsentEvents(db, granted.id, 3 * max)
    assert.equal((await put(granted, false)).status, 200)
    assert.equal(consentRow(db, granted.id).granted, 0)
  })

  test('malformed bodies are 400 and write nothing; the burst limit applies to consent too', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const env = environment(db, { RL_CUSTOMER_WRITE: limiter(1) })
    const bad = await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: { ...consentBody(true), granted: 'yes' } }))

    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'INVALID_REQUEST_BODY')

    const limited = await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(true) }))

    assert.equal(limited.status, 429)
    assert.equal(consentRow(db, booking.id), null)
  })

  test('the uid is bound in the write itself: a forged context grants and withdraws nothing (TM-06)', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const env = environment(db)

    await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(true) }))

    for (const granted of [false, true]) {
      const { status } = await send(
        handlePutConsent,
        customerContext(env, booking, { who: customer(OTHER_UID), method: 'PUT', resource: 'consent', body: consentBody(granted) }),
      )

      assert.equal(status, 404)
    }

    assert.equal(consentRow(db, booking.id).granted, 1)
    assert.equal(events(db, booking.id).length, 1)
  })
})

// ---------------------------------------------------------------------------
// #22
// ---------------------------------------------------------------------------

describe('#22 GET /api/admin/bookings/{id}/event-profile', () => {
  test('profile, consent with grantedAt for the "not yet confirmed by the studio" label, and history', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const env = environment(db)

    const empty = await send(handleAdminGetEventProfile, adminContext(env, booking.id))

    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body, {
      ok: true,
      eventProfile: null,
      textPurged: false,
      consent: { publishPhotos: { granted: false, textVersion: CONSENT_TEXT_VERSION, updatedAt: null, grantedAt: null } },
      history: [],
      eventDate: booking.eventDate,
    })

    await send(handlePutEventProfile, customerContext(env, booking, { method: 'PUT', body: profileBody() }))
    const grant = await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(true) }))
    const granted = await send(handleAdminGetEventProfile, adminContext(env, booking.id))

    assert.equal(granted.body.eventProfile.venueName, VENUE)
    assert.equal(granted.body.consent.publishPhotos.granted, true)
    assert.equal(granted.body.consent.publishPhotos.grantedAt, grant.body.consent.publishPhotos.updatedAt)
    assert.match(granted.body.consent.publishPhotos.grantedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.deepEqual(granted.body.history.map((entry) => Object.keys(entry).sort()), [['createdAt', 'event'], ['createdAt', 'event']])
    assert.deepEqual(granted.body.history.map((entry) => entry.event), ['consent_granted', 'event_profile_saved'])

    await send(handlePutConsent, customerContext(env, booking, { method: 'PUT', resource: 'consent', body: consentBody(false) }))
    const withdrawn = await send(handleAdminGetEventProfile, adminContext(env, booking.id))

    assert.equal(withdrawn.body.consent.publishPhotos.granted, false)
    assert.equal(withdrawn.body.consent.publishPhotos.grantedAt, null)
    assert.equal(withdrawn.body.history[0].event, 'consent_withdrawn')
  })

  test('an unknown booking is 404 BOOKING_NOT_FOUND; RL_ADMIN_READ limits by admin uid', async () => {
    const db = openDatabase()
    const booking = addBooking(db)
    const missing = await send(handleAdminGetEventProfile, adminContext(environment(db), uuid()))

    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'BOOKING_NOT_FOUND')

    const binding = limiter(0)
    const limited = await send(handleAdminGetEventProfile, adminContext(environment(db, { RL_ADMIN_READ: binding }), booking.id))

    assert.equal(limited.status, 429)
    assert.deepEqual(binding.keys, [ADMIN])
  })
})
