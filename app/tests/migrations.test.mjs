// W1-01 / SB-4, SB-5, SB-10, SB-14, L2, TM-03, TM-07, H3: migrations
// 0008_golive_admin_settings.sql and 0009_golive_hardening.sql (plan 11 §2.2
// and §2.4, drafted there as 0007 and 0008). Re-runs the 56 checks of §2.3 and
// the 42 checks of §2.5 against the repository's own files, applied in
// wrangler's order (0001, 0003–0009) with foreign keys on, as in D1, plus the
// plan's runtime statements of §2.3 and the 0009 section-7 guards against
// INSERT OR REPLACE (fix round 1). Every check fails if the CHECK, index,
// foreign key or trigger it names is taken out of a migration.
//
// Binding note: D1 binds a whole JavaScript number as INTEGER, node:sqlite
// binds every number as REAL, so the helpers below bind safe integers as
// BigInt. A REAL is only ever bound on purpose (the typeof() checks).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const SETTINGS_MIGRATION = '0008_golive_admin_settings.sql'
const HARDENING_MIGRATION = '0009_golive_hardening.sql'

const CHECK = /CHECK constraint failed/
const UNIQUE = /UNIQUE constraint failed/
const FOREIGN_KEY = /FOREIGN KEY constraint failed/

const ADMIN = 'AdminUid0001'
const BRIDE = 'BrideUid0001'
const OTHER_BRIDE = 'BrideUid0002'
const IBAN = 'SA0000000000000000000001'

/** Fixed clock for bound instants: 2026-10-01 09:00 UTC (12:00 Riyadh). */
const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const MINUTE_MS = 60 * 1000

/** The instant `minutes` after T0 as a toISOString() string. */
function at(minutes) {
  return new Date(T0 + minutes * MINUTE_MS).toISOString()
}

/** 10 minutes 1 second before T0: just outside the re-auth window (N-10). */
const STALE_REAUTH = new Date(T0 - 601 * 1000).toISOString()

/** The instant `minutes` after the real clock (for SQL-stamped created_at). */
function fromNow(minutes) {
  return new Date(Date.now() + minutes * MINUTE_MS).toISOString()
}

function uuid(prefix, n) {
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/** The repository's migration files in wrangler's order. */
function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
}

function migrationText(name) {
  return readFileSync(new URL(name, MIGRATIONS), 'utf8')
}

/** A fresh database with every migration up to and including `through`. */
function openDatabase(through = HARDENING_MIGRATION) {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of migrationFiles()) {
    if (name > through) {
      break
    }

    db.exec(migrationText(name))
  }

  return db
}

function sqlValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

function run(db, sql, ...params) {
  const info = db.prepare(sql).run(...params.map(sqlValue))

  return Number(info.changes)
}

function get(db, sql, ...params) {
  return db.prepare(sql).get(...params.map(sqlValue))
}

function all(db, sql, ...params) {
  return db.prepare(sql).all(...params.map(sqlValue))
}

function scalar(db, sql, ...params) {
  const row = get(db, sql, ...params)

  return row === undefined ? undefined : Object.values(row)[0]
}

