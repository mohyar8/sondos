// W2-12 / TM-13, SB-6, SB-10, SB-14 (N-09, N-10, N-26, N-42): the CSV writer
// (worker/csv.ts) and GET /api/admin/exports/bookings.csv
// (worker/portal/admin-export.ts, plan 11 §3.2 #38).
//
// The attack table runs every payload of N-09/N-42 through the writer: a
// cell that could start a formula, a DDE call or a link gets a leading `'`,
// control, bidi, separator and zero-width characters are stripped, and every
// text cell is quoted with `"` doubled. Invisible characters are built with
// String.fromCodePoint so this file itself carries none.
//
// The handler runs against a database built from the repository's own
// migrations (node:sqlite, foreign keys on) through a small stand-in for the
// D1 API, like tests/admin-audit.test.mjs: the audit row, the re-auth window,
// the range and row caps, the headers and the columns.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import { adminStatusPresentation } from '../src/features/admin-portal/booking-status.ts'
import {
  CSV_BOM,
  CSV_LINE_END,
  buildCsvDocument,
  csvInteger,
  csvText,
  formatCsvCell,
  neutralizeCsvText,
} from '../worker/csv.ts'
import { jsonResponse } from '../worker/http.ts'
import {
  EXPORT_COLUMNS,
  MAXIMUM_EXPORT_ROWS,
  exportFileName,
  exportStatusLabels,
  formatRiyadhInstant,
  handleBookingsExport,
} from '../worker/portal/admin-export.ts'
import { adminExportRoutes } from '../worker/portal/slots/admin-export.ts'

const cp = (...codes) => String.fromCodePoint(...codes)

const TAB = cp(0x09)
const CR = cp(0x0d)
const LF = cp(0x0a)
const NUL = cp(0x00)
const DEL = cp(0x7f)
const C1_CSI = cp(0x9b)
const RLO = cp(0x202e)
const LRE = cp(0x202a)
const RLI = cp(0x2067)
const PDI = cp(0x2069)
const ALM = cp(0x061c)
const LRM = cp(0x200e)
const LINE_SEPARATOR = cp(0x2028)
const PARAGRAPH_SEPARATOR = cp(0x2029)
const ZWSP = cp(0x200b)
const ZWNJ = cp(0x200c)
const ZWJ = cp(0x200d)
const WORD_JOINER = cp(0x2060)
const ZWNBSP = cp(0xfeff)
const SOFT_HYPHEN = cp(0x00ad)
const NBSP = cp(0x00a0)
const IDEOGRAPHIC_SPACE = cp(0x3000)
const LONE_SURROGATE = String.fromCharCode(0xd800)

const FULLWIDTH_EQUALS = cp(0xff1d)
const FULLWIDTH_PLUS = cp(0xff0b)
const FULLWIDTH_MINUS = cp(0xff0d)
const FULLWIDTH_AT = cp(0xff20)
const FULLWIDTH_BAR = cp(0xff5c)
const SMALL_EQUALS = cp(0xfe66)
const SMALL_PLUS = cp(0xfe62)
const SMALL_MINUS = cp(0xfe63)
const SMALL_AT = cp(0xfe6b)

/** Every character neutralizeCsvText must remove, with a name for the report. */
const STRIPPED = {
  NUL,
  TAB,
  LF,
  CR,
  DEL,
  C1_CSI,
  RLO,
  LRE,
  RLI,
  PDI,
  ALM,
  LRM,
  LINE_SEPARATOR,
  PARAGRAPH_SEPARATOR,
  ZWSP,
  ZWNJ,
  ZWJ,
  WORD_JOINER,
  ZWNBSP,
  SOFT_HYPHEN,
  LONE_SURROGATE,
}

