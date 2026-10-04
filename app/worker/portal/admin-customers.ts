/**
 * The customers directory (plan 11 §3.2 #37, W2-11). Auth AD: the admin
 * portal dispatcher has already run authorizeAdminRequest.
 *
 * - GET /api/admin/customers?cursor=&limit= → newest customer first,
 *   keyset-paginated on (created_at, id).
 * - GET /api/admin/customers/{customerId} → her profile and her booking
 *   summaries (newest first, at most CUSTOMER_MAXIMUM_BOOKINGS).
 *
 * The directory lists customer accounts only: admin rows and erased
 * customers (users.erased_at set) are never listed, and asking for one by
 * id answers the same 404 as an id that does not exist (SB-2, no existence
 * oracle). No free-text parameter is accepted: search is POST (#42, TM-17).
 *
 * The cursor has its own validator. users.created_at is SQLite's
 * CURRENT_TIMESTAMP text (`YYYY-MM-DD HH:MM:SS`), not the ISO-8601 instants
 * the booking list pages on, so the keyset is datetime(created_at): the
 * same format for every stored value, sorted as text. A row whose
 * created_at cannot be read sorts as CUSTOMER_UNREADABLE_CREATED_AT, last.
 * The cursor is base64url(JSON {createdAt, id}) and is accepted only in the
 * exact form this Worker issues.
 *
 * SB-4: bound parameters only. SB-7: logs carry fixed codes and counts.
 */

import {
  CUSTOMER_MAXIMUM_BOOKINGS,
  CUSTOMERS_DEFAULT_LIMIT,
  CUSTOMERS_MAXIMUM_LIMIT,
  currentTimestampToIso,
  isCurrentTimestampText,
  type AdminCustomerBookingSummary,
  type AdminCustomerDetailResponse,
  type AdminCustomersResponse,
  type AdminDirectoryCustomer,
} from '../../shared/portal/admin-directory.js'
import { isValidDateKey } from '../../shared/timing.js'
import { errorResponse, jsonResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import {
  ADMIN_BOOKING_STAGE_COLUMNS,
  ADMIN_BOOKING_STAGE_JOINS,
  readAdminBookingStageRow,
} from './admin-calendar.js'
import type { AdminPortalContext } from './admin-portal-routes.js'

type Row = Record<string, unknown>

/** Keyset position: the list continues strictly after this customer. */
export interface CustomerListCursor {
  /** `YYYY-MM-DD HH:MM:SS`, datetime(users.created_at). */
  readonly createdAt: string
  readonly id: string
}

/** The sort key of a row whose created_at SQLite cannot read. */
export const CUSTOMER_UNREADABLE_CREATED_AT = '1970-01-01 00:00:00'

/** users.id is a Firebase uid: at most 128 characters. */
const MAXIMUM_CUSTOMER_ID_LENGTH = 128
/** A real cursor is about 70 characters; this fits the longest valid id. */
const MAXIMUM_CURSOR_LENGTH = 320

const cursorKeys: ReadonlySet<string> = new Set(['createdAt', 'id'])
const listQueryKeys: ReadonlySet<string> = new Set(['cursor', 'limit'])

/** Sort key and keyset column, in one place for the ORDER BY and the seek. */
const CUSTOMER_SORT_KEY = `COALESCE(datetime(u.created_at), '${CUSTOMER_UNREADABLE_CREATED_AT}')`

const CUSTOMER_COLUMNS = `
    u.id AS id,
    u.first_name AS firstName,
    u.last_name AS lastName,
    u.email AS email,
    u.phone AS phone,
    ${CUSTOMER_SORT_KEY} AS sortKey,
    u.contact_changed_at AS contactChangedAt,
    (
      SELECT COUNT(*)
      FROM booking_requests AS cb
      WHERE cb.user_id = u.id
    ) AS bookingCount,
    (
      SELECT MAX(cb.event_date)
      FROM booking_requests AS cb
      WHERE cb.user_id = u.id
    ) AS lastEventDate`

/** Customers only, never erased ones. */
const LISTED_CUSTOMER = `u.role = 'customer' AND u.erased_at IS NULL`

/** ?1 row cap (one more than the page). */
const CUSTOMERS_FIRST_PAGE_SQL = `
  SELECT ${CUSTOMER_COLUMNS}
  FROM users AS u
  WHERE ${LISTED_CUSTOMER}
  ORDER BY sortKey DESC, u.id DESC
  LIMIT ?1
`

/** ?1 row cap | ?2 cursor createdAt | ?3 cursor id. */
const CUSTOMERS_NEXT_PAGE_SQL = `
  SELECT ${CUSTOMER_COLUMNS}
  FROM users AS u
  WHERE ${LISTED_CUSTOMER}
    AND (${CUSTOMER_SORT_KEY}, u.id) < (?2, ?3)
  ORDER BY sortKey DESC, u.id DESC
  LIMIT ?1
`

/** ?1 customer id. */
const CUSTOMER_BY_ID_SQL = `
  SELECT ${CUSTOMER_COLUMNS}
  FROM users AS u
  WHERE u.id = ?1
    AND ${LISTED_CUSTOMER}
`

/**
 * ?1 customer id | ?2 row cap. Joined to the listed customer again, so an
 * erasure between the two statements of the batch still shows nothing.
 */
const CUSTOMER_BOOKINGS_SQL = `
  SELECT
    ${ADMIN_BOOKING_STAGE_COLUMNS},
    b.estimated_total AS estimatedTotal,
    b.created_at AS createdAt
  FROM booking_requests AS b
  INNER JOIN users AS u ON u.id = b.user_id
  ${ADMIN_BOOKING_STAGE_JOINS}
  WHERE b.user_id = ?1
    AND ${LISTED_CUSTOMER}
  ORDER BY b.created_at DESC, b.id DESC
  LIMIT ?2
`

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }

  return false
}

