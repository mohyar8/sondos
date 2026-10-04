// W2-16 / UX-02, UX-14, TM-03, TM-19, SB-2, SB-4: journey facts v2 and the
// GET /api/bookings/me additions. Each case fails if its control is taken
// out of shared/journey.ts, worker/portal/journey-loader.ts,
// worker/bookings.ts or src/api/bookings.ts:
// - deriveJourneyStage: `awaiting_deposit` / `deposit_reported` only on a
//   flow-2 `approved_hold` with accepted terms, `deposit_reported` only with
//   a notice for the CURRENT deadline; `updatedAt` is the instant of the
//   status change or stage event behind each stage, null when unknown or
//   not an ISO instant; without the v2 facts the result is what it was;
// - the loader reads the v2 facts from the seeded database; its notice fact
//   agrees with the hold jobs' NOTICE_PROTECTED_SQL on every booking; the
//   customer read stays filtered by uid;
// - loadJourneyRecordsByBookingIds: an IN list of one `?` per distinct id
//   (never the ids in the SQL), the 100-id bound (D1's parameter cap), no
//   query for an empty list, rows of any customer with their owner, and no
//   customer-facing module imports it;
// - GET /api/bookings/me answers `termsAcceptedAt`, `stageUpdatedAt`, the
//   deposit sub-state and `studio` from the effective contact revision
//   (null without one; `whatsappNumberChangedAt` only after a change), for
//   the caller's own bookings only;
// - the SPA parser accepts the old and the new shape, and the booking form
//   reads the plan's 409 OPEN_REQUEST_LIMIT, and a Wave 0 Worker's
//   TOO_MANY_OPEN_REQUESTS, as the same cap.
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

import { deriveJourneyStage, journeyStageIds } from '../shared/journey.ts'
import { SENSITIVE_CHANGE_NOTICE_HOURS } from '../shared/settings.ts'
import { createBookingRequest, parseMyBookingsBody } from '../src/api/bookings.ts'
import { handleMyBookings } from '../worker/bookings.ts'
import { NOTICE_PROTECTED_SQL } from '../worker/jobs/hold-state.ts'
import {
  MAXIMUM_JOURNEY_IDS,
  loadCustomerBookingRecords,
  loadJourneyRecordsByBookingIds,
} from '../worker/portal/journey-loader.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIGRATIONS = join(APP_ROOT, 'migrations')
const SEED_SQL = readFileSync(join(APP_ROOT, 'scripts', 'dev-seed.sql'), 'utf8')
const PLACEHOLDER = '{{CUSTOMER_UID}}'
const BOOKING_PREFIX = '5eedb00c-0000-4000-8000-0000000000'
const PROJECT_ID = 'sundus-yar-w2-16-test'
const KEY_ID = 'w2-16-test-key'
const ORIGIN = 'https://sundusyar.test'
const HOUR_MS = 60 * 60 * 1000
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const tester = { uid: 'w216Tester', email: 'bride@example.test' }
const other = { uid: 'w216Other', email: 'other-bride@example.test' }
const admin = { uid: 'w216Admin', email: 'studio-admin@example.test' }

function seedId(suffix) {
  return `${BOOKING_PREFIX}${suffix}`
}

function iso(ms) {
  return new Date(ms).toISOString()
}

// ---------------------------------------------------------------------------
// Local stand-ins: node:sqlite with the migrations and the seed, D1 over it,
// the JWKS endpoint
// ---------------------------------------------------------------------------

/** D1 binds a whole JS number as INTEGER; node:sqlite would bind REAL. */
function toSqliteValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
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
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    }
  }
}

/** Records every prepared statement, so a test can inspect the SQL text. */
class D1DatabaseStub {
  constructor(database) {
    this.database = database
    this.prepared = []
  }

