// W2-13 / TM-03, TM-16, TM-18, B1, UX-08, GAP-05, SB-2, SB-3, SB-5, SB-13,
// SB-15: the customer confirmation routes (plan 11 §3.3 #2–#4), driven
// through the real customer dispatcher (portal-routes.ts) and slot, so the
// token check, the central ownership query and the handlers all run.
//
// No network: the Firebase JWKS is served by a fetch stub from a key made
// here, and D1 is node:sqlite with the repository's migrations applied (a
// batch runs as one transaction, as D1's does). Each scenario gets its own
// database. Times are relative to the real clock, since the handlers read
// it themselves.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SignJWT, exportJWK, generateKeyPair } from 'jose'

import {
  customerPortalRoutes,
  dispatchCustomerPortalRequest,
} from '../worker/portal/portal-routes.ts'
import { CONFIRMATION_SQL } from '../worker/portal/confirmation.ts'
import {
  groupIbanForDisplay,
  parseTermsVersion,
  resolveVerificationContact,
} from '../shared/portal/confirmation.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROJECT_ID = 'sundus-yar-w2-13-test'
const KEY_ID = 'w2-13-test-key'
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

const IBAN_A = 'SA0910000000000000000001'
const IBAN_B = 'SA0745000000ABCDEF123456'
const STUDIO = '966505647418'
const NEW_STUDIO = '966551234567'
const TERMS_V1 =
  'شروط الحجز: يُثبَّت موعد التصوير بعد استلام العربون، وتُرسل الصور خلال المدة المتفق عليها بين الطرفين.'
const TERMS_V2 =
  'شروط الحجز المحدّثة: يُثبَّت موعد التصوير بعد استلام العربون، ويُعاد جدولة الموعد بالاتفاق المسبق بين الطرفين.'

const customerA = { uid: 'w213CustomerA', email: 'bride-a@example.test' }
const customerB = { uid: 'w213CustomerB', email: 'bride-b@example.test' }
const ADMIN = 'w213Admin'

