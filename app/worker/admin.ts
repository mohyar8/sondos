import {
  bookingStatuses,
  getAllowedAdminActions,
  type AdminBlockedDate,
  type AdminBlockedDateResponse,
  type AdminBlockedDatesResponse,
  type AdminBookingActionResponse,
  type AdminBookingDetail,
  type AdminBookingDetailResponse,
  type AdminBookingFilters,
  type AdminBookingStatusHistoryEntry,
  type AdminBookingSummary,
  type AdminBookingsResponse,
  type AdminCustomer,
  type AdminDeleteBlockedDateResponse,
  type BookingStatus,
} from '../shared/admin.js'
import {
  isBookingPackageSnapshot,
  type BookingPackageSnapshot,
} from '../shared/booking.js'
import {
  authorizeAdminRequest,
  type AdminAuthorizationFailure,
  type AuthenticatedAdmin,
} from './admin-auth.js'
import {
  performAdminBookingAction,
  updateAdminBookingNotes,
} from './admin-workflow.js'
import {
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  payloadTooLargeResponse,
  readBoundedJson,
} from './http.js'
import {
  buildMyBookingsUrl,
  renderCustomerBookingStatusTemplate,
} from './email-templates.js'
import { sendEmail } from './email.js'

const DEFAULT_BOOKING_LIMIT = 50
const MAXIMUM_BOOKING_LIMIT = 100
/**
 * The list cursor is base64url(JSON {createdAt, id}) of the last row of a page
 * (inspection #4). A real one (ISO timestamp + UUID) is about 80 characters;
 * the ceiling still fits the longest timestamp and id the guards below accept
 * (at most 600 UTF-8 bytes of JSON, 800 characters once encoded).
 */
const MAXIMUM_BOOKING_CURSOR_LENGTH = 1_024
const MAXIMUM_CURSOR_CREATED_AT_LENGTH = 64
const MAXIMUM_BLOCKED_DATE_RANGE_DAYS = 366
const MAXIMUM_REASON_LENGTH = 500
/** UTF-8 bytes; a date plus a 500-character reason fits well inside. */
const MAXIMUM_BLOCKED_DATE_BODY_BYTES = 2_000
const MAXIMUM_BOOKING_ID_LENGTH = 128
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const RIYADH_TIME_ZONE = 'Asia/Riyadh'

const blockedDateBodyKeys: ReadonlySet<string> = new Set([
  'date',
  'reason',
])

const bookingCursorKeys: ReadonlySet<string> = new Set([
  'createdAt',
  'id',
])

interface ParsedCalendarDate {
  timestamp: number
}

interface AdminBookingRow {
  id: string
  eventDate: string
  status: string
  packageSnapshot: string
  estimatedTotal: number
  adminNotes: string | null
  holdExpiresAt: string | null
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
  customerId: string
  customerFirstName: string
  customerLastName: string
  customerEmail: string
  customerPhone: string
}

interface BookingHistoryRow {
  id: number
  fromStatus: string | null
  toStatus: string
  changedBy: string | null
  note: string | null
  createdAt: string
}

interface BlockedDateRow {
  date: string
  reason: string | null
  createdBy: string | null
  createdAt: string
}

interface ExistenceRow {
  found: number
}

interface VerifiedRecipientRow {
  email: string
}

/**
 * The answer to POST /api/admin/bookings/:id/actions. `customerEmailQueued`
 * is additive: false when no status email to the customer was scheduled
 * (her stored address was never proven by a verified sign-in, her data was
 * erased, or APP_BASE_URL is unset), so the admin UI can tell the owner to
 * reach her another way, e.g. on WhatsApp.
 */
interface AdminBookingActionResult extends AdminBookingActionResponse {
  customerEmailQueued: boolean
}

type QueryBinding = string | number

interface ParsedBlockedDateBody {
  date: string
  reason: string | null
}

interface BookingSubresourcePath {
  bookingId: string
  resource: 'actions' | 'notes'
}

/** Keyset position: the list continues strictly after this row. */
interface BookingListCursor {
  createdAt: string
  id: string
}

interface ParsedBookingListQuery {
  filters: AdminBookingFilters
  cursor: BookingListCursor | null
}

const riyadhDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: RIYADH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index)

    if (
      characterCode <= 0x1f ||
      (characterCode >= 0x7f && characterCode <= 0x9f)
    ) {
      return true
    }
  }

  return false
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return (
    typeof value === 'string' &&
    bookingStatuses.some((status) => status === value)
  )
}

function parseCalendarDate(value: string): ParsedCalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }

  const parsedDate = new Date(0)

  parsedDate.setUTCHours(0, 0, 0, 0)
  parsedDate.setUTCFullYear(year, month - 1, day)

  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    return null
  }

  return {
    timestamp: parsedDate.getTime(),
  }
}

function getRiyadhCalendarDate(date: Date): string {
  const parts = riyadhDateFormatter.formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value

  if (!year || !month || !day) {
    throw new Error('Riyadh calendar date formatting failed')
  }

  return `${year}-${month}-${day}`
}

function parseStoredSnapshot(value: string): BookingPackageSnapshot | null {
  try {
    const parsedValue: unknown = JSON.parse(value)

    return isBookingPackageSnapshot(parsedValue) ? parsedValue : null
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

function toAdminCustomer(row: AdminBookingRow): AdminCustomer {
  return {
    id: row.customerId,
    firstName: row.customerFirstName,
    lastName: row.customerLastName,
    email: row.customerEmail,
    phone: row.customerPhone,
  }
}

function toBlockedDate(row: BlockedDateRow): AdminBlockedDate {
  return {
    date: row.date,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

function invalidDateResponse(): Response {
  return errorResponse(
    400,
    'INVALID_DATE',
    'يجب أن يكون التاريخ بصيغة YYYY-MM-DD وأن يمثل تاريخًا صحيحًا.',
  )
}

function invalidDateRangeResponse(): Response {
  return errorResponse(
    400,
    'INVALID_DATE_RANGE',
    'يجب أن يكون تاريخ البداية قبل تاريخ النهاية أو مساويًا له.',
  )
}

function dateHasActiveBookingResponse(): Response {
  return errorResponse(
    409,
    'DATE_HAS_ACTIVE_BOOKING',
    'لا يمكن حجب هذا التاريخ لوجود حجز نشط عليه.',
  )
}

function invalidCursorResponse(): Response {
  return errorResponse(
    400,
    'INVALID_CURSOR',
    'رابط الصفحة التالية من القائمة غير صالح. حدّثي القائمة ثم أعيدي المحاولة.',
  )
}

function encodeBase64Url(value: string): string {
  let binary = ''

  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Decodes unpadded base64url to UTF-8 text; null for anything malformed. */
function decodeBase64Url(value: string): string | null {
  // A length of 4n + 1 can never come out of a base64 encoder.
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    return null
  }

  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  )

  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes)
  } catch (error) {
    if (error instanceof TypeError) {
      return null
    }

    throw error
  }
}

function isCursorText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !containsControlCharacter(value)
  )
}

function encodeBookingListCursor(cursor: BookingListCursor): string {
  return encodeBase64Url(
    JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }),
  )
}

/**
 * Accepts only a cursor this Worker issued: exactly {createdAt, id}, both
 * plausible, and byte-for-byte the canonical encoding of those two values.
 */
function decodeBookingListCursor(value: string): BookingListCursor | null {
  if (value.length === 0 || value.length > MAXIMUM_BOOKING_CURSOR_LENGTH) {
    return null
  }

  const json = decodeBase64Url(value)

  if (json === null) {
    return null
  }

  let parsedCursor: unknown

  try {
    parsedCursor = JSON.parse(json)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }

  if (
    !isRecord(parsedCursor) ||
    Object.keys(parsedCursor).length !== bookingCursorKeys.size ||
    Object.keys(parsedCursor).some((key) => !bookingCursorKeys.has(key)) ||
    !isCursorText(parsedCursor.createdAt, MAXIMUM_CURSOR_CREATED_AT_LENGTH) ||
    !isCursorText(parsedCursor.id, MAXIMUM_BOOKING_ID_LENGTH)
  ) {
    return null
  }

  const cursor: BookingListCursor = {
    createdAt: parsedCursor.createdAt,
    id: parsedCursor.id,
  }

  return encodeBookingListCursor(cursor) === value ? cursor : null
}

