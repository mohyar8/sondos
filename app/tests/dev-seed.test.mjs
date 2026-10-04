// W1-01 / SB-4, SB-8, SB-10: the local development seed (plan 11 §6.2).
// scripts/dev-seed.sql is applied with node:sqlite to every migration in the
// repository (0001, 0003–0009 today) inside one transaction, as wrangler runs
// a file, and read back through the Worker's own journey loader and
// deriveJourneyStage. scripts/seed-local.mjs is started only with arguments
// or environments it must refuse, so wrangler never runs and nothing leaves
// this machine. Every case fails if its control is taken out of the seed or
// the script: one booking per stage, the notice-protected hold, every admin
// queue section and /me sub-state the later runtime checks name (plan 11
// §6.3: W2-10, W2-16), the marker and its CHECKs, the run-once rule, the
// no-settings/no-admin rule, the --local-only argument and environment checks.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateBookingSelection } from '../shared/booking.ts'
import { deriveJourneyStage, journeyStageIds } from '../shared/journey.ts'
import { loadCustomerBookingRecords } from '../worker/portal/journey-loader.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const MIGRATIONS = join(APP_ROOT, 'migrations')
const SEED_SQL = readFileSync(join(APP_ROOT, 'scripts', 'dev-seed.sql'), 'utf8')
const SEED_SCRIPT = join(APP_ROOT, 'scripts', 'seed-local.mjs')
const PLACEHOLDER = '{{CUSTOMER_UID}}'
const TESTER = 'TesterUid0001'
const BOOKING_PREFIX = '5eedb00c-0000-4000-8000-0000000000'

function sqlValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

/** Every migration in wrangler's order: the seed must keep applying as the schema grows. */
function openMigrated() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, name), 'utf8'))
  }

  return db
}

/** The seed for `uid`, as seed-local.mjs renders it (exactly one placeholder). */
function renderSeed(uid) {
  const parts = SEED_SQL.split(PLACEHOLDER)
  assert.equal(parts.length, 2, 'dev-seed.sql holds the uid placeholder exactly once')

  return parts.join(uid)
}

/** Applies the seed in one transaction; a failing statement rolls it all back. */
function applySeed(db, uid = TESTER) {
  const sql = renderSeed(uid)
  let committed = false

  db.exec('BEGIN')

  try {
    db.exec(sql)
    db.exec('COMMIT')
    committed = true
  } finally {
    if (!committed) {
      db.exec('ROLLBACK')
    }
  }
}

function all(db, sql, ...params) {
  return db.prepare(sql).all(...params.map(sqlValue)).map((row) => ({ ...row }))
}

function scalar(db, sql, ...params) {
  const row = db.prepare(sql).get(...params.map(sqlValue))

  return row === undefined ? undefined : Object.values(row)[0]
}

function tableCounts(db) {
  return Object.fromEntries(
    all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name").map(
      ({ name }) => [name, scalar(db, `SELECT COUNT(*) FROM "${name}"`)],
    ),
  )
}

/** The part of D1 the journey loader uses, over node:sqlite. */
function d1(db) {
  return {
    prepare(sql) {
      const statement = (params) => ({
        bind: (...next) => statement(next),
        all: async () => ({ success: true, results: all(db, sql, ...params), meta: {} }),
      })

      return statement([])
    },
  }
}

function seeded(uid = TESTER) {
  const db = openMigrated()
  applySeed(db, uid)

  return db
}

// Journey stage (and sub-state) each tester booking must derive (plan 11 §6.2).
const EXPECTED_STAGES = {
  '01': ['pending_review', null],
  '02': ['approved_hold', null],
  '03': ['approved_hold', 'deposit_reported'],
  '04': ['approved_hold', 'deposit_reported'],
  '05': ['approved_hold', null],
  '06': [null, 'terminal_status'],
  '07': ['receipt_review', null],
  '08': ['terms_and_receipt_pending', 'receipt_rejected'],
  '09': ['confirmed', null],
  '10': ['pre_event_engagement', null],
  '11': ['pre_event_engagement', 'awaiting_previews'],
  '12': ['gallery_open', null],
  '13': ['gallery_locked', null],
  '14': ['album_design', null],
  '15': ['album_printing', null],
  '16': ['album_ready', null],
  '17': ['handover_scheduling', null],
  '18': ['handover_day', null],
  '19': ['completed_feedback', null],
  '20': ['completed_feedback', null],
  '21': ['privacy_cleanup', null],
  '22': [null, 'legacy_status'],
  '23': [null, 'terminal_status'],
  '24': [null, 'terminal_status'],
  // Fix round 1: states the admin queue and /me name (awaiting_deposit is a /me sub-state, W2-16).
  '32': ['approved_hold', 'awaiting_deposit'],
  '33': ['handover_scheduling', 'handover_missed'],
  '34': ['gallery_open', null],
}

