import { parseInstant } from '../../shared/timing.js'
import type { HoldOwedStep } from '../emails/hold.js'

/**
 * The flow-2 hold state that the hold-expiry and hold-reminders jobs share
 * (ADR-001 §2.1, §2.2; 06-data-model §4.2).
 *
 * She still owes a receipt while the booking is on flow 2 and it is either
 * `approved_hold`, or `payment_pending` with a REJECTED latest receipt. Only
 * those bookings expire and get reminders. A `payment_pending` booking whose
 * latest receipt is pending never expires, because the next move is the
 * admin's. Legacy flow-1 rows never match: their old `hold_expires_at` passed
 * long ago and they drain by hand.
 *
 * Every selection is repeated in the SQL (bound values only) and in the row
 * reader below, so a row is only acted on when both agree.
 */

export const OWED_HOLD_STATUSES = ['approved_hold', 'payment_pending'] as const

export type OwedHoldStatus = (typeof OWED_HOLD_STATUSES)[number]

/**
 * SQL predicate for "a flow-2 booking whose customer still owes a receipt",
 * on a booking_requests row aliased `b`. A constant: it contains no values.
 * "Latest receipt" is the highest attempt_no (UNIQUE (booking_id, attempt_no)).
 */
export const OWED_HOLD_PREDICATE_SQL = `
  b.flow_version = 2
  AND (
    b.status = 'approved_hold'
    OR (
      b.status = 'payment_pending'
      AND (
        SELECT r.status
        FROM booking_receipts AS r
        WHERE r.booking_id = b.id
        ORDER BY r.attempt_no DESC
        LIMIT 1
      ) = 'rejected'
    )
  )`

/** The latest receipt's status for booking alias `b`, as a selected column. */
export const LATEST_RECEIPT_STATUS_SQL = `(
    SELECT r.status
    FROM booking_receipts AS r
    WHERE r.booking_id = b.id
    ORDER BY r.attempt_no DESC
    LIMIT 1
  )`

/** A flow-2 booking whose customer still owes a receipt, read from D1. */
export interface OwedHold {
  readonly bookingId: string
  readonly status: OwedHoldStatus
  readonly owedStep: HoldOwedStep
  /** Riyadh calendar date, `YYYY-MM-DD`. */
  readonly eventDate: string
  /** The deadline exactly as stored: a canonical `toISOString()` instant. */
  readonly holdExpiresAt: string
  readonly holdExpiresAtMs: number
  /**
   * Null when there is no address to write to: her data was erased, or the
   * stored address was never proven by a verified sign-in (audit SEC-04).
   */
  readonly customerEmail: string | null
  readonly customerFirstName: string
}

const MAXIMUM_BOOKING_ID_LENGTH = 64

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * True for an instant in the exact `YYYY-MM-DDTHH:MM:SS.sssZ` form the Worker
 * writes (and the 0005 CHECKs enforce), so string comparison in SQL agrees
 * with time order.
 */
export function isCanonicalInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    parseInstant(value)?.toISOString() === value
  )
}

/**
 * What she still owes for a booking in `status` whose latest receipt has
 * `latestReceiptStatus`, or null when she owes nothing right now.
 */
export function owedStepFor(
  status: string,
  latestReceiptStatus: string | null,
): HoldOwedStep | null {
  if (status === 'approved_hold') {
    return 'terms_and_receipt'
  }

  if (status === 'payment_pending' && latestReceiptStatus === 'rejected') {
    return 'new_receipt'
  }

  return null
}

function isOwedHoldStatus(value: unknown): value is OwedHoldStatus {
  return OWED_HOLD_STATUSES.some((status) => status === value)
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Reads the shared columns `id, flow_version, status, event_date,
 * hold_expires_at, latest_receipt_status, customer_email,
 * customer_first_name`. Returns null for anything that is not a flow-2 hold
 * whose customer still owes a receipt, so a legacy row can never be touched.
 */
export function readOwedHold(value: unknown): OwedHold | null {
  if (!isRecord(value)) {
    return null
  }

  const {
    id,
    flow_version: flowVersion,
    status,
    event_date: eventDate,
    hold_expires_at: holdExpiresAt,
    latest_receipt_status: latestReceiptStatus,
    customer_email: customerEmail,
    customer_first_name: customerFirstName,
  } = value

  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAXIMUM_BOOKING_ID_LENGTH ||
    flowVersion !== 2 ||
    !isOwedHoldStatus(status) ||
    typeof eventDate !== 'string' ||
    !isCanonicalInstant(holdExpiresAt) ||
    (latestReceiptStatus !== null && typeof latestReceiptStatus !== 'string')
  ) {
    return null
  }

  const owedStep = owedStepFor(status, latestReceiptStatus)

  if (owedStep === null) {
    return null
  }

  return {
    bookingId: id,
    status,
    owedStep,
    eventDate,
    holdExpiresAt,
    holdExpiresAtMs: Date.parse(holdExpiresAt),
    customerEmail: readOptionalString(customerEmail),
    customerFirstName: readOptionalString(customerFirstName) ?? '',
  }
}
