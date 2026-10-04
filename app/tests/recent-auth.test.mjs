// W1-02 / C-1, TM-02, TM-07, TM-21, C-14, M1, SB-7, SB-14, SB-18: token
// claims, the admin binding, session freshness, revocation and the re-auth
// guards. Every case below fails if its control is taken out of
// worker/auth.ts, worker/admin-auth.ts, worker/recent-auth.ts,
// worker/users.ts or shared/admin-session.ts:
// - reauthAtFromToken returns auth_time, never iat or now (M1, N-58);
// - the admin guard binds uid + role + proven stored email = token email
//   (N-32), a sign-in at most 12 h old and not before tokens_valid_after
//   (N-44), all read in one D1 query, and answers 403 REAUTH_REQUIRED;
// - a token refreshed after "sign out everywhere" (new iat, old auth_time)
//   is still refused, on admin and customer routes (GAP-06, R-02);
// - the freshness and second-factor guards, and ADMIN_MEDIA_MFA being off
//   only for the exact value "off" (TM-21);
// - RA and CR stay strictly inside the D1 reauth_at CHECK: milliseconds
//   count, and a write landing up to the margin later is still accepted by
//   the database, so a late request is 403 REAUTH_REQUIRED, never a 500.
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

import {
  ADMIN_IDLE_SIGN_OUT_MINUTES,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  RECENT_SIGN_IN_GUARD_SECONDS,
  RECENT_SIGN_IN_MARGIN_SECONDS,
  describeAdminSession,
  unixSecondsToInstant,
} from '../shared/admin-session.ts'
import { ADMIN_SESSION_MAX_HOURS, RECENT_SIGN_IN_SECONDS } from '../shared/timing.ts'
import { authorizeAdminRequest } from '../worker/admin-auth.ts'
import {
  PRIVATE_MEDIA_MAX_AUTH_AGE_SECONDS,
  authenticateFirebaseRequest,
} from '../worker/auth.ts'
import { requireRecentAuthentication } from '../worker/portal/request.ts'
import {
  MEDIA_SIGN_IN_MAX_AGE_SECONDS,
  hasAdminSecondFactor,
  isRecentAuthentication,
  isSessionRevoked,
  reauthAtFromToken,
  requireMediaFreshSignIn,
  requireRecentCustomerSignIn,
  requireRecentSignIn,
  requireSecondFactor,
  requireSettingsSecondFactor,
} from '../worker/recent-auth.ts'
import { checkCustomerAccount, readAccountStanding } from '../worker/users.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROJECT_ID = 'sundus-yar-w1-02-test'
const KEY_ID = 'w1-02-test-key'
const HOUR = 60 * 60
const REAUTH_MESSAGE = 'لحماية الحساب، أعيدي إدخال كلمة المرور لإتمام هذا الإجراء.'
const SECOND_FACTOR_MESSAGE = 'هذا الإجراء يتطلب التحقق بخطوتين لحساب الإدارة.'
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// ---------------------------------------------------------------------------
// Local stand-ins: D1 over node:sqlite, the JWKS endpoint, ExecutionContext
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
    /** Every SQL text prepared, in order, so a test can count the reads. */
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

function migratedDatabase() {
  const database = new DatabaseSync(':memory:')
  const migrationsDirectory = join(APP_ROOT, 'migrations')

  for (const name of readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(migrationsDirectory, name), 'utf8'))
  }

  return database
}

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
}

const originalFetch = globalThis.fetch
let signingKey

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

/**
 * A Firebase ID token signed by the test key. `authTime` (the sign-in) and
 * `issuedAt` (the last refresh) are set independently; `authTime: null`
 * leaves the claim out.
 */
async function mintToken({
  uid,
  email,
  emailVerified = true,
  authTime,
  issuedAt = nowSeconds() - 30,
  secondFactor = null,
}) {
  const firebase = {
    sign_in_provider: 'password',
    identities: { email: [email] },
    ...(secondFactor === null ? {} : { sign_in_second_factor: secondFactor }),
  }
  const claims = {
    email,
    email_verified: emailVerified,
    firebase,
    ...(authTime === null ? {} : { auth_time: authTime }),
  }

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
    .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(PROJECT_ID)
    .setSubject(uid)
    .setIssuedAt(issuedAt)
    .setExpirationTime(nowSeconds() + 3600)
    .sign(signingKey)
}