// Plan 11 §3.3 #35 queue sections in their fixed order, each as the plan words it, over the seeded rows
// (?1, where used, = now as an ISO instant). bank_mismatch needs a bank revision, which the seed never writes.
const QUEUE_SECTIONS = [
  ['decide_now', `SELECT b.id FROM booking_requests AS b
    WHERE b.flow_version = 2 AND b.status = 'approved_hold' AND b.hold_expires_at <= ?1`],
  ['holds_expiring', `SELECT b.id FROM booking_requests AS b
    WHERE b.flow_version = 2 AND b.status = 'approved_hold'
      AND b.hold_expires_at > ?1 AND b.hold_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '+24 hours')`],
  ['deposit_notices', `SELECT b.id FROM booking_requests AS b
    WHERE b.flow_version = 2 AND b.status = 'approved_hold' AND EXISTS (
      SELECT 1 FROM booking_events AS e WHERE e.booking_id = b.id AND e.event = 'deposit_notice_sent'
        AND json_extract(e.details, '$.holdExpiresAt') = b.hold_expires_at)`],
  ['requests_over_sla', `SELECT b.id FROM booking_requests AS b
    WHERE b.status = 'pending_review' AND b.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '-24 hours')`],
  ['events_today_tomorrow', `SELECT b.id FROM booking_requests AS b
    WHERE b.status = 'confirmed' AND b.event_date BETWEEN date(?1, '+3 hours') AND date(?1, '+3 hours', '+1 days')`],
  ['handovers_today_tomorrow', `SELECT h.booking_id AS id FROM handovers AS h
    INNER JOIN handover_slots AS s ON s.id = h.slot_id
    WHERE h.status = 'scheduled' AND date(s.starts_at, '+3 hours') BETWEEN date(?1, '+3 hours') AND date(?1, '+3 hours', '+1 days')`],
  ['terms_pending', `SELECT b.id FROM booking_requests AS b
    WHERE b.flow_version = 2 AND b.status = 'approved_hold' AND b.terms_accepted_at IS NULL AND EXISTS (
      SELECT 1 FROM booking_status_history AS h WHERE h.booking_id = b.id AND h.to_status = 'approved_hold'
        AND h.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '-12 hours'))`],
  ['receipts_pending', `SELECT r.booking_id AS id FROM booking_receipts AS r
    WHERE r.status = 'pending'`],
  ['events_soon_without_details', `SELECT b.id FROM booking_requests AS b
    WHERE b.status = 'confirmed' AND b.event_date BETWEEN date(?1, '+3 hours') AND date(?1, '+3 hours', '+7 days')
      AND NOT EXISTS (SELECT 1 FROM event_profiles AS p WHERE p.booking_id = b.id)`],
  ['awaiting_production', `SELECT b.id FROM booking_requests AS b
    INNER JOIN galleries AS g ON g.booking_id = b.id
    WHERE b.status = 'confirmed' AND g.status = 'locked'
      AND NOT EXISTS (SELECT 1 FROM album_production AS a WHERE a.booking_id = b.id)`],
  ['selection_overdue', `SELECT g.booking_id AS id FROM galleries AS g
    WHERE g.status = 'open' AND g.submitted_at IS NULL AND g.selection_deadline < ?1`],
  ['ready_without_handover', `SELECT a.booking_id AS id FROM album_production AS a
    WHERE a.stage = 'ready' AND NOT EXISTS (
      SELECT 1 FROM handovers AS h WHERE h.booking_id = a.booking_id AND h.status <> 'cancelled')`],
  ['handover_no_show', `SELECT h.booking_id AS id FROM handovers AS h WHERE h.status = 'no_show'`],
  ['feedback_due', `SELECT b.id FROM booking_requests AS b
    WHERE b.completed_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '-2 days')
      AND NOT EXISTS (SELECT 1 FROM feedback AS f WHERE f.booking_id = b.id)`],
]

