// W1-15 / TM-11, C-4, SB-15, SB-7, SB-4: the burst limiter and the windowed
// caps (plan 11 §3.1). Each case fails if its control is taken out of
// worker/rate-limit.ts or shared/limits.ts: fail-open with a fixed log code
// and never the key, the runtime shape check of the binding, the uid and
// CF-Connecting-IP keys, the 429/409 contracts, the §3.1 numbers and their
// match with wrangler.jsonc, and the caps inside real writing statements on
// the repository's migrations (node:sqlite, foreign keys on as in D1).
//
// Binding note (as tests/migrations.test.mjs): node:sqlite binds every
// number as REAL, so safe integers are bound as BigInt.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import ts from 'typescript'

import {
  BURST_LIMITS,
  BURST_PERIOD_SECONDS,
  CSP_REPORT_ROWS_PER_DAY_MAX,
  LONGEST_LIMIT_WINDOW_SECONDS,
  OPEN_BOOKING_REQUESTS_MAX,
  RECEIPT_ATTEMPTS_MAX,
  WINDOWED_CAPS,
  windowStart,
} from '../shared/limits.ts'
import {
  connectingIpKey,
  isRateLimited,
  limitBurst,
  openRequestLimitResponse,
  rateLimitedResponse,
} from '../worker/rate-limit.ts'

const UID = 'BrideUid0001SecretLookingKey'
const OTHER_UID = 'BrideUid0002'

const BINDING_MISSING_LOG = 'RATE_LIMIT_SKIPPED code=RL_BINDING_MISSING'
const UNAVAILABLE_LOG = 'RATE_LIMIT_SKIPPED code=RL_UNAVAILABLE'

/**
 * A stand-in for the workerd `ratelimits` binding: `limit` on the prototype,
 * a fixed allowance per key, and every options object it received.
 */
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

/** Records every console call of the test; returns the arguments per call. */
function captureConsole(t) {
  const calls = []

  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => {
      calls.push({ method, args })
    })
  }

  return calls
}

function assertNothingLogged(calls) {
  assert.deepEqual(calls, [])
}

function assertOnlyLogged(calls, line, times = 1) {
  assert.deepEqual(
    calls,
    Array.from({ length: times }, () => ({ method: 'warn', args: [line] })),
  )
}

function requestFrom(headers) {
  return new Request('https://example.test/api/availability', { headers })
}

// ---------------------------------------------------------------------------
// limitBurst
// ---------------------------------------------------------------------------

describe('limitBurst (binding present)', () => {
  test('allows within the allowance and limits after it, keyed exactly as given', async (t) => {
    const logs = captureConsole(t)
    const binding = new FakeRateLimit(3)

    for (let request = 1; request <= 3; request += 1) {
      assert.equal(await limitBurst(binding, UID), 'allowed')
    }

    assert.equal(await limitBurst(binding, UID), 'limited')
    assert.equal(await limitBurst(binding, OTHER_UID), 'allowed')
    assert.deepEqual(binding.calls.map((call) => call.key), [UID, UID, UID, UID, OTHER_UID])
    assert.deepEqual(Object.keys(binding.calls[0]), ['key'])
    assertNothingLogged(logs)
  })

  test('only an explicit success:false limits', async (t) => {
    const logs = captureConsole(t)

    assert.equal(await limitBurst({ limit: async () => ({ success: true }) }, UID), 'allowed')
    assert.equal(await limitBurst({ limit: async () => ({ success: false }) }, UID), 'limited')
    assertNothingLogged(logs)
  })
})

