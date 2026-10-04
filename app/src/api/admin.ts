import {
  adminBookingActions,
  bookingStatuses,
  type AdminBookingAction,
  type AdminBookingActionRequest,
  type AdminBookingActionResponse,
  type AdminBookingDetail,
  type AdminBookingDetailResponse,
  type AdminBookingFilters,
  type AdminBookingNotesRequest,
  type AdminBookingNotesResponse,
  type AdminBookingStatusHistoryEntry,
  type AdminBookingSummary,
  type AdminBookingsResponse,
  type AdminBlockedDate,
  type AdminBlockedDateResponse,
  type AdminBlockedDatesResponse,
  type AdminCustomer,
  type AdminDeleteBlockedDateResponse,
  type BookingStatus,
} from '../../shared/admin'
import {
  isBookingPackageSnapshot,
  type BookingCalculationBreakdown,
} from '../../shared/booking'
import {
  readIdToken,
  retryAfterReauthentication,
  sendJsonWithToken,
  type ApiPath,
  type ApiSession,
} from '../lib/api-client'
import {
  isServerLimitCode,
  serverLimitCodeForStatus,
  serverLimitMessages,
  toCurrentServerErrorCode,
} from '../lib/server-error-messages'

export interface AdminBookingListFilters {
  status?: BookingStatus
  from?: string
  to?: string
  limit?: number
  /**
   * The `nextCursor` of the previous page, passed back unchanged, with the
   * same status/from/to/limit as that page.
   */
  cursor?: string
}

export interface AdminBlockedDateInput {
  date: string
  reason: string
}

/**
 * POST /api/admin/bookings/:id/actions as this client reads it.
 * `customerEmailQueued` (additive, worker/admin.ts): false when no status
 * email to the customer was scheduled (her address was never proven by a
 * verified sign-in, her data was erased, or email is not configured), so the
 * owner is told to reach her another way; null from a Worker that predates
 * the field.
 */
export interface AdminBookingActionOutcome extends AdminBookingActionResponse {
  customerEmailQueued: boolean | null
}

/**
 * `unauthenticated` is a 401 (the session is gone: offer sign-in) or, with
 * the code REAUTH_REQUIRED, a sign-in that is too old for the route (403 in
 * plan 11 §3.1, 401 from a Wave 0 Worker) that she did not confirm.
 */
export type AdminApiErrorKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'invalid-request'
  | 'network'
  | 'server'
  | 'malformed-response'
  | 'aborted'

export interface AdminApiError {
  kind: AdminApiErrorKind
  /**
   * The Worker's code, a Wave 0 name read as the plan's (ADMIN_MFA_REQUIRED
   * as SECOND_FACTOR_REQUIRED); or this module's own INVALID_* code.
   */
  code: string | null
}

export type AdminApiResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: AdminApiError
    }

/**
 * Lets an admin request recover from REAUTH_REQUIRED (the Worker's 12-hour
 * admin sign-in limit, or a route that needs a sign-in ≤ 10 minutes old).
 * Optional on every call; without it REAUTH_REQUIRED is returned as it is.
 */
export type AdminSession = ApiSession

/**
 * 403: the action needs the authenticator-app sign-in (plan 11 §3.1). A
 * Wave 0 Worker's ADMIN_MFA_REQUIRED arrives under this code too.
 */
export const SECOND_FACTOR_REQUIRED_CODE = 'SECOND_FACTOR_REQUIRED'

/** Wave 0 name of SECOND_FACTOR_REQUIRED_CODE, kept for existing callers. */
export const ADMIN_MFA_REQUIRED_CODE = SECOND_FACTOR_REQUIRED_CODE

/**
 * Her wording for SECOND_FACTOR_REQUIRED on an action or a save (the one
 * table in lib/server-error-messages.ts). The «أمان الحساب» tab
 * (AdminSecurityPanel) adds the authenticator app and, once one is
 * enrolled, confirms her identity with it for the current session.
 */
export const ADMIN_MFA_REQUIRED_MESSAGE =
  serverLimitMessages[SECOND_FACTOR_REQUIRED_CODE]

/**
 * Her wording for a Worker limit (rate limit, body cap, browse-only preview,
 * a declined re-authentication, a missing second factor), or null for any
 * other error.
 */
export function getAdminLimitMessage(error: AdminApiError): string | null {
  return isServerLimitCode(error.code) ? serverLimitMessages[error.code] : null
}

