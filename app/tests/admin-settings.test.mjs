// W2-01 / TM-03, TM-04, TM-12, TM-18, M1, H2, H3, GAP-03, GAP-05; SB-2…SB-4, SB-10, SB-14, SB-17:
// the admin settings API (worker/settings/admin-settings-handlers.ts over settings-write.ts), its
// alert email (worker/emails/admin-alert.ts) and migration 0010_business_identity.sql.
//
// The handlers run exactly as the dispatcher calls them (an authorised admin in the context),
// against a database built from the repository's own migrations (node:sqlite, foreign keys on, as
// in D1) through a small stand-in for the D1 API: prepare().bind(), all(), first(), run(), and
// batch() as one transaction that rolls back on the first failure. created_at, effective_at and
// the audit rows are stamped by SQLite's own clock, as in D1, so the checks read the stored rows.
//
// Binding note: node:sqlite binds every number as REAL, so the stand-in binds safe integers as
// BigInt, as D1 binds a whole JavaScript number as INTEGER.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import {
  renderSettingsChangeAlertEmail,
  sendSettingsChangeAlert,
} from '../worker/emails/admin-alert.ts'
import {
  handleGetDeliveryAreas,
  handleGetHistory,
  handleGetSettings,
  handleGetTerms,
  handlePatchDeliveryArea,
  handlePostDeliveryArea,
  handlePostTerms,
  handlePutBank,
  handlePutContact,
  handlePutDeposit,
  handlePutIdentity,
  handlePutPickup,
  handlePutSwitch,
} from '../worker/settings/admin-settings-handlers.ts'
import { readEffectiveSettings } from '../worker/settings/settings-read.ts'
import {
  SETTINGS_WRITE_OTHER_SQL,
  SETTINGS_WRITE_SQL,
  readCurrentBusinessIdentity,
} from '../worker/settings/settings-write.ts'
import { adminSettingsRoutes } from '../worker/portal/slots/admin-settings.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const ADMIN = 'AdminUid0001'
const HOUR_MS = 60 * 60 * 1000

/** Valid Saudi IBANs (ISO 13616 check digits computed for these values). */
const IBAN_A = 'SA0910000000000000000001'
const IBAN_B = 'SA0745000000ABCDEF123456'
const IBAN_C = 'SA0380000000608010167519'
const STUDIO = '966505647418'
const NEW_STUDIO = '966551234567'
const TERMS_BODY =
  'شروط الحجز: يُثبَّت موعد التصوير بعد استلام العربون، وتُرسل الصور خلال المدة المتفق عليها بين الطرفين.'
const TERMS_BODY_2 = `${TERMS_BODY}\nيُعاد جدولة الموعد مرة واحدة عند الحاجة بالاتفاق مع الاستوديو.`

// ---------------------------------------------------------------------------
// Database, D1 stand-in and handler context
// ---------------------------------------------------------------------------

function sqlValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

function plainRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]),
  )
}

function migrationFiles() {
  return readdirSync(MIGRATIONS).filter((name) => MIGRATION_FILE.test(name)).sort()
}

function openDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of migrationFiles()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
  }

  db.prepare(
    `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
     VALUES (?, 'admin@example.test', 'اسم', 'تجريبي', '+447700900000', 'admin', '2026-01-01T00:00:00.000Z')`,
  ).run(ADMIN)

  return db
}

function createD1(db) {
  function execute(sql, values) {
    const rows = db.prepare(sql).all(...values.map(sqlValue)).map(plainRow)
    const info = db.prepare('SELECT changes() AS changes, last_insert_rowid() AS lastRowId').get()

    return {
      success: true,
      results: rows,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastRowId) },
    }
  }

  function statement(sql, values) {
    return {
      sql,
      values,
      bind: (...next) => statement(sql, next),
      all: async () => execute(sql, values),
      first: async () => execute(sql, values).results[0] ?? null,
      run: async () => execute(sql, values),
    }
  }

  return {
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      db.exec('BEGIN')

      try {
        const results = statements.map((item) => execute(item.sql, item.values))
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
}

const allowAll = { limit: async () => ({ success: true }) }

function setup(envOverrides = {}) {
  const db = openDatabase()
  const waits = []
  const env = {
    DB: createD1(db),
    ONLINE_CONFIRMATION: 'off',
    ADMIN_MEDIA_MFA: 'required',
    ADMIN_SETTINGS_2F: 'optional',
    RL_ADMIN_READ: allowAll,
    ...envOverrides,
  }

  return { db, env, waits, ctx: { waitUntil: (promise) => waits.push(promise) } }
}

/** A sign-in `ageSeconds` old, with or without the TOTP factor. */
function adminSignedIn(ageSeconds = 60, secondFactor = null) {
  return { uid: ADMIN, authTime: Date.now() / 1000 - ageSeconds, secondFactor }
}

const FRESH = adminSignedIn(60)
const STALE = adminSignedIn(20 * 60)
const TOTP = adminSignedIn(60, 'totp')

async function call(harness, handler, { method = 'GET', path = '/api/admin/settings', body, admin = FRESH, params = {} } = {}) {
  const init = { method }

  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }

  const request = new Request(`https://studio.example${path}`, init)
  const response = await handler({
    request,
    env: harness.env,
    ctx: harness.ctx,
    url: new URL(request.url),
    admin,
    params,
  })

  return { status: response.status, body: await response.json(), headers: response.headers }
}