describe('limitBurst is fail-open with a fixed code and never logs the key (SB-7)', () => {
  test('missing binding: allowed, one counts-only line code=RL_BINDING_MISSING', async (t) => {
    const logs = captureConsole(t)

    assert.equal(await limitBurst(undefined, UID), 'allowed')
    assertOnlyLogged(logs, BINDING_MISSING_LOG)
  })

  test('a value that is not a binding (runtime shape, never the generated type) counts as missing', async (t) => {
    const logs = captureConsole(t)
    const notBindings = [null, {}, { limit: 'no' }, 'RL_BOOKING', 42, () => ({ success: false })]

    for (const value of notBindings) {
      assert.equal(await limitBurst(value, UID), 'allowed')
    }

    assertOnlyLogged(logs, BINDING_MISSING_LOG, notBindings.length)
  })

  test('a limiter that throws an Error: allowed, code=RL_UNAVAILABLE, the error text is not logged', async (t) => {
    const logs = captureConsole(t)
    const failing = {
      async limit() {
        throw new Error(`limiter down for ${UID}`)
      },
    }

    assert.equal(await limitBurst(failing, UID), 'allowed')
    assertOnlyLogged(logs, UNAVAILABLE_LOG)
  })

  test('a malformed outcome: allowed, code=RL_UNAVAILABLE', async (t) => {
    const logs = captureConsole(t)
    const outcomes = [undefined, null, {}, { success: 'false' }, { success: 0 }]

    for (const outcome of outcomes) {
      assert.equal(await limitBurst({ limit: async () => outcome }, UID), 'allowed')
    }

    assertOnlyLogged(logs, UNAVAILABLE_LOG, outcomes.length)
  })

  test('a rejection that is not an Error is rethrown, not swallowed', async (t) => {
    const logs = captureConsole(t)
    const odd = {
      limit() {
        return Promise.reject('not an Error')
      },
    }

    await assert.rejects(limitBurst(odd, UID), (reason) => reason === 'not an Error')
    assertNothingLogged(logs)
  })

  test('no log line ever carries the key', async (t) => {
    const logs = captureConsole(t)

    await limitBurst(undefined, UID)
    await limitBurst({ limit: async () => ({}) }, UID)
    await limitBurst({ limit: async () => { throw new Error(UID) } }, UID)

    for (const { args } of logs) {
      assert.equal(args.length, 1)
      assert.equal(String(args[0]).includes(UID), false)
      assert.match(String(args[0]), /^RATE_LIMIT_SKIPPED code=RL_[A-Z_]+$/)
    }
  })

  test('an empty or oversized key is a programming error, before the binding', async (t) => {
    const logs = captureConsole(t)
    const binding = new FakeRateLimit(10)

    await assert.rejects(limitBurst(binding, ''), RangeError)
    await assert.rejects(limitBurst(binding, 'k'.repeat(257)), RangeError)
    assert.equal(await limitBurst(binding, 'k'.repeat(256)), 'allowed')
    assert.deepEqual(binding.calls.map((call) => call.key.length), [256])
    assertNothingLogged(logs)
  })
})

describe('isRateLimited (Wave 0 call sites) runs on the RL_* bindings', () => {
  test('booking-create uses RL_BOOKING and profile-write RL_PROFILE, keyed by the uid alone', async (t) => {
    const logs = captureConsole(t)
    const env = { RL_BOOKING: new FakeRateLimit(1), RL_PROFILE: new FakeRateLimit(2) }

    assert.equal(await isRateLimited(env, 'booking-create', UID), false)
    assert.equal(await isRateLimited(env, 'booking-create', UID), true)
    assert.equal(await isRateLimited(env, 'profile-write', UID), false)
    assert.equal(await isRateLimited(env, 'profile-write', UID), false)
    assert.equal(await isRateLimited(env, 'profile-write', UID), true)
    assert.deepEqual(env.RL_BOOKING.calls, [{ key: UID }, { key: UID }])
    assert.deepEqual(env.RL_PROFILE.calls, [{ key: UID }, { key: UID }, { key: UID }])
    assertNothingLogged(logs)
  })

  test('the Wave 0 binding names no longer count; an env without RL_* allows and logs', async (t) => {
    const logs = captureConsole(t)
    const legacy = new FakeRateLimit(0)
    const env = { BOOKING_RATE_LIMITER: legacy, PROFILE_RATE_LIMITER: legacy }

    assert.equal(await isRateLimited(env, 'booking-create', UID), false)
    assert.equal(await isRateLimited(env, 'profile-write', UID), false)
    assert.deepEqual(legacy.calls, [])
    assertOnlyLogged(logs, BINDING_MISSING_LOG, 2)
  })
})

