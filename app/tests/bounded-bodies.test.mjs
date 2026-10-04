// W1-14 / C-5, C-9, SB-3, SB-9, R-05: bounded JSON bodies on the legacy
// handlers and the API security headers. Each case fails if its control is
// taken out of worker/http.ts, worker/profile.ts, worker/bookings.ts or
// worker/admin.ts:
// - readBoundedJson refuses a non-JSON type, checks a declared
//   Content-Length before reading a byte, and caps a chunked or understated
//   body with a streamed byte counter that cancels the stream; Wave 0's name
//   readJsonBody is the same function;
// - PUT /api/profile, POST /api/bookings and POST /api/admin/blocked-dates
//   answer 413 PAYLOAD_TOO_LARGE to a chunked 2 MiB body (audit SEC-05, plan
//   11 §6.3) after reading at most their cap plus one chunk, write nothing,
//   and still serve their normal requests;
// - error bodies are a fixed code and Arabic message that never echo the
//   request (SB-9);
// - PUT /api/profile applies shared/text.ts normalizePersonName, the rule
//   the sign-up form applies (SEC-10, R-07): a ZWNJ between two Arabic
//   letters (N-41) is saved, a leading or trailing ZWNJ and a ZWJ are not;
// - jsonResponse carries Strict-Transport-Security (SEC-12) with nosniff and
//   no-store, and no caller header overrides them;
// - the plan's codes (R-05): 429 RATE_LIMITED from the RL_BOOKING /
//   RL_PROFILE bindings (worker/rate-limit.ts) and 409 OPEN_REQUEST_LIMIT
//   for the open-request cap (W2-16; Wave 0 named it TOO_MANY_OPEN_REQUESTS).
//   One booking code keeps its Wave 0 name because the shipped booking form
//   (src/api/bookings.ts) accepts no other: 400 BOOKING_TOO_FAR_AHEAD
//   (DATE_BEYOND_HORIZON with W3-15). The cap's 409 is fed through that
//   client to prove the form still names the cap.
//
// No network: the Firebase JWKS is served by a fetch stub from a key made
// here, and D1 is node:sqlite with the repository's migrations applied.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SignJWT, exportJWK, generateKeyPair } from 'jose'

import { OPEN_BOOKING_REQUESTS_MAX } from '../shared/limits.ts'
import { normalizePersonName } from '../shared/text.ts'
import { latestBookableDateKey } from '../shared/timing.ts'
import { createBookingRequest } from '../src/api/bookings.ts'
import { normalizePersonName as formNameRule } from '../src/auth/person-name.ts'
import {
  serverLimitMessages,
  toCurrentServerErrorCode,
} from '../src/lib/server-error-messages.ts'
import { handleAdminRequest } from '../worker/admin.ts'
import { handleCreateBooking } from '../worker/bookings.ts'
import {
  errorResponse,
  jsonResponse,
  readBoundedJson,
  readJsonBody,
} from '../worker/http.ts'
import { handleProfile } from '../worker/profile.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROJECT_ID = 'sundus-yar-w1-14-test'
const KEY_ID = 'w1-14-test-key'
const ORIGIN = 'https://sundusyar.test'
const DAY_MS = 24 * 60 * 60 * 1000

const HSTS = 'max-age=63072000; includeSubDomains'
const PAYLOAD_TOO_LARGE_MESSAGE = 'حجم البيانات المرسلة أكبر من المسموح.'
const RATE_LIMITED_MESSAGE = 'طلبات كثيرة خلال وقت قصير. حاولي مرة أخرى بعد قليل.'
/**
 * The cap's wording, byte for byte: the Worker's 409 OPEN_REQUEST_LIMIT
 * (worker/rate-limit.ts) and what the booking form shows for it
 * (src/lib/server-error-messages.ts) are the same sentence.
 */
const OPEN_REQUEST_LIMIT_MESSAGE =
  'لديكِ ثلاثة طلبات مفتوحة. انتظري الرد عليها قبل إرسال طلب جديد.'
const BOOKING_TOO_FAR_AHEAD_MESSAGE =
  'لا يمكن الحجز لأكثر من سنتين مقدمًا. اختاري تاريخًا أقرب.'

/** The handlers' caps in UTF-8 bytes (profile.ts, bookings.ts, admin.ts). */
const PROFILE_CAP = 4_096
const BOOKING_CAP = 20_000
const BLOCKED_DATE_CAP = 2_000

const CHUNK_BYTES = 1_024
const TWO_MEBIBYTES = 2 * 1024 * 1024

