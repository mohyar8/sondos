// W2-11 / SB-2, SB-4: the admin calendar (#36) and customers directory (#37):
// shared/portal/admin-directory.ts, worker/portal/admin-calendar.ts and
// worker/portal/admin-customers.ts, reached through their slot routes.
//
// Every statement runs against a database built from the repository's own
// migrations (node:sqlite, foreign keys on, as in D1) through a small
// stand-in for the D1 API (prepare().bind(), all(), batch()) over a
// READ-ONLY connection, so a handler that tried to write would fail. The
// handlers are called with the context the admin portal dispatcher builds
// after authorizeAdminRequest, which tests/portal-routes.test.mjs covers.
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
  CALENDAR_MAXIMUM_BOOKINGS,
  currentTimestampToIso,
  isCurrentTimestampText,
  parseCalendarMonth,
} from '../shared/portal/admin-directory.ts'
import { handleAdminCalendar } from '../worker/portal/admin-calendar.ts'
import {
  decodeCustomerListCursor,
  encodeCustomerListCursor,
  handleAdminCustomerDetail,
  handleAdminCustomerList,
} from '../worker/portal/admin-customers.ts'
import { adminDirectoryRoutes } from '../worker/portal/slots/admin-directory.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const ADMIN = 'AdminUid0001'
const SNAPSHOT = JSON.stringify({ schemaVersion: 1, package: { id: 'four-hours', name: '4 ساعات' } })
const NOT_FOUND_BODY = { ok: false, error: { code: 'NOT_FOUND', message: 'مسار API الإداري غير موجود.' } }

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const folder = mkdtempSync(join(tmpdir(), 'sy-admin-directory-'))
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
  const path = join(folder, `directory-${databaseCount}.sqlite`)
  copyFileSync(migratedTemplate(), path)
  const writer = new DatabaseSync(path)
  openConnections.push(writer)
  writer.exec('PRAGMA foreign_keys = ON')

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

function addUser(writer, { id, firstName = 'نورة', role = 'customer', createdAt, erasedAt = null, contactChangedAt = null }) {
  writer
    .prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, created_at, erased_at, contact_changed_at)
       VALUES (?, ?, ?, 'تجريبية', '+447700900001', ?, ?, ?, ?)`,
    )
    .run(id, `${id.toLowerCase()}@example.test`, firstName, role, createdAt, erasedAt, contactChangedAt)
}

let bookingCount = 0

function addBooking(writer, { userId, eventDate, status = 'pending_review', createdAt, flowVersion = 1, holdExpiresAt = null, snapshot = SNAPSHOT }) {
  bookingCount += 1
  const id = `b00c0000-0000-4000-8000-${String(bookingCount).padStart(12, '0')}`
  writer
    .prepare(
      `INSERT INTO booking_requests
         (id, user_id, event_date, status, package_snapshot, estimated_total, created_at, updated_at,
          flow_version, hold_expires_at, deposit_amount)
       VALUES (?, ?, ?, ?, ?, 4000, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      eventDate,
      status,
      snapshot,
      createdAt ?? `2026-09-01T00:00:${String(bookingCount % 60).padStart(2, '0')}.000Z`,
      '2026-09-01T00:00:00.000Z',
      BigInt(flowVersion),
      holdExpiresAt,
      flowVersion === 2 ? 1000n : null,
    )

  return id
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

function context(db, path, { params = {}, limited = false } = {}) {
  const rateLimit = limiter(!limited)

  return {
    rateLimit,
    value: {
      request: new Request(`https://example.test${path}`),
      env: { DB: db, RL_ADMIN_READ: rateLimit },
      ctx: { waitUntil() {}, passThroughOnException() {} },
      url: new URL(`https://example.test${path}`),
      admin: { uid: ADMIN, authTime: 0, secondFactor: null },
      params,
    },
  }
}