// ---------------------------------------------------------------------------
// connectingIpKey
// ---------------------------------------------------------------------------

describe('connectingIpKey: the connecting IP set by the edge, never a client header', () => {
  test('IPv4 is the address itself', () => {
    assert.equal(connectingIpKey(requestFrom({ 'CF-Connecting-IP': '203.0.113.7' })), 'ip4:203.0.113.7')
    assert.equal(connectingIpKey(requestFrom({ 'CF-Connecting-IP': '0.0.0.0' })), 'ip4:0.0.0.0')
    assert.equal(connectingIpKey(requestFrom({ 'CF-Connecting-IP': '255.255.255.255' })), 'ip4:255.255.255.255')
  })

  test('X-Forwarded-For, X-Real-IP and True-Client-IP are ignored', () => {
    const spoofed = {
      'X-Forwarded-For': '198.51.100.1',
      'X-Real-IP': '198.51.100.2',
      'True-Client-IP': '198.51.100.3',
    }

    assert.equal(connectingIpKey(requestFrom(spoofed)), 'ip:unknown')
    assert.equal(
      connectingIpKey(requestFrom({ ...spoofed, 'CF-Connecting-IP': '203.0.113.7' })),
      'ip4:203.0.113.7',
    )
  })

  test('IPv6 is keyed by its /64, whatever the spelling or the interface id', () => {
    const sameSubnet = [
      '2001:db8:85a3:12::1',
      '2001:0DB8:85A3:0012:ffff:ffff:ffff:ffff',
      '2001:db8:85a3:12:0:0:0:0',
      '2001:db8:85a3:12::',
      '2001:db8:85a3:12:1:2:192.0.2.1',
    ]

    for (const address of sameSubnet) {
      assert.equal(
        connectingIpKey(requestFrom({ 'CF-Connecting-IP': address })),
        'ip6:2001:db8:85a3:12::/64',
        address,
      )
    }

    assert.equal(
      connectingIpKey(requestFrom({ 'CF-Connecting-IP': '2001:db8:85a3:13::1' })),
      'ip6:2001:db8:85a3:13::/64',
    )
    assert.equal(connectingIpKey(requestFrom({ 'CF-Connecting-IP': '::1' })), 'ip6:0:0:0:0::/64')
    assert.equal(connectingIpKey(requestFrom({ 'CF-Connecting-IP': '1:2:3:4:5:6:7::' })), 'ip6:1:2:3:4::/64')
  })

  test('an IPv4-mapped IPv6 address counts as its IPv4 address', () => {
    assert.equal(connectingIpKey(requestFrom({ 'CF-Connecting-IP': '::ffff:203.0.113.7' })), 'ip4:203.0.113.7')
    assert.equal(connectingIpKey(requestFrom({ 'CF-Connecting-IP': '::FFFF:cb00:7107' })), 'ip4:203.0.113.7')
  })

  test('missing or malformed values share one key, so omitting the header earns nothing', () => {
    const malformed = [
      '',
      'unknown',
      '203.0.113',
      '203.0.113.7.1',
      '256.1.1.1',
      '01.2.3.4',
      '203.0.113.7:443',
      '[2001:db8::1]',
      'fe80::1%eth0',
      '1::2::3',
      ':::',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7',
      '::1:2:3:4:5:6:7:8',
      '12345::1',
      '1:2:3:4:5:6:1.2.3.4:8',
      '::ffff:999.0.0.1',
      'g::1',
      `${'1'.repeat(46)}`,
    ]

    assert.equal(connectingIpKey(requestFrom({})), 'ip:unknown')

    for (const value of malformed) {
      assert.equal(connectingIpKey(requestFrom({ 'CF-Connecting-IP': value })), 'ip:unknown', value)
    }
  })
})

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

async function assertErrorEnvelope(response, status, code, message) {
  assert.equal(response.status, status)
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.deepEqual(await response.json(), { ok: false, error: { code, message } })
}

