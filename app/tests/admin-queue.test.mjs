// W2-10 / B1, UX-02, UX-03, UX-05, UX-06, TM-03, GAP-04, SB-2, SB-13: the
// admin work queue (plan 11 §3.2 #35): shared/portal/admin-queue.ts,
// worker/portal/admin-queue.ts and its slot route.
//
// Every statement runs against a database built from the repository's own
// migrations (node:sqlite, foreign keys on, as in D1) through a small
// stand-in for the D1 API over a READ-ONLY connection, so the loader can
// never write. The loader is driven with a fixed clock; the handler with
// the context the admin portal dispatcher builds after authorizeAdminRequest
// (tests/portal-routes.test.mjs covers the dispatcher itself). The last
// group applies scripts/dev-seed.sql and checks that it reaches every
// section the plan's §6.3 runtime check names.
//
// Binding note: node:sqlite binds every number as REAL, so the stand-in binds
// safe integers as BigInt, as D1 binds a whole JavaScript number as INTEGER.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, describe, test } from 'node:test'

import {
  ADMIN_QUEUE_ALERT_CODES,
  ADMIN_QUEUE_REPEAT_HOLD_FLAG_COUNT,
  ADMIN_QUEUE_SECTION_IDS,
  ADMIN_QUEUE_SECTION_MAX_ITEMS,
  ADMIN_QUEUE_TEMPLATE_IDS,
  adminQueuePrivateMediaSections,
  adminQueueSectionLabels,
  adminQueueSectionOrder,
  adminQueueSectionTemplates,
  isAdminQueueItem,
  isAdminQueueResponse,
  isAdminQueueSection,
  isAdminQueueWaDigits,
} from '../shared/portal/admin-queue.ts'
import { adminContactTemplateIds as spaTemplateIds } from '../src/features/admin-contact/whatsapp-templates.ts'
import { adminContactTemplateIds as logTemplateIds } from '../worker/portal/admin-booking-log.ts'
import { ADMIN_QUEUE_SQL, handleAdminQueue, loadAdminQueue } from '../worker/portal/admin-queue.ts'
import { adminQueueRoutes } from '../worker/portal/slots/admin-queue.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const SEED_SQL = readFileSync(new URL('../scripts/dev-seed.sql', import.meta.url), 'utf8')
const SEED_PLACEHOLDER = '{{CUSTOMER_UID}}'
const ADMIN = 'AdminUid0001'
const SNAPSHOT = JSON.stringify({ schemaVersion: 1, package: { id: 'four-hours', name: '4 ساعات' } })

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 12:00 Riyadh on 2031-03-10 (UTC+3, no daylight saving). */
const NOW = Date.parse('2031-03-10T09:00:00.000Z')
const TODAY = '2031-03-10'
const TOMORROW = '2031-03-11'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function iso(ms) {
  return new Date(ms).toISOString()
}

// ---------------------------------------------------------------------------
// Environments: the flags the queue reads (worker/settings/features.ts, gates.ts)
// ---------------------------------------------------------------------------

/** EM on: Resend settings sendEmail would accept. */
const EMAIL_VARS = { RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'المصورة سندس يار <studio@example.test>' }
/** AX on (with the kill switch on): EM and the ONLINE_CONFIRMATION var. */
const AX_VARS = { ...EMAIL_VARS, ONLINE_CONFIRMATION: 'on' }

/** An object shaped like the Workers R2Bucket binding (every method, no fetch). */
function r2BucketShape() {
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

/** PM open: every private-media condition met. */
const PRIVATE_MEDIA_VARS = {
  ...AX_VARS,
  PDPL_SIGNOFF_REF: 'PDPL-2026-TEST',
  MEDIA_SIGNING_KEY: 'k'.repeat(32),
}

function envFor(db, vars = {}) {
  const env = { DB: db, ...vars }

  if (vars === PRIVATE_MEDIA_VARS) {
    env.MEDIA = r2BucketShape()
  }

  return env
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const folder = mkdtempSync(join(tmpdir(), 'sy-admin-queue-'))
const openConnections = []
let databaseCount = 0

after(() => {
  for (const connection of openConnections) {
    connection.close()
  }

  rmSync(folder, { recursive: true, force: true })
})

let templatePath = null

function migratedTemplate() {
  if (templatePath === null) {
    const path = join(folder, 'template.sqlite')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA foreign_keys = ON')

    for (const name of readdirSync(MIGRATIONS).filter((file) => MIGRATION_FILE.test(file)).sort()) {
      db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
    }

    db.close()
    templatePath = path
  }

  return templatePath
}

function createDatabase() {
  databaseCount += 1
  const path = join(folder, `queue-${databaseCount}.sqlite`)
  copyFileSync(migratedTemplate(), path)
  const writer = new DatabaseSync(path)
  openConnections.push(writer)
  writer.exec('PRAGMA foreign_keys = ON')
  writer
    .prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, created_at, email_verified_at)
       VALUES (?, 'admin@example.test', 'سندس', 'يار', '+966500000000', 'admin', '2026-01-01 00:00:00', '2026-01-01T00:00:00.000Z')`,
    )
    .run(ADMIN)

  return { path, writer }
}

function toBinding(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

function createReadOnlyD1(path) {
  const reader = new DatabaseSync(path, { readOnly: true })
  openConnections.push(reader)
  const calls = { prepare: 0, batch: 0 }

  function rows(prepared) {
    return reader.prepare(prepared.sql).all(...prepared.values.map(toBinding))
  }

  function statement(sql, values) {
    const prepared = {
      sql,
      values,
      bind: (...next) => statement(sql, next),
      async all() {
        return { success: true, meta: {}, results: rows(prepared) }
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

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function addUser(writer, { id, firstName = 'نورة', phone = '+966512345678', erasedAt = null }) {
  writer
    .prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, created_at, erased_at)
       VALUES (?, ?, ?, 'تجريبية', ?, 'customer', '2026-01-01 00:00:00', ?)`,
    )
    .run(id, `${id.toLowerCase()}@example.test`, firstName, phone, erasedAt)
}

let bookingCount = 0

/**
 * One booking. A flow-2 row carries the deposit the CHECK requires; terms
 * come with their version; `history` adds status-history rows as
 * [fromStatus, toStatus, createdAt].
 */