interface AdminApiRequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?:
    | AdminBookingActionRequest
    | AdminBookingNotesRequest
    | AdminBlockedDateInput
  signal?: AbortSignal
}

const MAXIMUM_ERROR_CODE_LENGTH = 80
/** Same ceiling as the Worker's; a real cursor is about 80 characters. */
const MAXIMUM_BOOKING_CURSOR_LENGTH = 1_024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shape check only: the cursor is opaque, the Worker validates its content. */
function isBookingListCursor(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAXIMUM_BOOKING_CURSOR_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  )
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isSafeAmount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return (
    typeof value === 'string' &&
    bookingStatuses.some((status) => status === value)
  )
}

/**
 * The actions this bundle knows, in the Worker's order, each once. An entry
 * it does not know (an action shipped after this tab loaded its bundle, L1)
 * is skipped, never an error: the booking still opens, just without a
 * button for the new action. Null only when the list itself is missing.
 */
function readAllowedActions(value: unknown): AdminBookingAction[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const entries: readonly unknown[] = value
  const actions: AdminBookingAction[] = []

  for (const entry of entries) {
    const action = adminBookingActions.find((known) => known === entry)

    if (action !== undefined && !actions.includes(action)) {
      actions.push(action)
    }
  }

  return actions
}

function isAdminCustomer(value: unknown): value is AdminCustomer {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.firstName === 'string' &&
    typeof value.lastName === 'string' &&
    typeof value.email === 'string' &&
    typeof value.phone === 'string'
  )
}

function isAdminBookingSummary(
  value: unknown,
): value is AdminBookingSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.eventDate === 'string' &&
    isBookingStatus(value.status) &&
    isNullableString(value.packageName) &&
    isSafeAmount(value.estimatedTotal) &&
    isAdminCustomer(value.customer) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

function isAdminBookingFilters(
  value: unknown,
): value is AdminBookingFilters {
  if (
    !isRecord(value) ||
    typeof value.limit !== 'number' ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > 100
  ) {
    return false
  }

  return (
    (value.status === undefined || isBookingStatus(value.status)) &&
    (value.from === undefined || typeof value.from === 'string') &&
    (value.to === undefined || typeof value.to === 'string')
  )
}

function isBookingCalculationBreakdown(
  value: unknown,
): value is BookingCalculationBreakdown {
  return (
    isRecord(value) &&
    isSafeAmount(value.coverage) &&
    isSafeAmount(value.album) &&
    isSafeAmount(value.albumBoxUpgrade) &&
    isSafeAmount(value.individualPrints) &&
    isSafeAmount(value.magazines) &&
    isSafeAmount(value.woodenEnlargements)
  )
}

function isStatusHistoryEntry(
  value: unknown,
): value is AdminBookingStatusHistoryEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    (value.fromStatus === null || isBookingStatus(value.fromStatus)) &&
    isBookingStatus(value.toStatus) &&
    isNullableString(value.changedBy) &&
    isNullableString(value.note) &&
    typeof value.createdAt === 'string'
  )
}

/**
 * GET /api/admin/bookings/{id} `booking`, rebuilt from the fields this
 * bundle knows: `allowedActions` keeps only known actions (L1), and fields
 * a newer Worker adds (plan 11 #17) are left out until a parser reads them.
 */
function parseAdminBookingDetail(value: unknown): AdminBookingDetail | null {
  if (!isRecord(value) || !isAdminBookingSummary(value)) {
    return null
  }

  const allowedActions = readAllowedActions(value.allowedActions)
  const {
    packageSnapshot,
    priceBreakdown,
    adminNotes,
    holdExpiresAt,
    confirmedAt,
    statusHistory,
  } = value

  if (
    allowedActions === null ||
    !(packageSnapshot === null || isBookingPackageSnapshot(packageSnapshot)) ||
    !(
      priceBreakdown === null || isBookingCalculationBreakdown(priceBreakdown)
    ) ||
    !isNullableString(adminNotes) ||
    !isNullableString(holdExpiresAt) ||
    !isNullableString(confirmedAt) ||
    !Array.isArray(statusHistory)
  ) {
    return null
  }

  const historyEntries: readonly unknown[] = statusHistory

  if (!historyEntries.every(isStatusHistoryEntry)) {
    return null
  }

  return {
    id: value.id,
    eventDate: value.eventDate,
    status: value.status,
    allowedActions,
    packageName: value.packageName,
    estimatedTotal: value.estimatedTotal,
    packageSnapshot,
    priceBreakdown,
    adminNotes,
    holdExpiresAt,
    confirmedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    customer: value.customer,
    statusHistory: [...historyEntries],
  }
}