function bearer(token, path = '/api/admin/bookings') {
  return new Request(`https://sundusyar.test${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function errorOf(response) {
  const body = await response.json()

  return { status: response.status, code: body.error?.code, message: body.error?.message }
}

// ---------------------------------------------------------------------------
// Fixture: one admin, one customer, fresh database per test
// ---------------------------------------------------------------------------

const admin = { uid: 'w102Admin', email: 'studio-admin@example.test' }
const customer = { uid: 'w102Customer', email: 'bride@example.test' }

function insertUser(database, user, { role = 'customer', verified = true, tokensValidAfter = null, erased = false } = {}) {
  database
    .prepare(
      `INSERT INTO users
         (id, email, first_name, last_name, phone, role, email_verified_at, tokens_valid_after, erased_at)
       VALUES (?, ?, 'اختبار', 'اختبار', '0500000000', ?, ?, ?, ?)`,
    )
    .run(
      user.uid,
      user.email,
      role,
      verified ? '2026-09-01T10:00:00.000Z' : null,
      tokensValidAfter,
      erased ? '2026-09-02T10:00:00.000Z' : null,
    )
}

function freshEnv({ adminOptions = {}, customerOptions = {}, vars = {} } = {}) {
  const database = migratedDatabase()

  insertUser(database, admin, { role: 'admin', ...adminOptions })
  insertUser(database, customer, customerOptions)

  return {
    DB: new D1DatabaseStub(database),
    FIREBASE_PROJECT_ID: PROJECT_ID,
    ADMIN_MEDIA_MFA: 'required',
    ADMIN_SETTINGS_2F: 'off',
    ...vars,
  }
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
// Token claims (worker/auth.ts)
// ---------------------------------------------------------------------------

describe('token claims: authTime and secondFactor, fail closed (C-1, SB-1)', () => {
  test('a valid token carries authTime (auth_time, not iat) and the second factor', async () => {
    const env = freshEnv()
    const signedInAt = nowSeconds() - 5 * 60
    const token = await mintToken({
      ...admin,
      authTime: signedInAt,
      issuedAt: nowSeconds() - 20,
      secondFactor: 'totp',
    })
    const identity = await authenticateFirebaseRequest(bearer(token), env)

    assert.equal(identity?.uid, admin.uid)
    assert.equal(identity.authTime, signedInAt)
    assert.equal(identity.secondFactor, 'totp')
    assert.equal(Object.hasOwn(identity, 'iat'), false)
  })

  test('a password-only sign-in has no second factor', async () => {
    const env = freshEnv()
    const token = await mintToken({ ...customer, authTime: nowSeconds() - 60 })
    const identity = await authenticateFirebaseRequest(bearer(token), env)

    assert.equal(identity?.secondFactor, null)
  })

  test('a missing, future, negative or non-numeric auth_time is no sign-in', async () => {
    const env = freshEnv()

    for (const authTime of [null, nowSeconds() + 120, -1, `${nowSeconds() - 60}`]) {
      const token = await mintToken({ ...customer, authTime })

      assert.equal(await authenticateFirebaseRequest(bearer(token), env), null, String(authTime))
    }
  })

  test('an iat in the future is no sign-in', async () => {
    const env = freshEnv()
    const token = await mintToken({
      ...customer,
      authTime: nowSeconds() - 60,
      issuedAt: nowSeconds() + 120,
    })

    assert.equal(await authenticateFirebaseRequest(bearer(token), env), null)
  })

  test('a missing project id refuses every token instead of throwing', async () => {
    const env = freshEnv()
    const token = await mintToken({ ...customer, authTime: nowSeconds() - 60 })

    for (const projectId of [undefined, '', '   ']) {
      assert.equal(
        await authenticateFirebaseRequest(bearer(token), { ...env, FIREBASE_PROJECT_ID: projectId }),
        null,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// reauthAtFromToken (M1, N-58)
// ---------------------------------------------------------------------------

describe('reauthAtFromToken: the only source of reauth_at (M1, N-58)', () => {
  test('returns auth_time, never iat or now, for a refreshed admin token', async () => {
    const env = freshEnv()
    const signedInAt = nowSeconds() - 11 * 60
    const refreshedAt = nowSeconds() - 20
    const token = await mintToken({ ...admin, authTime: signedInAt, issuedAt: refreshedAt })
    const authorization = await authorizeAdminRequest(bearer(token), env)

    assert.equal(authorization.ok, true)

    const reauthAt = reauthAtFromToken(authorization.admin)

    assert.equal(reauthAt, new Date(signedInAt * 1000).toISOString())
    assert.notEqual(reauthAt, new Date(refreshedAt * 1000).toISOString())
    assert.notEqual(reauthAt.slice(0, 16), new Date().toISOString().slice(0, 16))
  })

  test('the stored value is what the D1 reauth window CHECK measures', async () => {
    // The CHECK of migrations 0008/0009, against a SQL-stamped created_at: a
    // sign-in 11 minutes old is refused although the token was refreshed 20
    // seconds ago. Binding iat (or now) instead would pass it (N-58).
    const database = new DatabaseSync(':memory:')
    const withinWindow = database.prepare(
      `SELECT (julianday(strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) - julianday(?)) * 1440
         BETWEEN 0 AND 10 AS ok`,
    )
    const env = freshEnv()
    const stale = await authenticateFirebaseRequest(
      bearer(await mintToken({ ...admin, authTime: nowSeconds() - 11 * 60, issuedAt: nowSeconds() - 20 })),
      env,
    )
    const fresh = await authenticateFirebaseRequest(
      bearer(await mintToken({ ...admin, authTime: nowSeconds() - 5 * 60, issuedAt: nowSeconds() - 20 })),
      env,
    )

    assert.equal(withinWindow.get(reauthAtFromToken(stale)).ok, 0)
    assert.equal(withinWindow.get(reauthAtFromToken(fresh)).ok, 1)
  })

  test('the value has the 24-character form every reauth_at CHECK requires', () => {
    const database = new DatabaseSync(':memory:')
    const matchesCheck = database.prepare(
      `SELECT length(?1) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', ?1) IS ?1 AS ok`,
    )

    for (const authTime of [0, 1_790_000_000, nowSeconds()]) {
      const reauthAt = reauthAtFromToken({ authTime })

      assert.match(reauthAt, ISO_INSTANT)
      assert.equal(matchesCheck.get(reauthAt).ok, 1, reauthAt)
    }
  })

  test('a claim that is not a usable instant throws instead of being stored', () => {
    for (const authTime of [Number.NaN, Number.POSITIVE_INFINITY, -1, 253_402_300_800]) {
      assert.throws(() => reauthAtFromToken({ authTime }), RangeError, String(authTime))
    }
  })
})