describe('429 RATE_LIMITED and 409 OPEN_REQUEST_LIMIT (plan 11 §3.1)', () => {
  const RATE_LIMITED_MESSAGE = 'طلبات كثيرة خلال وقت قصير. حاولي مرة أخرى بعد قليل.'

  test('a burst: 429 RATE_LIMITED with Retry-After of one binding period', async () => {
    const response = rateLimitedResponse()

    assert.equal(response.headers.get('Retry-After'), String(BURST_PERIOD_SECONDS))
    await assertErrorEnvelope(response, 429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE)
  })

  test('a windowed cap: Retry-After is its window', async () => {
    for (const cap of Object.values(WINDOWED_CAPS)) {
      const response = rateLimitedResponse(cap.windowSeconds)

      assert.equal(response.headers.get('Retry-After'), String(cap.windowSeconds))
      await assertErrorEnvelope(response, 429, 'RATE_LIMITED', RATE_LIMITED_MESSAGE)
    }
  })

  test('Retry-After outside 1 … the longest window, or not whole, is refused', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, LONGEST_LIMIT_WINDOW_SECONDS + 1]) {
      assert.throws(() => rateLimitedResponse(value), RangeError, String(value))
    }

    assert.equal(rateLimitedResponse(1).headers.get('Retry-After'), '1')
    assert.equal(
      rateLimitedResponse(LONGEST_LIMIT_WINDOW_SECONDS).headers.get('Retry-After'),
      String(LONGEST_LIMIT_WINDOW_SECONDS),
    )
  })

  // The helper the plan's code needs; worker/bookings.ts still answers Wave 0's
  // 409 TOO_MANY_OPEN_REQUESTS until W2-16 wires this and the client together.
  test('the open-request cap helper: 409 OPEN_REQUEST_LIMIT, the message spells out the cap', async () => {
    const response = openRequestLimitResponse()

    assert.equal(OPEN_BOOKING_REQUESTS_MAX, 3, 'the 409 message says «ثلاثة»: change both together')
    assert.equal(response.headers.get('Retry-After'), null)
    await assertErrorEnvelope(
      response,
      409,
      'OPEN_REQUEST_LIMIT',
      'لديكِ ثلاثة طلبات مفتوحة. انتظري الرد عليها قبل إرسال طلب جديد.',
    )
  })
})

// ---------------------------------------------------------------------------
// shared/limits.ts: the §3.1 table and wrangler.jsonc
// ---------------------------------------------------------------------------

function wranglerConfig() {
  const path = new URL('../wrangler.jsonc', import.meta.url)
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync(path, 'utf8'))

  assert.equal(error, undefined, 'wrangler.jsonc must parse')

  return config
}

describe('the §3.1 table (shared/limits.ts)', () => {
  test('burst limits and keys are exactly §3.1', () => {
    assert.equal(BURST_PERIOD_SECONDS, 60)
    assert.deepEqual(BURST_LIMITS, {
      RL_BOOKING: { limit: 3, keyedBy: 'uid' },
      RL_PROFILE: { limit: 3, keyedBy: 'uid' },
      RL_CUSTOMER_WRITE: { limit: 10, keyedBy: 'uid' },
      RL_UPLOAD: { limit: 2, keyedBy: 'uid' },
      RL_AVAILABILITY: { limit: 60, keyedBy: 'ip' },
      RL_CSP_REPORT: { limit: 30, keyedBy: 'ip' },
      RL_ADMIN_READ: { limit: 100, keyedBy: 'uid' },
    })
  })

  test('hard caps are exactly §3.1', () => {
    assert.deepEqual(WINDOWED_CAPS, {
      bookingRequestsPerAccount: { max: 5, windowSeconds: 3600 },
      consentChangesPerBooking: { max: 10, windowSeconds: 86_400 },
      receiptsPerBooking: { max: 6, windowSeconds: 3600 },
    })
    assert.equal(OPEN_BOOKING_REQUESTS_MAX, 3)
    assert.equal(RECEIPT_ATTEMPTS_MAX, 10)
    assert.equal(CSP_REPORT_ROWS_PER_DAY_MAX, 200)
    assert.equal(LONGEST_LIMIT_WINDOW_SECONDS, 86_400)
    assert.equal(
      LONGEST_LIMIT_WINDOW_SECONDS,
      Math.max(BURST_PERIOD_SECONDS, ...Object.values(WINDOWED_CAPS).map((cap) => cap.windowSeconds)),
    )
  })

  test('wrangler.jsonc declares the same bindings and limits, 60 s, in every environment', () => {
    const config = wranglerConfig()
    const environments = [['production', config], ...Object.entries(config.env ?? {})]

    assert.ok(environments.length >= 2, 'production and env.preview at least')

    for (const [name, environment] of environments) {
      const declared = Object.fromEntries(
        (environment.ratelimits ?? []).map((binding) => [
          binding.name,
          { limit: binding.simple?.limit, period: binding.simple?.period },
        ]),
      )
      const expected = Object.fromEntries(
        Object.entries(BURST_LIMITS).map(([binding, { limit }]) => [
          binding,
          { limit, period: BURST_PERIOD_SECONDS },
        ]),
      )

      assert.deepEqual(declared, expected, name)
    }
  })
})