  prepare(sql) {
    this.prepared.push(sql)

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

function openMigrated() {
  const database = new DatabaseSync(':memory:')

  database.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort()) {
    database.exec(readFileSync(join(MIGRATIONS, name), 'utf8'))
  }

  return database
}

function insertUser(database, user, role) {
  database
    .prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
       VALUES (?, ?, 'سارة', 'تجريبية', '+966500000001', ?, '2026-09-01T10:00:00.000Z')`,
    )
    .run(user.uid, user.email, role)
}

/** The seed for `uid`, in one transaction (scripts/dev-seed.sql, W1-01). */
function applySeed(database, uid) {
  const parts = SEED_SQL.split(PLACEHOLDER)
  assert.equal(parts.length, 2, 'dev-seed.sql holds the uid placeholder exactly once')

  database.exec('BEGIN')

  try {
    database.exec(parts.join(uid))
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/**
 * A migrated database with the tester's verified customer row, the admin,
 * the seed's bookings for the tester and a second customer of its own.
 */
function seededDatabase() {
  const database = openMigrated()

  insertUser(database, admin, 'admin')
  insertUser(database, tester, 'customer')
  insertUser(database, other, 'customer')
  applySeed(database, tester.uid)

  return database
}

function all(database, sql, ...params) {
  return database.prepare(sql).all(...params.map(toSqliteValue)).map((row) => ({ ...row }))
}

function scalar(database, sql, ...params) {
  const row = database.prepare(sql).get(...params.map(toSqliteValue))

  return row === undefined ? undefined : Object.values(row)[0]
}

/** A contact revision in force from `effectiveMs` (settings_revisions, 0008). */
function insertContact(database, digits, createdMs, effectiveMs = createdMs) {
  database
    .prepare(
      `INSERT INTO settings_revisions (section, whatsapp_number, created_by, reauth_at, created_at, effective_at)
       VALUES ('contact', ?, ?, ?, ?, ?)`,
    )
    .run(digits, admin.uid, iso(createdMs - 60_000), iso(createdMs), iso(effectiveMs))
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

function workerEnv(database) {
  return {
    DB: new D1DatabaseStub(database),
    FIREBASE_PROJECT_ID: PROJECT_ID,
    ADMIN_MEDIA_MFA: 'required',
    ADMIN_SETTINGS_2F: 'off',
  }
}

async function myBookings(env, token) {
  const response = await handleMyBookings(
    new Request(`${ORIGIN}/api/bookings/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
  )

  return { status: response.status, body: await response.json() }
}

// ---------------------------------------------------------------------------
// shared/journey.ts
// ---------------------------------------------------------------------------

const T = {
  created: '2026-09-01T08:00:00.000Z',
  approved: '2026-09-02T09:00:00.000Z',
  terms: '2026-09-02T10:30:00.000Z',
  notice: '2026-09-02T11:00:00.000Z',
  hold: '2026-09-04T09:00:00.000Z',
  receipt: '2026-09-03T12:00:00.000Z',
  confirmed: '2026-09-05T12:00:00.000Z',
  profile: '2026-09-06T12:00:00.000Z',
  opened: '2026-10-20T12:00:00.000Z',
  submitted: '2026-10-25T12:00:00.000Z',
  album: '2026-11-01T12:00:00.000Z',
  handover: '2026-11-10T12:00:00.000Z',
  completed: '2026-11-12T12:00:00.000Z',
  purged: '2026-12-12T12:00:00.000Z',
}

/** No stage time known (every column NULL). */
const NO_TIMES = Object.freeze({
  statusChangedAt: null,
  depositNoticeSentAt: null,
  latestReceiptAt: null,
  eventProfileCreatedAt: null,
  galleryOpenedAt: null,
  galleryPurgedAt: null,
  albumStageChangedAt: null,
  handoverChangedAt: null,
})

function facts(overrides = {}) {
  return {
    status: 'approved_hold',
    flowVersion: 2,
    eventDate: '2026-12-01',
    holdExpiresAt: T.hold,
    completedAt: null,
    latestReceiptStatus: null,
    hasEventProfile: false,
    gallery: null,
    albumStage: null,
    handover: null,
    ...overrides,
  }
}

function times(overrides) {
  return { ...NO_TIMES, ...overrides }
}

/** The v1 view of `input`: the same facts without the v2 fields. */
function withoutV2(input) {
  const { termsAcceptedAt, noticeForCurrentDeadline, stageUpdatedAt, ...rest } = input
  void termsAcceptedAt
  void noticeForCurrentDeadline
  void stageUpdatedAt

  return rest
}

const NOW = new Date('2026-09-03T00:00:00.000Z')

