// W2-09 / SB-2, SB-3, SB-6, SB-15, SB-16, TM-06, TM-11, TM-12: private
// feedback (plan 11 §3.3 #12, §3.2 #25; API contract 07 §3.H). The routes
// run through the real dispatchers (portal-routes.ts, admin-portal-routes.ts)
// with this unit's slots, over a database built from the repository's
// migrations plus scripts/dev-seed.sql (node:sqlite behind a D1 stand-in whose
// batch() is one transaction). Each case fails if its control is taken out
// of worker/portal/feedback.ts or shared/portal/feedback.ts:
// - ownership: another customer's booking answers the same 404 as an unknown
//   id, and nothing is written (TM-06);
// - the handover check inside the INSERT (409 NOT_YET_HANDED_OVER);
// - one row per booking and compare-on-retry: 201, then 200 for the same
//   (normalised) submission, 409 FEEDBACK_ALREADY_SUBMITTED for another, and
//   exactly one feedback_submitted event (the changes() guard);
// - exact-key body, integer rating 1–5, the comment through normalizeFreeText
//   (1000 code points, bidi controls refused), errors that never echo it;
// - the RL_CUSTOMER_WRITE and RL_ADMIN_READ bursts;
// - the admin view is read-only and admin-only.
//
// No network: the Firebase JWKS is served by a fetch stub from a key made
// here.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SignJWT, exportJWK, generateKeyPair } from 'jose'

import {
  FEEDBACK_BODY_MAX_BYTES,
  FEEDBACK_COMMENT_MAX_CODE_POINTS,
  isSameFeedback,
  parseFeedbackResponse,
  validateFeedbackSubmission,
} from '../shared/portal/feedback.ts'
import { handleGetFeedback, handleSubmitFeedback } from '../worker/portal/feedback.ts'
import { dispatchAdminPortalRequest } from '../worker/portal/admin-portal-routes.ts'
import { dispatchCustomerPortalRequest } from '../worker/portal/portal-routes.ts'
import { adminFeedbackRoutes } from '../worker/portal/slots/admin-feedback.ts'
import { feedbackRoutes } from '../worker/portal/slots/feedback.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SEED_SQL = readFileSync(join(APP_ROOT, 'scripts', 'dev-seed.sql'), 'utf8')
const PROJECT_ID = 'sundus-yar-w2-09-test'
const KEY_ID = 'w2-09-test-key'
const ORIGIN = 'https://sundusyar.test'

const tester = { uid: 'W209Tester', email: 'tester@example.test' }
const other = { uid: 'W209Other', email: 'other-bride@example.test' }
const admin = { uid: 'W209Admin', email: 'studio-admin@example.test' }

/** dev-seed.sql bookings of the tester. */
const COMPLETED_WITH_FEEDBACK = '5eedb00c-0000-4000-8000-000000000019'
const COMPLETED = '5eedb00c-0000-4000-8000-000000000020'
const HANDOVER_SCHEDULED = '5eedb00c-0000-4000-8000-000000000017'
const NO_HANDOVER = '5eedb00c-0000-4000-8000-000000000016'
const UNKNOWN = '5eedb00c-0000-4000-8000-0000000009ff'

const COMMENT = 'تجربة جميلة، شكرًا على الألبوم والاهتمام بالتفاصيل.'
const ECHO_MARKER = 'W209-ECHO-MARKER'

// ---------------------------------------------------------------------------
// Stand-ins: D1 over node:sqlite, JWKS, ratelimits, ExecutionContext
// ---------------------------------------------------------------------------

/** D1 binds a whole JS number as INTEGER; node:sqlite would bind REAL. */
function toSqliteValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

function plainRow(row) {
  const result = {}

  for (const [key, value] of Object.entries(row)) {
    result[key] = typeof value === 'bigint' ? Number(value) : value
  }

  return result
}

class D1StatementStub {
  constructor(database, sql, params = []) {
    this.database = database
    this.sql = sql
    this.params = params
  }

  bind(...params) {
    return new D1StatementStub(this.database, this.sql, params.map(toSqliteValue))
  }

  async first() {
    const row = this.database.prepare(this.sql).get(...this.params)

    return row === undefined ? null : plainRow(row)
  }