/** INSERT of one row; the column names are the test's own constant keys. */
function insertRow(db, table, row) {
  const columns = Object.keys(row)
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`

  return run(db, sql, ...Object.values(row))
}

function schemaCounts(db) {
  const count = (type) =>
    scalar(
      db,
      "SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND substr(name, 1, 7) <> 'sqlite_'",
      type,
    )

  return { tables: count('table'), indexes: count('index'), triggers: count('trigger') }
}

function names(db, type) {
  return all(db, "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name", type).map((row) => row.name)
}

function addUser(db, id, role = 'customer', extra = {}) {
  insertRow(db, 'users', {
    id,
    email: `${id.toLowerCase()}@example.test`,
    first_name: 'اسم',
    last_name: 'تجريبي',
    phone: '+447700900000',
    role,
    email_verified_at: at(-100_000),
    ...extra,
  })
}

/** A booking plus the status-history row every booking has from its creation. */
function addBooking(db, id, options = {}) {
  const {
    userId = BRIDE,
    eventDate = '2026-12-01',
    status = 'pending_review',
    total = 4000,
    flow = 1,
    hold = null,
    deposit = null,
    createdAt = at(-600),
    termsVersion = null,
    termsAcceptedAt = null,
  } = options

  insertRow(db, 'booking_requests', {
    id,
    user_id: userId,
    event_date: eventDate,
    status,
    package_snapshot: '{}',
    estimated_total: total,
    hold_expires_at: hold,
    created_at: createdAt,
    updated_at: createdAt,
    flow_version: flow,
    deposit_amount: deposit,
    terms_version: termsVersion,
    terms_accepted_at: termsAcceptedAt,
  })
  insertRow(db, 'booking_status_history', {
    booking_id: id,
    from_status: null,
    to_status: 'pending_review',
    changed_by: userId,
    note: null,
    created_at: createdAt,
  })
}

/** A flow-2 hold on `eventDate`, deadline `hold`. */
function addHold(db, id, eventDate, hold, options = {}) {
  addBooking(db, id, { eventDate, status: 'approved_hold', flow: 2, hold, deposit: 1000, ...options })
}

function addEvent(db, bookingId, event, extra = {}) {
  insertRow(db, 'booking_events', {
    booking_id: bookingId,
    actor: 'customer',
    actor_uid: null,
    event,
    subject_id: null,
    details: null,
    note: null,
    created_at: at(-10),
    ...extra,
  })

  return Number(scalar(db, 'SELECT MAX(id) FROM booking_events'))
}

/** One admin and two customers, all with a proven address. */
function fixture(through = HARDENING_MIGRATION) {
  const db = openDatabase(through)
  addUser(db, ADMIN, 'admin')
  addUser(db, BRIDE)
  addUser(db, OTHER_BRIDE)

  return db
}

const REVISION_FIELDS = {
  deposit: { section: 'deposit', deposit_kind: 'fixed', deposit_fixed_amount: 500, deposit_round_to: 1 },
  bank: { section: 'bank', bank_name: 'مصرف تجريبي', bank_account_holder: 'حساب تجريبي', bank_iban: IBAN },
  contact: { section: 'contact', whatsapp_number: '966500000000' },
  pickup: { section: 'pickup', pickup_address: 'عنوان تجريبي للاستلام' },
}

/** A valid revision row of `section`, saved at T0 with a 2-minute-old sign-in. */
function revision(section, overrides = {}) {
  return {
    ...REVISION_FIELDS[section],
    created_by: ADMIN,
    reauth_at: section === 'pickup' ? null : at(-2),
    created_at: at(0),
    ...overrides,
  }
}

function addRevision(db, section, overrides = {}) {
  insertRow(db, 'settings_revisions', revision(section, overrides))

  return Number(scalar(db, 'SELECT MAX(id) FROM settings_revisions'))
}

const TERMS_BODY = 'شروط الحجز التجريبية لبيئة الاختبار فقط، وليست نصًا قانونيًا معتمدًا. '.repeat(2)

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// Publishing = inserting the next version in one statement (plan 11 §2.2 §4),
// with created_at stamped by SQL (review M1).
const PUBLISH_TERMS_SQL = `
  INSERT INTO terms_versions (version, seq, body, body_sha256, change_summary, created_by, reauth_at, created_at)
  SELECT 'v' || (COALESCE(MAX(seq), 0) + 1), COALESCE(MAX(seq), 0) + 1, ?1, ?2, NULL, ?3, ?4,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM terms_versions`

function publishTerms(db, body = TERMS_BODY) {
  return run(db, PUBLISH_TERMS_SQL, body, sha256(body), ADMIN, fromNow(-1))
}

function addAudit(db, overrides = {}) {
  return insertRow(db, 'admin_audit_log', {
    actor_uid: ADMIN,
    action: 'settings_pickup_updated',
    target_id: null,
    details: null,
    reauth_at: null,
    created_at: at(0),
    ...overrides,
  })
}

function addSlot(db, n, options = {}) {
  const { startsAt = at(3 * 24 * 60 + n * 60), method = 'both', capacity = 1 } = options
  const id = uuid('5107a000', n)

  insertRow(db, 'handover_slots', {
    id,
    starts_at: startsAt,
    ends_at: new Date(Date.parse(startsAt) + 60 * MINUTE_MS).toISOString(),
    method,
    capacity,
    is_active: 1,
    created_at: at(-1000),
    updated_at: at(-1000),
  })

  return id
}

function addArea(db, n, fee = 25) {
  const id = uuid('aea0a000', n)

  insertRow(db, 'delivery_areas', {
    id,
    name: `منطقة ${n}`,
    fee,
    is_active: 1,
    sort_order: n,
    created_at: at(-1000),
    updated_at: at(-1000),
  })

  return id
}

function addHandover(db, bookingId, slotId, overrides = {}) {
  return insertRow(db, 'handovers', {
    booking_id: bookingId,
    slot_id: slotId,
    method: 'pickup',
    status: 'scheduled',
    created_at: at(-5),
    updated_at: at(-5),
    ...overrides,
  })
}

/** A confirmed booking whose album is ready (eligible for a handover). */
function addReadyBooking(db, id, userId, eventDate) {
  addBooking(db, id, { userId, eventDate, status: 'confirmed' })
  insertRow(db, 'album_production', { booking_id: id, stage: 'ready', created_at: at(-50), updated_at: at(-50) })
}

// ---------------------------------------------------------------------------
// Statements from the plan (§2.3, §2.5, §3.3), written as the Worker will
// ---------------------------------------------------------------------------

// Effective = the highest id already in force; pending = a newer one that is not.
const EFFECTIVE_REVISION_SQL = `
  SELECT id FROM settings_revisions
  WHERE section = ?1 AND COALESCE(effective_at, created_at) <= ?2
  ORDER BY id DESC LIMIT 1`

const PENDING_REVISION_SQL = `
  SELECT id FROM settings_revisions
  WHERE section = ?1
    AND COALESCE(effective_at, created_at) > ?2
    AND id > COALESCE((
      SELECT id FROM settings_revisions
      WHERE section = ?1 AND COALESCE(effective_at, created_at) <= ?2
      ORDER BY id DESC LIMIT 1
    ), 0)
  ORDER BY id DESC LIMIT 1`

// Flow-2 approval: the deposit rule the admin saw is still the latest, and a
// bank revision and a terms version exist, all inside the UPDATE.
const APPROVE_FLOW_2_SQL = `
  UPDATE booking_requests
  SET status = 'approved_hold', flow_version = 2, deposit_amount = ?1, deposit_rule_revision_id = ?2,
    hold_expires_at = ?3, updated_at = ?4
  WHERE id = ?5
    AND status = 'pending_review'
    AND ?2 = (SELECT MAX(id) FROM settings_revisions WHERE section = 'deposit')
    AND EXISTS (SELECT 1 FROM settings_revisions WHERE section = 'bank' AND COALESCE(effective_at, created_at) <= ?4)
    AND EXISTS (SELECT 1 FROM terms_versions)`

// Accept terms (§3.3 #3): only the current version, only her own live hold;
// snapshots the effective bank revision.
const ACCEPT_TERMS_SQL = `
  UPDATE booking_requests
  SET terms_version = (SELECT version FROM terms_versions ORDER BY seq DESC LIMIT 1),
    terms_accepted_at = ?1,
    bank_revision_id = (
      SELECT id FROM settings_revisions
      WHERE section = 'bank' AND COALESCE(effective_at, created_at) <= ?1
      ORDER BY id DESC LIMIT 1
    ),
    updated_at = ?1
  WHERE id = ?2 AND user_id = ?3 AND flow_version = 2 AND status = 'approved_hold'
    AND hold_expires_at > ?1 AND terms_accepted_at IS NULL
    AND ?4 = (SELECT version FROM terms_versions ORDER BY seq DESC LIMIT 1)`

// A pickup handover for her own confirmed, album-ready booking on an active,
// future slot with room (§3.3 handover, TM-06): ownership and capacity inside.
const BOOK_PICKUP_SQL = `
  INSERT INTO handovers (booking_id, slot_id, method, status, created_at, updated_at)
  SELECT b.id, s.id, 'pickup', 'scheduled', ?4, ?4
  FROM booking_requests AS b
  INNER JOIN album_production AS a ON a.booking_id = b.id AND a.stage = 'ready'
  INNER JOIN handover_slots AS s ON s.id = ?3
  WHERE b.id = ?1 AND b.user_id = ?2 AND b.status = 'confirmed'
    AND s.is_active = 1 AND s.starts_at > ?4 AND s.method IN ('pickup', 'both')
    AND (SELECT COUNT(*) FROM handovers AS h WHERE h.slot_id = s.id AND h.status = 'scheduled') < s.capacity`

// Flow-2 holds past their deadline that no deposit notice for the CURRENT
// deadline protects (B1, N-50).
const EXPIRABLE_HOLDS_SQL = `
  SELECT b.id FROM booking_requests AS b
  WHERE b.flow_version = 2 AND b.status = 'approved_hold' AND b.hold_expires_at <= ?1
    AND NOT EXISTS (
      SELECT 1 FROM booking_events AS e
      WHERE e.booking_id = b.id AND e.event = 'deposit_notice_sent'
        AND json_extract(e.details, '$.holdExpiresAt') = b.hold_expires_at
    )
  ORDER BY b.id`

// Before a flow-2 approval: expire the stale, unprotected flow-2 holds on the
// same date (history first, then the status, both on the same ?now).
const TARGETED_EXPIRY_HISTORY_SQL = `
  INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
  SELECT b.id, 'approved_hold', 'expired', NULL, NULL, ?2 FROM booking_requests AS b
  WHERE b.event_date = ?1 AND b.flow_version = 2 AND b.status = 'approved_hold' AND b.hold_expires_at <= ?2
    AND NOT EXISTS (SELECT 1 FROM booking_events AS e WHERE e.booking_id = b.id AND e.event = 'deposit_notice_sent'
      AND json_extract(e.details, '$.holdExpiresAt') = b.hold_expires_at)`

const TARGETED_EXPIRY_UPDATE_SQL = `
  UPDATE booking_requests SET status = 'expired', updated_at = ?2
  WHERE event_date = ?1 AND flow_version = 2 AND status = 'approved_hold' AND hold_expires_at <= ?2
    AND NOT EXISTS (SELECT 1 FROM booking_events AS e WHERE e.booking_id = booking_requests.id
      AND e.event = 'deposit_notice_sent' AND json_extract(e.details, '$.holdExpiresAt') = booking_requests.hold_expires_at)`

// extend_hold: compare-and-swap on the deadline the admin saw (SB-5).
const EXTEND_HOLD_SQL = `
  UPDATE booking_requests SET hold_expires_at = ?1, updated_at = ?2
  WHERE id = ?3 AND status = 'approved_hold' AND flow_version = 2 AND hold_expires_at = ?4`

// reinstate_hold: an expired flow-2 booking gets its hold back; the unique
// blocking-date index refuses it while another booking holds the date.
const REINSTATE_HOLD_SQL = `
  UPDATE booking_requests SET status = 'approved_hold', hold_expires_at = ?1, updated_at = ?2
  WHERE id = ?3 AND status = 'expired' AND flow_version = 2`

// POST /api/bookings: at most 3 open requests whose date has not passed,
// counted inside the INSERT (worker/bookings.ts, SEC-03).
const CAPPED_BOOKING_INSERT_SQL = `
  INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total, created_at, updated_at)
  SELECT ?1, ?2, ?3, 'pending_review', '{}', 4000, ?4, ?4
  WHERE (
    SELECT COUNT(*) FROM booking_requests
    WHERE user_id = ?2 AND event_date >= ?5
      AND status IN ('pending_review', 'approved_hold', 'contract_pending', 'contract_signed', 'payment_pending')
  ) < 3`

// PATCH slot capacity: never below the scheduled handovers (TM-15).
const DECREASE_CAPACITY_SQL = `
  UPDATE handover_slots SET capacity = ?1, updated_at = ?2
  WHERE id = ?3 AND ?1 >= (SELECT COUNT(*) FROM handovers WHERE slot_id = ?3 AND status = 'scheduled')`

// Re-book or reassign: the capacity count leaves out the booking's own row.
const REASSIGN_SQL = `
  UPDATE handovers SET slot_id = ?1, status = 'scheduled', updated_at = ?2
  WHERE booking_id = ?3
    AND (
      SELECT COUNT(*) FROM handovers AS h
      WHERE h.slot_id = ?1 AND h.status = 'scheduled' AND h.booking_id <> ?3
    ) < (SELECT capacity FROM handover_slots WHERE id = ?1 AND is_active = 1)`

// The admin guard's row predicate (W1-02 over Wave 0's INTEGER seconds column).
const ADMIN_ROW_SQL = `
  SELECT COUNT(*) FROM users
  WHERE id = ?1 AND role = 'admin' AND lower(email) = lower(?2)
    AND email_verified_at IS NOT NULL AND erased_at IS NULL
    AND (tokens_valid_after IS NULL OR tokens_valid_after <= ?3)`

const SWITCH_STATE_SQL = `
  SELECT state FROM ops_switch_revisions WHERE switch_name = 'online_confirmation' ORDER BY id DESC LIMIT 1`

const CSP_UPSERT_SQL = `
  INSERT INTO csp_report_counts (day, directive, blocked_origin, count) VALUES (?1, ?2, ?3, 1)
  ON CONFLICT (day, directive, blocked_origin) DO UPDATE SET count = csp_report_counts.count + 1`

/** Vocabulary INSERT … SELECT … NOT IN statements of a migration file. */
function vocabularyStatements(name) {
  return migrationText(name).match(/INSERT INTO (?:event_kinds|admin_audit_actions) \(\w+\)\nSELECT column1[\s\S]*?;/g) ?? []
}

const EVENT_KINDS_0008 = [
  'terms_accepted', 'deposit_notice_sent', 'deposit_recorded', 'receipt_verified',
  'event_profile_saved', 'feedback_submitted', 'internal_notes_updated', 'admin_whatsapp_opened',
]
const AUDIT_ACTIONS_0008 = [
  'settings_deposit_updated', 'settings_bank_updated', 'settings_contact_updated', 'settings_pickup_updated',
  'terms_published', 'delivery_area_created', 'delivery_area_updated', 'handover_slot_created',
  'handover_slots_generated', 'handover_slot_updated', 'handover_slot_deleted', 'blocked_date_created',
  'blocked_date_deleted', 'bookings_exported', 'receipt_viewed', 'gallery_selection_exported',
]
const EVENT_KINDS_0009 = ['hold_reinstated', 'terms_accepted_offline', 'admin_whatsapp_sent', 'admin_queue_dismissed']
const AUDIT_ACTIONS_0009 = ['admin_promoted', 'admin_demoted', 'admin_sessions_revoked', 'online_confirmation_switched']

function vocabulary(db, table, column) {
  return all(db, `SELECT ${column} AS value FROM ${table}`).map((row) => row.value)
}

// ---------------------------------------------------------------------------
// §2.3 — 0008_golive_admin_settings.sql (56 checks)
// ---------------------------------------------------------------------------

const settingsChecks = [
  ['01 applies after 0001, 0003–0007: 25 tables, 22 indexes, 8 triggers', () => {
    assert.deepEqual(migrationFiles().filter((name) => name <= SETTINGS_MIGRATION), [
      '0001_initial.sql',
      '0003_create_core_tables.sql',
      '0004_prevent_duplicate_booking_requests.sql',
      '0005_portal_schema.sql',
      '0006_hold_expired_event_and_admin_list_index.sql',
      '0007_users_email_verified_and_token_revocation.sql',
      SETTINGS_MIGRATION,
    ])
    assert.deepEqual(schemaCounts(openDatabase(SETTINGS_MIGRATION)), { tables: 25, indexes: 22, triggers: 8 })
  }],
  ['02 event_kinds gains the 8 kinds of 0008', () => {
    const before = vocabulary(openDatabase('0007_users_email_verified_and_token_revocation.sql'), 'event_kinds', 'kind')
    const after = vocabulary(openDatabase(SETTINGS_MIGRATION), 'event_kinds', 'kind')
    assert.deepEqual(after.filter((kind) => !before.includes(kind)).sort(), [...EVENT_KINDS_0008].sort())
  }],
  ['03 admin_audit_actions holds exactly the 16 actions of 0008', () => {
    const actions = vocabulary(openDatabase(SETTINGS_MIGRATION), 'admin_audit_actions', 'action')
    assert.deepEqual(actions.sort(), [...AUDIT_ACTIONS_0008].sort())
  }],
  ['04 re-running the event_kinds vocabulary insert changes nothing', () => {
    const db = openDatabase(SETTINGS_MIGRATION)
    const statements = vocabularyStatements(SETTINGS_MIGRATION)
    assert.equal(statements.length, 1)
    assert.equal(run(db, statements[0]), 0)
  }],
  ['05 admin_audit_actions refuses an action outside [a-z_] or 3–48 characters', () => {
    const db = openDatabase()
    for (const action of ['Settings_updated', 'settings-updated', 'ab', 'a'.repeat(49)]) {
      assert.throws(() => insertRow(db, 'admin_audit_actions', { action }), CHECK, action)
    }
  }],
  ['06 a second admin row is refused (ux_users_single_admin)', () => {
    const db = fixture()
    assert.throws(() => addUser(db, 'AdminUid0002', 'admin'), UNIQUE)
  }],
  ['07 promoting a second user to admin is refused', () => {
    const db = fixture()
    assert.throws(() => run(db, "UPDATE users SET role = 'admin' WHERE id = ?", BRIDE), UNIQUE)
    assert.equal(scalar(db, "SELECT COUNT(*) FROM users WHERE role = 'admin'"), 1)
  }],
  ['08 demoting the admin lets another user be promoted (the --replace swap)', () => {
    const db = fixture()
    db.exec('BEGIN')
    assert.equal(run(db, "UPDATE users SET role = 'customer' WHERE id = ?", ADMIN), 1)
    assert.equal(run(db, "UPDATE users SET role = 'admin' WHERE id = ?", OTHER_BRIDE), 1)
    db.exec('COMMIT')
    assert.equal(scalar(db, "SELECT id FROM users WHERE role = 'admin'"), OTHER_BRIDE)
  }],
  ['09 a fixed deposit rule is accepted', () => {
    const db = fixture()
    assert.equal(addRevision(db, 'deposit'), 1)
  }],
  ['10 a percent deposit rule is accepted', () => {
    const db = fixture()
    addRevision(db, 'deposit', { deposit_kind: 'percent', deposit_fixed_amount: null, deposit_percent: 30, deposit_round_to: 50 })
    assert.equal(scalar(db, 'SELECT deposit_percent FROM settings_revisions'), 30)
  }],
  ['11 a deposit rule with both an amount and a percent, or neither, is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'deposit', { deposit_percent: 30 }), CHECK)
    assert.throws(() => addRevision(db, 'deposit', { deposit_kind: 'percent', deposit_fixed_amount: null }), CHECK)
    assert.throws(() => addRevision(db, 'deposit', { deposit_fixed_amount: null }), CHECK)
  }],
  ['12 a deposit row carrying a bank, contact or pickup field is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'deposit', { bank_iban: IBAN }), CHECK)
    assert.throws(() => addRevision(db, 'deposit', { whatsapp_number: '966500000000' }), CHECK)
    assert.throws(() => addRevision(db, 'deposit', { pickup_address: 'عنوان تجريبي' }), CHECK)
  }],
  ['13 deposit_round_to outside 1, 5, 10, 50, 100 is refused', () => {
    const db = fixture()
    for (const roundTo of [0, 2, 25, 1000, null]) {
      assert.throws(() => addRevision(db, 'deposit', { deposit_round_to: roundTo }), CHECK, String(roundTo))
    }
  }],
  ['14 deposit_percent outside 1–100 and deposit_fixed_amount outside 1–1,000,000 are refused', () => {
    const db = fixture()
    for (const percent of [0, 101]) {
      assert.throws(
        () => addRevision(db, 'deposit', { deposit_kind: 'percent', deposit_fixed_amount: null, deposit_percent: percent }),
        CHECK,
      )
    }
    for (const amount of [0, 1_000_001, -5]) {
      assert.throws(() => addRevision(db, 'deposit', { deposit_fixed_amount: amount }), CHECK, String(amount))
    }
  }],
  ['15 a non-integer deposit amount or percent is refused (typeof)', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'deposit', { deposit_fixed_amount: 500.5 }), CHECK)
    assert.throws(() => addRevision(db, 'deposit', { deposit_fixed_amount: '500 ريال' }), CHECK)
    assert.throws(
      () => addRevision(db, 'deposit', { deposit_kind: 'percent', deposit_fixed_amount: null, deposit_percent: 30.5 }),
      CHECK,
    )
  }],
  ['16 a bank revision is accepted', () => {
    const db = fixture()
    addRevision(db, 'bank')
    assert.equal(scalar(db, 'SELECT bank_iban FROM settings_revisions'), IBAN)
  }],
  ['17 a bank revision missing its name, holder or IBAN is refused', () => {
    const db = fixture()
    for (const field of ['bank_name', 'bank_account_holder', 'bank_iban']) {
      assert.throws(() => addRevision(db, 'bank', { [field]: null }), CHECK, field)
    }
  }],
  ['18 a lower-case IBAN is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'bank', { bank_iban: 'sa0000000000000000000001' }), CHECK)
    assert.throws(() => addRevision(db, 'bank', { bank_iban: 'SA00000000000000000000ab' }), CHECK)
  }],
  ['19 a 23- or 25-character IBAN is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'bank', { bank_iban: IBAN.slice(0, 23) }), CHECK)
    assert.throws(() => addRevision(db, 'bank', { bank_iban: `${IBAN}0` }), CHECK)
  }],
  ['20 an IBAN that is not SA + two check digits, or contains a space, is refused', () => {
    const db = fixture()
    for (const iban of ['AE0000000000000000000001', 'SAX000000000000000000001', `${IBAN.slice(0, 4)} ${IBAN.slice(5)}`]) {
      assert.equal(iban.length, 24)
      assert.throws(() => addRevision(db, 'bank', { bank_iban: iban }), CHECK, iban)
    }
  }],
  ['21 a control character in the bank name or account holder is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'bank', { bank_name: 'مصرف\nتجريبي' }), CHECK)
    assert.throws(() => addRevision(db, 'bank', { bank_account_holder: 'حساب\u0007تجريبي' }), CHECK)
    assert.throws(() => addRevision(db, 'bank', { bank_name: 'مصرف\u007f' }), CHECK)
  }],
  ['22 a contact revision is accepted', () => {
    const db = fixture()
    addRevision(db, 'contact')
    assert.equal(scalar(db, 'SELECT whatsapp_number FROM settings_revisions'), '966500000000')
  }],
  ['23 a WhatsApp number with a leading 0, or shorter than 8 or longer than 15 digits, is refused', () => {
    const db = fixture()
    for (const number of ['0500000000', '9665000', '9665000000000000']) {
      assert.throws(() => addRevision(db, 'contact', { whatsapp_number: number }), CHECK, number)
    }
  }],
  ['24 a WhatsApp number with +, letters or a query string is refused (N-21)', () => {
    const db = fixture()
    for (const number of ['+966500000000', '96650000000a', '966500000000?text=x', '٩٦٦٥٠٠٠٠٠٠٠٠']) {
      assert.throws(() => addRevision(db, 'contact', { whatsapp_number: number }), CHECK, number)
    }
  }],
  ['25 a pickup revision is accepted without reauth_at', () => {
    const db = fixture()
    addRevision(db, 'pickup', { pickup_instructions: 'اتصلي قبل الوصول بعشر دقائق.' })
    assert.equal(scalar(db, 'SELECT reauth_at FROM settings_revisions'), null)
  }],
  ['26 a pickup address may contain a line break but not a tab or another control character', () => {
    const db = fixture()
    addRevision(db, 'pickup', { pickup_address: 'الرياض\nحي تجريبي' })
    assert.throws(() => addRevision(db, 'pickup', { pickup_address: 'الرياض\tحي تجريبي' }), CHECK)
    assert.throws(() => addRevision(db, 'pickup', { pickup_instructions: 'اتصلي\rقبل الوصول' }), CHECK)
  }],
  ['27 a deposit, bank or contact revision without reauth_at is refused', () => {
    const db = fixture()
    for (const section of ['deposit', 'bank', 'contact']) {
      assert.throws(() => addRevision(db, section, { reauth_at: null }), CHECK, section)
    }
  }],
  ['28 a reauth_at 10 minutes 1 second before created_at is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'bank', { reauth_at: STALE_REAUTH }), CHECK)
    assert.throws(() => addRevision(db, 'deposit', { reauth_at: at(-60) }), CHECK)
  }],
  ['29 a reauth_at after created_at (future) is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'bank', { reauth_at: at(1) }), CHECK)
  }],
  ['30 a reauth_at 9 minutes 59 seconds before created_at is accepted', () => {
    const db = fixture()
    addRevision(db, 'bank', { reauth_at: new Date(T0 - (9 * 60 + 59) * 1000).toISOString() })
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM settings_revisions'), 1)
  }],
  ['31 a created_at or reauth_at in CURRENT_TIMESTAMP format is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'pickup', { created_at: '2026-10-01 09:00:00' }), CHECK)
    assert.throws(() => addRevision(db, 'bank', { reauth_at: '2026-10-01 08:58:00' }), CHECK)
    assert.throws(() => addRevision(db, 'pickup', { created_at: '2026-10-01T25:00:00.000Z' }), CHECK)
  }],
  ['32 an unknown section is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'pickup', { section: 'terms' }), CHECK)
  }],
  ['33 a revision by an unknown user is refused (foreign key)', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'pickup', { created_by: 'NobodyUid' }), FOREIGN_KEY)
  }],
  ['34 UPDATE on settings_revisions aborts', () => {
    const db = fixture()
    addRevision(db, 'bank')
    assert.throws(() => run(db, "UPDATE settings_revisions SET bank_iban = 'SA9900000000000000000009'"), /APPEND_ONLY_SETTINGS_REVISIONS/)
  }],
  ['35 DELETE on settings_revisions aborts', () => {
    const db = fixture()
    addRevision(db, 'bank')
    assert.throws(() => run(db, 'DELETE FROM settings_revisions'), /APPEND_ONLY_SETTINGS_REVISIONS/)
  }],
  ['36 UPDATE on terms_versions aborts', () => {
    const db = fixture()
    publishTerms(db)
    assert.throws(() => run(db, "UPDATE terms_versions SET change_summary = 'تعديل'"), /APPEND_ONLY_TERMS_VERSIONS/)
  }],
  ['37 DELETE on terms_versions aborts', () => {
    const db = fixture()
    publishTerms(db)
    assert.throws(() => run(db, 'DELETE FROM terms_versions'), /APPEND_ONLY_TERMS_VERSIONS/)
  }],
  ['38 UPDATE on admin_audit_log aborts', () => {
    const db = fixture()
    addAudit(db)
    assert.throws(() => run(db, "UPDATE admin_audit_log SET target_id = 'x'"), /APPEND_ONLY_ADMIN_AUDIT_LOG/)
  }],
  ['39 DELETE on admin_audit_log aborts', () => {
    const db = fixture()
    addAudit(db)
    assert.throws(() => run(db, 'DELETE FROM admin_audit_log'), /APPEND_ONLY_ADMIN_AUDIT_LOG/)
  }],
  ['40 the atomic INSERT … SELECT publishes v1, then v2', () => {
    const db = fixture()
    assert.equal(publishTerms(db), 1)
    assert.equal(publishTerms(db, `${TERMS_BODY} (نسخة ثانية)`), 1)
    assert.deepEqual(
      all(db, 'SELECT version, seq FROM terms_versions ORDER BY seq').map((row) => [row.version, row.seq]),
      [['v1', 1], ['v2', 2]],
    )
  }],
  ['41 a terms version that is not v || seq, a short body, a control character or a non-hex hash is refused', () => {
    const db = fixture()
    const terms = (overrides) => ({
      version: 'v1', seq: 1, body: TERMS_BODY, body_sha256: sha256(TERMS_BODY), created_by: ADMIN,
      reauth_at: at(-1), created_at: at(0), ...overrides,
    })
    assert.throws(() => insertRow(db, 'terms_versions', terms({ version: 'v2' })), CHECK)
    assert.throws(() => insertRow(db, 'terms_versions', terms({ version: 'v0', seq: 0 })), CHECK)
    assert.throws(() => insertRow(db, 'terms_versions', terms({ body: 'نص قصير' })), CHECK)
    assert.throws(() => insertRow(db, 'terms_versions', terms({ body: `${TERMS_BODY}\u000b` })), CHECK)
    assert.throws(() => insertRow(db, 'terms_versions', terms({ body: `\u0001${TERMS_BODY}` })), CHECK)
    assert.throws(() => insertRow(db, 'terms_versions', terms({ body_sha256: sha256(TERMS_BODY).toUpperCase() })), CHECK)
    insertRow(db, 'terms_versions', terms({ body: `${TERMS_BODY}\nالبند الثاني.\n` }))
  }],
  ['42 a terms version saved 10 minutes 1 second after the sign-in is refused', () => {
    const db = fixture()
    assert.throws(() => run(db, PUBLISH_TERMS_SQL, TERMS_BODY, sha256(TERMS_BODY), ADMIN, fromNow(-601 / 60)), CHECK)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM terms_versions'), 0)
  }],
  ['43 the flow-2 approve UPDATE with the settings predicates changes 1 row', () => {
    const db = fixture()
    const depositId = addRevision(db, 'deposit')
    addRevision(db, 'bank')
    publishTerms(db)
    addBooking(db, 'booking-approve')
    assert.equal(run(db, APPROVE_FLOW_2_SQL, 500, depositId, at(48 * 60), at(0), 'booking-approve'), 1)
    const row = get(db, 'SELECT status, flow_version, deposit_rule_revision_id FROM booking_requests')
    assert.deepEqual({ ...row }, { status: 'approved_hold', flow_version: 2, deposit_rule_revision_id: depositId })
  }],
  ['44 the approve changes 0 rows with a stale deposit rule, without a bank revision or without terms', () => {
    const stale = fixture()
    const oldRule = addRevision(stale, 'deposit')
    addRevision(stale, 'deposit', { deposit_fixed_amount: 700 })
    addRevision(stale, 'bank')
    publishTerms(stale)
    addBooking(stale, 'booking-approve')
    assert.equal(run(stale, APPROVE_FLOW_2_SQL, 500, oldRule, at(48 * 60), at(0), 'booking-approve'), 0)

    const noBank = fixture()
    const rule = addRevision(noBank, 'deposit')
    publishTerms(noBank)
    addBooking(noBank, 'booking-approve')
    assert.equal(run(noBank, APPROVE_FLOW_2_SQL, 500, rule, at(48 * 60), at(0), 'booking-approve'), 0)

    const noTerms = fixture()
    const ruleId = addRevision(noTerms, 'deposit')
    addRevision(noTerms, 'bank')
    addBooking(noTerms, 'booking-approve')
    assert.equal(run(noTerms, APPROVE_FLOW_2_SQL, 500, ruleId, at(48 * 60), at(0), 'booking-approve'), 0)
  }],
  ['45 accepting a stale terms version changes 0 rows; the current one changes 1 and snapshots the bank', () => {
    const db = fixture()
    const bankId = addRevision(db, 'bank')
    publishTerms(db)
    publishTerms(db, `${TERMS_BODY} (نسخة ثانية)`)
    addHold(db, 'booking-hold', '2026-12-01', at(24 * 60))
    assert.equal(run(db, ACCEPT_TERMS_SQL, at(0), 'booking-hold', BRIDE, 'v1'), 0)
    assert.equal(run(db, ACCEPT_TERMS_SQL, at(0), 'booking-hold', OTHER_BRIDE, 'v2'), 0)
    assert.equal(run(db, ACCEPT_TERMS_SQL, at(0), 'booking-hold', BRIDE, 'v2'), 1)
    const row = get(db, 'SELECT terms_version, bank_revision_id FROM booking_requests')
    assert.deepEqual({ ...row }, { terms_version: 'v2', bank_revision_id: bankId })
  }],
  ['46 bank_revision_id without an accepted terms version is refused', () => {
    const db = fixture()
    const bankId = addRevision(db, 'bank')
    addHold(db, 'booking-hold', '2026-12-01', at(24 * 60))
    assert.throws(() => run(db, 'UPDATE booking_requests SET bank_revision_id = ?', bankId), CHECK)
  }],
  ['47 deposit_rule_revision_id on a flow-1 booking is refused', () => {
    const db = fixture()
    const ruleId = addRevision(db, 'deposit')
    addBooking(db, 'booking-legacy')
    assert.throws(() => run(db, 'UPDATE booking_requests SET deposit_rule_revision_id = ?', ruleId), CHECK)
  }],
  ['48 a received deposit above the estimated total, or below 1, is refused', () => {
    const db = fixture()
    addHold(db, 'booking-hold', '2026-12-01', at(24 * 60), { total: 4000 })
    const record = 'UPDATE booking_requests SET deposit_received_amount = ?, deposit_received_at = ?'
    assert.throws(() => run(db, record, 4001, at(0)), CHECK)
    assert.throws(() => run(db, record, 0, at(0)), CHECK)
    assert.equal(run(db, record, 4000, at(0)), 1)
  }],
  ['49 a received deposit without its timestamp, or a timestamp without an amount, is refused', () => {
    const db = fixture()
    addHold(db, 'booking-hold', '2026-12-01', at(24 * 60))
    assert.throws(() => run(db, 'UPDATE booking_requests SET deposit_received_amount = 1000'), CHECK)
    assert.throws(() => run(db, 'UPDATE booking_requests SET deposit_received_at = ?', at(0)), CHECK)
  }],
  ['50 editing a booking_status_history note or status aborts', () => {
    const db = fixture()
    addBooking(db, 'booking-history')
    assert.throws(() => run(db, "UPDATE booking_status_history SET note = 'تعديل'"), /APPEND_ONLY_BOOKING_STATUS_HISTORY/)
    assert.throws(() => run(db, "UPDATE booking_status_history SET to_status = 'confirmed'"), /APPEND_ONLY_BOOKING_STATUS_HISTORY/)
    assert.throws(() => run(db, 'UPDATE booking_status_history SET created_at = ?', at(5)), /APPEND_ONLY_BOOKING_STATUS_HISTORY/)
  }],
  // Fix round 1 (deviation from the §2.2 text, recorded in d1/0008-0009-verification.md): the attribution
  // columns may only become NULL through ON DELETE SET NULL; a reassignment, direct or cascaded from a
  // users.id rename, aborts.
  ['51 changed_by and actor_uid follow ON DELETE SET NULL; reassigning them to another user aborts', () => {
    const db = fixture()
    addUser(db, 'FormerStaff')
    addBooking(db, 'booking-history')
    insertRow(db, 'booking_status_history', {
      booking_id: 'booking-history', from_status: 'pending_review', to_status: 'rejected', changed_by: 'FormerStaff',
      note: null, created_at: at(0),
    })
    const eventId = addEvent(db, 'booking-history', 'internal_notes_updated', { actor: 'admin', actor_uid: 'FormerStaff', note: 'ملاحظة' })
    const reassign = [
      ["UPDATE booking_status_history SET changed_by = ? WHERE to_status = 'rejected'", [ADMIN], /APPEND_ONLY_BOOKING_STATUS_HISTORY/],
      ["UPDATE booking_status_history SET changed_by = ? WHERE to_status = 'pending_review'", [ADMIN], /APPEND_ONLY_BOOKING_STATUS_HISTORY/],
      ['UPDATE booking_events SET actor_uid = ? WHERE id = ?', [ADMIN, eventId], /APPEND_ONLY_BOOKING_EVENTS/],
    ]
    for (const [sql, params, error] of reassign) {
      assert.throws(() => run(db, sql, ...params), error, sql)
    }
    assert.throws(() => run(db, "UPDATE users SET id = 'FormerStaff2' WHERE id = 'FormerStaff'"), /APPEND_ONLY_BOOKING_/)
    assert.equal(run(db, "DELETE FROM users WHERE id = 'FormerStaff'"), 1)
    assert.equal(scalar(db, "SELECT changed_by FROM booking_status_history WHERE to_status = 'rejected'"), null)
    assert.equal(scalar(db, 'SELECT actor_uid FROM booking_events WHERE id = ?', eventId), null)
    // A NULL (studio) attribution cannot be pinned on a user afterwards either.
    assert.throws(() => run(db, "UPDATE booking_status_history SET changed_by = ? WHERE to_status = 'rejected'", BRIDE), /APPEND_ONLY_BOOKING_STATUS_HISTORY/)
    assert.throws(() => run(db, 'UPDATE booking_events SET actor_uid = ? WHERE id = ?', ADMIN, eventId), /APPEND_ONLY_BOOKING_EVENTS/)
  }],
  ['52 rewriting a booking_events row (details, note, event, actor, actor_uid) aborts', () => {
    const db = fixture()
    addBooking(db, 'booking-events')
    addEvent(db, 'booking-events', 'deposit_notice_sent', { details: '{"holdExpiresAt":"2026-10-02T09:00:00.000Z"}', note: 'ملاحظة' })
    for (const assignment of [
      `details = '{"holdExpiresAt":"2026-10-09T09:00:00.000Z"}'`,
      "note = 'ملاحظة أخرى'",
      "event = 'receipt_verified'",
      "actor = 'system'",
      `actor = 'admin', actor_uid = '${ADMIN}'`,
    ]) {
      assert.throws(() => run(db, `UPDATE booking_events SET ${assignment}`), /APPEND_ONLY_BOOKING_EVENTS/, assignment)
    }
  }],
  ['53 a booking_events note can be redacted once and never restored', () => {
    const db = fixture()
    addBooking(db, 'booking-events')
    addEvent(db, 'booking-events', 'internal_notes_updated', { actor: 'admin', actor_uid: ADMIN, note: 'ملاحظة داخلية' })
    assert.equal(run(db, 'UPDATE booking_events SET note = NULL, redacted_at = ?', at(1)), 1)
    assert.throws(() => run(db, 'UPDATE booking_events SET redacted_at = NULL'), /APPEND_ONLY_BOOKING_EVENTS/)
    assert.throws(() => run(db, 'UPDATE booking_events SET redacted_at = ?', at(2)), /APPEND_ONLY_BOOKING_EVENTS/)
  }],
  ['54 a pickup with a delivery area, a delivery without one, or a fee without an area is refused', () => {
    const db = fixture()
    addReadyBooking(db, 'booking-ready', BRIDE, '2026-08-01')
    const slot = addSlot(db, 1)
    const area = addArea(db, 1)
    const delivery = { method: 'delivery', delivery_city: 'منطقة 1', delivery_district: 'حي', delivery_street: 'شارع' }
    assert.throws(() => addHandover(db, 'booking-ready', slot, { delivery_area_id: area, delivery_fee: 25 }), CHECK)
    assert.throws(() => addHandover(db, 'booking-ready', slot, delivery), CHECK)
    assert.throws(() => addHandover(db, 'booking-ready', slot, { ...delivery, delivery_area_id: area }), CHECK)
    assert.throws(() => addHandover(db, 'booking-ready', slot, { delivery_fee: 0 }), CHECK)
    assert.equal(addHandover(db, 'booking-ready', slot, { ...delivery, delivery_area_id: area, delivery_fee: 25 }), 1)
  }],
  ['55 a delivery area in use cannot be deleted', () => {
    const db = fixture()
    addReadyBooking(db, 'booking-ready', BRIDE, '2026-08-01')
    const area = addArea(db, 1)
    const unused = addArea(db, 2)
    addHandover(db, 'booking-ready', addSlot(db, 1), {
      method: 'delivery', delivery_city: 'منطقة 1', delivery_district: 'حي', delivery_street: 'شارع',
      delivery_area_id: area, delivery_fee: 25,
    })
    assert.throws(() => run(db, 'DELETE FROM delivery_areas WHERE id = ?', area), FOREIGN_KEY)
    assert.equal(run(db, 'DELETE FROM delivery_areas WHERE id = ?', unused), 1)
  }],
  ['56 admin_audit_log refuses an unknown action, non-object or malformed details, a spaced target_id and a stale reauth_at; receipts refuse a non-hex hash', () => {
    const db = fixture()
    assert.equal(addAudit(db, { target_id: 'booking:5eed-1', details: '{"count":3}' }), 1)
    assert.throws(() => addAudit(db, { action: 'settings_iban_changed' }), FOREIGN_KEY)
    assert.throws(() => addAudit(db, { details: '[1,2]' }), CHECK)
    assert.throws(() => addAudit(db, { details: '{"count":' }), CHECK)
    assert.throws(() => addAudit(db, { target_id: 'booking 1' }), CHECK)
    assert.throws(() => addAudit(db, { action: 'settings_bank_updated', reauth_at: STALE_REAUTH }), CHECK)
    addBooking(db, 'booking-receipt')
    const receipt = (hash) => insertRow(db, 'booking_receipts', {
      id: uuid('0ec0a000', 1), booking_id: 'booking-receipt', attempt_no: 1, status: 'void', reviewed_at: at(1),
      created_at: at(0), updated_at: at(1), content_sha256: hash,
    })
    assert.throws(() => receipt(sha256('x').toUpperCase()), CHECK)
    assert.throws(() => receipt(sha256('x').slice(1)), CHECK)
    assert.equal(receipt(sha256('x')), 1)
    assert.ok(names(db, 'index').includes('idx_booking_receipts_sha256'))
  }],
]

// ---------------------------------------------------------------------------
// §2.5 — 0009_golive_hardening.sql (42 checks)
// ---------------------------------------------------------------------------

const hardeningChecks = [
  // Fix rounds 1 and 2: 24 triggers, not the plan's 12 (0009 section 7 adds a no-replace and a key-range guard
  // per append-only table).
  ['01 applies after 0008: 27 tables, 23 indexes, 24 triggers', () => {
    assert.equal(migrationFiles().filter((name) => name > SETTINGS_MIGRATION && name <= HARDENING_MIGRATION).join(), HARDENING_MIGRATION)
    const db = openDatabase()
    assert.deepEqual(schemaCounts(db), { tables: 27, indexes: 23, triggers: 24 })
    assert.deepEqual(names(db, 'trigger'), [
      'trg_admin_audit_log_key_range', 'trg_admin_audit_log_no_delete', 'trg_admin_audit_log_no_replace',
      'trg_admin_audit_log_no_update',
      'trg_booking_events_key_range', 'trg_booking_events_no_delete', 'trg_booking_events_no_replace',
      'trg_booking_events_redact_only',
      'trg_booking_status_history_key_range', 'trg_booking_status_history_no_delete',
      'trg_booking_status_history_no_replace', 'trg_booking_status_history_no_update',
      'trg_ops_switch_revisions_key_range', 'trg_ops_switch_revisions_no_delete',
      'trg_ops_switch_revisions_no_replace', 'trg_ops_switch_revisions_no_update',
      'trg_settings_revisions_key_range', 'trg_settings_revisions_no_delete', 'trg_settings_revisions_no_replace',
      'trg_settings_revisions_no_update',
      'trg_terms_versions_key_range', 'trg_terms_versions_no_delete', 'trg_terms_versions_no_replace',
      'trg_terms_versions_no_update',
    ])
  }],
  ['02 event_kinds gains the 4 kinds of 0009', () => {
    const before = vocabulary(openDatabase(SETTINGS_MIGRATION), 'event_kinds', 'kind')
    const after = vocabulary(openDatabase(), 'event_kinds', 'kind')
    assert.deepEqual(after.filter((kind) => !before.includes(kind)).sort(), [...EVENT_KINDS_0009].sort())
  }],
  ['03 admin_audit_actions gains the 4 actions of 0009 (20 in all)', () => {
    const actions = vocabulary(openDatabase(), 'admin_audit_actions', 'action')
    assert.deepEqual(actions.sort(), [...AUDIT_ACTIONS_0008, ...AUDIT_ACTIONS_0009].sort())
  }],
  ['04 re-running both vocabulary inserts changes nothing', () => {
    const db = openDatabase()
    const statements = vocabularyStatements(HARDENING_MIGRATION)
    assert.equal(statements.length, 2)
    for (const statement of statements) {
      assert.equal(run(db, statement), 0)
    }
  }],
  ['05 Wave 0 users columns are kept once, with their 0007 types; contact_changed_at is added (R-01)', () => {
    const db = openDatabase()
    const columns = all(db, 'PRAGMA table_info(users)').map((column) => [column.name, column.type])
    const typeOf = (name) => columns.filter(([column]) => column === name).map(([, type]) => type)
    assert.deepEqual(typeOf('email_verified_at'), ['TEXT'])
    assert.deepEqual(typeOf('tokens_valid_after'), ['INTEGER'])
    assert.deepEqual(typeOf('contact_changed_at'), ['TEXT'])
    assert.doesNotMatch(migrationText(HARDENING_MIGRATION), /ADD COLUMN (?:email_verified_at|tokens_valid_after)\b/)
  }],
  ['06 email_verified_at refuses the CURRENT_TIMESTAMP format', () => {
    const db = fixture()
    assert.throws(() => run(db, "UPDATE users SET email_verified_at = '2026-10-01 09:00:00' WHERE id = ?", BRIDE), CHECK)
    assert.equal(run(db, 'UPDATE users SET email_verified_at = ? WHERE id = ?', at(0), BRIDE), 1)
  }],
  ['07 tokens_valid_after takes whole Unix seconds only (Wave 0 type)', () => {
    const db = fixture()
    for (const value of [at(0), -1, 1.5]) {
      assert.throws(() => run(db, 'UPDATE users SET tokens_valid_after = ? WHERE id = ?', value, ADMIN), CHECK, String(value))
    }
    assert.equal(run(db, 'UPDATE users SET tokens_valid_after = ? WHERE id = ?', T0 / 1000, ADMIN), 1)
  }],
  ['08 the admin predicate accepts a fresh token of the stored, verified address', () => {
    const db = fixture()
    run(db, 'UPDATE users SET tokens_valid_after = ? WHERE id = ?', T0 / 1000, ADMIN)
    assert.equal(scalar(db, ADMIN_ROW_SQL, ADMIN, 'ADMINUID0001@example.test', T0 / 1000), 1)
    assert.equal(scalar(db, ADMIN_ROW_SQL, ADMIN, 'adminuid0001@example.test', T0 / 1000 + 60), 1)
  }],
  ['09 the admin predicate refuses a token from before the revocation, another address, or an unverified row', () => {
    const db = fixture()
    run(db, 'UPDATE users SET tokens_valid_after = ? WHERE id = ?', T0 / 1000, ADMIN)
    assert.equal(scalar(db, ADMIN_ROW_SQL, ADMIN, 'adminuid0001@example.test', T0 / 1000 - 1), 0)
    assert.equal(scalar(db, ADMIN_ROW_SQL, ADMIN, 'attacker@example.test', T0 / 1000 + 60), 0)
    run(db, 'UPDATE users SET email_verified_at = NULL WHERE id = ?', ADMIN)
    assert.equal(scalar(db, ADMIN_ROW_SQL, ADMIN, 'adminuid0001@example.test', T0 / 1000 + 60), 0)
  }],
  ['10 contact_changed_at takes an ISO instant and refuses the CURRENT_TIMESTAMP format', () => {
    const db = fixture()
    assert.throws(() => run(db, "UPDATE users SET contact_changed_at = '2026-10-01 09:00:00' WHERE id = ?", BRIDE), CHECK)
    assert.equal(run(db, 'UPDATE users SET contact_changed_at = ? WHERE id = ?', at(0), BRIDE), 1)
  }],
  ['11 a bank revision with an SQL-stamped created_at and a reauth_at 10 min 1 s older is refused', () => {
    const db = fixture()
    const insert = `
      INSERT INTO settings_revisions (section, bank_name, bank_account_holder, bank_iban, created_by, reauth_at, created_at)
      VALUES ('bank', 'مصرف تجريبي', 'حساب تجريبي', ?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    assert.throws(() => run(db, insert, IBAN, ADMIN, fromNow(-601 / 60)), CHECK)
    assert.equal(run(db, insert, IBAN, ADMIN, fromNow(-1)), 1)
    const stamped = Date.parse(scalar(db, 'SELECT created_at FROM settings_revisions'))
    assert.ok(Math.abs(stamped - Date.now()) < 60_000)
  }],
  ['12 the first bank revision is effective at once', () => {
    const db = fixture()
    const first = addRevision(db, 'bank')
    assert.equal(scalar(db, EFFECTIVE_REVISION_SQL, 'bank', at(0)), first)
    assert.equal(scalar(db, PENDING_REVISION_SQL, 'bank', at(0)), undefined)
  }],
  ['13 a second bank revision with effective_at + 24 h is pending; the first stays effective', () => {
    const db = fixture()
    const first = addRevision(db, 'bank')
    const second = addRevision(db, 'bank', { bank_iban: 'SA9900000000000000000009', created_at: at(60), reauth_at: at(58), effective_at: at(60 + 24 * 60) })
    assert.equal(scalar(db, EFFECTIVE_REVISION_SQL, 'bank', at(61)), first)
    assert.equal(scalar(db, PENDING_REVISION_SQL, 'bank', at(61)), second)
  }],
  ['14 the pending revision becomes effective when effective_at passes', () => {
    const db = fixture()
    addRevision(db, 'bank')
    const second = addRevision(db, 'bank', { bank_iban: 'SA9900000000000000000009', created_at: at(60), reauth_at: at(58), effective_at: at(60 + 24 * 60) })
    assert.equal(scalar(db, EFFECTIVE_REVISION_SQL, 'bank', at(60 + 24 * 60)), second)
    assert.equal(scalar(db, PENDING_REVISION_SQL, 'bank', at(60 + 24 * 60)), undefined)
  }],
  ['15 re-saving the effective values supersedes the pending change at once', () => {
    const db = fixture()
    addRevision(db, 'bank')
    addRevision(db, 'bank', { bank_iban: 'SA9900000000000000000009', created_at: at(60), reauth_at: at(58), effective_at: at(60 + 24 * 60) })
    const cancel = addRevision(db, 'bank', { created_at: at(120), reauth_at: at(118) })
    for (const now of [at(121), at(60 + 24 * 60), at(3 * 24 * 60)]) {
      assert.equal(scalar(db, EFFECTIVE_REVISION_SQL, 'bank', now), cancel, now)
      assert.equal(scalar(db, PENDING_REVISION_SQL, 'bank', now), undefined, now)
    }
  }],
  ['16 effective_at on a deposit or pickup revision is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'deposit', { effective_at: at(60) }), CHECK)
    assert.throws(() => addRevision(db, 'pickup', { effective_at: at(60) }), CHECK)
    addRevision(db, 'contact', { effective_at: at(60) })
  }],
  // Fix round 1: the bound is 72 h (GAP-05's longer delay), not the plan's 24 h.
  ['17 effective_at more than 72 h after created_at is refused; exactly 24 h and 72 h are accepted', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'bank', { effective_at: new Date(T0 + 259_201_000).toISOString() }), CHECK)
    assert.throws(() => addRevision(db, 'contact', { effective_at: at(30 * 24 * 60) }), CHECK)
    addRevision(db, 'bank', { effective_at: at(24 * 60) })
    addRevision(db, 'contact', { effective_at: at(72 * 60) })
    addRevision(db, 'bank', { effective_at: at(72 * 60) })
  }],
  ['18 effective_at before created_at is refused', () => {
    const db = fixture()
    assert.throws(() => addRevision(db, 'bank', { effective_at: at(-1) }), CHECK)
  }],
  ['19 effective_at in a non-ISO format is refused', () => {
    const db = fixture()
    for (const value of ['2026-10-02 09:00:00', '2026-10-02T09:00:00Z', '2026-10-02T24:00:00.000Z']) {
      assert.throws(() => addRevision(db, 'bank', { effective_at: value }), CHECK, value)
    }
  }],
  ['20 revisions stay append-only: effective_at cannot be moved', () => {
    const db = fixture()
    addRevision(db, 'bank')
    addRevision(db, 'bank', { created_at: at(60), reauth_at: at(58), effective_at: at(60 + 24 * 60) })
    assert.throws(() => run(db, 'UPDATE settings_revisions SET effective_at = NULL WHERE id = 2'), /APPEND_ONLY_SETTINGS_REVISIONS/)
  }],
  ['21 the kill switch accepts "off" without a re-auth', () => {
    const db = fixture()
    assert.equal(insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'off', note: 'إيقاف مؤقت', created_by: ADMIN, created_at: at(0) }), 1)
  }],
  ['22 the kill switch refuses "on" without a reauth_at', () => {
    const db = fixture()
    assert.throws(() => insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'on', created_by: ADMIN, created_at: at(0) }), CHECK)
  }],
  ['23 the kill switch refuses "on" with a stale reauth_at and accepts a fresh one', () => {
    const db = fixture()
    const on = (reauth) => insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'on', created_by: ADMIN, reauth_at: reauth, created_at: at(0) })
    assert.throws(() => on(STALE_REAUTH), CHECK)
    assert.throws(() => on(at(1)), CHECK)
    assert.equal(on(at(-2)), 1)
  }],
  ['24 the kill switch refuses an unknown switch, an unknown state or a control character in the note', () => {
    const db = fixture()
    const row = (overrides) => ({ switch_name: 'online_confirmation', state: 'off', created_by: ADMIN, created_at: at(0), ...overrides })
    assert.throws(() => insertRow(db, 'ops_switch_revisions', row({ switch_name: 'private_media' })), CHECK)
    assert.throws(() => insertRow(db, 'ops_switch_revisions', row({ state: 'OFF' })), CHECK)
    assert.throws(() => insertRow(db, 'ops_switch_revisions', row({ note: 'سطر\nآخر' })), CHECK)
    assert.throws(() => insertRow(db, 'ops_switch_revisions', row({ created_by: 'NobodyUid' })), FOREIGN_KEY)
  }],
  ['25 UPDATE on ops_switch_revisions aborts', () => {
    const db = fixture()
    insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'off', created_by: ADMIN, created_at: at(0) })
    assert.throws(() => run(db, "UPDATE ops_switch_revisions SET state = 'on'"), /APPEND_ONLY_OPS_SWITCH_REVISIONS/)
  }],
  ['26 DELETE on ops_switch_revisions aborts', () => {
    const db = fixture()
    insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'off', created_by: ADMIN, created_at: at(0) })
    assert.throws(() => run(db, 'DELETE FROM ops_switch_revisions'), /APPEND_ONLY_OPS_SWITCH_REVISIONS/)
  }],
  ['27 the switch is on while no row exists, and the newest row decides', () => {
    const db = fixture()
    assert.equal(scalar(db, SWITCH_STATE_SQL), undefined)
    insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'off', created_by: ADMIN, created_at: at(0) })
    assert.equal(scalar(db, SWITCH_STATE_SQL), 'off')
    insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'on', created_by: ADMIN, reauth_at: at(4), created_at: at(5) })
    assert.equal(scalar(db, SWITCH_STATE_SQL), 'on')
    assert.ok(names(db, 'index').includes('idx_ops_switch_revisions_name'))
  }],
  ['28 CSP report counts upsert per day, directive and origin', () => {
    const db = openDatabase()
    for (let index = 0; index < 3; index += 1) {
      run(db, CSP_UPSERT_SQL, '2026-10-01', 'script-src-elem', 'https://evil.example')
    }
    run(db, CSP_UPSERT_SQL, '2026-10-01', 'img-src', 'data')
    assert.deepEqual(
      all(db, 'SELECT directive, count FROM csp_report_counts ORDER BY directive').map((row) => [row.directive, row.count]),
      [['img-src', 1], ['script-src-elem', 3]],
    )
  }],
  // Fix round 1: origin-only in the database too (TM-17), not just in the report route (W2-17). A path, a
  // trailing '/', a host without a scheme and anything a full URL adds (query, fragment, credentials, upper
  // case) are refused; an origin with a port and the route's keywords are accepted.
  ['29 CSP report counts refuse a path, a query, a fragment, credentials or upper case: origin or keyword only', () => {
    const db = openDatabase()
    for (const origin of [
      'https://evil.example/exfil/5eedb00c-0000-4000-8000-000000000007', 'https://evil.example/', 'https://evil.example/p?q=1',
      'evil.example/path', 'evil.example', '5eedb00c-0000-4000-8000-000000000007', 'https://', '://evil.example',
      'https:///evil.example', 'http2://evil.example', 'https://evil.example#x', 'https://user@evil.example',
      'HTTPS://EVIL.EXAMPLE', `https://${'x'.repeat(113)}`, 'x'.repeat(41),
    ]) {
      assert.throws(() => run(db, CSP_UPSERT_SQL, '2026-10-01', 'img-src', origin), CHECK, origin)
    }
    for (const origin of ['https://evil.example', 'https://cdn.evil.example:8443', 'wss://127.0.0.1:9000', 'inline', 'eval', 'data', 'blob', 'wasm-eval']) {
      assert.equal(run(db, CSP_UPSERT_SQL, '2026-10-01', 'img-src', origin), 1, origin)
    }
  }],
  ['30 CSP report counts refuse an upper-case or unknown-character directive', () => {
    const db = openDatabase()
    for (const directive of ['Script-Src', 'script_src', 'img-src;x']) {
      assert.throws(() => run(db, CSP_UPSERT_SQL, '2026-10-01', directive, 'https://evil.example'), CHECK, directive)
    }
  }],
  ['31 CSP report counts refuse an impossible date', () => {
    const db = openDatabase()
    for (const day of ['2026-02-30', '2026-13-01', '01-10-2026']) {
      assert.throws(() => run(db, CSP_UPSERT_SQL, day, 'img-src', 'https://evil.example'), CHECK, day)
    }
  }],
  ['32 DELETE on booking_status_history aborts', () => {
    const db = fixture()
    addBooking(db, 'booking-history')
    assert.throws(() => run(db, 'DELETE FROM booking_status_history'), /APPEND_ONLY_BOOKING_STATUS_HISTORY/)
  }],
  ['33 DELETE on booking_events aborts', () => {
    const db = fixture()
    addBooking(db, 'booking-events')
    addEvent(db, 'booking-events', 'deposit_notice_sent')
    assert.throws(() => run(db, 'DELETE FROM booking_events'), /APPEND_ONLY_BOOKING_EVENTS/)
  }],
  ['34 deleting a booking would cascade into its history or events, so it aborts and nothing is removed', () => {
    const db = fixture()
    addBooking(db, 'booking-history')
    assert.throws(() => run(db, "DELETE FROM booking_requests WHERE id = 'booking-history'"), /APPEND_ONLY_BOOKING_STATUS_HISTORY/)
    // A row written without its status history, so only the events cascade.
    insertRow(db, 'booking_requests', {
      id: 'booking-events', user_id: BRIDE, event_date: '2026-12-02', package_snapshot: '{}', estimated_total: 4000,
      created_at: at(-600), updated_at: at(-600),
    })
    addEvent(db, 'booking-events', 'deposit_notice_sent')
    assert.throws(() => run(db, "DELETE FROM booking_requests WHERE id = 'booking-events'"), /APPEND_ONLY_BOOKING_EVENTS/)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM booking_requests'), 2)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM booking_status_history'), 1)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM booking_events'), 1)
  }],
  ['35 event redaction still works with the no-delete trigger', () => {
    const db = fixture()
    addBooking(db, 'booking-events')
    addEvent(db, 'booking-events', 'internal_notes_updated', { actor: 'admin', actor_uid: ADMIN, note: 'ملاحظة داخلية' })
    assert.equal(run(db, 'UPDATE booking_events SET note = NULL, redacted_at = ?', at(1)), 1)
  }],
  ['36 a notice for the current deadline protects an overdue hold; one for an earlier deadline does not (N-50)', () => {
    const db = fixture()
    addHold(db, 'hold-protected', '2026-12-01', at(-60))
    addHold(db, 'hold-old-notice', '2026-12-02', at(-60))
    addHold(db, 'hold-no-notice', '2026-12-03', at(-60))
    addHold(db, 'hold-running', '2026-12-04', at(60))
    addEvent(db, 'hold-protected', 'deposit_notice_sent', { details: JSON.stringify({ holdExpiresAt: at(-60) }) })
    addEvent(db, 'hold-old-notice', 'deposit_notice_sent', { details: JSON.stringify({ holdExpiresAt: at(-3000) }) })
    assert.deepEqual(all(db, EXPIRABLE_HOLDS_SQL, at(0)).map((row) => row.id), ['hold-no-notice', 'hold-old-notice'])
  }],
  ['37 extend_hold applies once; a stale second attempt changes 0 rows', () => {
    const db = fixture()
    addHold(db, 'hold-extend', '2026-12-01', at(60))
    assert.equal(run(db, EXTEND_HOLD_SQL, at(24 * 60), at(0), 'hold-extend', at(60)), 1)
    assert.equal(run(db, EXTEND_HOLD_SQL, at(48 * 60), at(1), 'hold-extend', at(60)), 0)
    assert.equal(scalar(db, 'SELECT hold_expires_at FROM booking_requests'), at(24 * 60))
  }],
  ['38 reinstate_hold fails on a date held by another booking and succeeds on a free date (N-51)', () => {
    const db = fixture()
    addBooking(db, 'expired-taken', { eventDate: '2026-12-01', status: 'expired', flow: 2, deposit: 1000 })
    addHold(db, 'hold-other', '2026-12-01', at(60), { userId: OTHER_BRIDE })
    addBooking(db, 'expired-free', { eventDate: '2026-12-02', status: 'expired', flow: 2, deposit: 1000 })
    assert.throws(() => run(db, REINSTATE_HOLD_SQL, at(48 * 60), at(0), 'expired-taken'), UNIQUE)
    assert.equal(run(db, REINSTATE_HOLD_SQL, at(48 * 60), at(0), 'expired-free'), 1)
  }],
  ['39 the open-request cap inside the INSERT admits the third open request and refuses the fourth', () => {
    const db = fixture()
    const today = '2026-10-01'
    addBooking(db, 'past-open', { eventDate: '2026-09-01' })
    addBooking(db, 'confirmed', { eventDate: '2026-11-01', status: 'confirmed' })
    for (const [id, date] of [['open-1', '2026-12-01'], ['open-2', '2026-12-02'], ['open-3', '2026-12-03']]) {
      assert.equal(run(db, CAPPED_BOOKING_INSERT_SQL, id, BRIDE, date, at(0), today), 1, id)
    }
    assert.equal(run(db, CAPPED_BOOKING_INSERT_SQL, 'open-4', BRIDE, '2026-12-04', at(0), today), 0)
    assert.equal(run(db, CAPPED_BOOKING_INSERT_SQL, 'other-1', OTHER_BRIDE, '2026-12-04', at(0), today), 1)
  }],
  ['40 a capacity decrease below the scheduled handovers changes 0 rows', () => {
    const db = fixture()
    const slot = addSlot(db, 1, { capacity: 3 })
    addReadyBooking(db, 'ready-1', BRIDE, '2026-08-01')
    addReadyBooking(db, 'ready-2', OTHER_BRIDE, '2026-08-02')
    addHandover(db, 'ready-1', slot)
    addHandover(db, 'ready-2', slot)
    assert.equal(run(db, DECREASE_CAPACITY_SQL, 1, at(0), slot), 0)
    assert.equal(run(db, DECREASE_CAPACITY_SQL, 2, at(0), slot), 1)
  }],
  ['41 the re-book count excludes the booking\'s own row', () => {
    const db = fixture()
    const full = addSlot(db, 1, { capacity: 1 })
    addReadyBooking(db, 'ready-1', BRIDE, '2026-08-01')
    addReadyBooking(db, 'ready-2', OTHER_BRIDE, '2026-08-02')
    addHandover(db, 'ready-1', full)
    addHandover(db, 'ready-2', addSlot(db, 2), { status: 'no_show' })
    assert.equal(run(db, REASSIGN_SQL, full, at(0), 'ready-1'), 1)
    assert.equal(run(db, REASSIGN_SQL, full, at(0), 'ready-2'), 0)
  }],
  ['42 the targeted expiry before an approval spares a protected hold, so the date stays taken (N-30b)', () => {
    const sweepThenApprove = (protectedHold) => {
      const db = fixture()
      addHold(db, 'hold-first', '2026-12-01', at(-60))
      if (protectedHold) {
        addEvent(db, 'hold-first', 'deposit_notice_sent', { details: JSON.stringify({ holdExpiresAt: at(-60) }) })
      }
      addBooking(db, 'request-second', { userId: OTHER_BRIDE, eventDate: '2026-12-01' })
      const swept = run(db, TARGETED_EXPIRY_HISTORY_SQL, '2026-12-01', at(0))
      assert.equal(run(db, TARGETED_EXPIRY_UPDATE_SQL, '2026-12-01', at(0)), swept)
      const approve = () => run(
        db,
        "UPDATE booking_requests SET status = 'approved_hold', flow_version = 2, deposit_amount = 500, hold_expires_at = ? WHERE id = 'request-second'",
        at(48 * 60),
      )
      return { db, swept, approve }
    }

    const kept = sweepThenApprove(true)
    assert.equal(kept.swept, 0)
    assert.throws(kept.approve, UNIQUE)
    assert.equal(scalar(kept.db, "SELECT status FROM booking_requests WHERE id = 'hold-first'"), 'approved_hold')

    const freed = sweepThenApprove(false)
    assert.equal(freed.swept, 1)
    assert.equal(freed.approve(), 1)
    assert.equal(scalar(freed.db, "SELECT status FROM booking_requests WHERE id = 'hold-first'"), 'expired')
  }],
]

