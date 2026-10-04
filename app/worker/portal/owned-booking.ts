import { bookingStatuses, type BookingStatus } from '../../shared/admin.js'
import { isFlowVersion, type FlowVersion } from '../../shared/journey.js'
import { errorResponse } from '../http.js'
import type { VerifiedCustomer } from './request.js'

/**
 * Central booking ownership for the customer portal (baseline C-16, threat
 * model TM-06, SB-20; 11 §3.1 auth model CO).
 *
 * The customer dispatcher (portal-routes.ts) calls resolveOwnedBooking ONCE
 * for every `/api/bookings/{bookingId}/...` route: after
 * requireVerifiedCustomer and before any handler code. The booking must
 * exist AND belong to the verified customer, in one query
 * (`WHERE id = ? AND user_id = ?`), so someone else's booking and a booking
 * that does not exist are the same miss. Both, and a malformed id, answer
 * bookingNotFoundResponse(): one function, so status, headers and body are
 * byte-identical and the answer is no existence oracle (N-04, N-36).
 *
 * The OwnedBooking a handler receives is a snapshot read before its own
 * statements run. It proves ownership and may pick a branch or a message;
 * it never replaces the checks inside a write. Every handler still binds
 * `booking_requests.user_id = ?` to `customer.uid` and re-checks status,
 * flow and deadline inside its own writing statement (SB-5, SB-20).
 *
 * D1 rows are a trust boundary: a row with an unexpected shape throws a
 * fixed code without any row data, which worker/index.ts answers with 500.
 */

/** A booking the dispatcher has proven belongs to the verified customer. */
export interface OwnedBooking {
  /** Exactly the id from the path (the value bound in the ownership query). */
  readonly id: string
  readonly status: BookingStatus
  /** 1 = legacy WhatsApp flow, 2 = online confirmation (migration 0005). */
  readonly flowVersion: FlowVersion
  /** `YYYY-MM-DD`, the event day. */
  readonly eventDate: string
  /** The hold deadline as stored (UTC instant), or null. */
  readonly holdExpiresAt: string | null
}

export type OwnedBookingResult =
  | {
      readonly ok: true
      readonly booking: OwnedBooking
    }
  | {
      readonly ok: false
      readonly response: Response
    }

/**
 * The one answer for a booking id the caller may not use: unknown,
 * someone else's, or malformed. Never 403.
 */
export function bookingNotFoundResponse(): Response {
  return errorResponse(
    404,
    'BOOKING_NOT_FOUND',
    'لم يتم العثور على طلب الحجز.',
  )
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return (
    typeof value === 'string' &&
    bookingStatuses.some((status) => status === value)
  )
}

function readOwnedBookingRow(
  row: Readonly<Record<string, unknown>>,
  bookingId: string,
): OwnedBooking {
  const { id, status, flowVersion, eventDate, holdExpiresAt } = row

  if (
    id !== bookingId ||
    !isBookingStatus(status) ||
    !isFlowVersion(flowVersion) ||
    typeof eventDate !== 'string' ||
    !(holdExpiresAt === null || typeof holdExpiresAt === 'string')
  ) {
    throw new Error('OWNED_BOOKING_ROW_INVALID')
  }

  return {
    id: bookingId,
    status,
    flowVersion,
    eventDate,
    holdExpiresAt,
  }
}

/**
 * The ownership check (TM-06): one primary-key read bound to the verified
 * customer's uid. Takes the VerifiedCustomer itself, not a bare uid, so the
 * bound owner can only come from a verified token. `bookingId` is the
 * decoded, bounded path parameter (portal-routes.ts decodePathParameter).
 */
export async function resolveOwnedBooking(
  db: D1Database,
  bookingId: string,
  customer: VerifiedCustomer,
): Promise<OwnedBookingResult> {
  const row = await db
    .prepare(
      `
        SELECT
          id,
          status,
          flow_version AS flowVersion,
          event_date AS eventDate,
          hold_expires_at AS holdExpiresAt
        FROM booking_requests
        WHERE id = ?
          AND user_id = ?
        LIMIT 1
      `,
    )
    .bind(bookingId, customer.uid)
    .first<Record<string, unknown>>()

  if (!row) {
    return { ok: false, response: bookingNotFoundResponse() }
  }

  return {
    ok: true,
    booking: readOwnedBookingRow(row, bookingId),
  }
}