function parseBookingFilters(url: URL):
  | { ok: true; query: ParsedBookingListQuery }
  | { ok: false; response: Response } {
  const statusValue = url.searchParams.get('status')
  const fromValue = url.searchParams.get('from')
  const toValue = url.searchParams.get('to')
  const limitValue = url.searchParams.get('limit')
  const cursorValue = url.searchParams.get('cursor')

  if (statusValue !== null && !isBookingStatus(statusValue)) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'INVALID_STATUS',
        'حالة الحجز المطلوبة غير صحيحة.',
      ),
    }
  }

  const parsedFrom = fromValue === null ? null : parseCalendarDate(fromValue)
  const parsedTo = toValue === null ? null : parseCalendarDate(toValue)

  if (
    (fromValue !== null && !parsedFrom) ||
    (toValue !== null && !parsedTo)
  ) {
    return {
      ok: false,
      response: invalidDateResponse(),
    }
  }

  if (parsedFrom && parsedTo && parsedFrom.timestamp > parsedTo.timestamp) {
    return {
      ok: false,
      response: invalidDateRangeResponse(),
    }
  }

  let limit = DEFAULT_BOOKING_LIMIT

  if (limitValue !== null) {
    if (!/^\d{1,3}$/.test(limitValue)) {
      return {
        ok: false,
        response: errorResponse(
          400,
          'INVALID_LIMIT',
          'يجب أن يكون الحد عددًا صحيحًا بين 1 و100.',
        ),
      }
    }

    limit = Number(limitValue)

    if (limit < 1 || limit > MAXIMUM_BOOKING_LIMIT) {
      return {
        ok: false,
        response: errorResponse(
          400,
          'INVALID_LIMIT',
          'يجب أن يكون الحد عددًا صحيحًا بين 1 و100.',
        ),
      }
    }
  }

  let cursor: BookingListCursor | null = null

  if (cursorValue !== null) {
    cursor = decodeBookingListCursor(cursorValue)

    if (!cursor) {
      return {
        ok: false,
        response: invalidCursorResponse(),
      }
    }
  }

  return {
    ok: true,
    query: {
      filters: {
        ...(statusValue === null ? {} : { status: statusValue }),
        ...(fromValue === null ? {} : { from: fromValue }),
        ...(toValue === null ? {} : { to: toValue }),
        limit,
      },
      cursor,
    },
  }
}

/**
 * Newest first, keyset-paginated on (created_at DESC, id DESC). created_at is
 * compared and sorted as the stored text (the Worker writes ISO-8601 UTC), so
 * an index on (created_at, id) can serve both the order and the cursor, which
 * datetime(created_at) never could. The ORDER BY and the cursor condition use
 * the same text order, so paging never repeats or skips a row even around a
 * legacy 'YYYY-MM-DD HH:MM:SS' value. One extra row is read to learn whether
 * another page exists.
 */