function rows(db, sql, ...values) {
  return db.prepare(sql).all(...values.map(sqlValue)).map(plainRow)
}

function revisions(db, section) {
  return rows(db, 'SELECT * FROM settings_revisions WHERE section = ? ORDER BY id', section)
}

function audits(db) {
  return rows(db, 'SELECT * FROM admin_audit_log ORDER BY id')
}

function hoursBetween(from, to) {
  return (Date.parse(to) - Date.parse(from)) / HOUR_MS
}

const bank = (iban, bankName = 'بنك تجريبي') => ({ bankName, accountHolder: 'صاحبة الحساب', iban })

// ---------------------------------------------------------------------------
// Migration 0010
// ---------------------------------------------------------------------------

describe('0010_business_identity.sql', () => {
  const now = new Date().toISOString()
  const insert = (db, values = {}) =>
    db
      .prepare(
        `INSERT INTO business_identity_revisions (id, legal_name, licence_number, vat_status, created_by, reauth_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        values.id ?? null,
        values.legal_name ?? 'سندس يار',
        values.licence_number ?? 'FL-123456',
        values.vat_status ?? 'unknown',
        ADMIN,
        values.reauth_at ?? now,
        values.created_at ?? now,
      )

  test('stores a valid identity and refuses values its CHECKs exclude', () => {
    const db = openDatabase()
    insert(db)

    for (const bad of [
      { licence_number: 'fl-1234' },
      { licence_number: '-1234' },
      { licence_number: '1234-' },
      { licence_number: '12--34' },
      { licence_number: 'ABCD' },
      { licence_number: '123' },
      { legal_name: 'س' },
      { legal_name: 'سندس\nيار' },
      { vat_status: 'maybe' },
      { reauth_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() },
    ]) {
      assert.throws(() => insert(db, bad), /CHECK constraint failed/, JSON.stringify(bad))
    }
  })

  test('is append-only: no update, delete, replace or key outside the sequence', () => {
    const db = openDatabase()
    insert(db)
    assert.throws(() => db.exec("UPDATE business_identity_revisions SET vat_status = 'registered'"), /APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS/)
    assert.throws(() => db.exec('DELETE FROM business_identity_revisions'), /APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS/)
    assert.throws(
      () =>
        db.exec(
          `INSERT OR REPLACE INTO business_identity_revisions (id, legal_name, licence_number, vat_status, created_by, reauth_at, created_at)
           VALUES (1, NULL, NULL, 'registered', '${ADMIN}', '${now}', '${now}')`,
        ),
      /APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS/,
    )
    assert.throws(() => insert(db, { id: -1 }), /APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS/)
    assert.throws(() => insert(db, { id: 5_000_000_000 }), /APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS/)
    assert.equal(rows(db, 'SELECT * FROM business_identity_revisions').length, 1)
  })

  test('every write statement prepares against the migrations', () => {
    const db = openDatabase()

    for (const [name, sql] of Object.entries({ ...SETTINGS_WRITE_SQL, ...SETTINGS_WRITE_OTHER_SQL })) {
      assert.doesNotThrow(() => db.prepare(sql), name)
    }
  })

  test('the slot registers every endpoint with the open gate', () => {
    const templates = adminSettingsRoutes.map((route) => `${route.path.join('/')} ${Object.keys(route.handlers).sort().join(',')}`)

    assert.deepEqual(templates, [
      'settings GET',
      'settings/deposit PUT',
      'settings/bank PUT',
      'settings/contact PUT',
      'settings/pickup PUT',
      'settings/identity PUT',
      'settings/terms GET,POST',
      'settings/history GET',
      'settings/delivery-areas GET,POST',
      'settings/delivery-areas/:areaId PATCH',
      'settings/switch PUT',
    ])
    assert.ok(adminSettingsRoutes.every((route) => route.gate === 'open'))
  })
})

// ---------------------------------------------------------------------------
// Bank and contact: delayed activation (TM-03, N-45, GAP-05)
// ---------------------------------------------------------------------------

describe('PUT bank and contact (AD+S, delayed activation)', () => {
  test('the first bank revision is immediate and audited without its values', async () => {
    const harness = setup()
    const saved = await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })

    assert.equal(saved.status, 200)
    assert.equal(saved.body.delayed, false)
    assert.equal(saved.body.effectiveAt, saved.body.savedAt)

    const [row] = revisions(harness.db, 'bank')
    assert.equal(row.effective_at, null)
    assert.equal(row.reauth_at, new Date(FRESH.authTime * 1000).toISOString())

    const [audit] = audits(harness.db)
    assert.equal(audit.action, 'settings_bank_updated')
    assert.equal(audit.target_id, String(row.id))
    assert.equal(audit.details, '{"section":"bank"}')
    assert.equal(audit.reauth_at, row.reauth_at)
    assert.ok(!JSON.stringify(audits(harness.db)).includes(IBAN_A))
  })

  test('saving the values in force changes nothing: no row, no audit, unchanged: true', async () => {
    const harness = setup()
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })
    const again = await call(harness, handlePutBank, { method: 'PUT', body: bank(` ${IBAN_A.slice(0, 4)} ${IBAN_A.slice(4)} `) })

    assert.deepEqual(again.body, { ok: true, unchanged: true })
    assert.equal(revisions(harness.db, 'bank').length, 1)
    assert.equal(audits(harness.db).length, 1)
    assert.equal(harness.waits.length, 1)
  })

  test('a change to an existing bank revision waits 24 h; customers keep the old one', async () => {
    const harness = setup()
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })
    const changed = await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B) })

    assert.equal(changed.status, 200)
    assert.equal(changed.body.delayed, true)
    assert.equal(changed.body.delayHours, 24)
    assert.equal(changed.body.pairedChange, false)

    const [, pending] = revisions(harness.db, 'bank')
    assert.equal(hoursBetween(pending.created_at, pending.effective_at), 24)

    const view = await call(harness, handleGetSettings)
    assert.equal(view.body.settings.bank.iban, IBAN_A)
    assert.equal(view.body.pending.bank.revisionId, pending.id)
    assert.equal(view.body.pending.bank.delayHours, 24)
    assert.equal(view.body.pending.contact, null)

    const later = await readEffectiveSettings(harness.env.DB, new Date(Date.parse(pending.effective_at) + 1))
    assert.equal(later.bank.iban, IBAN_B)
  })

  test('saving the pending values again keeps its effective_at (unchanged)', async () => {
    const harness = setup()
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B) })
    const again = await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B) })

    assert.deepEqual(again.body, { ok: true, unchanged: true })
    assert.equal(revisions(harness.db, 'bank').length, 2)
  })

  test('re-saving the values in force cancels the pending change: it never takes effect', async () => {
    const harness = setup()
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B) })
    const cancel = await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })

    assert.equal(cancel.body.delayed, false)

    const [, pending] = revisions(harness.db, 'bank')
    const view = await call(harness, handleGetSettings)
    assert.equal(view.body.pending.bank, null)

    for (const offset of [0, 1, 25 * HOUR_MS]) {
      const at = new Date(Date.parse(pending.effective_at) + offset)
      assert.equal((await readEffectiveSettings(harness.env.DB, at)).bank.iban, IBAN_A)
    }
  })

  test('a new delayed change while one is pending writes a cancel first: only the newest can take effect', async () => {
    const harness = setup()
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B) })
    const third = await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_C) })

    assert.equal(third.body.delayed, true)
    assert.equal(third.body.cancelledPending, true)

    const [, first, cancel, newest] = revisions(harness.db, 'bank')
    assert.equal(cancel.bank_iban, IBAN_A)
    assert.equal(cancel.effective_at, null)
    assert.equal(newest.bank_iban, IBAN_C)
    assert.equal(audits(harness.db).filter((row) => row.action === 'settings_bank_updated').length, 4)

    // The first pending change (B) is never in force, not even at its own effective_at.
    const firstAt = Date.parse(first.effective_at)
    const newestAt = Date.parse(newest.effective_at)

    for (const at of [newest.created_at, firstAt - 1, firstAt, firstAt + 1, newestAt - 1, newestAt]) {
      assert.notEqual((await readEffectiveSettings(harness.env.DB, new Date(at))).bank.iban, IBAN_B)
    }

    assert.equal((await readEffectiveSettings(harness.env.DB, new Date(newest.created_at))).bank.iban, IBAN_A)

    assert.equal(
      (await readEffectiveSettings(harness.env.DB, new Date(Date.parse(newest.effective_at) + 1))).bank.iban,
      IBAN_C,
    )
  })

  test('a save with the TOTP factor is immediate', async () => {
    const harness = setup()
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })
    const saved = await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B), admin: TOTP })

    assert.equal(saved.body.delayed, false)
    assert.equal(revisions(harness.db, 'bank')[1].effective_at, null)
  })

  test('GAP-05: a bank change within 30 days of a number change waits 72 h (and the reverse)', async () => {
    const harness = setup()
    await call(harness, handlePutContact, { method: 'PUT', body: { whatsappNumber: '0505647418' } })
    await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })

    // First revisions of the other section do not pair.
    const contactChange = await call(harness, handlePutContact, { method: 'PUT', body: { whatsappNumber: '+966 55 123 4567' } })
    assert.equal(contactChange.body.delayHours, 24)

    const bankChange = await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B) })
    assert.equal(bankChange.body.delayHours, 72)
    assert.equal(bankChange.body.pairedChange, true)

    const row = revisions(harness.db, 'bank').at(-1)
    assert.equal(hoursBetween(row.created_at, row.effective_at), 72)

    const view = await call(harness, handleGetSettings)
    assert.equal(view.body.pending.bank.pairedChange, true)
    assert.equal(view.body.pending.contact.whatsappNumber, undefined)
    assert.equal(revisions(harness.db, 'contact').at(-1).whatsapp_number, NEW_STUDIO)
  })

  test('a stale sign-in is refused before anything is read or written (403 REAUTH_REQUIRED)', async () => {
    const harness = setup()

    for (const handler of [handlePutBank, handlePutContact, handlePutDeposit, handlePostTerms]) {
      const refused = await call(harness, handler, { method: 'PUT', body: '{', admin: STALE })
      assert.equal(refused.status, 403)
      assert.equal(refused.body.error.code, 'REAUTH_REQUIRED')
    }

    assert.equal(audits(harness.db).length, 0)
  })

  test('ADMIN_SETTINGS_2F=required: bank, contact, deposit and terms need the TOTP factor (N-45)', async () => {
    const harness = setup({ ADMIN_SETTINGS_2F: 'required' })

    for (const [handler, body] of [
      [handlePutBank, bank(IBAN_A)],
      [handlePutContact, { whatsappNumber: '0505647418' }],
      [handlePutDeposit, { kind: 'percent', percent: 20, roundTo: 50 }],
      [handlePostTerms, { body: TERMS_BODY, changeSummary: null, expectedCurrentVersion: null }],
    ]) {
      const refused = await call(harness, handler, { method: 'PUT', body })
      assert.equal(refused.status, 403)
      assert.equal(refused.body.error.code, 'SECOND_FACTOR_REQUIRED')

      const accepted = await call(harness, handler, { method: 'PUT', body, admin: TOTP })
      assert.ok(accepted.status === 200 || accepted.status === 201, String(accepted.status))
    }

    // Pickup is AD+R only.
    const pickup = await call(harness, handlePutPickup, { method: 'PUT', body: { address: 'حي الملقا، الرياض', instructions: null } })
    assert.equal(pickup.status, 200)
  })

  test('invalid input answers the plan codes and writes nothing', async () => {
    const harness = setup()
    const cases = [
      [handlePutBank, bank('SA0910000000000000000002'), 'INVALID_IBAN'],
      [handlePutBank, { ...bank(IBAN_A), extra: 1 }, 'INVALID_REQUEST_BODY'],
      [handlePutBank, bank(IBAN_A, 'بنك wa.me/966500000000'), 'INVALID_TEXT'],
      [handlePutBank, bank(IBAN_A, 'بنك‮تجريبي'), 'INVALID_TEXT'],
      [handlePutContact, { whatsappNumber: '05056474' }, 'INVALID_PHONE'],
      [handlePutDeposit, { kind: 'fixed', fixedAmount: 0, roundTo: 1 }, 'INVALID_REQUEST_BODY'],
      [handlePutDeposit, { kind: 'fixed', fixedAmount: 1000, percent: 20, roundTo: 1 }, 'INVALID_REQUEST_BODY'],
    ]

    for (const [handler, body, code] of cases) {
      const refused = await call(harness, handler, { method: 'PUT', body })
      assert.equal(refused.status, 400, JSON.stringify(body))
      assert.equal(refused.body.error.code, code, JSON.stringify(body))
      assert.ok(!JSON.stringify(refused.body).includes('SA09'))
    }

    assert.equal(rows(harness.db, 'SELECT * FROM settings_revisions').length, 0)
    assert.equal(audits(harness.db).length, 0)
  })

  test('a body over its byte cap or of another media type is refused before parsing', async () => {
    const harness = setup()
    const tooLarge = await call(harness, handlePutContact, { method: 'PUT', body: JSON.stringify({ whatsappNumber: '0'.repeat(600) }) })
    assert.equal(tooLarge.status, 400)

    const request = new Request('https://studio.example/api/admin/settings/contact', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"whatsappNumber":"0505647418"}',
    })
    const response = await handlePutContact({ request, env: harness.env, ctx: harness.ctx, url: new URL(request.url), admin: FRESH, params: {} })
    assert.equal(response.status, 415)
  })
})

// ---------------------------------------------------------------------------
// Deposit and pickup (TM-04, N-33, N-34)
// ---------------------------------------------------------------------------

describe('PUT deposit and pickup', () => {
  test('deposit is immediate, audited and unchanged when equal', async () => {
    const harness = setup()
    const saved = await call(harness, handlePutDeposit, { method: 'PUT', body: { kind: 'percent', percent: 20, roundTo: 50 } })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.delayed, false)

    const same = await call(harness, handlePutDeposit, { method: 'PUT', body: { kind: 'percent', percent: 20, roundTo: 50 } })
    assert.deepEqual(same.body, { ok: true, unchanged: true })

    const fixed = await call(harness, handlePutDeposit, { method: 'PUT', body: { kind: 'fixed', fixedAmount: 1000, roundTo: 1 } })
    assert.equal(fixed.status, 200)

    const view = await call(harness, handleGetSettings)
    assert.deepEqual(
      { kind: view.body.settings.deposit.kind, fixedAmount: view.body.settings.deposit.fixedAmount, percent: view.body.settings.deposit.percent },
      { kind: 'fixed', fixedAmount: 1000, percent: null },
    )
    assert.deepEqual(audits(harness.db).map((row) => row.action), ['settings_deposit_updated', 'settings_deposit_updated'])
  })

  test('pickup needs a recent sign-in (N-34)', async () => {
    const harness = setup()
    const refused = await call(harness, handlePutPickup, { method: 'PUT', body: { address: 'حي الملقا، الرياض', instructions: null }, admin: STALE })

    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'REAUTH_REQUIRED')
  })

  test('pickup text with payment instructions, links or other numbers is refused (N-33)', async () => {
    const harness = setup()
    await call(harness, handlePutContact, { method: 'PUT', body: { whatsappNumber: STUDIO } })

    for (const instructions of [
      'للتأكيد حوّلي العربون إلى SA09 1000 0000 0000 0000 0001',
      'راسلينا على 0551234567',
      'تفاصيل الموقع على wa.me/966551234567',
      'الحساب 1234567890123',
    ]) {
      const refused = await call(harness, handlePutPickup, { method: 'PUT', body: { address: 'حي الملقا، الرياض', instructions } })
      assert.equal(refused.status, 400, instructions)
      assert.equal(refused.body.error.code, 'CONTENT_NOT_ALLOWED', instructions)
    }

    const studio = await call(harness, handlePutPickup, {
      method: 'PUT',
      body: { address: 'حي الملقا، الرياض', instructions: 'عند الوصول راسلينا على 0505647418' },
    })
    assert.equal(studio.status, 200)
    assert.equal(revisions(harness.db, 'pickup').length, 1)
  })
})

// ---------------------------------------------------------------------------
// Terms (TM-04, TM-18)
// ---------------------------------------------------------------------------

describe('GET and POST terms', () => {
  test('publishes with optimistic concurrency and a server-side SHA-256', async () => {
    const harness = setup()
    const first = await call(harness, handlePostTerms, {
      method: 'POST',
      body: { body: TERMS_BODY, changeSummary: 'النسخة الأولى', expectedCurrentVersion: null },
    })

    assert.equal(first.status, 201)
    assert.equal(first.body.terms.version, 'v1')

    const [stored] = rows(harness.db, 'SELECT * FROM terms_versions')
    const { createHash } = await import('node:crypto')
    assert.equal(stored.body_sha256, createHash('sha256').update(TERMS_BODY, 'utf8').digest('hex'))
    assert.equal(first.body.terms.bodySha256, stored.body_sha256)

    const same = await call(harness, handlePostTerms, {
      method: 'POST',
      body: { body: TERMS_BODY, changeSummary: null, expectedCurrentVersion: 'v1' },
    })
    assert.deepEqual(same.body, { ok: true, unchanged: true })

    const stale = await call(harness, handlePostTerms, {
      method: 'POST',
      body: { body: TERMS_BODY_2, changeSummary: null, expectedCurrentVersion: null },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'TERMS_VERSION_CONFLICT')

    const second = await call(harness, handlePostTerms, {
      method: 'POST',
      body: { body: TERMS_BODY_2, changeSummary: '', expectedCurrentVersion: 'v1' },
    })
    assert.equal(second.status, 201)
    assert.equal(second.body.terms.version, 'v2')
    assert.deepEqual(audits(harness.db).map((row) => [row.action, row.target_id]), [['terms_published', 'v1'], ['terms_published', 'v2']])

    const list = await call(harness, handleGetTerms, { path: '/api/admin/settings/terms' })
    assert.deepEqual(list.body.versions.map((version) => [version.version, version.changeSummary]), [['v2', null], ['v1', 'النسخة الأولى']])

    const one = await call(harness, handleGetTerms, { path: '/api/admin/settings/terms?version=v1' })
    assert.equal(one.body.terms.body, TERMS_BODY)

    const missing = await call(harness, handleGetTerms, { path: '/api/admin/settings/terms?version=v9' })
    assert.equal(missing.status, 404)

    const bad = await call(harness, handleGetTerms, { path: '/api/admin/settings/terms?version=v1&version=v2' })
    assert.equal(bad.status, 400)
  })

  test('the body and summary pass the text validator, the content rules and the plain-text rule', async () => {
    const harness = setup()

    for (const [body, changeSummary, code] of [
      [`${TERMS_BODY} للتحويل: SA09 1000 0000 0000 0000 0001`, null, 'CONTENT_NOT_ALLOWED'],
      [`${TERMS_BODY} التفاصيل على https://example.test`, null, 'CONTENT_NOT_ALLOWED'],
      [`${TERMS_BODY} <script>alert(1)</script>`, null, 'INVALID_TEXT'],
      [`${TERMS_BODY}‏`, null, 'INVALID_TEXT'],
      [TERMS_BODY, 'راسلينا على 0551234567', 'CONTENT_NOT_ALLOWED'],
      ['قصير جدًا', null, 'INVALID_REQUEST_BODY'],
    ]) {
      const refused = await call(harness, handlePostTerms, {
        method: 'POST',
        body: { body, changeSummary, expectedCurrentVersion: null },
      })
      assert.equal(refused.status, 400, body)
      assert.equal(refused.body.error.code, code, body)
    }

    assert.equal(rows(harness.db, 'SELECT * FROM terms_versions').length, 0)
  })
})