describe('deriveJourneyStage: deposit sub-states (UX-02)', () => {
  test('without the v2 facts a flow-2 hold has no sub-state and no updatedAt, exactly as before', () => {
    assert.deepEqual(deriveJourneyStage(facts(), NOW), {
      stage: 'approved_hold',
      reason: null,
      deadline: { kind: 'instant', value: T.hold },
      subState: null,
      updatedAt: null,
    })
  })

  test('terms accepted and no notice for the current deadline → awaiting_deposit, timed by the acceptance', () => {
    const result = deriveJourneyStage(
      facts({ termsAcceptedAt: T.terms, noticeForCurrentDeadline: false, stageUpdatedAt: times({ statusChangedAt: T.approved }) }),
      NOW,
    )

    assert.equal(result.stage, 'approved_hold')
    assert.equal(result.subState, 'awaiting_deposit')
    assert.equal(result.updatedAt, T.terms)
    assert.deepEqual(result.deadline, { kind: 'instant', value: T.hold })
  })

  test('a notice for the current deadline → deposit_reported, timed by the notice; the deadline never moves (N-19)', () => {
    const result = deriveJourneyStage(
      facts({
        termsAcceptedAt: T.terms,
        noticeForCurrentDeadline: true,
        stageUpdatedAt: times({ statusChangedAt: T.approved, depositNoticeSentAt: T.notice }),
      }),
      NOW,
    )

    assert.equal(result.subState, 'deposit_reported')
    assert.equal(result.updatedAt, T.notice)
    assert.deepEqual(result.deadline, { kind: 'instant', value: T.hold })
  })

  test('a notice without accepted terms is not a deposit step (the API refuses one; the derivation does not trust it)', () => {
    const result = deriveJourneyStage(
      facts({ termsAcceptedAt: null, noticeForCurrentDeadline: true, stageUpdatedAt: times({ statusChangedAt: T.approved, depositNoticeSentAt: T.notice }) }),
      NOW,
    )

    assert.equal(result.subState, null)
    assert.equal(result.updatedAt, T.approved)
  })

  test('the deposit step exists only on a flow-2 approved_hold', () => {
    const v2 = { termsAcceptedAt: T.terms, noticeForCurrentDeadline: true, stageUpdatedAt: times({ depositNoticeSentAt: T.notice }) }

    assert.equal(deriveJourneyStage(facts({ ...v2, flowVersion: 1 }), NOW).subState, 'legacy_flow')
    assert.equal(deriveJourneyStage(facts({ ...v2, status: 'payment_pending' }), NOW).subState, null)
    assert.equal(deriveJourneyStage(facts({ ...v2, status: 'confirmed' }), NOW).subState, null)
    assert.equal(deriveJourneyStage(facts({ ...v2, status: 'pending_review' }), NOW).subState, null)
  })

  test('a notice time that is not stored falls back to the status change; a legacy timestamp is unknown', () => {
    const reported = { termsAcceptedAt: T.terms, noticeForCurrentDeadline: true }

    assert.equal(
      deriveJourneyStage(facts({ ...reported, stageUpdatedAt: times({ statusChangedAt: T.approved }) }), NOW).updatedAt,
      T.approved,
    )
    // The 0003 default `CURRENT_TIMESTAMP` has no offset: never read in local time.
    assert.equal(
      deriveJourneyStage(facts({ ...reported, stageUpdatedAt: times({ statusChangedAt: '2026-09-02 09:00:00' }) }), NOW).updatedAt,
      null,
    )
    assert.equal(deriveJourneyStage(facts({ termsAcceptedAt: '2026-09-02 10:30:00' }), NOW).subState, null)
  })

  test('updatedAt is canonical: an offset form is normalised, a fraction kept', () => {
    const result = deriveJourneyStage(
      facts({
        termsAcceptedAt: '2026-09-02T13:30:00+03:00',
        noticeForCurrentDeadline: false,
        stageUpdatedAt: NO_TIMES,
      }),
      NOW,
    )

    assert.equal(result.updatedAt, T.terms)
  })
})