// ---------------------------------------------------------------------------
// 0009 section 7 — an INSERT cannot rewrite an append-only row (fix round 1;
// beyond the plan's §2.5 list, recorded in d1/0008-0009-verification.md).
// INSERT OR REPLACE deletes the row with the same key without running its
// DELETE triggers (recursive_triggers is off, as in D1), so without section 7
// every rewrite below succeeds.
// ---------------------------------------------------------------------------

/** Every row of `table` with its rowid, to show that a refused write changed nothing. */
function snapshot(db, table) {
  return all(db, `SELECT rowid AS row_id, * FROM ${table} ORDER BY rowid`)
}

/** Each conflict clause, on a copy of the row that `key` selects. */
function conflictingCopies(table, key) {
  const copy = `INTO ${table} SELECT * FROM ${table} WHERE ${key}`

  return [
    `INSERT OR REPLACE ${copy}`,
    `REPLACE ${copy}`,
    `INSERT OR IGNORE ${copy}`,
    `INSERT ${copy}`,
    `INSERT ${copy} ON CONFLICT DO NOTHING`,
    `INSERT ${copy} ON CONFLICT DO UPDATE SET created_at = excluded.created_at`,
  ]
}

const TERMS_COLUMNS = 'version, seq, body, body_sha256, change_summary, created_by, reauth_at, created_at'
const EVENT_COLUMNS = 'id, booking_id, actor, actor_uid, event, subject_id, details, note, created_at, redacted_at'