function addBooking(
  writer,
  {
    userId,
    eventDate,
    status = 'pending_review',
    flowVersion = 1,
    holdExpiresAt = null,
    termsAcceptedAt = null,
    completedAt = null,
    createdAt = iso(NOW - 10 * DAY),
    updatedAt = createdAt,
    bankRevisionId = null,
    depositReceived = null,
    history = [],
  },
) {
  bookingCount += 1
  const id = `b00c0000-0000-4000-8000-${String(bookingCount).padStart(12, '0')}`

  writer
    .prepare(
      `INSERT INTO booking_requests
         (id, user_id, event_date, status, package_snapshot, estimated_total, created_at, updated_at,
          flow_version, hold_expires_at, deposit_amount, terms_version, terms_accepted_at, completed_at,
          bank_revision_id, deposit_received_amount, deposit_received_at)
       VALUES (?, ?, ?, ?, ?, 4000, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      eventDate,
      status,
      SNAPSHOT,
      createdAt,
      updatedAt,
      BigInt(flowVersion),
      holdExpiresAt,
      flowVersion === 2 ? 1000n : null,
      termsAcceptedAt === null ? null : 'v1',
      termsAcceptedAt,
      completedAt,
      bankRevisionId === null ? null : BigInt(bankRevisionId),
      depositReceived === null ? null : BigInt(depositReceived),
      depositReceived === null ? null : iso(NOW - 9 * DAY),
    )

  for (const [fromStatus, toStatus, at] of history) {
    addHistory(writer, id, fromStatus, toStatus, at)
  }

  return id
}

function addHistory(writer, bookingId, fromStatus, toStatus, createdAt) {
  writer
    .prepare(
      `INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?)`,
    )
    .run(bookingId, fromStatus, toStatus, createdAt)
}

function addEvent(writer, bookingId, event, details, createdAt, actor = 'customer') {
  writer
    .prepare(
      `INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(bookingId, actor, actor === 'admin' ? ADMIN : null, event, details === null ? null : JSON.stringify(details), createdAt)
}

function addNotice(writer, bookingId, holdExpiresAt, createdAt = iso(NOW - 3 * HOUR)) {
  addEvent(writer, bookingId, 'deposit_notice_sent', { holdExpiresAt }, createdAt)
}

/** A contact-log row as W2-05 writes it: `{"template"}` and nothing else. */
function addContactLog(writer, bookingId, outcome, template, createdAt) {
  const event = { opened: 'admin_whatsapp_opened', sent: 'admin_whatsapp_sent', dismissed: 'admin_queue_dismissed' }[outcome]

  addEvent(writer, bookingId, event, { template }, createdAt, 'admin')
}

function addEventProfile(writer, bookingId, { startTime = null, venueArea = null, updatedAt = iso(NOW - 2 * DAY) } = {}) {
  writer
    .prepare(
      `INSERT INTO event_profiles (booking_id, venue_name, venue_area, event_start_time, created_at, updated_at)
       VALUES (?, 'قاعة تجريبية', ?, ?, ?, ?)`,
    )
    .run(bookingId, venueArea, startTime, updatedAt, updatedAt)
}

let receiptCount = 0