describe('deriveJourneyStage: updatedAt per stage (UX-14)', () => {
  const cases = [
    ['pending_review', facts({ status: 'pending_review', stageUpdatedAt: times({ statusChangedAt: T.created }) }), T.created],
    ['approved_hold (flow 1, legacy_flow)', facts({ flowVersion: 1, stageUpdatedAt: times({ statusChangedAt: T.approved }) }), T.approved],
    ['receipt_review', facts({ status: 'payment_pending', latestReceiptStatus: 'pending', stageUpdatedAt: times({ statusChangedAt: T.approved, latestReceiptAt: T.receipt }) }), T.receipt],
    ['terms_and_receipt_pending, receipt_rejected', facts({ status: 'payment_pending', latestReceiptStatus: 'rejected', stageUpdatedAt: times({ statusChangedAt: T.approved, latestReceiptAt: T.receipt }) }), T.receipt],
    ['terms_and_receipt_pending, no receipt', facts({ status: 'payment_pending', stageUpdatedAt: times({ statusChangedAt: T.approved, latestReceiptAt: null }) }), T.approved],
    ['confirmed', facts({ status: 'confirmed', stageUpdatedAt: times({ statusChangedAt: T.confirmed }) }), T.confirmed],
    ['pre_event_engagement (details saved)', facts({ status: 'confirmed', hasEventProfile: true, stageUpdatedAt: times({ statusChangedAt: T.confirmed, eventProfileCreatedAt: T.profile }) }), T.profile],
    ['pre_event_engagement, awaiting_previews', facts({ status: 'confirmed', eventDate: '2026-08-01', hasEventProfile: true, stageUpdatedAt: times({ statusChangedAt: T.confirmed, eventProfileCreatedAt: T.profile }) }), T.profile],
    ['awaiting_previews without details', facts({ status: 'confirmed', eventDate: '2026-08-01', stageUpdatedAt: times({ statusChangedAt: T.confirmed }) }), T.confirmed],
    ['gallery_open', facts({ status: 'confirmed', gallery: { status: 'open', selectionDeadline: T.submitted, submittedAt: null }, stageUpdatedAt: times({ galleryOpenedAt: T.opened }) }), T.opened],
    ['gallery_locked', facts({ status: 'confirmed', gallery: { status: 'locked', selectionDeadline: null, submittedAt: T.submitted }, stageUpdatedAt: times({ galleryOpenedAt: T.opened }) }), T.submitted],
    ['gallery_locked (purged after a choice)', facts({ status: 'confirmed', gallery: { status: 'purged', selectionDeadline: null, submittedAt: T.submitted }, stageUpdatedAt: times({ galleryPurgedAt: T.purged }) }), T.submitted],
    ['album_design', facts({ status: 'confirmed', albumStage: 'design', stageUpdatedAt: times({ albumStageChangedAt: T.album }) }), T.album],
    ['album_printing', facts({ status: 'confirmed', albumStage: 'printing', stageUpdatedAt: times({ albumStageChangedAt: T.album }) }), T.album],
    ['album_ready', facts({ status: 'confirmed', albumStage: 'ready', stageUpdatedAt: times({ albumStageChangedAt: T.album }) }), T.album],
    ['handover_scheduling (booked)', facts({ status: 'confirmed', albumStage: 'ready', handover: { status: 'scheduled', slotStartsAt: '2026-11-20T08:00:00.000Z', completedAt: null }, stageUpdatedAt: times({ albumStageChangedAt: T.album, handoverChangedAt: T.handover }) }), T.handover],
    ['handover_day', facts({ status: 'confirmed', albumStage: 'ready', handover: { status: 'scheduled', slotStartsAt: '2026-09-03T08:00:00.000Z', completedAt: null }, stageUpdatedAt: times({ handoverChangedAt: T.handover }) }), T.handover],
    ['handover_scheduling, handover_missed', facts({ status: 'confirmed', albumStage: 'ready', handover: { status: 'no_show', slotStartsAt: '2026-09-01T08:00:00.000Z', completedAt: null }, stageUpdatedAt: times({ handoverChangedAt: T.handover }) }), T.handover],
    ['completed_feedback', facts({ status: 'confirmed', completedAt: T.completed, gallery: { status: 'locked', selectionDeadline: null, submittedAt: T.submitted }, stageUpdatedAt: times({ handoverChangedAt: T.handover }) }), T.completed],
    ['privacy_cleanup (purged previews)', facts({ status: 'confirmed', completedAt: T.completed, gallery: { status: 'purged', selectionDeadline: null, submittedAt: T.submitted }, stageUpdatedAt: times({ galleryPurgedAt: T.purged }) }), T.purged],
    ['privacy_cleanup (never a gallery)', facts({ status: 'confirmed', completedAt: T.completed, stageUpdatedAt: NO_TIMES }), T.completed],
  ]

  for (const [name, input, expected] of cases) {
    test(`${name} → ${expected}`, () => {
      const result = deriveJourneyStage(input, NOW)

      assert.notEqual(result.stage, null)
      assert.equal(result.updatedAt, expected)
    })
  }

  test('the v2 facts change neither the stage nor the deadline of any case', () => {
    for (const [name, input] of cases) {
      const v1 = deriveJourneyStage(withoutV2(input), NOW)
      const v2 = deriveJourneyStage(input, NOW)

      assert.equal(v2.stage, v1.stage, name)
      assert.deepEqual(v2.deadline, v1.deadline, name)
      assert.equal(v1.updatedAt, null, name)
    }
  })

  test('every one of the 15 stages is covered above', () => {
    const covered = new Set(cases.map(([, input]) => deriveJourneyStage(input, NOW).stage))

    assert.deepEqual([...covered].sort(), [...journeyStageIds].sort())
  })

  test('no stage → updatedAt null, whatever the times say', () => {
    for (const status of ['rejected', 'cancelled', 'expired', 'contract_pending', 'contract_signed']) {
      const result = deriveJourneyStage(facts({ status, flowVersion: 1, stageUpdatedAt: times({ statusChangedAt: T.approved }) }), NOW)

      assert.equal(result.stage, null, status)
      assert.equal(result.updatedAt, null, status)
      assert.equal(result.subState, null, status)
    }
  })
})

// ---------------------------------------------------------------------------
// worker/portal/journey-loader.ts
// ---------------------------------------------------------------------------

