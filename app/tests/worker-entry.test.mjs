// W2-17 / C-8, C-10, TM-11, TM-14, TM-17, SB-3, SB-7, SB-15: the Worker entry
// (worker/index.ts) and the CSP report route (worker/csp-report.ts). Every
// case below fails if its control is taken out:
// - PREVIEW_READ_ONLY "on": every /api request that is not a GET of a public
//   read, or the POST of a CSP report, answers 403 PREVIEW_READ_ONLY before
//   any handler runs, and every preview response carries X-Robots-Tag;
// - GET /api/availability: an IP burst (RL_AVAILABILITY) before the cache,
//   a 60 s public edge cache whose key holds the validated range only, a
//   cache hit that never reaches D1, errors never cached, a cache failure
//   that falls back to D1;
// - POST /api/csp-report: both report media types, 8 KiB bound (declared
//   and streamed), burst per IP before the body is read, only (day,
//   directive, blocked origin) counts stored, never a URL path, query or any
//   other report field, at most 200 rows a day, 204, nothing logged.
//
// No network: D1 is node:sqlite with the repository's migrations applied,
// and the Cache API and the ratelimits binding are local stand-ins.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CSP_REPORT_ROWS_PER_DAY_MAX } from '../shared/limits.ts'
import { riyadhTodayKey } from '../shared/timing.ts'
import { handleCspReport } from '../worker/csp-report.ts'
import worker from '../worker/index.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const ORIGIN = 'https://example.test'
const CLIENT_IP = '198.51.100.7'
const REPORTS_TYPE = 'application/reports+json'
const CSP_REPORT_TYPE = 'application/csp-report'
/** A marker planted in every URL part a report route must drop. */
const SECRET = 'bride-0555123456-secret'

// ---------------------------------------------------------------------------
// Local stand-ins: D1 over node:sqlite, ratelimits, Cache API, ExecutionContext
// ---------------------------------------------------------------------------

class D1StatementStub {
  constructor(database, sql, params = []) {
    this.database = database
    this.sql = sql
    this.params = params
  }

  bind(...params) {
    return new D1StatementStub(this.database, this.sql, params)
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

    return { success: true, results: [], meta: { changes: Number(info.changes) } }
  }
}

class D1DatabaseStub {
  constructor(database) {
    this.database = database
    this.preparedSql = []
  }

  prepare(sql) {
    this.preparedSql.push(sql)

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

function migratedDatabase() {
  const database = new DatabaseSync(':memory:')
  const migrationsDirectory = join(APP_ROOT, 'migrations')

  for (const name of readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(migrationsDirectory, name), 'utf8'))
  }

  return database
}

/** A `ratelimits` binding stand-in with a fixed allowance per key. */
class FakeRateLimit {
  constructor(allowance) {
    this.allowance = allowance
    this.keys = []
  }

  async limit({ key }) {
    this.keys.push(key)

    return { success: this.keys.filter((seen) => seen === key).length <= this.allowance }
  }
}

/** The Cache API's caches.default: stores by URL, records every call. */
class FakeCache {
  constructor() {
    this.entries = new Map()
    this.putKeys = []
    this.matchKeys = []
    this.failReads = false
  }

  async match(request) {
    this.matchKeys.push(request.url)

    if (this.failReads) {
      throw new Error('cache unavailable')
    }

    const stored = this.entries.get(request.url)

    return stored ? new Response(stored.body, stored.init) : undefined
  }

  async put(request, response) {
    this.putKeys.push({ url: request.url, headers: [...request.headers.keys()] })
    this.entries.set(request.url, {
      body: await response.text(),
      init: { status: response.status, headers: [...response.headers] },
    })
  }
}

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

function makeEnv(database, overrides = {}) {
  return {
    DB: new D1DatabaseStub(database),
    FIREBASE_PROJECT_ID: 'sundus-yar-w2-17-test',
    RL_AVAILABILITY: new FakeRateLimit(1_000),
    RL_CSP_REPORT: new FakeRateLimit(1_000),
    ...overrides,
  }
}