function isAdminBookingsResponse(
  value: unknown,
): value is AdminBookingsResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isAdminBookingFilters(value.filters) &&
    Array.isArray(value.bookings) &&
    value.bookings.every(isAdminBookingSummary) &&
    // Absent on a response from before pagination: read as "no more pages".
    (value.nextCursor === undefined ||
      value.nextCursor === null ||
      isBookingListCursor(value.nextCursor))
  )
}

function parseAdminBookingDetailResponse(
  value: unknown,
): AdminBookingDetailResponse | null {
  if (!isRecord(value) || value.ok !== true) {
    return null
  }

  const booking = parseAdminBookingDetail(value.booking)

  return booking === null ? null : { ok: true, booking }
}

/**
 * POST …/actions: the booking as parseAdminBookingDetail reads it, the
 * top-level `allowedActions` likewise (unknown actions skipped, L1), and
 * the additive `customerEmailQueued` (null from a Worker without it).
 */
function parseAdminBookingActionResponse(
  value: unknown,
): AdminBookingActionOutcome | null {
  if (!isRecord(value) || value.ok !== true) {
    return null
  }

  const booking = parseAdminBookingDetail(value.booking)
  const allowedActions = readAllowedActions(value.allowedActions)
  const { customerEmailQueued } = value

  if (
    booking === null ||
    allowedActions === null ||
    !(
      customerEmailQueued === undefined ||
      typeof customerEmailQueued === 'boolean'
    )
  ) {
    return null
  }

  return {
    ok: true,
    booking,
    allowedActions,
    customerEmailQueued: customerEmailQueued ?? null,
  }
}

function isAdminBookingNotesResponse(
  value: unknown,
): value is AdminBookingNotesResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.bookingId === 'string' &&
    value.bookingId.length > 0 &&
    isNullableString(value.adminNotes) &&
    typeof value.updatedAt === 'string' &&
    value.updatedAt.length > 0
  )
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)

  if (year < 1) {
    return false
  }

  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function isAdminBlockedDate(value: unknown): value is AdminBlockedDate {
  return (
    isRecord(value) &&
    typeof value.date === 'string' &&
    isCalendarDate(value.date) &&
    isNullableString(value.reason) &&
    isNullableString(value.createdBy) &&
    typeof value.createdAt === 'string'
  )
}

function isAdminBlockedDatesResponse(
  value: unknown,
): value is AdminBlockedDatesResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isRecord(value.range) &&
    typeof value.range.from === 'string' &&
    isCalendarDate(value.range.from) &&
    typeof value.range.to === 'string' &&
    isCalendarDate(value.range.to) &&
    Array.isArray(value.blockedDates) &&
    value.blockedDates.every(isAdminBlockedDate)
  )
}

function isAdminBlockedDateResponse(
  value: unknown,
): value is AdminBlockedDateResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isAdminBlockedDate(value.blockedDate)
  )
}

function isAdminDeleteBlockedDateResponse(
  value: unknown,
): value is AdminDeleteBlockedDateResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.date === 'string' &&
    isCalendarDate(value.date) &&
    typeof value.deleted === 'boolean'
  )
}

function getStructuredErrorCode(value: unknown): string | null {
  if (
    !isRecord(value) ||
    value.ok !== false ||
    !isRecord(value.error) ||
    typeof value.error.code !== 'string' ||
    value.error.code.length === 0 ||
    value.error.code.length > MAXIMUM_ERROR_CODE_LENGTH
  ) {
    return null
  }

  return toCurrentServerErrorCode(value.error.code)
}

function mapResponseError(
  status: number,
  structuredCode: string | null,
): AdminApiError {
  // A platform 413/429 page carries no envelope; its status still names it.
  const code = structuredCode ?? serverLimitCodeForStatus(status)

  // A 401 is a session that is gone. REAUTH_REQUIRED (403 in plan 11 §3.1,
  // 401 from a Wave 0 Worker) is the password prompt's case; callers find it
  // under `unauthenticated` with its code, as before.
  if (status === 401 || (status === 403 && code === 'REAUTH_REQUIRED')) {
    return { kind: 'unauthenticated', code }
  }

  if (status === 403) {
    return { kind: 'forbidden', code }
  }

  if (status === 404) {
    return { kind: 'not-found', code }
  }

  if (status === 409) {
    return { kind: 'conflict', code }
  }

  if (status >= 500) {
    return { kind: 'server', code }
  }

  return { kind: 'invalid-request', code }
}

