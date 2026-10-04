// W2-15 / C-2, C-4, TM-08, TM-12, SEC-04, SEC-14: PUT /api/profile.
// Every case below fails if its control is taken out of worker/profile.ts:
// - users.email only from a verified token (email_verified_at stamped); an
//   unverified booking-less squatter is reclaimed by the verified owner, one
//   with a booking is not; unverified registration still saves the row
//   (C-2, SEC-04);
// - an erased row answers 410 and is never written (SEC-14);
// - a new phone, or a new address, on an existing row needs a sign-in at
//   most RECENT_SIGN_IN_GUARD_SECONDS old (403 REAUTH_REQUIRED) and stamps
//   contact_changed_at; creating the row and name-only saves do neither
//   (TM-08, C-4), and the upsert re-checks the row it updates (a phone
//   changed by another tab after the read is still guarded);
// - names through shared/text.ts normalizePersonName: URLs and bidi marks
//   refused (TM-12, SB-16);
// - the RL_PROFILE burst keyed by the uid (SB-15);
// - no email or phone in any log line.
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

import { RECENT_SIGN_IN_GUARD_SECONDS } from '../shared/admin-session.ts'
import { handleProfile } from '../worker/profile.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROJECT_ID = 'sundus-yar-w2-15-test'
const KEY_ID = 'w2-15-test-key'
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const STORED_PHONE = '+966500000001'
const NEW_PHONE_INPUT = '0551234567'
const NEW_PHONE = '+966551234567'

// ---------------------------------------------------------------------------
// Local stand-ins: D1 over node:sqlite, the JWKS endpoint, RL_PROFILE
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

  async first() {
    const row = this.database.prepare(this.sql).get(...this.params)

    return row === undefined ? null : { ...row }
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
    /** Runs once, right before the next batch (another tab's write). */
    this.beforeNextBatch = null
  }

  prepare(sql) {
    return new D1StatementStub(this.database, sql)
  }

  async batch(statements) {
    const hook = this.beforeNextBatch

    this.beforeNextBatch = null
    hook?.()
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

  for (const name of readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(migrationsDirectory, name), 'utf8'))
  }

  return database
}

const originalFetch = globalThis.fetch
let signingKey

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

/** A sign-in well inside the CO+R window, and one well outside it. */
const RECENT = () => nowSeconds() - 60
const STALE = () => nowSeconds() - 2 * 60 * 60