const replaceGuardCases = [
  {
    table: 'settings_revisions',
    error: /APPEND_ONLY_SETTINGS_REVISIONS/,
    key: 'id = 1',
    add: (db) => addRevision(db, 'bank'),
    append: (db) => addRevision(db, 'pickup'),
    // The effective bank row would take another IBAN and keep its created_at: no 24 h delay (TM-03).
    rewrites: [`
      INSERT OR REPLACE INTO settings_revisions (id, section, bank_name, bank_account_holder, bank_iban, created_by, reauth_at, created_at)
      SELECT id, section, bank_name, bank_account_holder, 'SA9999999999999999999999', created_by, reauth_at, created_at
      FROM settings_revisions WHERE id = 1`],
  },
  {
    table: 'terms_versions',
    error: /APPEND_ONLY_TERMS_VERSIONS/,
    key: "version = 'v1'",
    add: (db) => publishTerms(db),
    append: (db) => publishTerms(db, `${TERMS_BODY} (نسخة ثانية)`),
    rewrites: [
      // The body a customer accepted.
      `REPLACE INTO terms_versions (${TERMS_COLUMNS})
       SELECT version, seq, body || ' بند مضاف.', body_sha256, change_summary, created_by, reauth_at, created_at
       FROM terms_versions WHERE version = 'v1'`,
      // Each key on its own: the guard refuses these before the version = 'v' || seq CHECK would.
      `INSERT OR REPLACE INTO terms_versions (${TERMS_COLUMNS})
       SELECT version, 9, body, body_sha256, change_summary, created_by, reauth_at, created_at
       FROM terms_versions WHERE version = 'v1'`,
      `INSERT OR REPLACE INTO terms_versions (${TERMS_COLUMNS})
       SELECT 'v9', seq, body, body_sha256, change_summary, created_by, reauth_at, created_at
       FROM terms_versions WHERE version = 'v1'`,
      // A new version and seq on v1's rowid would delete v1 without a trace.
      `INSERT OR REPLACE INTO terms_versions (rowid, ${TERMS_COLUMNS})
       SELECT rowid, 'v2', 2, body, body_sha256, change_summary, created_by, reauth_at, created_at
       FROM terms_versions WHERE version = 'v1'`,
    ],
  },
  {
    table: 'admin_audit_log',
    error: /APPEND_ONLY_ADMIN_AUDIT_LOG/,
    key: 'id = 1',
    add: (db) => addAudit(db),
    append: (db) => addAudit(db, { action: 'settings_deposit_updated' }),
    rewrites: [`
      INSERT OR REPLACE INTO admin_audit_log (id, actor_uid, action, target_id, details, reauth_at, created_at)
      SELECT id, actor_uid, 'bookings_exported', target_id, details, reauth_at, created_at
      FROM admin_audit_log WHERE id = 1`],
  },
  {
    table: 'booking_status_history',
    error: /APPEND_ONLY_BOOKING_STATUS_HISTORY/,
    key: 'id = 1',
    add: (db) => addBooking(db, 'booking-history'),
    append: (db) => insertRow(db, 'booking_status_history', {
      booking_id: 'booking-history', from_status: 'pending_review', to_status: 'rejected', changed_by: ADMIN,
      note: null, created_at: at(1),
    }),
    // Another transition, attributed to the admin, with a note.
    rewrites: [`
      INSERT OR REPLACE INTO booking_status_history (id, booking_id, from_status, to_status, changed_by, note, created_at)
      SELECT id, booking_id, 'approved_hold', 'rejected', '${ADMIN}', 'ملاحظة لاحقة', created_at
      FROM booking_status_history WHERE id = 1`],
  },
  {
    table: 'booking_events',
    error: /APPEND_ONLY_BOOKING_EVENTS/,
    key: 'id = 1',
    add: (db) => {
      addBooking(db, 'booking-events')
      addEvent(db, 'booking-events', 'internal_notes_updated', { actor: 'admin', actor_uid: ADMIN, note: 'ملاحظة داخلية' })
      run(db, 'UPDATE booking_events SET note = NULL, redacted_at = ? WHERE id = 1', at(1))
    },
    append: (db) => addEvent(db, 'booking-events', 'deposit_notice_sent'),
    rewrites: [
      // Un-redacting the note, then turning the event into another kind by another actor.
      `INSERT OR REPLACE INTO booking_events (${EVENT_COLUMNS})
       SELECT id, booking_id, actor, actor_uid, event, subject_id, details, 'ملاحظة داخلية', created_at, NULL
       FROM booking_events WHERE id = 1`,
      `REPLACE INTO booking_events (${EVENT_COLUMNS})
       SELECT id, booking_id, 'system', NULL, 'receipt_verified', subject_id, details, note, created_at, redacted_at
       FROM booking_events WHERE id = 1`,
    ],
  },
  {
    table: 'ops_switch_revisions',
    error: /APPEND_ONLY_OPS_SWITCH_REVISIONS/,
    key: 'id = 1',
    add: (db) => insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'off', created_by: ADMIN, created_at: at(0) }),
    append: (db) => insertRow(db, 'ops_switch_revisions', { switch_name: 'online_confirmation', state: 'off', created_by: ADMIN, created_at: at(1) }),
    // The recorded "off" would read as "on" (with a re-auth stamp the row never had).
    rewrites: [`
      INSERT OR REPLACE INTO ops_switch_revisions (id, switch_name, state, note, created_by, reauth_at, created_at)
      SELECT id, switch_name, 'on', note, created_by, created_at, created_at
      FROM ops_switch_revisions WHERE id = 1`],
  },
]