function isReauthenticationRequired<T>(result: AdminApiResult<T>): boolean {
  return (
    !result.ok &&
    result.error.kind === 'unauthenticated' &&
    result.error.code === 'REAUTH_REQUIRED'
  )
}

function unauthenticatedResult<T>(): AdminApiResult<T> {
  return {
    ok: false,
    error: {
      kind: 'unauthenticated',
      code: 'UNAUTHENTICATED',
    },
  }
}

/**
 * One admin request; after a REAUTH_REQUIRED, and only with a `session`, it
 * asks for her password and sends it once more with a fresh token
 * (lib/api-client.ts, retryAfterReauthentication).
 */
async function requestAdminApi<T>(
  path: ApiPath,
  token: string,
  parse: (value: unknown) => T | null,
  options: AdminApiRequestOptions,
  session?: AdminSession,
): Promise<AdminApiResult<T>> {
  let nextToken: string | null = token

  return retryAfterReauthentication(
    async () => {
      // The first attempt uses the caller's token; the retry a fresh one.
      const attemptToken =
        nextToken ??
        (session === undefined ? null : await readIdToken(session.getIdToken))

      nextToken = null

      return attemptToken === null
        ? unauthenticatedResult<T>()
        : sendAdminRequest(path, attemptToken, parse, options)
    },
    isReauthenticationRequired,
    session?.requestReauthentication,
    options.signal,
  )
}

/**
 * Sent through lib/api-client.ts (same-origin `/api/` path, the token in
 * the header only, no redirects, nothing logged); the answer is mapped here.
 */
async function sendAdminRequest<T>(
  path: ApiPath,
  token: string,
  parse: (value: unknown) => T | null,
  options: AdminApiRequestOptions,
): Promise<AdminApiResult<T>> {
  const sent = await sendJsonWithToken(token, {
    method: options.method,
    path,
    body:
      options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })

  if (!sent.ok) {
    switch (sent.code) {
      case 'TOKEN_UNAVAILABLE':
        return unauthenticatedResult<T>()
      case 'INVALID_REQUEST':
        return {
          ok: false,
          error: { kind: 'invalid-request', code: 'INVALID_REQUEST_PATH' },
        }
      case 'ABORTED':
        return { ok: false, error: { kind: 'aborted', code: null } }
      case 'NETWORK_ERROR':
        return { ok: false, error: { kind: 'network', code: null } }
    }
  }

  if (sent.status < 200 || sent.status > 299) {
    return {
      ok: false,
      error: mapResponseError(sent.status, getStructuredErrorCode(sent.body)),
    }
  }

  const data = parse(sent.body)

  if (data === null) {
    return {
      ok: false,
      error: {
        kind: 'malformed-response',
        code: null,
      },
    }
  }

  return {
    ok: true,
    data,
  }
}

/** A type guard as a parser: the value itself when it matches, else null. */
function parseWith<T>(
  guard: (value: unknown) => value is T,
): (value: unknown) => T | null {
  return (value) => (guard(value) ? value : null)
}

export async function fetchAdminBookings(
  token: string,
  filters: AdminBookingListFilters = {},
  signal?: AbortSignal,
  session?: AdminSession,
): Promise<AdminApiResult<AdminBookingsResponse>> {
  const from = filters.from?.trim() ?? ''
  const to = filters.to?.trim() ?? ''

  if (
    (from !== '' && !isCalendarDate(from)) ||
    (to !== '' && !isCalendarDate(to)) ||
    (from !== '' && to !== '' && from > to)
  ) {
    return {
      ok: false,
      error: {
        kind: 'invalid-request',
        code: 'INVALID_DATE_RANGE',
      },
    }
  }

  const searchParams = new URLSearchParams()

  if (filters.status) {
    searchParams.set('status', filters.status)
  }

  if (from) {
    searchParams.set('from', from)
  }

  if (to) {
    searchParams.set('to', to)
  }

  searchParams.set('limit', String(filters.limit ?? 50))

  if (filters.cursor !== undefined) {
    if (!isBookingListCursor(filters.cursor)) {
      return {
        ok: false,
        error: {
          kind: 'invalid-request',
          code: 'INVALID_CURSOR',
        },
      }
    }

    searchParams.set('cursor', filters.cursor)
  }

  return requestAdminApi(
    `/api/admin/bookings?${searchParams.toString()}`,
    token,
    parseWith(isAdminBookingsResponse),
    {
      method: 'GET',
      signal,
    },
    session,
  )
}