async function handleBookingList(env: Env, url: URL): Promise<Response> {
  const parsedFilters = parseBookingFilters(url)

  if (!parsedFilters.ok) {
    return parsedFilters.response
  }

  const { filters, cursor } = parsedFilters.query
  const conditions: string[] = []
  const bindings: QueryBinding[] = []

  if (filters.status) {
    conditions.push('b.status = ?')
    bindings.push(filters.status)
  }

  if (filters.from) {
    conditions.push('b.event_date >= ?')
    bindings.push(filters.from)
  }

  if (filters.to) {
    conditions.push('b.event_date <= ?')
    bindings.push(filters.to)
  }

  if (cursor) {
    conditions.push('(b.created_at, b.id) < (?, ?)')
    bindings.push(cursor.createdAt, cursor.id)
  }

  const whereClause =
    conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
  const statement = env.DB.prepare(
    `
      SELECT
        b.id,
        b.event_date AS eventDate,
        b.status,
        b.package_snapshot AS packageSnapshot,
        b.estimated_total AS estimatedTotal,
        b.admin_notes AS adminNotes,
        b.hold_expires_at AS holdExpiresAt,
        b.confirmed_at AS confirmedAt,
        b.created_at AS createdAt,
        b.updated_at AS updatedAt,
        u.id AS customerId,
        u.first_name AS customerFirstName,
        u.last_name AS customerLastName,
        u.email AS customerEmail,
        u.phone AS customerPhone
      FROM booking_requests AS b
      INNER JOIN users AS u ON u.id = b.user_id
      ${whereClause}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?
    `,
  ).bind(...bindings, filters.limit + 1)
  const result = await statement.all<AdminBookingRow>()
  const pageRows = result.results.slice(0, filters.limit)
  const lastPageRow = pageRows[pageRows.length - 1]
  // The cursor follows the last row READ, even if that row is skipped below
  // for an unreadable status, so no row is ever read twice or passed over.
  const nextCursor =
    result.results.length > filters.limit && lastPageRow
      ? encodeBookingListCursor({
          createdAt: lastPageRow.createdAt,
          id: lastPageRow.id,
        })
      : null
  const bookings: AdminBookingSummary[] = []

  for (const row of pageRows) {
    if (!isBookingStatus(row.status)) {
      continue
    }

    const snapshot = parseStoredSnapshot(row.packageSnapshot)

    bookings.push({
      id: row.id,
      eventDate: row.eventDate,
      status: row.status,
      packageName: snapshot?.package.name ?? null,
      estimatedTotal: row.estimatedTotal,
      customer: toAdminCustomer(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  }

  const response: AdminBookingsResponse = {
    ok: true,
    filters,
    bookings,
    nextCursor,
  }

  return jsonResponse(response)
}

function parseBookingId(pathname: string): string | null {
  const match = /^\/api\/admin\/bookings\/([^/]+)$/.exec(pathname)

  if (!match?.[1]) {
    return null
  }

  let decodedId: string

  try {
    decodedId = decodeURIComponent(match[1])
  } catch (error) {
    if (error instanceof URIError) {
      return ''
    }

    throw error
  }

  if (
    decodedId.length === 0 ||
    decodedId.length > MAXIMUM_BOOKING_ID_LENGTH ||
    containsControlCharacter(decodedId)
  ) {
    return ''
  }

  return decodedId
}

function parseBookingSubresourcePath(
  pathname: string,
): BookingSubresourcePath | null {
  const match =
    /^\/api\/admin\/bookings\/([^/]+)\/(actions|notes)$/.exec(pathname)

  if (!match?.[1] || (match[2] !== 'actions' && match[2] !== 'notes')) {
    return null
  }

  let decodedId: string

  try {
    decodedId = decodeURIComponent(match[1])
  } catch (error) {
    if (!(error instanceof URIError)) {
      throw error
    }

    decodedId = ''
  }

  if (
    decodedId.length > MAXIMUM_BOOKING_ID_LENGTH ||
    containsControlCharacter(decodedId)
  ) {
    decodedId = ''
  }

  return {
    bookingId: decodedId,
    resource: match[2],
  }
}

function parseHistoryRows(
  rows: BookingHistoryRow[],
): AdminBookingStatusHistoryEntry[] {
  const history: AdminBookingStatusHistoryEntry[] = []

  for (const row of rows) {
    if (
      !isBookingStatus(row.toStatus) ||
      (row.fromStatus !== null && !isBookingStatus(row.fromStatus))
    ) {
      continue
    }

    history.push({
      id: row.id,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      changedBy: row.changedBy,
      note: row.note,
      createdAt: row.createdAt,
    })
  }

  return history
}

async function loadAdminBookingDetail(
  env: Env,
  bookingId: string,
): Promise<AdminBookingDetail | null> {
  const booking = await env.DB.prepare(
    `
      SELECT
        b.id,
        b.event_date AS eventDate,
        b.status,
        b.package_snapshot AS packageSnapshot,
        b.estimated_total AS estimatedTotal,
        b.admin_notes AS adminNotes,
        b.hold_expires_at AS holdExpiresAt,
        b.confirmed_at AS confirmedAt,
        b.created_at AS createdAt,
        b.updated_at AS updatedAt,
        u.id AS customerId,
        u.first_name AS customerFirstName,
        u.last_name AS customerLastName,
        u.email AS customerEmail,
        u.phone AS customerPhone
      FROM booking_requests AS b
      INNER JOIN users AS u ON u.id = b.user_id
      WHERE b.id = ?
      LIMIT 1
    `,
  )
    .bind(bookingId)
    .first<AdminBookingRow>()

  if (!booking) {
    return null
  }

  if (!isBookingStatus(booking.status)) {
    throw new Error('Stored booking status is invalid')
  }

  const historyResult = await env.DB.prepare(
    `
      SELECT
        id,
        from_status AS fromStatus,
        to_status AS toStatus,
        changed_by AS changedBy,
        note,
        created_at AS createdAt
      FROM booking_status_history
      WHERE booking_id = ?
      ORDER BY id ASC
    `,
  )
    .bind(bookingId)
    .all<BookingHistoryRow>()
  const snapshot = parseStoredSnapshot(booking.packageSnapshot)
  const detail: AdminBookingDetail = {
    id: booking.id,
    eventDate: booking.eventDate,
    status: booking.status,
    allowedActions: getAllowedAdminActions(booking.status),
    packageName: snapshot?.package.name ?? null,
    estimatedTotal: booking.estimatedTotal,
    packageSnapshot: snapshot,
    priceBreakdown: snapshot?.calculation ?? null,
    adminNotes: booking.adminNotes,
    holdExpiresAt: booking.holdExpiresAt,
    confirmedAt: booking.confirmedAt,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
    customer: toAdminCustomer(booking),
    statusHistory: parseHistoryRows(historyResult.results),
  }

  return detail
}

function bookingNotFoundResponse(): Response {
  return errorResponse(
    404,
    'BOOKING_NOT_FOUND',
    'لم يتم العثور على طلب الحجز.',
  )
}

function invalidBookingIdResponse(): Response {
  return errorResponse(
    400,
    'INVALID_BOOKING_ID',
    'مرجع طلب الحجز غير صحيح.',
  )
}

async function handleBookingDetail(
  env: Env,
  bookingId: string,
): Promise<Response> {
  const booking = await loadAdminBookingDetail(env, bookingId)

  if (!booking) {
    return bookingNotFoundResponse()
  }

  const response: AdminBookingDetailResponse = {
    ok: true,
    booking,
  }

  return jsonResponse(response)
}

function parseBlockedDateRange(url: URL):
  | {
      ok: true
      from: string
      to: string
    }
  | {
      ok: false
      response: Response
    } {
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')

  if (!from || !to) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'MISSING_DATE_RANGE',
        'يجب إرسال تاريخ البداية في from وتاريخ النهاية في to.',
      ),
    }
  }

  const parsedFrom = parseCalendarDate(from)
  const parsedTo = parseCalendarDate(to)

  if (!parsedFrom || !parsedTo) {
    return {
      ok: false,
      response: invalidDateResponse(),
    }
  }

  if (parsedFrom.timestamp > parsedTo.timestamp) {
    return {
      ok: false,
      response: invalidDateRangeResponse(),
    }
  }

  const inclusiveRangeDays =
    Math.floor(
      (parsedTo.timestamp - parsedFrom.timestamp) / MILLISECONDS_PER_DAY,
    ) + 1

  if (inclusiveRangeDays > MAXIMUM_BLOCKED_DATE_RANGE_DAYS) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'DATE_RANGE_TOO_LARGE',
        'يجب ألا تتجاوز المدة المطلوبة 366 يومًا شاملة تاريخي البداية والنهاية.',
      ),
    }
  }

  return {
    ok: true,
    from,
    to,
  }
}

