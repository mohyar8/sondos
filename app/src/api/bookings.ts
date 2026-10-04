import { bookingStatuses, type BookingStatus } from '../../shared/admin'
import {
  isBookingPackageSnapshot,
  type BookingPackageSnapshot,
  type BookingSelectionInput,
} from '../../shared/booking'
import {
  isFlowVersion,
  isIsoInstant,
  isJourneyStageId,
  isJourneySubState,
  journeyStageLabels,
  parseJourneyDeadline,
  type FlowVersion,
  type JourneyDeadline,
  type JourneyStageId,
  type JourneySubState,
} from '../../shared/journey'
import {
  retryAfterReauthentication,
  type ApiSession,
} from '../lib/api-client'
import { serverLimitCodeForStatus } from '../lib/server-error-messages'

/** GET /api/bookings/me never returns more rows than this. */
const MAXIMUM_MY_BOOKINGS = 50
const MAXIMUM_STAGE_LABEL_LENGTH = 120

export type CreateBookingApiErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_EVENT_DATE'
  | 'INVALID_BOOKING_SELECTION'
  | 'UNAUTHORIZED'
  | 'PROFILE_REQUIRED'
  | 'DATE_UNAVAILABLE'
  | 'DUPLICATE_BOOKING_REQUEST'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL_ERROR'
  /** 409: she already has the most open requests one account may have. */
  | 'TOO_MANY_OPEN_REQUESTS'
  /** 400: the date is past the booking horizon (shared/timing.ts). */
  | 'BOOKING_TOO_FAR_AHEAD'
  /** 429: the Worker's rate limit. */
  | 'RATE_LIMITED'
  /** 413: the body is over the Worker's byte cap. */
  | 'PAYLOAD_TOO_LARGE'
  /** 403: the browse-only preview accepts no bookings. */
  | 'PREVIEW_READ_ONLY'
  /** 401: a recent sign-in is required and she did not confirm it. */
  | 'REAUTH_REQUIRED'
  /** 410: the account's data was erased at her request (final). */
  | 'ACCOUNT_ERASED'
  /**
   * 409: her verified address could not be bound to her account, because
   * another account already holds it (SEC-04). Retrying cannot change it.
   */
  | 'EMAIL_ALREADY_IN_USE'
  | 'NETWORK_ERROR'
  | 'MALFORMED_RESPONSE'

export interface CreatedBooking {
  id: string
  eventDate: string
  status: 'pending_review'
  estimatedTotal: number
  createdAt: string
}

export type CreateBookingResult =
  | {
      ok: true
      booking: CreatedBooking
    }
  | {
      ok: false
      error: {
        code: CreateBookingApiErrorCode
      }
    }

/** The one status list lives in shared/admin.ts; this alias keeps old imports working. */
export const customerBookingStatuses = bookingStatuses

export type CustomerBookingStatus = BookingStatus

export interface CustomerBooking {
  id: string
  eventDate: string
  status: CustomerBookingStatus
  estimatedTotal: number
  /** null when the stored snapshot is missing or not readable by this client. */
  packageSnapshot: BookingPackageSnapshot | null
  holdExpiresAt: string | null
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
  /**
   * Journey fields (Run 3, additive). Each is null when the server predates
   * it or sent a value this client does not recognise; the card then renders
   * from `status` exactly as before.
   */
  flowVersion: FlowVersion | null
  /** Her current stage (shared/journey.ts), or null (legacy/terminal/unknown). */
  stage: JourneyStageId | null
  /** Arabic label: this client's own for a known stage, else the server's. */
  stageLabel: string | null
  stageSubState: JourneySubState | null
  /** Typed by the stage: an ISO instant, or a Riyadh date at stages 5–6. */
  stageDeadline: JourneyDeadline | null
  depositAmount: number | null
}

export interface MyBookingsResponse {
  ok: true
  bookings: CustomerBooking[]
  /** The server's clock when it answered (ISO), or null from an older server. */
  serverTime: string | null
  /**
   * `serverTime` minus this device's clock when the response arrived, in ms.
   * A countdown uses `Date.now() + serverClockOffsetMs` as "now".
   */
  serverClockOffsetMs: number | null
}

/** Some rows failed validation and were left out; the rest are usable. */
export interface MyBookingsPartialError {
  code: 'INVALID_BOOKING_ROWS'
  skippedCount: number
}

export type MyBookingsApiErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  /** 410: the account's data was erased at her request (final). */
  | 'ACCOUNT_ERASED'
  | 'NETWORK_ERROR'
  | 'INTERNAL_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'ABORTED'

export type MyBookingsResult =
  | {
      ok: true
      data: MyBookingsResponse
      partialError: MyBookingsPartialError | null
    }
  | {
      ok: false
      error: {
        code: MyBookingsApiErrorCode
      }
    }

interface CreateBookingRequest {
  eventDate: string
  selection: BookingSelectionInput
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
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

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64
  )
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value)
}

