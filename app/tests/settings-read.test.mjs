// W1-06 / TM-03, TM-21, H3, B1, SB-4, SB-7: the settings read side
// (worker/settings/settings-read.ts) and the feature flags built on it
// (worker/settings/features.ts).
//
// Every SQL string the module prepares is prepared against a database built
// from the repository's own migrations (0008_golive_admin_settings and
// 0009_golive_hardening are the plan's 0007 and 0008), and the readers run
// against it through a small stand-in for the D1 API (prepare().bind(),
// all(), first(), batch()) over a READ-ONLY connection to the same file, so
// a statement that tried to write would fail. The revisions are written
// through a second, writable connection, with the created_at/effective_at
// values the settings API would stamp.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, test } from 'node:test'

import { sendEmail } from '../worker/email.ts'
import {
  isEmailConfigured,
  isHoldAutoExpiryOn,
  isOnlineConfirmationEffective,
  getReceiptChannel,
  loadFeatures,
  onlineConfirmationUnavailableReason,
  readHoldAutoExpiry,
  readOnlineConfirmationEffective,
  resolveFeatures,
} from '../worker/settings/features.ts'
import {
  ONLINE_CONFIRMATION_SWITCH_ON_SQL,
  SETTINGS_READ_SQL,
  effectiveRevisionIdSql,
  readCurrentTermsVersion,
  readEffectiveSettings,
  readKillSwitch,
  readPendingSettings,
  readRecentSensitiveChanges,
  readSettingsSnapshot,
  readStudioContact,
} from '../worker/settings/settings-read.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const ADMIN = 'AdminUid0001'
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

/** Valid Saudi IBANs (ISO 13616 check digits computed for these values). */
const IBAN_A = 'SA0910000000000000000001'
const IBAN_B = 'SA0745000000ABCDEF123456'
const IBAN_C = 'SA0380000000608010167519'
/** 24 characters that pass the bank_iban CHECK but not mod-97. */
const IBAN_BAD_CHECKSUM = 'SA0910000000000000000002'
const STUDIO = '966505647418'
const NEW_STUDIO = '966551234567'
const SHA256 = 'ab'.repeat(32)
const TERMS_BODY = 'شروط الحجز: يُثبَّت موعد التصوير بعد استلام العربون، وتُرسل الصور خلال المدة المتفق عليها.'

const T0 = Date.parse('2026-10-01T09:00:00.000Z')

function at(ms) {
  return new Date(ms)
}