async function handleBlockedDateList(env: Env, url: URL): Promise<Response> {
  const parsedRange = parseBlockedDateRange(url)

  if (!parsedRange.ok) {
    return parsedRange.response
  }

  const result = await env.DB.prepare(
    `
      SELECT
        event_date AS date,
        reason,
        created_by AS createdBy,
        created_at AS createdAt
      FROM blocked_dates
      WHERE event_date BETWEEN ? AND ?
      ORDER BY event_date ASC
    `,
  )
    .bind(parsedRange.from, parsedRange.to)
    .all<BlockedDateRow>()
  const response: AdminBlockedDatesResponse = {
    ok: true,
    range: {
      from: parsedRange.from,
      to: parsedRange.to,
    },
    blockedDates: result.results.map(toBlockedDate),
  }

  return jsonResponse(response)
}

function invalidBlockedDateResponse(): Response {
  return errorResponse(
    400,
    'INVALID_BLOCKED_DATE',
    'بيانات التاريخ المحجوب غير صحيحة.',
  )
}

type BlockedDateBodyResult =
  | {
      ok: true
      value: ParsedBlockedDateBody
    }
  | {
      ok: false
      response: Response
    }

/**
 * Reads the POST /api/admin/blocked-dates body through the bounded reader in
 * worker/http.ts (audit SEC-05): 415 for a non-JSON type, 413 over 2,000
 * bytes, 400 INVALID_BLOCKED_DATE for anything malformed.
 */