function isCustomerId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAXIMUM_CUSTOMER_ID_LENGTH &&
    !containsControlCharacter(value)
  )
}

function encodeBase64Url(value: string): string {
  let binary = ''

  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Unpadded base64url to UTF-8 text; null for anything malformed. */
function decodeBase64Url(value: string): string | null {
  // A length of 4n + 1 can never come out of a base64 encoder.
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    return null
  }

  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4)
  const bytes = Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0),
  )

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch (error) {
    if (error instanceof TypeError) {
      return null
    }

    throw error
  }
}

export function encodeCustomerListCursor(cursor: CustomerListCursor): string {
  return encodeBase64Url(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }))
}

/**
 * Accepts only a cursor this Worker issued: exactly {createdAt, id}, with
 * createdAt in the CURRENT_TIMESTAMP format, a plausible id, and
 * byte-for-byte the canonical encoding of those two values.
 */
export function decodeCustomerListCursor(value: string): CustomerListCursor | null {
  if (value.length === 0 || value.length > MAXIMUM_CURSOR_LENGTH) {
    return null
  }

  const json = decodeBase64Url(value)

  if (json === null) {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(json)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }

  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== cursorKeys.size ||
    Object.keys(parsed).some((key) => !cursorKeys.has(key)) ||
    typeof parsed.createdAt !== 'string' ||
    !isCurrentTimestampText(parsed.createdAt) ||
    !isCustomerId(parsed.id)
  ) {
    return null
  }

  const cursor: CustomerListCursor = { createdAt: parsed.createdAt, id: parsed.id }

  return encodeCustomerListCursor(cursor) === value ? cursor : null
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

interface CustomerRecord {
  readonly customer: AdminDirectoryCustomer
  /** The keyset value, `YYYY-MM-DD HH:MM:SS`. */
  readonly sortKey: string
}