/** A string the request carries and no response may repeat. */
const ECHO_MARKER = 'W114-ECHO-MARKER'

// ---------------------------------------------------------------------------
// Local stand-ins: D1 over node:sqlite, the JWKS endpoint, ExecutionContext,
// the ratelimits binding
// ---------------------------------------------------------------------------

/** D1 binds a whole JS number as INTEGER; node:sqlite would bind REAL. */
function toSqliteValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? BigInt(value)
    : value
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

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.params)

    if (row === undefined) {
      return null
    }

    return column === undefined ? { ...row } : row[column]
  }

  async all() {
    const results = this.database
      .prepare(this.sql)
      .all(...this.params)
      .map((row) => ({ ...row }))

    return { success: true, results, meta: { changes: 0 } }
  }

  async run() {
    const info = this.database.prepare(this.sql).run(...this.params)

    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    }
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
        const returnsRows =
          this.database.prepare(statement.sql).columns().length > 0

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

/** The workerd `ratelimits` binding: a fixed allowance per key. */
class FakeRateLimit {
  constructor(allowance) {
    this.allowance = allowance
    this.calls = []
  }

  async limit(options) {
    this.calls.push(options)

    const used = this.calls.filter((call) => call.key === options.key).length

    return { success: used <= this.allowance }
  }
}

function migratedDatabase() {
  const database = new DatabaseSync(':memory:')
  const migrationsDirectory = join(APP_ROOT, 'migrations')

  database.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(migrationsDirectory, name), 'utf8'))
  }

  return database
}

/** Collects what the handlers hand to waitUntil, so each test can settle it. */
function executionContext() {
  const pending = []

  return {
    pending,
    waitUntil(promise) {
      pending.push(promise)
    },
    passThroughOnException() {},
  }
}

const originalFetch = globalThis.fetch
let signingKey

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