describe('journey loader: v2 facts from the seeded database', () => {
  test('the seed derives awaiting_deposit and deposit_reported where the plan puts them (§6.2, §6.3)', async () => {
    const database = seededDatabase()
    const { records, skippedCount } = await loadCustomerBookingRecords(new D1DatabaseStub(database), tester.uid)
    const byId = new Map(records.map((record) => [record.id, record]))
    const derived = (suffix) => deriveJourneyStage(byId.get(seedId(suffix)).journeyFacts, new Date())

    assert.equal(skippedCount, 0)
    // 02: terms not accepted. 32: terms accepted, no notice. 03: notice for the
    // current deadline. 04: the same, deadline passed (protected, decide_now).
    assert.equal(derived('02').subState, null)
    assert.equal(derived('32').subState, 'awaiting_deposit')
    assert.equal(derived('03').subState, 'deposit_reported')
    assert.equal(derived('04').subState, 'deposit_reported')

    const noticeAt = scalar(
      database,
      `SELECT created_at FROM booking_events WHERE booking_id = ? AND event = 'deposit_notice_sent'`,
      seedId('03'),
    )
    assert.equal(derived('03').updatedAt, noticeAt)
    assert.equal(derived('32').updatedAt, byId.get(seedId('32')).termsAcceptedAt)
    assert.equal(byId.get(seedId('02')).termsAcceptedAt, null)
  })

  test('noticeForCurrentDeadline agrees with the hold jobs\' NOTICE_PROTECTED_SQL on every seeded booking', async () => {
    const database = seededDatabase()
    const ids = all(database, 'SELECT id FROM booking_requests ORDER BY id').map(({ id }) => id)
    const { records, skippedCount } = await loadJourneyRecordsByBookingIds({ DB: new D1DatabaseStub(database) }, ids)
    const protectedIds = new Set(
      all(database, `SELECT b.id FROM booking_requests AS b WHERE ${NOTICE_PROTECTED_SQL}`).map(({ id }) => id),
    )

    assert.equal(skippedCount, 0)
    assert.equal(records.size, ids.length)
    assert.ok(protectedIds.size > 0)

    for (const [id, record] of records) {
      assert.equal(record.journeyFacts.noticeForCurrentDeadline, protectedIds.has(id), id)
    }
  })

  test('stage times come from the defining rows: status history, event details, gallery, album, handover', async () => {
    const database = seededDatabase()
    const { records } = await loadCustomerBookingRecords(new D1DatabaseStub(database), tester.uid)
    const now = new Date()
    const updatedAt = new Map(records.map((record) => [record.id, deriveJourneyStage(record.journeyFacts, now).updatedAt]))
    const column = (sql, suffix) => scalar(database, sql, seedId(suffix))

    assert.equal(
      updatedAt.get(seedId('01')),
      column(`SELECT created_at FROM booking_status_history WHERE booking_id = ? AND to_status = 'pending_review'`, '01'),
    )
    assert.equal(
      updatedAt.get(seedId('09')),
      column(`SELECT created_at FROM booking_status_history WHERE booking_id = ? AND to_status = 'confirmed'`, '09'),
    )
    assert.equal(updatedAt.get(seedId('10')), column('SELECT created_at FROM event_profiles WHERE booking_id = ?', '10'))
    assert.equal(updatedAt.get(seedId('12')), column('SELECT opened_at FROM galleries WHERE booking_id = ?', '12'))
    assert.equal(updatedAt.get(seedId('13')), column('SELECT submitted_at FROM galleries WHERE booking_id = ?', '13'))
    assert.equal(updatedAt.get(seedId('14')), column('SELECT updated_at FROM album_production WHERE booking_id = ?', '14'))
    assert.equal(updatedAt.get(seedId('17')), column('SELECT updated_at FROM handovers WHERE booking_id = ?', '17'))
    assert.equal(updatedAt.get(seedId('19')), column('SELECT completed_at FROM booking_requests WHERE id = ?', '19'))

    for (const [id, value] of updatedAt) {
      if (value !== null) {
        assert.match(value, CANONICAL_INSTANT, id)
      }
    }
  })

  test('the customer read is still filtered by uid inside the SQL (SB-2)', async () => {
    const database = seededDatabase()
    const db = new D1DatabaseStub(database)

    for (const uid of [tester.uid, 'seed-customer-1', other.uid]) {
      const { records } = await loadCustomerBookingRecords(db, uid)
      const owned = new Set(all(database, 'SELECT id FROM booking_requests WHERE user_id = ?', uid).map(({ id }) => id))

      assert.equal(records.length, owned.size, uid)
      assert.ok(records.every((record) => owned.has(record.id)), uid)
    }

    assert.ok(db.prepared.every((sql) => /WHERE b\.user_id = \?1/.test(sql)))
  })
})