const EXPECTED_QUEUE = {
  decide_now: ['04', '05'],
  holds_expiring: ['02'],
  deposit_notices: ['03', '04'],
  requests_over_sla: ['01'],
  events_today_tomorrow: ['35'],
  handovers_today_tomorrow: ['17', '18', '31'],
  terms_pending: ['02', '05'],
  receipts_pending: ['07'],
  events_soon_without_details: ['36'],
  awaiting_production: ['13'],
  selection_overdue: ['34'],
  ready_without_handover: ['16'],
  handover_no_show: ['33'],
  feedback_due: ['20', '21'],
}

describe('scripts/dev-seed.sql on every migration', () => {
  test('applies once, keeps the marker and drops its plan table', () => {
    const db = seeded()
    assert.deepEqual(all(db, 'SELECT id, customer_uid FROM _dev_seed_marker'), [{ id: 1, customer_uid: TESTER }])
    assert.equal(scalar(db, "SELECT COUNT(*) FROM sqlite_master WHERE name = '_dev_seed_plan'"), 0)
  })

  test('a second run fails on the marker and changes nothing', () => {
    const db = seeded()
    const before = tableCounts(db)
    assert.throws(() => applySeed(db), /_dev_seed_marker already exists/)
    assert.deepEqual(tableCounts(db), before)
  })

  test('the marker refuses an admin\'s uid, an erased row\'s uid or a uid outside [A-Za-z0-9]{1,128}, and the whole file rolls back', () => {
    const db = openMigrated()
    db.prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at, erased_at)
       VALUES (?, ?, 'اسم', 'تجريبي', '+447700900990', ?, ?, ?)`,
    ).run('AdminUid0001', 'admin@example.test', 'admin', new Date().toISOString(), null)
    db.prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, erased_at)
       VALUES (?, ?, 'اسم', 'تجريبي', '+447700900991', 'customer', ?)`,
    ).run('ErasedUid0001', 'erased@example.test', new Date().toISOString())
    const before = tableCounts(db)

    for (const uid of ['AdminUid0001', 'ErasedUid0001', 'seed-uid', 'a'.repeat(129)]) {
      assert.throws(() => applySeed(db, uid), /CHECK constraint failed/, uid.slice(0, 20))
      assert.deepEqual(tableCounts(db), before, uid.slice(0, 20))
    }
  })

  test('the tester gets one booking per journey stage, each on its own date', async () => {
    const db = seeded()
    const now = new Date()
    const { records, skippedCount } = await loadCustomerBookingRecords(d1(db), TESTER)
    assert.equal(skippedCount, 0)
    assert.equal(records.length, Object.keys(EXPECTED_STAGES).length)

    const derived = Object.fromEntries(
      records.map((record) => {
        const result = deriveJourneyStage(record.journeyFacts, now)
        return [record.id.slice(BOOKING_PREFIX.length), [result.stage, result.stage === null ? result.reason : result.subState]]
      }),
    )
    assert.deepEqual(derived, EXPECTED_STAGES)

    const stages = new Set(Object.values(derived).map(([stage]) => stage).filter((stage) => stage !== null))
    assert.deepEqual([...stages].sort(), [...journeyStageIds].sort())
    assert.equal(scalar(db, 'SELECT COUNT(DISTINCT event_date) FROM booking_requests'), scalar(db, 'SELECT COUNT(*) FROM booking_requests'))
  })

  test('one overdue flow-2 hold is protected by a notice for its current deadline; one is not (B1, N-50)', () => {
    const db = seeded()
    const now = new Date().toISOString()
    const overdue = (protectedHold) => all(
      db,
      `SELECT b.id FROM booking_requests AS b
       WHERE b.user_id = ?1 AND b.flow_version = 2 AND b.status = 'approved_hold' AND b.hold_expires_at <= ?2
         AND ?3 = EXISTS (
           SELECT 1 FROM booking_events AS e
           WHERE e.booking_id = b.id AND e.event = 'deposit_notice_sent'
             AND json_extract(e.details, '$.holdExpiresAt') = b.hold_expires_at
         )`,
      TESTER, now, protectedHold ? 1 : 0,
    ).map((row) => row.id.slice(BOOKING_PREFIX.length))
    assert.deepEqual(overdue(true), ['04'])
    assert.deepEqual(overdue(false), ['05'])
  })

  test('reaches every admin queue section of #35 in the fixed order except bank_mismatch (W2-10)', () => {
    const db = seeded()
    const now = new Date().toISOString()
    const reached = Object.fromEntries(
      QUEUE_SECTIONS.map(([section, sql]) => [
        section,
        all(db, sql, ...(sql.includes('?1') ? [now] : [])).map((row) => row.id.slice(BOOKING_PREFIX.length)).sort(),
      ]),
    )
    assert.deepEqual(reached, EXPECTED_QUEUE)
    assert.deepEqual(
      QUEUE_SECTIONS.map(([section]) => section).filter((section) => reached[section].length > 0),
      ['decide_now', 'holds_expiring', 'deposit_notices', 'requests_over_sla', 'events_today_tomorrow',
        'handovers_today_tomorrow', 'terms_pending', 'receipts_pending', 'events_soon_without_details',
        'awaiting_production', 'selection_overdue', 'ready_without_handover', 'handover_no_show', 'feedback_due'],
    )
    // The event today carries the admin-only startTime and venueArea.
    assert.deepEqual(
      all(db, "SELECT event_start_time, venue_area FROM event_profiles WHERE booking_id = ?", `${BOOKING_PREFIX}35`),
      [{ event_start_time: '21:00', venue_area: 'الرياض' }],
    )
  })

  test('the tester reaches the /me sub-states awaiting_deposit and deposit_reported (W2-16) and handover_missed', async () => {
    const db = seeded()
    const now = new Date().toISOString()
    // Plan 11 §3.3 #1: flow 2, approved_hold, terms accepted; deposit_reported when a notice quotes the current
    // deadline, awaiting_deposit when none does.
    const holds = (reported) => all(
      db,
      `SELECT b.id FROM booking_requests AS b
       WHERE b.user_id = ?1 AND b.flow_version = 2 AND b.status = 'approved_hold' AND b.terms_accepted_at IS NOT NULL
         AND ?2 = EXISTS (
           SELECT 1 FROM booking_events AS e WHERE e.booking_id = b.id AND e.event = 'deposit_notice_sent'
             AND json_extract(e.details, '$.holdExpiresAt') = b.hold_expires_at)
       ORDER BY b.id`,
      TESTER, reported ? 1 : 0,
    ).map((row) => row.id.slice(BOOKING_PREFIX.length))
    assert.deepEqual(holds(false), ['32'])
    assert.deepEqual(holds(true), ['03', '04'])
    assert.ok(scalar(db, 'SELECT hold_expires_at FROM booking_requests WHERE id = ?', `${BOOKING_PREFIX}32`) > now)

    const { records } = await loadCustomerBookingRecords(d1(db), TESTER)
    const missed = records.filter((record) => deriveJourneyStage(record.journeyFacts, new Date()).subState === 'handover_missed')
    assert.deepEqual(missed.map((record) => record.id.slice(BOOKING_PREFIX.length)), ['33'])
    assert.ok(scalar(db, "SELECT s.ends_at FROM handovers AS h INNER JOIN handover_slots AS s ON s.id = h.slot_id WHERE h.status = 'no_show'") < now)
  })

  test('six fake customers who cannot sign in, one with a contact change after her booking (TM-08)', () => {
    const db = seeded()
    const customers = all(db, "SELECT id, email, phone, role, email_verified_at FROM users WHERE id <> ? ORDER BY id", TESTER)
    assert.deepEqual(customers.map((row) => row.id), [1, 2, 3, 4, 5, 6].map((n) => `seed-customer-${n}`))
    for (const customer of customers) {
      assert.match(customer.email, /^seed-customer-\d@example\.test$/)
      assert.match(customer.phone, /^\+447700900\d{3}$/)
      assert.equal(customer.role, 'customer')
    }
    assert.deepEqual(
      all(db, `SELECT DISTINCT u.id FROM users AS u INNER JOIN booking_requests AS b ON b.user_id = u.id
               WHERE u.contact_changed_at > b.created_at`).map((row) => row.id),
      ['seed-customer-3'],
    )
    const riyadhToday = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10)
    const upcoming = all(db, "SELECT event_date FROM booking_requests WHERE user_id GLOB 'seed-customer-*' AND event_date > ?", riyadhToday)
    assert.equal(upcoming.length, 7)
    const latest = new Date(Date.parse(`${riyadhToday}T00:00:00Z`) + 62 * 86_400_000).toISOString().slice(0, 10)
    assert.ok(upcoming.every((row) => row.event_date <= latest))
  })

  test('writes no settings, bank details, terms, switch, audit rows or admin', () => {
    const db = seeded()
    const counts = tableCounts(db)
    for (const table of ['settings_revisions', 'terms_versions', 'ops_switch_revisions', 'admin_audit_log', 'csp_report_counts']) {
      assert.equal(counts[table], 0, table)
    }
    assert.equal(scalar(db, "SELECT COUNT(*) FROM users WHERE role = 'admin'"), 0)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM booking_requests WHERE bank_revision_id IS NOT NULL OR deposit_rule_revision_id IS NOT NULL'), 0)
    assert.doesNotMatch(SEED_SQL, /INSERT INTO (?:settings_revisions|terms_versions|ops_switch_revisions|admin_audit_log)\b/)
  })

  test('3 blocked dates away from every booking, 2 delivery areas, 11 slots, handovers within capacity', () => {
    const db = seeded()
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM blocked_dates'), 3)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM blocked_dates WHERE event_date IN (SELECT event_date FROM booking_requests)'), 0)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM delivery_areas'), 2)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM handover_slots'), 11)
    assert.equal(
      scalar(db, `SELECT COUNT(*) FROM handover_slots AS s
                  WHERE (SELECT COUNT(*) FROM handovers AS h WHERE h.slot_id = s.id AND h.status = 'scheduled') > s.capacity`),
      0,
    )
    assert.deepEqual(
      all(db, "SELECT h.delivery_city, h.delivery_fee FROM handovers AS h INNER JOIN delivery_areas AS a ON a.id = h.delivery_area_id")
        .map((row) => [row.delivery_city, row.delivery_fee]),
      [[scalar(db, "SELECT name FROM delivery_areas WHERE sort_order = 1"), 0]],
    )
  })

  test('keeps an existing tester row as it is and creates an unproven placeholder only when she has none', () => {
    const fresh = seeded()
    assert.deepEqual(
      all(fresh, 'SELECT email, email_verified_at, role FROM users WHERE id = ?', TESTER),
      [{ email: 'seed-tester@example.test', email_verified_at: null, role: 'customer' }],
    )

    const db = openMigrated()
    const verifiedAt = new Date().toISOString()
    db.prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
       VALUES (?, 'tester@example.test', 'سارة', 'تجريبية', '+966500000001', 'customer', ?)`,
    ).run(TESTER, verifiedAt)
    applySeed(db)
    assert.deepEqual(
      all(db, 'SELECT email, first_name, phone, email_verified_at FROM users WHERE id = ?', TESTER),
      [{ email: 'tester@example.test', first_name: 'سارة', phone: '+966500000001', email_verified_at: verifiedAt }],
    )
  })

  test('every package snapshot is the catalogue\'s own output (no invented prices)', () => {
    const db = seeded()
    const none = { a6: 0, a5: 0, a4: 0 }
    const selection = (overrides) => ({
      coverageId: 'four-hours', albumEnabled: true, albumSizeId: 'medium', photoCount: 45, albumPageCount: 15,
      albumBoxId: 'normal', printQuantities: none, magazineQuantity: 0, magazinePageCount: 1, woodenEnlargementQuantity: 0,
      ...overrides,
    })
    const expected = [
      selection({}),
      selection({ coverageId: 'two-hours', albumEnabled: false, photoCount: 30, albumPageCount: 10 }),
      selection({ coverageId: 'six-hours', albumSizeId: 'large', photoCount: 60, albumPageCount: 20, albumBoxId: 'vip', printQuantities: { a6: 0, a5: 10, a4: 2 } }),
      selection({ coverageId: 'eight-hours', albumSizeId: 'large', photoCount: 80, albumPageCount: 20, woodenEnlargementQuantity: 1 }),
    ].map((value) => {
      const result = validateBookingSelection(value)
      assert.ok(result.ok)
      return JSON.stringify(result.snapshot)
    })
    const stored = all(db, 'SELECT DISTINCT package_snapshot FROM booking_requests').map((row) => row.package_snapshot)
    assert.deepEqual(stored.sort(), [...expected].sort())
    assert.equal(
      scalar(db, "SELECT COUNT(*) FROM booking_requests WHERE estimated_total <> json_extract(package_snapshot, '$.estimatedTotal')"),
      0,
    )
  })
})

describe('scripts/seed-local.mjs refuses before wrangler runs', () => {
  const refusals = [
    ['--remote', ['--customer-uid', TESTER, '--remote']],
    ['--env preview', ['--customer-uid', TESTER, '--env', 'preview']],
    ['--env=production', ['--customer-uid', TESTER, '--env=production']],
    ['--preview', ['--customer-uid', TESTER, '--preview']],
    ['an unknown option', ['--customer-uid', TESTER, '--config', 'wrangler.jsonc']],
    ['a positional argument', [TESTER]],
    ['a missing uid', []],
    ['a uid with a quote', ['--customer-uid', "Tester'Uid"]],
    ['a uid with a dash', ['--customer-uid', 'seed-uid']],
    ['a 129-character uid', ['--customer-uid', 'a'.repeat(129)]],
    ['a repeated uid', ['--customer-uid', TESTER, '--customer-uid=Other1']],
    ['a --persist-to value that is a flag', ['--customer-uid', TESTER, '--persist-to', '-e']],
  ]

  const runScript = (args, environment) => spawnSync(process.execPath, [SEED_SCRIPT, ...args], {
    cwd: APP_ROOT,
    encoding: 'utf8',
    env: { ...environment, WRANGLER_SEND_METRICS: 'false' },
    shell: false,
    timeout: 30_000,
  })

  const baseEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'CLOUDFLARE_ENV'))

  for (const [name, args] of refusals) {
    test(`refuses ${name}`, () => {
      const folder = mkdtempSync(join(tmpdir(), 'sundus-seed-test-'))

      try {
        const hasPersist = args.some((arg) => arg.startsWith('--persist-to'))
        const result = runScript(hasPersist ? args : [...args, `--persist-to=${folder}`], baseEnvironment)
        assert.equal(result.status, 2, result.stderr)
        assert.match(result.stderr, /Usage: node scripts\/seed-local\.mjs --customer-uid/)
        assert.equal(result.stdout, '')
        assert.deepEqual(readdirSync(folder), [])
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    })
  }

  for (const environmentName of ['production', 'preview']) {
    test(`refuses CLOUDFLARE_ENV=${environmentName}`, () => {
      const folder = mkdtempSync(join(tmpdir(), 'sundus-seed-test-'))

      try {
        const result = runScript(
          ['--customer-uid', TESTER, `--persist-to=${folder}`],
          { ...baseEnvironment, CLOUDFLARE_ENV: environmentName },
        )
        assert.equal(result.status, 2, result.stderr)
        assert.match(result.stderr, /CLOUDFLARE_ENV="[a-z]+" is not accepted/)
        assert.deepEqual(readdirSync(folder), [])
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    })
  }

  test('hard-codes --local and never passes --remote or --env to wrangler', () => {
    const source = readFileSync(SEED_SCRIPT, 'utf8')
    assert.match(source, /'d1', 'execute', 'DB', '--local', '--json'/)
    assert.match(source, /^import \{ spawnSync \} from 'node:child_process'$/m)
    assert.match(source, /spawnSync\(process\.execPath, args,/)
    assert.doesNotMatch(source, /'--remote'|'--env'|'-e'|shell:/)
  })
})