async function mintToken({ uid, email, emailVerified = true }) {
  return new SignJWT({
    email,
    email_verified: emailVerified,
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

  const publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: KEY_ID,
    alg: 'RS256',
    use: 'sig',
  }

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
// Bodies
// ---------------------------------------------------------------------------

/**
 * A chunked body of `totalBytes`, produced only when the reader pulls
 * (highWaterMark 0), so `probe.pulledBytes` is what the Worker read and
 * `probe.cancelled` whether it cancelled the rest. It starts like a JSON
 * object and never ends like one.
 */
function chunkedBody(totalBytes) {
  const probe = { pulledBytes: 0, cancelled: false }
  const head = new TextEncoder().encode(`{"firstName":"${ECHO_MARKER}`)

  const stream = new ReadableStream(
    {
      pull(controller) {
        if (probe.pulledBytes >= totalBytes) {
          controller.close()

          return
        }

        const size = Math.min(CHUNK_BYTES, totalBytes - probe.pulledBytes)
        const chunk = new Uint8Array(size).fill(0x61)

        if (probe.pulledBytes === 0) {
          chunk.set(head.subarray(0, size))
        }

        probe.pulledBytes += size
        controller.enqueue(chunk)
      },
      cancel() {
        probe.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )

  return { stream, probe }
}

function streamedRequest(path, method, token, stream, headers = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
      ...headers,
    },
    body: stream,
    duplex: 'half',
  })
}

function jsonRequest(path, method, token, body, headers = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** The response as text, and its error envelope when it is one. */
async function readError(response) {
  const text = await response.text()
  const body = JSON.parse(text)

  return { status: response.status, text, body }
}

/**
 * An error body is exactly { ok: false, error: { code, message } }: no
 * detail, stack or SQL next to the fixed code, and nothing of the request.
 */
function assertFixedError(error, status, code) {
  assert.equal(error.status, status)
  assert.deepEqual(Object.keys(error.body).sort(), ['error', 'ok'])
  assert.equal(error.body.ok, false)
  assert.deepEqual(Object.keys(error.body.error).sort(), ['code', 'message'])
  assert.equal(error.body.error.code, code)
  assert.match(error.body.error.message, /[؀-ۿ]/)
  assert.equal(error.text.includes(ECHO_MARKER), false, 'the response echoes the request')
}

function assertApiHeaders(response) {
  assert.equal(response.headers.get('Strict-Transport-Security'), HSTS)
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8')
}

/** A calendar date `days` from now, far inside the booking horizon. */
function futureDate(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10)
}

const validSelection = {
  coverageId: 'four-hours',
  albumEnabled: true,
  albumSizeId: 'medium',
  photoCount: 45,
  albumPageCount: 15,
  albumBoxId: 'normal',
  printQuantities: { a6: 0, a5: 0, a4: 0 },
  magazineQuantity: 0,
  magazinePageCount: 1,
  woodenEnlargementQuantity: 0,
}

// ---------------------------------------------------------------------------
// Fixture: one admin, one customer with a profile, fresh database per test
// ---------------------------------------------------------------------------

const admin = { uid: 'w114Admin', email: 'studio-admin@example.test' }
const customer = { uid: 'w114Customer', email: 'bride@example.test' }
const newCustomer = { uid: 'w114NewCustomer', email: 'new-bride@example.test' }

function insertUser(database, user, role) {
  database
    .prepare(
      `INSERT INTO users
         (id, email, first_name, last_name, phone, role, email_verified_at)
       VALUES (?, ?, 'سارة', 'تجريبية', '+966500000001', ?, '2026-09-01T10:00:00.000Z')`,
    )
    .run(user.uid, user.email, role)
}

function freshEnv(vars = {}) {
  const database = migratedDatabase()

  insertUser(database, admin, 'admin')
  insertUser(database, customer, 'customer')

  return {
    database,
    env: {
      DB: new D1DatabaseStub(database),
      FIREBASE_PROJECT_ID: PROJECT_ID,
      ADMIN_MEDIA_MFA: 'required',
      ADMIN_SETTINGS_2F: 'off',
      RL_BOOKING: new FakeRateLimit(100),
      RL_PROFILE: new FakeRateLimit(100),
      ...vars,
    },
  }
}

function countRows(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
}

async function adminRequest(env, request) {
  const ctx = executionContext()
  const response = await handleAdminRequest(request, env, new URL(request.url), ctx)

  await Promise.allSettled(ctx.pending)

  return response
}

async function bookingRequest(env, request) {
  const ctx = executionContext()
  const response = await handleCreateBooking(request, env, ctx)

  await Promise.allSettled(ctx.pending)

  return response
}

// ---------------------------------------------------------------------------
// worker/http.ts
// ---------------------------------------------------------------------------

describe('jsonResponse: API security headers (C-9, SEC-12)', () => {
  test('every JSON response carries HSTS, nosniff, no-store and the JSON type', async () => {
    const response = jsonResponse({ ok: true, value: 1 }, 201)

    assert.equal(response.status, 201)
    assertApiHeaders(response)
    assert.deepEqual(await response.json(), { ok: true, value: 1 })
  })

  test('an error response has the same headers and keeps the caller\'s own', async () => {
    const response = errorResponse(429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE, {
      'Retry-After': '60',
    })

    assertApiHeaders(response)
    assert.equal(response.headers.get('Retry-After'), '60')
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: 'RATE_LIMITED', message: RATE_LIMITED_MESSAGE },
    })
  })

  test('a caller header cannot weaken HSTS, nosniff or no-store', () => {
    const response = jsonResponse({ ok: true }, 200, {
      'Strict-Transport-Security': 'max-age=0',
      'X-Content-Type-Options': 'sniff',
      'Cache-Control': 'public, max-age=600',
      'Content-Type': 'text/html',
    })

    assertApiHeaders(response)
  })
})