// ---------------------------------------------------------------------------
// History, delivery areas, identity
// ---------------------------------------------------------------------------

describe('GET history', () => {
  test('pages revisions newest first with full values; rejects unknown parameters', async () => {
    const harness = setup()

    for (const iban of [IBAN_A, IBAN_B, IBAN_C]) {
      await call(harness, handlePutBank, { method: 'PUT', body: bank(iban), admin: TOTP })
    }

    const first = await call(harness, handleGetHistory, { path: '/api/admin/settings/history?section=bank&limit=2' })
    assert.deepEqual(first.body.revisions.map((row) => row.values.iban), [IBAN_C, IBAN_B])
    assert.ok(first.body.revisions.every((row) => row.reauthAt !== null && row.createdAt !== null))

    const second = await call(harness, handleGetHistory, {
      path: `/api/admin/settings/history?section=bank&limit=2&cursor=${first.body.nextCursor}`,
    })
    assert.deepEqual(second.body.revisions.map((row) => row.values.iban), [IBAN_A])
    assert.equal(second.body.nextCursor, null)

    for (const query of ['section=switch', 'section=bank&limit=51', 'section=bank&limit=0', 'section=bank&cursor=-1', 'section=bank&x=1', '']) {
      const refused = await call(harness, handleGetHistory, { path: `/api/admin/settings/history?${query}` })
      assert.equal(refused.status, 400, query)
      assert.equal(refused.body.error.code, 'INVALID_QUERY', query)
    }
  })

  test('reads are held to the RL_ADMIN_READ burst', async () => {
    const harness = setup({ RL_ADMIN_READ: { limit: async () => ({ success: false }) } })
    const limited = await call(harness, handleGetSettings)

    assert.equal(limited.status, 429)
    assert.equal(limited.body.error.code, 'RATE_LIMITED')
  })
})