  async all() {
    const results = this.database.prepare(this.sql).all(...this.params).map(plainRow)

    return { success: true, results, meta: { changes: 0 } }
  }

  async run() {
    const info = this.database.prepare(this.sql).run(...this.params)

    return { success: true, results: [], meta: { changes: Number(info.changes) } }
  }
}

class D1DatabaseStub {
  constructor(database) {
    this.database = database
  }

  prepare(sql) {
    return new D1StatementStub(this.database, sql)
  }

  async batch(statements) {
    this.database.exec('BEGIN')

    try {
      const results = []

      for (const statement of statements) {
        const returnsRows = this.database.prepare(statement.sql).columns().length > 0

        results.push(returnsRows ? await statement.all() : await statement.run())
      }

      this.database.exec('COMMIT')

      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

class FakeRateLimit {
  constructor(allowance) {
    this.allowance = allowance
    this.keys = []
  }

  async limit({ key }) {
    this.keys.push(key)

    return { success: this.keys.filter((used) => used === key).length <= this.allowance }
  }
}

function executionContext() {
  return { waitUntil() {}, passThroughOnException() {} }
}

const originalFetch = globalThis.fetch
let signingKey

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

async function mintToken({ uid, email }) {
  return new SignJWT({
    email,
    email_verified: true,
    firebase: { sign_in_provider: 'password', identities: { email: [email] } },
    auth_time: nowSeconds() - 60,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
    .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(PROJECT_ID)
    .setSubject(uid)
    .setIssuedAt(nowSeconds() - 30)
    .setExpirationTime(nowSeconds() + 3600)
    .sign(signingKey)
}

before(async () => {
  const keyPair = await generateKeyPair('RS256', { extractable: true })

  signingKey = keyPair.privateKey

  const publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }

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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function insertUser(database, user, role) {
  database
    .prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
       VALUES (?, ?, 'سارة', 'تجريبية', '+447700900100', ?, '2026-09-01T10:00:00.000Z')`,
    )
    .run(user.uid, user.email, role)
}

/** Migrations, the tester and a second customer, the dev seed, then the admin. */
function freshEnv() {
  const database = new DatabaseSync(':memory:')

  database.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(join(APP_ROOT, 'migrations')).filter((file) => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(APP_ROOT, 'migrations', name), 'utf8'))
  }

  insertUser(database, tester, 'customer')
  insertUser(database, other, 'customer')
  database.exec('BEGIN')
  database.exec(SEED_SQL.split('{{CUSTOMER_UID}}').join(tester.uid))
  database.exec('COMMIT')
  insertUser(database, admin, 'admin')

  return {
    database,
    env: {
      DB: new D1DatabaseStub(database),
      FIREBASE_PROJECT_ID: PROJECT_ID,
      ADMIN_MEDIA_MFA: 'required',
      ADMIN_SETTINGS_2F: 'off',
      RL_CUSTOMER_WRITE: new FakeRateLimit(100),
      RL_ADMIN_READ: new FakeRateLimit(100),
    },
  }
}

function request(path, method, token, body) {
  const headers = {}

  if (token !== null) {
    headers.Authorization = `Bearer ${token}`
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function customerCall(env, user, bookingId, method, body) {
  const token = user === null ? null : await mintToken(user)
  const req = request(`/api/bookings/${bookingId}/feedback`, method, token, body)

  return dispatchCustomerPortalRequest(req, env, new URL(req.url), executionContext(), feedbackRoutes)
}

async function adminCall(env, user, bookingId, method = 'GET') {
  const req = request(`/api/admin/bookings/${bookingId}/feedback`, method, await mintToken(user))

  return dispatchAdminPortalRequest(req, env, new URL(req.url), executionContext(), adminFeedbackRoutes)
}

async function read(response) {
  const text = await response.text()

  return { status: response.status, text, body: JSON.parse(text), headers: response.headers }
}

function assertError(result, status, code) {
  assert.equal(result.status, status, result.text)
  assert.deepEqual(Object.keys(result.body).sort(), ['error', 'ok'])
  assert.equal(result.body.ok, false)
  assert.deepEqual(Object.keys(result.body.error).sort(), ['code', 'message'])
  assert.equal(result.body.error.code, code)
  assert.match(result.body.error.message, /[؀-ۿ]/)
  assert.equal(result.text.includes(ECHO_MARKER), false, 'the error echoes the request')
}

function feedbackRows(database) {
  return database.prepare('SELECT booking_id, rating, comment, created_at, updated_at FROM feedback ORDER BY booking_id').all().map(plainRow)
}

function feedbackEvents(database) {
  return database
    .prepare("SELECT booking_id, actor, actor_uid, subject_id, details, note FROM booking_events WHERE event = 'feedback_submitted' ORDER BY id")
    .all()
    .map(plainRow)
}

// ---------------------------------------------------------------------------
// Shared validator
// ---------------------------------------------------------------------------

describe('shared/portal/feedback.ts', () => {
  test('rating is a whole number from 1 to 5, nothing else', () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      assert.equal(validateFeedbackSubmission({ rating }).ok, true, String(rating))
    }

    for (const rating of [0, 6, -1, 4.5, '5', true, null, Number.NaN, Infinity, [5], { value: 5 }]) {
      assert.deepEqual(validateFeedbackSubmission({ rating }), { ok: false, problem: 'invalid-body' }, String(rating))
    }
  })

  test('the comment goes through the shared text validator', () => {
    assert.deepEqual(validateFeedbackSubmission({ rating: 5, comment: `  ${COMMENT}\r\nسطر ثانٍ  ` }), {
      ok: true,
      submission: { rating: 5, comment: `${COMMENT}\nسطر ثانٍ` },
    })
    assert.deepEqual(validateFeedbackSubmission({ rating: 4, comment: 'é' }), {
      ok: true,
      submission: { rating: 4, comment: 'é' },
    })

    for (const empty of ['', '   ', '\n\n', '‌']) {
      assert.deepEqual(validateFeedbackSubmission({ rating: 3, comment: empty }), {
        ok: true,
        submission: { rating: 3, comment: null },
      })
    }

    for (const forbidden of ['‮abc', 'a‎b', 'a\u0000b', 'a b', '﻿abc', 'a⁦b']) {
      assert.deepEqual(validateFeedbackSubmission({ rating: 5, comment: forbidden }), { ok: false, problem: 'invalid-text' })
    }

    assert.deepEqual(validateFeedbackSubmission({ rating: 5, comment: 'ا'.repeat(FEEDBACK_COMMENT_MAX_CODE_POINTS + 1) }), {
      ok: false,
      problem: 'too-long',
    })
    assert.equal(validateFeedbackSubmission({ rating: 5, comment: '🌸'.repeat(FEEDBACK_COMMENT_MAX_CODE_POINTS) }).ok, true)

    for (const notText of [5, true, ['x'], { text: 'x' }]) {
      assert.deepEqual(validateFeedbackSubmission({ rating: 5, comment: notText }), { ok: false, problem: 'invalid-body' })
    }
  })

  test('compare-on-retry compares the rating and the normalised comment', () => {
    assert.equal(isSameFeedback({ rating: 5, comment: 'أ' }, { rating: 5, comment: 'أ' }), true)
    assert.equal(isSameFeedback({ rating: 5, comment: null }, { rating: 5, comment: null }), true)
    assert.equal(isSameFeedback({ rating: 5, comment: 'أ' }, { rating: 4, comment: 'أ' }), false)
    assert.equal(isSameFeedback({ rating: 5, comment: 'أ' }, { rating: 5, comment: null }), false)
  })

  test('the response parser accepts only the contract shape', () => {
    const view = { rating: 4, comment: null, submittedAt: '2026-09-30T10:00:00.000Z' }

    assert.deepEqual(parseFeedbackResponse({ ok: true, feedback: null }), { feedback: null })
    assert.deepEqual(parseFeedbackResponse({ ok: true, feedback: { ...view, extra: '<b>' } }), { feedback: view })

    for (const feedback of [
      undefined,
      [],
      'x',
      { ...view, rating: 6 },
      { ...view, rating: '4' },
      { ...view, comment: '' },
      { ...view, comment: 'ا'.repeat(1001) },
      { ...view, submittedAt: '2026-09-30' },
      { ...view, submittedAt: '2026-13-45T10:00:00.000Z' },
    ]) {
      assert.equal(parseFeedbackResponse({ ok: true, feedback }), null, JSON.stringify(feedback))
    }
  })
})

// ---------------------------------------------------------------------------
// Customer routes (#12)
// ---------------------------------------------------------------------------

describe('GET and POST /api/bookings/{id}/feedback', () => {
  test('GET: null before feedback, the stored view after, and the API headers', async () => {
    const { env } = freshEnv()
    const none = await read(await customerCall(env, tester, COMPLETED, 'GET'))

    assert.equal(none.status, 200)
    assert.deepEqual(none.body, { ok: true, feedback: null })
    assert.equal(none.headers.get('Cache-Control'), 'no-store')
    assert.equal(none.headers.get('X-Content-Type-Options'), 'nosniff')

    const seeded = await read(await customerCall(env, tester, COMPLETED_WITH_FEEDBACK, 'GET'))

    assert.equal(seeded.status, 200)
    assert.deepEqual(Object.keys(seeded.body.feedback).sort(), ['comment', 'rating', 'submittedAt'])
    assert.equal(seeded.body.feedback.rating, 5)
    assert.notEqual(parseFeedbackResponse(seeded.body), null)
  })

  test('first submission 201, the same again 200 unchanged, a different one 409; one row, one event', async () => {
    const { env, database } = freshEnv()
    const created = await read(await customerCall(env, tester, COMPLETED, 'POST', { rating: 5, comment: COMMENT }))

    assert.equal(created.status, 201, created.text)
    assert.equal(created.body.ok, true)
    assert.equal(created.body.feedback.rating, 5)
    assert.equal(created.body.feedback.comment, COMMENT)
    assert.notEqual(parseFeedbackResponse(created.body), null)

    // The same submission in another form (spaces, CRLF-free, decomposed
    // characters normalise to the same NFC text): an idempotent success.
    const retry = await read(
      await customerCall(env, tester, COMPLETED, 'POST', { rating: 5, comment: `  ${COMMENT.normalize('NFD')}  ` }),
    )

    assert.equal(retry.status, 200, retry.text)
    assert.deepEqual(retry.body, created.body)

    for (const different of [
      { rating: 4, comment: COMMENT },
      { rating: 5, comment: `${COMMENT} ${ECHO_MARKER}` },
      { rating: 5 },
      { rating: 5, comment: null },
    ]) {
      assertError(await read(await customerCall(env, tester, COMPLETED, 'POST', different)), 409, 'FEEDBACK_ALREADY_SUBMITTED')
    }

    const rows = feedbackRows(database).filter((row) => row.booking_id === COMPLETED)

    assert.equal(rows.length, 1)
    assert.equal(rows[0].rating, 5)
    assert.equal(rows[0].comment, COMMENT)
    assert.equal(rows[0].created_at, created.body.feedback.submittedAt)
    assert.equal(rows[0].updated_at, rows[0].created_at)
    assert.deepEqual(feedbackEvents(database), [
      { booking_id: COMPLETED, actor: 'customer', actor_uid: null, subject_id: null, details: null, note: null },
    ])
  })

  test('a comment that shows nothing is stored as no comment', async () => {
    const { env, database } = freshEnv()
    const created = await read(await customerCall(env, tester, COMPLETED, 'POST', { rating: 3, comment: '  \n ' }))

    assert.equal(created.status, 201)
    assert.equal(created.body.feedback.comment, null)
    assert.equal(feedbackRows(database).find((row) => row.booking_id === COMPLETED).comment, null)
    assert.equal((await customerCall(env, tester, COMPLETED, 'POST', { rating: 3 })).status, 200)
  })

  test('before the handover is completed: 409 NOT_YET_HANDED_OVER and nothing written', async () => {
    const { env, database } = freshEnv()
    const before = feedbackRows(database)

    for (const bookingId of [HANDOVER_SCHEDULED, NO_HANDOVER]) {
      assertError(
        await read(await customerCall(env, tester, bookingId, 'POST', { rating: 5, comment: ECHO_MARKER })),
        409,
        'NOT_YET_HANDED_OVER',
      )
    }

    assert.deepEqual(feedbackRows(database), before)
    assert.deepEqual(feedbackEvents(database), [])
  })

  test('the seeded feedback cannot be overwritten', async () => {
    const { env, database } = freshEnv()
    const before = feedbackRows(database)

    assertError(
      await read(await customerCall(env, tester, COMPLETED_WITH_FEEDBACK, 'POST', { rating: 1, comment: ECHO_MARKER })),
      409,
      'FEEDBACK_ALREADY_SUBMITTED',
    )
    assert.deepEqual(feedbackRows(database), before)
  })

  test('another customer gets the same 404 as an unknown id, and nothing is written (TM-06)', async () => {
    const { env, database } = freshEnv()
    const unknown = await read(await customerCall(env, other, UNKNOWN, 'POST', { rating: 5 }))

    assertError(unknown, 404, 'BOOKING_NOT_FOUND')

    for (const [method, body] of [['GET', undefined], ['POST', { rating: 1, comment: ECHO_MARKER }]]) {
      for (const bookingId of [COMPLETED, COMPLETED_WITH_FEEDBACK]) {
        const foreign = await read(await customerCall(env, other, bookingId, method, body))

        assert.equal(foreign.status, 404)
        assert.equal(foreign.text, unknown.text)
      }
    }

    assert.equal(feedbackRows(database).some((row) => row.booking_id === COMPLETED), false)
    assert.deepEqual(feedbackEvents(database), [])
  })

  test('the handlers bind the uid themselves: a stale ownership snapshot writes nothing (SB-20)', async () => {
    const { env, database } = freshEnv()
    // As if the booking changed hands after the dispatcher's ownership read.
    const context = (method, body) => {
      const req = request(`/api/bookings/${COMPLETED}/feedback`, method, 'unused', body)

      return {
        request: req,
        env,
        ctx: executionContext(),
        url: new URL(req.url),
        customer: { uid: other.uid, email: other.email, emailVerified: true, authTime: nowSeconds() - 60 },
        bookingId: COMPLETED,
        booking: { id: COMPLETED, status: 'confirmed', flowVersion: 2, eventDate: '2026-05-01', holdExpiresAt: null },
        params: {},
      }
    }

    assertError(await read(await handleSubmitFeedback(context('POST', { rating: 5, comment: ECHO_MARKER }))), 404, 'BOOKING_NOT_FOUND')
    assertError(await read(await handleGetFeedback(context('GET'))), 404, 'BOOKING_NOT_FOUND')
    assert.equal(feedbackRows(database).some((row) => row.booking_id === COMPLETED), false)
    assert.deepEqual(feedbackEvents(database), [])
  })

  test('no token: 401 before anything is read', async () => {
    const { env } = freshEnv()

    assert.equal((await customerCall(env, null, COMPLETED, 'GET')).status, 401)
    assert.equal((await customerCall(env, null, COMPLETED, 'POST', { rating: 5 })).status, 401)
  })

  test('unsupported methods answer 405 with Allow: GET, POST', async () => {
    const { env } = freshEnv()

    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await customerCall(env, tester, COMPLETED, method)

      assert.equal(response.status, 405)
      assert.equal(response.headers.get('Allow'), 'GET, POST')
    }
  })

  test('bodies: exact keys, JSON only, typed values, bounded bytes, no echo', async () => {
    const { env, database } = freshEnv()

    for (const body of [
      {},
      { comment: COMMENT },
      { rating: 5, comment: COMMENT, extra: ECHO_MARKER },
      { rating: 5, publish: true },
      { rating: '5' },
      { rating: 4.5 },
      { rating: 0 },
      { rating: 6 },
      { rating: 5, comment: 7 },
      [5],
      'null',
      `{"rating":5,"comment":"${ECHO_MARKER}"`,
    ]) {
      assertError(await read(await customerCall(env, tester, COMPLETED, 'POST', body)), 400, 'INVALID_REQUEST_BODY')
    }

    assertError(
      await read(await customerCall(env, tester, COMPLETED, 'POST', { rating: 5, comment: `${ECHO_MARKER}${'ا'.repeat(1000)}` })),
      400,
      'FIELD_TOO_LONG',
    )
    assertError(
      await read(await customerCall(env, tester, COMPLETED, 'POST', { rating: 5, comment: `‮${ECHO_MARKER}` })),
      400,
      'INVALID_TEXT',
    )
    assertError(
      await read(await customerCall(env, tester, COMPLETED, 'POST', { rating: 5, comment: 'ا'.repeat(FEEDBACK_BODY_MAX_BYTES) })),
      400,
      'INVALID_REQUEST_BODY',
    )

    const textPlain = new Request(`${ORIGIN}/api/bookings/${COMPLETED}/feedback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await mintToken(tester)}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ rating: 5 }),
    })

    assert.equal(
      (await dispatchCustomerPortalRequest(textPlain, env, new URL(textPlain.url), executionContext(), feedbackRoutes)).status,
      415,
    )
    assert.equal(feedbackRows(database).some((row) => row.booking_id === COMPLETED), false)

    // The longest valid comment, written with JSON escapes only, fits the cap.
    const escaped = `{"rating":5,"comment":"${'\\ud83c\\udf38'.repeat(FEEDBACK_COMMENT_MAX_CODE_POINTS)}"}`

    assert.ok(new TextEncoder().encode(escaped).length <= FEEDBACK_BODY_MAX_BYTES)
    assert.equal((await customerCall(env, tester, COMPLETED, 'POST', escaped)).status, 201)
  })