async function call(handler, db, path, options) {
  const { value, rateLimit } = context(db, path, options)
  const response = await handler(value)

  return { status: response.status, headers: response.headers, body: await response.json(), rateLimit }
}

// ---------------------------------------------------------------------------
// Slot
// ---------------------------------------------------------------------------

describe('slot', () => {
  test('three GET routes, gate open, nothing private-media', () => {
    assert.deepEqual(
      adminDirectoryRoutes.map((route) => [route.path.join('/'), route.gate, Object.keys(route.handlers)]),
      [
        ['calendar', 'open', ['GET']],
        ['customers', 'open', ['GET']],
        ['customers/:customerId', 'open', ['GET']],
      ],
    )
  })
})

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('strict month parsing', () => {
  test('real months give every date, leap years included', () => {
    const february = parseCalendarMonth('2028-02')
    assert.equal(february.firstDate, '2028-02-01')
    assert.equal(february.lastDate, '2028-02-29')
    assert.equal(february.dates.length, 29)
    assert.equal(parseCalendarMonth('2026-02').dates.length, 28)
    assert.equal(parseCalendarMonth('2026-12').lastDate, '2026-12-31')
  })

  test('anything but YYYY-MM with a real month is refused', () => {
    for (const value of [
      '', '2026', '2026-1', '2026-00', '2026-13', '2026-01-01', ' 2026-01', '2026-01 ',
      '٢٠٢٦-٠١', '2026/01', '1999-12', '2101-01', '+2026-01', '2026-1a',
    ]) {
      assert.equal(parseCalendarMonth(value), null, JSON.stringify(value))
    }
  })
})

describe('CURRENT_TIMESTAMP format', () => {
  test('accepts only real `YYYY-MM-DD HH:MM:SS` values', () => {
    assert.equal(isCurrentTimestampText('2026-09-30 23:59:59'), true)
    assert.equal(isCurrentTimestampText('2028-02-29 00:00:00'), true)

    for (const value of [
      '2026-09-30T23:59:59', '2026-09-30T23:59:59.000Z', '2026-09-30 24:00:00', '2026-02-30 10:00:00',
      '2026-09-30 10:60:00', '2026-09-30 10:00:60', '2026-09-30 10:00', '2026-09-30  10:00:00',
      '2026-09-30 10:00:00.000', '0050-01-01 00:00:00',
    ]) {
      assert.equal(isCurrentTimestampText(value), false, value)
    }
  })

  test('is converted to an ISO instant for the wire', () => {
    assert.equal(currentTimestampToIso('2026-09-30 08:05:01'), '2026-09-30T08:05:01.000Z')
    assert.equal(currentTimestampToIso('2026-09-30T08:05:01.000Z'), null)
  })
})

describe('customers cursor', () => {
  const cursor = { createdAt: '2026-09-30 08:05:01', id: 'CustomerUid0001' }

  test('round-trips', () => {
    assert.deepEqual(decodeCustomerListCursor(encodeCustomerListCursor(cursor)), cursor)
  })

  test('refuses anything this Worker did not issue', () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')

    for (const value of [
      encode({ createdAt: '2026-09-30T08:05:01.000Z', id: 'x' }), // ISO: the bookings list format
      encode({ createdAt: '2026-09-30 08:05:01', id: '' }),
      encode({ createdAt: '2026-09-30 08:05:01', id: 'x'.repeat(129) }),
      encode({ createdAt: '2026-09-30 08:05:01', id: 'a\u0000b' }),
      encode({ createdAt: '2026-09-30 08:05:01', id: 5 }),
      encode({ createdAt: '2026-09-30 08:05:01', id: 'x', extra: 1 }),
      encode({ id: 'x', createdAt: '2026-09-30 08:05:01' }), // not the canonical key order
      encode([cursor.createdAt, cursor.id]),
      `${encodeCustomerListCursor(cursor)}=`,
      Buffer.from(JSON.stringify(cursor)).toString('base64'),
      'a',
      'x'.repeat(400),
      '',
    ]) {
      assert.equal(decodeCustomerListCursor(value), null, value)
    }
  })
})