describe('delivery areas (AD, content rules on names)', () => {
  test('create, list, update and refusals; the audit never records a name', async () => {
    const harness = setup()
    const created = await call(harness, handlePostDeliveryArea, {
      method: 'POST',
      admin: STALE,
      body: { name: '  شمال   الرياض ', fee: 150, sortOrder: 1 },
    })

    assert.equal(created.status, 201)
    assert.equal(created.body.area.name, 'شمال الرياض')

    const duplicate = await call(harness, handlePostDeliveryArea, { method: 'POST', body: { name: 'شمال الرياض', fee: 100, sortOrder: 2 } })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'DELIVERY_AREA_NAME_TAKEN')

    for (const [name, code] of [
      ['حوّلي إلى 0551234567', 'CONTENT_NOT_ALLOWED'],
      ['sundus.example', 'INVALID_TEXT'],
      ['شرق‮الرياض', 'INVALID_TEXT'],
    ]) {
      const refused = await call(harness, handlePostDeliveryArea, { method: 'POST', body: { name, fee: 100, sortOrder: 2 } })
      assert.equal(refused.body.error.code, code, name)
    }

    const areaId = created.body.area.id
    const params = { areaId }
    const path = `/api/admin/settings/delivery-areas/${areaId}`
    const updated = await call(harness, handlePatchDeliveryArea, { method: 'PATCH', path, params, body: { fee: 200, isActive: false } })
    assert.equal(updated.status, 200)
    assert.deepEqual([updated.body.area.fee, updated.body.area.isActive], [200, false])

    const unchanged = await call(harness, handlePatchDeliveryArea, { method: 'PATCH', path, params, body: { fee: 200 } })
    assert.deepEqual(unchanged.body, { ok: true, unchanged: true })

    const renamed = await call(harness, handlePatchDeliveryArea, { method: 'PATCH', path, params, body: { name: 'جنوب الرياض' } })
    assert.equal(renamed.body.area.name, 'جنوب الرياض')

    const empty = await call(harness, handlePatchDeliveryArea, { method: 'PATCH', path, params, body: {} })
    assert.equal(empty.status, 400)

    const missing = await call(harness, handlePatchDeliveryArea, {
      method: 'PATCH',
      path,
      params: { areaId: '00000000-0000-4000-8000-000000000000' },
      body: { fee: 1 },
    })
    assert.equal(missing.status, 404)

    const list = await call(harness, handleGetDeliveryAreas, { path: '/api/admin/settings/delivery-areas' })
    assert.deepEqual(list.body.deliveryAreas.map((area) => area.name), ['جنوب الرياض'])

    const log = audits(harness.db)
    assert.deepEqual(log.map((row) => row.action), ['delivery_area_created', 'delivery_area_updated', 'delivery_area_updated'])
    assert.deepEqual(JSON.parse(log[2].details), { changed: ['name'] })
    assert.ok(!JSON.stringify(log).includes('الرياض'))
  })
})