describe('loadJourneyRecordsByBookingIds (admin-only; SB-4)', () => {
  test('reads bookings of any customer by id, with their owner, deduplicated and unknown ids absent', async () => {
    const database = seededDatabase()
    const db = new D1DatabaseStub(database)
    const mine = seedId('03')
    const theirs = seedId('25')
    const { records, skippedCount } = await loadJourneyRecordsByBookingIds({ DB: db }, [
      mine,
      theirs,
      mine,
      'no-such-booking',
      '',
      'x'.repeat(129),
    ])

    assert.equal(skippedCount, 0)
    assert.deepEqual([...records.keys()].sort(), [mine, theirs].sort())
    assert.equal(records.get(mine).userId, tester.uid)
    assert.equal(records.get(theirs).userId, 'seed-customer-1')
    assert.equal(deriveJourneyStage(records.get(mine).journeyFacts).subState, 'deposit_reported')

    // One statement: an IN list of one `?` per distinct bindable id (the
    // unknown id has the shape of one, the empty and the overlong do not)
    // and no id in the SQL text.
    assert.equal(db.prepared.length, 1)
    const [sql] = db.prepared
    assert.match(sql, /WHERE b\.id IN \(\?, \?, \?\)\s*$/)
    assert.equal(sql.includes(mine), false)
    assert.equal(sql.includes('no-such-booking'), false)
  })

  test('the placeholder list grows with the count, up to the 100-id bound; 101 distinct ids are refused before any query', async () => {
    const database = seededDatabase()
    const db = new D1DatabaseStub(database)
    const ids = Array.from({ length: MAXIMUM_JOURNEY_IDS }, (_, index) => `id-${index}`)

    assert.equal(MAXIMUM_JOURNEY_IDS, 100)

    const { records } = await loadJourneyRecordsByBookingIds({ DB: db }, ids)

    assert.equal(records.size, 0)
    assert.equal(db.prepared.length, 1)
    assert.equal((db.prepared[0].match(/\?/g) ?? []).length, MAXIMUM_JOURNEY_IDS)

    await assert.rejects(
      loadJourneyRecordsByBookingIds({ DB: db }, [...ids, 'id-100']),
      RangeError,
    )
    assert.equal(db.prepared.length, 1)
  })

  test('an empty list, or one with nothing bindable, reads nothing', async () => {
    const db = new D1DatabaseStub(seededDatabase())

    assert.deepEqual(await loadJourneyRecordsByBookingIds({ DB: db }, []), { records: new Map(), skippedCount: 0 })
    assert.deepEqual(await loadJourneyRecordsByBookingIds({ DB: db }, ['', 'x'.repeat(129)]), { records: new Map(), skippedCount: 0 })
    assert.equal(db.prepared.length, 0)
  })

  test('no customer-facing module imports the admin-only reader', () => {
    const importers = []

    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)

        if (entry.isDirectory()) {
          walk(path)
        } else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
          const source = readFileSync(path, 'utf8')

          if (/loadJourneyRecordsByBookingIds/.test(source)) {
            importers.push(path.slice(APP_ROOT.length).replaceAll('\\', '/'))
          }
        }
      }
    }

    walk(join(APP_ROOT, 'worker'))
    walk(join(APP_ROOT, 'shared'))
    walk(join(APP_ROOT, 'src'))

    // Admin modules only: the admin dispatcher runs authorizeAdminRequest
    // before any of them; every customer route and the SPA are out.
    const ADMIN_MODULE = /^worker\/(?:admin[^/]*\.ts|portal\/admin-[^/]*\.ts|portal\/slots\/admin-[^/]*\.ts)$/

    for (const importer of importers) {
      if (importer === 'worker/portal/journey-loader.ts') {
        continue
      }

      assert.match(importer, ADMIN_MODULE)
    }
  })
})

// ---------------------------------------------------------------------------
// GET /api/bookings/me (worker/bookings.ts) and its client (src/api/bookings.ts)
// ---------------------------------------------------------------------------