// ---------------------------------------------------------------------------
// #36 calendar
// ---------------------------------------------------------------------------

describe('GET /api/admin/calendar', () => {
  const { path, writer } = createDatabase()
  addUser(writer, { id: 'CustomerA', firstName: 'نورة', createdAt: '2026-01-01 10:00:00' })
  addUser(writer, { id: 'CustomerErased', firstName: 'محذوفة', createdAt: '2026-01-02 10:00:00', erasedAt: '2026-09-01T00:00:00.000Z' })
  const pending = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-11-05' })
  const hold = addBooking(writer, {
    userId: 'CustomerA', eventDate: '2031-11-10', status: 'approved_hold', flowVersion: 2,
    holdExpiresAt: '2031-10-01T09:00:00.000Z',
  })
  addUser(writer, { id: 'CustomerB', firstName: 'ريم', createdAt: '2026-01-03 10:00:00' })
  // pending_review does not block the date, so a second request may share it.
  const second = addBooking(writer, { userId: 'CustomerB', eventDate: '2031-11-10' })
  const legacy = addBooking(writer, { userId: 'CustomerB', eventDate: '2031-11-12', status: 'contract_pending' })
  const cancelled = addBooking(writer, { userId: 'CustomerA', eventDate: '2031-11-20', status: 'cancelled' })
  const ofErased = addBooking(writer, { userId: 'CustomerErased', eventDate: '2031-11-30', status: 'confirmed' })
  addBooking(writer, { userId: 'CustomerA', eventDate: '2031-12-01' })
  addBooking(writer, { userId: 'CustomerA', eventDate: '2031-10-31' })
  addBooking(writer, { userId: 'CustomerA', eventDate: '2031-11-07', snapshot: '{"schemaVersion":2,"package":{"name":"x"}}' })
  writer.prepare("INSERT INTO blocked_dates (event_date, reason) VALUES ('2031-11-15', 'سفر'), ('2031-11-16', NULL), ('2031-12-15', 'x')").run()
  const db = createReadOnlyD1(path)

  test('every day of the month, bookings by date, blocked dates, closed ones left out', async () => {
    const { status, body, headers } = await call(handleAdminCalendar, db, '/api/admin/calendar?month=2031-11')

    assert.equal(status, 200)
    assert.equal(headers.get('Cache-Control'), 'no-store')
    assert.equal(body.ok, true)
    assert.equal(body.month, '2031-11')
    assert.equal(body.includeClosed, false)
    assert.equal(body.truncated, false)
    assert.equal(body.days.length, 30)
    assert.deepEqual(body.days.map((day) => day.date), parseCalendarMonth('2031-11').dates)

    const byDate = new Map(body.days.map((day) => [day.date, day]))
    assert.deepEqual(byDate.get('2031-11-05'), {
      date: '2031-11-05',
      blocked: null,
      bookings: [{ id: pending, status: 'pending_review', stage: 'pending_review', customerFirstName: 'نورة', packageName: '4 ساعات' }],
    })
    assert.deepEqual(
      byDate.get('2031-11-10').bookings.map((booking) => [booking.id, booking.stage]),
      [[hold, 'approved_hold'], [second, 'pending_review']],
    )
    // A legacy status has no journey stage.
    assert.deepEqual(byDate.get('2031-11-12').bookings.map((booking) => [booking.id, booking.stage]), [[legacy, null]])
    assert.deepEqual(byDate.get('2031-11-15').blocked, { reason: 'سفر' })
    assert.deepEqual(byDate.get('2031-11-16').blocked, { reason: null })
    assert.deepEqual(byDate.get('2031-11-20').bookings, [])
    // Erased customer: the date stays occupied, her name is not shown.
    assert.equal(byDate.get('2031-11-30').bookings[0].id, ofErased)
    assert.equal(byDate.get('2031-11-30').bookings[0].customerFirstName, null)
    // A snapshot of an unknown schema gives no package name.
    assert.equal(byDate.get('2031-11-07').bookings[0].packageName, null)

    const ids = body.days.flatMap((day) => day.bookings.map((booking) => booking.id))
    assert.equal(ids.length, 6)
    assert.equal(ids.includes(cancelled), false)
  })

  test('includeClosed=1 adds closed requests, without a stage', async () => {
    const { body } = await call(handleAdminCalendar, db, '/api/admin/calendar?month=2031-11&includeClosed=1')
    const day = body.days.find((entry) => entry.date === '2031-11-20')

    assert.equal(body.includeClosed, true)
    assert.deepEqual(day.bookings.map((booking) => [booking.id, booking.status, booking.stage]), [[cancelled, 'cancelled', null]])
  })

  test('without month: the current Asia/Riyadh month', async () => {
    const { status, body } = await call(handleAdminCalendar, db, '/api/admin/calendar')
    const riyadhMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit' }).format(new Date())

    assert.equal(status, 200)
    assert.equal(body.month, riyadhMonth)
  })

  test('malformed, repeated or unknown parameters are refused before any read', async () => {
    const before = db.calls.batch

    for (const [query, code] of [
      ['?month=2031-13', 'INVALID_MONTH'],
      ['?month=2031-1', 'INVALID_MONTH'],
      ['?month=', 'INVALID_MONTH'],
      ['?month=2031-11-01', 'INVALID_MONTH'],
      ['?month=2031-11&month=2031-12', 'INVALID_QUERY'],
      ['?month=2031-11&includeClosed=true', 'INVALID_QUERY'],
      ['?month=2031-11&includeClosed=1&includeClosed=1', 'INVALID_QUERY'],
      ['?month=2031-11&q=%D9%86%D9%88%D8%B1%D8%A9', 'INVALID_QUERY'],
    ]) {
      const { status, body } = await call(handleAdminCalendar, db, `/api/admin/calendar${query}`)

      assert.equal(status, 400, query)
      assert.equal(body.error.code, code, query)
    }

    assert.equal(db.calls.batch, before)
  })

  // Closed requests are the only ones the unique indexes let pile up on one date.
  test(`at most ${CALENDAR_MAXIMUM_BOOKINGS} bookings, earliest dates first, then truncated`, async () => {
    const big = createDatabase()
    addUser(big.writer, { id: 'CustomerA', createdAt: '2026-01-01 10:00:00' })
    big.writer.exec('BEGIN')

    for (let index = 0; index <= CALENDAR_MAXIMUM_BOOKINGS; index += 1) {
      addBooking(big.writer, {
        userId: 'CustomerA',
        eventDate: index === CALENDAR_MAXIMUM_BOOKINGS ? '2031-11-30' : '2031-11-02',
        status: 'rejected',
      })
    }

    big.writer.exec('COMMIT')

    const { body } = await call(handleAdminCalendar, createReadOnlyD1(big.path), '/api/admin/calendar?month=2031-11&includeClosed=1')
    const count = body.days.reduce((total, day) => total + day.bookings.length, 0)

    assert.equal(body.truncated, true)
    assert.equal(count, CALENDAR_MAXIMUM_BOOKINGS)
    assert.equal(body.days.find((day) => day.date === '2031-11-30').bookings.length, 0)
  })

  test('RL_ADMIN_READ over its allowance → 429 before any read, keyed by the admin uid', async () => {
    const before = db.calls.batch
    const { status, body, headers, rateLimit } = await call(handleAdminCalendar, db, '/api/admin/calendar?month=2031-11', { limited: true })

    assert.equal(status, 429)
    assert.equal(body.error.code, 'RATE_LIMITED')
    assert.equal(headers.get('Retry-After'), '60')
    assert.deepEqual(rateLimit.keys, [ADMIN])
    assert.equal(db.calls.batch, before)
  })
})