async function parseBlockedDateBody(
  request: Request,
): Promise<BlockedDateBodyResult> {
  const body = await readBoundedJson(request, MAXIMUM_BLOCKED_DATE_BODY_BYTES)

  if (body.kind === 'unsupported-media-type') {
    return {
      ok: false,
      response: errorResponse(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'يجب إرسال بيانات التاريخ المحجوب بصيغة JSON.',
      ),
    }
  }

  if (body.kind === 'too-large') {
    return { ok: false, response: payloadTooLargeResponse() }
  }

  const parsedBody = body.kind === 'parsed' ? body.value : null
  const value = readBlockedDateFields(parsedBody)

  return value
    ? { ok: true, value }
    : { ok: false, response: invalidBlockedDateResponse() }
}

function readBlockedDateFields(
  parsedBody: unknown,
): ParsedBlockedDateBody | null {
  if (
    !isRecord(parsedBody) ||
    Object.keys(parsedBody).some((key) => !blockedDateBodyKeys.has(key)) ||
    typeof parsedBody.date !== 'string' ||
    !Object.prototype.hasOwnProperty.call(parsedBody, 'date')
  ) {
    return null
  }

  const reasonValue = parsedBody.reason

  if (
    reasonValue !== undefined &&
    reasonValue !== null &&
    typeof reasonValue !== 'string'
  ) {
    return null
  }

  const reason = typeof reasonValue === 'string' ? reasonValue.trim() : null

  if (
    reason !== null &&
    (reason.length > MAXIMUM_REASON_LENGTH || containsControlCharacter(reason))
  ) {
    return null
  }

  return {
    date: parsedBody.date,
    reason: reason || null,
  }
}

async function hasActiveBlockingBooking(
  env: Env,
  date: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `
      SELECT 1 AS found
      FROM booking_requests
      WHERE event_date = ?
        AND status IN (
          'approved_hold',
          'contract_pending',
          'contract_signed',
          'payment_pending',
          'confirmed'
        )
      LIMIT 1
    `,
  )
    .bind(date)
    .first<ExistenceRow>()

  return row !== null
}

async function handleBlockDate(
  request: Request,
  env: Env,
  admin: AuthenticatedAdmin,
): Promise<Response> {
  const parsedBody = await parseBlockedDateBody(request)

  if (!parsedBody.ok) {
    return parsedBody.response
  }

  const body = parsedBody.value

  if (!parseCalendarDate(body.date)) {
    return invalidDateResponse()
  }

  if (body.date < getRiyadhCalendarDate(new Date())) {
    return errorResponse(
      400,
      'PAST_DATE',
      'لا يمكن حجب تاريخ سابق لليوم.',
    )
  }

  if (await hasActiveBlockingBooking(env, body.date)) {
    return dateHasActiveBookingResponse()
  }

  const result = await env.DB.prepare(
    `
      INSERT INTO blocked_dates (
        event_date,
        reason,
        created_by
      )
      SELECT ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1
        FROM booking_requests
        WHERE event_date = ?
          AND status IN (
            'approved_hold',
            'contract_pending',
            'contract_signed',
            'payment_pending',
            'confirmed'
          )
      )
      ON CONFLICT(event_date) DO UPDATE SET
        reason = excluded.reason,
        created_by = excluded.created_by
    `,
  )
    .bind(body.date, body.reason, admin.uid, body.date)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    if (await hasActiveBlockingBooking(env, body.date)) {
      return dateHasActiveBookingResponse()
    }

    throw new Error('Blocked date persistence failed')
  }

  const savedDate = await env.DB.prepare(
    `
      SELECT
        event_date AS date,
        reason,
        created_by AS createdBy,
        created_at AS createdAt
      FROM blocked_dates
      WHERE event_date = ?
      LIMIT 1
    `,
  )
    .bind(body.date)
    .first<BlockedDateRow>()

  if (!savedDate) {
    throw new Error('Saved blocked date was not found')
  }

  const response: AdminBlockedDateResponse = {
    ok: true,
    blockedDate: toBlockedDate(savedDate),
  }

  return jsonResponse(response)
}