// ---------------------------------------------------------------------------
// The admin guard (worker/admin-auth.ts)
// ---------------------------------------------------------------------------

describe('authorizeAdminRequest: uid + stored email + fresh, unrevoked session (C-1, TM-02, TM-07)', () => {
  test('a fresh admin token passes and hands over its claims', async () => {
    const env = freshEnv()
    const signedInAt = nowSeconds() - 60
    const token = await mintToken({ ...admin, authTime: signedInAt })
    const authorization = await authorizeAdminRequest(bearer(token), env)

    assert.deepEqual(authorization, {
      ok: true,
      admin: { uid: admin.uid, authTime: signedInAt, secondFactor: null },
    })
  })

  test('the binding, revocation and email checks are one D1 query', async () => {
    const env = freshEnv()
    const token = await mintToken({ ...admin, authTime: nowSeconds() - 60 })
    const before = env.DB.preparedSql.length

    await authorizeAdminRequest(bearer(token), env)

    const queries = env.DB.preparedSql.slice(before)

    assert.equal(queries.length, 1)
    assert.match(queries[0], /lower\(email\)\s*=\s*lower\(\?\)/)
    assert.match(queries[0], /tokens_valid_after IS NULL OR tokens_valid_after <= \?/)
  })

  test('no token, or a bad one, is unauthenticated (401)', async () => {
    const env = freshEnv()

    for (const request of [
      new Request('https://sundusyar.test/api/admin/bookings'),
      bearer('not-a-jwt'),
    ]) {
      const authorization = await authorizeAdminRequest(request, env)

      assert.equal(authorization.ok, false)
      assert.equal(authorization.failure, 'unauthenticated')
      assert.equal(authorization.response.status, 401)
    }
  })

  test('an unverified token email is 403 EMAIL_NOT_VERIFIED', async () => {
    const env = freshEnv()
    const token = await mintToken({ ...admin, emailVerified: false, authTime: nowSeconds() - 60 })
    const authorization = await authorizeAdminRequest(bearer(token), env)

    assert.equal(authorization.failure, 'email-not-verified')
    assert.deepEqual(
      { status: authorization.response.status, code: (await errorOf(authorization.response)).code },
      { status: 403, code: 'EMAIL_NOT_VERIFIED' },
    )
  })

  test('a customer, an unknown uid or an erased admin is 403 FORBIDDEN', async () => {
    const cases = [
      [freshEnv(), customer],
      [freshEnv(), { uid: 'w102Stranger', email: 'stranger@example.test' }],
      [freshEnv({ adminOptions: { erased: true } }), admin],
    ]

    for (const [env, user] of cases) {
      const token = await mintToken({ ...user, authTime: nowSeconds() - 60 })
      const authorization = await authorizeAdminRequest(bearer(token), env)

      assert.equal(authorization.failure, 'forbidden', user.uid)
      assert.equal((await errorOf(authorization.response)).code, 'FORBIDDEN')
      assert.equal(authorization.response.status, 403)
    }
  })

  test('N-32: the admin uid with another email is 403 FORBIDDEN; case alone does not matter', async () => {
    const env = freshEnv()
    const otherEmail = await mintToken({
      uid: admin.uid,
      email: 'attacker@example.test',
      authTime: nowSeconds() - 60,
    })
    const refused = await authorizeAdminRequest(bearer(otherEmail), env)

    assert.equal(refused.failure, 'forbidden')
    assert.equal(refused.response.status, 403)

    const upperCase = await mintToken({
      uid: admin.uid,
      email: admin.email.toUpperCase(),
      authTime: nowSeconds() - 60,
    })

    assert.equal((await authorizeAdminRequest(bearer(upperCase), env)).ok, true)
  })

  test('an admin row whose stored email was never proven is 403 FORBIDDEN', async () => {
    const env = freshEnv({ adminOptions: { verified: false } })
    const token = await mintToken({ ...admin, authTime: nowSeconds() - 60 })

    assert.equal((await authorizeAdminRequest(bearer(token), env)).failure, 'forbidden')
  })

  test('N-44: a sign-in older than 12 h is 403 REAUTH_REQUIRED, even with a fresh iat', async () => {
    const env = freshEnv()
    const withinWindow = await mintToken({ ...admin, authTime: nowSeconds() - 12 * HOUR + 5 })
    const tooOld = await mintToken({
      ...admin,
      authTime: nowSeconds() - 12 * HOUR - 5,
      issuedAt: nowSeconds() - 10,
    })

    assert.equal((await authorizeAdminRequest(bearer(withinWindow), env)).ok, true)

    const refused = await authorizeAdminRequest(bearer(tooOld), env)

    assert.equal(refused.failure, 'reauth-required')
    assert.deepEqual(await errorOf(refused.response), {
      status: 403,
      code: 'REAUTH_REQUIRED',
      message: REAUTH_MESSAGE,
    })
  })

  test('N-44: a sign-in before tokens_valid_after is 403 REAUTH_REQUIRED', async () => {
    const mark = nowSeconds() - 60
    const env = freshEnv({ adminOptions: { tokensValidAfter: mark } })
    const before = await mintToken({ ...admin, authTime: mark - 1, issuedAt: mark - 1 })
    const refused = await authorizeAdminRequest(bearer(before), env)

    assert.equal(refused.failure, 'reauth-required')
    assert.deepEqual(await errorOf(refused.response), {
      status: 403,
      code: 'REAUTH_REQUIRED',
      message: REAUTH_MESSAGE,
    })
  })

  test('GAP-06 / R-02: a token refreshed after revocation (new iat, old auth_time) is still refused', async () => {
    const mark = nowSeconds() - 60
    const env = freshEnv({ adminOptions: { tokensValidAfter: mark } })
    const refreshed = await mintToken({
      ...admin,
      authTime: mark - 10 * 60,
      issuedAt: mark + 30,
    })
    const refused = await authorizeAdminRequest(bearer(refreshed), env)

    assert.equal(refused.failure, 'reauth-required')
    assert.equal(refused.response.status, 403)

    // A new sign-in at (or after) the mark passes.
    for (const authTime of [mark, mark + 5]) {
      const signedInAgain = await mintToken({ ...admin, authTime, issuedAt: authTime })

      assert.equal((await authorizeAdminRequest(bearer(signedInAgain), env)).ok, true)
    }
  })

  test('R-04: no global MFA switch; Wave 0 ADMIN_REQUIRE_MFA="on" locks nobody out', async () => {
    const env = freshEnv({ vars: { ADMIN_REQUIRE_MFA: 'on', ADMIN_SETTINGS_2F: 'required' } })
    const token = await mintToken({ ...admin, authTime: nowSeconds() - 60 })

    assert.equal((await authorizeAdminRequest(bearer(token), env)).ok, true)
  })
})