async function mintToken({ uid, email, emailVerified = true, authTime }) {
  return new SignJWT({
    email,
    email_verified: emailVerified,
    firebase: { sign_in_provider: 'password', identities: { email: [email] } },
    auth_time: authTime,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
    .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(PROJECT_ID)
    .setSubject(uid)
    .setIssuedAt(nowSeconds() - 30)
    .setExpirationTime(nowSeconds() + 3600)
    .sign(signingKey)
}

async function putProfile(env, identity, profile) {
  const token = await mintToken(identity)

  return handleProfile(
    new Request('https://sundusyar.test/api/profile', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(profile),
    }),
    env,
  )
}

async function errorCodeOf(response) {
  return { status: response.status, code: (await response.json()).error?.code }
}

// ---------------------------------------------------------------------------
// Fixture: one customer and one admin with a stored profile
// ---------------------------------------------------------------------------

const customer = { uid: 'w215Customer', email: 'bride@example.test' }
const admin = { uid: 'w215Admin', email: 'studio-admin@example.test' }
const profile = { firstName: 'ريم', lastName: 'العتيبي', phone: STORED_PHONE }

function insertUser(database, user, { role = 'customer', verified = true, erased = false } = {}) {
  database
    .prepare(
      `INSERT INTO users
         (id, email, first_name, last_name, phone, role, email_verified_at, erased_at)
       VALUES (?, ?, 'ريم', 'العتيبي', ?, ?, ?, ?)`,
    )
    .run(
      user.uid,
      user.email,
      STORED_PHONE,
      role,
      verified ? '2026-09-01T10:00:00.000Z' : null,
      erased ? '2026-09-02T10:00:00.000Z' : null,
    )
}

function insertBooking(database, userId) {
  database
    .prepare(
      `INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total)
       VALUES (?, ?, '2026-11-20', 'pending_review', '{}', 4000)`,
    )
    .run(`booking-${userId}`, userId)
}

function freshEnv({ customerOptions = {}, profileAllowance = 100 } = {}) {
  const database = migratedDatabase()

  insertUser(database, customer, customerOptions)
  insertUser(database, admin, { role: 'admin' })

  return {
    database,
    env: {
      DB: new D1DatabaseStub(database),
      FIREBASE_PROJECT_ID: PROJECT_ID,
      RL_PROFILE: new FakeRateLimit(profileAllowance),
    },
  }
}

function rowOf(database, uid) {
  const row = database
    .prepare(
      `SELECT email, email_verified_at AS emailVerifiedAt, first_name AS firstName,
              last_name AS lastName, phone, contact_changed_at AS contactChangedAt
       FROM users WHERE id = ?`,
    )
    .get(uid)

  return row === undefined ? null : { ...row }
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
// Contact changes: CO+R and contact_changed_at (TM-08, C-4, SB-18)
// ---------------------------------------------------------------------------

describe('PUT /api/profile: contact changes need a recent sign-in (TM-08, C-4)', () => {
  test('the stale window is outside the guard and the recent one inside it', () => {
    assert.ok(nowSeconds() - STALE() > RECENT_SIGN_IN_GUARD_SECONDS)
    assert.ok(nowSeconds() - RECENT() < RECENT_SIGN_IN_GUARD_SECONDS)
  })

  test('a name-only save with an old sign-in is accepted and stamps nothing', async () => {
    const { database, env } = freshEnv()
    const response = await putProfile(
      env,
      { ...customer, authTime: STALE() },
      { ...profile, lastName: 'الحربي' },
    )

    assert.equal(response.status, 200)
    assert.equal((await response.json()).profile.lastName, 'الحربي')
    assert.equal(rowOf(database, customer.uid).contactChangedAt, null)
  })

  test('a new phone with an old sign-in is 403 REAUTH_REQUIRED and changes nothing', async () => {
    const { database, env } = freshEnv()
    const before = rowOf(database, customer.uid)
    const response = await putProfile(
      env,
      { ...customer, authTime: STALE() },
      { ...profile, firstName: 'سارة', phone: NEW_PHONE_INPUT },
    )

    assert.deepEqual(await errorCodeOf(response), { status: 403, code: 'REAUTH_REQUIRED' })
    assert.deepEqual(rowOf(database, customer.uid), before)
  })

  test('the same number in another spelling is not a change', async () => {
    const { database, env } = freshEnv()
    const response = await putProfile(
      env,
      { ...customer, authTime: STALE() },
      { ...profile, phone: '050 000 0001' },
    )

    assert.equal(response.status, 200)
    assert.equal(rowOf(database, customer.uid).contactChangedAt, null)
  })

  test('a new phone with a recent sign-in is saved and stamps contact_changed_at', async () => {
    const { database, env } = freshEnv()
    const startedAt = Date.now()
    const response = await putProfile(
      env,
      { ...customer, authTime: RECENT() },
      { ...profile, phone: NEW_PHONE_INPUT },
    )

    assert.equal(response.status, 200)
    assert.equal((await response.json()).profile.phone, NEW_PHONE)

    const row = rowOf(database, customer.uid)

    assert.equal(row.phone, NEW_PHONE)
    assert.match(row.contactChangedAt, ISO_INSTANT)
    assert.ok(Date.parse(row.contactChangedAt) >= startedAt - 1000)
  })

  test('a phone typed in Arabic-Indic or Persian digits is the same number (UX-07)', async () => {
    const { database, env } = freshEnv()

    for (const typed of ['٠٥٥١٢٣٤٥٦٧', '۰۵۵۱۲۳۴۵۶۷']) {
      const response = await putProfile(env, { ...customer, authTime: RECENT() }, { ...profile, phone: typed })

      assert.equal(response.status, 200, typed)
      assert.equal(rowOf(database, customer.uid).phone, NEW_PHONE)
    }
  })

  test('a later name-only save keeps the earlier contact stamp', async () => {
    const { database, env } = freshEnv()

    await putProfile(env, { ...customer, authTime: RECENT() }, { ...profile, phone: NEW_PHONE_INPUT })

    const stamp = rowOf(database, customer.uid).contactChangedAt
    const response = await putProfile(
      env,
      { ...customer, authTime: STALE() },
      { ...profile, phone: NEW_PHONE, firstName: 'سارة' },
    )

    assert.equal(response.status, 200)
    assert.equal(rowOf(database, customer.uid).contactChangedAt, stamp)
  })

  test('a verified new address with an old sign-in is 403 and the row keeps its address', async () => {
    const { database, env } = freshEnv()
    const before = rowOf(database, customer.uid)
    const response = await putProfile(
      env,
      { uid: customer.uid, email: 'bride.new@example.test', authTime: STALE() },
      profile,
    )

    assert.deepEqual(await errorCodeOf(response), { status: 403, code: 'REAUTH_REQUIRED' })
    assert.deepEqual(rowOf(database, customer.uid), before)
  })

  test('a verified new address with a recent sign-in is taken, proven and stamped', async () => {
    const { database, env } = freshEnv()
    const response = await putProfile(
      env,
      { uid: customer.uid, email: 'bride.new@example.test', authTime: RECENT() },
      profile,
    )

    assert.equal(response.status, 200)

    const row = rowOf(database, customer.uid)

    assert.equal(row.email, 'bride.new@example.test')
    assert.notEqual(row.emailVerifiedAt, '2026-09-01T10:00:00.000Z')
    assert.match(row.emailVerifiedAt, ISO_INSTANT)
    assert.equal(row.contactChangedAt, row.emailVerifiedAt)
  })

  test('a case-only change of the address is not a contact change', async () => {
    const { database, env } = freshEnv()
    const response = await putProfile(
      env,
      { uid: customer.uid, email: 'Bride@Example.test', authTime: STALE() },
      profile,
    )

    assert.equal(response.status, 200)
    assert.equal(rowOf(database, customer.uid).contactChangedAt, null)
  })

  test('an unverified token never moves the address, so it is not a contact change', async () => {
    const { database, env } = freshEnv()
    const response = await putProfile(
      env,
      { uid: customer.uid, email: 'someone-else@example.test', emailVerified: false, authTime: STALE() },
      { ...profile, firstName: 'سارة' },
    )

    assert.equal(response.status, 200)

    const row = rowOf(database, customer.uid)

    assert.equal(row.email, customer.email)
    assert.equal(row.contactChangedAt, null)
  })

  test('an admin row: the address never follows the token, a new phone still needs CO+R', async () => {
    const { database, env } = freshEnv()
    const other = { uid: admin.uid, email: 'owner.new@example.test', authTime: STALE() }

    assert.equal((await putProfile(env, other, profile)).status, 200)
    assert.equal(rowOf(database, admin.uid).email, admin.email)
    assert.equal(rowOf(database, admin.uid).contactChangedAt, null)
    assert.deepEqual(
      await errorCodeOf(await putProfile(env, { ...admin, authTime: STALE() }, { ...profile, phone: NEW_PHONE_INPUT })),
      { status: 403, code: 'REAUTH_REQUIRED' },
    )
  })

  test('the write re-checks the row: a phone changed by another tab after the read is still guarded', async () => {
    const { database, env } = freshEnv()

    // Another tab (with a recent sign-in) saves a new phone between this
    // request's read and its write; this request still sends the old one.
    env.DB.beforeNextBatch = () => {
      database
        .prepare("UPDATE users SET phone = ?, contact_changed_at = '2026-09-29T08:00:00.000Z' WHERE id = ?")
        .run(NEW_PHONE, customer.uid)
    }

    const response = await putProfile(env, { ...customer, authTime: STALE() }, { ...profile, firstName: 'سارة' })

    assert.deepEqual(await errorCodeOf(response), { status: 403, code: 'REAUTH_REQUIRED' })

    const row = rowOf(database, customer.uid)

    assert.equal(row.phone, NEW_PHONE)
    assert.equal(row.firstName, 'ريم')
    assert.equal(row.contactChangedAt, '2026-09-29T08:00:00.000Z')
  })

  test('creating the row needs no recent sign-in and leaves the stamp empty', async () => {
    const { database, env } = freshEnv()
    const newcomer = { uid: 'w215Newcomer', email: 'new-bride@example.test', authTime: STALE() }
    const response = await putProfile(env, newcomer, { ...profile, phone: NEW_PHONE_INPUT })

    assert.equal(response.status, 200)
    assert.equal(rowOf(database, newcomer.uid).contactChangedAt, null)
  })
})

// ---------------------------------------------------------------------------
// Verified-email ownership (C-2, SEC-04)
// ---------------------------------------------------------------------------

describe('PUT /api/profile: users.email only from a verified token (C-2, SEC-04)', () => {
  test('an unverified registration still saves the row, without a proof stamp', async () => {
    const { database, env } = freshEnv()
    const newcomer = { uid: 'w215Newcomer', email: 'new-bride@example.test', emailVerified: false, authTime: RECENT() }
    const response = await putProfile(env, newcomer, profile)

    assert.equal(response.status, 200)

    const row = rowOf(database, newcomer.uid)

    assert.equal(row.email, newcomer.email)
    assert.equal(row.emailVerifiedAt, null)
  })

  test('the verified owner later proves the same address and gets the stamp', async () => {
    const { database, env } = freshEnv()
    const newcomer = { uid: 'w215Newcomer', email: 'new-bride@example.test', authTime: STALE() }

    await putProfile(env, { ...newcomer, emailVerified: false }, profile)

    const response = await putProfile(env, newcomer, profile)

    assert.equal(response.status, 200)

    const row = rowOf(database, newcomer.uid)

    assert.match(row.emailVerifiedAt, ISO_INSTANT)
    assert.equal(row.contactChangedAt, null)
  })

  test('an unverified squatter without bookings is reclaimed by the verified owner (SEC-04 reproduction)', async () => {
    const { database, env } = freshEnv()
    const victim = { uid: 'w215Victim', email: 'victim@example.test', authTime: RECENT() }

    // The attacker registers the victim's address first, unverified.
    assert.equal(
      (await putProfile(env, { uid: 'w215Squatter', email: victim.email, emailVerified: false, authTime: RECENT() }, profile)).status,
      200,
    )

    const response = await putProfile(env, victim, profile)

    assert.equal(response.status, 200)
    assert.equal(rowOf(database, 'w215Squatter'), null)
    assert.equal(rowOf(database, victim.uid).email, victim.email)
    assert.match(rowOf(database, victim.uid).emailVerifiedAt, ISO_INSTANT)
  })

  test('a holder with a booking is not reclaimed: 409 EMAIL_ALREADY_IN_USE', async () => {
    const { database, env } = freshEnv()

    insertUser(database, { uid: 'w215Holder', email: 'holder@example.test' }, { verified: false })
    insertBooking(database, 'w215Holder')

    const response = await putProfile(env, { uid: 'w215Claimant', email: 'holder@example.test', authTime: RECENT() }, profile)

    assert.deepEqual(await errorCodeOf(response), { status: 409, code: 'EMAIL_ALREADY_IN_USE' })
    assert.notEqual(rowOf(database, 'w215Holder'), null)
    assert.equal(rowOf(database, 'w215Claimant'), null)
  })

  test('an unverified token cannot take an address a verified row holds', async () => {
    const { database, env } = freshEnv()
    const response = await putProfile(
      env,
      { uid: 'w215Impostor', email: customer.email, emailVerified: false, authTime: RECENT() },
      profile,
    )

    assert.deepEqual(await errorCodeOf(response), { status: 409, code: 'EMAIL_ALREADY_IN_USE' })
    assert.equal(rowOf(database, 'w215Impostor'), null)
  })
})

// ---------------------------------------------------------------------------
// Erasure, names, limiter, logs
// ---------------------------------------------------------------------------

describe('PUT /api/profile: erasure, names, burst limit and logs', () => {
  test('an erased row answers 410 ACCOUNT_ERASED and is never written (SEC-14)', async () => {
    const { database, env } = freshEnv({ customerOptions: { erased: true } })
    const before = rowOf(database, customer.uid)
    const response = await putProfile(
      env,
      { ...customer, authTime: RECENT() },
      { ...profile, phone: NEW_PHONE_INPUT },
    )

    assert.deepEqual(await errorCodeOf(response), { status: 410, code: 'ACCOUNT_ERASED' })
    assert.deepEqual(rowOf(database, customer.uid), before)
    assert.equal(env.RL_PROFILE.calls.length, 0)
  })

  test('names with a URL, a domain or a bidi mark are refused (TM-12, SB-16)', async () => {
    const { database, env } = freshEnv()
    const before = rowOf(database, customer.uid)

    for (const name of ['https://evil.example', 'ريم.example.com', 'www.example.com', 'ريم‮مير', 'ريم‏العتيبي']) {
      const response = await putProfile(env, { ...customer, authTime: RECENT() }, { ...profile, firstName: name })

      assert.deepEqual(await errorCodeOf(response), { status: 400, code: 'INVALID_PROFILE' }, name)
    }

    assert.deepEqual(rowOf(database, customer.uid), before)
  })

  test('the RL_PROFILE burst is keyed by the uid and answers 429 before any write (SB-15)', async () => {
    const { database, env } = freshEnv({ profileAllowance: 1 })

    assert.equal((await putProfile(env, { ...customer, authTime: RECENT() }, profile)).status, 200)

    const before = rowOf(database, customer.uid)
    const response = await putProfile(
      env,
      { ...customer, authTime: RECENT() },
      { ...profile, phone: NEW_PHONE_INPUT },
    )

    assert.deepEqual(await errorCodeOf(response), { status: 429, code: 'RATE_LIMITED' })
    assert.deepEqual(env.RL_PROFILE.calls, [{ key: customer.uid }, { key: customer.uid }])
    assert.deepEqual(rowOf(database, customer.uid), before)
  })

  test('no email address or phone number reaches a log line', async (t) => {
    const lines = []

    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      t.mock.method(console, method, (...args) => {
        lines.push(args.map(String).join(' '))
      })
    }

    const { env } = freshEnv()

    // Every outcome of the handler: refused, saved, conflict, and a missing
    // limiter binding (the one path that logs).
    await putProfile(env, { ...customer, authTime: STALE() }, { ...profile, phone: NEW_PHONE_INPUT })
    await putProfile(env, { ...customer, authTime: RECENT() }, { ...profile, phone: NEW_PHONE_INPUT })
    await putProfile(env, { uid: 'w215Impostor', email: admin.email, emailVerified: false, authTime: RECENT() }, profile)
    await putProfile({ ...env, RL_PROFILE: undefined }, { ...customer, authTime: RECENT() }, profile)

    const text = lines.join('\n')

    for (const secret of [customer.email, admin.email, NEW_PHONE, STORED_PHONE, '0551234567', '551234567']) {
      assert.ok(!text.includes(secret), `a log line contains ${secret}`)
    }
  })
})