function parseBlockedDatePath(pathname: string): string | null {
  const match = /^\/api\/admin\/blocked-dates\/([^/]+)$/.exec(pathname)

  if (!match?.[1]) {
    return null
  }

  try {
    return decodeURIComponent(match[1])
  } catch (error) {
    if (error instanceof URIError) {
      return ''
    }

    throw error
  }
}

async function handleDeleteBlockedDate(
  env: Env,
  date: string,
): Promise<Response> {
  if (!parseCalendarDate(date)) {
    return invalidDateResponse()
  }

  const result = await env.DB.prepare(
    `
      DELETE FROM blocked_dates
      WHERE event_date = ?
    `,
  )
    .bind(date)
    .run()
  const response: AdminDeleteBlockedDateResponse = {
    ok: true,
    date,
    deleted: (result.meta.changes ?? 0) > 0,
  }

  return jsonResponse(response)
}

function adminNotFoundResponse(): Response {
  return errorResponse(
    404,
    'NOT_FOUND',
    'مسار API الإداري غير موجود.',
  )
}

/**
 * A request without a valid token answers 401 UNAUTHENTICATED on the admin
 * surface; every other refusal of authorizeAdminRequest (admin-auth.ts)
 * passes through with its own status and code.
 */
function normalizedAdminAuthorizationError(
  failure: AdminAuthorizationFailure,
  response: Response,
): Response {
  if (failure === 'unauthenticated') {
    return errorResponse(
      401,
      'UNAUTHENTICATED',
      'يجب تسجيل الدخول للوصول إلى لوحة الإدارة.',
      {
        'WWW-Authenticate': 'Bearer',
      },
    )
  }

  return response
}

/**
 * The address a status email may go to (audit SEC-04 fix 4): the customer's
 * stored email only while it is proven (email_verified_at) and not erased.
 */
async function loadVerifiedCustomerRecipient(
  env: Env,
  bookingId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `
      SELECT u.email AS email
      FROM booking_requests AS b
      INNER JOIN users AS u ON u.id = b.user_id
      WHERE b.id = ?
        AND u.email_verified_at IS NOT NULL
        AND u.erased_at IS NULL
      LIMIT 1
    `,
  )
    .bind(bookingId)
    .first<VerifiedRecipientRow>()

  return row?.email ?? null
}

/**
 * Where the status email of this booking goes, decided before the action is
 * answered: null when it is not sent. A skip for want of a proven address
 * (every row from before migration 0007 until its owner signs in again) is
 * logged with a fixed code and reported as `customerEmailQueued: false`.
 */
async function resolveStatusEmailRecipient(
  env: Env,
  bookingId: string,
): Promise<string | null> {
  if (!buildMyBookingsUrl(env.APP_BASE_URL)) {
    return null
  }

  try {
    const recipient = await loadVerifiedCustomerRecipient(env, bookingId)

    if (recipient === null) {
      console.warn(
        'BOOKING_STATUS_NOTIFICATION_SKIPPED code=NO_VERIFIED_RECIPIENT',
      )
    }

    return recipient
  } catch (error) {
    // The action is already committed; a failed lookup only costs the email.
    if (error instanceof Error) {
      console.error('BOOKING_STATUS_NOTIFICATION_FAILED')

      return null
    }

    throw error
  }
}