function isCreatedBooking(value: unknown): value is CreatedBooking {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    isCalendarDate(value.eventDate) &&
    value.status === 'pending_review' &&
    typeof value.estimatedTotal === 'number' &&
    Number.isSafeInteger(value.estimatedTotal) &&
    value.estimatedTotal >= 0 &&
    isTimestamp(value.createdAt)
  )
}

function isCustomerBookingStatus(
  value: unknown,
): value is CustomerBookingStatus {
  return customerBookingStatuses.some((status) => status === value)
}

function isBookingId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readStageLabel(stage: JourneyStageId | null, value: unknown): string | null {
  if (stage !== null) {
    return journeyStageLabels[stage]
  }

  // A stage this client does not know yet: show the server's label, if sane.
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAXIMUM_STAGE_LABEL_LENGTH
    ? value
    : null
}

/**
 * Validates one row. The pre-Run-3 fields are required (null = skip the
 * row); the journey fields and the package snapshot degrade to null on their
 * own, so an older or newer server never costs her the whole list.
 */
function parseCustomerBooking(value: unknown): CustomerBooking | null {
  if (!isRecord(value)) {
    return null
  }

  const {
    id,
    eventDate,
    status,
    estimatedTotal,
    packageSnapshot,
    holdExpiresAt,
    confirmedAt,
    createdAt,
    updatedAt,
  } = value

  if (
    !isBookingId(id) ||
    !isCalendarDate(eventDate) ||
    !isCustomerBookingStatus(status) ||
    !isNonNegativeSafeInteger(estimatedTotal) ||
    !isNullableTimestamp(holdExpiresAt) ||
    !isNullableTimestamp(confirmedAt) ||
    !isTimestamp(createdAt) ||
    !isTimestamp(updatedAt)
  ) {
    return null
  }

  const stage = isJourneyStageId(value.stage) ? value.stage : null

  return {
    id,
    eventDate,
    status,
    estimatedTotal,
    packageSnapshot: isBookingPackageSnapshot(packageSnapshot)
      ? packageSnapshot
      : null,
    holdExpiresAt,
    confirmedAt,
    createdAt,
    updatedAt,
    flowVersion: isFlowVersion(value.flowVersion) ? value.flowVersion : null,
    stage,
    stageLabel: readStageLabel(stage, value.stageLabel),
    stageSubState:
      stage !== null && isJourneySubState(value.stageSubState)
        ? value.stageSubState
        : null,
    stageDeadline:
      stage === null ? null : parseJourneyDeadline(stage, value.stageDeadline),
    depositAmount: isNonNegativeSafeInteger(value.depositAmount)
      ? value.depositAmount
      : null,
  }
}

interface ParsedMyBookings {
  response: MyBookingsResponse
  skippedCount: number
}

/**
 * Validates the envelope strictly (ok flag, array, the 50-row cap) and each
 * row on its own: a bad or duplicated row is skipped and counted instead of
 * failing the whole list.
 */
function parseMyBookingsResponse(
  value: unknown,
  receivedAtMs: number,
): ParsedMyBookings | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Array.isArray(value.bookings) ||
    value.bookings.length > MAXIMUM_MY_BOOKINGS
  ) {
    return null
  }

  const items: readonly unknown[] = value.bookings
  const bookings: CustomerBooking[] = []
  const seenIds = new Set<string>()
  let skippedCount = 0

  for (const item of items) {
    const booking = parseCustomerBooking(item)

    if (booking === null || seenIds.has(booking.id)) {
      skippedCount += 1
      continue
    }

    seenIds.add(booking.id)
    bookings.push(booking)
  }

  const serverTimeMs = isIsoInstant(value.serverTime)
    ? new Date(value.serverTime).getTime()
    : null

  return {
    response: {
      ok: true,
      bookings,
      serverTime:
        serverTimeMs === null ? null : new Date(serverTimeMs).toISOString(),
      serverClockOffsetMs:
        serverTimeMs === null ? null : serverTimeMs - receivedAtMs,
    },
    skippedCount,
  }
}

/** GET /api/bookings/me as read through src/lib/api-client.ts. */
export interface MyBookingsData {
  response: MyBookingsResponse
  partialError: MyBookingsPartialError | null
}

function toMyBookingsData(parsed: ParsedMyBookings): MyBookingsData {
  return {
    response: parsed.response,
    partialError:
      parsed.skippedCount > 0
        ? { code: 'INVALID_BOOKING_ROWS', skippedCount: parsed.skippedCount }
        : null,
  }
}

/**
 * The `parse` option for `apiClient.request({ path: '/api/bookings/me' })`:
 * the same strict envelope check and per-row validation as getMyBookings,
 * or null (→ MALFORMED_RESPONSE). `receivedAtMs` is the api-client's
 * `meta.receivedAtMs`, used for the server-clock offset.
 */
export function parseMyBookingsBody(
  body: Readonly<Record<string, unknown>>,
  receivedAtMs: number,
): MyBookingsData | null {
  const parsed = parseMyBookingsResponse(body, receivedAtMs)
  return parsed === null ? null : toMyBookingsData(parsed)
}

