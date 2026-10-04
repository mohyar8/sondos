// W1-09 / SB-10, SB-13, M1: the admin audit writer (worker/audit/admin-audit.ts)
// and its vocabulary and details allowlist (shared/audit.ts). The action list
// is compared with the admin_audit_actions rows of the repository's own
// migrations, and every statement runs against a database built from them
// (node:sqlite, foreign keys on, as in D1) through a small stand-in for the
// D1 API: prepare().bind(), run(), and batch() as one transaction that rolls
// back on the first failure. Each case fails if its control (the SQL clock,
// the changes() guard, the revision check, a value check, the size cap, the
// nominal entry type, the placement check) is taken out.
//
// Placement: an after_write action is recorded only by auditAfterWrite, right
// after its one write (here a stand-in with the handler's condition, since the
// handlers land in W2 and W3); a standalone action only by auditStatement.
//
// Binding note: node:sqlite binds every number as REAL, so the stand-in binds
// safe integers as BigInt, as D1 binds a whole JavaScript number as INTEGER.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import {
  ADMIN_AUDIT_DETAILS_MAX_LENGTH,
  adminAuditActions,
  adminAuditPlacements,
  adminAuditScriptActions,
  adminSessionsRevokedAudit,
  blockedDateCreatedAudit,
  blockedDateDeletedAudit,
  bookingsExportedAudit,
  deliveryAreaCreatedAudit,
  deliveryAreaUpdatedAudit,
  gallerySelectionExportedAudit,
  handoverSlotCreatedAudit,
  handoverSlotDeletedAudit,
  handoverSlotUpdatedAudit,
  handoverSlotsGeneratedAudit,
  isAdminAuditAction,
  isAdminAuditEntry,
  isAuditInstant,
  onlineConfirmationSwitchedAudit,
  receiptViewedAudit,
  serializeAdminAuditDetails,
  settingsUpdatedAudit,
  termsPublishedAudit,
} from '../shared/audit.ts'
import { auditAfterWrite, auditStatement } from '../worker/audit/admin-audit.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
const CHECK = /CHECK constraint failed/
const AUDIT_REFUSED = /NOT NULL constraint failed: admin_audit_log\.action/

const ADMIN = 'AdminUid0001'
const CUSTOMER = 'CustomerUid0001'
const BOOKING_ID = '5eedb00c-0000-4000-8000-000000000001'
const SLOT_ID = '5eed5107-0000-4000-8000-000000000001'
const AREA_ID = '5eedaa00-0000-4000-8000-000000000001'
const GALLERY_ID = '5eed9a11-0000-4000-8000-000000000001'
const SHA256 = 'a'.repeat(64)
const STARTS_AT = '2026-11-20T13:00:00.000Z'
const ENDS_AT = '2026-11-20T14:00:00.000Z'
const MINUTE_MS = 60 * 1000

/** A recent sign-in: one minute before the real clock. */
function recentReauth() {
  return new Date(Date.now() - MINUTE_MS).toISOString()
}

// ---------------------------------------------------------------------------
// Database and D1 stand-in
// ---------------------------------------------------------------------------

function sqlValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

/** A fresh database with every repository migration, in wrangler's order, and one admin. */
function openDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => MIGRATION_FILE.test(file)).sort()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
  }

  const addUser = db.prepare(
    `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
     VALUES (?, ?, 'اسم', 'تجريبي', '+447700900000', ?, '2026-01-01T00:00:00.000Z')`,
  )

  addUser.run(ADMIN, 'admin@example.test', 'admin')
  addUser.run(CUSTOMER, 'customer@example.test', 'customer')

  return db
}