export async function fetchAdminBookingDetail(
  token: string,
  bookingId: string,
  signal?: AbortSignal,
  session?: AdminSession,
): Promise<AdminApiResult<AdminBookingDetailResponse>> {
  if (bookingId.length === 0 || bookingId.length > 128) {
    return {
      ok: false,
      error: {
        kind: 'invalid-request',
        code: 'INVALID_BOOKING_ID',
      },
    }
  }

  return requestAdminApi(
    `/api/admin/bookings/${encodeURIComponent(bookingId)}`,
    token,
    parseAdminBookingDetailResponse,
    {
      method: 'GET',
      signal,
    },
    session,
  )
}

export async function performAdminBookingAction(
  token: string,
  bookingId: string,
  request: AdminBookingActionRequest,
  signal?: AbortSignal,
  session?: AdminSession,
): Promise<AdminApiResult<AdminBookingActionOutcome>> {
  if (bookingId.length === 0 || bookingId.length > 128) {
    return {
      ok: false,
      error: {
        kind: 'invalid-request',
        code: 'INVALID_BOOKING_ID',
      },
    }
  }

  return requestAdminApi(
    `/api/admin/bookings/${encodeURIComponent(bookingId)}/actions`,
    token,
    parseAdminBookingActionResponse,
    {
      method: 'POST',
      body: request,
      signal,
    },
    session,
  )
}

export async function updateAdminBookingNotes(
  token: string,
  bookingId: string,
  request: AdminBookingNotesRequest,
  signal?: AbortSignal,
  session?: AdminSession,
): Promise<AdminApiResult<AdminBookingNotesResponse>> {
  if (bookingId.length === 0 || bookingId.length > 128) {
    return {
      ok: false,
      error: {
        kind: 'invalid-request',
        code: 'INVALID_BOOKING_ID',
      },
    }
  }

  return requestAdminApi(
    `/api/admin/bookings/${encodeURIComponent(bookingId)}/notes`,
    token,
    parseWith(isAdminBookingNotesResponse),
    {
      method: 'PATCH',
      body: request,
      signal,
    },
    session,
  )
}

export async function getAdminBlockedDates(
  token: string,
  from: string,
  to: string,
  signal?: AbortSignal,
  session?: AdminSession,
): Promise<AdminApiResult<AdminBlockedDatesResponse>> {
  if (!isCalendarDate(from) || !isCalendarDate(to) || from > to) {
    return {
      ok: false,
      error: {
        kind: 'invalid-request',
        code: 'INVALID_DATE_RANGE',
      },
    }
  }

  const searchParams = new URLSearchParams({ from, to })

  return requestAdminApi(
    `/api/admin/blocked-dates?${searchParams.toString()}`,
    token,
    parseWith(isAdminBlockedDatesResponse),
    {
      method: 'GET',
      signal,
    },
    session,
  )
}

export async function saveAdminBlockedDate(
  token: string,
  input: AdminBlockedDateInput,
  signal?: AbortSignal,
  session?: AdminSession,
): Promise<AdminApiResult<AdminBlockedDateResponse>> {
  if (!isCalendarDate(input.date)) {
    return {
      ok: false,
      error: {
        kind: 'invalid-request',
        code: 'INVALID_DATE',
      },
    }
  }

  return requestAdminApi(
    '/api/admin/blocked-dates',
    token,
    parseWith(isAdminBlockedDateResponse),
    {
      method: 'POST',
      body: input,
      signal,
    },
    session,
  )
}

export async function deleteAdminBlockedDate(
  token: string,
  date: string,
  signal?: AbortSignal,
  session?: AdminSession,
): Promise<AdminApiResult<AdminDeleteBlockedDateResponse>> {
  if (!isCalendarDate(date)) {
    return {
      ok: false,
      error: {
        kind: 'invalid-request',
        code: 'INVALID_DATE',
      },
    }
  }

  return requestAdminApi(
    `/api/admin/blocked-dates/${encodeURIComponent(date)}`,
    token,
    parseWith(isAdminDeleteBlockedDateResponse),
    {
      method: 'DELETE',
      signal,
    },
    session,
  )
}