describe('windowStart', () => {
  const now = new Date('2026-10-01T09:00:00.000Z')

  test('is the window back from the Worker clock, in the created_at format', () => {
    assert.equal(windowStart(WINDOWED_CAPS.bookingRequestsPerAccount, now), '2026-10-01T08:00:00.000Z')
    assert.equal(windowStart(WINDOWED_CAPS.consentChangesPerBooking, now), '2026-09-30T09:00:00.000Z')
    assert.equal(windowStart({ max: 1, windowSeconds: 1 }, new Date('2026-01-01T00:00:00.000Z')), '2025-12-31T23:59:59.000Z')

    for (const cap of Object.values(WINDOWED_CAPS)) {
      assert.match(windowStart(cap, now), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })

  test('an invalid clock throws instead of binding a bogus bound', () => {
    assert.throws(() => windowStart(WINDOWED_CAPS.receiptsPerBooking, new Date(Number.NaN)), RangeError)
  })
})

// ---------------------------------------------------------------------------
// The caps inside writing statements, on the repository's migrations
// ---------------------------------------------------------------------------

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const T0 = new Date('2026-10-01T09:00:00.000Z')
const SECOND_MS = 1000

function instant(offsetSeconds) {
  return new Date(T0.getTime() + offsetSeconds * SECOND_MS)
}

function iso(offsetSeconds) {
  return instant(offsetSeconds).toISOString()
}

function sqlValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

function run(db, sql, ...params) {
  return Number(db.prepare(sql).run(...params.map(sqlValue)).changes)
}

function scalar(db, sql, ...params) {
  return Object.values(db.prepare(sql).get(...params.map(sqlValue)))[0]
}

function openDatabase() {
  const db = new DatabaseSync(':memory:')

  db.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
  }

  for (const uid of [UID, OTHER_UID]) {
    run(
      db,
      `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
       VALUES (?, ?, 'اسم', 'تجريبي', '+447700900000', 'customer', ?)`,
      uid,
      `${uid.toLowerCase()}@example.test`,
      iso(-100_000),
    )
  }

  return db
}

let sequence = 0

function uuid() {
  sequence += 1

  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
}

function eventDate(dayOffset) {
  return new Date(Date.UTC(2027, 0, 1 + dayOffset)).toISOString().slice(0, 10)
}

function addBooking(db, userId, createdAtOffset, dayOffset, status = 'pending_review') {
  const id = uuid()

  run(
    db,
    `INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', 4000, ?, ?)`,
    id,
    userId,
    eventDate(dayOffset),
    status,
    iso(createdAtOffset),
    iso(createdAtOffset),
  )

  return id
}

// POST /api/bookings (W3-15): the hourly cap inside the INSERT.
const CAPPED_BOOKING_INSERT = `
  INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total, created_at, updated_at)
  SELECT ?1, ?2, ?3, 'pending_review', '{}', 4000, ?4, ?4
  WHERE (
    SELECT COUNT(*) FROM booking_requests WHERE user_id = ?2 AND created_at > ?5
  ) < ?6`

function capBooking(db, userId, dayOffset, nowOffset) {
  const cap = WINDOWED_CAPS.bookingRequestsPerAccount

  return run(
    db,
    CAPPED_BOOKING_INSERT,
    uuid(),
    userId,
    eventDate(dayOffset),
    iso(nowOffset),
    windowStart(cap, instant(nowOffset)),
    cap.max,
  )
}

// PUT consent (W2-06): the daily cap on consent events inside the INSERT.
const CAPPED_CONSENT_EVENT = `
  INSERT INTO booking_events (booking_id, actor, event, created_at)
  SELECT ?1, 'customer', ?2, ?3
  WHERE (
    SELECT COUNT(*) FROM booking_events
    WHERE booking_id = ?1 AND event IN ('consent_granted', 'consent_withdrawn') AND created_at > ?4
  ) < ?5`

function capConsent(db, bookingId, event, nowOffset) {
  const cap = WINDOWED_CAPS.consentChangesPerBooking

  return run(db, CAPPED_CONSENT_EVENT, bookingId, event, iso(nowOffset), windowStart(cap, instant(nowOffset)), cap.max)
}

// Receipt upload #5 (W9-02): the hourly cap and the next attempt number.
const CAPPED_RECEIPT_INSERT = `
  INSERT INTO booking_receipts (id, booking_id, attempt_no, status, created_at, updated_at)
  SELECT ?1, ?2, COALESCE((SELECT MAX(attempt_no) FROM booking_receipts WHERE booking_id = ?2), 0) + 1, 'pending', ?3, ?3
  WHERE (
    SELECT COUNT(*) FROM booking_receipts WHERE booking_id = ?2 AND created_at > ?4
  ) < ?5`

function capReceipt(db, bookingId, nowOffset) {
  const cap = WINDOWED_CAPS.receiptsPerBooking
  const id = uuid()
  const changes = run(db, CAPPED_RECEIPT_INSERT, id, bookingId, iso(nowOffset), windowStart(cap, instant(nowOffset)), cap.max)

  if (changes === 1) {
    // Reviewed at once, so the one-pending index never decides the outcome.
    run(
      db,
      `UPDATE booking_receipts SET status = 'rejected', reviewed_at = ?, rejection_reason = 'اختبار', updated_at = ?
       WHERE id = ?`,
      iso(nowOffset),
      iso(nowOffset),
      id,
    )
  }

  return changes
}

// POST /api/csp-report (W2-17): a new row only below the daily row cap.
const CAPPED_CSP_UPSERT = `
  INSERT INTO csp_report_counts (day, directive, blocked_origin, count)
  SELECT ?1, ?2, ?3, 1
  WHERE EXISTS (
    SELECT 1 FROM csp_report_counts WHERE day = ?1 AND directive = ?2 AND blocked_origin = ?3
  ) OR (SELECT COUNT(*) FROM csp_report_counts WHERE day = ?1) < ?4
  ON CONFLICT (day, directive, blocked_origin) DO UPDATE SET count = min(count + 1, 1000000)`

function capCsp(db, day, origin) {
  return run(db, CAPPED_CSP_UPSERT, day, 'script-src', origin, CSP_REPORT_ROWS_PER_DAY_MAX)
}

describe('windowed caps inside the writing statement (SQL caps unit-tested, 11 §6.3)', () => {
  test('booking requests: the sixth in an hour is refused; older rows and other accounts do not count', () => {
    const db = openDatabase()
    const { max, windowSeconds } = WINDOWED_CAPS.bookingRequestsPerAccount

    // Exactly one window old: outside it. Another account's rows: never counted.
    addBooking(db, UID, -windowSeconds, 0, 'rejected')
    addBooking(db, OTHER_UID, -60, 1)
    addBooking(db, OTHER_UID, -30, 2)

    for (let index = 0; index < max; index += 1) {
      assert.equal(capBooking(db, UID, 10 + index, index * 60), 1, `request ${index + 1}`)
    }

    // The sixth within the hour, whatever the date or the earlier rows' status.
    run(db, "UPDATE booking_requests SET status = 'cancelled' WHERE user_id = ?", UID)
    assert.equal(capBooking(db, UID, 20, max * 60), 0)
    assert.equal(capBooking(db, OTHER_UID, 21, max * 60), 1)

    // Once the first counted row is a full window old, one more fits.
    assert.equal(capBooking(db, UID, 22, windowSeconds - 1), 0)
    assert.equal(capBooking(db, UID, 22, windowSeconds), 1)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM booking_requests WHERE user_id = ?', UID), max + 2)
  })

  test('repeated attempts at one instant insert exactly the cap (the count is inside the INSERT)', () => {
    const db = openDatabase()
    const { max } = WINDOWED_CAPS.bookingRequestsPerAccount
    let inserted = 0

    for (let attempt = 0; attempt < max * 3; attempt += 1) {
      inserted += capBooking(db, UID, 30 + attempt, 0)
    }

    assert.equal(inserted, max)
  })

  test('consent changes: the eleventh in a day is refused; other events and bookings do not count', () => {
    const db = openDatabase()
    const { max, windowSeconds } = WINDOWED_CAPS.consentChangesPerBooking
    const booking = addBooking(db, UID, -200_000, 40, 'confirmed')
    const otherBooking = addBooking(db, UID, -200_000, 41, 'confirmed')

    run(
      db,
      "INSERT INTO booking_events (booking_id, actor, event, created_at) VALUES (?, 'customer', 'receipt_submitted', ?)",
      booking,
      iso(0),
    )

    for (let index = 0; index < max; index += 1) {
      const event = index % 2 === 0 ? 'consent_granted' : 'consent_withdrawn'

      assert.equal(capConsent(db, booking, event, index * 600), 1, `change ${index + 1}`)
    }

    assert.equal(capConsent(db, booking, 'consent_granted', max * 600), 0)
    assert.equal(capConsent(db, otherBooking, 'consent_granted', max * 600), 1)
    assert.equal(capConsent(db, booking, 'consent_granted', windowSeconds - 1), 0)
    assert.equal(capConsent(db, booking, 'consent_granted', windowSeconds), 1)
  })

  test('receipts: the seventh in an hour is refused, and the DB refuses an eleventh attempt', () => {
    const db = openDatabase()
    const { max, windowSeconds } = WINDOWED_CAPS.receiptsPerBooking
    const booking = addBooking(db, UID, -200_000, 50, 'payment_pending')

    for (let index = 0; index < max; index += 1) {
      assert.equal(capReceipt(db, booking, index * 60), 1, `receipt ${index + 1}`)
    }

    assert.equal(capReceipt(db, booking, max * 60), 0)

    // A new hour: attempts 7 … 10 fit the hourly cap; attempt 11 breaks the CHECK.
    for (let attempt = max + 1; attempt <= RECEIPT_ATTEMPTS_MAX; attempt += 1) {
      assert.equal(capReceipt(db, booking, windowSeconds + attempt * 60), 1, `attempt ${attempt}`)
    }

    assert.equal(scalar(db, 'SELECT MAX(attempt_no) FROM booking_receipts WHERE booking_id = ?', booking), RECEIPT_ATTEMPTS_MAX)
    assert.throws(() => capReceipt(db, booking, 3 * windowSeconds), /CHECK constraint failed/)
  })

  test('CSP reports: at most 200 rows a day; an existing row still counts up; the next day starts afresh', () => {
    const db = openDatabase()
    const day = '2026-10-01'

    for (let index = 0; index < CSP_REPORT_ROWS_PER_DAY_MAX; index += 1) {
      assert.equal(capCsp(db, day, `https://h${index}.example`), 1)
    }

    assert.equal(capCsp(db, day, 'https://one-too-many.example'), 0)
    assert.equal(capCsp(db, day, 'https://h0.example'), 1)
    assert.equal(
      scalar(db, "SELECT count FROM csp_report_counts WHERE day = ? AND blocked_origin = 'https://h0.example'", day),
      2,
    )
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM csp_report_counts WHERE day = ?', day), CSP_REPORT_ROWS_PER_DAY_MAX)
    assert.equal(capCsp(db, '2026-10-02', 'https://one-too-many.example'), 1)
  })
})