// ---------------------------------------------------------------------------
// §2.3 — the plan's runtime statements prepare against 0001–0009, and the
// capacity/IDOR predicate is executed
// ---------------------------------------------------------------------------

const runtimeStatements = [
  ['search with LIKE … ESCAPE', `
    SELECT b.id FROM booking_requests AS b INNER JOIN users AS u ON u.id = b.user_id
    WHERE u.first_name LIKE ?1 ESCAPE '\\' OR u.last_name LIKE ?1 ESCAPE '\\' OR u.phone LIKE ?1 ESCAPE '\\'
    ORDER BY b.created_at DESC, b.id DESC LIMIT 20`],
  ['targeted expiry: status history', TARGETED_EXPIRY_HISTORY_SQL],
  ['targeted expiry: update', TARGETED_EXPIRY_UPDATE_SQL],
  ['capacity-guarded handover insert', BOOK_PICKUP_SQL],
  ['queue: deposit notices for the current deadline', `
    SELECT b.id, b.hold_expires_at FROM booking_requests AS b
    INNER JOIN booking_events AS e ON e.booking_id = b.id AND e.event = 'deposit_notice_sent'
      AND json_extract(e.details, '$.holdExpiresAt') = b.hold_expires_at
    WHERE b.status = 'approved_hold' AND b.flow_version = 2 ORDER BY b.hold_expires_at, b.id`],
  ['queue: bank details changed since acceptance', `
    SELECT b.id FROM booking_requests AS b
    WHERE b.bank_revision_id IS NOT NULL AND b.status IN ('approved_hold', 'payment_pending')
      AND b.bank_revision_id <> COALESCE((SELECT id FROM settings_revisions WHERE section = 'bank'
        AND COALESCE(effective_at, created_at) <= ?1 ORDER BY id DESC LIMIT 1), 0)`],
  ['calendar month', `
    SELECT event_date, 'booking' AS kind, id FROM booking_requests WHERE event_date BETWEEN ?1 AND ?2
      AND status IN ('pending_review', 'approved_hold', 'contract_pending', 'contract_signed', 'payment_pending', 'confirmed')
    UNION ALL
    SELECT event_date, 'blocked', NULL FROM blocked_dates WHERE event_date BETWEEN ?1 AND ?2
    ORDER BY 1, 2`],
  ['current settings per section', `
    SELECT s.* FROM settings_revisions AS s
    WHERE s.id = (SELECT id FROM settings_revisions AS r WHERE r.section = s.section
      AND COALESCE(r.effective_at, r.created_at) <= ?1 ORDER BY r.id DESC LIMIT 1)`],
  ['timeline UNION ALL', `
    SELECT 'status' AS source, created_at, to_status AS what FROM booking_status_history WHERE booking_id = ?1
    UNION ALL
    SELECT 'event', created_at, event FROM booking_events WHERE booking_id = ?1
    ORDER BY 2, 1`],
  ['customers directory with keyset', `
    SELECT u.id, u.created_at, COUNT(b.id) AS bookings FROM users AS u
    LEFT JOIN booking_requests AS b ON b.user_id = u.id
    WHERE u.role = 'customer' AND (u.created_at, u.id) < (?1, ?2)
    GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC LIMIT 50`],
  ['consent upsert', `
    INSERT INTO booking_consents (booking_id, purpose, granted, text_version, created_at, updated_at)
    VALUES (?1, 'publish_photos', ?2, ?3, ?4, ?4)
    ON CONFLICT (booking_id, purpose) DO UPDATE SET granted = excluded.granted,
      text_version = excluded.text_version, updated_at = excluded.updated_at
    WHERE booking_consents.granted <> excluded.granted`],
]