// ---------------------------------------------------------------------------
// Customer revocation (worker/users.ts) and the Wave 0 media helper
// ---------------------------------------------------------------------------

describe('customer sessions: revocation stays 401, media reads 12 h (C-14, R-05, R-06)', () => {
  test('GAP-06: a refreshed customer token after revocation is 401; a new sign-in passes', async () => {
    const mark = nowSeconds() - 60
    const env = freshEnv({ customerOptions: { tokensValidAfter: mark } })
    const refreshed = await authenticateFirebaseRequest(
      bearer(await mintToken({ ...customer, authTime: mark - 600, issuedAt: mark + 30 }), '/api/profile'),
      env,
    )

    for (const check of [readAccountStanding, checkCustomerAccount]) {
      const standing = await check(env.DB, refreshed)

      assert.equal(standing.ok, false)
      assert.equal(standing.response.status, 401)
      assert.equal((await errorOf(standing.response)).code, 'UNAUTHORIZED')
    }

    const signedInAgain = await authenticateFirebaseRequest(
      bearer(await mintToken({ ...customer, authTime: mark, issuedAt: mark }), '/api/profile'),
      env,
    )

    assert.equal((await readAccountStanding(env.DB, signedInAgain)).ok, true)
  })

  test('R-06: private-media reads take a 12 h sign-in through requireMediaFreshSignIn and answer 403', async () => {
    assert.equal(requireMediaFreshSignIn({ authTime: nowSeconds() - 11 * HOUR }), null)
    assert.deepEqual(await errorOf(requireMediaFreshSignIn({ authTime: nowSeconds() - 12 * HOUR - 5 })), {
      status: 403,
      code: 'REAUTH_REQUIRED',
      message: REAUTH_MESSAGE,
    })
  })

  test('the deprecated Wave 0 helper is never looser than CO+R (fail-safe, not 12 h)', async () => {
    // worker/portal/request.ts requireRecentAuthentication still reads the
    // Wave 0 constant and documents a 10-minute guard: a route that trusts
    // it must get that, never the 12 h media window.
    assert.equal(PRIVATE_MEDIA_MAX_AUTH_AGE_SECONDS, RECENT_SIGN_IN_GUARD_SECONDS)
    assert.equal(requireRecentAuthentication({ authTime: nowSeconds() - 60 }), null)

    for (const age of [RECENT_SIGN_IN_SECONDS, HOUR, 11 * HOUR]) {
      assert.deepEqual(await errorOf(requireRecentAuthentication({ authTime: nowSeconds() - age })), {
        status: 403,
        code: 'REAUTH_REQUIRED',
        message: REAUTH_MESSAGE,
      }, String(age))
    }
  })
})