function addReceipt(writer, bookingId, status, createdAt) {
  receiptCount += 1
  const reviewedAt = status === 'pending' ? null : iso(Date.parse(createdAt) + HOUR)

  writer
    .prepare(
      `INSERT INTO booking_receipts (id, booking_id, attempt_no, status, reviewed_by, reviewed_at, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(`5eed0ec0-0000-4000-8000-${String(receiptCount).padStart(12, '0')}`, bookingId, status, reviewedAt === null ? null : ADMIN, reviewedAt, createdAt, reviewedAt ?? createdAt)
}

let galleryCount = 0

function addGallery(writer, bookingId, { status, openedAt, selectionDeadline, submittedAt = null }) {
  galleryCount += 1

  writer
    .prepare(
      `INSERT INTO galleries (id, booking_id, status, quota, quota_source, opened_at, selection_deadline, submitted_at, created_at, updated_at)
       VALUES (?, ?, ?, 45, 'package', ?, ?, ?, ?, ?)`,
    )
    .run(`5eed9a11-0000-4000-8000-${String(galleryCount).padStart(12, '0')}`, bookingId, status, openedAt, selectionDeadline, submittedAt, openedAt, submittedAt ?? openedAt)
}

function addProduction(writer, bookingId, stage, updatedAt = iso(NOW - 2 * DAY)) {
  writer
    .prepare('INSERT INTO album_production (booking_id, stage, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(bookingId, stage, updatedAt, updatedAt)
}

let slotCount = 0

function addHandover(writer, bookingId, { startsAt, status = 'scheduled', method = 'pickup', updatedAt = iso(NOW - DAY) }) {
  slotCount += 1
  const slotId = `5eed5107-0000-4000-8000-${String(slotCount).padStart(12, '0')}`
  const createdAt = iso(NOW - 5 * DAY)

  writer
    .prepare(
      `INSERT INTO handover_slots (id, starts_at, ends_at, method, capacity, is_active, created_at, updated_at)
       VALUES (?, ?, ?, 'both', 2, 1, ?, ?)`,
    )
    .run(slotId, startsAt, iso(Date.parse(startsAt) + HOUR), createdAt, createdAt)
  writer
    .prepare(
      `INSERT INTO handovers (booking_id, slot_id, method, status, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(bookingId, slotId, method, status, createdAt, updatedAt, status === 'completed' ? updatedAt : null)
}

let revisionCount = 0

/** A bank revision (reauth_at one minute before created_at, inside the 10-minute CHECK). */
function addBankRevision(writer, { createdAt, effectiveAt = null, iban = 'SA0380000000608010167519' }) {
  revisionCount += 1
  const info = writer
    .prepare(
      `INSERT INTO settings_revisions
         (section, bank_name, bank_account_holder, bank_iban, created_by, reauth_at, created_at, effective_at)
       VALUES ('bank', 'مصرف تجريبي', 'سندس يار', ?, ?, ?, ?, ?)`,
    )
    .run(iban, ADMIN, iso(Date.parse(createdAt) - MINUTE), createdAt, effectiveAt)

  return Number(info.lastInsertRowid)
}

function addKillSwitch(writer, state, createdAt) {
  writer
    .prepare(
      `INSERT INTO ops_switch_revisions (switch_name, state, note, created_by, reauth_at, created_at)
       VALUES ('online_confirmation', ?, NULL, ?, ?, ?)`,
    )
    .run(state, ADMIN, state === 'on' ? iso(Date.parse(createdAt) - MINUTE) : null, createdAt)
}

// ---------------------------------------------------------------------------
// Handler context (what the admin dispatcher passes after the admin guard)
// ---------------------------------------------------------------------------

function limiter(success) {
  const keys = []

  return {
    keys,
    async limit({ key }) {
      keys.push(key)
      return { success }
    },
  }
}

async function call(db, path, { limited = false, vars = {} } = {}) {
  const rateLimit = limiter(!limited)
  const url = new URL(`https://example.test${path}`)
  const response = await handleAdminQueue({
    request: new Request(url),
    env: { ...envFor(db, vars), RL_ADMIN_READ: rateLimit },
    ctx: { waitUntil() {}, passThroughOnException() {} },
    url,
    admin: { uid: ADMIN, authTime: 0, secondFactor: null },
    params: {},
  })

  return { status: response.status, headers: response.headers, body: await response.json(), rateLimit }
}

function sectionIds(response) {
  return response.sections.map((section) => section.id)
}

function sectionOf(response, id) {
  return response.sections.find((section) => section.id === id) ?? null
}

function itemOf(response, sectionId, bookingId) {
  return sectionOf(response, sectionId)?.items.find((item) => item.bookingId === bookingId) ?? null
}

// ---------------------------------------------------------------------------
// Slot and shared contract
// ---------------------------------------------------------------------------

describe('slot', () => {
  test('one GET route, no parameters, gate open', () => {
    assert.deepEqual(
      adminQueueRoutes.map((route) => [route.path.join('/'), route.gate, Object.keys(route.handlers)]),
      [['queue', 'open', ['GET']]],
    )
  })
})

describe('shared contract (#35, UX-05)', () => {
  test('the fixed section order starts with decide_now and the six urgent sections', () => {
    assert.deepEqual(ADMIN_QUEUE_SECTION_IDS.slice(0, 6), [
      'decide_now',
      'holds_expiring',
      'deposit_notices',
      'requests_over_sla',
      'events_today_tomorrow',
      'handovers_today_tomorrow',
    ])
    assert.equal(ADMIN_QUEUE_SECTION_IDS.length, 15)
    assert.equal(new Set(ADMIN_QUEUE_SECTION_IDS).size, 15)
    assert.deepEqual(
      ADMIN_QUEUE_SECTION_IDS.map(adminQueueSectionOrder),
      ADMIN_QUEUE_SECTION_IDS.map((_, index) => index + 1),
    )
    assert.equal(ADMIN_QUEUE_SECTION_MAX_ITEMS, 50)
  })

  test('every section has one template, an Arabic label, and the ids match W2-14 and W2-05', () => {
    for (const id of ADMIN_QUEUE_SECTION_IDS) {
      assert.ok(ADMIN_QUEUE_TEMPLATE_IDS.includes(adminQueueSectionTemplates[id]), id)
      assert.match(adminQueueSectionLabels[id], /[؀-ۿ]/, id)
    }

    assert.deepEqual([...ADMIN_QUEUE_TEMPLATE_IDS], [...spaTemplateIds])
    assert.deepEqual([...ADMIN_QUEUE_TEMPLATE_IDS], [...logTemplateIds])
    assert.deepEqual([...adminQueuePrivateMediaSections], ['receipts_pending', 'selection_overdue'])
    assert.deepEqual([...ADMIN_QUEUE_ALERT_CODES], [
      'BANK_DETAILS_CHANGED_RECENTLY',
      'SETTINGS_CHANGE_PENDING',
      'ONLINE_CONFIRMATION_NOT_OFFERED',
      'KILL_SWITCH_OFF',
      'CRON_STALE',
      'CSP_VIOLATIONS',
    ])
  })

  test('waDigits is exactly ^[1-9]\\d{7,14}$ (UX-03)', () => {
    for (const value of ['966512345678', '447700900001', '12345678', '1'.repeat(15)]) {
      assert.equal(isAdminQueueWaDigits(value), true, value)
    }

    for (const value of ['0966512345678', '+966512345678', '1234567', '1'.repeat(16), '٩٦٦٥١٢٣٤٥٦٧٨', '966 512345678', '', 966512345678, null]) {
      assert.equal(isAdminQueueWaDigits(value), false, String(value))
    }
  })

  test('the response guard refuses a section out of order, empty, over the cap or with a bad item', () => {
    const item = {
      bookingId: 'b', reference: 'b', eventDate: TODAY, customerFirstName: 'نورة', status: 'confirmed',
      stage: 'confirmed', dueAt: null, suggestedTemplate: 'event_reminder', waDigits: '966512345678',
      templateInputs: { amount: 1000, holdExpiresAt: null, slotStartsAt: null, method: null, productionStage: null },
      startTime: '20:00', venueArea: 'الرياض', lastContact: null,
      repeatHolds: { expired: 0, abandoned: 0, flagged: false },
    }
    const section = (id, items = [item]) => ({ id, order: adminQueueSectionOrder(id), total: items.length, items })
    const base = {
      ok: true,
      summary: { decideNow: 0, dueToday: 0, eventsToday: 1, handoversToday: 0 },
      health: { cronLastOkAt: null, cronStale: true, emailConfigured: false, outboxFailed: 0, outboxSkipped24h: 0, cspViolations24h: 0 },
      alerts: [{ code: 'CRON_STALE', at: null, detail: null }],
      sections: [section('decide_now'), section('events_today_tomorrow')],
      serverTime: iso(NOW),
    }

    assert.equal(isAdminQueueResponse(base), true)
    assert.equal(isAdminQueueItem(item), true)
    assert.equal(isAdminQueueResponse({ ...base, sections: [section('events_today_tomorrow'), section('decide_now')] }), false)
    assert.equal(isAdminQueueResponse({ ...base, sections: [section('decide_now', [])] }), false)
    assert.equal(isAdminQueueSection({ ...section('decide_now'), order: 2 }), false)
    assert.equal(isAdminQueueSection({ ...section('decide_now'), total: 0 }), false)
    assert.equal(isAdminQueueSection(section('decide_now', Array.from({ length: 51 }, () => item))), false)
    assert.equal(isAdminQueueItem({ ...item, waDigits: '+966512345678' }), false)
    assert.equal(isAdminQueueItem({ ...item, status: 'hacked' }), false)
    assert.equal(isAdminQueueItem({ ...item, stage: 'hacked' }), false)
    assert.equal(isAdminQueueItem({ ...item, suggestedTemplate: 'free_text' }), false)
    assert.equal(isAdminQueueItem({ ...item, lastContact: { template: 'event_reminder', outcome: 'read', at: iso(NOW) } }), false)
    assert.equal(isAdminQueueItem({ ...item, startTime: '24:00' }), false)
    assert.equal(isAdminQueueResponse({ ...base, alerts: [{ code: 'FREE_TEXT', at: null, detail: null }] }), false)
    assert.equal(isAdminQueueResponse({ ...base, serverTime: '2031-03-10 09:00:00' }), false)
  })
})

// ---------------------------------------------------------------------------
// Handler: AD context, filter-free, rate limited
// ---------------------------------------------------------------------------

describe('GET /api/admin/queue handler', () => {
  const { path } = createDatabase()
  const db = createReadOnlyD1(path)

  test('an empty database answers the #35 shape with no sections', async () => {
    const { status, headers, body, rateLimit } = await call(db, '/api/admin/queue')

    assert.equal(status, 200)
    assert.equal(headers.get('Cache-Control'), 'no-store')
    assert.equal(isAdminQueueResponse(body), true, JSON.stringify(body))
    assert.deepEqual(body.sections, [])
    assert.deepEqual(body.summary, { decideNow: 0, dueToday: 0, eventsToday: 0, handoversToday: 0 })
    assert.equal(body.health.cronStale, true)
    assert.equal(body.health.emailConfigured, false)
    assert.deepEqual(body.alerts.map((alert) => alert.code), ['ONLINE_CONFIRMATION_NOT_OFFERED', 'CRON_STALE'])
    assert.deepEqual(rateLimit.keys, [ADMIN])
    assert.equal(db.calls.batch >= 1, true)
  })

  test('any query string is refused before a read', async () => {
    const before = db.calls.prepare
    const { status, body } = await call(db, '/api/admin/queue?section=decide_now')

    assert.equal(status, 400)
    assert.equal(body.error.code, 'INVALID_QUERY')
    assert.equal(db.calls.prepare, before)
  })

  test('RL_ADMIN_READ answers 429 before a read', async () => {
    const before = db.calls.prepare
    const { status, headers } = await call(db, '/api/admin/queue', { limited: true })

    assert.equal(status, 429)
    assert.ok(headers.get('Retry-After'))
    assert.equal(db.calls.prepare, before)
  })

  test('every statement prepares against the migrated schema', () => {
    const reader = new DatabaseSync(path, { readOnly: true })
    openConnections.push(reader)

    for (const [name, sql] of [...Object.entries(ADMIN_QUEUE_SQL.sections), ...Object.entries(ADMIN_QUEUE_SQL).filter(([key]) => key !== 'sections')]) {
      assert.doesNotThrow(() => reader.prepare(sql), name)
    }
  })
})

// ---------------------------------------------------------------------------
// Every section, in the fixed order, from one database
// ---------------------------------------------------------------------------

describe('sections (#35, B1, UX-02, UX-05, SB-13)', () => {
  const { path, writer } = createDatabase()
  addUser(writer, { id: 'CustomerA', firstName: 'نورة', phone: '+966 51 234 5678' })
  addUser(writer, { id: 'CustomerErased', firstName: 'محذوفة', erasedAt: iso(NOW - DAY) })
  addUser(writer, { id: 'CustomerBadPhone', firstName: 'ريم', phone: '12' })
  const deadlinePast = iso(NOW - HOUR)

  // decide_now: notice-protected and overdue (always); unprotected and overdue (AX off only).
  const protectedHold = addBooking(writer, {
    userId: 'CustomerA', eventDate: '2031-06-01', status: 'approved_hold', flowVersion: 2,
    holdExpiresAt: deadlinePast, termsAcceptedAt: iso(NOW - 20 * HOUR),
  })
  addNotice(writer, protectedHold, deadlinePast)
  const unprotectedOverdue = addBooking(writer, {
    userId: 'CustomerA', eventDate: '2031-06-02', status: 'approved_hold', flowVersion: 2,
    holdExpiresAt: iso(NOW - 2 * HOUR),
  })
  // holds_expiring: terms accepted, no notice (unprotected), deadline in 10 h.
  const expiring = addBooking(writer, {
    userId: 'CustomerErased', eventDate: '2031-06-03', status: 'approved_hold', flowVersion: 2,
    holdExpiresAt: iso(NOW + 10 * HOUR), termsAcceptedAt: iso(NOW - 20 * HOUR),
  })
  // deposit_notices: protected, deadline in 30 h.
  const noticed = addBooking(writer, {
    userId: 'CustomerA', eventDate: '2031-06-04', status: 'approved_hold', flowVersion: 2,
    holdExpiresAt: iso(NOW + 30 * HOUR), termsAcceptedAt: iso(NOW - 10 * HOUR),
  })
  addNotice(writer, noticed, iso(NOW + 30 * HOUR))
  // requests_over_sla: 30 h old; a 2 h old one is not listed.
  const stale = addBooking(writer, { userId: 'CustomerBadPhone', eventDate: '2031-06-05', createdAt: iso(NOW - 30 * HOUR) })
  addBooking(writer, { userId: 'CustomerA', eventDate: '2031-06-06', createdAt: iso(NOW - 2 * HOUR) })
  // events_today_tomorrow: today with details, tomorrow without.
  const eventToday = addBooking(writer, { userId: 'CustomerA', eventDate: TODAY, status: 'confirmed', flowVersion: 2, termsAcceptedAt: iso(NOW - 30 * DAY), depositReceived: 1000 })
  addEventProfile(writer, eventToday, { startTime: '20:00', venueArea: 'الرياض' })
  const eventTomorrow = addBooking(writer, { userId: 'CustomerA', eventDate: TOMORROW, status: 'confirmed', flowVersion: 2 })
  // handovers_today_tomorrow: a slot tomorrow 14:00 Riyadh.
  const handoverTomorrow = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-01-10', status: 'confirmed', flowVersion: 2 })
  addProduction(writer, handoverTomorrow, 'ready')
  addHandover(writer, handoverTomorrow, { startsAt: '2031-03-11T11:00:00.000Z' })
  // terms_pending: approved 13 h ago, terms unaccepted, 40 h left.
  const termsPending = addBooking(writer, {
    userId: 'CustomerA', eventDate: '2031-06-07', status: 'approved_hold', flowVersion: 2,
    holdExpiresAt: iso(NOW + 40 * HOUR), history: [['pending_review', 'approved_hold', iso(NOW - 13 * HOUR)]],
  })
  // Approved 2 h ago: not yet pending.
  addBooking(writer, {
    userId: 'CustomerA', eventDate: '2031-06-08', status: 'approved_hold', flowVersion: 2,
    holdExpiresAt: iso(NOW + 46 * HOUR), history: [['pending_review', 'approved_hold', iso(NOW - 2 * HOUR)]],
  })
  // bank_mismatch: accepted under revision 1, revision 2 effective since (TM-03).
  const firstBank = addBankRevision(writer, { createdAt: iso(NOW - 10 * DAY) })
  addBankRevision(writer, { createdAt: iso(NOW - 5 * DAY), iban: 'SA4420000001234567891234' })
  const bankMismatch = addBooking(writer, {
    userId: 'CustomerA', eventDate: '2031-06-09', status: 'approved_hold', flowVersion: 2,
    holdExpiresAt: iso(NOW + 40 * HOUR), termsAcceptedAt: iso(NOW - 6 * DAY), bankRevisionId: firstBank,
  })
  // receipts_pending (PM): one pending receipt, 2 h old.
  const receiptPending = addBooking(writer, {
    userId: 'CustomerA', eventDate: '2031-06-10', status: 'payment_pending', flowVersion: 2,
    holdExpiresAt: iso(NOW + 20 * HOUR), termsAcceptedAt: iso(NOW - DAY),
  })
  addReceipt(writer, receiptPending, 'pending', iso(NOW - 2 * HOUR))
  // events_soon_without_details: in 3 days, no profile; in 9 days: too far.
  const soon = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-03-13', status: 'confirmed', flowVersion: 2 })
  addBooking(writer, { userId: 'CustomerA', eventDate: '2031-03-19', status: 'confirmed', flowVersion: 2 })
  // awaiting_production: event 5 days ago, nothing started.
  const awaiting = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-03-05', status: 'confirmed', flowVersion: 2 })
  // selection_overdue (PM): gallery open, deadline yesterday.
  const overdue = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-02-18', status: 'confirmed', flowVersion: 2 })
  addGallery(writer, overdue, { status: 'open', openedAt: iso(NOW - 15 * DAY), selectionDeadline: iso(NOW - DAY) })
  // ready_without_handover: album ready, no handover.
  const ready = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-02-08', status: 'confirmed', flowVersion: 2 })
  addProduction(writer, ready, 'ready')
  // handover_no_show: missed two days ago.
  const noShow = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-01-29', status: 'confirmed', flowVersion: 2 })
  addProduction(writer, noShow, 'ready')
  addHandover(writer, noShow, { startsAt: iso(NOW - 2 * DAY), status: 'no_show' })
  // feedback_due: completed 3 days ago; completed yesterday is not due yet.
  const feedbackDue = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-01-19', status: 'confirmed', flowVersion: 2, completedAt: iso(NOW - 3 * DAY) })
  addBooking(writer, { userId: 'CustomerA', eventDate: '2031-01-20', status: 'confirmed', flowVersion: 2, completedAt: iso(NOW - DAY) })
  const db = createReadOnlyD1(path)

  test('every section in the fixed order (private media open), each with its booking', async () => {
    const response = await loadAdminQueue(envFor(db, PRIVATE_MEDIA_VARS), new Date(NOW))

    assert.equal(isAdminQueueResponse(response), true, JSON.stringify(response))
    assert.deepEqual(sectionIds(response), [...ADMIN_QUEUE_SECTION_IDS])
    assert.deepEqual(
      response.sections.map((section) => [section.id, section.order]),
      ADMIN_QUEUE_SECTION_IDS.map((id, index) => [id, index + 1]),
    )

    const expected = {
      decide_now: [protectedHold],
      holds_expiring: [expiring],
      deposit_notices: [noticed],
      requests_over_sla: [stale],
      events_today_tomorrow: [eventToday, eventTomorrow],
      handovers_today_tomorrow: [handoverTomorrow],
      terms_pending: [termsPending],
      bank_mismatch: [bankMismatch],
      receipts_pending: [receiptPending],
      // Tomorrow's event has no details either: one booking, two sections, two messages.
      events_soon_without_details: [eventTomorrow, soon],
      awaiting_production: [awaiting],
      selection_overdue: [overdue],
      ready_without_handover: [ready],
      handover_no_show: [noShow],
      feedback_due: [feedbackDue],
    }

    for (const section of response.sections) {
      assert.deepEqual(section.items.map((item) => item.bookingId), expected[section.id], section.id)
      assert.equal(section.total, expected[section.id].length, section.id)
      assert.ok(section.items.every((item) => item.suggestedTemplate === adminQueueSectionTemplates[section.id]), section.id)
    }

    // Due today (Riyadh): the overdue hold, the hold expiring at 22:00, the stale request, tonight's event.
    assert.deepEqual(response.summary, { decideNow: 1, dueToday: 4, eventsToday: 1, handoversToday: 0 })
    assert.equal(response.serverTime, iso(NOW))
  })

  test('decide_now also lists an unprotected overdue hold only while automatic expiry is off (B1 #4)', async () => {
    const withoutEmail = await loadAdminQueue(envFor(db), new Date(NOW))
    // Oldest deadline first.
    assert.deepEqual(sectionOf(withoutEmail, 'decide_now').items.map((item) => item.bookingId), [unprotectedOverdue, protectedHold])
    assert.equal(withoutEmail.summary.decideNow, 2)

    const withExpiry = await loadAdminQueue(envFor(db, AX_VARS), new Date(NOW))
    assert.deepEqual(sectionOf(withExpiry, 'decide_now').items.map((item) => item.bookingId), [protectedHold])
  })

  test('private-media sections are left out while the gate is closed, the others unchanged', async () => {
    const closed = await loadAdminQueue(envFor(db, AX_VARS), new Date(NOW))

    assert.deepEqual(
      sectionIds(closed),
      ADMIN_QUEUE_SECTION_IDS.filter((id) => !adminQueuePrivateMediaSections.includes(id)),
    )
    assert.equal(db.calls.prepare > 0, true)
  })

  test('items carry first names, reference, waDigits from the stored phone, inputs and dues (UX-03, SB-13)', async () => {
    const response = await loadAdminQueue(envFor(db, PRIVATE_MEDIA_VARS), new Date(NOW))
    const hold = itemOf(response, 'decide_now', protectedHold)

    assert.equal(hold.reference, protectedHold)
    assert.equal(hold.customerFirstName, 'نورة')
    assert.equal(hold.waDigits, '966512345678')
    assert.equal(hold.status, 'approved_hold')
    assert.equal(hold.stage, 'approved_hold')
    assert.equal(hold.dueAt, deadlinePast)
    assert.deepEqual(hold.templateInputs, { amount: 1000, holdExpiresAt: deadlinePast, slotStartsAt: null, method: null, productionStage: null })
    assert.equal(hold.startTime, null)
    assert.equal(hold.venueArea, null)
    assert.equal(hold.lastContact, null)
    assert.deepEqual(hold.repeatHolds, { expired: 0, abandoned: 0, flagged: false })

    const serialised = JSON.stringify(response)
    assert.equal(serialised.includes('تجريبية'), false, 'no last name')
    assert.equal(serialised.includes('example.test'), false, 'no email')
    assert.equal(serialised.includes('+966'), false, 'no stored phone text')
    assert.equal(serialised.includes('قاعة تجريبية'), false, 'no venue name')

    // Erased customer: no name, no number. A phone that does not normalise: no number.
    const erased = itemOf(response, 'holds_expiring', expiring)
    assert.equal(erased.customerFirstName, null)
    assert.equal(erased.waDigits, null)
    assert.equal(itemOf(response, 'requests_over_sla', stale).waDigits, null)
    assert.equal(itemOf(response, 'requests_over_sla', stale).customerFirstName, 'ريم')
    assert.equal(itemOf(response, 'requests_over_sla', stale).dueAt, iso(NOW - 6 * HOUR))

    // Event details only in events_today_tomorrow.
    const today = itemOf(response, 'events_today_tomorrow', eventToday)
    assert.equal(today.startTime, '20:00')
    assert.equal(today.venueArea, 'الرياض')
    assert.equal(today.dueAt, '2031-03-10T17:00:00.000Z')
    assert.equal(today.templateInputs.amount, 1000)
    const tomorrow = itemOf(response, 'events_today_tomorrow', eventTomorrow)
    assert.equal(tomorrow.startTime, null)
    assert.equal(tomorrow.dueAt, '2031-03-10T21:00:00.000Z')
    assert.equal(itemOf(response, 'events_soon_without_details', soon).startTime, null)
    assert.equal(itemOf(response, 'events_soon_without_details', soon).venueArea, null)

    const handover = itemOf(response, 'handovers_today_tomorrow', handoverTomorrow)
    assert.equal(handover.dueAt, '2031-03-11T11:00:00.000Z')
    assert.deepEqual(handover.templateInputs, { amount: 1000, holdExpiresAt: null, slotStartsAt: '2031-03-11T11:00:00.000Z', method: 'pickup', productionStage: null })
    assert.equal(itemOf(response, 'receipts_pending', receiptPending).dueAt, iso(NOW + 22 * HOUR))
    assert.equal(itemOf(response, 'selection_overdue', overdue).dueAt, iso(NOW - DAY))
    assert.equal(itemOf(response, 'feedback_due', feedbackDue).dueAt, iso(NOW - DAY))
    assert.equal(itemOf(response, 'awaiting_production', awaiting).dueAt, null)
    assert.equal(itemOf(response, 'ready_without_handover', ready).dueAt, null)

    for (const section of response.sections) {
      for (const item of section.items) {
        assert.ok(item.waDigits === null || isAdminQueueWaDigits(item.waDigits))
        assert.equal(item.bookingId, item.reference)
        assert.ok(UUID_PATTERN.test(item.bookingId))
      }
    }
  })

  test('bank_mismatch empties once the accepted revision is the effective one again', async () => {
    const earlier = await loadAdminQueue(envFor(db, AX_VARS), new Date(NOW - 7 * DAY))

    assert.equal(sectionOf(earlier, 'bank_mismatch'), null)
  })
})

// ---------------------------------------------------------------------------
// UX-06: an item leaves only on a state change or a sent/dismissed row
// ---------------------------------------------------------------------------

describe('UX-06 contact log', () => {
  const { path, writer } = createDatabase()
  addUser(writer, { id: 'CustomerA' })
  const booking = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-06-05', createdAt: iso(NOW - 30 * HOUR) })
  const db = createReadOnlyD1(path)
  const load = () => loadAdminQueue(envFor(db), new Date(NOW))

  test('an opened row keeps the item and is reported as lastContact', async () => {
    addContactLog(writer, booking, 'opened', 'request_received', iso(NOW - 5 * HOUR))
    const response = await load()
    const item = itemOf(response, 'requests_over_sla', booking)

    assert.ok(item)
    assert.deepEqual(item.lastContact, { template: 'request_received', outcome: 'opened', at: iso(NOW - 5 * HOUR) })
  })

  test('a sent row for another template changes nothing', async () => {
    addContactLog(writer, booking, 'sent', 'hold_reminder', iso(NOW - 4 * HOUR))
    const response = await load()

    assert.ok(itemOf(response, 'requests_over_sla', booking))
    assert.equal(itemOf(response, 'requests_over_sla', booking).lastContact.outcome, 'opened')
  })

  test('a sent row for the section template takes the item off', async () => {
    addContactLog(writer, booking, 'sent', 'request_received', iso(NOW - 3 * HOUR))
    const response = await load()

    assert.equal(sectionOf(response, 'requests_over_sla'), null)
  })

  test('a later state change brings it back, with the sent row as lastContact', async () => {
    addHistory(writer, booking, 'pending_review', 'pending_review', iso(NOW - 2 * HOUR))
    const response = await load()
    const item = itemOf(response, 'requests_over_sla', booking)

    assert.ok(item)
    assert.deepEqual(item.lastContact, { template: 'request_received', outcome: 'sent', at: iso(NOW - 3 * HOUR) })
  })

  test('a dismissed row takes it off again; a non-contact event afterwards brings it back', async () => {
    addContactLog(writer, booking, 'dismissed', 'request_received', iso(NOW - HOUR))
    assert.equal(sectionOf(await load(), 'requests_over_sla'), null)

    addEvent(writer, booking, 'deposit_notice_sent', { holdExpiresAt: 'x' }, iso(NOW - 30 * MINUTE))
    const item = itemOf(await load(), 'requests_over_sla', booking)
    assert.ok(item)
    assert.equal(item.lastContact.outcome, 'dismissed')
  })
})

// ---------------------------------------------------------------------------
// Cap, GAP-04 repeat holds, invalid rows
// ---------------------------------------------------------------------------

describe('cap and GAP-04', () => {
  const { path, writer } = createDatabase()
  addUser(writer, { id: 'CustomerMany' })
  addUser(writer, { id: 'CustomerRepeat', firstName: 'هند' })
  addUser(writer, { id: 'CustomerOnce', firstName: 'لمى' })

  // One open request per (customer, date): the 0004 index.
  for (let index = 0; index < ADMIN_QUEUE_SECTION_MAX_ITEMS + 1; index += 1) {
    addBooking(writer, {
      userId: 'CustomerMany',
      eventDate: `2032-0${1 + Math.floor(index / 28)}-${String((index % 28) + 1).padStart(2, '0')}`,
      createdAt: iso(NOW - 30 * HOUR - index * MINUTE),
    })
  }

  // CustomerRepeat: one expired hold, one abandoned hold (cancelled while owing), one old expiry (outside 90 d).
  addBooking(writer, { userId: 'CustomerRepeat', eventDate: '2031-04-01', status: 'expired', flowVersion: 2, history: [['approved_hold', 'expired', iso(NOW - 10 * DAY)]] })
  addBooking(writer, { userId: 'CustomerRepeat', eventDate: '2031-04-02', status: 'cancelled', flowVersion: 2, history: [['payment_pending', 'cancelled', iso(NOW - 20 * DAY)]] })
  addBooking(writer, { userId: 'CustomerRepeat', eventDate: '2031-04-03', status: 'expired', flowVersion: 2, history: [['approved_hold', 'expired', iso(NOW - 100 * DAY)]] })
  // A cancellation after confirmation is not an abandoned hold.
  addBooking(writer, { userId: 'CustomerRepeat', eventDate: '2031-04-04', status: 'cancelled', flowVersion: 2, history: [['confirmed', 'cancelled', iso(NOW - 5 * DAY)]] })
  const repeatRequest = addBooking(writer, { userId: 'CustomerRepeat', eventDate: '2031-05-01', createdAt: iso(NOW - 40 * HOUR) })
  // CustomerOnce: a single expiry.
  addBooking(writer, { userId: 'CustomerOnce', eventDate: '2031-04-05', status: 'expired', flowVersion: 2, history: [['approved_hold', 'expired', iso(NOW - 10 * DAY)]] })
  const onceRequest = addBooking(writer, { userId: 'CustomerOnce', eventDate: '2031-05-02', createdAt: iso(NOW - 40 * HOUR) })
  const db = createReadOnlyD1(path)

  test('at most 50 items per section; total counts every match', async () => {
    const response = await loadAdminQueue(envFor(db), new Date(NOW))
    const section = sectionOf(response, 'requests_over_sla')

    assert.equal(section.items.length, ADMIN_QUEUE_SECTION_MAX_ITEMS)
    assert.equal(section.total, ADMIN_QUEUE_SECTION_MAX_ITEMS + 3)
    assert.equal(isAdminQueueResponse(response), true)
    // Oldest first: the two older requests of the other customers lead.
    assert.deepEqual(section.items.slice(0, 2).map((item) => item.bookingId), [repeatRequest, onceRequest])
  })

  test('repeat holds within 90 days are counted and flagged from two (GAP-04)', async () => {
    const response = await loadAdminQueue(envFor(db), new Date(NOW))

    assert.equal(ADMIN_QUEUE_REPEAT_HOLD_FLAG_COUNT, 2)
    assert.deepEqual(itemOf(response, 'requests_over_sla', repeatRequest).repeatHolds, { expired: 1, abandoned: 1, flagged: true })
    assert.deepEqual(itemOf(response, 'requests_over_sla', onceRequest).repeatHolds, { expired: 1, abandoned: 0, flagged: false })
  })

  test('a row the guard refuses is counted in total and logged by section and count only', async () => {
    const { path: brokenPath, writer: brokenWriter } = createDatabase()
    addUser(brokenWriter, { id: 'CustomerA' })
    addBooking(brokenWriter, { userId: 'CustomerA', eventDate: '2031-06-05', createdAt: iso(NOW - 30 * HOUR) })
    const broken = addBooking(brokenWriter, { userId: 'CustomerA', eventDate: '2031-06-06', createdAt: iso(NOW - 31 * HOUR) })
    // The 0005 CHECK only shapes a flow-2 hold's deadline; a legacy row may hold anything.
    brokenWriter.prepare("UPDATE booking_requests SET hold_expires_at = 'not-an-instant' WHERE id = ?").run(broken)
    const brokenDb = createReadOnlyD1(brokenPath)
    const logged = []
    const original = console.error
    console.error = (message) => logged.push(String(message))

    try {
      const response = await loadAdminQueue(envFor(brokenDb), new Date(NOW))
      const section = sectionOf(response, 'requests_over_sla')

      assert.equal(section.items.length, 1)
      assert.equal(section.total, 2)
      assert.deepEqual(logged, ['ADMIN_QUEUE_ROW_INVALID section=requests_over_sla count=1'])
    } finally {
      console.error = original
    }
  })
})

// ---------------------------------------------------------------------------
// Alerts and health (TM-03, H3, C-10)
// ---------------------------------------------------------------------------

describe('alerts and health', () => {
  test('a recent bank change, a pending change, the kill switch, a stale cron and CSP counts', async () => {
    const { path, writer } = createDatabase()
    addBankRevision(writer, { createdAt: iso(NOW - 10 * DAY) })
    addBankRevision(writer, { createdAt: iso(NOW - 2 * HOUR), effectiveAt: iso(NOW + 22 * HOUR), iban: 'SA4420000001234567891234' })
    addKillSwitch(writer, 'off', iso(NOW - HOUR))
    writer.prepare("INSERT INTO csp_report_counts (day, directive, blocked_origin, count) VALUES (?, 'img-src', 'https://evil.example', 3)").run(TODAY)
    writer.prepare("INSERT INTO csp_report_counts (day, directive, blocked_origin, count) VALUES (?, 'script-src', 'inline', 2)").run('2031-03-09')
    writer.prepare("INSERT INTO csp_report_counts (day, directive, blocked_origin, count) VALUES (?, 'script-src', 'inline', 50)").run('2031-03-08')
    writer.prepare("INSERT INTO job_runs (job, last_ok_at, last_status) VALUES ('scheduler-quarter-hourly', ?, 'ok')").run(iso(NOW - 50 * MINUTE))
    const db = createReadOnlyD1(path)

    const response = await loadAdminQueue(envFor(db, AX_VARS), new Date(NOW))

    assert.equal(isAdminQueueResponse(response), true)
    assert.deepEqual(response.alerts, [
      { code: 'BANK_DETAILS_CHANGED_RECENTLY', at: iso(NOW - 2 * HOUR), detail: null },
      { code: 'SETTINGS_CHANGE_PENDING', at: iso(NOW + 22 * HOUR), detail: 'bank' },
      { code: 'ONLINE_CONFIRMATION_NOT_OFFERED', at: null, detail: 'KILL_SWITCH' },
      { code: 'KILL_SWITCH_OFF', at: iso(NOW - HOUR), detail: null },
      { code: 'CRON_STALE', at: iso(NOW - 50 * MINUTE), detail: null },
      { code: 'CSP_VIOLATIONS', at: null, detail: null },
    ])
    assert.equal(response.health.cronLastOkAt, iso(NOW - 50 * MINUTE))
    assert.equal(response.health.cronStale, true)
    assert.equal(response.health.emailConfigured, true)
    assert.equal(response.health.cspViolations24h, 5)
  })

  test('a fresh heartbeat, outbox counts within their windows, and no alert without a reason', async () => {
    const { path, writer } = createDatabase()
    addUser(writer, { id: 'CustomerA' })
    const booking = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-06-05' })
    writer.prepare("INSERT INTO job_runs (job, last_ok_at, last_status) VALUES ('scheduler-quarter-hourly', ?, 'ok')").run(iso(NOW - 10 * MINUTE))
    const outbox = writer.prepare(
      `INSERT INTO notification_log (dedupe_key, booking_id, kind, status, attempts, created_at, updated_at, finished_at)
       VALUES (?, ?, 'hold_reminder_24h', ?, 1, ?, ?, ?)`,
    )
    outbox.run('hold_reminder_24h:a', booking, 'failed', iso(NOW - 2 * DAY), iso(NOW - 2 * DAY), iso(NOW - 2 * DAY))
    outbox.run('hold_reminder_24h:b', booking, 'failed', iso(NOW - 8 * DAY), iso(NOW - 8 * DAY), iso(NOW - 8 * DAY))
    outbox.run('hold_reminder_24h:c', booking, 'skipped', iso(NOW - 2 * HOUR), iso(NOW - 2 * HOUR), iso(NOW - 2 * HOUR))
    outbox.run('hold_reminder_24h:d', booking, 'skipped', iso(NOW - 30 * HOUR), iso(NOW - 30 * HOUR), iso(NOW - 30 * HOUR))
    const db = createReadOnlyD1(path)

    const response = await loadAdminQueue(envFor(db, AX_VARS), new Date(NOW))

    assert.equal(response.health.cronStale, false)
    assert.equal(response.health.outboxFailed, 1)
    assert.equal(response.health.outboxSkipped24h, 1)
    assert.equal(response.health.cspViolations24h, 0)
    // Only the settings-incomplete reason remains (no deposit rule, bank or terms yet).
    assert.deepEqual(response.alerts, [{ code: 'ONLINE_CONFIRMATION_NOT_OFFERED', at: null, detail: 'SETTINGS_INCOMPLETE' }])
  })
})

// ---------------------------------------------------------------------------
// The local seed reaches every section (plan 11 §6.3 W2-10)
// ---------------------------------------------------------------------------

describe('scripts/dev-seed.sql', () => {
  test('populates every section the seed can reach, in the fixed order', async () => {
    const { path, writer } = createDatabase()
    const parts = SEED_SQL.split(SEED_PLACEHOLDER)
    assert.equal(parts.length, 2)
    writer.exec('BEGIN')
    writer.exec(parts.join('TesterUid0001'))
    writer.exec('COMMIT')
    const db = createReadOnlyD1(path)

    // The seed is relative to the real clock (date('now')).
    const response = await loadAdminQueue(envFor(db, PRIVATE_MEDIA_VARS), new Date())

    assert.equal(isAdminQueueResponse(response), true, JSON.stringify(response))
    // bank_mismatch needs settings, which the seed never writes (§6.2).
    assert.deepEqual(sectionIds(response), ADMIN_QUEUE_SECTION_IDS.filter((id) => id !== 'bank_mismatch'))
    assert.ok(response.summary.eventsToday >= 1)
    assert.ok(response.summary.decideNow >= 1)
    assert.ok(response.sections.every((section) => section.items.length <= ADMIN_QUEUE_SECTION_MAX_ITEMS))
    assert.ok(itemOf(response, 'events_today_tomorrow', '5eedb00c-0000-4000-8000-000000000035').startTime)
    assert.ok(response.sections.flatMap((section) => section.items).some((item) => item.waDigits !== null))
  })
})