describe('GET /api/bookings/me: the v2 fields and studio (§3.3 #1)', () => {
  test('answers termsAcceptedAt, stageUpdatedAt and the deposit sub-state for the caller\'s own bookings only', async () => {
    const database = seededDatabase()
    const env = workerEnv(database)
    const token = await mintToken(tester)
    const { status, body } = await myBookings(env, token)

    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.match(body.serverTime, CANONICAL_INSTANT)

    const owned = new Set(all(database, 'SELECT id FROM booking_requests WHERE user_id = ?', tester.uid).map(({ id }) => id))
    assert.equal(body.bookings.length, owned.size)
    assert.ok(body.bookings.every((booking) => owned.has(booking.id)))

    const byId = new Map(body.bookings.map((booking) => [booking.id, booking]))
    const reported = byId.get(seedId('03'))
    const awaiting = byId.get(seedId('32'))
    const fresh = byId.get(seedId('02'))
    const pending = byId.get(seedId('01'))

    assert.equal(reported.stageSubState, 'deposit_reported')
    assert.match(reported.termsAcceptedAt, CANONICAL_INSTANT)
    assert.match(reported.stageUpdatedAt, CANONICAL_INSTANT)
    assert.equal(awaiting.stageSubState, 'awaiting_deposit')
    assert.equal(awaiting.stageUpdatedAt, awaiting.termsAcceptedAt)
    assert.equal(fresh.stageSubState, null)
    assert.equal(fresh.termsAcceptedAt, null)
    assert.equal(pending.stage, 'pending_review')
    assert.match(pending.stageUpdatedAt, CANONICAL_INSTANT)

    // The pre-Wave-2 fields are untouched, and each item carries exactly the
    // documented keys.
    assert.deepEqual(
      Object.keys(reported).sort(),
      [
        'confirmedAt', 'createdAt', 'depositAmount', 'estimatedTotal', 'eventDate', 'flowVersion',
        'holdExpiresAt', 'id', 'packageSnapshot', 'stage', 'stageDeadline', 'stageLabel',
        'stageSubState', 'stageUpdatedAt', 'status', 'termsAcceptedAt', 'updatedAt',
      ],
    )
    assert.equal(reported.stageDeadline, reported.holdExpiresAt)
  })

  test('studio is null/null without a contact revision, the number once one is in force, and the change time only after a change within 72 h', async () => {
    const database = seededDatabase()
    const env = workerEnv(database)
    const token = await mintToken(tester)
    const nowMs = Date.now()

    assert.deepEqual((await myBookings(env, token)).body.studio, { whatsappNumber: null, whatsappNumberChangedAt: null })

    // The first revision is not a change (§3.3 #1).
    insertContact(database, '966500000010', nowMs - 10 * 24 * HOUR_MS)
    assert.deepEqual((await myBookings(env, token)).body.studio, { whatsappNumber: '966500000010', whatsappNumberChangedAt: null })

    // A replacing revision saved but not yet in force (TM-03 delay) is never shown.
    insertContact(database, '966500000020', nowMs - HOUR_MS, nowMs + 23 * HOUR_MS)
    assert.deepEqual((await myBookings(env, token)).body.studio, { whatsappNumber: '966500000010', whatsappNumberChangedAt: null })

    // One in force since an hour ago: the new number and when it took over.
    const changedMs = nowMs - 2 * HOUR_MS
    insertContact(database, '966500000030', nowMs - 26 * HOUR_MS, changedMs)
    assert.deepEqual((await myBookings(env, token)).body.studio, { whatsappNumber: '966500000030', whatsappNumberChangedAt: iso(changedMs) })

    // Older than the notice window: the number without a change time. A
    // fresh database, because the TM-03 delay makes revisions take effect
    // in the order they were saved, and the reader (settings-read.ts) shows
    // the latest saved one in force.
    const oldDatabase = seededDatabase()
    const oldEnv = workerEnv(oldDatabase)
    const oldChangeMs = nowMs - (SENSITIVE_CHANGE_NOTICE_HOURS + 1) * HOUR_MS
    insertContact(oldDatabase, '966500000010', oldChangeMs - 10 * 24 * HOUR_MS)
    insertContact(oldDatabase, '966500000040', oldChangeMs - 25 * HOUR_MS, oldChangeMs)
    assert.deepEqual((await myBookings(oldEnv, token)).body.studio, { whatsappNumber: '966500000040', whatsappNumberChangedAt: null })
  })

  test('a customer with no bookings gets an empty list and the same studio object', async () => {
    const database = seededDatabase()
    const env = workerEnv(database)
    const { status, body } = await myBookings(env, await mintToken(other))

    assert.equal(status, 200)
    assert.deepEqual(body.bookings, [])
    assert.deepEqual(body.studio, { whatsappNumber: null, whatsappNumberChangedAt: null })
  })

  test('the SPA parser reads the new shape: deposit sub-state, times and studio', async () => {
    const database = seededDatabase()
    const env = workerEnv(database)
    const changedMs = Date.now() - HOUR_MS

    insertContact(database, '966500000010', Date.now() - 10 * 24 * HOUR_MS)
    insertContact(database, '966500000030', Date.now() - 25 * HOUR_MS, changedMs)

    const { body } = await myBookings(env, await mintToken(tester))
    const receivedAtMs = Date.now()
    const parsed = parseMyBookingsBody(body, receivedAtMs)

    assert.notEqual(parsed, null)
    assert.equal(parsed.partialError, null)
    assert.deepEqual(parsed.response.studio, { whatsappNumber: '966500000030', whatsappNumberChangedAt: iso(changedMs) })

    const byId = new Map(parsed.response.bookings.map((booking) => [booking.id, booking]))
    const reported = byId.get(seedId('03'))
    const missed = byId.get(seedId('33'))

    assert.equal(reported.stage, 'approved_hold')
    assert.equal(reported.depositSubState, 'deposit_reported')
    assert.equal(reported.stageSubState, null)
    assert.equal(reported.termsAcceptedAt, body.bookings.find((booking) => booking.id === reported.id).termsAcceptedAt)
    assert.match(reported.stageUpdatedAt, CANONICAL_INSTANT)
    assert.equal(byId.get(seedId('32')).depositSubState, 'awaiting_deposit')
    // A tracker sub-state still lands where the tracker reads it.
    assert.equal(missed.stageSubState, 'handover_missed')
    assert.equal(missed.depositSubState, null)
  })

  test('the SPA parser reads the old shape (no studio, no v2 fields) as nulls, and refuses bad values', () => {
    const receivedAtMs = Date.now()
    const item = {
      id: 'b-1',
      eventDate: '2026-12-01',
      status: 'approved_hold',
      estimatedTotal: 1600,
      packageSnapshot: null,
      holdExpiresAt: T.hold,
      confirmedAt: null,
      createdAt: T.created,
      updatedAt: T.approved,
      flowVersion: 2,
      stage: 'approved_hold',
      stageLabel: 'x',
      stageSubState: 'deposit_reported',
      stageDeadline: T.hold,
      depositAmount: 320,
    }
    const old = parseMyBookingsBody({ ok: true, bookings: [item], serverTime: T.approved }, receivedAtMs)

    assert.equal(old.response.studio, null)
    assert.equal(old.response.bookings[0].depositSubState, 'deposit_reported')
    assert.equal(old.response.bookings[0].stageSubState, null)
    assert.equal(old.response.bookings[0].termsAcceptedAt, null)
    assert.equal(old.response.bookings[0].stageUpdatedAt, null)

    const odd = parseMyBookingsBody(
      {
        ok: true,
        bookings: [
          { ...item, stage: 'confirmed', stageSubState: 'deposit_reported', stageUpdatedAt: '2026-09-02 09:00:00', termsAcceptedAt: 7 },
        ],
        serverTime: T.approved,
        studio: { whatsappNumber: '0505647418', whatsappNumberChangedAt: 'yesterday' },
      },
      receivedAtMs,
    )

    // A deposit sub-state outside stage 2, a local-time instant, a number that
    // is not E.164 digits and a non-instant change time all read as none.
    assert.equal(odd.response.bookings[0].depositSubState, null)
    assert.equal(odd.response.bookings[0].stageUpdatedAt, null)
    assert.equal(odd.response.bookings[0].termsAcceptedAt, null)
    assert.deepEqual(odd.response.studio, { whatsappNumber: null, whatsappNumberChangedAt: null })
    assert.equal(parseMyBookingsBody({ ok: true, bookings: [], studio: 'none' }, receivedAtMs).response.studio, null)
  })
})