/** prepare().bind(), run() and batch() over node:sqlite; `bound` lists every bound statement. */
function createD1(db) {
  const bound = []

  function execute(statement) {
    const info = db.prepare(statement.sql).run(...statement.values.map(sqlValue))

    return { success: true, meta: { changes: Number(info.changes) } }
  }

  function statement(sql, values) {
    const prepared = {
      sql,
      values,
      bind(...next) {
        const result = statement(sql, next)
        bound.push(result)
        return result
      },
      async run() {
        return execute(prepared)
      },
    }

    return prepared
  }

  return {
    bound,
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      db.exec('BEGIN')

      try {
        const results = statements.map(execute)
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

function auditRows(db) {
  return db.prepare('SELECT * FROM admin_audit_log ORDER BY id').all()
}

function count(db, table) {
  return Number(Object.values(db.prepare(`SELECT COUNT(*) FROM ${table}`).get())[0])
}

/** Valid columns and values of each settings section (test data only). */
const SECTION_VALUES = {
  deposit: ['deposit_kind, deposit_fixed_amount, deposit_round_to', "'fixed', 1000, 1"],
  bank: ['bank_name, bank_account_holder, bank_iban', "'بنك تجريبي', 'صاحبة الحساب', 'SA0000000000000000000001'"],
  contact: ['whatsapp_number', "'966500000000'"],
  pickup: ['pickup_address', "'حي الملقا، الرياض'"],
}

/**
 * The settings revision INSERT a settings handler would batch (created_at by SQL, like the audit
 * row); `guardPasses: false` stands for the handler's own condition refusing the save.
 */
function revisionInsert(d1, section, { actor = ADMIN, reauthAt = recentReauth(), guardPasses = true } = {}) {
  const [columns, values] = SECTION_VALUES[section]

  return d1
    .prepare(
      `INSERT INTO settings_revisions (section, ${columns}, created_by, reauth_at, created_at)
       SELECT ?, ${values}, ?, ?, ${SQL_NOW}
       WHERE ? = 1`,
    )
    .bind(section, actor, reauthAt, guardPasses ? 1 : 0)
}

/** The kill-switch revision INSERT of PUT /api/admin/settings/switch. */
function switchInsert(d1, state, { actor = ADMIN, reauthAt = recentReauth() } = {}) {
  return d1
    .prepare(
      `INSERT INTO ops_switch_revisions (switch_name, state, note, created_by, reauth_at, created_at)
       VALUES ('online_confirmation', ?, NULL, ?, ?, ${SQL_NOW})`,
    )
    .bind(state, actor, reauthAt)
}

function addSlot(db, id, startsAt, endsAt) {
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO handover_slots (id, starts_at, ends_at, method, capacity, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'pickup', 1, 1, ?, ?)`,
  ).run(id, startsAt, endsAt, now, now)
}

/** A terms body the terms_versions CHECKs accept (test data only). */
const TERMS_BODY = 'نص تجريبي لاختبار سجل التدقيق فقط، وليس من شروط الحجز المعتمدة لدى المصورة.'

/**
 * The one write of each after_write action, as its handler would batch it right before the audit
 * row (test data only), with the condition that lets it change no row. `target` is the entry's.
 */
const AFTER_WRITES = {
  settings_deposit_updated: (d1, actor, target) => revisionInsert(d1, target.section, { reauthAt: actor.reauthAt }),
  settings_bank_updated: (d1, actor, target) => revisionInsert(d1, target.section, { reauthAt: actor.reauthAt }),
  settings_contact_updated: (d1, actor, target) => revisionInsert(d1, target.section, { reauthAt: actor.reauthAt }),
  settings_pickup_updated: (d1, actor, target) => revisionInsert(d1, target.section, { reauthAt: actor.reauthAt }),
  // Optimistic: only on top of the version before it (409 TERMS_VERSION_CONFLICT otherwise).
  terms_published: (d1, actor, target) => {
    const seq = Number(target.id.slice(1))

    return d1
      .prepare(
        `INSERT INTO terms_versions (version, seq, body, body_sha256, change_summary, created_by, reauth_at, created_at)
         SELECT ?, ?, ?, ?, NULL, ?, ?, ${SQL_NOW}
         WHERE (SELECT COALESCE(MAX(seq), 0) FROM terms_versions) = ?`,
      )
      .bind(target.id, seq, TERMS_BODY, SHA256, actor.uid, actor.reauthAt, seq - 1)
  },
  delivery_area_created: (d1, _actor, target) =>
    d1
      .prepare(
        `INSERT INTO delivery_areas (id, name, fee, is_active, sort_order, created_at, updated_at)
         VALUES (?, 'حي الياسمين', 50, 1, 1, ${SQL_NOW}, ${SQL_NOW})
         ON CONFLICT DO NOTHING`,
      )
      .bind(target.id),
  delivery_area_updated: (d1, _actor, target) =>
    d1.prepare(`UPDATE delivery_areas SET fee = 75, updated_at = ${SQL_NOW} WHERE id = ?`).bind(target.id),
  handover_slot_created: (d1, _actor, target) =>
    d1
      .prepare(
        `INSERT INTO handover_slots (id, starts_at, ends_at, method, capacity, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'pickup', 2, 1, ${SQL_NOW}, ${SQL_NOW})
         ON CONFLICT DO NOTHING`,
      )
      .bind(target.id, STARTS_AT, ENDS_AT),
  // The capacity rule: never below the handovers already booked on the slot.
  handover_slot_updated: (d1, _actor, target) =>
    d1
      .prepare(
        `UPDATE handover_slots SET capacity = 3, updated_at = ${SQL_NOW}
         WHERE id = ? AND (SELECT COUNT(*) FROM handovers WHERE slot_id = ?) <= 3`,
      )
      .bind(target.id, target.id),
  // Only a slot no handover references.
  handover_slot_deleted: (d1, _actor, target) =>
    d1
      .prepare('DELETE FROM handover_slots WHERE id = ? AND NOT EXISTS (SELECT 1 FROM handovers WHERE slot_id = ?)')
      .bind(target.id, target.id),
  blocked_date_created: (d1, actor, target) =>
    d1
      .prepare('INSERT INTO blocked_dates (event_date, reason, created_by) VALUES (?, NULL, ?) ON CONFLICT DO NOTHING')
      .bind(target.id, actor.uid),
  blocked_date_deleted: (d1, _actor, target) =>
    d1.prepare('DELETE FROM blocked_dates WHERE event_date = ?').bind(target.id),
  // Only while the account is still the admin.
  admin_sessions_revoked: (d1, actor) =>
    d1
      .prepare(
        "UPDATE users SET tokens_valid_after = CAST(strftime('%s', 'now') AS INTEGER) WHERE id = ? AND role = 'admin'",
      )
      .bind(actor.uid),
  online_confirmation_switched: (d1, actor, target) => switchInsert(d1, target.state, { reauthAt: actor.reauthAt }),
}

/** The stand-in write of an after_write entry. */
function standInWrite(d1, actor, entry) {
  return AFTER_WRITES[entry.action](d1, actor, entry.target)
}

/** `entry` recorded the only way its placement allows: after its write, or on its own. */
function recordStatements(d1, actor, entry) {
  return entry.placement === 'after_write'
    ? auditAfterWrite(d1, standInWrite(d1, actor, entry), actor, entry)
    : [auditStatement(d1, actor, entry)]
}

/** Every Worker builder once, with valid input. */
function oneEntryPerBuilder() {
  return [
    settingsUpdatedAudit('deposit'),
    settingsUpdatedAudit('bank'),
    settingsUpdatedAudit('contact'),
    settingsUpdatedAudit('pickup'),
    termsPublishedAudit({ version: 'v1', bodySha256: SHA256 }),
    deliveryAreaCreatedAudit(AREA_ID, { fee: 50, isActive: true, sortOrder: 1 }),
    deliveryAreaUpdatedAudit(AREA_ID, { fee: 75 }),
    handoverSlotCreatedAudit(SLOT_ID, { startsAt: STARTS_AT, endsAt: ENDS_AT, method: 'pickup', capacity: 2 }),
    handoverSlotsGeneratedAudit({
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      method: 'both',
      capacity: 1,
      created: 40,
      skipped: 2,
    }),
    handoverSlotUpdatedAudit(SLOT_ID, { capacity: 3 }),
    handoverSlotDeletedAudit(SLOT_ID, { startsAt: STARTS_AT, method: 'pickup' }),
    blockedDateCreatedAudit('2026-12-24'),
    blockedDateDeletedAudit('2026-12-24'),
    bookingsExportedAudit({ from: '2026-10-01', to: '2026-12-31', status: null, rows: 12 }),
    receiptViewedAudit(BOOKING_ID, { receipts: 2 }),
    gallerySelectionExportedAudit(BOOKING_ID, { galleryId: GALLERY_ID, photos: 60 }),
    adminSessionsRevokedAudit(),
    onlineConfirmationSwitchedAudit('off'),
  ]
}

/** Asserts `build` throws a TypeError whose message does not repeat `value`. */
function assertRefused(build, value) {
  assert.throws(build, (error) => {
    assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`)
    assert.ok(!error.message.includes(String(value)), 'the message must not repeat the value')
    return true
  })
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('action vocabulary (0008 + 0009)', () => {
  test('adminAuditActions is exactly the admin_audit_actions table, in migration order', () => {
    const db = openDatabase()
    const actions = db.prepare('SELECT action FROM admin_audit_actions ORDER BY rowid').all().map((row) => row.action)

    assert.equal(actions.length, 20)
    assert.deepEqual([...adminAuditActions], actions)
    assert.equal(new Set(adminAuditActions).size, adminAuditActions.length)
  })

  test('isAdminAuditAction accepts the vocabulary only', () => {
    for (const action of adminAuditActions) {
      assert.equal(isAdminAuditAction(action), true, action)
    }

    for (const value of ['settings_updated', 'ADMIN_PROMOTED', '', null, 7, {}]) {
      assert.equal(isAdminAuditAction(value), false, String(value))
    }
  })

  test('the Worker builders cover every action except the two promotion rows of scripts/promote-admin.mjs', () => {
    const built = new Set(oneEntryPerBuilder().map((entry) => entry.action))
    const expected = adminAuditActions.filter((action) => !adminAuditScriptActions.includes(action))

    assert.deepEqual([...adminAuditScriptActions], ['admin_promoted', 'admin_demoted'])
    assert.deepEqual([...built].sort(), [...expected].sort())
  })

  test('every Worker action has one placement, and only four are standalone', () => {
    const workerActions = adminAuditActions.filter((action) => !adminAuditScriptActions.includes(action))
    const placed = Object.keys(adminAuditPlacements)
    const byPlacement = (placement) => placed.filter((action) => adminAuditPlacements[action] === placement).sort()

    assert.ok(Object.isFrozen(adminAuditPlacements))
    assert.deepEqual(placed.sort(), [...workerActions].sort())
    assert.deepEqual(byPlacement('standalone'), [
      'bookings_exported',
      'gallery_selection_exported',
      'handover_slots_generated',
      'receipt_viewed',
    ])
    assert.deepEqual(Object.keys(AFTER_WRITES).sort(), byPlacement('after_write'))

    for (const entry of oneEntryPerBuilder()) {
      assert.equal(entry.placement, adminAuditPlacements[entry.action], entry.action)
    }
  })
})

// ---------------------------------------------------------------------------
// Details allowlist (SB-13)
// ---------------------------------------------------------------------------

describe('details builders (ids, counts, dates, codes only)', () => {
  test('each builder records its target and its allowlisted details', () => {
    const cases = [
      [settingsUpdatedAudit('bank'), 'settings_bank_updated', { kind: 'settings_revision', section: 'bank' }, { section: 'bank' }, true],
      [
        settingsUpdatedAudit('pickup'),
        'settings_pickup_updated',
        { kind: 'settings_revision', section: 'pickup' },
        { section: 'pickup' },
        true,
      ],
      [termsPublishedAudit({ version: 'v12', bodySha256: SHA256 }), 'terms_published', { kind: 'id', id: 'v12' }, { bodySha256: SHA256 }, true],
      [
        deliveryAreaUpdatedAudit(AREA_ID, { nameChanged: true, isActive: false }),
        'delivery_area_updated',
        { kind: 'id', id: AREA_ID },
        { changed: ['name', 'isActive'], isActive: false },
        false,
      ],
      [
        handoverSlotUpdatedAudit(SLOT_ID, { isActive: false }),
        'handover_slot_updated',
        { kind: 'id', id: SLOT_ID },
        { isActive: false },
        false,
      ],
      [blockedDateCreatedAudit('2026-12-24'), 'blocked_date_created', { kind: 'id', id: '2026-12-24' }, null, false],
      [
        bookingsExportedAudit({ from: '2026-10-01', to: '2026-10-31', status: 'confirmed', rows: 5000 }),
        'bookings_exported',
        { kind: 'none' },
        { from: '2026-10-01', to: '2026-10-31', status: 'confirmed', rows: 5000 },
        true,
      ],
      [
        gallerySelectionExportedAudit(BOOKING_ID, { galleryId: GALLERY_ID, photos: 45 }),
        'gallery_selection_exported',
        { kind: 'id', id: BOOKING_ID },
        { galleryId: GALLERY_ID, photos: 45 },
        false,
      ],
      [adminSessionsRevokedAudit(), 'admin_sessions_revoked', { kind: 'none' }, null, true],
      [onlineConfirmationSwitchedAudit('on'), 'online_confirmation_switched', { kind: 'switch_revision', state: 'on' }, { state: 'on' }, true],
      [onlineConfirmationSwitchedAudit('off'), 'online_confirmation_switched', { kind: 'switch_revision', state: 'off' }, { state: 'off' }, false],
    ]

    for (const [entry, action, target, details, reauthRequired] of cases) {
      assert.equal(entry.action, action)
      assert.deepEqual({ ...entry.target }, target, action)
      assert.deepEqual(entry.detailsJson === null ? null : JSON.parse(entry.detailsJson), details, action)
      assert.equal(entry.reauthRequired, reauthRequired, action)
      assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.target), action)
    }
  })

  test('properties outside the allowlist are never copied', () => {
    const personal = {
      name: 'نورة العتيبي',
      phone: '966512345678',
      email: 'bride@example.com',
      note: 'ملاحظة خاصة',
      iban: 'SA0000000000000000000001',
      address: 'حي الملقا، الرياض',
    }
    const entries = [
      deliveryAreaCreatedAudit(AREA_ID, { ...personal, fee: 50, isActive: true, sortOrder: 2 }),
      deliveryAreaUpdatedAudit(AREA_ID, { ...personal, nameChanged: true }),
      handoverSlotDeletedAudit(SLOT_ID, { ...personal, startsAt: STARTS_AT, method: 'pickup' }),
      bookingsExportedAudit({ ...personal, from: '2026-10-01', to: '2026-10-31', status: null, rows: 3 }),
      receiptViewedAudit(BOOKING_ID, { ...personal, receipts: 1 }),
      termsPublishedAudit({ ...personal, version: 'v1', bodySha256: SHA256 }),
    ]

    for (const entry of entries) {
      for (const value of Object.values(personal)) {
        assert.ok(!entry.detailsJson.includes(value), `${entry.action} copied a value outside its allowlist`)
      }

      for (const key of Object.keys(personal)) {
        assert.ok(!(key in JSON.parse(entry.detailsJson)), `${entry.action} copied "${key}"`)
      }
    }
  })

  test('personal data in an id, date, instant, count or code field is refused without being echoed', () => {
    const email = 'bride@example.com'
    const phone = '966512345678'
    const name = 'نورة العتيبي'

    assertRefused(() => receiptViewedAudit(email, { receipts: 1 }), email)
    assertRefused(() => receiptViewedAudit(phone, { receipts: 1 }), phone)
    assertRefused(() => receiptViewedAudit(BOOKING_ID.toUpperCase(), { receipts: 1 }), BOOKING_ID.toUpperCase())
    assertRefused(() => handoverSlotUpdatedAudit(name, { capacity: 1 }), name)
    assertRefused(() => gallerySelectionExportedAudit(BOOKING_ID, { galleryId: phone, photos: 1 }), phone)
    assertRefused(() => blockedDateCreatedAudit(name), name)
    assertRefused(() => blockedDateDeletedAudit('2026-02-30'), '2026-02-30')
    assertRefused(() => bookingsExportedAudit({ from: '٢٠٢٦-١٠-٠١', to: '2026-10-31', status: null, rows: 1 }), '٢٠٢٦')
    assertRefused(() => bookingsExportedAudit({ from: '2026-10-01', to: '2026-10-31', status: email, rows: 1 }), email)
    assertRefused(() => termsPublishedAudit({ version: email, bodySha256: SHA256 }), email)
    assertRefused(() => termsPublishedAudit({ version: 'v1', bodySha256: 'A'.repeat(64) }), 'A'.repeat(64))
    assertRefused(() => onlineConfirmationSwitchedAudit(name), name)
    assertRefused(() => settingsUpdatedAudit('iban'), 'iban')

    for (const instant of ['2026-11-20', '2026-11-20T13:00:00Z', '2026-11-20T13:00:00.000+03:00', '2026-02-30T13:00:00.000Z']) {
      assertRefused(
        () => handoverSlotCreatedAudit(SLOT_ID, { startsAt: instant, endsAt: ENDS_AT, method: 'pickup', capacity: 1 }),
        instant,
      )
    }

    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001, '3', null]) {
      assert.throws(() => receiptViewedAudit(BOOKING_ID, { receipts: bad }), TypeError, String(bad))
    }

    assert.throws(
      () => handoverSlotCreatedAudit(SLOT_ID, { startsAt: STARTS_AT, endsAt: ENDS_AT, method: 'pickup', capacity: 0 }),
      TypeError,
    )
    assert.throws(
      () => handoverSlotCreatedAudit(SLOT_ID, { startsAt: STARTS_AT, endsAt: ENDS_AT, method: 'courier', capacity: 1 }),
      TypeError,
    )
    assert.throws(() => deliveryAreaCreatedAudit(AREA_ID, { fee: 50, isActive: 'yes', sortOrder: 1 }), TypeError)
  })

  test('an update that changes nothing is refused', () => {
    assert.throws(() => deliveryAreaUpdatedAudit(AREA_ID, {}), TypeError)
    assert.throws(() => deliveryAreaUpdatedAudit(AREA_ID, { nameChanged: false }), TypeError)
    assert.throws(() => handoverSlotUpdatedAudit(SLOT_ID, {}), TypeError)
  })

  test('isAuditInstant accepts toISOString() output only', () => {
    assert.equal(isAuditInstant(new Date().toISOString()), true)

    for (const value of ['2026-11-20T13:00:00Z', '2026-11-20T24:00:00.000Z', '2026-11-20 13:00:00.000Z', '', null, 0]) {
      assert.equal(isAuditInstant(value), false, String(value))
    }
  })

  test(`serialised details are capped at ${ADMIN_AUDIT_DETAILS_MAX_LENGTH} characters before the database`, () => {
    // {"k":"…"} is 8 characters plus the value.
    const atCap = serializeAdminAuditDetails({ k: 'x'.repeat(ADMIN_AUDIT_DETAILS_MAX_LENGTH - 8) })

    assert.equal(ADMIN_AUDIT_DETAILS_MAX_LENGTH, 2_000)
    assert.equal(atCap.length, ADMIN_AUDIT_DETAILS_MAX_LENGTH)
    assert.throws(
      () => serializeAdminAuditDetails({ k: 'x'.repeat(ADMIN_AUDIT_DETAILS_MAX_LENGTH - 7) }),
      RangeError,
    )
    assert.equal(serializeAdminAuditDetails(null), null)
  })

  test('only a builder makes an entry: look-alikes are refused', () => {
    const genuine = receiptViewedAudit(BOOKING_ID, { receipts: 1 })
    const literal = {
      action: 'receipt_viewed',
      target: { kind: 'none' },
      reauthRequired: false,
      detailsJson: '{"email":"bride@example.com"}',
    }
    const prototypeCopy = Object.create(Object.getPrototypeOf(genuine), {
      action: { value: 'receipt_viewed' },
      target: { value: { kind: 'none' } },
      reauthRequired: { value: false },
    })

    assert.equal(isAdminAuditEntry(genuine), true)
    assert.equal(isAdminAuditEntry(literal), false)
    assert.equal(isAdminAuditEntry(prototypeCopy), false)

    const d1 = createD1(openDatabase())

    for (const forged of [literal, prototypeCopy]) {
      assert.throws(() => auditStatement(d1, { uid: ADMIN, reauthAt: null }, forged), TypeError)
      assert.throws(() => auditAfterWrite(d1, d1.prepare('SELECT 1'), { uid: ADMIN, reauthAt: null }, forged), TypeError)
    }

    assert.equal(d1.bound.length, 0)
  })
})