describe('0008_golive_admin_settings.sql — plan 11 §2.3 (56 checks)', () => {
  test('the list holds exactly 56 checks', () => {
    assert.equal(settingsChecks.length, 56)
  })

  for (const [name, check] of settingsChecks) {
    test(name, check)
  }
})

describe('0009_golive_hardening.sql — plan 11 §2.5 (42 checks)', () => {
  test('the list holds exactly 42 checks', () => {
    assert.equal(hardeningChecks.length, 42)
  })

  for (const [name, check] of hardeningChecks) {
    test(name, check)
  }
})

describe('0009_golive_hardening.sql section 7 — no rewrite through INSERT OR REPLACE (fix round 1)', () => {
  test('recursive_triggers is off, as in D1, so a REPLACE runs no DELETE trigger', () => {
    assert.equal(scalar(openDatabase(), 'PRAGMA recursive_triggers'), 0)
  })

  for (const { table, error, key, add, append, rewrites } of replaceGuardCases) {
    test(`${table}: an INSERT that names an existing key aborts and changes nothing; a normal INSERT still appends`, () => {
      const db = fixture()
      add(db)
      const before = snapshot(db, table)
      assert.equal(before.length, 1)
      for (const sql of [...rewrites, ...conflictingCopies(table, key)]) {
        assert.throws(() => run(db, sql), error, sql)
        assert.deepEqual(snapshot(db, table), before, sql)
      }
      append(db)
      assert.deepEqual(snapshot(db, table).slice(0, 1), before)
      assert.equal(snapshot(db, table).length, 2)
    })
  }

  test('REPLACE of a booking cannot drop its history or events: the foreign-key cascade meets the no-delete triggers', () => {
    const db = fixture()
    addBooking(db, 'booking-history')
    // A row written without its status history, so only the events cascade (as in §2.5 check 34).
    insertRow(db, 'booking_requests', {
      id: 'booking-events', user_id: BRIDE, event_date: '2026-12-02', package_snapshot: '{}', estimated_total: 4000,
      created_at: at(-600), updated_at: at(-600),
    })
    addEvent(db, 'booking-events', 'deposit_notice_sent')
    const replace = `
      INSERT OR REPLACE INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'pending_review', '{}', 4000, ?4, ?4)`
    assert.throws(() => run(db, replace, 'booking-history', BRIDE, '2026-12-01', at(0)), /APPEND_ONLY_BOOKING_STATUS_HISTORY/)
    assert.throws(() => run(db, replace, 'booking-events', BRIDE, '2026-12-02', at(0)), /APPEND_ONLY_BOOKING_EVENTS/)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM booking_status_history'), 1)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM booking_events'), 1)
    assert.deepEqual(all(db, 'SELECT created_at FROM booking_requests ORDER BY id').map((row) => row.created_at), [at(-600), at(-600)])
  })
})