describe('PUT identity (AD+R, GAP-03)', () => {
  test('saves the business identity with content rules and reads it back', async () => {
    const harness = setup()
    const refused = await call(harness, handlePutIdentity, {
      method: 'PUT',
      body: { legalName: 'سندس يار', licenceNumber: 'FL-1234', vatStatus: 'unknown' },
      admin: STALE,
    })
    assert.equal(refused.body.error.code, 'REAUTH_REQUIRED')

    for (const [body, code] of [
      [{ legalName: 'سندس يار', licenceNumber: '0551234567', vatStatus: 'unknown' }, 'CONTENT_NOT_ALLOWED'],
      [{ legalName: 'www.example.test', licenceNumber: null, vatStatus: 'unknown' }, 'INVALID_TEXT'],
      [{ legalName: null, licenceNumber: null, vatStatus: 'yes' }, 'INVALID_REQUEST_BODY'],
    ]) {
      const invalid = await call(harness, handlePutIdentity, { method: 'PUT', body })
      assert.equal(invalid.body.error.code, code, JSON.stringify(body))
    }

    const saved = await call(harness, handlePutIdentity, {
      method: 'PUT',
      body: { legalName: 'سندس يار', licenceNumber: ' fl-١٢٣٤٥ ', vatStatus: 'not_registered' },
    })
    assert.equal(saved.status, 200)

    const same = await call(harness, handlePutIdentity, {
      method: 'PUT',
      body: { legalName: 'سندس يار', licenceNumber: 'FL-12345', vatStatus: 'not_registered' },
    })
    assert.deepEqual(same.body, { ok: true, unchanged: true })

    const identity = await readCurrentBusinessIdentity(harness.env.DB)
    assert.deepEqual(
      { legalName: identity.legalName, licenceNumber: identity.licenceNumber, vatStatus: identity.vatStatus },
      { legalName: 'سندس يار', licenceNumber: 'FL-12345', vatStatus: 'not_registered' },
    )

    const view = await call(harness, handleGetSettings)
    assert.equal(view.body.settings.identity.licenceNumber, 'FL-12345')

    const history = await call(harness, handleGetHistory, { path: '/api/admin/settings/history?section=identity' })
    assert.equal(history.body.revisions.length, 1)
  })

  test('a stored row that fails the content rules reads as no identity (fail closed)', async () => {
    const harness = setup()
    const now = new Date().toISOString()
    harness.db
      .prepare(
        `INSERT INTO business_identity_revisions (legal_name, licence_number, vat_status, created_by, reauth_at, created_at)
         VALUES ('سندس يار', '0551234567', 'registered', ?, ?, ?)`,
      )
      .run(ADMIN, now, now)

    assert.equal(await readCurrentBusinessIdentity(harness.env.DB), null)
  })
})