// ---------------------------------------------------------------------------
// #37 customers
// ---------------------------------------------------------------------------

describe('GET /api/admin/customers', () => {
  const { path, writer } = createDatabase()
  // Three share one created_at second: the id breaks the tie.
  addUser(writer, { id: 'CustomerA', firstName: 'نورة', createdAt: '2026-03-01 10:00:00' })
  addUser(writer, { id: 'CustomerB', firstName: 'ريم', createdAt: '2026-03-02 10:00:00', contactChangedAt: '2026-09-01T12:00:00.000Z' })
  addUser(writer, { id: 'CustomerC', firstName: 'سارة', createdAt: '2026-03-02 10:00:00' })
  addUser(writer, { id: 'CustomerD', firstName: 'لمى', createdAt: '2026-03-02 10:00:00' })
  addUser(writer, { id: 'CustomerE', firstName: 'هيا', createdAt: '2026-03-03 10:00:00' })
  // An ISO value (not what the schema writes, but readable): same keyset.
  addUser(writer, { id: 'CustomerIso', firstName: 'جود', createdAt: '2026-03-04T10:00:00.000Z' })
  addUser(writer, { id: 'CustomerErased', firstName: 'محذوفة', createdAt: '2026-03-05 10:00:00', erasedAt: '2026-09-01T00:00:00.000Z' })
  addUser(writer, { id: ADMIN, firstName: 'المصورة', role: 'admin', createdAt: '2026-03-06 10:00:00' })
  addBooking(writer, { userId: 'CustomerB', eventDate: '2031-05-01', status: 'cancelled' })
  const latest = addBooking(writer, { userId: 'CustomerB', eventDate: '2031-06-01', createdAt: '2026-09-02T00:00:00.000Z' })
  addBooking(writer, { userId: 'CustomerErased', eventDate: '2031-07-01' })
  const db = createReadOnlyD1(path)
  const expectedOrder = ['CustomerIso', 'CustomerE', 'CustomerD', 'CustomerC', 'CustomerB', 'CustomerA']

  test('newest first; erased customers and admins are never listed; contactChangedAt exposed', async () => {
    const { status, body, headers } = await call(handleAdminCustomerList, db, '/api/admin/customers')

    assert.equal(status, 200)
    assert.equal(headers.get('Cache-Control'), 'no-store')
    assert.equal(body.nextCursor, null)
    assert.deepEqual(body.customers.map((customer) => customer.id), expectedOrder)
    assert.deepEqual(body.customers.find((customer) => customer.id === 'CustomerB'), {
      id: 'CustomerB',
      firstName: 'ريم',
      lastName: 'تجريبية',
      email: 'customerb@example.test',
      phone: '+447700900001',
      createdAt: '2026-03-02T10:00:00.000Z',
      contactChangedAt: '2026-09-01T12:00:00.000Z',
      bookingCount: 2,
      lastEventDate: '2031-06-01',
    })
    assert.equal(body.customers.find((customer) => customer.id === 'CustomerIso').createdAt, '2026-03-04T10:00:00.000Z')
    assert.equal(body.customers.find((customer) => customer.id === 'CustomerA').lastEventDate, null)
  })

  test('keyset paging visits every customer once, ties included', async () => {
    for (const limit of [1, 2, 3, 4, 5]) {
      const seen = []
      let cursor = null

      do {
        const query = cursor === null ? `?limit=${limit}` : `?limit=${limit}&cursor=${cursor}`
        const { status, body } = await call(handleAdminCustomerList, db, `/api/admin/customers${query}`)

        assert.equal(status, 200)
        assert.ok(body.customers.length <= limit)
        seen.push(...body.customers.map((customer) => customer.id))
        cursor = body.nextCursor

        if (cursor !== null) {
          assert.ok(isCurrentTimestampText(decodeCustomerListCursor(cursor).createdAt))
        }
      } while (cursor !== null)

      assert.deepEqual(seen, expectedOrder, `limit=${limit}`)
    }
  })

  test('bad limit, bad cursor, a search text or any other parameter → 400 before any read', async () => {
    const before = db.calls.prepare
    const isoCursor = Buffer.from(JSON.stringify({ createdAt: '2026-03-02T10:00:00.000Z', id: 'CustomerC' })).toString('base64url')

    for (const [query, code] of [
      ['?limit=0', 'INVALID_LIMIT'],
      ['?limit=101', 'INVALID_LIMIT'],
      ['?limit=01', 'INVALID_LIMIT'],
      ['?limit=abc', 'INVALID_LIMIT'],
      ['?limit=', 'INVALID_LIMIT'],
      ['?limit=%D9%A5', 'INVALID_LIMIT'],
      [`?cursor=${isoCursor}`, 'INVALID_CURSOR'],
      ['?cursor=', 'INVALID_CURSOR'],
      ['?q=0550000000', 'INVALID_QUERY'],
      ['?limit=5&limit=5', 'INVALID_QUERY'],
      ['?status=pending_review', 'INVALID_QUERY'],
    ]) {
      const { status, body } = await call(handleAdminCustomerList, db, `/api/admin/customers${query}`)

      assert.equal(status, 400, query)
      assert.equal(body.error.code, code, query)
    }

    assert.equal(db.calls.prepare, before)
  })

  test('limit=100 is accepted', async () => {
    const { status, body } = await call(handleAdminCustomerList, db, '/api/admin/customers?limit=100')

    assert.equal(status, 200)
    assert.equal(body.customers.length, expectedOrder.length)
  })

  test('detail: her profile and booking summaries with their stage', async () => {
    const { status, body } = await call(handleAdminCustomerDetail, db, '/api/admin/customers/CustomerB', {
      params: { customerId: 'CustomerB' },
    })

    assert.equal(status, 200)
    assert.equal(body.customer.id, 'CustomerB')
    assert.equal(body.customer.contactChangedAt, '2026-09-01T12:00:00.000Z')
    assert.equal(body.bookingsTruncated, false)
    assert.deepEqual(body.bookings.map((booking) => [booking.status, booking.stage]), [
      ['pending_review', 'pending_review'],
      ['cancelled', null],
    ])
    assert.deepEqual(body.bookings[0], {
      id: latest,
      eventDate: '2031-06-01',
      status: 'pending_review',
      stage: 'pending_review',
      packageName: '4 ساعات',
      estimatedTotal: 4000,
      createdAt: '2026-09-02T00:00:00.000Z',
    })
  })

  test('detail: unknown, erased and admin ids get the same 404 as an unknown admin path', async () => {
    for (const customerId of ['NoSuchCustomer', 'CustomerErased', ADMIN]) {
      const { status, body } = await call(handleAdminCustomerDetail, db, `/api/admin/customers/${customerId}`, {
        params: { customerId },
      })

      assert.equal(status, 404, customerId)
      assert.deepEqual(body, NOT_FOUND_BODY, customerId)
    }
  })

  test('detail: a query string is refused; RL_ADMIN_READ applies', async () => {
    const refused = await call(handleAdminCustomerDetail, db, '/api/admin/customers/CustomerB?q=x', {
      params: { customerId: 'CustomerB' },
    })
    const before = db.calls.batch
    const limited = await call(handleAdminCustomerDetail, db, '/api/admin/customers/CustomerB', {
      params: { customerId: 'CustomerB' },
      limited: true,
    })
    const limitedList = await call(handleAdminCustomerList, db, '/api/admin/customers', { limited: true })

    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'INVALID_QUERY')
    assert.equal(limited.status, 429)
    assert.equal(limitedList.status, 429)
    assert.equal(db.calls.batch, before)
  })
})