// ---------------------------------------------------------------------------
// 0009 section 7 — no key outside the table's sequence (fix round 2). A
// BEFORE INSERT trigger reads an unassigned key as -1, so a row stored at -1
// would make every later INSERT look like a rewrite; a row at the top of the
// 64-bit range would make every later INSERT fail with SQLITE_FULL. Neither
// row could be deleted. Without the key-range guards each poisoned key below
// is accepted and the normal INSERT after it fails.
// ---------------------------------------------------------------------------

const KEY_JUMP = 1_000_000_000
const LARGEST_KEY = 9223372036854775807n

/** A copy of the first row under an explicit key (terms: with the next version and seq). */
function explicitKeyCopy(db, table, conflict = '') {
  const key = table === 'terms_versions' ? 'rowid' : 'id'
  const nextSeq = '(SELECT MAX(seq) + 1 FROM terms_versions)'
  const values = all(db, `PRAGMA table_info(${table})`)
    .map((column) => column.name)
    .filter((name) => name !== 'id')
    .map((name) => {
      if (table === 'terms_versions' && name === 'version') {
        return ['version', `'v' || ${nextSeq}`]
      }

      return table === 'terms_versions' && name === 'seq' ? ['seq', nextSeq] : [name, name]
    })
  const insert = conflict === 'upsert' ? 'INSERT' : `INSERT${conflict}`
  const upsert = conflict === 'upsert' ? ' ON CONFLICT DO NOTHING' : ''

  return `${insert} INTO ${table} (${key}, ${values.map(([name]) => name).join(', ')})
    SELECT ?, ${values.map(([, value]) => value).join(', ')} FROM ${table} WHERE rowid = (SELECT MIN(rowid) FROM ${table})${upsert}`
}