// ---------------------------------------------------------------------------
// Kill switch (H3) and the GET view
// ---------------------------------------------------------------------------

describe('PUT switch (off: AD; on: AD+R)', () => {
  test('turning it off needs no recent sign-in; turning it on does', async () => {
    const harness = setup({ ONLINE_CONFIRMATION: 'on' })
    const off = await call(harness, handlePutSwitch, { method: 'PUT', body: { onlineConfirmation: 'off', note: 'إيقاف احترازي' }, admin: STALE })

    assert.equal(off.status, 200)
    assert.equal(off.body.killSwitch.state, 'off')

    const [row] = rows(harness.db, 'SELECT * FROM ops_switch_revisions')
    assert.equal(row.reauth_at, null)

    const again = await call(harness, handlePutSwitch, { method: 'PUT', body: { onlineConfirmation: 'off', note: null }, admin: STALE })
    assert.deepEqual(again.body, { ok: true, unchanged: true })

    const onStale = await call(harness, handlePutSwitch, { method: 'PUT', body: { onlineConfirmation: 'on', note: null }, admin: STALE })
    assert.equal(onStale.status, 403)
    assert.equal(onStale.body.error.code, 'REAUTH_REQUIRED')

    const view = await call(harness, handleGetSettings)
    assert.equal(view.body.features.onlineConfirmation.killSwitch, 'off')
    assert.equal(view.body.killSwitch.state, 'off')

    const on = await call(harness, handlePutSwitch, { method: 'PUT', body: { onlineConfirmation: 'on', note: null } })
    assert.equal(on.status, 200)
    assert.deepEqual(audits(harness.db).map((audit) => JSON.parse(audit.details).state), ['off', 'on'])
    assert.ok(!JSON.stringify(audits(harness.db)).includes('احترازي'))

    const invalid = await call(harness, handlePutSwitch, { method: 'PUT', body: { onlineConfirmation: 'ON', note: null } })
    assert.equal(invalid.status, 400)
  })
})