async function deliverBookingStatusNotification(
  env: Env,
  booking: AdminBookingDetail,
  recipient: string,
  previousStatus: BookingStatus,
  newStatus: BookingStatus,
): Promise<void> {
  try {
    const myBookingsUrl = buildMyBookingsUrl(env.APP_BASE_URL)

    if (!myBookingsUrl) {
      return
    }

    const template = renderCustomerBookingStatusTemplate({
      customerFirstName: booking.customer.firstName,
      bookingReference: booking.id,
      eventDate: booking.eventDate,
      previousStatus,
      newStatus,
      myBookingsUrl,
    })
    const deliveryResult = await sendEmail(env, {
      to: recipient,
      ...template,
      idempotencyKey:
        `booking-status:${booking.id}:${previousStatus}:${newStatus}`,
    })

    if (deliveryResult.status === 'failed') {
      console.error('BOOKING_STATUS_NOTIFICATION_FAILED')
    }
  } catch (error) {
    // The action is already committed; a failed send only costs the email.
    if (error instanceof Error) {
      console.error('BOOKING_STATUS_NOTIFICATION_FAILED')

      return
    }

    throw error
  }
}

/** True when the email was handed to waitUntil. */
function scheduleBookingStatusNotification(
  ctx: ExecutionContext,
  env: Env,
  booking: AdminBookingDetail,
  recipient: string,
  previousStatus: BookingStatus,
  newStatus: BookingStatus,
): boolean {
  try {
    ctx.waitUntil(
      deliverBookingStatusNotification(
        env,
        booking,
        recipient,
        previousStatus,
        newStatus,
      ),
    )

    return true
  } catch (error) {
    if (error instanceof Error) {
      console.error('BOOKING_STATUS_NOTIFICATION_FAILED')

      return false
    }

    throw error
  }
}

export async function handleAdminRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  const authorization = await authorizeAdminRequest(request, env)

  if (!authorization.ok) {
    return normalizedAdminAuthorizationError(
      authorization.failure,
      authorization.response,
    )
  }

  if (url.pathname === '/api/admin/bookings') {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse(['GET'])
    }

    return handleBookingList(env, url)
  }

  const bookingSubresource = parseBookingSubresourcePath(url.pathname)

  if (bookingSubresource) {
    const allowedMethod =
      bookingSubresource.resource === 'actions' ? 'POST' : 'PATCH'

    if (request.method !== allowedMethod) {
      return methodNotAllowedResponse([allowedMethod])
    }

    // A malformed id in the path is the path's fault, not the body's.
    if (!bookingSubresource.bookingId) {
      return invalidBookingIdResponse()
    }

    if (bookingSubresource.resource === 'actions') {
      const result = await performAdminBookingAction(
        request,
        env,
        authorization.admin,
        bookingSubresource.bookingId,
      )

      if (!result.ok) {
        return result.response
      }

      const booking = await loadAdminBookingDetail(
        env,
        result.bookingId,
      )

      if (!booking) {
        return bookingNotFoundResponse()
      }

      const recipient = await resolveStatusEmailRecipient(env, booking.id)
      const customerEmailQueued =
        recipient !== null &&
        scheduleBookingStatusNotification(
          ctx,
          env,
          booking,
          recipient,
          result.previousStatus,
          result.newStatus,
        )
      const response: AdminBookingActionResult = {
        ok: true,
        booking,
        allowedActions: booking.allowedActions,
        customerEmailQueued,
      }

      return jsonResponse(response)
    }

    const result = await updateAdminBookingNotes(
      request,
      env,
      bookingSubresource.bookingId,
    )

    return result.ok
      ? jsonResponse(result.responseBody)
      : result.response
  }

  const bookingId = parseBookingId(url.pathname)

  if (bookingId !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowedResponse(['GET'])
    }

    if (!bookingId) {
      return invalidBookingIdResponse()
    }

    return handleBookingDetail(env, bookingId)
  }

  if (url.pathname === '/api/admin/blocked-dates') {
    if (request.method === 'GET') {
      return handleBlockedDateList(env, url)
    }

    if (request.method === 'POST') {
      return handleBlockDate(request, env, authorization.admin)
    }

    return methodNotAllowedResponse(['GET', 'POST'])
  }

  const blockedDate = parseBlockedDatePath(url.pathname)

  if (blockedDate !== null) {
    if (request.method !== 'DELETE') {
      return methodNotAllowedResponse(['DELETE'])
    }

    return handleDeleteBlockedDate(env, blockedDate)
  }

  return adminNotFoundResponse()
}