describe('neutralizeCsvText: the N-09 / N-42 attack table', () => {
  const cases = [
    ['=HYPERLINK', '=HYPERLINK("http://example.test/x","اضغطي هنا")', `'=HYPERLINK("http://example.test/x","اضغطي هنا")`],
    ['+SUM', '+SUM(1,2)', "'+SUM(1,2)"],
    ['-1+1', '-1+1', "'-1+1"],
    ['@cmd', '@SUM(A1)', "'@SUM(A1)"],
    ['|cmd (LibreOffice DDE)', "|cmd'/C calc'!A0", "'|cmd'/C calc'!A0"],
    ['DDE through =', "=cmd|'/C calc'!A0", "'=cmd|'/C calc'!A0"],
    ['leading TAB', `${TAB}=1+1`, "'=1+1"],
    ['leading TAB, harmless text', `${TAB}نص`, "'نص"],
    ['leading CR', `${CR}=1+1`, "'=1+1"],
    ['leading CR, harmless text', `${CR}نص`, "'نص"],
    ['spaces before =', '   =1+1', "'   =1+1"],
    ['NBSP and ideographic space before =', `${NBSP}${IDEOGRAPHIC_SPACE}=1+1`, `'${NBSP}${IDEOGRAPHIC_SPACE}=1+1`],
    ['full-width ＝', `${FULLWIDTH_EQUALS}1+1`, `'${FULLWIDTH_EQUALS}1+1`],
    ['full-width ＋', `${FULLWIDTH_PLUS}1`, `'${FULLWIDTH_PLUS}1`],
    ['full-width －', `${FULLWIDTH_MINUS}1`, `'${FULLWIDTH_MINUS}1`],
    ['full-width ＠', `${FULLWIDTH_AT}cmd`, `'${FULLWIDTH_AT}cmd`],
    ['full-width ｜', `${FULLWIDTH_BAR}cmd`, `'${FULLWIDTH_BAR}cmd`],
    ['small ﹦ ﹢ ﹣ ﹫', `${SMALL_EQUALS}1`, `'${SMALL_EQUALS}1`],
    ['small ﹢', `${SMALL_PLUS}1`, `'${SMALL_PLUS}1`],
    ['small ﹣', `${SMALL_MINUS}1`, `'${SMALL_MINUS}1`],
    ['small ﹫', `${SMALL_AT}1`, `'${SMALL_AT}1`],
    ['U+202E before =', `${RLO}=1+1`, "'=1+1"],
    ['U+202E inside a name', `سارة${RLO}fdp.exe`, 'سارةfdp.exe'],
    ['U+2028 / U+2029', `سطر${LINE_SEPARATOR}ثانٍ${PARAGRAPH_SEPARATOR}ثالث`, 'سطرثانٍثالث'],
    ['zero-width space before =', `${ZWSP}=1+1`, "'=1+1"],
    ['zero-width joiner and BOM before +', `${ZWJ}${ZWNBSP}+1`, "'+1"],
    ['word joiner before @', `${WORD_JOINER}@cmd`, "'@cmd"],
    ['LF inside', `نورة${LF}=1+1`, 'نورة=1+1'],
    ['C0, DEL and C1', `أ${NUL}ب${DEL}ج${C1_CSI}د`, 'أبجد'],
    ['HTML stays inert text (N-20)', '<img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>'],
    ['javascript: stays text (N-20)', 'javascript:alert(1)', 'javascript:alert(1)'],
    ['plain Arabic untouched', 'نورة العتيبي', 'نورة العتيبي'],
    ['email untouched', 'bride@example.test', 'bride@example.test'],
    ['formula starter later in the text', 'a=1', 'a=1'],
    ['empty', '', ''],
  ]

  for (const [name, input, expected] of cases) {
    test(name, () => {
      assert.equal(neutralizeCsvText(input), expected)
    })
  }

  test('every stripped character is removed wherever it stands', () => {
    for (const [name, character] of Object.entries(STRIPPED)) {
      const output = neutralizeCsvText(`نو${character}رة`)

      assert.equal(output.replace(/^'/, ''), 'نورة', name)
    }
  })

  test('no output ever starts with a formula starter (after spaces)', () => {
    const starters = ['=', '+', '-', '@', '|', FULLWIDTH_EQUALS, FULLWIDTH_PLUS, FULLWIDTH_MINUS, FULLWIDTH_AT]
    const hiders = ['', ' ', TAB, CR, LF, RLO, ZWSP, ZWNBSP, LINE_SEPARATOR, `${ZWSP}${RLO} `]

    for (const hider of hiders) {
      for (const starter of starters) {
        const output = neutralizeCsvText(`${hider}${starter}1`)

        assert.ok(output.startsWith("'"), JSON.stringify(output))
      }
    }
  })
})

describe('formatCsvCell and buildCsvDocument', () => {
  test('text cells are always quoted, with " doubled', () => {
    assert.equal(formatCsvCell(csvText('قال "مرحبا", ثم')), '"قال ""مرحبا"", ثم"')
    assert.equal(formatCsvCell(csvText('=A1&"x"')), `"'=A1&""x"""`)
    assert.equal(formatCsvCell(csvText('')), '""')
    assert.equal(formatCsvCell(csvText(null)), '""')
  })

  test('integer cells are bare digits, never quoted or prefixed', () => {
    assert.equal(formatCsvCell(csvInteger(12500)), '12500')
    assert.equal(formatCsvCell(csvInteger(0)), '0')
    assert.equal(formatCsvCell(csvInteger(null)), '')
  })

  test('an integer cell refuses anything but a safe integer', () => {
    for (const bad of ['1000', '=1+1', 1.5, Number.NaN, Infinity, 2 ** 53]) {
      assert.throws(() => csvInteger(bad), TypeError, String(bad))
      assert.throws(() => formatCsvCell({ kind: 'integer', value: bad }), TypeError, String(bad))
    }
  })

  test('the document has the BOM, CRLF after every line, and one cell per column', () => {
    const document = buildCsvDocument(['أ', 'ب'], [[csvText('x'), csvInteger(1)]])

    assert.equal(document, `${CSV_BOM}"أ","ب"${CSV_LINE_END}"x",1${CSV_LINE_END}`)
    assert.equal(CSV_BOM, cp(0xfeff))
    assert.equal(CSV_LINE_END, `${CR}${LF}`)
    assert.throws(() => buildCsvDocument(['أ', 'ب'], [[csvText('x')]]), RangeError)
    assert.throws(() => buildCsvDocument([], []), RangeError)
  })

  test('the header itself is neutralised', () => {
    assert.ok(buildCsvDocument(['=x'], []).startsWith(`${CSV_BOM}"'=x"`))
  })
})

// ---------------------------------------------------------------------------
// GET /api/admin/exports/bookings.csv
// ---------------------------------------------------------------------------

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const ADMIN = 'AdminUid0001'
const CUSTOMER = 'CustomerUid0001'
const SECOND = 1
const MINUTE = 60 * SECOND

function sqlValue(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value
}

/** A database with every migration and one admin and one customer (test data only). */
function openDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => MIGRATION_FILE.test(file)).sort()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
  }

  const addUser = db.prepare(
    `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  )

  addUser.run(ADMIN, 'admin@example.test', 'مديرة', 'الاستوديو', '+966500000001', 'admin')
  addUser.run(
    CUSTOMER,
    'bride@example.test',
    `${RLO}=HYPERLINK("http://example.test","x")`,
    `${FULLWIDTH_EQUALS}1+1`,
    '+٩٦٦٥٠٠٠٠٠٠٠٢',
    'customer',
  )

  return db
}

/** prepare().bind(), all() and run() over node:sqlite, as D1 answers them. */
function createD1(db) {
  function statement(sql, values) {
    return {
      bind: (...next) => statement(sql, next),
      async all() {
        return { success: true, results: db.prepare(sql).all(...values.map(sqlValue)), meta: {} }
      },
      async run() {
        const info = db.prepare(sql).run(...values.map(sqlValue))

        return { success: true, results: [], meta: { changes: Number(info.changes) } }
      },
    }
  }

  return { prepare: (sql) => statement(sql, []) }
}

const SNAPSHOT = JSON.stringify({ package: { name: 'باقة تجريبية' } })

let bookingCounter = 0

/** One booking (test data only); the admin note must never reach the file. */
function addBooking(db, overrides = {}) {
  bookingCounter += 1
  const id = overrides.id ?? `5eedb00c-0000-4000-8000-${String(bookingCounter).padStart(12, '0')}`

  db.prepare(
    `INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total,
       admin_notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-01 09:05:00', '2026-10-01 09:05:00')`,
  ).run(
    id,
    CUSTOMER,
    overrides.eventDate ?? '2026-11-20',
    overrides.status ?? 'cancelled',
    overrides.snapshot ?? SNAPSHOT,
    BigInt(overrides.total ?? 12500),
    'ملاحظة داخلية سرية',
  )

  return id
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function adminContext(db, query, { authAgeSeconds = MINUTE, limited = false } = {}) {
  const url = new URL(`https://example.test/api/admin/exports/bookings.csv${query}`)

  return {
    request: new Request(url),
    env: {
      DB: createD1(db),
      RL_ADMIN_READ: { limit: async () => ({ success: !limited }) },
    },
    ctx: {},
    url,
    admin: { uid: ADMIN, authTime: nowSeconds() - authAgeSeconds, secondFactor: null },
    params: {},
  }
}