function captureConsole(t) {
  const calls = []

  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, method, (...args) => {
      calls.push({ method, args })
    })
  }

  return calls
}

async function errorCode(response) {
  const body = await response.json()

  return body.error.code
}

function countRows(database) {
  return database
    .prepare('SELECT day, directive, blocked_origin, count FROM csp_report_counts ORDER BY directive, blocked_origin')
    .all()
    .map((row) => ({ ...row }))
}

function reportRequest(body, { type = REPORTS_TYPE, headers = {}, method = 'POST' } = {}) {
  return new Request(`${ORIGIN}/api/csp-report`, {
    method,
    headers: { 'Content-Type': type, 'CF-Connecting-IP': CLIENT_IP, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** One Reporting API csp-violation entry, with personal data in every URL part. */
function violation(effectiveDirective, blockedURL) {
  return {
    type: 'csp-violation',
    age: 10,
    url: `${ORIGIN}/my-bookings?phone=${SECRET}`,
    user_agent: `Mozilla/5.0 ${SECRET}`,
    body: {
      documentURL: `${ORIGIN}/my-bookings?phone=${SECRET}#${SECRET}`,
      referrer: `${ORIGIN}/?q=${SECRET}`,
      effectiveDirective,
      blockedURL,
      originalPolicy: "default-src 'self'",
      sourceFile: `${ORIGIN}/assets/app.js?${SECRET}`,
      sample: SECRET,
      disposition: 'report',
      statusCode: 200,
      lineNumber: 1,
      columnNumber: 1,
    },
  }
}

function encoderLength(text) {
  return new TextEncoder().encode(text).byteLength
}

let database
let cache
let originalCaches

beforeEach(() => {
  database = migratedDatabase()
  cache = new FakeCache()
  originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  Object.defineProperty(globalThis, 'caches', {
    value: { default: cache },
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  if (originalCaches) {
    Object.defineProperty(globalThis, 'caches', originalCaches)
  } else {
    delete globalThis.caches
  }
})

// ---------------------------------------------------------------------------
// Preview read-only (C-8)
// ---------------------------------------------------------------------------

describe('PREVIEW_READ_ONLY (C-8)', () => {
  function previewEnv(value = 'on') {
    return makeEnv(database, { PREVIEW_READ_ONLY: value })
  }

  test('every write, and every read that is not public, answers 403 before any handler', async () => {
    const env = previewEnv()
    const cases = [
      ['POST', '/api/bookings'],
      ['PUT', '/api/profile'],
      ['PATCH', '/api/admin/bookings/0f8fad5b-d9cb-469f-a165-70867728950e'],
      ['DELETE', '/api/admin/blocked-dates/2026-12-01'],
      ['POST', '/api/admin/settings/bank'],
      ['PUT', '/api/bookings/0f8fad5b-d9cb-469f-a165-70867728950e/event-profile'],
      ['POST', '/api/availability'],
      ['POST', '/api/health'],
      ['POST', '/api/unknown'],
      ['PUT', '/api/csp-report'],
      ['GET', '/api/csp-report'],
      // Stricter than §3.1 on purpose (landed in Wave 0): no account reads.
      ['GET', '/api/bookings/me'],
      ['GET', '/api/profile'],
      ['GET', '/api/admin/bookings'],
    ]

    for (const [method, path] of cases) {
      const response = await worker.fetch(
        new Request(`${ORIGIN}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }),
        env,
        executionContext(),
      )

      assert.equal(response.status, 403, `${method} ${path}`)
      assert.equal(await errorCode(response), 'PREVIEW_READ_ONLY', `${method} ${path}`)
      assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow', `${method} ${path}`)
    }

    // No handler ran: nothing was read from or written to D1.
    assert.deepEqual(env.DB.preparedSql, [])
  })

  test('public reads and the CSP report route still answer, with X-Robots-Tag', async () => {
    const env = previewEnv()

    const health = await worker.fetch(new Request(`${ORIGIN}/api/health`), env, executionContext())

    assert.equal(health.status, 200)
    assert.equal(health.headers.get('X-Robots-Tag'), 'noindex, nofollow')

    const availability = await worker.fetch(
      new Request(`${ORIGIN}/api/availability?from=2026-10-01&to=2026-10-31`),
      env,
      executionContext(),
    )

    assert.equal(availability.status, 200)
    assert.equal(availability.headers.get('X-Robots-Tag'), 'noindex, nofollow')

    const report = await worker.fetch(
      reportRequest([violation('script-src-elem', 'https://evil.example/x.js')]),
      env,
      executionContext(),
    )

    assert.equal(report.status, 204)
    assert.equal(report.headers.get('X-Robots-Tag'), 'noindex, nofollow')
    assert.equal(countRows(database).length, 1)

    const notFound = await worker.fetch(new Request(`${ORIGIN}/not-api`), env, executionContext())

    assert.equal(notFound.headers.get('X-Robots-Tag'), 'noindex, nofollow')
  })

  test('only the exact value "on" makes the Worker read-only; production responses carry no X-Robots-Tag', async () => {
    for (const value of [undefined, 'ON', 'true', ' on', '']) {
      const env = value === undefined ? makeEnv(database) : previewEnv(value)
      const response = await worker.fetch(new Request(`${ORIGIN}/api/bookings`, { method: 'POST' }), env, executionContext())

      assert.notEqual(response.status, 403, String(value))
      assert.equal(response.headers.get('X-Robots-Tag'), null, String(value))
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/availability: edge cache and IP burst (TM-11)
// ---------------------------------------------------------------------------

describe('GET /api/availability (TM-11)', () => {
  function availability(query, env, ctx = executionContext(), headers = { 'CF-Connecting-IP': CLIENT_IP }) {
    return worker.fetch(new Request(`${ORIGIN}/api/availability?${query}`, { headers }), env, ctx)
  }

  test('a 200 is public for 60 s and stored under a key made of the validated range only', async () => {
    database.exec("INSERT INTO blocked_dates (event_date) VALUES ('2026-10-15')")

    const env = makeEnv(database)
    const ctx = executionContext()
    const response = await availability(
      `to=2026-10-31&from=2026-10-01&email=${SECRET}&utm=${SECRET}`,
      env,
      ctx,
      { 'CF-Connecting-IP': CLIENT_IP, Authorization: `Bearer ${SECRET}`, Cookie: `s=${SECRET}` },
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=60')
    assert.deepEqual((await response.json()).dates, [{ date: '2026-10-15', status: 'unavailable' }])

    await Promise.all(ctx.pending)

    assert.deepEqual(cache.putKeys, [
      { url: `${ORIGIN}/api/availability?from=2026-10-01&to=2026-10-31`, headers: [] },
    ])
  })

  test('a cached range is answered without D1, whatever else the query carries', async () => {
    const env = makeEnv(database)
    const first = executionContext()

    await (await availability('from=2026-11-01&to=2026-11-30', env, first)).json()
    await Promise.all(first.pending)

    const readsAfterFirst = env.DB.preparedSql.length

    assert.ok(readsAfterFirst > 0)

    const second = await availability(`from=2026-11-01&to=2026-11-30&x=${SECRET}`, env)

    assert.equal(second.status, 200)
    assert.equal(second.headers.get('Cache-Control'), 'public, max-age=60')
    assert.equal((await second.json()).range.from, '2026-11-01')
    assert.equal(env.DB.preparedSql.length, readsAfterFirst)
    assert.equal(cache.matchKeys.at(-1), `${ORIGIN}/api/availability?from=2026-11-01&to=2026-11-30`)
  })

  test('errors are never cached and stay no-store', async () => {
    const env = makeEnv(database)

    for (const query of ['from=2026-10-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-01-01&to=2026-12-31']) {
      const ctx = executionContext()
      const response = await availability(query, env, ctx)

      assert.equal(response.status, 400, query)
      assert.equal(response.headers.get('Cache-Control'), 'no-store', query)
      assert.deepEqual(ctx.pending, [], query)
    }

    assert.deepEqual(cache.matchKeys, [])
    assert.deepEqual(cache.putKeys, [])
  })

  test('the IP burst answers 429 before the cache and D1, keyed by CF-Connecting-IP', async () => {
    const limiter = new FakeRateLimit(2)
    const env = makeEnv(database, { RL_AVAILABILITY: limiter })

    for (let index = 0; index < 2; index += 1) {
      const ctx = executionContext()

      assert.equal((await availability('from=2026-10-01&to=2026-10-31', env, ctx)).status, 200)
      await Promise.all(ctx.pending)
    }

    const matchesBefore = cache.matchKeys.length
    const readsBefore = env.DB.preparedSql.length
    const limited = await availability('from=2026-10-01&to=2026-10-31', env)

    assert.equal(limited.status, 429)
    assert.equal(await errorCode(limited), 'RATE_LIMITED')
    assert.equal(limited.headers.get('Retry-After'), '60')
    assert.equal(cache.matchKeys.length, matchesBefore)
    assert.equal(env.DB.preparedSql.length, readsBefore)
    assert.deepEqual(new Set(limiter.keys), new Set([`ip4:${CLIENT_IP}`]))

    // Another address has its own allowance.
    const other = await availability('from=2026-10-01&to=2026-10-31', env, executionContext(), {
      'CF-Connecting-IP': '203.0.113.9',
    })

    assert.equal(other.status, 200)
  })

  test('an unreadable cache falls back to D1 and logs a fixed code only', async (t) => {
    const calls = captureConsole(t)
    const env = makeEnv(database)

    cache.failReads = true

    const response = await availability('from=2026-10-01&to=2026-10-31', env)

    assert.equal(response.status, 200)
    assert.ok(env.DB.preparedSql.length > 0)
    assert.deepEqual(calls, [{ method: 'warn', args: ['AVAILABILITY_CACHE_SKIPPED code=CACHE_READ_FAILED'] }])
  })
})

// ---------------------------------------------------------------------------
// POST /api/csp-report (C-10, TM-14, TM-17)
// ---------------------------------------------------------------------------

describe('POST /api/csp-report (C-10, TM-17)', () => {
  test('a Reporting API batch stores counts per directive and blocked origin only, and answers 204', async (t) => {
    const calls = captureConsole(t)
    const env = makeEnv(database)
    const response = await worker.fetch(
      reportRequest([
        violation('script-src-elem', `https://User:pw@CDN.Evil.example:8443/path/${SECRET}.js?q=${SECRET}#${SECRET}`),
        violation('script-src-elem', `https://cdn.evil.example:8443/other?${SECRET}`),
        violation('style-src-attr', 'inline'),
        violation('img-src', `data:image/png;base64,${SECRET}`),
        violation('connect-src', `blob:${ORIGIN}/${SECRET}`),
        violation('script-src', 'eval'),
        violation('made-up-directive', 'https://evil.example/'),
        violation('img-src', `chrome-extension://abcdef/${SECRET}.png`),
        violation('img-src', `ftp://files.example/${SECRET}`),
        violation('img-src', 'http://[2001:db8::1]/x.png'),
        violation('img-src', `not a url ${SECRET}`),
        violation('img-src', ''),
        { type: 'deprecation', body: { id: SECRET } },
        { type: 'csp-violation', body: { blockedURL: 'https://no-directive.example/' } },
        'not a report',
      ]),
      env,
      executionContext(),
    )

    assert.equal(response.status, 204)
    assert.equal(await response.text(), '')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.match(response.headers.get('Strict-Transport-Security') ?? '', /^max-age=\d+/)

    const day = riyadhTodayKey()

    assert.deepEqual(countRows(database), [
      { day, directive: 'connect-src', blocked_origin: 'blob', count: 1 },
      { day, directive: 'img-src', blocked_origin: 'data', count: 1 },
      { day, directive: 'img-src', blocked_origin: 'extension', count: 1 },
      { day, directive: 'img-src', blocked_origin: 'other', count: 3 },
      { day, directive: 'img-src', blocked_origin: 'unknown', count: 1 },
      { day, directive: 'other', blocked_origin: 'https://evil.example', count: 1 },
      { day, directive: 'script-src', blocked_origin: 'eval', count: 1 },
      { day, directive: 'script-src-elem', blocked_origin: 'https://cdn.evil.example:8443', count: 2 },
      { day, directive: 'style-src-attr', blocked_origin: 'inline', count: 1 },
    ])

    // Nothing of any URL path, query, fragment, credential or other field.
    const everything = JSON.stringify(database.prepare('SELECT * FROM csp_report_counts').all())

    assert.ok(!everything.includes(SECRET))
    assert.ok(!everything.toLowerCase().includes('user'))
    assert.ok(!everything.includes('/path'))
    assert.deepEqual(calls, [])
  })

  test('a legacy application/csp-report body is counted the same way', async () => {
    const env = makeEnv(database)
    const response = await handleCspReport(
      reportRequest(
        {
          'csp-report': {
            'document-uri': `${ORIGIN}/admin?q=${SECRET}`,
            referrer: '',
            'violated-directive': "frame-src https://sundus-yar-website.firebaseapp.com",
            'original-policy': "default-src 'self'",
            'blocked-uri': `https://frames.example/${SECRET}`,
            'script-sample': SECRET,
          },
        },
        { type: `${CSP_REPORT_TYPE}; charset=utf-8` },
      ),
      env,
    )

    assert.equal(response.status, 204)
    assert.deepEqual(countRows(database), [
      { day: riyadhTodayKey(), directive: 'frame-src', blocked_origin: 'https://frames.example', count: 1 },
    ])

    const second = await handleCspReport(
      reportRequest(
        { 'csp-report': { 'effective-directive': 'frame-src', 'blocked-uri': 'https://frames.example/other' } },
        { type: CSP_REPORT_TYPE },
      ),
      env,
    )

    assert.equal(second.status, 204)
    assert.equal(countRows(database)[0].count, 2)
  })

  test('at most 200 rows a day: a new origin is dropped, an existing one still counts up', async () => {
    const env = makeEnv(database)
    const day = riyadhTodayKey()
    const insert = database.prepare(
      "INSERT INTO csp_report_counts (day, directive, blocked_origin, count) VALUES (?, 'img-src', ?, 1)",
    )

    for (let index = 0; index < CSP_REPORT_ROWS_PER_DAY_MAX - 1; index += 1) {
      insert.run(day, `https://h${index}.example`)
    }

    // One batch that would add two new rows: only the first fits.
    const response = await handleCspReport(
      reportRequest([
        violation('img-src', 'https://last-fit.example/a.png'),
        violation('img-src', 'https://one-too-many.example/a.png'),
        violation('img-src', 'https://h0.example/a.png'),
      ]),
      env,
    )

    assert.equal(response.status, 204)

    const count = (sql, ...params) => Number(database.prepare(sql).get(...params).n)

    assert.equal(count('SELECT COUNT(*) AS n FROM csp_report_counts WHERE day = ?', day), CSP_REPORT_ROWS_PER_DAY_MAX)
    assert.equal(count("SELECT COUNT(*) AS n FROM csp_report_counts WHERE blocked_origin = 'https://one-too-many.example'"), 0)
    assert.equal(count("SELECT count AS n FROM csp_report_counts WHERE blocked_origin = 'https://h0.example'"), 2)
    assert.equal(count("SELECT count AS n FROM csp_report_counts WHERE blocked_origin = 'https://last-fit.example'"), 1)
  })

  test('only the two report media types are accepted', async () => {
    const env = makeEnv(database)

    for (const type of ['application/json', 'text/plain', 'application/reports+json-x', '']) {
      const response = await handleCspReport(reportRequest([violation('img-src', 'data:')], { type }), env)

      assert.equal(response.status, 415, type)
      assert.equal(await errorCode(response), 'UNSUPPORTED_MEDIA_TYPE', type)
    }

    assert.deepEqual(countRows(database), [])
  })

  test('bodies over 8 KiB are refused, declared or streamed, and malformed ones are 400', async () => {
    const env = makeEnv(database)
    const oversized = JSON.stringify([violation('img-src', `https://big.example/${'a'.repeat(9_000)}`)])

    const declared = await handleCspReport(
      reportRequest(oversized, { headers: { 'Content-Length': String(encoderLength(oversized)) } }),
      env,
    )

    assert.equal(declared.status, 413)

    const encoder = new TextEncoder()
    const streamed = new Request(`${ORIGIN}/api/csp-report`, {
      method: 'POST',
      headers: { 'Content-Type': REPORTS_TYPE },
      duplex: 'half',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(oversized.slice(0, 5_000)))
          controller.enqueue(encoder.encode(oversized.slice(5_000)))
          controller.close()
        },
      }),
    })

    assert.equal(streamed.headers.get('Content-Length'), null)
    assert.equal((await handleCspReport(streamed, env)).status, 413)

    const lying = await handleCspReport(reportRequest(oversized, { headers: { 'Content-Length': 'abc' } }), env)

    assert.equal(lying.status, 400)

    for (const body of ['not json', '{"csp-report": 1}', '{}', '"text"', 'null']) {
      const response = await handleCspReport(reportRequest(body), env)

      assert.equal(response.status, 400, body)
      assert.equal(await errorCode(response), 'INVALID_REQUEST_BODY', body)
    }

    const invalidUtf8 = new Request(`${ORIGIN}/api/csp-report`, {
      method: 'POST',
      headers: { 'Content-Type': REPORTS_TYPE },
      body: new Uint8Array([0x5b, 0xff, 0x5d]),
    })

    assert.equal((await handleCspReport(invalidUtf8, env)).status, 400)
    assert.deepEqual(countRows(database), [])
  })

  test('only POST; a batch with no CSP violation writes nothing', async () => {
    const env = makeEnv(database)
    const get = await handleCspReport(new Request(`${ORIGIN}/api/csp-report`), env)

    assert.equal(get.status, 405)
    assert.equal(get.headers.get('Allow'), 'POST')

    const empty = await handleCspReport(reportRequest([{ type: 'intervention', body: {} }]), env)

    assert.equal(empty.status, 204)
    assert.deepEqual(env.DB.preparedSql, [])
  })

  test('at most 20 reports of one body are read', async () => {
    const env = makeEnv(database)
    const batch = Array.from({ length: 40 }, () => ({
      type: 'csp-violation',
      body: { effectiveDirective: 'img-src', blockedURL: 'https://many.example/a.png' },
    }))
    const response = await handleCspReport(reportRequest(batch), env)

    assert.equal(response.status, 204)
    assert.equal(countRows(database)[0].count, 20)
  })

  test('the per-IP burst answers 429 before the body is read', async () => {
    const limiter = new FakeRateLimit(1)
    const env = makeEnv(database, { RL_CSP_REPORT: limiter })

    assert.equal((await handleCspReport(reportRequest([violation('img-src', 'data:')]), env)).status, 204)

    const request = reportRequest([violation('img-src', 'https://second.example/')])
    const limited = await handleCspReport(request, env)

    assert.equal(limited.status, 429)
    assert.equal(await errorCode(limited), 'RATE_LIMITED')
    assert.equal(request.bodyUsed, false)
    assert.deepEqual(limiter.keys, [`ip4:${CLIENT_IP}`, `ip4:${CLIENT_IP}`])
    assert.equal(countRows(database).length, 1)
  })

  test('the route is public: no Authorization header is needed or read', async () => {
    const env = makeEnv(database)
    const response = await worker.fetch(
      reportRequest([violation('font-src', 'https://fonts.example/f.woff2')]),
      env,
      executionContext(),
    )

    assert.equal(response.status, 204)
  })
})