describe('GET settings (#29)', () => {
  test('the empty view, features, and no pending change shown as effective', async () => {
    const harness = setup()
    const view = await call(harness, handleGetSettings)

    assert.equal(view.status, 200)
    assert.deepEqual(
      [view.body.settings.deposit, view.body.settings.bank, view.body.settings.contact, view.body.settings.pickup, view.body.settings.terms, view.body.settings.identity],
      [null, null, null, null, null, null],
    )
    assert.deepEqual(view.body.settings.deliveryAreas, [])
    assert.deepEqual(view.body.pending, { bank: null, contact: null })
    assert.deepEqual(view.body.features.onlineConfirmation.missing, ['deposit', 'bank', 'terms'])
    assert.equal(view.body.features.settings2f.required, false)
    assert.deepEqual(view.body.recentSensitiveChanges, [])
    assert.ok(!Number.isNaN(Date.parse(view.body.serverTime)))

    const withQuery = await call(harness, handleGetSettings, { path: '/api/admin/settings?x=1' })
    assert.equal(withQuery.status, 400)
  })
})

// ---------------------------------------------------------------------------
// Alert email (H2)
// ---------------------------------------------------------------------------

describe('settings alert email (H2)', () => {
  const EMAIL_ENV = {
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'studio@example.test',
    ADMIN_NOTIFICATION_EMAIL: 'owner@example.test',
    APP_BASE_URL: 'https://studio.example',
  }

  test('each bank, contact, deposit, terms and switch change sends one alert with section and time only', async () => {
    const harness = setup({ ...EMAIL_ENV, ONLINE_CONFIRMATION: 'on' })
    const originalFetch = globalThis.fetch
    const sent = []

    globalThis.fetch = async (url, init) => {
      sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ id: `email_${sent.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    try {
      await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_A) })
      await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B) })
      await call(harness, handlePutContact, { method: 'PUT', body: { whatsappNumber: STUDIO } })
      await call(harness, handlePutDeposit, { method: 'PUT', body: { kind: 'fixed', fixedAmount: 1500, roundTo: 1 } })
      await call(harness, handlePostTerms, { method: 'POST', body: { body: TERMS_BODY, changeSummary: null, expectedCurrentVersion: null } })
      await call(harness, handlePutSwitch, { method: 'PUT', body: { onlineConfirmation: 'off', note: null } })
      await call(harness, handlePutPickup, { method: 'PUT', body: { address: 'حي الملقا، الرياض', instructions: null } })
      await call(harness, handlePutBank, { method: 'PUT', body: bank(IBAN_B) })
      await Promise.all(harness.waits)
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.equal(sent.length, 6)
    assert.ok(sent.every((email) => email.body.to[0] === 'owner@example.test'))

    const everything = JSON.stringify(sent)
    for (const value of [IBAN_A, IBAN_B, 'بنك تجريبي', 'صاحبة الحساب', STUDIO, '1500', 'شروط الحجز:', 'حي الملقا']) {
      assert.ok(!everything.includes(value), value)
    }

    assert.ok(sent[1].body.text.includes('يظهر للعميلات ابتداءً من'))
    assert.ok(!sent[0].body.text.includes('يظهر للعميلات ابتداءً من'))
    assert.deepEqual(
      sent.map((email) => email.headers['Idempotency-Key'].split(':').slice(0, 2).join(':')),
      ['settings-alert:bank', 'settings-alert:bank', 'settings-alert:contact', 'settings-alert:deposit', 'settings-alert:terms', 'settings-alert:switch'],
    )
  })

  test('skipped without email configuration or recipient; never sent for an unusable time', async () => {
    const alert = { section: 'bank', reference: '7', changedAt: new Date().toISOString(), effectiveAt: null }

    assert.equal(await sendSettingsChangeAlert({}, alert), 'skipped')
    assert.equal(await sendSettingsChangeAlert({ ...EMAIL_ENV, ADMIN_NOTIFICATION_EMAIL: ' ' }, alert), 'skipped')
    assert.equal(await sendSettingsChangeAlert({ ...EMAIL_ENV, EMAIL_FROM: 'not an address' }, alert), 'skipped')
    assert.equal(renderSettingsChangeAlertEmail({ ...alert, changedAt: 'yesterday' }, undefined), null)

    const email = renderSettingsChangeAlertEmail(alert, 'https://studio.example')
    assert.ok(email.html.includes('https://studio.example/admin'))
    assert.ok(email.text.includes('غيّري كلمة مرور حساب الإدارة'))
  })
})