// ---------------------------------------------------------------------------
// End to end through the Worker: both admin surfaces and a customer route
// ---------------------------------------------------------------------------

describe('through the Worker (GAP-06 on every admin surface)', () => {
  test('fresh tokens are unchanged; refreshed-after-revocation tokens are refused', async () => {
    const { default: worker } = await import('../worker/index.ts')
    const mark = nowSeconds() - 60
    const env = freshEnv({
      adminOptions: { tokensValidAfter: mark },
      customerOptions: { tokensValidAfter: mark },
    })
    const freshAdmin = await mintToken({ ...admin, authTime: mark + 1, secondFactor: 'totp' })
    const refreshedAdmin = await mintToken({ ...admin, authTime: mark - 600, issuedAt: mark + 30 })
    const freshCustomer = await mintToken({ ...customer, authTime: mark + 1 })
    const refreshedCustomer = await mintToken({ ...customer, authTime: mark - 600, issuedAt: mark + 30 })
    const fetchWith = (token, path) => worker.fetch(bearer(token, path), env, executionContext)

    // Legacy admin surface (worker/admin.ts) and the portal namespace
    // (worker/portal/admin-portal-routes.ts): the guard runs before routing.
    assert.equal((await fetchWith(freshAdmin, '/api/admin/bookings')).status, 200)

    for (const path of ['/api/admin/bookings', '/api/admin/queue', '/api/admin/session']) {
      assert.deepEqual(await errorOf(await fetchWith(refreshedAdmin, path)), {
        status: 403,
        code: 'REAUTH_REQUIRED',
        message: REAUTH_MESSAGE,
      }, path)
    }

    assert.equal((await fetchWith(freshCustomer, '/api/profile')).status, 200)
    assert.deepEqual(
      (({ status, code }) => ({ status, code }))(await errorOf(await fetchWith(refreshedCustomer, '/api/profile'))),
      { status: 401, code: 'UNAUTHORIZED' },
    )
  })
})