describe('readBoundedJson: the bounded reader (C-5, SEC-05, SB-3)', () => {
  const CAP = 64

  function plainRequest(body, headers = {}) {
    return new Request(`${ORIGIN}/api/x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    })
  }

  test('only application/json (parameters and case aside) is read', async () => {
    for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON']) {
      const result = await readBoundedJson(plainRequest('{"a":1}', { 'Content-Type': type }), CAP)

      assert.deepEqual(result, { kind: 'parsed', value: { a: 1 } }, type)
    }

    for (const type of ['text/plain', 'application/json-patch+json', 'multipart/form-data']) {
      const { stream, probe } = chunkedBody(CAP)
      const result = await readBoundedJson(
        streamedRequest('/api/x', 'POST', null, stream, { 'Content-Type': type }),
        CAP,
      )

      assert.deepEqual(result, { kind: 'unsupported-media-type' }, type)
      assert.equal(probe.pulledBytes, 0, `${type}: read before the type check`)
    }
  })

  test('a declared Content-Length over the cap is refused before a byte is read', async () => {
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const result = await readBoundedJson(
      streamedRequest('/api/x', 'POST', null, stream, {
        'Content-Length': String(TWO_MEBIBYTES),
      }),
      CAP,
    )

    assert.deepEqual(result, { kind: 'too-large' })
    assert.equal(probe.pulledBytes, 0)
  })

  test('a malformed Content-Length is invalid', async () => {
    for (const declared of ['abc', '-1', '1e3', '12.5', '1234567890123456']) {
      const { stream, probe } = chunkedBody(8)
      const result = await readBoundedJson(
        streamedRequest('/api/x', 'POST', null, stream, { 'Content-Length': declared }),
        CAP,
      )

      assert.deepEqual(result, { kind: 'invalid' }, declared)
      assert.equal(probe.pulledBytes, 0, declared)
    }
  })

  test('a chunked body (no Content-Length) stops at the cap and the stream is cancelled', async () => {
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const request = streamedRequest('/api/x', 'POST', null, stream)

    assert.equal(request.headers.get('Content-Length'), null)
    assert.deepEqual(await readBoundedJson(request, CAP), { kind: 'too-large' })
    assert.ok(probe.pulledBytes <= CAP + CHUNK_BYTES, `read ${probe.pulledBytes} bytes`)
    assert.equal(probe.cancelled, true)
  })

  test('an understated Content-Length does not lift the cap', async () => {
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const result = await readBoundedJson(
      streamedRequest('/api/x', 'POST', null, stream, { 'Content-Length': '10' }),
      CAP,
    )

    assert.deepEqual(result, { kind: 'too-large' })
    assert.ok(probe.pulledBytes <= CAP + CHUNK_BYTES, `read ${probe.pulledBytes} bytes`)
    assert.equal(probe.cancelled, true)
  })

  test('the cap counts UTF-8 bytes: exactly the cap is read, one byte more is not', async () => {
    // 'س' is two bytes in UTF-8: 8 bytes of JSON syntax + 28 × 2 = 64.
    const atCap = JSON.stringify({ n: 'س'.repeat(28) })

    assert.equal(new TextEncoder().encode(atCap).byteLength, CAP)
    assert.equal((await readBoundedJson(plainRequest(atCap), CAP)).kind, 'parsed')

    const overCap = JSON.stringify({ n: `${'س'.repeat(28)}a` })

    assert.deepEqual(await readBoundedJson(plainRequest(overCap), CAP), { kind: 'too-large' })
  })

  test('Wave 0\'s readJsonBody is the same function, not a second reader', () => {
    assert.equal(readJsonBody, readBoundedJson)
  })

  test('an empty body, invalid UTF-8 and malformed JSON are invalid', async () => {
    assert.deepEqual(await readBoundedJson(plainRequest(''), CAP), { kind: 'invalid' })
    assert.deepEqual(
      await readBoundedJson(plainRequest(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])), CAP),
      { kind: 'invalid' },
    )
    assert.deepEqual(await readBoundedJson(plainRequest('{"a":'), CAP), { kind: 'invalid' })
  })
})

// ---------------------------------------------------------------------------
// PUT /api/profile
// ---------------------------------------------------------------------------

describe('PUT /api/profile: bounded body (SEC-05) and the plan\'s codes (R-05)', () => {
  test('a chunked 2 MiB body → 413 PAYLOAD_TOO_LARGE, read up to the cap only, nothing written', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(newCustomer)
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const request = streamedRequest('/api/profile', 'PUT', token, stream)

    assert.equal(request.headers.get('Content-Length'), null)

    const response = await handleProfile(request, env)
    const error = await readError(response)

    assertFixedError(error, 413, 'PAYLOAD_TOO_LARGE')
    assert.equal(error.body.error.message, PAYLOAD_TOO_LARGE_MESSAGE)
    assertApiHeaders(response)
    assert.ok(probe.pulledBytes <= PROFILE_CAP + CHUNK_BYTES, `read ${probe.pulledBytes} bytes`)
    assert.equal(probe.cancelled, true)
    assert.equal(countRows(database, 'users'), 2)
  })

  test('a declared 2 MiB Content-Length → 413 before the body is read', async () => {
    const { env } = freshEnv()
    const token = await mintToken(customer)
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const response = await handleProfile(
      streamedRequest('/api/profile', 'PUT', token, stream, {
        'Content-Length': String(TWO_MEBIBYTES),
      }),
      env,
    )

    assertFixedError(await readError(response), 413, 'PAYLOAD_TOO_LARGE')
    assert.equal(probe.pulledBytes, 0)
  })

  test('the normal save still works (a new row, then an update)', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(newCustomer)
    const profile = { firstName: 'ريم', lastName: 'العتيبي', phone: '0551234567' }

    const created = await handleProfile(jsonRequest('/api/profile', 'PUT', token, profile), env)

    assert.equal(created.status, 200)
    assertApiHeaders(created)

    const body = await created.json()

    assert.equal(body.ok, true)
    assert.equal(body.profile.firstName, 'ريم')
    assert.equal(body.profile.phone, '+966551234567')
    assert.equal(countRows(database, 'users'), 3)

    const updated = await handleProfile(
      jsonRequest('/api/profile', 'PUT', token, { ...profile, lastName: 'الحربي' }),
      env,
    )

    assert.equal(updated.status, 200)
    assert.equal((await updated.json()).profile.lastName, 'الحربي')
  })

  test('refusals are fixed codes that never echo the request', async () => {
    const { env } = freshEnv()
    const token = await mintToken(customer)
    const cases = [
      [{ firstName: `<img src=x onerror=alert(1)>${ECHO_MARKER}`, lastName: 'العتيبي', phone: '0551234567' }, 400, 'INVALID_PROFILE'],
      [{ firstName: 'ريم', lastName: 'العتيبي', phone: ECHO_MARKER }, 400, 'INVALID_PROFILE'],
      [{ firstName: 'ريم', lastName: 'العتيبي', phone: '0551234567', [ECHO_MARKER]: 1 }, 400, 'INVALID_PROFILE'],
      [`{"firstName":"${ECHO_MARKER}"`, 400, 'INVALID_JSON'],
    ]

    for (const [body, status, code] of cases) {
      const response = await handleProfile(jsonRequest('/api/profile', 'PUT', token, body), env)

      assertFixedError(await readError(response), status, code)
    }

    const wrongType = await handleProfile(
      jsonRequest('/api/profile', 'PUT', token, ECHO_MARKER, { 'Content-Type': 'text/plain' }),
      env,
    )

    assertFixedError(await readError(wrongType), 415, 'UNSUPPORTED_MEDIA_TYPE')
  })

  test('the burst limit is the RL_PROFILE binding: 429 RATE_LIMITED before the body is read', async () => {
    const { env } = freshEnv({ RL_PROFILE: new FakeRateLimit(0) })
    const token = await mintToken(customer)
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const response = await handleProfile(streamedRequest('/api/profile', 'PUT', token, stream), env)
    const error = await readError(response)

    assertFixedError(error, 429, 'RATE_LIMITED')
    assert.equal(error.body.error.message, RATE_LIMITED_MESSAGE)
    assert.equal(response.headers.get('Retry-After'), '60')
    assertApiHeaders(response)
    assert.equal(probe.pulledBytes, 0)
    assert.deepEqual(env.RL_PROFILE.calls, [{ key: customer.uid }])
  })

  test('the Wave 0 binding name is no longer consulted', async () => {
    const { env } = freshEnv({ PROFILE_RATE_LIMITER: new FakeRateLimit(0) })
    const token = await mintToken(customer)
    const response = await handleProfile(
      jsonRequest('/api/profile', 'PUT', token, { firstName: 'ريم', lastName: 'العتيبي', phone: '0551234567' }),
      env,
    )

    assert.equal(response.status, 200)
    assert.deepEqual(env.PROFILE_RATE_LIMITER.calls, [])
  })
})

describe('PUT /api/profile: the sign-up form\'s name rule (SEC-10, R-07)', () => {
  const ZWNJ = '‌'
  const ZWJ = '‍'
  /** N-41: a Persian name written with a ZWNJ between two Arabic letters. */
  const NARGES_KHANUM = `نرگس${ZWNJ}خانم`

  function storedName(database, uid) {
    const row = database
      .prepare('SELECT first_name AS firstName, last_name AS lastName FROM users WHERE id = ?')
      .get(uid)

    return { firstName: row.firstName, lastName: row.lastName }
  }

  test('a ZWNJ between two Arabic letters is saved as she typed it', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(newCustomer)
    const response = await handleProfile(
      jsonRequest('/api/profile', 'PUT', token, {
        firstName: NARGES_KHANUM,
        lastName: `آل${ZWNJ}سعود`,
        phone: '0551234567',
      }),
      env,
    )

    assert.equal(response.status, 200)
    assertApiHeaders(response)

    const body = await response.json()

    assert.equal(body.profile.firstName, NARGES_KHANUM)
    assert.equal(body.profile.lastName, `آل${ZWNJ}سعود`)
    assert.deepEqual(storedName(database, newCustomer.uid), {
      firstName: NARGES_KHANUM,
      lastName: `آل${ZWNJ}سعود`,
    })
  })

  test('a leading or trailing ZWNJ, a ZWNJ off an Arabic letter pair and a ZWJ → 400 INVALID_PROFILE, nothing written', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(customer)
    const refusedNames = [
      `${ZWNJ}نرگس`,
      `نرگس${ZWNJ}`,
      `${ZWNJ}${NARGES_KHANUM}${ZWNJ}`,
      `نرگس${ZWNJ}${ZWNJ}خانم`,
      `نرگس${ZWNJ} خانم`,
      `Nar${ZWNJ}ges`,
      `نرگس${ZWJ}خانم`,
      `نرگس${ZWNJ}${ZWJ}خانم`,
    ]

    for (const name of refusedNames) {
      for (const field of ['firstName', 'lastName']) {
        const profile = { firstName: 'ريم', lastName: 'العتيبي', phone: '0551234567', [field]: name }
        const response = await handleProfile(jsonRequest('/api/profile', 'PUT', token, profile), env)
        const label = `${field}: ${JSON.stringify(name)}`

        assertFixedError(await readError(response), 400, 'INVALID_PROFILE')
        assert.deepEqual(
          storedName(database, customer.uid),
          { firstName: 'سارة', lastName: 'تجريبية' },
          label,
        )
      }
    }
  })

  test('the Worker gives the sign-up form\'s verdict on every name, so a name the form accepts is saved', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(customer)
    const names = [
      NARGES_KHANUM,
      `${ZWNJ}نرگس`,
      `نرگس${ZWNJ}`,
      `نرگس${ZWJ}خانم`,
      '  ريم  ',
      'آل  سعود',
      'O’Neil',
      'سُندُس',
      'https://example.test',
      '﻿ريم',
      'ريم ',
    ]

    for (const name of names) {
      const formVerdict = formNameRule(name)
      const response = await handleProfile(
        jsonRequest('/api/profile', 'PUT', token, {
          firstName: name,
          lastName: 'العتيبي',
          phone: '0551234567',
        }),
        env,
      )
      const label = JSON.stringify(name)

      assert.equal(formVerdict, normalizePersonName(name), label)

      if (formVerdict === null) {
        assertFixedError(await readError(response), 400, 'INVALID_PROFILE')
      } else {
        assert.equal(response.status, 200, label)
        assert.equal((await response.json()).profile.firstName, formVerdict, label)
        assert.equal(storedName(database, customer.uid).firstName, formVerdict, label)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// POST /api/bookings
// ---------------------------------------------------------------------------

describe('POST /api/bookings: bounded body (SEC-05) and the plan\'s codes (R-05)', () => {
  test('a chunked 2 MiB body → 413 PAYLOAD_TOO_LARGE, read up to the cap only, nothing written', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(customer)
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const response = await bookingRequest(env, streamedRequest('/api/bookings', 'POST', token, stream))
    const error = await readError(response)

    assertFixedError(error, 413, 'PAYLOAD_TOO_LARGE')
    assert.equal(error.body.error.message, PAYLOAD_TOO_LARGE_MESSAGE)
    assertApiHeaders(response)
    assert.ok(probe.pulledBytes <= BOOKING_CAP + CHUNK_BYTES, `read ${probe.pulledBytes} bytes`)
    assert.equal(probe.cancelled, true)
    assert.equal(countRows(database, 'booking_requests'), 0)
  })

  test('a declared 2 MiB Content-Length → 413 before the body is read', async () => {
    const { env } = freshEnv()
    const token = await mintToken(customer)
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const response = await bookingRequest(
      env,
      streamedRequest('/api/bookings', 'POST', token, stream, {
        'Content-Length': String(TWO_MEBIBYTES),
      }),
    )

    assertFixedError(await readError(response), 413, 'PAYLOAD_TOO_LARGE')
    assert.equal(probe.pulledBytes, 0)
  })

  /**
   * Fills her open requests up to the cap with normal requests (each a 201)
   * and returns the Worker's answer to one more.
   */
  async function requestPastOpenCap(env, token) {
    for (let index = 0; index < OPEN_BOOKING_REQUESTS_MAX; index += 1) {
      const eventDate = futureDate(40 + index)
      const response = await bookingRequest(
        env,
        jsonRequest('/api/bookings', 'POST', token, { eventDate, selection: validSelection }),
      )

      assert.equal(response.status, 201, eventDate)
      assertApiHeaders(response)

      const body = await response.json()

      assert.equal(body.ok, true)
      assert.equal(body.booking.eventDate, eventDate)
      assert.equal(body.booking.status, 'pending_review')
    }

    return bookingRequest(
      env,
      jsonRequest('/api/bookings', 'POST', token, {
        eventDate: futureDate(40 + OPEN_BOOKING_REQUESTS_MAX),
        selection: validSelection,
      }),
    )
  }

  test(`the normal request still works; request ${OPEN_BOOKING_REQUESTS_MAX + 1} open → the plan's 409 OPEN_REQUEST_LIMIT`, async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(customer)
    const response = await requestPastOpenCap(env, token)
    const error = await readError(response)

    assertFixedError(error, 409, 'OPEN_REQUEST_LIMIT')
    assert.equal(error.body.error.message, OPEN_REQUEST_LIMIT_MESSAGE)
    assertApiHeaders(response)
    assert.equal(countRows(database, 'booking_requests'), OPEN_BOOKING_REQUESTS_MAX)
  })

  test('the booking form (src/api/bookings.ts) reads that 409 as the cap, not as a malformed answer', async () => {
    const { env } = freshEnv()
    const token = await mintToken(customer)
    const workerResponse = await requestPastOpenCap(env, token)
    const workerText = await workerResponse.text()
    const jwksFetch = globalThis.fetch
    const clientRequests = []

    // The client's fetch('/api/bookings') gets the Worker's own answer.
    globalThis.fetch = async (input, init) => {
      clientRequests.push({ path: String(input), method: init?.method })

      return new Response(workerText, {
        status: workerResponse.status,
        headers: workerResponse.headers,
      })
    }

    let result

    try {
      result = await createBookingRequest(
        'w114-client-token',
        futureDate(40 + OPEN_BOOKING_REQUESTS_MAX),
        validSelection,
      )
    } finally {
      globalThis.fetch = jwksFetch
    }

    assert.deepEqual(clientRequests, [{ path: '/api/bookings', method: 'POST' }])
    assert.deepEqual(result, { ok: false, error: { code: 'TOO_MANY_OPEN_REQUESTS' } })
    // PackageConfigurator shows serverLimitMessages[code] for this code, and
    // the shared API client files it under the plan's name.
    assert.equal(serverLimitMessages[result.error.code], OPEN_REQUEST_LIMIT_MESSAGE)
    assert.equal(toCurrentServerErrorCode(result.error.code), 'OPEN_REQUEST_LIMIT')
  })

  test('the last bookable day is accepted; the day after → 400 BOOKING_TOO_FAR_AHEAD', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(customer)
    const lastDay = latestBookableDateKey(new Date())
    const dayAfter = new Date(Date.parse(`${lastDay}T00:00:00Z`) + DAY_MS)
      .toISOString()
      .slice(0, 10)

    const beyond = await bookingRequest(
      env,
      jsonRequest('/api/bookings', 'POST', token, { eventDate: dayAfter, selection: validSelection }),
    )
    const error = await readError(beyond)

    assertFixedError(error, 400, 'BOOKING_TOO_FAR_AHEAD')
    assert.equal(error.body.error.message, BOOKING_TOO_FAR_AHEAD_MESSAGE)
    assertApiHeaders(beyond)
    assert.equal(countRows(database, 'booking_requests'), 0)

    const last = await bookingRequest(
      env,
      jsonRequest('/api/bookings', 'POST', token, { eventDate: lastDay, selection: validSelection }),
    )

    assert.equal(last.status, 201)
    assert.equal(countRows(database, 'booking_requests'), 1)
  })

  test('refusals are fixed codes that never echo the request', async () => {
    const { env } = freshEnv()
    const token = await mintToken(customer)
    const cases = [
      [{ eventDate: ECHO_MARKER, selection: validSelection }, 400, 'INVALID_EVENT_DATE'],
      [{ eventDate: futureDate(40), selection: { ...validSelection, coverageId: ECHO_MARKER } }, 400, 'INVALID_BOOKING_SELECTION'],
      [{ eventDate: futureDate(40), selection: validSelection, [ECHO_MARKER]: true }, 400, 'INVALID_JSON'],
      [`{"eventDate":"${ECHO_MARKER}"`, 400, 'INVALID_JSON'],
    ]

    for (const [body, status, code] of cases) {
      const response = await bookingRequest(env, jsonRequest('/api/bookings', 'POST', token, body))

      assertFixedError(await readError(response), status, code)
    }

    const wrongType = await bookingRequest(
      env,
      jsonRequest('/api/bookings', 'POST', token, ECHO_MARKER, { 'Content-Type': 'text/plain' }),
    )

    assertFixedError(await readError(wrongType), 415, 'UNSUPPORTED_MEDIA_TYPE')
  })

  test('the burst limit is the RL_BOOKING binding: 429 RATE_LIMITED before the body is read', async () => {
    const { database, env } = freshEnv({
      RL_BOOKING: new FakeRateLimit(0),
      BOOKING_RATE_LIMITER: new FakeRateLimit(100),
    })
    const token = await mintToken(customer)
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const response = await bookingRequest(env, streamedRequest('/api/bookings', 'POST', token, stream))
    const error = await readError(response)

    assertFixedError(error, 429, 'RATE_LIMITED')
    assert.equal(error.body.error.message, RATE_LIMITED_MESSAGE)
    assert.equal(response.headers.get('Retry-After'), '60')
    assertApiHeaders(response)
    assert.equal(probe.pulledBytes, 0)
    assert.deepEqual(env.RL_BOOKING.calls, [{ key: customer.uid }])
    assert.deepEqual(env.BOOKING_RATE_LIMITER.calls, [])
    assert.equal(countRows(database, 'booking_requests'), 0)
  })
})