  test('RL_CUSTOMER_WRITE: a burst answers 429 with Retry-After and writes nothing', async () => {
    const { env, database } = freshEnv()

    env.RL_CUSTOMER_WRITE = new FakeRateLimit(0)

    const limited = await read(await customerCall(env, tester, COMPLETED, 'POST', { rating: 5 }))

    assertError(limited, 429, 'RATE_LIMITED')
    assert.equal(limited.headers.get('Retry-After'), '60')
    assert.deepEqual(env.RL_CUSTOMER_WRITE.keys, [tester.uid])
    assert.equal(feedbackRows(database).some((row) => row.booking_id === COMPLETED), false)
  })

  test('concurrent identical submissions store one row and one event', async () => {
    const { env, database } = freshEnv()
    const statuses = await Promise.all(
      [1, 2, 3].map(() => customerCall(env, tester, COMPLETED, 'POST', { rating: 4, comment: COMMENT }).then((r) => r.status)),
    )

    assert.deepEqual(statuses.sort(), [200, 200, 201])
    assert.equal(feedbackRows(database).filter((row) => row.booking_id === COMPLETED).length, 1)
    assert.equal(feedbackEvents(database).length, 1)
  })
})

// ---------------------------------------------------------------------------
// Admin route (#25)
// ---------------------------------------------------------------------------