function auditRows(db) {
  return db.prepare("SELECT * FROM admin_audit_log WHERE action = 'bookings_exported' ORDER BY id").all()
}

async function errorCode(response) {
  const body = await response.json()

  return body.error.code
}

/** The body with its BOM kept (Response.text() drops it). */
async function bodyText(response) {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await response.arrayBuffer())
}

/** A strict cell splitter: quoted cells or bare cells, comma separated. */
function splitCells(line) {
  const cells = []
  let rest = line

  for (;;) {
    const match = /^(?:"((?:[^"]|"")*)"|([^,"]*))(,|$)/.exec(rest)

    assert.ok(match, `malformed line: ${line}`)
    cells.push(match[1] !== undefined ? { quoted: true, value: match[1].replaceAll('""', '"') } : { quoted: false, value: match[2] })
    rest = rest.slice(match[0].length)

    if (match[3] === '') {
      return cells
    }
  }
}

function readLines(text) {
  assert.ok(text.startsWith(CSV_BOM))
  assert.ok(text.endsWith(CSV_LINE_END))

  return text.slice(CSV_BOM.length, -CSV_LINE_END.length).split(CSV_LINE_END).map(splitCells)
}

describe('GET /api/admin/exports/bookings.csv (#38)', () => {
  test('the slot registers exactly the GET route, gate open', () => {
    assert.equal(adminExportRoutes.length, 1)
    assert.deepEqual(adminExportRoutes[0].path, ['exports', 'bookings.csv'])
    assert.equal(adminExportRoutes[0].gate, 'open')
    assert.deepEqual(Object.keys(adminExportRoutes[0].handlers), ['GET'])
  })

  test('the file: headers, BOM, columns, neutralised text, integers, digits, no notes; audit row first', async () => {
    const db = openDatabase()
    const id = addBooking(db, { status: 'pending_review' })

    const response = await handleBookingsExport(adminContext(db, '?from=2026-11-01&to=2026-11-30'))

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'text/csv; charset=utf-8')
    assert.equal(
      response.headers.get('Content-Disposition'),
      'attachment; filename="bookings-20261101-20261130.csv"',
    )
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(
      response.headers.get('Strict-Transport-Security'),
      jsonResponse({}).headers.get('Strict-Transport-Security'),
    )

    // The audit row exists before the body is read.
    const audits = auditRows(db)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].actor_uid, ADMIN)
    assert.deepEqual(JSON.parse(audits[0].details), {
      from: '2026-11-01',
      to: '2026-11-30',
      status: null,
      rows: 1,
    })
    assert.ok(audits[0].reauth_at !== null)

    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])

    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    assert.ok(!text.includes('ملاحظة داخلية'), 'internal notes are excluded')

    const [header, row, ...rest] = readLines(text)
    assert.equal(rest.length, 0)
    assert.deepEqual(header.map((cell) => cell.value), [...EXPORT_COLUMNS])
    assert.ok(header.every((cell) => cell.quoted))
    assert.equal(row.length, EXPORT_COLUMNS.length)

    const byColumn = Object.fromEntries(EXPORT_COLUMNS.map((name, index) => [name, row[index]]))
    assert.deepEqual(byColumn['رقم الحجز'], { quoted: true, value: id })
    assert.deepEqual(byColumn['تاريخ الإنشاء (توقيت الرياض)'], { quoted: true, value: '2026-10-01 12:05' })
    assert.deepEqual(byColumn['رمز الحالة'], { quoted: true, value: 'pending_review' })
    assert.deepEqual(byColumn['الحالة'], { quoted: true, value: 'قيد المراجعة' })
    assert.deepEqual(byColumn['المرحلة'], { quoted: true, value: 'قيد المراجعة' })
    assert.deepEqual(byColumn['الباقة'], { quoted: true, value: 'باقة تجريبية' })
    assert.deepEqual(byColumn['الإجمالي'], { quoted: false, value: '12500' })
    assert.deepEqual(byColumn['العربون المطلوب'], { quoted: false, value: '' })
    assert.deepEqual(byColumn['العربون المستلم'], { quoted: false, value: '' })
    assert.deepEqual(byColumn['الاسم الأول'], { quoted: true, value: `'=HYPERLINK("http://example.test","x")` })
    assert.deepEqual(byColumn['اسم العائلة'], { quoted: true, value: `'${FULLWIDTH_EQUALS}1+1` })
    assert.deepEqual(byColumn['الجوال'], { quoted: true, value: '966500000002' })
    assert.deepEqual(byColumn['البريد الإلكتروني'], { quoted: true, value: 'bride@example.test' })
  })

  test('a confirmed flow-2 booking: deposit integers, terms, handover and production columns', async () => {
    const db = openDatabase()
    const id = addBooking(db, { status: 'confirmed', eventDate: '2026-11-10' })
    const stamp = '2026-10-02T10:00:00.000Z'

    db.prepare(
      `UPDATE booking_requests SET flow_version = 2, deposit_amount = 3000, deposit_received_amount = 3000,
         deposit_received_at = ?, terms_version = 'v1', terms_accepted_at = ? WHERE id = ?`,
    ).run(stamp, stamp, id)
    db.prepare(
      `INSERT INTO album_production (booking_id, stage, created_at, updated_at) VALUES (?, 'printing', ?, ?)`,
    ).run(id, stamp, stamp)
    db.prepare(
      `INSERT INTO handover_slots (id, starts_at, ends_at, method, capacity, is_active, created_at, updated_at)
       VALUES ('5eed5107-0000-4000-8000-000000000001', '2026-12-01T13:00:00.000Z', '2026-12-01T14:00:00.000Z',
         'pickup', 1, 1, ?, ?)`,
    ).run(stamp, stamp)
    db.prepare(
      `INSERT INTO handovers (booking_id, slot_id, method, created_at, updated_at)
       VALUES (?, '5eed5107-0000-4000-8000-000000000001', 'pickup', ?, ?)`,
    ).run(id, stamp, stamp)

    const response = await handleBookingsExport(adminContext(db, '?from=2026-11-01&to=2026-11-30'))
    assert.equal(response.status, 200)

    const [, row] = readLines(await bodyText(response))
    const byColumn = Object.fromEntries(EXPORT_COLUMNS.map((name, index) => [name, row[index]]))

    assert.deepEqual(byColumn['العربون المطلوب'], { quoted: false, value: '3000' })
    assert.deepEqual(byColumn['العربون المستلم'], { quoted: false, value: '3000' })
    assert.deepEqual(byColumn['تاريخ استلام العربون'], { quoted: true, value: '2026-10-02 13:00' })
    assert.deepEqual(byColumn['نسخة الشروط'], { quoted: true, value: 'v1' })
    assert.deepEqual(byColumn['تاريخ قبول الشروط'], { quoted: true, value: '2026-10-02 13:00' })
    assert.deepEqual(byColumn['طريقة الاستلام'], { quoted: true, value: 'استلام' })
    assert.deepEqual(byColumn['موعد الاستلام'], { quoted: true, value: '2026-12-01 16:00' })
    assert.deepEqual(byColumn['مرحلة الإنتاج'], { quoted: true, value: 'الألبوم قيد الطباعة' })
    assert.deepEqual(byColumn['الحالة'], { quoted: true, value: 'الحجز مؤكد' })
    assert.ok(byColumn['المرحلة'].value.length > 0)
  })

  test('status filter and an empty result still write the audit row', async () => {
    const db = openDatabase()
    addBooking(db, { status: 'cancelled' })

    const response = await handleBookingsExport(
      adminContext(db, '?from=2026-11-01&to=2026-11-30&status=confirmed'),
    )

    assert.equal(response.status, 200)
    assert.equal(readLines(await bodyText(response)).length, 1)
    assert.equal(JSON.parse(auditRows(db)[0].details).status, 'confirmed')
    assert.equal(JSON.parse(auditRows(db)[0].details).rows, 0)
  })

  test('a stale sign-in answers 403 REAUTH_REQUIRED and writes nothing (N-10)', async () => {
    const db = openDatabase()
    addBooking(db)

    const response = await handleBookingsExport(
      adminContext(db, '?from=2026-11-01&to=2026-11-30', { authAgeSeconds: 10 * MINUTE + 1 }),
    )

    assert.equal(response.status, 403)
    assert.equal(await errorCode(response), 'REAUTH_REQUIRED')
    assert.equal(auditRows(db).length, 0)
  })

  test('a burst over RL_ADMIN_READ answers 429', async () => {
    const db = openDatabase()
    const response = await handleBookingsExport(
      adminContext(db, '?from=2026-11-01&to=2026-11-30', { limited: true }),
    )

    assert.equal(response.status, 429)
    assert.equal(auditRows(db).length, 0)
  })

  test('a span over 400 days answers 400 EXPORT_TOO_LARGE (N-26)', async () => {
    const db = openDatabase()
    const ok = await handleBookingsExport(adminContext(db, '?from=2026-01-01&to=2027-02-05'))
    assert.equal(ok.status, 200)

    const tooLong = await handleBookingsExport(adminContext(db, '?from=2026-01-01&to=2027-02-06'))
    assert.equal(tooLong.status, 400)
    assert.equal(await errorCode(tooLong), 'EXPORT_TOO_LARGE')
    assert.equal(auditRows(db).length, 1)
  })

  test('more than 5,000 bookings answer 400 EXPORT_TOO_LARGE with no audit row (N-26)', async () => {
    const db = openDatabase()
    const insert = db.prepare(
      `INSERT INTO booking_requests (id, user_id, event_date, status, package_snapshot, estimated_total)
       VALUES (?, ?, '2026-11-20', 'cancelled', '{}', 1)`,
    )

    db.exec('BEGIN')
    for (let index = 0; index <= MAXIMUM_EXPORT_ROWS; index += 1) {
      insert.run(`5eedcafe-0000-4000-8000-${String(index).padStart(12, '0')}`, CUSTOMER)
    }
    db.exec('COMMIT')

    const response = await handleBookingsExport(adminContext(db, '?from=2026-11-01&to=2026-11-30'))

    assert.equal(response.status, 400)
    assert.equal(await errorCode(response), 'EXPORT_TOO_LARGE')
    assert.equal(auditRows(db).length, 0)

    db.prepare("DELETE FROM booking_requests WHERE id = '5eedcafe-0000-4000-8000-000000000000'").run()
    const exactlyAtCap = await handleBookingsExport(adminContext(db, '?from=2026-11-01&to=2026-11-30'))
    assert.equal(exactlyAtCap.status, 200)
    assert.equal(readLines(await bodyText(exactlyAtCap)).length, MAXIMUM_EXPORT_ROWS + 1)
    assert.equal(JSON.parse(auditRows(db)[0].details).rows, MAXIMUM_EXPORT_ROWS)
  })

  test('malformed queries answer 400 with nothing written (N-05)', async () => {
    const db = openDatabase()
    const cases = [
      ['', 'INVALID_DATE'],
      ['?from=2026-11-01', 'INVALID_DATE'],
      ['?to=2026-11-01', 'INVALID_DATE'],
      ['?from=2026-02-30&to=2026-03-01', 'INVALID_DATE'],
      ['?from=2026-11-1&to=2026-11-30', 'INVALID_DATE'],
      ['?from=2026-11-30&to=2026-11-01', 'INVALID_DATE_RANGE'],
      ['?from=2026-11-01&to=2026-11-30&status=bogus', 'INVALID_STATUS'],
      ['?from=2026-11-01&to=2026-11-30&status=', 'INVALID_STATUS'],
      ['?from=2026-11-01&to=2026-11-30&limit=10', 'INVALID_QUERY'],
      ['?from=2026-11-01&from=2026-11-02&to=2026-11-30', 'INVALID_QUERY'],
      ['?from=2026-11-01&to=2026-11-30&notes=1', 'INVALID_QUERY'],
    ]

    for (const [query, code] of cases) {
      const response = await handleBookingsExport(adminContext(db, query))

      assert.equal(response.status, 400, query)
      assert.equal(await errorCode(response), code, query)
    }

    assert.equal(auditRows(db).length, 0)
  })

  test('Arabic-Indic digits in the dates are accepted', async () => {
    const db = openDatabase()
    const response = await handleBookingsExport(
      adminContext(db, `?from=${encodeURIComponent('٢٠٢٦-١١-٠١')}&to=2026-11-30`),
    )

    assert.equal(response.status, 200)
    assert.equal(
      response.headers.get('Content-Disposition'),
      'attachment; filename="bookings-20261101-20261130.csv"',
    )
  })

  test('a failed audit write fails the export: no file without its row', async () => {
    const db = openDatabase()
    addBooking(db)
    const context = adminContext(db, '?from=2026-11-01&to=2026-11-30')
    const failing = {
      ...context,
      admin: { ...context.admin, uid: 'NotAUser0001' },
    }

    await assert.rejects(handleBookingsExport(failing))
    assert.equal(auditRows(db).length, 0)
  })
})

describe('export helpers', () => {
  test('status labels equal the admin SPA labels', () => {
    for (const [status, presentation] of Object.entries(adminStatusPresentation)) {
      assert.equal(exportStatusLabels[status], presentation.label, status)
    }

    assert.deepEqual(Object.keys(exportStatusLabels).sort(), Object.keys(adminStatusPresentation).sort())
  })

  test('the file name is ASCII and built from the dates only', () => {
    assert.equal(exportFileName('2026-01-02', '2026-12-31'), 'bookings-20260102-20261231.csv')
    assert.match(exportFileName('2026-01-02', '2026-12-31'), /^[\x21-\x7e]+$/)
  })

  test('instants are Riyadh wall time; legacy SQL timestamps are UTC', () => {
    assert.equal(formatRiyadhInstant('2026-10-01T21:30:00.000Z'), '2026-10-02 00:30')
    assert.equal(formatRiyadhInstant('2026-10-01 21:30:00'), '2026-10-02 00:30')
    assert.equal(formatRiyadhInstant(null), '')
    assert.equal(formatRiyadhInstant('=1+1'), '')
    assert.equal(formatRiyadhInstant('2026-13-45T00:00:00.000Z'), '')
  })
})