// ---------------------------------------------------------------------------
// POST /api/admin/blocked-dates
// ---------------------------------------------------------------------------

describe('POST /api/admin/blocked-dates: bounded body (SEC-05)', () => {
  test('a chunked 2 MiB body → 413 PAYLOAD_TOO_LARGE, read up to the cap only, nothing written', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(admin)
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const response = await adminRequest(
      env,
      streamedRequest('/api/admin/blocked-dates', 'POST', token, stream),
    )
    const error = await readError(response)

    assertFixedError(error, 413, 'PAYLOAD_TOO_LARGE')
    assertApiHeaders(response)
    assert.ok(probe.pulledBytes <= BLOCKED_DATE_CAP + CHUNK_BYTES, `read ${probe.pulledBytes} bytes`)
    assert.equal(probe.cancelled, true)
    assert.equal(countRows(database, 'blocked_dates'), 0)
  })

  test('a declared 2 MiB Content-Length → 413 before the body is read', async () => {
    const { env } = freshEnv()
    const token = await mintToken(admin)
    const { stream, probe } = chunkedBody(TWO_MEBIBYTES)
    const response = await adminRequest(
      env,
      streamedRequest('/api/admin/blocked-dates', 'POST', token, stream, {
        'Content-Length': String(TWO_MEBIBYTES),
      }),
    )

    assertFixedError(await readError(response), 413, 'PAYLOAD_TOO_LARGE')
    assert.equal(probe.pulledBytes, 0)
  })

  test('the normal block and unblock still work', async () => {
    const { database, env } = freshEnv()
    const token = await mintToken(admin)
    const date = futureDate(60)
    const blocked = await adminRequest(
      env,
      jsonRequest('/api/admin/blocked-dates', 'POST', token, { date, reason: 'إجازة' }),
    )

    assert.equal(blocked.status, 200)
    assertApiHeaders(blocked)

    const body = await blocked.json()

    assert.equal(body.ok, true)
    assert.equal(body.blockedDate.date, date)
    assert.equal(body.blockedDate.reason, 'إجازة')
    assert.equal(countRows(database, 'blocked_dates'), 1)

    const unblocked = await adminRequest(
      env,
      new Request(`${ORIGIN}/api/admin/blocked-dates/${date}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
    )

    assert.equal(unblocked.status, 200)
    assert.deepEqual(await unblocked.json(), { ok: true, date, deleted: true })
  })

  test('refusals are fixed codes that never echo the request', async () => {
    const { env } = freshEnv()
    const token = await mintToken(admin)
    const cases = [
      [{ date: ECHO_MARKER }, 400, 'INVALID_DATE'],
      [{ date: futureDate(60), reason: `${ECHO_MARKER}\u0000` }, 400, 'INVALID_BLOCKED_DATE'],
      [{ date: futureDate(60), [ECHO_MARKER]: 'x' }, 400, 'INVALID_BLOCKED_DATE'],
      [`{"date":"${ECHO_MARKER}"`, 400, 'INVALID_BLOCKED_DATE'],
    ]

    for (const [body, status, code] of cases) {
      const response = await adminRequest(
        env,
        jsonRequest('/api/admin/blocked-dates', 'POST', token, body),
      )

      assertFixedError(await readError(response), status, code)
    }
  })
})