describe('POST /api/bookings open-request cap: the plan\'s wire code (W1 carry-over)', () => {
  const selection = {
    coverageId: 'four-hours',
    albumEnabled: false,
    albumSizeId: null,
    photoCount: null,
    albumPageCount: null,
    albumBoxId: null,
    printQuantities: { a6: 0, a5: 0, a4: 0 },
    magazineQuantity: 0,
    magazinePageCount: 1,
    woodenEnlargementQuantity: 0,
  }

  async function submitAgainst(code) {
    const jwksFetch = globalThis.fetch

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: { code, message: 'x' } }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })

    try {
      return await createBookingRequest('w216-client-token', '2026-12-01', selection)
    } finally {
      globalThis.fetch = jwksFetch
    }
  }

  test('the booking form reads OPEN_REQUEST_LIMIT, and a Wave 0 Worker\'s TOO_MANY_OPEN_REQUESTS, as the one cap code', async () => {
    assert.deepEqual(await submitAgainst('OPEN_REQUEST_LIMIT'), { ok: false, error: { code: 'TOO_MANY_OPEN_REQUESTS' } })
    assert.deepEqual(await submitAgainst('TOO_MANY_OPEN_REQUESTS'), { ok: false, error: { code: 'TOO_MANY_OPEN_REQUESTS' } })
    assert.deepEqual(await submitAgainst('SOMETHING_ELSE'), { ok: false, error: { code: 'MALFORMED_RESPONSE' } })
  })

  test('the Worker no longer names the Wave 0 code anywhere', () => {
    const worker = readFileSync(join(APP_ROOT, 'worker', 'bookings.ts'), 'utf8')

    assert.equal(worker.includes("'TOO_MANY_OPEN_REQUESTS'"), false)
    assert.match(worker, /openRequestLimitResponse\(\)/)
  })
})