function iso(ms) {
  return new Date(ms).toISOString()
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Local stand-ins: D1 over node:sqlite and the JWKS endpoint
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

const originalFetch = globalThis.fetch
let signingKey
let publicJwk
const tokens = new Map()

async function mintToken({ uid, email }) {
  const now = Math.floor(Date.now() / 1000)

  return new SignJWT({
    email,
    email_verified: true,
    auth_time: now - 60,
    firebase: { sign_in_provider: 'password', identities: { email: [email] } },
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
    .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(PROJECT_ID)
    .setSubject(uid)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 3600)
    .sign(signingKey)
}

before(async () => {
  const keyPair = await generateKeyPair('RS256', { extractable: true })

  signingKey = keyPair.privateKey
  publicJwk = { ...(await exportJWK(keyPair.publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' }
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
  tokens.set(customerA.uid, await mintToken(customerA))
  tokens.set(customerB.uid, await mintToken(customerB))
})

after(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let eventDay = 0

/** A distinct 2027 event date per booking (the blocking-date index). */
function nextEventDate() {
  eventDay += 1
  return iso(Date.parse('2027-03-01T00:00:00.000Z') + eventDay * 24 * HOUR).slice(0, 10)
}

function migratedDatabase() {
  const database = new DatabaseSync(':memory:')
  const directory = join(APP_ROOT, 'migrations')

  database.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(directory).filter((file) => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(directory, name), 'utf8'))
  }

  for (const [uid, email, role] of [
    [customerA.uid, customerA.email, 'customer'],
    [customerB.uid, customerB.email, 'customer'],
    [ADMIN, 'studio-admin@example.test', 'admin'],
  ]) {
    database
      .prepare(
        `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
         VALUES (?, ?, 'اختبار', 'اختبار', '0500000000', ?, '2026-09-01T10:00:00.000Z')`,
      )
      .run(uid, email, role)
  }

  return database
}

function insertRevision(database, section, columns, createdMs, effectiveMs = null) {
  const names = Object.keys(columns)
  const info = database
    .prepare(
      `INSERT INTO settings_revisions (section, ${names.join(', ')}, created_by, reauth_at, created_at, effective_at)
       VALUES (?, ${names.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
    )
    .run(
      section,
      ...Object.values(columns),
      ADMIN,
      iso(createdMs - MINUTE),
      iso(createdMs),
      effectiveMs === null ? null : iso(effectiveMs),
    )

  return Number(info.lastInsertRowid)
}

function insertBank(database, iban, createdMs, effectiveMs = null) {
  return insertRevision(
    database,
    'bank',
    { bank_name: 'مصرف الراجحي', bank_account_holder: 'سندس يار', bank_iban: iban },
    createdMs,
    effectiveMs,
  )
}

function insertContact(database, number, createdMs, effectiveMs = null) {
  return insertRevision(database, 'contact', { whatsapp_number: number }, createdMs, effectiveMs)
}

function publishTerms(database, seq, body, createdMs) {
  database
    .prepare(
      `INSERT INTO terms_versions (version, seq, body, body_sha256, change_summary, created_by, reauth_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(`v${seq}`, seq, body, sha256(body), ADMIN, iso(createdMs - MINUTE), iso(createdMs))
}

function insertBooking(
  database,
  {
    uid = customerA.uid,
    status = 'approved_hold',
    flowVersion = 2,
    holdMs = Date.now() + 20 * HOUR,
    approvedMs = Date.now() - 28 * HOUR,
    termsVersion = null,
    termsAcceptedMs = null,
    bankRevisionId = null,
  } = {},
) {
  const id = randomUUID()

  database
    .prepare(
      `INSERT INTO booking_requests
         (id, user_id, event_date, status, package_snapshot, estimated_total,
          hold_expires_at, flow_version, deposit_amount, terms_version, terms_accepted_at, bank_revision_id)
       VALUES (?, ?, ?, ?, '{}', 6500, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      uid,
      nextEventDate(),
      status,
      holdMs === null ? null : iso(holdMs),
      flowVersion,
      flowVersion === 2 ? 1300 : null,
      termsVersion,
      termsAcceptedMs === null ? null : iso(termsAcceptedMs),
      bankRevisionId,
    )

  if (approvedMs !== null) {
    database
      .prepare(
        `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
         VALUES (?, 'pending_review', 'approved_hold', ?, NULL, ?)`,
      )
      .run(id, ADMIN, iso(approvedMs))
  }

  return id
}

/**
 * A database with deposit, bank (IBAN_A) and contact (STUDIO) saved ten
 * days ago and terms v1 published, and an env with online confirmation on.
 */
function scenario(envOverrides = {}) {
  const database = migratedDatabase()
  const tenDaysAgo = Date.now() - 10 * 24 * HOUR

  insertRevision(
    database,
    'deposit',
    { deposit_kind: 'percent', deposit_percent: 20, deposit_round_to: 50 },
    tenDaysAgo,
  )
  const bankId = insertBank(database, IBAN_A, tenDaysAgo)
  insertContact(database, STUDIO, tenDaysAgo)
  publishTerms(database, 1, TERMS_V1, tenDaysAgo)

  const limiter = { limited: false, calls: 0 }
  const env = {
    DB: new D1DatabaseStub(database),
    FIREBASE_PROJECT_ID: PROJECT_ID,
    ONLINE_CONFIRMATION: 'on',
    RL_CUSTOMER_WRITE: {
      async limit() {
        limiter.calls += 1
        return { success: !limiter.limited }
      },
    },
    ...envOverrides,
  }

  return { database, env, bankId, limiter }
}

const executionContext = { waitUntil() {}, passThroughOnException() {} }

async function call(env, { method = 'GET', bookingId, path = 'confirmation', user = customerA, body }) {
  const url = new URL(`https://studio.example/api/bookings/${bookingId}/${path}`)
  const headers = { Authorization: `Bearer ${tokens.get(user.uid)}` }
  let payload

  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }

  const response = await dispatchCustomerPortalRequest(
    new Request(url, { method, headers, body: payload }),
    env,
    url,
    executionContext,
    customerPortalRoutes,
  )

  return { status: response.status, headers: response.headers, json: await response.json() }
}

function view(env, bookingId, user) {
  return call(env, { bookingId, user })
}

function accept(env, bookingId, termsVersion = 'v1', user = customerA) {
  return call(env, { method: 'POST', bookingId, path: 'confirmation/accept-terms', user, body: { termsVersion } })
}

function notify(env, bookingId, user = customerA) {
  return call(env, { method: 'POST', bookingId, path: 'confirmation/whatsapp-notice', user, body: { channel: 'whatsapp' } })
}

function bookingRow(database, id) {
  return database
    .prepare(
      `SELECT status, hold_expires_at AS holdExpiresAt, terms_version AS termsVersion,
              terms_accepted_at AS termsAcceptedAt, bank_revision_id AS bankRevisionId, updated_at AS updatedAt
       FROM booking_requests WHERE id = ?`,
    )
    .get(id)
}

function events(database, id, event) {
  return database
    .prepare('SELECT actor, actor_uid AS actorUid, details, created_at AS createdAt FROM booking_events WHERE booking_id = ? AND event = ? ORDER BY id')
    .all(id, event)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('shared confirmation helpers', () => {
  test('parseTermsVersion accepts only v1…v9999', () => {
    for (const value of ['v1', 'v12', 'v9999']) {
      assert.equal(parseTermsVersion(value), value)
    }

    for (const value of ['v0', 'v01', 'V1', 'v10000', '1', ' v1', 'v1 ', 'v١', 1, null, undefined, {}]) {
      assert.equal(parseTermsVersion(value), null, String(value))
    }
  })

  test('groupIbanForDisplay groups by four and keeps every character', () => {
    assert.equal(groupIbanForDisplay(IBAN_A), 'SA09 1000 0000 0000 0000 0001')
    assert.equal(groupIbanForDisplay(IBAN_A).replaceAll(' ', ''), IBAN_A)
  })

  test('resolveVerificationContact (GAP-05)', () => {
    assert.deepEqual(resolveVerificationContact(STUDIO, STUDIO), { whatsappNumber: STUDIO, changedSinceApproval: false })
    assert.deepEqual(resolveVerificationContact(STUDIO, NEW_STUDIO), { whatsappNumber: STUDIO, changedSinceApproval: true })
    assert.deepEqual(resolveVerificationContact(null, NEW_STUDIO), { whatsappNumber: null, changedSinceApproval: true })
    assert.deepEqual(resolveVerificationContact(null, null), { whatsappNumber: null, changedSinceApproval: false })
    assert.deepEqual(resolveVerificationContact('unknown', NEW_STUDIO), { whatsappNumber: null, changedSinceApproval: false })
  })

  test('every statement prepares against the migrated schema', () => {
    const database = migratedDatabase()

    for (const [name, sql] of Object.entries(CONFIRMATION_SQL)) {
      assert.doesNotThrow(() => database.prepare(sql), name)
    }
  })
})

// ---------------------------------------------------------------------------
// Gates, ownership, legacy rows
// ---------------------------------------------------------------------------

describe('gating and ownership', () => {
  test('OC off (missing, "off", "On") → 503 on all three routes, nothing written', async () => {
    for (const value of [undefined, 'off', 'On']) {
      const { database, env } = scenario({ ONLINE_CONFIRMATION: value })
      const id = insertBooking(database)

      assert.equal((await view(env, id)).status, 503)
      assert.equal((await accept(env, id)).status, 503)
      assert.equal((await notify(env, id)).status, 503)
      assert.equal(bookingRow(database, id).termsAcceptedAt, null)
    }
  })

  test('kill switch pulled → 503 (OCe = OC ∧ KS)', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database)

    database
      .prepare(
        `INSERT INTO ops_switch_revisions (switch_name, state, note, created_by, reauth_at, created_at)
         VALUES ('online_confirmation', 'off', NULL, ?, NULL, ?)`,
      )
      .run(ADMIN, iso(Date.now() - MINUTE))

    const response = await view(env, id)

    assert.equal(response.status, 503)
    assert.equal(response.json.error.code, 'SERVICE_UNAVAILABLE')
    assert.equal((await accept(env, id)).status, 503)
    assert.equal((await notify(env, id)).status, 503)
  })

  test("another customer's booking answers exactly like an unknown id, and stays untouched (N-04, N-36)", async () => {
    const { database, env } = scenario()
    const ofB = insertBooking(database, { uid: customerB.uid })
    const unknown = randomUUID()

    for (const send of [view, accept, notify]) {
      const foreign = await send(env, ofB)
      const missing = await send(env, unknown)

      assert.equal(foreign.status, 404)
      assert.deepEqual(foreign.json, missing.json)
      assert.equal(foreign.json.error.code, 'BOOKING_NOT_FOUND')
    }

    assert.equal(bookingRow(database, ofB).termsAcceptedAt, null)
    assert.equal(events(database, ofB, 'deposit_notice_sent').length, 0)
    assert.equal((await view(env, ofB, customerB)).status, 200)
  })

  test('legacy flow-1 rows → 409 LEGACY_FLOW_NOT_SUPPORTED', async () => {
    const { database, env } = scenario()
    const legacy = insertBooking(database, { status: 'pending_review', flowVersion: 1, holdMs: null, approvedMs: null })

    for (const send of [view, accept, notify]) {
      const response = await send(env, legacy)

      assert.equal(response.status, 409)
      assert.equal(response.json.error.code, 'LEGACY_FLOW_NOT_SUPPORTED')
    }
  })

  test('a flow-2 row outside the panel statuses → 409 CONFIRMATION_NOT_AVAILABLE', async () => {
    const { database, env } = scenario()
    const cancelled = insertBooking(database, { status: 'cancelled' })
    const response = await view(env, cancelled)

    assert.equal(response.status, 409)
    assert.equal(response.json.error.code, 'CONFIRMATION_NOT_AVAILABLE')
  })

  test('bodies: exact keys, byte cap, JSON only (SB-3)', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database)
    const path = 'confirmation/accept-terms'

    for (const body of [{}, { termsVersion: 'v1', extra: 1 }, { termsVersion: 1 }, { termsVersion: 'x' }, `{"termsVersion":"${'v'.repeat(300)}"}`]) {
      const response = await call(env, { method: 'POST', bookingId: id, path, body })

      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal(response.json.error.code, 'INVALID_REQUEST_BODY')
    }

    for (const body of [{}, { channel: 'sms' }, { channel: 'whatsapp', at: 1 }]) {
      const response = await call(env, { method: 'POST', bookingId: id, path: 'confirmation/whatsapp-notice', body })

      assert.equal(response.status, 400, JSON.stringify(body))
    }

    const url = new URL(`https://studio.example/api/bookings/${id}/${path}`)
    const response = await dispatchCustomerPortalRequest(
      new Request(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens.get(customerA.uid)}`, 'Content-Type': 'text/plain' },
        body: '{"termsVersion":"v1"}',
      }),
      env,
      url,
      executionContext,
      customerPortalRoutes,
    )

    assert.equal(response.status, 415)
    assert.equal(bookingRow(database, id).termsAcceptedAt, null)
  })

  test('customer writes are burst-limited per uid (RL_CUSTOMER_WRITE) → 429', async () => {
    const { database, env, limiter } = scenario()
    const id = insertBooking(database)

    limiter.limited = true

    for (const send of [accept, notify]) {
      const response = await send(env, id)

      assert.equal(response.status, 429)
      assert.equal(response.json.error.code, 'RATE_LIMITED')
      assert.ok(response.headers.get('Retry-After'))
    }

    assert.equal(bookingRow(database, id).termsAcceptedAt, null)
  })
})

// ---------------------------------------------------------------------------
// The panel and accepting the terms
// ---------------------------------------------------------------------------

describe('GET confirmation and accept-terms', () => {
  test('before acceptance: terms to read, no bank details, WhatsApp channel, studio number', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database)
    const { status, json, headers } = await view(env, id)

    assert.equal(status, 200)
    assert.equal(headers.get('Cache-Control'), 'no-store')
    assert.equal(json.booking.id, id)
    assert.equal(json.booking.flowVersion, 2)
    assert.equal(json.booking.depositAmount, 1300)
    assert.equal(json.booking.estimatedTotal, 6500)
    assert.deepEqual(
      { version: json.terms.version, body: json.terms.body },
      { version: 'v1', body: TERMS_V1 },
    )
    assert.equal(json.acceptedTerms, null)
    assert.equal(json.bankDetails, null)
    assert.equal(json.bankDetailsChangedSinceAcceptance, false)
    assert.equal(json.receiptChannel, 'whatsapp')
    assert.deepEqual(json.receipts, [])
    assert.equal(json.notice, null)
    assert.deepEqual(json.studio, { whatsappNumber: STUDIO, whatsappNumberChangedAt: null })
    assert.deepEqual(json.verificationContact, { whatsappNumber: STUDIO, changedSinceApproval: false })
    assert.ok(Math.abs(Date.parse(json.serverTime) - Date.now()) < 60_000)
  })

  test('accept v1: row, bank snapshot and a terms_accepted event with bodySha256 (TM-18); repeat is idempotent', async () => {
    const { database, env, bankId } = scenario()
    const id = insertBooking(database)
    const holdBefore = bookingRow(database, id).holdExpiresAt
    const first = await accept(env, id)

    assert.equal(first.status, 200)
    assert.equal(first.json.booking.termsVersion, 'v1')
    assert.deepEqual(first.json.bankDetails.iban, IBAN_A)
    assert.equal(first.json.bankDetails.iban.length, 24)
    assert.equal(first.json.bankDetailsChangedSinceAcceptance, false)

    const row = bookingRow(database, id)

    assert.equal(row.status, 'approved_hold')
    assert.equal(row.holdExpiresAt, holdBefore)
    assert.equal(row.termsVersion, 'v1')
    assert.equal(row.termsAcceptedAt, first.json.booking.termsAcceptedAt)
    assert.equal(row.bankRevisionId, bankId)

    const [event, ...more] = events(database, id, 'terms_accepted')

    assert.equal(more.length, 0)
    assert.equal(event.actor, 'customer')
    assert.equal(event.actorUid, null)
    assert.deepEqual(JSON.parse(event.details), { termsVersion: 'v1', bodySha256: sha256(TERMS_V1) })

    const again = await accept(env, id)

    assert.equal(again.status, 200)
    assert.equal(again.json.booking.termsAcceptedAt, first.json.booking.termsAcceptedAt)
    assert.equal(events(database, id, 'terms_accepted').length, 1)
  })

  test('after acceptance the panel shows the effective bank details and the accepted version', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database)

    await accept(env, id)
    const { json } = await view(env, id)

    assert.deepEqual(
      { ...json.bankDetails, updatedAt: undefined },
      { bankName: 'مصرف الراجحي', accountHolder: 'سندس يار', iban: IBAN_A, updatedAt: undefined },
    )
    assert.equal(json.bankDetailsChangedSinceAcceptance, false)
    assert.deepEqual(json.acceptedTerms, { version: 'v1', bodySha256: sha256(TERMS_V1), body: TERMS_V1 })
  })

  test('a pending bank revision is never shown; one in force flags the change (TM-03, TM-16)', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database)

    await accept(env, id)
    insertBank(database, IBAN_B, Date.now() - HOUR, Date.now() + 23 * HOUR)

    let { json } = await view(env, id)

    assert.equal(json.bankDetails.iban, IBAN_A)
    assert.equal(json.bankDetailsChangedSinceAcceptance, false)
    assert.ok(!JSON.stringify(json).includes(IBAN_B))

    insertBank(database, IBAN_B, Date.now() - MINUTE)
    ;({ json } = await view(env, id))

    assert.equal(json.bankDetails.iban, IBAN_B)
    assert.equal(json.bankDetailsChangedSinceAcceptance, true)
  })

  test('a newer terms version: the accepted one stays readable, a stale accept is refused (TM-18, N-16)', async () => {
    const { database, env } = scenario()
    const accepted = insertBooking(database)
    const pending = insertBooking(database)

    await accept(env, accepted)
    publishTerms(database, 2, TERMS_V2, Date.now() - MINUTE)

    const { json } = await view(env, accepted)

    assert.equal(json.terms.version, 'v2')
    assert.deepEqual(json.acceptedTerms, { version: 'v1', bodySha256: sha256(TERMS_V1), body: TERMS_V1 })

    const stale = await accept(env, pending, 'v1')

    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'TERMS_VERSION_MISMATCH')
    assert.equal(bookingRow(database, pending).termsAcceptedAt, null)
    assert.equal((await accept(env, pending, 'v3')).json.error.code, 'TERMS_VERSION_MISMATCH')
    assert.equal((await accept(env, pending, 'v2')).status, 200)
    // Already accepted v1: sending v2 later does not rewrite her acceptance.
    assert.equal((await accept(env, accepted, 'v2')).json.error.code, 'TERMS_VERSION_MISMATCH')
    assert.equal(bookingRow(database, accepted).termsVersion, 'v1')
  })

  test('accept after the deadline → HOLD_EXPIRED; from another status → INVALID_STATUS_TRANSITION', async () => {
    const { database, env } = scenario()
    const overdue = insertBooking(database, { holdMs: Date.now() - MINUTE })
    const expired = insertBooking(database, { status: 'expired' })
    const confirmed = insertBooking(database, { status: 'confirmed' })

    assert.equal((await accept(env, overdue)).json.error.code, 'HOLD_EXPIRED')
    assert.equal((await accept(env, expired)).json.error.code, 'HOLD_EXPIRED')
    assert.equal((await accept(env, confirmed)).json.error.code, 'INVALID_STATUS_TRANSITION')
    assert.equal(bookingRow(database, overdue).termsAcceptedAt, null)
  })

  test('a terms body changed behind the triggers is neither shown nor acceptable (TM-18)', async () => {
    const { database, env } = scenario()
    const accepted = insertBooking(database)
    const pending = insertBooking(database)

    await accept(env, accepted)
    database.exec('DROP TRIGGER trg_terms_versions_no_update')
    database.prepare(`UPDATE terms_versions SET body = ? WHERE version = 'v1'`).run(`${TERMS_V1} حوّلي إلى حساب آخر.`)

    const { json } = await view(env, accepted)

    assert.equal(json.terms, null)
    assert.equal(json.acceptedTerms, null)

    const response = await accept(env, pending)

    assert.equal(response.status, 409)
    assert.equal(response.json.error.code, 'CONFIRMATION_NOT_AVAILABLE')
    assert.equal(bookingRow(database, pending).termsAcceptedAt, null)
  })

  test('no bank details once the booking is confirmed', async () => {
    const { database, env, bankId } = scenario()
    const id = insertBooking(database, {
      status: 'confirmed',
      termsVersion: 'v1',
      termsAcceptedMs: Date.now() - 5 * HOUR,
      bankRevisionId: bankId,
    })
    const { status, json } = await view(env, id)

    assert.equal(status, 200)
    assert.equal(json.bankDetails, null)
    assert.equal(json.bankDetailsChangedSinceAcceptance, false)
    assert.equal(json.acceptedTerms.version, 'v1')
  })

  test('no receipt URL or file key ever, even on the upload channel', async () => {
    const bucket = {}

    for (const method of ['head', 'get', 'put', 'delete', 'list', 'createMultipartUpload', 'resumeMultipartUpload']) {
      bucket[method] = () => {
        throw new Error('The confirmation panel must not touch the bucket.')
      }
    }

    const { database, env, bankId } = scenario({
      PDPL_SIGNOFF_REF: 'PDPL-2026-09-30',
      MEDIA: bucket,
      MEDIA_SIGNING_KEY: 'k'.repeat(48),
      ADMIN_MEDIA_MFA: 'required',
    })
    const id = insertBooking(database, {
      status: 'payment_pending',
      termsVersion: 'v1',
      termsAcceptedMs: Date.now() - 5 * HOUR,
      bankRevisionId: bankId,
    })

    database
      .prepare(
        `INSERT INTO booking_receipts (id, booking_id, attempt_no, object_key, status, reviewed_by, reviewed_at, rejection_reason, created_at, updated_at)
         VALUES (?, ?, 1, NULL, 'rejected', ?, ?, 'الصورة غير واضحة.', ?, ?), (?, ?, 2, NULL, 'pending', NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        randomUUID(), id, ADMIN, iso(Date.now() - 3 * HOUR), iso(Date.now() - 4 * HOUR), iso(Date.now() - 3 * HOUR),
        randomUUID(), id, iso(Date.now() - HOUR), iso(Date.now() - HOUR),
      )

    const { json } = await view(env, id)

    assert.equal(json.receiptChannel, 'upload')
    assert.deepEqual(
      json.receipts.map(({ attemptNo, status, rejectionReason }) => ({ attemptNo, status, rejectionReason })),
      [
        { attemptNo: 2, status: 'pending', rejectionReason: null },
        { attemptNo: 1, status: 'rejected', rejectionReason: 'الصورة غير واضحة.' },
      ],
    )

    for (const receipt of json.receipts) {
      assert.deepEqual(Object.keys(receipt).sort(), ['attemptNo', 'rejectionReason', 'reviewedAt', 'status', 'uploadedAt'])
    }

    assert.doesNotMatch(JSON.stringify(json), /\/api\/media|r\/[0-9a-f-]{36}\//)
  })
})

// ---------------------------------------------------------------------------
// The WhatsApp deposit notice (B1, UX-02, N-19)
// ---------------------------------------------------------------------------

describe('POST whatsapp-notice', () => {
  test('refused before the terms are accepted', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database)
    const response = await notify(env, id)

    assert.equal(response.status, 409)
    assert.equal(response.json.error.code, 'TERMS_NOT_ACCEPTED')
    assert.equal(events(database, id, 'deposit_notice_sent').length, 0)
  })

  test('records once per deadline, protects the hold, never moves status or deadline (N-19)', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database)

    await accept(env, id)
    const before = bookingRow(database, id)
    const first = await notify(env, id)

    assert.equal(first.status, 200)
    assert.equal(first.json.holdProtected, true)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const repeat = await notify(env, id)

      assert.equal(repeat.status, 200)
      assert.equal(repeat.json.noticeRecordedAt, first.json.noticeRecordedAt)
    }

    const notices = events(database, id, 'deposit_notice_sent')

    assert.equal(notices.length, 1)
    assert.equal(notices[0].actor, 'customer')
    assert.deepEqual(JSON.parse(notices[0].details), { holdExpiresAt: before.holdExpiresAt })
    assert.deepEqual(bookingRow(database, id), before)

    const { json } = await view(env, id)

    assert.deepEqual(json.notice, { sentAt: first.json.noticeRecordedAt, holdProtected: true })
  })

  test('a notice for an earlier deadline protects nothing: a new deadline takes a new notice', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database)

    await accept(env, id)
    await notify(env, id)
    database
      .prepare('UPDATE booking_requests SET hold_expires_at = ? WHERE id = ?')
      .run(iso(Date.now() + 40 * HOUR), id)

    assert.equal((await view(env, id)).json.notice, null)
    assert.equal((await notify(env, id)).status, 200)
    assert.equal(events(database, id, 'deposit_notice_sent').length, 2)
  })

  test('accepted within the grace window after the deadline, refused after it', async () => {
    const { database, env, bankId } = scenario()
    const accepted = { termsVersion: 'v1', termsAcceptedMs: Date.now() - 80 * HOUR, bankRevisionId: bankId }
    const inGrace = insertBooking(database, { ...accepted, holdMs: Date.now() - 2 * HOUR })
    const pastGrace = insertBooking(database, { ...accepted, holdMs: Date.now() - 73 * HOUR })

    assert.equal((await notify(env, inGrace)).status, 200)

    const refused = await notify(env, pastGrace)

    assert.equal(refused.status, 409)
    assert.equal(refused.json.error.code, 'HOLD_EXPIRED')
    assert.equal(events(database, pastGrace, 'deposit_notice_sent').length, 0)
  })

  test('only while approved_hold', async () => {
    const { database, env, bankId } = scenario()
    const accepted = { termsVersion: 'v1', termsAcceptedMs: Date.now() - 5 * HOUR, bankRevisionId: bankId }
    const expired = insertBooking(database, { ...accepted, status: 'expired' })
    const confirmed = insertBooking(database, { ...accepted, status: 'confirmed' })

    assert.equal((await notify(env, expired)).json.error.code, 'HOLD_EXPIRED')
    assert.equal((await notify(env, confirmed)).json.error.code, 'CONFIRMATION_NOT_AVAILABLE')
    assert.equal(events(database, expired, 'deposit_notice_sent').length, 0)
  })
})