function lastKey(db, table) {
  return Number(scalar(db, `SELECT MAX(rowid) FROM ${table}`))
}

describe('0009_golive_hardening.sql section 7 — no key outside the key sequence (fix round 2)', () => {
  for (const { table, error, add, append } of replaceGuardCases) {
    test(`${table}: an explicit key of -1, 0, the 64-bit maximum or a jump of more than 1e9 aborts; normal INSERTs still append`, () => {
      const db = fixture()
      add(db)
      const before = snapshot(db, table)
      assert.equal(before.length, 1)
      for (const conflict of ['', ' OR IGNORE', ' OR REPLACE', 'upsert']) {
        const sql = explicitKeyCopy(db, table, conflict)
        for (const key of [-1, 0, LARGEST_KEY, lastKey(db, table) + KEY_JUMP + 1]) {
          assert.throws(() => run(db, sql, key), error, `${sql} [${key}]`)
          assert.deepEqual(snapshot(db, table), before, `${sql} [${key}]`)
        }
      }
      // The refused keys left nothing behind: the next INSERT gets the next key.
      append(db)
      assert.equal(lastKey(db, table), 2)
      // A jump of exactly 1e9 is inside the bound, and the key after it is assigned normally.
      assert.equal(run(db, explicitKeyCopy(db, table), 2 + KEY_JUMP), 1)
      append(db)
      assert.deepEqual(snapshot(db, table).map((row) => row.row_id), [1, 2, 2 + KEY_JUMP, 3 + KEY_JUMP])
    })
  }
})

describe('plan 11 §2.3 runtime statements against 0001, 0003–0009', () => {
  for (const [name, sql] of runtimeStatements) {
    test(`prepares: ${name}`, () => {
      const db = fixture()
      assert.doesNotThrow(() => db.prepare(sql))
    })
  }

  test('LIKE … ESCAPE treats % in the search text as a literal', () => {
    const db = fixture()
    run(db, "UPDATE users SET first_name = 'نورة%' WHERE id = ?", BRIDE)
    run(db, "UPDATE users SET first_name = 'نورة أخرى' WHERE id = ?", OTHER_BRIDE)
    addBooking(db, 'booking-percent')
    addBooking(db, 'booking-plain', { userId: OTHER_BRIDE, eventDate: '2026-12-02' })
    const search = runtimeStatements[0][1]
    assert.deepEqual(all(db, search, '%نورة\\%%').map((row) => row.id), ['booking-percent'])
    assert.equal(all(db, search, '%نورة%%').length, 2)
  })

  test('a capacity-1 slot accepts exactly one handover; another customer\'s uid inserts 0 rows (IDOR)', () => {
    const db = fixture()
    const slot = addSlot(db, 1, { capacity: 1, method: 'pickup' })
    addReadyBooking(db, 'ready-1', BRIDE, '2026-08-01')
    addReadyBooking(db, 'ready-2', OTHER_BRIDE, '2026-08-02')
    assert.equal(run(db, BOOK_PICKUP_SQL, 'ready-1', OTHER_BRIDE, slot, at(0)), 0)
    assert.equal(run(db, BOOK_PICKUP_SQL, 'ready-1', BRIDE, slot, at(0)), 1)
    assert.equal(run(db, BOOK_PICKUP_SQL, 'ready-2', OTHER_BRIDE, slot, at(0)), 0)
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM handovers'), 1)
  })
})
