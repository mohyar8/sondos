// W2-03 / B1, H3, TM-15, N-50, N-52, SB-6, SB-13: the hold lifecycle jobs
// (worker/jobs/hold-expiry.ts, worker/jobs/hold-reminders.ts, their shared
// state in worker/jobs/hold-state.ts) and the hold emails
// (worker/emails/hold.ts).
//
// Every statement runs against a database built from the repository's own
// migrations (node:sqlite, foreign keys on, as in D1) through a small
// stand-in for the D1 API: prepare().bind(), first(), all(), run(), and
// batch() as one transaction that rolls back on the first failure. Each
// case fails if its control (the notice predicate, the AX gate, the
// in-statement switch check, the channel-aware copy) is taken out.
//
// Binding note: node:sqlite binds every number as REAL, so the stand-in
// binds safe integers as BigInt, as D1 binds a whole JavaScript number as
// INTEGER.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import {
  holdOwedStepCopy,
  renderHoldExpiredEmail,
  renderHoldReminderEmail,
} from '../worker/emails/hold.ts'
import {
  expireOverdueHolds,
  holdExpiryJob,
} from '../worker/jobs/hold-expiry.ts'
import {
  planHoldReminder,
  queueDueHoldReminders,
} from '../worker/jobs/hold-reminders.ts'
import {
  NOTICE_PROTECTED_SQL,
  SYSTEM_EXPIRABLE_HOLD_SQL,
  isNoticeForCurrentDeadline,
  owedStepFor,
  readOwedHold,
} from '../worker/jobs/hold-state.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const ADMIN = 'AdminUid0001'
const CUSTOMER = 'CustomerUid0001'
const CUSTOMER_EMAIL = 'bride@example.test'
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
/** 12:00 in Riyadh: inside the 09:00–21:00 send window. */
const NOW = Date.parse('2026-10-01T09:00:00.000Z')
const NOW_ISO = new Date(NOW).toISOString()

/** Email settings sendEmail would send with (EM on). */
const EMAIL_ENV = {
  RESEND_API_KEY: 're_test_key_for_unit_tests',
  EMAIL_FROM: 'المصورة سندس يار <studio@example.test>',
}
const AX_ENV = { ...EMAIL_ENV, ONLINE_CONFIRMATION: 'on', APP_BASE_URL: 'https://example.test' }

function iso(ms) {
  return new Date(ms).toISOString()
}

function sqlValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

function migratedDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => MIGRATION_FILE.test(file)).sort()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
  }

  const insertUser = db.prepare(
    `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
     VALUES (?, ?, ?, 'تجريبي', '+447700900000', ?, '2026-01-01T00:00:00.000Z')`,
  )
  insertUser.run(ADMIN, 'admin@example.test', 'اسم', 'admin')
  insertUser.run(CUSTOMER, CUSTOMER_EMAIL, 'سارة', 'customer')

  return db
}

/**
 * prepare().bind(), first(), all(), run() and batch() over node:sqlite.
 * `beforeBatch` runs just before each batch (to change the state between a
 * job's select and its write).
 */