// ---------------------------------------------------------------------------
// GAP-05: the verification number
// ---------------------------------------------------------------------------

describe('verification contact (GAP-05)', () => {
  test('a number changed after approval: the link keeps the number in force at approval, with the notice', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database, { approvedMs: Date.now() - 5 * 24 * HOUR })

    insertContact(database, NEW_STUDIO, Date.now() - 4 * 24 * HOUR)

    const { json } = await view(env, id)

    // The 72 h notice of §3.3 #1 has lapsed; the GAP-05 notice has not.
    assert.deepEqual(json.studio, { whatsappNumber: NEW_STUDIO, whatsappNumberChangedAt: null })
    assert.deepEqual(json.verificationContact, { whatsappNumber: STUDIO, changedSinceApproval: true })
  })

  test('a change still pending at approval time does not count as the approval number', async () => {
    const { database, env } = scenario()

    insertContact(database, NEW_STUDIO, Date.now() - 30 * HOUR, Date.now() - 6 * HOUR)
    const id = insertBooking(database, { approvedMs: Date.now() - 20 * HOUR })
    const { json } = await view(env, id)

    assert.equal(json.studio.whatsappNumber, NEW_STUDIO)
    assert.deepEqual(json.verificationContact, { whatsappNumber: STUDIO, changedSinceApproval: true })
  })

  test('no approval row: the compiled number, no notice', async () => {
    const { database, env } = scenario()
    const id = insertBooking(database, { approvedMs: null })
    const { json } = await view(env, id)

    assert.deepEqual(json.verificationContact, { whatsappNumber: null, changedSinceApproval: false })
  })
})