/** Guards one customer row; null when any column has an unexpected shape. */
export function readCustomerRow(row: Row): CustomerRecord | null {
  const {
    id,
    firstName,
    lastName,
    email,
    phone,
    sortKey,
    contactChangedAt,
    bookingCount,
    lastEventDate,
  } = row

  if (
    !isCustomerId(id) ||
    typeof firstName !== 'string' ||
    typeof lastName !== 'string' ||
    typeof email !== 'string' ||
    typeof phone !== 'string' ||
    typeof sortKey !== 'string' ||
    !(contactChangedAt === null || typeof contactChangedAt === 'string') ||
    !isNonNegativeSafeInteger(bookingCount) ||
    !(lastEventDate === null || (typeof lastEventDate === 'string' && isValidDateKey(lastEventDate)))
  ) {
    return null
  }

  const createdAt = currentTimestampToIso(sortKey)

  if (createdAt === null) {
    return null
  }

  return {
    sortKey,
    customer: {
      id,
      firstName,
      lastName,
      email,
      phone,
      createdAt,
      contactChangedAt,
      bookingCount,
      lastEventDate,
    },
  }
}

function readCustomerBookingRow(row: Row, now: Date): AdminCustomerBookingSummary | null {
  const record = readAdminBookingStageRow(row, now)
  const { estimatedTotal, createdAt } = row

  if (
    record === null ||
    !isNonNegativeSafeInteger(estimatedTotal) ||
    typeof createdAt !== 'string'
  ) {
    return null
  }

  return {
    id: record.id,
    eventDate: record.eventDate,
    status: record.status,
    stage: record.stage,
    packageName: record.packageName,
    estimatedTotal,
    createdAt,
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function invalidQueryResponse(): Response {
  return errorResponse(400, 'INVALID_QUERY', 'معاملات الطلب غير صحيحة.')
}

function invalidLimitResponse(): Response {
  return errorResponse(
    400,
    'INVALID_LIMIT',
    `يجب أن يكون الحد عددًا صحيحًا بين 1 و${CUSTOMERS_MAXIMUM_LIMIT}.`,
  )
}

function invalidCursorResponse(): Response {
  return errorResponse(
    400,
    'INVALID_CURSOR',
    'رابط الصفحة التالية من القائمة غير صالح. حدّثي القائمة ثم أعيدي المحاولة.',
  )
}

/**
 * An unknown, erased or admin id answers exactly like an unknown admin path
 * (admin-portal-routes.ts adminNotFoundResponse), so the answer tells
 * nothing about which ids exist (SB-2).
 */
function customerNotFoundResponse(): Response {
  return errorResponse(404, 'NOT_FOUND', 'مسار API الإداري غير موجود.')
}

type ListQuery =
  | { readonly ok: true; readonly limit: number; readonly cursor: CustomerListCursor | null }
  | { readonly ok: false; readonly response: Response }

/**
 * Strict: only `cursor` and `limit`, each at most once (so `q` or any other
 * name is refused). `limit` is 1–CUSTOMERS_MAXIMUM_LIMIT in ASCII digits.
 */
export function parseCustomerListQuery(url: URL): ListQuery {
  const params = url.searchParams

  for (const key of params.keys()) {
    if (!listQueryKeys.has(key) || params.getAll(key).length !== 1) {
      return { ok: false, response: invalidQueryResponse() }
    }
  }

  let limit = CUSTOMERS_DEFAULT_LIMIT
  const limitValue = params.get('limit')

  if (limitValue !== null) {
    if (!/^[1-9]\d{0,2}$/.test(limitValue)) {
      return { ok: false, response: invalidLimitResponse() }
    }

    limit = Number(limitValue)

    if (limit > CUSTOMERS_MAXIMUM_LIMIT) {
      return { ok: false, response: invalidLimitResponse() }
    }
  }

  const cursorValue = params.get('cursor')
  let cursor: CustomerListCursor | null = null

  if (cursorValue !== null) {
    cursor = decodeCustomerListCursor(cursorValue)

    if (cursor === null) {
      return { ok: false, response: invalidCursorResponse() }
    }
  }

  return { ok: true, limit, cursor }
}

async function isAdminReadLimited(context: AdminPortalContext): Promise<boolean> {
  // RL_ADMIN_READ (§3.1): slows a scripted scrape with a stolen session.
  return (await limitBurst(context.env.RL_ADMIN_READ, context.admin.uid)) === 'limited'
}

export async function handleAdminCustomerList(
  context: AdminPortalContext,
): Promise<Response> {
  if (await isAdminReadLimited(context)) {
    return rateLimitedResponse()
  }

  const query = parseCustomerListQuery(context.url)

  if (!query.ok) {
    return query.response
  }

  const { limit, cursor } = query
  const statement = cursor === null
    ? context.env.DB.prepare(CUSTOMERS_FIRST_PAGE_SQL).bind(limit + 1)
    : context.env.DB.prepare(CUSTOMERS_NEXT_PAGE_SQL).bind(limit + 1, cursor.createdAt, cursor.id)
  const { results } = await statement.all<Row>()
  const pageRows = results.slice(0, limit)
  const customers: AdminDirectoryCustomer[] = []
  let lastRead: CustomerListCursor | null = null
  let skippedCount = 0

  for (const row of pageRows) {
    const record = readCustomerRow(row)

    if (record === null) {
      skippedCount += 1
    } else {
      customers.push(record.customer)
    }

    // The cursor follows the last row READ, even a skipped one, so no row
    // is read twice or passed over. A row too broken to seek from ends the
    // list here rather than restarting it.
    lastRead =
      typeof row.sortKey === 'string' &&
      isCurrentTimestampText(row.sortKey) &&
      isCustomerId(row.id)
        ? { createdAt: row.sortKey, id: row.id }
        : null
  }

  if (skippedCount > 0) {
    console.error(`ADMIN_CUSTOMERS_ROW_INVALID count=${skippedCount}`)
  }

  const response: AdminCustomersResponse = {
    ok: true,
    customers,
    nextCursor:
      results.length > limit && lastRead !== null
        ? encodeCustomerListCursor(lastRead)
        : null,
  }

  return jsonResponse(response)
}

export async function handleAdminCustomerDetail(
  context: AdminPortalContext,
): Promise<Response> {
  if (await isAdminReadLimited(context)) {
    return rateLimitedResponse()
  }

  // Filter-free route: any query string is refused like on the list.
  if ([...context.url.searchParams.keys()].length > 0) {
    return invalidQueryResponse()
  }

  const customerId = context.params.customerId

  if (!isCustomerId(customerId)) {
    return customerNotFoundResponse()
  }

  const db = context.env.DB
  const [customerResult, bookingResult] = await db.batch<Row>([
    db.prepare(CUSTOMER_BY_ID_SQL).bind(customerId),
    db.prepare(CUSTOMER_BOOKINGS_SQL).bind(customerId, CUSTOMER_MAXIMUM_BOOKINGS + 1),
  ])
  const customerRow = customerResult?.results[0]

  if (customerRow === undefined) {
    return customerNotFoundResponse()
  }

  const record = readCustomerRow(customerRow)

  if (record === null) {
    console.error('ADMIN_CUSTOMER_ROW_INVALID')

    return customerNotFoundResponse()
  }

  const now = new Date()
  const bookingRows = bookingResult?.results ?? []
  const bookings: AdminCustomerBookingSummary[] = []
  let skippedCount = 0

  for (const row of bookingRows.slice(0, CUSTOMER_MAXIMUM_BOOKINGS)) {
    const booking = readCustomerBookingRow(row, now)

    if (booking === null) {
      skippedCount += 1
    } else {
      bookings.push(booking)
    }
  }

  if (skippedCount > 0) {
    console.error(`ADMIN_CUSTOMER_BOOKING_ROW_INVALID count=${skippedCount}`)
  }

  const response: AdminCustomerDetailResponse = {
    ok: true,
    customer: record.customer,
    bookings,
    bookingsTruncated: bookingRows.length > CUSTOMER_MAXIMUM_BOOKINGS,
  }

  return jsonResponse(response)
}