function createD1(db, { beforeBatch = () => {} } = {}) {
  function execute(statement) {
    const info = db.prepare(statement.sql).run(...statement.values.map(sqlValue))

    return { success: true, meta: { changes: Number(info.changes) }, results: [] }
  }

  function statement(sql, values) {
    const prepared = {
      sql,
      values,
      bind: (...next) => statement(sql, next),
      async run() {
        return execute(prepared)
      },
      async all() {
        return {
          success: true,
          meta: {},
          results: db.prepare(sql).all(...values.map(sqlValue)),
        }
      },
      async first() {
        return db.prepare(sql).all(...values.map(sqlValue))[0] ?? null
      },
    }

    return prepared
  }

  return {
    prepare: (sql) => statement(sql, []),
    async batch(statements) {
      beforeBatch()
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

let bookingCount = 0

/** A flow-2 booking; each one gets its own event date (the blocking index). */
function insertHold(db, overrides = {}) {
  bookingCount += 1
  const id = overrides.id ?? `b2c0ffee-0000-4000-8000-${String(bookingCount).padStart(12, '0')}`
  const termsAcceptedAt = overrides.termsAcceptedAt ?? null

  db.prepare(
    `INSERT INTO booking_requests
       (id, user_id, event_date, status, package_snapshot, estimated_total,
        hold_expires_at, flow_version, deposit_amount, terms_version, terms_accepted_at)
     VALUES (?, ?, ?, ?, '{}', 6500, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    CUSTOMER,
    overrides.eventDate ?? `2026-12-${String(bookingCount).padStart(2, '0')}`,
    overrides.status ?? 'approved_hold',
    overrides.holdExpiresAt ?? iso(NOW - HOUR),
    BigInt(overrides.flowVersion ?? 2),
    (overrides.flowVersion ?? 2) === 2 ? 1300n : null,
    termsAcceptedAt === null ? null : 'v1',
    termsAcceptedAt,
  )

  return id
}

function insertNotice(db, bookingId, holdExpiresAt) {
  db.prepare(
    `INSERT INTO booking_events (booking_id, actor, event, details, created_at)
     VALUES (?, 'customer', 'deposit_notice_sent', json_object('holdExpiresAt', ?), ?)`,
  ).run(bookingId, holdExpiresAt, iso(NOW - 2 * HOUR))
}

function insertSwitch(db, state) {
  db.prepare(
    `INSERT INTO ops_switch_revisions (switch_name, state, note, created_by, reauth_at, created_at)
     VALUES ('online_confirmation', ?, NULL, ?, ?, ?)`,
  ).run(state, ADMIN, state === 'on' ? iso(NOW - 3 * MINUTE) : null, iso(NOW - 2 * MINUTE))
}

function statusOf(db, id) {
  return db.prepare('SELECT status FROM booking_requests WHERE id = ?').get(id).status
}

function outboxRows(db, bookingId) {
  return db
    .prepare('SELECT dedupe_key, kind, recipient, payload, status FROM notification_log WHERE booking_id = ? ORDER BY dedupe_key')
    .all(bookingId)
}

function env(db, vars = AX_ENV, options) {
  return { ...vars, DB: createD1(db, options) }
}

function expiryOptions(extra = {}) {
  return { nowIso: NOW_ISO, signal: new AbortController().signal, appBaseUrl: 'https://example.test', ...extra }
}

function reminderOptions(nowIso = NOW_ISO) {
  return { nowIso, signal: new AbortController().signal, appBaseUrl: 'https://example.test' }
}

// ---------------------------------------------------------------------------
// hold-state: NOTICE_PROTECTED (N-50) and what she owes
// ---------------------------------------------------------------------------

describe('NOTICE_PROTECTED predicate (B1, N-50)', () => {
  test('protects only for a notice whose holdExpiresAt equals the current deadline', () => {
    const db = migratedDatabase()
    const deadline = iso(NOW - HOUR)
    const current = insertHold(db, { holdExpiresAt: deadline, termsAcceptedAt: iso(NOW - 20 * HOUR) })
    const earlier = insertHold(db, { holdExpiresAt: deadline, termsAcceptedAt: iso(NOW - 20 * HOUR) })
    const bare = insertHold(db)
    insertNotice(db, current, deadline)
    insertNotice(db, earlier, iso(NOW - 25 * HOUR))

    const protectedIds = db
      .prepare(`SELECT b.id FROM booking_requests AS b WHERE ${NOTICE_PROTECTED_SQL} ORDER BY b.id`)
      .all()
      .map((row) => row.id)

    assert.deepEqual(protectedIds, [current])
    assert.ok(!protectedIds.includes(bare))
  })

  test('a notice whose holdExpiresAt is not a string protects nothing', () => {
    const db = migratedDatabase()
    const id = insertHold(db)
    db.prepare(
      `INSERT INTO booking_events (booking_id, actor, event, details, created_at)
       VALUES (?, 'customer', 'deposit_notice_sent', '{"holdExpiresAt":1}', ?)`,
    ).run(id, NOW_ISO)

    const row = db
      .prepare(`SELECT ${NOTICE_PROTECTED_SQL} AS p FROM booking_requests AS b WHERE b.id = ?`)
      .get(id)
    assert.equal(row.p, 0)
  })

  test('SYSTEM_EXPIRABLE_HOLD_SQL excludes protected holds and everything while the switch is off', () => {
    const db = migratedDatabase()
    const deadline = iso(NOW - HOUR)
    const open = insertHold(db, { holdExpiresAt: deadline })
    const noticed = insertHold(db, { holdExpiresAt: deadline, termsAcceptedAt: iso(NOW - 5 * HOUR) })
    insertNotice(db, noticed, deadline)
    const select = () =>
      db.prepare(`SELECT b.id FROM booking_requests AS b WHERE ${SYSTEM_EXPIRABLE_HOLD_SQL}`).all().map((row) => row.id)

    assert.deepEqual(select(), [open])
    insertSwitch(db, 'off')
    assert.deepEqual(select(), [])
  })

  test('the JavaScript twin agrees', () => {
    const deadline = '2026-10-01T08:00:00.000Z'
    assert.equal(isNoticeForCurrentDeadline(deadline, deadline), true)
    assert.equal(isNoticeForCurrentDeadline('2026-09-30T08:00:00.000Z', deadline), false)
    assert.equal(isNoticeForCurrentDeadline(Date.parse(deadline), deadline), false)
    assert.equal(isNoticeForCurrentDeadline('2026-10-01 08:00:00', '2026-10-01 08:00:00'), false)
  })

  test('owedStepFor: terms first, then the receipt; a rejected receipt owes a new one', () => {
    assert.equal(owedStepFor('approved_hold', null, false), 'accept_terms')
    assert.equal(owedStepFor('approved_hold', null, true), 'deposit_receipt')
    assert.equal(owedStepFor('payment_pending', 'rejected', true), 'new_receipt')
    assert.equal(owedStepFor('payment_pending', 'pending', true), null)
    assert.equal(owedStepFor('confirmed', null, true), null)
  })

  test('readOwedHold refuses rows without the notice column (fail closed)', () => {
    const row = {
      id: 'b1',
      flow_version: 2,
      status: 'approved_hold',
      event_date: '2026-12-01',
      hold_expires_at: NOW_ISO,
      terms_accepted_at: null,
      latest_receipt_status: null,
      customer_email: CUSTOMER_EMAIL,
      customer_first_name: 'سارة',
    }
    assert.equal(readOwedHold(row), null)
    assert.equal(readOwedHold({ ...row, notice_protected: 0 })?.owedStep, 'accept_terms')
    assert.equal(readOwedHold({ ...row, notice_protected: 0, flow_version: 1 }), null)
  })
})

// ---------------------------------------------------------------------------
// hold-expiry (N-50, N-52)
// ---------------------------------------------------------------------------

describe('hold-expiry job', () => {
  test('AX on: an unprotected overdue hold expires with its email; a protected one is untouched (N-50)', async () => {
    const db = migratedDatabase()
    const deadline = iso(NOW - HOUR)
    const open = insertHold(db, { holdExpiresAt: deadline })
    const noticed = insertHold(db, { holdExpiresAt: deadline, termsAcceptedAt: iso(NOW - 5 * HOUR) })
    insertNotice(db, noticed, deadline)
    const stale = insertHold(db, { holdExpiresAt: deadline, termsAcceptedAt: iso(NOW - 30 * HOUR) })
    insertNotice(db, stale, iso(NOW - 30 * HOUR))

    const summary = await expireOverdueHolds(env(db), expiryOptions())

    assert.equal(summary.autoExpiryOn, true)
    assert.equal(summary.expired, 2)
    assert.equal(statusOf(db, open), 'expired')
    assert.equal(statusOf(db, stale), 'expired', 'a notice for an earlier deadline protects nothing')
    assert.equal(statusOf(db, noticed), 'approved_hold')
    assert.deepEqual(outboxRows(db, noticed), [])

    const [email] = outboxRows(db, open)
    assert.equal(email.kind, 'hold_expired')
    assert.equal(email.dedupe_key, `hold_expired:${open}:${deadline}`)
    assert.ok(!email.dedupe_key.includes('@'), 'no personal data in the dedupe key (SB-13)')
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE booking_id = ? AND event = 'hold_expired' AND actor = 'system'").get(open).n,
      1,
    )
  })

  test('the targeted sweep (eventDate) spares a protected hold too', async () => {
    const db = migratedDatabase()
    const deadline = iso(NOW - HOUR)
    const noticed = insertHold(db, { holdExpiresAt: deadline, termsAcceptedAt: iso(NOW - 5 * HOUR), eventDate: '2027-01-15' })
    insertNotice(db, noticed, deadline)

    const summary = await expireOverdueHolds(env(db), expiryOptions({ eventDate: '2027-01-15' }))

    assert.equal(summary.selected, 0)
    assert.equal(statusOf(db, noticed), 'approved_hold')
  })

  test('no email provider: AX off, nothing expires (B1 #4)', async () => {
    const db = migratedDatabase()
    const open = insertHold(db)

    const summary = await expireOverdueHolds(
      env(db, { ONLINE_CONFIRMATION: 'on' }),
      expiryOptions(),
    )

    assert.equal(summary.autoExpiryOn, false)
    assert.equal(summary.selected, 0)
    assert.equal(statusOf(db, open), 'approved_hold')
  })

  test('ONLINE_CONFIRMATION off: nothing expires (N-52)', async () => {
    const db = migratedDatabase()
    const open = insertHold(db)

    const summary = await expireOverdueHolds(env(db, { ...EMAIL_ENV, ONLINE_CONFIRMATION: 'On' }), expiryOptions())

    assert.equal(summary.autoExpiryOn, false)
    assert.equal(statusOf(db, open), 'approved_hold')
  })

  test('D1 kill switch off: nothing expires (N-52, H3)', async () => {
    const db = migratedDatabase()
    const open = insertHold(db)
    insertSwitch(db, 'off')

    const summary = await expireOverdueHolds(env(db), expiryOptions())

    assert.equal(summary.autoExpiryOn, false)
    assert.equal(statusOf(db, open), 'approved_hold')
  })

  test('the switch pulled between the select and the write: the batch rolls back (TM-15)', async () => {
    const db = migratedDatabase()
    const open = insertHold(db)
    let pulled = false

    const summary = await expireOverdueHolds(
      env(db, AX_ENV, {
        beforeBatch() {
          if (!pulled) {
            pulled = true
            insertSwitch(db, 'off')
          }
        },
      }),
      expiryOptions(),
    )

    assert.equal(summary.raced, 1)
    assert.equal(summary.expired, 0)
    assert.equal(statusOf(db, open), 'approved_hold')
    assert.deepEqual(outboxRows(db, open), [])
  })

  test('a notice recorded between the select and the write: the batch rolls back (TM-15)', async () => {
    const db = migratedDatabase()
    const deadline = iso(NOW - HOUR)
    const hold = insertHold(db, { holdExpiresAt: deadline, termsAcceptedAt: iso(NOW - 5 * HOUR) })
    let noticed = false

    const summary = await expireOverdueHolds(
      env(db, AX_ENV, {
        beforeBatch() {
          if (!noticed) {
            noticed = true
            insertNotice(db, hold, deadline)
          }
        },
      }),
      expiryOptions(),
    )

    assert.equal(summary.raced, 1)
    assert.equal(statusOf(db, hold), 'approved_hold')
  })

  test('legacy flow-1 rows are never touched', async () => {
    const db = migratedDatabase()
    const legacy = insertHold(db, { flowVersion: 1, status: 'approved_hold', holdExpiresAt: iso(NOW - 48 * HOUR) })

    const summary = await expireOverdueHolds(env(db), expiryOptions())

    assert.equal(summary.selected, 0)
    assert.equal(statusOf(db, legacy), 'approved_hold')
  })

  test('the cron job logs counts only, under count=', async () => {
    const db = migratedDatabase()
    insertHold(db)
    const logged = []
    const original = console.log
    console.log = (...values) => logged.push(values.join(' '))

    try {
      await holdExpiryJob.run({
        env: env(db),
        ctx: {},
        now: new Date(NOW),
        nowIso: NOW_ISO,
        scheduledTime: NOW,
        signal: new AbortController().signal,
      })
    } finally {
      console.log = original
    }

    assert.deepEqual(logged, ['HOLD_EXPIRY_DONE count=1'])
  })
})

// ---------------------------------------------------------------------------
// hold-reminders
// ---------------------------------------------------------------------------

describe('hold-reminders job', () => {
  test('channel-aware copy: accept the terms, or send the receipt on WhatsApp', async () => {
    const db = migratedDatabase()
    const withoutTerms = insertHold(db, { holdExpiresAt: iso(NOW + 5 * HOUR) })
    const withTerms = insertHold(db, { holdExpiresAt: iso(NOW + 5 * HOUR), termsAcceptedAt: iso(NOW - HOUR) })

    const summary = await queueDueHoldReminders(env(db), reminderOptions())

    assert.equal(summary.remindersOn, true)
    assert.equal(summary.queued, 2)

    const termsRow = outboxRows(db, withoutTerms).find((row) => row.kind === 'hold_reminder_6h')
    const receiptRow = outboxRows(db, withTerms).find((row) => row.kind === 'hold_reminder_6h')
    const termsText = JSON.parse(termsRow.payload).text
    const receiptText = JSON.parse(receiptRow.payload).text

    assert.ok(termsText.includes(holdOwedStepCopy('accept_terms', 'whatsapp')))
    assert.ok(receiptText.includes(holdOwedStepCopy('deposit_receipt', 'whatsapp')))
    assert.ok(receiptText.includes('واتساب'))
    assert.ok(!receiptText.includes('ارفعي'), 'no upload wording while uploads are gated')
    assert.equal(termsRow.recipient, CUSTOMER_EMAIL)
    assert.equal(termsRow.dedupe_key, `hold_reminder_6h:${withoutTerms}:${iso(NOW + 5 * HOUR)}`)
  })

  test('a notice-protected hold gets no reminder, and a pending one is superseded (B1)', async () => {
    const db = migratedDatabase()
    const deadline = iso(NOW + 5 * HOUR)
    const hold = insertHold(db, { holdExpiresAt: deadline, termsAcceptedAt: iso(NOW - HOUR) })
    db.prepare(
      `INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, attempts, created_at, updated_at)
       VALUES (?, ?, 'hold_reminder_24h', ?, '{}', 'pending', 0, ?, ?)`,
    ).run(`hold_reminder_24h:${hold}:${deadline}`, hold, CUSTOMER_EMAIL, iso(NOW - 19 * HOUR), iso(NOW - 19 * HOUR))
    insertNotice(db, hold, deadline)

    const summary = await queueDueHoldReminders(env(db), reminderOptions())

    assert.equal(summary.queued, 0)
    assert.equal(summary.superseded, 1)
    assert.deepEqual(
      outboxRows(db, hold).map((row) => [row.kind, row.status, row.recipient, row.payload]),
      [['hold_reminder_24h', 'superseded', null, null]],
    )
  })

  test('AX off (no email provider, or the switch pulled): nothing is queued', async () => {
    for (const [label, vars, pull] of [
      ['no email provider', { ONLINE_CONFIRMATION: 'on' }, false],
      ['switch off', AX_ENV, true],
    ]) {
      const db = migratedDatabase()
      const hold = insertHold(db, { holdExpiresAt: iso(NOW + 5 * HOUR) })
      if (pull) insertSwitch(db, 'off')

      const summary = await queueDueHoldReminders(env(db, vars), reminderOptions())

      assert.equal(summary.remindersOn, false, label)
      assert.equal(summary.queued, 0, label)
      assert.deepEqual(outboxRows(db, hold), [], label)
    }
  })

  test('terms accepted between the select and the insert: the stale copy is not queued (TM-15)', async () => {
    const db = migratedDatabase()
    const hold = insertHold(db, { holdExpiresAt: iso(NOW + 5 * HOUR) })
    let accepted = false

    const summary = await queueDueHoldReminders(
      env(db, AX_ENV, {
        beforeBatch() {
          if (!accepted) {
            accepted = true
            db.prepare("UPDATE booking_requests SET terms_version = 'v1', terms_accepted_at = ? WHERE id = ?").run(NOW_ISO, hold)
          }
        },
      }),
      reminderOptions(),
    )

    assert.equal(summary.queued, 0)
    assert.equal(outboxRows(db, hold).filter((row) => row.status === 'pending').length, 0)
  })

  test('legacy flow-1 rows get no reminder', async () => {
    const db = migratedDatabase()
    const legacy = insertHold(db, { flowVersion: 1, holdExpiresAt: iso(NOW + 5 * HOUR) })

    const summary = await queueDueHoldReminders(env(db), reminderOptions())

    assert.equal(summary.selected, 0)
    assert.deepEqual(outboxRows(db, legacy), [])
  })

  test('planHoldReminder: protected or off only supersedes what is pending', () => {
    const base = {
      holdExpiresAtMs: NOW + 5 * HOUR,
      deadlineSetAtMs: null,
      recorded: { hold_reminder_24h: 'pending', hold_reminder_6h: null },
    }
    const on = { remindersOn: true, inSendWindow: true }

    assert.deepEqual(planHoldReminder({ ...base, noticeProtected: false }, NOW, on), {
      send: 'hold_reminder_6h',
      supersede: ['hold_reminder_24h'],
    })
    assert.deepEqual(planHoldReminder({ ...base, noticeProtected: true }, NOW, on), {
      send: null,
      supersede: ['hold_reminder_24h'],
    })
    assert.deepEqual(
      planHoldReminder({ ...base, noticeProtected: false }, NOW, { remindersOn: false, inSendWindow: true }),
      { send: null, supersede: ['hold_reminder_24h'] },
    )
    assert.deepEqual(
      planHoldReminder(
        { ...base, noticeProtected: true, recorded: { hold_reminder_24h: 'sent', hold_reminder_6h: null } },
        NOW,
        on,
      ),
      { send: null, supersede: [] },
    )
  })
})

// ---------------------------------------------------------------------------
// emails/hold.ts (SB-6)
// ---------------------------------------------------------------------------

describe('hold emails', () => {
  const input = {
    kind: 'hold_reminder_24h',
    customerFirstName: '<img src=x onerror=alert(1)>‮سارة',
    bookingId: 'b2c0ffee-0000-4000-8000-000000000001',
    eventDate: '2026-12-01',
    holdExpiresAt: '2026-10-02T09:00:00.000Z',
    appBaseUrl: 'https://example.test',
  }

  test('the three instructions: accept the terms, WhatsApp, upload', () => {
    const terms = renderHoldReminderEmail({ ...input, owedStep: 'accept_terms', receiptChannel: 'upload' })
    const whatsapp = renderHoldReminderEmail({ ...input, owedStep: 'deposit_receipt', receiptChannel: 'whatsapp' })
    const upload = renderHoldReminderEmail({ ...input, owedStep: 'deposit_receipt', receiptChannel: 'upload' })
    const again = renderHoldReminderEmail({ ...input, owedStep: 'new_receipt', receiptChannel: 'whatsapp' })

    assert.ok(terms.text.includes('وافقي على شروط الحجز'))
    assert.ok(whatsapp.text.includes('أرسلي إيصال التحويل عبر واتساب'))
    assert.ok(upload.text.includes('ارفعي إيصال التحويل'))
    assert.ok(again.text.includes('إيصالًا جديدًا') && again.text.includes('واتساب'))
    assert.equal(new Set([terms.text, whatsapp.text, upload.text, again.text]).size, 4)
  })

  test('escaped and bidi-isolated: name and reference, no number, no bank details', () => {
    const email = renderHoldReminderEmail({ ...input, owedStep: 'deposit_receipt', receiptChannel: 'whatsapp' })

    assert.ok(!email.html.includes('<img'))
    assert.ok(email.html.includes('&lt;img src=x onerror=alert(1)&gt;'))
    assert.ok(!email.text.includes('‮') && !email.html.includes('‮'))
    assert.ok(email.text.includes('⁨'), 'the name sits in a first-strong isolate')
    assert.ok(email.text.includes(`⁦${input.bookingId}⁩`), 'the reference sits in an LTR isolate')
    assert.ok(email.html.includes(`dir="ltr"`))
    assert.ok(!/966\d{6,}|IBAN|SA\d{22}/.test(email.text), 'no phone number or IBAN in the email')
  })

  test('the expired notice escapes and isolates too', () => {
    const email = renderHoldExpiredEmail(input)

    assert.ok(!email.html.includes('<img'))
    assert.ok(!email.text.includes('‮'))
    assert.ok(email.text.includes(`⁦${input.bookingId}⁩`))
  })
})