// ---------------------------------------------------------------------------
// The route guards (worker/recent-auth.ts)
// ---------------------------------------------------------------------------

describe('recent-auth guards (RA, CR, CM, 2F, 2S; SB-14, TM-21)', () => {
  const now = 1_790_000_000

  test('the windows come from shared/timing.ts', () => {
    assert.equal(ADMIN_SESSION_MAX_AGE_SECONDS, ADMIN_SESSION_MAX_HOURS * HOUR)
    assert.equal(ADMIN_SESSION_MAX_AGE_SECONDS, 12 * HOUR)
    assert.equal(RECENT_SIGN_IN_SECONDS, 600)
    assert.equal(MEDIA_SIGN_IN_MAX_AGE_SECONDS, 12 * HOUR)
    assert.equal(RECENT_SIGN_IN_MARGIN_SECONDS, 30)
    assert.equal(RECENT_SIGN_IN_GUARD_SECONDS, RECENT_SIGN_IN_SECONDS - RECENT_SIGN_IN_MARGIN_SECONDS)
  })

  test('requireRecentSignIn and requireRecentCustomerSignIn: 570 s passes; 570.001 s, 600 s, 600.5 s and 601 s are 403', async () => {
    for (const guard of [requireRecentSignIn, requireRecentCustomerSignIn]) {
      assert.equal(guard({ authTime: now - 570 }, now), null)
      assert.equal(guard({ authTime: now }, now), null)
      assert.equal(guard({ authTime: now }, now + 569.999), null)

      for (const elapsed of [570.001, 600, 600.5, 601]) {
        assert.deepEqual(
          await errorOf(guard({ authTime: now }, now + elapsed)),
          { status: 403, code: 'REAUTH_REQUIRED', message: REAUTH_MESSAGE },
          String(elapsed),
        )
      }
    }
  })

  test('the default clock keeps milliseconds: 570.5 s after the sign-in is 403, 570 s passes', async (t) => {
    let clockMs = (now + 570) * 1000 + 500

    t.mock.method(Date, 'now', () => clockMs)

    for (const guard of [requireRecentSignIn, requireRecentCustomerSignIn]) {
      assert.equal((await errorOf(guard({ authTime: now }))).code, 'REAUTH_REQUIRED')
    }

    clockMs = (now + 570) * 1000

    assert.equal(requireRecentSignIn({ authTime: now }), null)
    assert.equal(requireRecentCustomerSignIn({ authTime: now }), null)

    // The 12 h windows keep milliseconds too.
    clockMs = (now + 12 * HOUR) * 1000 + 1

    assert.notEqual(requireMediaFreshSignIn({ authTime: now }), null)
    assert.equal(isRecentAuthentication({ authTime: now }, ADMIN_SESSION_MAX_AGE_SECONDS), false)
  })

  test('RA and CR are strictly inside the D1 reauth_at CHECK (created_at stamped later, to the millisecond)', () => {
    // A write behind the guard stores reauth_at = auth_time and gets its
    // created_at when the INSERT runs, after the guard. Every age the guard
    // accepts, plus up to the margin of handler time, still passes the
    // CHECK of migrations 0008/0009; the case that used to fail (a request
    // 600.7 s after the sign-in, a row stamped then) is now refused by the
    // guard with 403 instead of reaching the database.
    const database = migratedDatabase()

    insertUser(database, admin, { role: 'admin' })

    const insertAudit = database.prepare(
      `INSERT INTO admin_audit_log (actor_uid, action, reauth_at, created_at)
       VALUES (?, 'settings_bank_updated', ?, ?)`,
    )
    const reauthAt = reauthAtFromToken({ authTime: now })
    const stampedAt = (elapsedSeconds) => new Date(Math.round((now + elapsedSeconds) * 1000)).toISOString()
    // The oldest sign-in each guard really accepts, found by asking the guard
    // itself (to the millisecond), not by trusting the constant.
    const oldestAcceptedAge = (guard) => {
      let accepted = 0
      let refused = 3600

      while (refused - accepted > 0.001) {
        const age = (accepted + refused) / 2

        if (guard({ authTime: now }, now + age) === null) {
          accepted = age
        } else {
          refused = age
        }
      }

      return accepted
    }

    for (const guard of [requireRecentSignIn, requireRecentCustomerSignIn]) {
      const oldest = oldestAcceptedAge(guard)

      assert.ok(oldest > RECENT_SIGN_IN_GUARD_SECONDS - 0.002 && oldest <= RECENT_SIGN_IN_GUARD_SECONDS, `${guard.name} ${oldest}`)

      for (const acceptedAge of [0, 300, oldest]) {
        for (const handlerSeconds of [0, 1.25, RECENT_SIGN_IN_MARGIN_SECONDS - 0.002]) {
          assert.doesNotThrow(
            () => insertAudit.run(admin.uid, reauthAt, stampedAt(acceptedAge + handlerSeconds)),
            `${guard.name}: ${acceptedAge} + ${handlerSeconds}`,
          )
        }
      }
    }

    assert.throws(
      () => insertAudit.run(admin.uid, reauthAt, stampedAt(600.75)),
      /CHECK constraint failed/,
    )
    assert.notEqual(requireRecentSignIn({ authTime: now }, now + 600.7), null)
    assert.notEqual(requireRecentCustomerSignIn({ authTime: now }, now + 600.7), null)
  })

  test('requireMediaFreshSignIn: 12 h passes, 12 h 1 s is 403', async () => {
    assert.equal(requireMediaFreshSignIn({ authTime: now - 12 * HOUR }, now), null)
    assert.equal((await errorOf(requireMediaFreshSignIn({ authTime: now - 12 * HOUR - 1 }, now))).code, 'REAUTH_REQUIRED')
  })

  test('a future or non-finite sign-in is never fresh', () => {
    for (const authTime of [now + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(isRecentAuthentication({ authTime }, 12 * HOUR, now), false, String(authTime))
      assert.notEqual(requireRecentSignIn({ authTime }, now), null, String(authTime))
    }
  })

  test('the default clock is the real one', () => {
    assert.equal(requireRecentSignIn({ authTime: nowSeconds() - 30 }), null)
    assert.notEqual(requireRecentSignIn({ authTime: nowSeconds() - 700 }), null)
  })

  test('isSessionRevoked compares auth_time with the mark and fails closed', () => {
    assert.equal(isSessionRevoked({ authTime: now }, null), false)
    assert.equal(isSessionRevoked({ authTime: now }, now), false)
    assert.equal(isSessionRevoked({ authTime: now - 1 }, now), true)
    assert.equal(isSessionRevoked({ authTime: now }, Number.NaN), true)
    assert.equal(isSessionRevoked({ authTime: Number.NaN }, now), true)
  })

  test('requireSecondFactor: TOTP required unless ADMIN_MEDIA_MFA is exactly "off" (TM-21)', async () => {
    const totp = { secondFactor: 'totp' }
    const none = { secondFactor: null }
    const sms = { secondFactor: 'phone' }

    assert.equal(requireSecondFactor({ ADMIN_MEDIA_MFA: 'required' }, totp), null)
    assert.deepEqual(await errorOf(requireSecondFactor({ ADMIN_MEDIA_MFA: 'required' }, none)), {
      status: 403,
      code: 'SECOND_FACTOR_REQUIRED',
      message: SECOND_FACTOR_MESSAGE,
    })
    assert.notEqual(requireSecondFactor({ ADMIN_MEDIA_MFA: 'required' }, sms), null)
    assert.equal(requireSecondFactor({ ADMIN_MEDIA_MFA: 'off' }, none), null)

    for (const value of ['OFF', 'Off', ' off', 'off ', '', 'false', '0', 'disabled', undefined, null]) {
      assert.notEqual(requireSecondFactor({ ADMIN_MEDIA_MFA: value }, none), null, String(value))
    }

    assert.equal(requireSecondFactor({}, none)?.status, 403)
  })

  test('requireSettingsSecondFactor: TOTP only once ADMIN_SETTINGS_2F is exactly "required"', async () => {
    const none = { secondFactor: null }

    assert.equal((await errorOf(requireSettingsSecondFactor({ ADMIN_SETTINGS_2F: 'required' }, none))).code, 'SECOND_FACTOR_REQUIRED')
    assert.notEqual(requireSettingsSecondFactor({ ADMIN_SETTINGS_2F: 'required' }, { secondFactor: 'phone' }), null)
    assert.equal(requireSettingsSecondFactor({ ADMIN_SETTINGS_2F: 'required' }, { secondFactor: 'totp' }), null)

    for (const value of ['off', 'Required', 'required ', '', undefined]) {
      assert.equal(requireSettingsSecondFactor({ ADMIN_SETTINGS_2F: value }, none), null, String(value))
    }
  })

  test('only TOTP counts as the admin second factor', () => {
    assert.equal(hasAdminSecondFactor({ secondFactor: 'totp' }), true)

    for (const secondFactor of ['phone', 'TOTP', null, '']) {
      assert.equal(hasAdminSecondFactor({ secondFactor }), false, String(secondFactor))
    }
  })

  test('403 answers are JSON and never cached', () => {
    for (const response of [
      requireRecentSignIn({ authTime: now - 601 }, now),
      requireSecondFactor({ ADMIN_MEDIA_MFA: 'required' }, { secondFactor: null }),
    ]) {
      assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/)
      assert.match(response.headers.get('Cache-Control') ?? '', /no-store/)
    }
  })
})