function iso(ms) {
  return new Date(ms).toISOString()
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const folder = mkdtempSync(join(tmpdir(), 'sy-settings-read-'))
const openConnections = []
let databaseCount = 0

after(() => {
  for (const connection of openConnections) {
    connection.close()
  }

  rmSync(folder, { recursive: true, force: true })
})

function migrationNames() {
  return readdirSync(MIGRATIONS).filter((file) => MIGRATION_FILE.test(file)).sort()
}

let templatePath = null

/** A database file with every repository migration and one admin, built once. */
function migratedTemplate() {
  if (templatePath === null) {
    const path = join(folder, 'template.sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA foreign_keys = ON')

    for (const name of migrationNames()) {
      db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
    }

    db.prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
       VALUES (?, 'admin@example.test', 'اسم', 'تجريبي', '+447700900000', 'admin', '2026-01-01T00:00:00.000Z')`,
    ).run(ADMIN)
    db.close()
    templatePath = path
  }

  return templatePath
}

/** A fresh copy of the migrated database and a writable connection to it. */
function createDatabaseFile() {
  databaseCount += 1
  const path = join(folder, `settings-${databaseCount}.sqlite`)
  copyFileSync(migratedTemplate(), path)
  const writer = new DatabaseSync(path)
  openConnections.push(writer)
  writer.exec('PRAGMA foreign_keys = ON')

  return { path, writer }
}

/**
 * The D1 calls the module makes, over a read-only connection. `calls`
 * counts prepare() and batch(), to show which readers touch D1 at all.
 */
function createReadOnlyD1(path) {
  const reader = new DatabaseSync(path, { readOnly: true })
  openConnections.push(reader)
  const calls = { prepare: 0, batch: 0 }

  function rows(statement) {
    return reader.prepare(statement.sql).all(...statement.values)
  }

  function statement(sql, values) {
    const prepared = {
      sql,
      values,
      bind: (...next) => statement(sql, next),
      async all() {
        return { success: true, meta: {}, results: rows(prepared) }
      },
      async first() {
        return rows(prepared)[0] ?? null
      },
    }

    return prepared
  }

  return {
    calls,
    prepare(sql) {
      calls.prepare += 1
      return statement(sql, [])
    },
    async batch(statements) {
      calls.batch += 1
      return statements.map((prepared) => ({ success: true, meta: {}, results: rows(prepared) }))
    },
  }
}

/**
 * A D1 stand-in that answers each statement with fixed rows (none for a
 * statement not listed): for rows the schema's CHECKs would refuse, as a
 * damaged or hand-edited database could still return them.
 */
function createFixedRowD1(rowsBySql) {
  function statement(sql) {
    const results = rowsBySql.get(sql) ?? []
    const prepared = {
      sql,
      bind: () => prepared,
      async all() {
        return { success: true, meta: {}, results }
      },
      async first() {
        return results[0] ?? null
      },
    }

    return prepared
  }

  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      return statements.map(({ sql }) => ({ success: true, meta: {}, results: rowsBySql.get(sql) ?? [] }))
    },
  }
}

function scenario() {
  const { path, writer } = createDatabaseFile()

  return { writer, d1: createReadOnlyD1(path) }
}

/** One settings revision as the settings API writes it (reauth 1 minute before). */
function insertRevision(writer, section, columns, createdMs, effectiveMs = null) {
  const names = Object.keys(columns)
  const values = Object.values(columns).map((value) =>
    typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value,
  )
  const info = writer
    .prepare(
      `INSERT INTO settings_revisions (section, ${names.join(', ')}, created_by, reauth_at, created_at, effective_at)
       VALUES (?, ${names.map(() => '?').join(', ')}, ?, ?, ?, ?)`,
    )
    .run(
      section,
      ...values,
      ADMIN,
      section === 'pickup' ? null : iso(createdMs - MINUTE),
      iso(createdMs),
      effectiveMs === null ? null : iso(effectiveMs),
    )

  return Number(info.lastInsertRowid)
}

function insertBank(writer, iban, createdMs, effectiveMs = null, names = {}) {
  return insertRevision(
    writer,
    'bank',
    {
      bank_name: names.bankName ?? 'مصرف الراجحي',
      bank_account_holder: names.accountHolder ?? 'سندس يار',
      bank_iban: iban,
    },
    createdMs,
    effectiveMs,
  )
}

function insertContact(writer, digits, createdMs, effectiveMs = null) {
  return insertRevision(writer, 'contact', { whatsapp_number: digits }, createdMs, effectiveMs)
}

function insertDeposit(writer, createdMs, rule = { kind: 'percent', percent: 20, roundTo: 50 }) {
  return insertRevision(
    writer,
    'deposit',
    rule.kind === 'fixed'
      ? { deposit_kind: 'fixed', deposit_fixed_amount: rule.fixedAmount, deposit_round_to: rule.roundTo }
      : { deposit_kind: 'percent', deposit_percent: rule.percent, deposit_round_to: rule.roundTo },
    createdMs,
  )
}

function insertTerms(writer, seq, createdMs) {
  writer
    .prepare(
      `INSERT INTO terms_versions (version, seq, body, body_sha256, change_summary, created_by, reauth_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(`v${seq}`, BigInt(seq), TERMS_BODY, SHA256, ADMIN, iso(createdMs - MINUTE), iso(createdMs))
}

function insertSwitch(writer, state, createdMs) {
  const info = writer
    .prepare(
      `INSERT INTO ops_switch_revisions (switch_name, state, note, created_by, reauth_at, created_at)
       VALUES ('online_confirmation', ?, NULL, ?, ?, ?)`,
    )
    .run(state, ADMIN, state === 'on' ? iso(createdMs - MINUTE) : null, iso(createdMs))

  return Number(info.lastInsertRowid)
}

/**
 * The plan's statements as tests/migrations.test.mjs writes them "as the
 * Worker will" (§2.1, §2.5): effective = the highest id already in force;
 * pending = a newer one that is not. The readers must agree with both.
 */
const PLAN_EFFECTIVE_REVISION_SQL = `
  SELECT id FROM settings_revisions
  WHERE section = ?1 AND COALESCE(effective_at, created_at) <= ?2
  ORDER BY id DESC LIMIT 1`

const PLAN_PENDING_REVISION_SQL = `
  SELECT id FROM settings_revisions
  WHERE section = ?1
    AND COALESCE(effective_at, created_at) > ?2
    AND id > COALESCE((
      SELECT id FROM settings_revisions
      WHERE section = ?1 AND COALESCE(effective_at, created_at) <= ?2
      ORDER BY id DESC LIMIT 1
    ), 0)
  ORDER BY id DESC LIMIT 1`

function planRevisionId(writer, sql, section, nowMs) {
  const row = writer.prepare(sql).get(section, iso(nowMs))

  return row === undefined ? null : Number(row.id)
}

function plainEffectiveId(writer, section, nowMs) {
  return planRevisionId(writer, PLAN_EFFECTIVE_REVISION_SQL, section, nowMs)
}

function plainPendingId(writer, section, nowMs) {
  return planRevisionId(writer, PLAN_PENDING_REVISION_SQL, section, nowMs)
}

/** effectiveRevisionIdSql() evaluated inside a statement, as approve embeds it. */
function sqlEffectiveId(writer, section, nowMs) {
  const row = writer.prepare(`SELECT ${effectiveRevisionIdSql(section, '?1')} AS id`).get(iso(nowMs))

  return row.id === null ? null : Number(row.id)
}

// ---------------------------------------------------------------------------
// Every statement prepares against 0001, 0003–0009
// ---------------------------------------------------------------------------

describe('every SQL string prepares against the migrated schema (plan §6.3)', () => {
  test('the migration chain includes 0008 and 0009', () => {
    const names = migrationNames()
    assert.ok(names.includes('0008_golive_admin_settings.sql'))
    assert.ok(names.includes('0009_golive_hardening.sql'))
  })

  test('each read statement prepares and runs on an empty settings history', () => {
    const { writer } = scenario()

    for (const [name, sql] of Object.entries(SETTINGS_READ_SQL)) {
      const statement = writer.prepare(sql)
      const parameters = (sql.match(/\?1/g) ?? []).length > 0 ? [iso(T0)] : []
      assert.deepEqual(statement.all(...parameters), [], name)
    }
  })

  test('each statement is a single SELECT: no write, no pragma, no attach', () => {
    for (const [name, sql] of Object.entries(SETTINGS_READ_SQL)) {
      assert.match(sql.trimStart(), /^SELECT\b/, name)
      assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA|ATTACH|VACUUM)\b/i, name)
      assert.doesNotMatch(sql, /;/, name)
    }
  })

  test('the embeddable fragments prepare inside a statement', () => {
    const { writer } = scenario()

    assert.equal(Number(writer.prepare(`SELECT (${ONLINE_CONFIRMATION_SWITCH_ON_SQL}) AS isOn`).get().isOn), 1)

    for (const section of ['deposit', 'bank', 'contact', 'pickup']) {
      assert.equal(sqlEffectiveId(writer, section, T0), null, section)
    }
  })

  test('the effective-revision statements need 0009 (effective_at), the switch needs ops_switch_revisions', () => {
    const db = new DatabaseSync(':memory:')

    for (const name of migrationNames().filter((file) => file < '0009')) {
      db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
    }

    assert.throws(() => db.prepare(SETTINGS_READ_SQL.effectiveRevisions), /effective_at/)
    assert.throws(() => db.prepare(SETTINGS_READ_SQL.killSwitch), /ops_switch_revisions/)
    db.close()
  })

  test('effectiveRevisionIdSql accepts only a section name and a positional parameter (SB-4)', () => {
    for (const [section, parameter] of [
      ["bank' OR 1=1 --", '?1'],
      ['BANK', '?1'],
      ['terms', '?1'],
      ['bank', '?0'],
      ['bank', '1'],
      ['bank', '?1 OR 1'],
      ['bank', ':now'],
      ['bank', '?100'],
    ]) {
      assert.throws(() => effectiveRevisionIdSql(section, parameter), RangeError, `${section} ${parameter}`)
    }

    assert.match(effectiveRevisionIdSql('contact', '?12'), /candidate\.section = 'contact'/)
    assert.match(effectiveRevisionIdSql('contact', '?12'), /<= \?12\s/)
  })
})

// ---------------------------------------------------------------------------
// Effective and pending revisions (TM-03, verified §2.5)
// ---------------------------------------------------------------------------

describe('effective and pending revisions (TM-03, §2.5)', () => {
  test('no revisions: every section null, nothing pending', async () => {
    const { d1 } = scenario()

    assert.deepEqual(await readEffectiveSettings(d1, at(T0)), { deposit: null, bank: null, contact: null, pickup: null })
    assert.deepEqual(await readPendingSettings(d1, at(T0)), { bank: null, contact: null })
  })

  test('the first bank revision is immediate; a second one is pending for 24 h, then effective', async () => {
    const { writer, d1 } = scenario()
    const first = insertBank(writer, IBAN_A, T0)
    const t1 = T0 + 26 * HOUR
    const second = insertBank(writer, IBAN_B, t1, t1 + 24 * HOUR, { accountHolder: 'مؤسسة سندس يار' })

    const before = await readEffectiveSettings(d1, at(t1 + HOUR))
    assert.equal(before.bank.revisionId, first)
    assert.equal(before.bank.iban, IBAN_A)
    assert.equal(before.bank.activeFrom, iso(T0))

    const pending = await readPendingSettings(d1, at(t1 + HOUR))
    assert.deepEqual(pending.bank, {
      revisionId: second,
      savedAt: iso(t1),
      activeFrom: iso(t1 + 24 * HOUR),
      bankName: 'مصرف الراجحي',
      accountHolder: 'مؤسسة سندس يار',
      iban: IBAN_B,
    })
    assert.equal(pending.contact, null)

    // One millisecond before effective_at: still the first; at effective_at: the second.
    assert.equal((await readEffectiveSettings(d1, at(t1 + 24 * HOUR - 1))).bank.revisionId, first)
    const after = await readEffectiveSettings(d1, at(t1 + 24 * HOUR))
    assert.equal(after.bank.revisionId, second)
    assert.equal(after.bank.savedAt, iso(t1))
    assert.equal(after.bank.activeFrom, iso(t1 + 24 * HOUR))
    assert.deepEqual(await readPendingSettings(d1, at(t1 + 24 * HOUR)), { bank: null, contact: null })
  })

  test('re-saving the effective values cancels a pending change at once, and it never surfaces', async () => {
    const { writer, d1 } = scenario()
    insertBank(writer, IBAN_A, T0)
    const t1 = T0 + 26 * HOUR
    insertBank(writer, IBAN_B, t1, t1 + 24 * HOUR)
    const resaved = insertBank(writer, IBAN_A, t1 + 2 * HOUR)

    for (const nowMs of [t1 + 3 * HOUR, t1 + 24 * HOUR, t1 + 48 * HOUR]) {
      const effective = await readEffectiveSettings(d1, at(nowMs))
      assert.equal(effective.bank.revisionId, resaved, iso(nowMs))
      assert.equal(effective.bank.iban, IBAN_A)
      assert.equal((await readPendingSettings(d1, at(nowMs))).bank, null)
      assert.equal(plainEffectiveId(writer, 'bank', nowMs), resaved, 'the plain rule agrees here')
    }
  })

  test('a second delayed change saved while a first is pending: each takes effect at its own time (§2.1)', async () => {
    const { writer, d1 } = scenario()
    const first = insertBank(writer, IBAN_A, T0)
    const t1 = T0 + 26 * HOUR
    const earlier = insertBank(writer, IBAN_B, t1, t1 + 24 * HOUR)
    const t2 = t1 + 6 * HOUR
    const latest = insertBank(writer, IBAN_C, t2, t2 + 24 * HOUR)

    // Both pending: the first revision stays in force; the newest is the pending one.
    assert.equal((await readEffectiveSettings(d1, at(t2 + HOUR))).bank.revisionId, first)
    assert.equal((await readPendingSettings(d1, at(t2 + HOUR))).bank.revisionId, latest)

    // Between the two deadlines the earlier change is in force, exactly as
    // the plan's statement (and so approve and accept-terms) has it.
    const between = t1 + 24 * HOUR + MINUTE
    assert.equal(plainEffectiveId(writer, 'bank', between), earlier)
    assert.equal((await readEffectiveSettings(d1, at(between))).bank.revisionId, earlier)
    assert.equal(sqlEffectiveId(writer, 'bank', between), earlier)
    assert.equal((await readPendingSettings(d1, at(between))).bank.revisionId, latest)

    assert.equal((await readEffectiveSettings(d1, at(t2 + 24 * HOUR))).bank.revisionId, latest)
    assert.equal((await readPendingSettings(d1, at(t2 + 24 * HOUR))).bank, null)
  })

  test('the cancel written before a new delayed change keeps the replaced one from ever taking effect', async () => {
    const { writer, d1 } = scenario()
    insertBank(writer, IBAN_A, T0)
    const t1 = T0 + 26 * HOUR
    insertBank(writer, IBAN_B, t1, t1 + 24 * HOUR)
    const t2 = t1 + 6 * HOUR
    const cancel = insertBank(writer, IBAN_A, t2)
    const latest = insertBank(writer, IBAN_C, t2, t2 + 24 * HOUR)

    for (const nowMs of [t2 + HOUR, t1 + 24 * HOUR + MINUTE, t2 + 24 * HOUR - 1]) {
      const effective = await readEffectiveSettings(d1, at(nowMs))
      assert.equal(effective.bank.revisionId, cancel, iso(nowMs))
      assert.equal(effective.bank.iban, IBAN_A)
      assert.equal((await readPendingSettings(d1, at(nowMs))).bank.revisionId, latest)
    }

    assert.equal((await readEffectiveSettings(d1, at(t2 + 24 * HOUR))).bank.revisionId, latest)
  })

  test('contact changes follow the same rule; deposit and pickup are the highest id', async () => {
    const { writer, d1 } = scenario()
    insertContact(writer, STUDIO, T0)
    const t1 = T0 + 30 * HOUR
    const pendingContact = insertContact(writer, NEW_STUDIO, t1, t1 + 24 * HOUR)
    insertDeposit(writer, T0, { kind: 'fixed', fixedAmount: 1000, roundTo: 1 })
    const deposit = insertDeposit(writer, T0 + HOUR, { kind: 'percent', percent: 20, roundTo: 50 })
    insertRevision(writer, 'pickup', { pickup_address: 'حي النرجس\nالرياض' }, T0)
    const pickup = insertRevision(
      writer,
      'pickup',
      { pickup_address: 'حي الملقا، الرياض', pickup_instructions: 'اتصلي عند الوصول' },
      T0 + 2 * HOUR,
    )

    const effective = await readEffectiveSettings(d1, at(t1 + HOUR))
    assert.equal(effective.contact.whatsappNumber, STUDIO)
    assert.deepEqual(effective.deposit, {
      revisionId: deposit,
      savedAt: iso(T0 + HOUR),
      activeFrom: iso(T0 + HOUR),
      rule: { kind: 'percent', percent: 20, roundTo: 50 },
    })
    assert.deepEqual(effective.pickup, {
      revisionId: pickup,
      savedAt: iso(T0 + 2 * HOUR),
      activeFrom: iso(T0 + 2 * HOUR),
      address: 'حي الملقا، الرياض',
      instructions: 'اتصلي عند الوصول',
    })
    assert.equal((await readPendingSettings(d1, at(t1 + HOUR))).contact.revisionId, pendingContact)
    assert.equal((await readEffectiveSettings(d1, at(t1 + 24 * HOUR))).contact.whatsappNumber, NEW_STUDIO)
  })

  test('the readers, effectiveRevisionIdSql and the plan statements give the same ids at every instant', async () => {
    const { writer, d1 } = scenario()
    insertBank(writer, IBAN_A, T0)
    const t1 = T0 + 26 * HOUR
    insertBank(writer, IBAN_B, t1, t1 + 24 * HOUR)
    insertBank(writer, IBAN_C, t1 + 6 * HOUR, t1 + 30 * HOUR)
    insertBank(writer, IBAN_A, t1 + 40 * HOUR)
    insertBank(writer, IBAN_B, t1 + 41 * HOUR, t1 + 65 * HOUR)
    insertContact(writer, STUDIO, T0 + HOUR)
    insertContact(writer, NEW_STUDIO, t1, t1 + 24 * HOUR)
    insertContact(writer, STUDIO, t1 + 2 * HOUR)
    insertDeposit(writer, T0)
    insertDeposit(writer, t1 + 3 * HOUR, { kind: 'fixed', fixedAmount: 1000, roundTo: 1 })

    for (let nowMs = T0 - HOUR; nowMs <= t1 + 70 * HOUR; nowMs += 30 * MINUTE) {
      const effective = await readEffectiveSettings(d1, at(nowMs))
      const pending = await readPendingSettings(d1, at(nowMs))

      for (const section of ['deposit', 'bank', 'contact', 'pickup']) {
        const label = `${section} ${iso(nowMs)}`
        const effectiveId = effective[section]?.revisionId ?? null
        assert.equal(sqlEffectiveId(writer, section, nowMs), effectiveId, label)
        assert.equal(plainEffectiveId(writer, section, nowMs), effectiveId, label)
      }

      for (const section of ['bank', 'contact']) {
        assert.equal(pending[section]?.revisionId ?? null, plainPendingId(writer, section, nowMs), `${section} ${iso(nowMs)}`)
      }
    }
  })

  test('a revision in force at a past instant stays the same after later saves (GAP-05)', async () => {
    const { writer, d1 } = scenario()
    const first = insertContact(writer, STUDIO, T0)
    const approvedAt = T0 + 10 * HOUR
    const before = (await readEffectiveSettings(d1, at(approvedAt))).contact.revisionId
    insertContact(writer, NEW_STUDIO, T0 + 20 * HOUR, T0 + 44 * HOUR)
    insertContact(writer, STUDIO, T0 + 21 * HOUR)

    assert.equal(before, first)
    assert.equal((await readEffectiveSettings(d1, at(approvedAt))).contact.revisionId, first)
  })

  test('a stored row that fails its guard reads as no revision, never as an older one', async () => {
    const { writer, d1 } = scenario()
    insertBank(writer, IBAN_A, T0)
    insertBank(writer, IBAN_BAD_CHECKSUM, T0 + HOUR)
    insertContact(writer, STUDIO, T0)
    insertContact(writer, '96612345678', T0 + HOUR) // passes the CHECK, not a whole Saudi number
    insertRevision(writer, 'pickup', { pickup_address: 'حي النرجس \u202Eالرياض' }, T0)

    const effective = await readEffectiveSettings(d1, at(T0 + 2 * HOUR))
    assert.equal(effective.bank, null)
    assert.equal(effective.contact, null)
    assert.equal(effective.pickup, null)
  })

  test('bank names with a bidi override, a zero-width space or untrimmed spaces fail the read guard (TM-12)', async () => {
    for (const names of [
      { bankName: 'مصرف\u202Eالراجحي' },
      { accountHolder: 'سندس\u200Bيار' },
      { accountHolder: ' سندس يار' },
      { bankName: 'مصرف  الراجحي' },
      { accountHolder: 'سندس @sndsyar' },
    ]) {
      const { writer, d1 } = scenario()
      insertBank(writer, IBAN_A, T0, null, names)
      assert.equal((await readEffectiveSettings(d1, at(T0 + HOUR))).bank, null, JSON.stringify(names))
    }
  })

  test('the reader binds the Worker clock and refuses an invalid one', async () => {
    const { d1 } = scenario()

    await assert.rejects(readEffectiveSettings(d1, new Date(Number.NaN)), RangeError)
    await assert.rejects(readSettingsSnapshot(d1, new Date(Number.NaN)), RangeError)
  })
})

// ---------------------------------------------------------------------------
// Terms, kill switch, recent changes, studio contact
// ---------------------------------------------------------------------------

describe('terms version and kill switch (H3)', () => {
  test('the current terms version is the highest seq', async () => {
    const { writer, d1 } = scenario()
    assert.equal(await readCurrentTermsVersion(d1), null)

    insertTerms(writer, 1, T0)
    insertTerms(writer, 2, T0 + HOUR)
    assert.deepEqual(await readCurrentTermsVersion(d1), {
      version: 'v2',
      seq: 2,
      publishedAt: iso(T0 + HOUR),
      bodySha256: SHA256,
    })
  })

  test('no switch row reads as on; the latest row decides; the SQL fragment agrees', async () => {
    const { writer, d1 } = scenario()
    const fragment = writer.prepare(`SELECT (${ONLINE_CONFIRMATION_SWITCH_ON_SQL}) AS isOn`)

    assert.deepEqual(await readKillSwitch(d1), { state: 'on', revisionId: null, changedAt: null })
    assert.equal(Number(fragment.get().isOn), 1)

    const off = insertSwitch(writer, 'off', T0)
    assert.deepEqual(await readKillSwitch(d1), { state: 'off', revisionId: off, changedAt: iso(T0) })
    assert.equal(Number(fragment.get().isOn), 0)

    const on = insertSwitch(writer, 'on', T0 + HOUR)
    assert.deepEqual(await readKillSwitch(d1), { state: 'on', revisionId: on, changedAt: iso(T0 + HOUR) })
    assert.equal(Number(fragment.get().isOn), 1)
  })

  test('a switch row that fails its guard reads as off, in every reader (fail closed)', async () => {
    const env = { ONLINE_CONFIRMATION: 'on', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test' }
    const complete = new Map([
      [SETTINGS_READ_SQL.effectiveRevisions, [
        { id: 1, section: 'deposit', depositKind: 'percent', depositFixedAmount: null, depositPercent: 20, depositRoundTo: 50, savedAt: iso(T0), activeFrom: iso(T0) },
        { id: 2, section: 'bank', bankName: 'مصرف الراجحي', accountHolder: 'سندس يار', iban: IBAN_A, savedAt: iso(T0), activeFrom: iso(T0) },
      ]],
      [SETTINGS_READ_SQL.currentTermsVersion, [{ version: 'v1', seq: 1, publishedAt: iso(T0), bodySha256: SHA256 }]],
    ])

    // The stand-in itself: complete settings and a valid 'on' row are offered.
    const valid = new Map([...complete, [SETTINGS_READ_SQL.killSwitch, [{ id: 3, state: 'on', changedAt: iso(T0) }]]])
    assert.deepEqual(await readKillSwitch(createFixedRowD1(valid)), { state: 'on', revisionId: 3, changedAt: iso(T0) })
    assert.equal((await loadFeatures(env, createFixedRowD1(valid), at(T0 + HOUR))).onlineConfirmation.offered, true)

    for (const row of [
      { id: 3, state: 'on', changedAt: 'not an instant' },
      { id: 3, state: 'on', changedAt: '2026-10-01 09:00:00' },
      { id: 3, state: 'on', changedAt: null },
      { id: 0, state: 'on', changedAt: iso(T0) },
      { id: -3, state: 'on', changedAt: iso(T0) },
      { id: 3.5, state: 'on', changedAt: iso(T0) },
      { id: '3', state: 'on', changedAt: iso(T0) },
      { id: null, state: 'on', changedAt: iso(T0) },
    ]) {
      const d1 = createFixedRowD1(new Map([...complete, [SETTINGS_READ_SQL.killSwitch, [row]]]))
      const label = JSON.stringify(row)

      assert.deepEqual(await readKillSwitch(d1), { state: 'off', revisionId: null, changedAt: null }, label)
      assert.equal((await readSettingsSnapshot(d1, at(T0 + HOUR))).killSwitch.state, 'off', label)
      assert.equal((await loadFeatures(env, d1, at(T0 + HOUR))).onlineConfirmation.offered, false, label)
      assert.equal(await readOnlineConfirmationEffective(env, d1), false, label)
      assert.equal(await readHoldAutoExpiry(env, d1), false, label)
    }

    // A well-formed row whose state is anything but exactly 'on' is off.
    for (const state of ['ON', 'On', ' on', 'yes', '1', null]) {
      const d1 = createFixedRowD1(new Map([...complete, [SETTINGS_READ_SQL.killSwitch, [{ id: 3, state, changedAt: iso(T0) }]]]))

      assert.deepEqual(await readKillSwitch(d1), { state: 'off', revisionId: 3, changedAt: iso(T0) }, String(state))
      assert.equal(await readOnlineConfirmationEffective(env, d1), false, String(state))
    }
  })
})

describe('recent sensitive changes (72 h fraud-visibility banner)', () => {
  test('bank, contact, deposit, terms and switch changes of the last 72 h, newest first; pickup never', async () => {
    const { writer, d1 } = scenario()
    const now = T0 + 100 * HOUR
    insertContact(writer, STUDIO, now - 72 * HOUR - 1) // one millisecond too old
    const bank = insertBank(writer, IBAN_A, now - 72 * HOUR) // exactly at the cutoff
    const deposit = insertDeposit(writer, now - HOUR)
    insertRevision(writer, 'pickup', { pickup_address: 'حي النرجس، الرياض' }, now - HOUR)
    insertTerms(writer, 1, now - 2 * HOUR)
    const switchOff = insertSwitch(writer, 'off', now - 3 * HOUR)
    const contact = insertContact(writer, NEW_STUDIO, now - 4 * HOUR, now + 20 * HOUR)

    assert.deepEqual(await readRecentSensitiveChanges(d1, at(now)), [
      { section: 'deposit', revisionId: deposit, at: iso(now - HOUR) },
      { section: 'terms', revisionId: 1, at: iso(now - 2 * HOUR) },
      { section: 'switch', revisionId: switchOff, at: iso(now - 3 * HOUR) },
      { section: 'contact', revisionId: contact, at: iso(now - 4 * HOUR) },
      { section: 'bank', revisionId: bank, at: iso(now - 72 * HOUR) },
    ])
  })

  test('a burst of saves in other sections never pushes a bank or contact change out (TM-03)', async () => {
    // The stolen-password case: the IBAN and the number are swapped, then 50
    // deposit saves and 50 switch saves follow within the re-auth window. At
    // T0 + 30 h both swaps are in force and no longer pending, so the banner
    // is where the admin still sees them.
    const { writer, d1 } = scenario()
    insertBank(writer, IBAN_A, T0 - 100 * HOUR)
    insertContact(writer, STUDIO, T0 - 100 * HOUR)
    const bank = insertBank(writer, IBAN_B, T0, T0 + 24 * HOUR)
    const contact = insertContact(writer, NEW_STUDIO, T0 + MINUTE, T0 + MINUTE + 24 * HOUR)

    for (let index = 0; index < 50; index += 1) {
      const savedMs = T0 + 2 * MINUTE + index * 5000
      insertDeposit(writer, savedMs, { kind: 'percent', percent: index % 2 === 0 ? 25 : 20, roundTo: 50 })
      insertSwitch(writer, index % 2 === 0 ? 'off' : 'on', savedMs + 1000)
    }

    const now = at(T0 + 30 * HOUR)
    assert.deepEqual(await readPendingSettings(d1, now), { bank: null, contact: null })

    const changes = await readRecentSensitiveChanges(d1, now)
    assert.deepEqual(changes.filter(({ section }) => section === 'bank'), [{ section: 'bank', revisionId: bank, at: iso(T0) }])
    assert.deepEqual(changes.filter(({ section }) => section === 'contact'), [
      { section: 'contact', revisionId: contact, at: iso(T0 + MINUTE) },
    ])
    assert.deepEqual((await readSettingsSnapshot(d1, now)).recentSensitiveChanges, changes)

    // Each section keeps its own newest 20, newest first overall.
    for (const section of ['deposit', 'switch']) {
      assert.equal(changes.filter((change) => change.section === section).length, 20, section)
    }

    assert.equal(changes.length, 42)
    assert.deepEqual(
      changes.map(({ at: changedAt }) => changedAt),
      changes.map(({ at: changedAt }) => changedAt).toSorted().reverse(),
    )
    assert.deepEqual(changes[0], { section: 'switch', revisionId: 50, at: iso(T0 + 2 * MINUTE + 49 * 5000 + 1000) })
  })

  test('a section with more than 20 changes in 72 h shows its newest 20', async () => {
    const { writer, d1 } = scenario()
    const ids = []

    for (let index = 0; index < 25; index += 1) {
      ids.push(insertBank(writer, index % 2 === 0 ? IBAN_A : IBAN_B, T0 + index * MINUTE))
    }

    const changes = await readRecentSensitiveChanges(d1, at(T0 + HOUR))
    assert.deepEqual(changes.map(({ revisionId }) => revisionId), ids.slice(5).reverse())
  })

  test('a pending change is listed from the moment it is saved', async () => {
    const { writer, d1 } = scenario()
    insertBank(writer, IBAN_A, T0)
    const pending = insertBank(writer, IBAN_B, T0 + 30 * HOUR, T0 + 54 * HOUR)

    const changes = await readRecentSensitiveChanges(d1, at(T0 + 31 * HOUR))
    assert.deepEqual(changes[0], { section: 'bank', revisionId: pending, at: iso(T0 + 30 * HOUR) })
  })
})

describe('studio contact (plan §3.3 #1 studio, TM-03, TM-19)', () => {
  test('no contact revision: no number, the SPA uses its compiled one', async () => {
    const { d1 } = scenario()
    assert.deepEqual(await readStudioContact(d1, at(T0)), { whatsappNumber: null, whatsappNumberChangedAt: null })
  })

  test('the first contact revision is not a change, whatever its number (§3.3 #1: no earlier revision)', async () => {
    for (const digits of [STUDIO, NEW_STUDIO]) {
      const { writer, d1 } = scenario()
      insertContact(writer, digits, T0)
      assert.deepEqual(await readStudioContact(d1, at(T0 + HOUR)), { whatsappNumber: digits, whatsappNumberChangedAt: null })

      // Re-saving it is not a change either.
      insertContact(writer, digits, T0 + 2 * HOUR)
      assert.deepEqual(await readStudioContact(d1, at(T0 + 3 * HOUR)), { whatsappNumber: digits, whatsappNumberChangedAt: null })
    }
  })

  test('a first contact revision that waits: no number until it takes effect, then no notice', async () => {
    const { writer, d1 } = scenario()
    insertContact(writer, NEW_STUDIO, T0, T0 + 24 * HOUR)

    assert.deepEqual(await readStudioContact(d1, at(T0 + HOUR)), { whatsappNumber: null, whatsappNumberChangedAt: null })
    assert.deepEqual(await readStudioContact(d1, at(T0 + 24 * HOUR)), { whatsappNumber: NEW_STUDIO, whatsappNumberChangedAt: null })
  })

  test('a change cancelled before it took effect never reached customers: no notice', async () => {
    const { writer, d1 } = scenario()
    insertContact(writer, STUDIO, T0)
    const t1 = T0 + 30 * HOUR
    insertContact(writer, NEW_STUDIO, t1, t1 + 24 * HOUR)
    insertContact(writer, STUDIO, t1 + 2 * HOUR)

    for (const nowMs of [t1 + 3 * HOUR, t1 + 24 * HOUR, t1 + 30 * HOUR]) {
      assert.deepEqual(await readStudioContact(d1, at(nowMs)), { whatsappNumber: STUDIO, whatsappNumberChangedAt: null }, iso(nowMs))
    }
  })

  test('two delayed changes: each notice starts when its number reached customers', async () => {
    const { writer, d1 } = scenario()
    insertContact(writer, STUDIO, T0)
    const t1 = T0 + 30 * HOUR
    insertContact(writer, NEW_STUDIO, t1, t1 + 24 * HOUR)
    const other = '966561234567'
    insertContact(writer, other, t1 + 6 * HOUR, t1 + 30 * HOUR)

    assert.deepEqual(await readStudioContact(d1, at(t1 + 25 * HOUR)), {
      whatsappNumber: NEW_STUDIO,
      whatsappNumberChangedAt: iso(t1 + 24 * HOUR),
    })
    assert.deepEqual(await readStudioContact(d1, at(t1 + 31 * HOUR)), {
      whatsappNumber: other,
      whatsappNumberChangedAt: iso(t1 + 30 * HOUR),
    })
  })

  test('going back to an earlier number is a change like any other', async () => {
    const { writer, d1 } = scenario()
    insertContact(writer, NEW_STUDIO, T0)
    insertContact(writer, STUDIO, T0 + 100 * HOUR)

    assert.equal((await readStudioContact(d1, at(T0 + 101 * HOUR))).whatsappNumberChangedAt, iso(T0 + 100 * HOUR))
  })

  test('a changed number carries the time it reached customers, for 72 h', async () => {
    const { writer, d1 } = scenario()
    insertContact(writer, STUDIO, T0)
    const t1 = T0 + 30 * HOUR
    const activeFrom = t1 + 24 * HOUR
    insertContact(writer, NEW_STUDIO, t1, activeFrom)

    // Pending: customers still get the old number, with no notice.
    assert.deepEqual(await readStudioContact(d1, at(t1 + HOUR)), { whatsappNumber: STUDIO, whatsappNumberChangedAt: null })
    assert.deepEqual(await readStudioContact(d1, at(activeFrom)), {
      whatsappNumber: NEW_STUDIO,
      whatsappNumberChangedAt: iso(activeFrom),
    })
    assert.equal((await readStudioContact(d1, at(activeFrom + 72 * HOUR))).whatsappNumberChangedAt, iso(activeFrom))
    assert.deepEqual(await readStudioContact(d1, at(activeFrom + 72 * HOUR + 1)), {
      whatsappNumber: NEW_STUDIO,
      whatsappNumberChangedAt: null,
    })
  })

  test('re-saving the same number is not a change; the change time is the last different number', async () => {
    const { writer, d1 } = scenario()
    insertContact(writer, STUDIO, T0)
    insertContact(writer, NEW_STUDIO, T0 + 10 * HOUR)
    insertContact(writer, NEW_STUDIO, T0 + 20 * HOUR)

    assert.equal((await readStudioContact(d1, at(T0 + 21 * HOUR))).whatsappNumberChangedAt, iso(T0 + 10 * HOUR))
  })

  test('a history longer than the rows compared errs on showing the notice; a complete one never does', async () => {
    // 51 saves of one number: the 50 compared cannot show the first, so a
    // change older than them cannot be ruled out.
    const { writer, d1 } = scenario()

    for (let index = 0; index < 51; index += 1) {
      insertContact(writer, STUDIO, T0 + index * MINUTE)
    }

    assert.equal((await readStudioContact(d1, at(T0 + 2 * HOUR))).whatsappNumberChangedAt, iso(T0 + MINUTE))

    // 50 saves of one number: the whole history, first revision included,
    // so there is no change (§3.3 #1).
    const { writer: completeWriter, d1: completeD1 } = scenario()

    for (let index = 0; index < 50; index += 1) {
      insertContact(completeWriter, STUDIO, T0 + index * MINUTE)
    }

    assert.deepEqual(await readStudioContact(completeD1, at(T0 + 2 * HOUR)), { whatsappNumber: STUDIO, whatsappNumberChangedAt: null })

    // A real change followed by more same-number re-saves than are read
    // still shows the notice.
    const { writer: burstWriter, d1: burstD1 } = scenario()
    insertContact(burstWriter, STUDIO, T0 - 100 * HOUR)

    for (let index = 0; index < 60; index += 1) {
      insertContact(burstWriter, NEW_STUDIO, T0 + index * MINUTE)
    }

    assert.equal((await readStudioContact(burstD1, at(T0 + 2 * HOUR))).whatsappNumberChangedAt, iso(T0 + 10 * MINUTE))
  })
})

describe('settings snapshot: one D1 batch', () => {
  test('equals the separate readers', async () => {
    const { writer, d1 } = scenario()
    insertBank(writer, IBAN_A, T0)
    insertBank(writer, IBAN_B, T0 + 30 * HOUR, T0 + 54 * HOUR)
    insertDeposit(writer, T0)
    insertContact(writer, STUDIO, T0)
    insertTerms(writer, 1, T0)
    insertSwitch(writer, 'off', T0 + 31 * HOUR)
    const now = at(T0 + 32 * HOUR)

    const batchesBefore = d1.calls.batch
    const snapshot = await readSettingsSnapshot(d1, now)
    assert.equal(d1.calls.batch, batchesBefore + 1)

    assert.deepEqual(snapshot, {
      effective: await readEffectiveSettings(d1, now),
      pending: await readPendingSettings(d1, now),
      terms: await readCurrentTermsVersion(d1),
      killSwitch: await readKillSwitch(d1),
      recentSensitiveChanges: await readRecentSensitiveChanges(d1, now),
    })
    assert.equal(snapshot.pending.bank.iban, IBAN_B)
    assert.equal(snapshot.effective.bank.iban, IBAN_A)
  })
})

// ---------------------------------------------------------------------------
// Feature flags (plan §4.1, §3.3 #29 features; M3, H3, B1, TM-21)
// ---------------------------------------------------------------------------

/** A structural stand-in for the R2 binding gates.ts accepts. */
function fakeR2Bucket() {
  const method = async () => null

  return {
    head: method,
    get: method,
    put: method,
    delete: method,
    list: method,
    createMultipartUpload: method,
    resumeMultipartUpload: method,
  }
}

const OPEN_MEDIA_ENV = {
  ONLINE_CONFIRMATION: 'on',
  PDPL_SIGNOFF_REF: 'PDPL-2026-10-01',
  MEDIA_SIGNING_KEY: 'k'.repeat(43),
  ADMIN_MEDIA_MFA: 'required',
  MEDIA: fakeR2Bucket(),
}

const COMPLETE = {
  effective: { deposit: { revisionId: 1 }, bank: { revisionId: 2 } },
  terms: { version: 'v1' },
  killSwitch: { state: 'on' },
}

const EMPTY = {
  effective: { deposit: null, bank: null },
  terms: null,
  killSwitch: { state: 'on' },
}

describe('features: fail-closed flags from vars, the D1 switch and the settings', () => {
  test('production at go-live: switch on, settings incomplete, media closed, no email', () => {
    const features = resolveFeatures({ ONLINE_CONFIRMATION: 'on', ADMIN_MEDIA_MFA: 'required', ADMIN_SETTINGS_2F: 'off' }, EMPTY)

    assert.deepEqual(features, {
      onlineConfirmation: {
        switchOn: true,
        killSwitch: 'on',
        settingsComplete: false,
        missing: ['deposit', 'bank', 'terms'],
        offered: false,
      },
      privateMedia: { allowed: false, blockers: ['PDPL_SIGNOFF_REF', 'MEDIA_BINDING', 'MEDIA_SIGNING_KEY'] },
      email: { configured: false },
      holdAutoExpiry: false,
      settings2f: { required: false },
      retentionPurge: { enabled: false },
    })
  })

  test('offered = OC ∧ KS ∧ SET, and the first missing cause is named', () => {
    const on = { ONLINE_CONFIRMATION: 'on' }

    assert.equal(resolveFeatures(on, COMPLETE).onlineConfirmation.offered, true)
    assert.equal(onlineConfirmationUnavailableReason(resolveFeatures(on, COMPLETE).onlineConfirmation), null)

    for (const [env, facts, reason] of [
      [{}, COMPLETE, 'SWITCH_OFF'],
      [{ ONLINE_CONFIRMATION: 'On' }, COMPLETE, 'SWITCH_OFF'],
      [{ ONLINE_CONFIRMATION: ' on' }, COMPLETE, 'SWITCH_OFF'],
      [{ ONLINE_CONFIRMATION: 'true' }, COMPLETE, 'SWITCH_OFF'],
      [on, { ...COMPLETE, killSwitch: { state: 'off' } }, 'KILL_SWITCH'],
      [on, { ...COMPLETE, terms: null }, 'SETTINGS_INCOMPLETE'],
      [{}, { ...COMPLETE, killSwitch: { state: 'off' }, terms: null }, 'SWITCH_OFF'],
    ]) {
      const feature = resolveFeatures(env, facts).onlineConfirmation
      assert.equal(feature.offered, false, JSON.stringify(env))
      assert.equal(onlineConfirmationUnavailableReason(feature), reason, JSON.stringify(env))
    }

    assert.deepEqual(
      resolveFeatures(on, { ...COMPLETE, effective: { deposit: { revisionId: 1 }, bank: null } }).onlineConfirmation.missing,
      ['bank'],
    )
  })

  test('private media: every blocker named, ADMIN_MFA_DISABLED only for the exact value "off" (TM-21)', () => {
    assert.deepEqual(resolveFeatures(OPEN_MEDIA_ENV, COMPLETE).privateMedia, { allowed: true, blockers: [] })
    assert.equal(getReceiptChannel(OPEN_MEDIA_ENV), 'upload')

    assert.deepEqual(resolveFeatures({ ...OPEN_MEDIA_ENV, ADMIN_MEDIA_MFA: 'off' }, COMPLETE).privateMedia, {
      allowed: false,
      blockers: ['ADMIN_MFA_DISABLED'],
    })
    assert.equal(getReceiptChannel({ ...OPEN_MEDIA_ENV, ADMIN_MEDIA_MFA: 'off' }), 'whatsapp')

    for (const value of ['OFF', 'Off', ' off', undefined, 'optional']) {
      assert.deepEqual(resolveFeatures({ ...OPEN_MEDIA_ENV, ADMIN_MEDIA_MFA: value }, COMPLETE).privateMedia.blockers, [], String(value))
    }

    assert.deepEqual(resolveFeatures({}, EMPTY).privateMedia.blockers, [
      'ONLINE_CONFIRMATION',
      'PDPL_SIGNOFF_REF',
      'MEDIA_BINDING',
      'MEDIA_SIGNING_KEY',
    ])
  })

  test('holdAutoExpiry = EM ∧ OCe (B1, H3)', () => {
    const email = { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test' }

    for (const [env, killSwitch, expected] of [
      [{ ...email, ONLINE_CONFIRMATION: 'on' }, 'on', true],
      [{ ...email, ONLINE_CONFIRMATION: 'on' }, 'off', false],
      [{ ...email, ONLINE_CONFIRMATION: 'off' }, 'on', false],
      [{ ONLINE_CONFIRMATION: 'on' }, 'on', false],
      [{ ONLINE_CONFIRMATION: 'on', RESEND_API_KEY: 're_test_key', EMAIL_FROM: '   ' }, 'on', false],
      [{ ONLINE_CONFIRMATION: 'on', RESEND_API_KEY: '', EMAIL_FROM: 'studio@example.test' }, 'on', false],
    ]) {
      assert.equal(isHoldAutoExpiryOn(env, killSwitch), expected, JSON.stringify({ env, killSwitch }))
      assert.equal(resolveFeatures(env, { ...COMPLETE, killSwitch: { state: killSwitch } }).holdAutoExpiry, expected)
    }

    assert.equal(resolveFeatures(email, EMPTY).email.configured, true)
  })

  test('a present but malformed email setting is off: EM off, so AX off (§4.3, B1)', () => {
    const on = { ONLINE_CONFIRMATION: 'on', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test' }

    for (const malformed of [
      { EMAIL_FROM: 'Sundus Studio' },
      { EMAIL_FROM: 'studio@localhost' },
      { EMAIL_FROM: '<studio@example.test>' },
      { EMAIL_FROM: 'Sundus Studio <studio@example.test' },
      { RESEND_API_KEY: 'r'.repeat(513) },
      { RESEND_API_KEY: 're_test\u0007key' },
      { EMAIL_REPLY_TO: 'reply-to-the-studio' },
    ]) {
      const env = { ...on, ...malformed }
      const label = JSON.stringify(malformed)

      assert.equal(isEmailConfigured(env), false, label)
      assert.equal(isHoldAutoExpiryOn(env, 'on'), false, label)
      assert.deepEqual(resolveFeatures(env, COMPLETE).email, { configured: false }, label)
      assert.equal(resolveFeatures(env, COMPLETE).holdAutoExpiry, false, label)
    }
  })

  test('EM is on exactly when sendEmail would send with the same settings', async () => {
    const message = {
      to: 'bride@example.test',
      subject: 'تذكير بموعد العربون',
      html: '<p>تذكير</p>',
      text: 'تذكير',
      idempotencyKey: 'settings-read-parity',
    }
    const originalFetch = globalThis.fetch
    let fetchCalls = 0

    globalThis.fetch = async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({ id: 'email_0001' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    try {
      for (const env of [
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test' },
        { RESEND_API_KEY: '  re_test_key  ', EMAIL_FROM: '  studio@example.test  ' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'المصورة سندس يار <studio@example.test>' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Sundus Studio <studio@example.test>' },
        { RESEND_API_KEY: 'r'.repeat(512), EMAIL_FROM: 'studio@example.test' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test', EMAIL_REPLY_TO: 'help@example.test' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test', EMAIL_REPLY_TO: '   ' },
        {},
        { RESEND_API_KEY: 're_test_key' },
        { EMAIL_FROM: 'studio@example.test' },
        { RESEND_API_KEY: '   ', EMAIL_FROM: 'studio@example.test' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: '' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Sundus Studio' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@localhost' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@-example.test' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: '.studio@example.test' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'stu..dio@example.test' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: `${'s'.repeat(65)}@example.test` },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: '<studio@example.test>' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Studio <studio@example.test> ' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Studio <studio@example.test>>' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Studio <<studio@example.test>' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Studio studio@example.test>' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test\u0085' },
        { RESEND_API_KEY: 'r'.repeat(513), EMAIL_FROM: 'studio@example.test' },
        { RESEND_API_KEY: 're_test\u0007key', EMAIL_FROM: 'studio@example.test' },
        { RESEND_API_KEY: 're_test\u009Fkey', EMAIL_FROM: 'studio@example.test' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test', EMAIL_REPLY_TO: 'reply-to-the-studio' },
        { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test', EMAIL_REPLY_TO: 'help@localhost' },
      ]) {
        const callsBefore = fetchCalls
        const result = await sendEmail(env, message)
        const label = JSON.stringify(env)

        // Only the settings differ between runs, so any refusal is theirs.
        assert.ok(
          result.status === 'sent' ||
            (result.status === 'skipped' && result.reason === 'NOT_CONFIGURED') ||
            (result.status === 'failed' && result.reason === 'INVALID_CONFIGURATION'),
          label,
        )
        assert.equal(fetchCalls - callsBefore, result.status === 'sent' ? 1 : 0, label)
        assert.equal(isEmailConfigured(env), result.status === 'sent', label)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('settings2f and the retention purge need their exact values', () => {
    assert.equal(resolveFeatures({ ADMIN_SETTINGS_2F: 'required' }, EMPTY).settings2f.required, true)
    assert.equal(resolveFeatures({ RETENTION_PURGE: 'on' }, EMPTY).retentionPurge.enabled, true)

    for (const value of ['Required', 'on', 'true', ' required', undefined]) {
      assert.equal(resolveFeatures({ ADMIN_SETTINGS_2F: value }, EMPTY).settings2f.required, false, String(value))
    }

    for (const value of ['On', 'true', '1', undefined]) {
      assert.equal(resolveFeatures({ RETENTION_PURGE: value }, EMPTY).retentionPurge.enabled, false, String(value))
    }
  })

  test('OCe needs the var and the D1 switch; D1 is not read while the var is off', async () => {
    assert.equal(isOnlineConfirmationEffective({ ONLINE_CONFIRMATION: 'on' }, 'on'), true)
    assert.equal(isOnlineConfirmationEffective({ ONLINE_CONFIRMATION: 'on' }, 'off'), false)

    const { writer, d1 } = scenario()
    assert.equal(await readOnlineConfirmationEffective({ ONLINE_CONFIRMATION: 'off' }, d1), false)
    assert.equal(await readHoldAutoExpiry({ ONLINE_CONFIRMATION: 'on' }, d1), false)
    assert.equal(d1.calls.prepare, 0)

    const email = { ONLINE_CONFIRMATION: 'on', RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'studio@example.test' }
    assert.equal(await readOnlineConfirmationEffective(email, d1), true)
    assert.equal(await readHoldAutoExpiry(email, d1), true)

    insertSwitch(writer, 'off', T0)
    assert.equal(await readOnlineConfirmationEffective(email, d1), false)
    assert.equal(await readHoldAutoExpiry(email, d1), false)
  })

  test('loadFeatures reads the settings facts from D1 in one batch', async () => {
    const { writer, d1 } = scenario()
    const env = { ONLINE_CONFIRMATION: 'on' }
    const now = at(T0 + HOUR)

    assert.deepEqual((await loadFeatures(env, d1, now)).onlineConfirmation.missing, ['deposit', 'bank', 'terms'])

    insertDeposit(writer, T0)
    insertBank(writer, IBAN_A, T0)
    insertTerms(writer, 1, T0)
    assert.equal((await loadFeatures(env, d1, now)).onlineConfirmation.offered, true)

    // A bank change that is still pending does not complete the settings.
    const { writer: pendingWriter, d1: pendingD1 } = scenario()
    insertDeposit(pendingWriter, T0)
    insertTerms(pendingWriter, 1, T0)
    insertBank(pendingWriter, IBAN_A, T0, T0 + 24 * HOUR)
    const pending = await loadFeatures(env, pendingD1, now)
    assert.deepEqual(pending.onlineConfirmation.missing, ['bank'])
    assert.equal(pending.onlineConfirmation.offered, false)

    insertSwitch(writer, 'off', T0 + 30 * MINUTE)
    const pulled = await loadFeatures(env, d1, now)
    assert.equal(pulled.onlineConfirmation.killSwitch, 'off')
    assert.equal(pulled.onlineConfirmation.offered, false)
  })
})

// ---------------------------------------------------------------------------
// SB-7: nothing is logged
// ---------------------------------------------------------------------------

describe('SB-7: the readers never log', () => {
  test('no console call while reading bank details and flags', async () => {
    const { writer, d1 } = scenario()
    insertBank(writer, IBAN_A, T0)
    insertBank(writer, IBAN_BAD_CHECKSUM, T0 + HOUR)
    insertContact(writer, STUDIO, T0)
    const logged = []
    const methods = ['log', 'info', 'warn', 'error', 'debug', 'trace']
    const originals = methods.map((name) => console[name])

    methods.forEach((name) => {
      console[name] = (...args) => logged.push([name, args.length])
    })

    try {
      await readSettingsSnapshot(d1, at(T0 + 2 * HOUR))
      await readStudioContact(d1, at(T0 + 2 * HOUR))
      await loadFeatures({ ONLINE_CONFIRMATION: 'on' }, d1, at(T0 + 2 * HOUR))
    } finally {
      methods.forEach((name, index) => {
        console[name] = originals[index]
      })
    }

    assert.deepEqual(logged, [])
  })
})