// ---------------------------------------------------------------------------
// Writer (SB-10, M1)
// ---------------------------------------------------------------------------

describe('auditStatement / auditAfterWrite', () => {
  test('created_at comes from SQLite: five bound values, none of them a time the Worker chose (M1)', async () => {
    const db = openDatabase()
    const d1 = createD1(db)
    const before = Date.now()
    const statement = auditStatement(d1, { uid: ADMIN, reauthAt: null }, receiptViewedAudit(BOOKING_ID, { receipts: 2 }))
    const result = await statement.run()
    const after = Date.now()

    assert.equal(result.meta.changes, 1)
    assert.ok(statement.sql.includes(SQL_NOW))
    assert.equal(statement.sql.match(/\?/g).length, 5)
    assert.deepEqual(statement.values, [ADMIN, 'receipt_viewed', BOOKING_ID, '{"receipts":2}', null])

    const [row] = auditRows(db)

    assert.equal(row.actor_uid, ADMIN)
    assert.equal(row.action, 'receipt_viewed')
    assert.equal(row.target_id, BOOKING_ID)
    assert.equal(row.details, '{"receipts":2}')
    assert.equal(row.reauth_at, null)
    assert.ok(isAuditInstant(row.created_at), row.created_at)
    assert.ok(Date.parse(row.created_at) >= before - 1_000 && Date.parse(row.created_at) <= after + 1_000)
  })

  test('a wrong Worker clock does not change created_at, on its own or after a write (M1)', async (t) => {
    const db = openDatabase()
    const d1 = createD1(db)
    const actor = { uid: ADMIN, reauthAt: null }
    const blocked = blockedDateCreatedAudit('2026-12-24')

    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2001-01-01T00:00:00.000Z') })

    try {
      assert.equal(new Date().getUTCFullYear(), 2001, 'the Worker clock is mocked')
      await auditStatement(d1, actor, receiptViewedAudit(BOOKING_ID, { receipts: 1 })).run()
      await d1.batch([...auditAfterWrite(d1, standInWrite(d1, actor, blocked), actor, blocked)])
    } finally {
      t.mock.timers.reset()
    }

    const rows = auditRows(db)

    assert.deepEqual(rows.map((row) => row.action), ['receipt_viewed', 'blocked_date_created'])

    for (const row of rows) {
      assert.ok(Math.abs(Date.parse(row.created_at) - Date.now()) < 60_000, row.created_at)
    }
  })

  test('a settings revision and its audit row commit together; the target is the new revision id', async () => {
    const db = openDatabase()
    const d1 = createD1(db)
    const actor = { uid: ADMIN, reauthAt: recentReauth() }

    // Two saves, so the target is the inserted row and not merely row 1.
    for (let save = 1; save <= 2; save += 1) {
      const pair = auditAfterWrite(d1, revisionInsert(d1, 'bank', { reauthAt: actor.reauthAt }), actor, settingsUpdatedAudit('bank'))
      const results = await d1.batch([...pair])

      assert.deepEqual(results.map((result) => result.meta.changes), [1, 1])
    }

    const revisionIds = db.prepare("SELECT id FROM settings_revisions WHERE section = 'bank' ORDER BY id").all()
    const rows = auditRows(db)
    const auditSql = d1.bound.at(-1).sql

    assert.equal(auditSql.match(/\?/g).length, 7)
    assert.ok(auditSql.includes('last_insert_rowid()') && auditSql.includes('changes() = 1') && auditSql.includes(SQL_NOW))
    assert.ok(auditSql.trimEnd().endsWith(`${SQL_NOW}\n  WHERE changes() <> 0`), 'created_at is the last column and never bound')
    assert.deepEqual(rows.map((row) => row.target_id), revisionIds.map((row) => String(row.id)))
    assert.deepEqual(rows.map((row) => row.action), ['settings_bank_updated', 'settings_bank_updated'])
    assert.deepEqual(rows.map((row) => row.details), ['{"section":"bank"}', '{"section":"bank"}'])
    assert.deepEqual(rows.map((row) => row.reauth_at), [actor.reauthAt, actor.reauthAt])
  })

  test('a switch revision is audited with its own id as the target', async () => {
    const db = openDatabase()
    const d1 = createD1(db)
    const write = switchInsert(d1, 'off', { reauthAt: null })

    await d1.batch([...auditAfterWrite(d1, write, { uid: ADMIN, reauthAt: null }, onlineConfirmationSwitchedAudit('off'))])

    const [row] = auditRows(db)
    const switchId = db.prepare('SELECT id FROM ops_switch_revisions').get().id

    assert.equal(row.target_id, String(switchId))
    assert.equal(row.details, '{"state":"off"}')
  })

  test('a write that changes no row leaves no audit row (no false, undeletable entry)', async () => {
    const db = openDatabase()
    const d1 = createD1(db)
    const actor = { uid: ADMIN, reauthAt: recentReauth() }

    // Earlier inserts on the connection must not satisfy the guard or lend their rowid.
    for (const entry of [
      settingsUpdatedAudit('bank'),
      blockedDateCreatedAudit('2026-12-24'),
      termsPublishedAudit({ version: 'v1', bodySha256: SHA256 }),
    ]) {
      const results = await d1.batch([...recordStatements(d1, actor, entry)])

      assert.deepEqual(results.map((result) => result.meta.changes), [1, 1], entry.action)
    }

    const missingSlot = handoverSlotUpdatedAudit(SLOT_ID, { capacity: 3 })
    const blockedAgain = blockedDateCreatedAudit('2026-12-24')
    const notBlocked = blockedDateDeletedAudit('2026-12-25')
    const termsAgain = termsPublishedAudit({ version: 'v1', bodySha256: SHA256 })
    const refused = [
      [
        'a settings save that changes nothing',
        revisionInsert(d1, 'bank', { reauthAt: actor.reauthAt, guardPasses: false }),
        settingsUpdatedAudit('bank'),
      ],
      ['an update of a missing slot', standInWrite(d1, actor, missingSlot), missingSlot],
      ['a date already blocked', standInWrite(d1, actor, blockedAgain), blockedAgain],
      ['a date that is not blocked', standInWrite(d1, actor, notBlocked), notBlocked],
      ['a terms version already published', standInWrite(d1, actor, termsAgain), termsAgain],
    ]

    for (const [name, write, entry] of refused) {
      const results = await d1.batch([...auditAfterWrite(d1, write, actor, entry)])

      assert.deepEqual(results.map((result) => result.meta.changes), [0, 0], name)
    }

    // Revoke-all after the account lost the admin role between the guard and the write.
    db.prepare("UPDATE users SET role = 'customer' WHERE id = ?").run(ADMIN)

    const revoked = await d1.batch([...recordStatements(d1, actor, adminSessionsRevokedAudit())])

    assert.deepEqual(revoked.map((result) => result.meta.changes), [0, 0])
    assert.equal(count(db, 'settings_revisions'), 1)
    assert.equal(count(db, 'terms_versions'), 1)
    assert.equal(count(db, 'blocked_dates'), 1)
    assert.deepEqual(auditRows(db).map((row) => row.action), ['settings_bank_updated', 'blocked_date_created', 'terms_published'])
  })

  test('an update that changes one row is audited with the explicit target', async () => {
    const db = openDatabase()
    const d1 = createD1(db)

    addSlot(db, SLOT_ID, STARTS_AT, ENDS_AT)

    const results = await d1.batch([
      ...auditAfterWrite(
        d1,
        d1.prepare('UPDATE handover_slots SET capacity = ? WHERE id = ?').bind(3, SLOT_ID),
        { uid: ADMIN, reauthAt: null },
        handoverSlotUpdatedAudit(SLOT_ID, { capacity: 3 }),
      ),
    ])
    const [row] = auditRows(db)
    const audit = d1.bound.at(-1)

    assert.deepEqual(results.map((result) => result.meta.changes), [1, 1])
    assert.equal(audit.sql.match(/\?/g).length, 5)
    assert.deepEqual(audit.values, [ADMIN, 'handover_slot_updated', SLOT_ID, '{"capacity":3}', null])
    assert.ok(audit.sql.trimEnd().endsWith(`${SQL_NOW}\n  WHERE changes() <> 0`), 'created_at is the last column and never bound')
    assert.equal(row.target_id, SLOT_ID)
    assert.equal(row.details, '{"capacity":3}')
    assert.ok(Math.abs(Date.parse(row.created_at) - Date.now()) < 60_000, row.created_at)
  })

  test('a write that changes more than one row fails the batch: nothing is committed', async () => {
    const db = openDatabase()
    const d1 = createD1(db)

    addSlot(db, SLOT_ID, STARTS_AT, ENDS_AT)
    addSlot(db, '5eed5107-0000-4000-8000-000000000002', '2026-11-21T13:00:00.000Z', '2026-11-21T14:00:00.000Z')

    const pair = auditAfterWrite(
      d1,
      d1.prepare('UPDATE handover_slots SET capacity = ?').bind(3),
      { uid: ADMIN, reauthAt: null },
      handoverSlotUpdatedAudit(SLOT_ID, { capacity: 3 }),
    )

    await assert.rejects(d1.batch([...pair]), AUDIT_REFUSED)
    assert.deepEqual(
      db.prepare('SELECT capacity FROM handover_slots ORDER BY id').all().map((row) => row.capacity),
      [1, 1],
    )
    assert.equal(count(db, 'admin_audit_log'), 0)
  })

  test('a revision entry after a write that did not insert that revision fails the batch', async () => {
    const db = openDatabase()
    const d1 = createD1(db)
    const actor = { uid: ADMIN, reauthAt: recentReauth() }

    // One audited bank save first: afterwards last_insert_rowid() is 1 (its audit row) and bank
    // revision 1 exists, so only the "not audited yet" check tells that stale id from a new one.
    await d1.batch([...auditAfterWrite(d1, revisionInsert(d1, 'bank', { reauthAt: actor.reauthAt }), actor, settingsUpdatedAudit('bank'))])
    addSlot(db, SLOT_ID, STARTS_AT, ENDS_AT)

    const cases = [
      ['another section', revisionInsert(d1, 'deposit', { reauthAt: actor.reauthAt }), settingsUpdatedAudit('bank')],
      ['another actor', revisionInsert(d1, 'bank', { actor: CUSTOMER, reauthAt: actor.reauthAt }), settingsUpdatedAudit('bank')],
      ['another table', switchInsert(d1, 'off', { reauthAt: actor.reauthAt }), settingsUpdatedAudit('pickup')],
      ['another state', switchInsert(d1, 'off', { reauthAt: actor.reauthAt }), onlineConfirmationSwitchedAudit('on')],
      [
        'an update, with an audited revision id still in last_insert_rowid()',
        d1.prepare('UPDATE handover_slots SET capacity = ? WHERE id = ?').bind(2, SLOT_ID),
        settingsUpdatedAudit('bank'),
      ],
    ]

    for (const [name, write, entry] of cases) {
      await assert.rejects(d1.batch([...auditAfterWrite(d1, write, actor, entry)]), AUDIT_REFUSED, name)
    }

    assert.equal(count(db, 'settings_revisions'), 1)
    assert.equal(count(db, 'ops_switch_revisions'), 0)
    assert.equal(count(db, 'admin_audit_log'), 1)
    assert.equal(db.prepare('SELECT capacity FROM handover_slots').get().capacity, 1)
  })

  test('a stale reauth_at is refused by the database and the whole batch rolls back', async () => {
    const db = openDatabase()
    const d1 = createD1(db)
    const stale = new Date(Date.now() - 11 * MINUTE_MS).toISOString()

    // The revision row alone would pass with a fresh value; the audit row carries the stale one.
    const pair = auditAfterWrite(d1, revisionInsert(d1, 'bank'), { uid: ADMIN, reauthAt: stale }, settingsUpdatedAudit('bank'))

    await assert.rejects(d1.batch([...pair]), CHECK)
    assert.equal(count(db, 'settings_revisions'), 0)
    assert.equal(count(db, 'admin_audit_log'), 0)
  })

  test('each entry is refused by the writer function its placement does not name, before any SQL', () => {
    const d1 = createD1(openDatabase())
    // A fresh sign-in and an admin uid, so only the placement rule can refuse.
    const actor = { uid: ADMIN, reauthAt: recentReauth() }
    const write = d1.prepare('SELECT 1')
    const entries = oneEntryPerBuilder()

    for (const entry of entries) {
      if (entry.placement === 'after_write') {
        assert.throws(
          () => auditStatement(d1, actor, entry),
          { name: 'TypeError', message: /only after its write, with auditAfterWrite/ },
          entry.action,
        )
      } else {
        assert.throws(
          () => auditAfterWrite(d1, write, actor, entry),
          { name: 'TypeError', message: /on its own, with auditStatement/ },
          entry.action,
        )
      }
    }

    assert.equal(entries.filter((entry) => entry.placement === 'after_write').length, 14)
    assert.equal(entries.filter((entry) => entry.placement === 'standalone').length, 4)
    assert.equal(d1.bound.length, 0)
  })

  test('refused before any SQL: missing reauth for a recent-sign-in action, bad reauthAt, non-admin uid', () => {
    const d1 = createD1(openDatabase())
    const write = d1.prepare('SELECT 1')
    const noReauth = { name: 'TypeError', message: /only with a recent sign-in time/ }

    assert.throws(
      () =>
        auditStatement(
          d1,
          { uid: ADMIN, reauthAt: null },
          bookingsExportedAudit({ from: '2026-10-01', to: '2026-10-31', status: null, rows: 1 }),
        ),
      noReauth,
    )

    for (const entry of [
      settingsUpdatedAudit('deposit'),
      termsPublishedAudit({ version: 'v1', bodySha256: SHA256 }),
      onlineConfirmationSwitchedAudit('on'),
      adminSessionsRevokedAudit(),
    ]) {
      assert.throws(() => auditAfterWrite(d1, write, { uid: ADMIN, reauthAt: null }, entry), noReauth, entry.action)
    }

    const receipt = receiptViewedAudit(BOOKING_ID, { receipts: 1 })

    for (const reauthAt of ['2026-10-01T09:00:00Z', 'yesterday', 1_760_000_000]) {
      assert.throws(() => auditStatement(d1, { uid: ADMIN, reauthAt }, receipt), TypeError, String(reauthAt))
    }

    for (const uid of ['admin@example.com', '', 'Admin Uid', 'a'.repeat(129), null]) {
      assertRefused(() => auditStatement(d1, { uid, reauthAt: null }, receipt), uid || 'placeholder-never-in-message')
    }

    assert.equal(d1.bound.length, 0)
  })

  test('every Worker entry inserts against the real schema (FK, CHECKs, vocabulary), after its write when it has one', async () => {
    const db = openDatabase()
    const d1 = createD1(db)
    const actor = { uid: ADMIN, reauthAt: recentReauth() }
    const entries = oneEntryPerBuilder()

    for (const entry of entries) {
      const results = await d1.batch([...recordStatements(d1, actor, entry)])

      assert.deepEqual(
        results.map((result) => result.meta.changes),
        entry.placement === 'after_write' ? [1, 1] : [1],
        entry.action,
      )
    }

    const rows = auditRows(db)

    assert.deepEqual(rows.map((row) => row.action), entries.map((entry) => entry.action))

    entries.forEach((entry, index) => {
      const { target } = entry
      const targetId = rows[index].target_id

      if (target.kind === 'id') {
        assert.equal(targetId, target.id, entry.action)
      } else if (target.kind === 'none') {
        assert.equal(targetId, null, entry.action)
      } else if (target.kind === 'settings_revision') {
        const revision = db.prepare('SELECT id FROM settings_revisions WHERE section = ?').get(target.section)

        assert.equal(targetId, String(revision.id), entry.action)
      } else {
        const revision = db.prepare('SELECT id FROM ops_switch_revisions WHERE state = ?').get(target.state)

        assert.equal(targetId, String(revision.id), entry.action)
      }

      assert.equal(rows[index].details, entry.detailsJson, entry.action)
      assert.equal(rows[index].reauth_at, actor.reauthAt, entry.action)
    })

    // Each write happened once: slot and date created, then removed; area created, then updated.
    assert.equal(count(db, 'settings_revisions'), 4)
    assert.equal(count(db, 'ops_switch_revisions'), 1)
    assert.equal(count(db, 'terms_versions'), 1)
    assert.equal(count(db, 'handover_slots'), 0)
    assert.equal(count(db, 'blocked_dates'), 0)
    assert.equal(db.prepare('SELECT fee FROM delivery_areas WHERE id = ?').get(AREA_ID).fee, 75)
    assert.notEqual(db.prepare('SELECT tokens_valid_after FROM users WHERE id = ?').get(ADMIN).tokens_valid_after, null)
  })
})