// ---------------------------------------------------------------------------
// shared/admin-session.ts (#40 GET /api/admin/session)
// ---------------------------------------------------------------------------

describe('describeAdminSession (#40)', () => {
  test('reports the windows from auth_time, TOTP or phone as the factor', () => {
    const authTime = 1_790_000_000
    const view = describeAdminSession({ uid: admin.uid, authTime, secondFactor: 'totp' }, authTime + 90)

    assert.deepEqual(view, {
      admin: {
        uid: admin.uid,
        authTime: unixSecondsToInstant(authTime),
        reauthFreshUntil: unixSecondsToInstant(authTime + 570),
        sessionFreshUntil: unixSecondsToInstant(authTime + 12 * HOUR),
        secondFactor: 'totp',
      },
      idleMinutes: ADMIN_IDLE_SIGN_OUT_MINUTES,
      serverTime: unixSecondsToInstant(authTime + 90),
    })
    assert.equal(ADMIN_IDLE_SIGN_OUT_MINUTES, 30)
    assert.equal(describeAdminSession({ uid: 'x', authTime, secondFactor: 'phone' }, authTime).admin.secondFactor, 'phone')
    assert.equal(describeAdminSession({ uid: 'x', authTime, secondFactor: 'email' }, authTime).admin.secondFactor, null)
  })
})

// ---------------------------------------------------------------------------
// SB-7: nothing logs
// ---------------------------------------------------------------------------

describe('SB-7: the guards log nothing', () => {
  test('no console output on any refusal or success', async (t) => {
    const calls = []

    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      t.mock.method(console, method, (...args) => {
        calls.push([method, ...args])
      })
    }

    const mark = nowSeconds() - 60
    const env = freshEnv({ adminOptions: { tokensValidAfter: mark } })

    for (const token of [
      await mintToken({ ...admin, authTime: mark + 1 }),
      await mintToken({ ...admin, authTime: mark - 600, issuedAt: mark + 30 }),
      await mintToken({ uid: admin.uid, email: 'attacker@example.test', authTime: mark + 1 }),
      await mintToken({ ...customer, authTime: mark + 1 }),
      'not-a-jwt',
    ]) {
      await authorizeAdminRequest(bearer(token), env)
    }

    requireSecondFactor({ ADMIN_MEDIA_MFA: 'required' }, { secondFactor: null })
    requireRecentCustomerSignIn({ authTime: 0 })

    assert.deepEqual(calls, [])
  })
})