function isServerErrorCode(
  value: unknown,
): value is Exclude<
  CreateBookingApiErrorCode,
  'NETWORK_ERROR' | 'MALFORMED_RESPONSE'
> {
  switch (value) {
    case 'INVALID_JSON':
    case 'INVALID_EVENT_DATE':
    case 'INVALID_BOOKING_SELECTION':
    case 'UNAUTHORIZED':
    case 'PROFILE_REQUIRED':
    case 'DATE_UNAVAILABLE':
    case 'DUPLICATE_BOOKING_REQUEST':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'INTERNAL_ERROR':
    case 'TOO_MANY_OPEN_REQUESTS':
    case 'BOOKING_TOO_FAR_AHEAD':
    case 'RATE_LIMITED':
    case 'PAYLOAD_TOO_LARGE':
    case 'PREVIEW_READ_ONLY':
    case 'REAUTH_REQUIRED':
    case 'ACCOUNT_ERASED':
    case 'EMAIL_ALREADY_IN_USE':
      return true
    default:
      return false
  }
}

function getServerErrorCode(value: unknown): CreateBookingApiErrorCode | null {
  if (
    !isRecord(value) ||
    value.ok !== false ||
    !isRecord(value.error) ||
    !isServerErrorCode(value.error.code)
  ) {
    return null
  }

  return value.error.code
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

/**
 * POST /api/bookings. With a `session`, a 401 REAUTH_REQUIRED asks for her
 * password and sends the request once more with a fresh token (the Worker
 * refuses before it creates anything, so the retry cannot book twice).
 */
export async function createBookingRequest(
  token: string,
  eventDate: string,
  selection: BookingSelectionInput,
  session?: ApiSession,
): Promise<CreateBookingResult> {
  let nextToken: string | null = token

  return retryAfterReauthentication(
    async () => {
      // The first attempt uses the caller's token; the retry a fresh one.
      const attemptToken = nextToken ?? (await session?.getIdToken()) ?? ''

      nextToken = null

      return sendBookingRequest(attemptToken, eventDate, selection)
    },
    (result) => !result.ok && result.error.code === 'REAUTH_REQUIRED',
    session?.requestReauthentication,
  )
}

async function sendBookingRequest(
  token: string,
  eventDate: string,
  selection: BookingSelectionInput,
): Promise<CreateBookingResult> {
  if (token.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
      },
    }
  }

  const requestBody: CreateBookingRequest = {
    eventDate,
    selection,
  }

  try {
    const response = await fetch('/api/bookings', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      cache: 'no-store',
    })
    const responseBody = await readJsonResponse(response)

    if (response.ok) {
      if (
        response.status !== 201 ||
        !isRecord(responseBody) ||
        responseBody.ok !== true ||
        !isCreatedBooking(responseBody.booking)
      ) {
        return {
          ok: false,
          error: {
            code: 'MALFORMED_RESPONSE',
          },
        }
      }

      return {
        ok: true,
        booking: responseBody.booking,
      }
    }

    // A platform 413/429 page carries no envelope; its status still names it.
    const errorCode =
      getServerErrorCode(responseBody) ??
      serverLimitCodeForStatus(response.status)

    return {
      ok: false,
      error: {
        code: errorCode ?? 'MALFORMED_RESPONSE',
      },
    }
  } catch {
    return {
      ok: false,
      error: {
        code: 'NETWORK_ERROR',
      },
    }
  }
}

export async function getMyBookings(
  token: string,
  signal?: AbortSignal,
): Promise<MyBookingsResult> {
  if (token.trim().length === 0) {
    return {
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
      },
    }
  }

  try {
    const response = await fetch('/api/bookings/me', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      signal,
    })
    const receivedAtMs = Date.now()
    const responseBody = await readJsonResponse(response)

    if (response.ok) {
      const parsed =
        response.status === 200
          ? parseMyBookingsResponse(responseBody, receivedAtMs)
          : null

      if (parsed === null) {
        return {
          ok: false,
          error: {
            code: 'MALFORMED_RESPONSE',
          },
        }
      }

      const { response: data, partialError } = toMyBookingsData(parsed)

      return {
        ok: true,
        data,
        partialError,
      }
    }

    if (response.status === 401) {
      return {
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
        },
      }
    }

    if (response.status === 403) {
      return {
        ok: false,
        error: {
          code: 'FORBIDDEN',
        },
      }
    }

    if (response.status === 410) {
      return {
        ok: false,
        error: {
          code: 'ACCOUNT_ERASED',
        },
      }
    }

    return {
      ok: false,
      error: {
        code:
          response.status >= 500
            ? 'INTERNAL_ERROR'
            : 'MALFORMED_RESPONSE',
      },
    }
  } catch {
    return {
      ok: false,
      error: {
        code: signal?.aborted ? 'ABORTED' : 'NETWORK_ERROR',
      },
    }
  }
}