describe('GET /api/admin/bookings/{id}/feedback', () => {
  test('the admin reads any booking\'s feedback; unknown ids 404', async () => {
    const { env } = freshEnv()

    await customerCall(env, tester, COMPLETED, 'POST', { rating: 2, comment: COMMENT })

    const stored = await read(await adminCall(env, admin, COMPLETED))

    assert.equal(stored.status, 200)
    assert.equal(stored.body.feedback.rating, 2)
    assert.equal(stored.body.feedback.comment, COMMENT)
    assert.notEqual(parseFeedbackResponse(stored.body), null)

    assert.deepEqual((await read(await adminCall(env, admin, HANDOVER_SCHEDULED))).body, { ok: true, feedback: null })
    assertError(await read(await adminCall(env, admin, UNKNOWN)), 404, 'BOOKING_NOT_FOUND')
  })

  test('read-only: every other method answers 405 with Allow: GET, and nothing changes', async () => {
    const { env, database } = freshEnv()
    const before = feedbackRows(database)

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await adminCall(env, admin, COMPLETED_WITH_FEEDBACK, method)

      assert.equal(response.status, 405)
      assert.equal(response.headers.get('Allow'), 'GET')
    }

    assert.deepEqual(feedbackRows(database), before)
  })

  test('customers are refused', async () => {
    const { env } = freshEnv()

    assertError(await read(await adminCall(env, tester, COMPLETED_WITH_FEEDBACK)), 403, 'FORBIDDEN')
  })

  test('RL_ADMIN_READ: a burst answers 429', async () => {
    const { env } = freshEnv()

    env.RL_ADMIN_READ = new FakeRateLimit(0)
    assertError(await read(await adminCall(env, admin, COMPLETED_WITH_FEEDBACK)), 429, 'RATE_LIMITED')
    assert.deepEqual(env.RL_ADMIN_READ.keys, [admin.uid])
  })
})
