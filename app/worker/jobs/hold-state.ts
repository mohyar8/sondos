import { parseInstant } from '../../shared/timing.js'
import type { HoldOwedStep } from '../emails/hold.js'
import { ONLINE_CONFIRMATION_SWITCH_ON_SQL } from '../settings/settings-read.js'

/**
 * The flow-2 hold state that the hold-expiry and hold-reminders jobs share
 * (ADR-001 §2.1, §2.2; 06-data-model §4.2; plan 11 B1, H3, TM-15).
 *
 * She still owes a receipt while the booking is on flow 2 and it is either
 * `approved_hold`, or `payment_pending` with a REJECTED latest receipt. Only
 * those bookings expire and get reminders. A `payment_pending` booking whose
 * latest receipt is pending never expires, because the next move is the
 * admin's. Legacy flow-1 rows never match: their old `hold_expires_at` passed
 * long ago and they drain by hand.
 *
 * A hold is NOTICE-PROTECTED while a `deposit_notice_sent` event exists for
 * its CURRENT deadline (B1, UX-02, N-50): she has told us she transferred
 * the deposit, so no job ever expires it or reminds her again; the admin
 * confirms or cancels it from the queue's `decide_now` section. A notice
 * for an earlier deadline protects nothing, and a notice never moves the
 * deadline (N-19).
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

/**
 * NOTICE_PROTECTED (B1, N-50) on a booking_requests row aliased `b`: a
 * `deposit_notice_sent` event whose `details.holdExpiresAt` is a string
 * equal to the booking's current `hold_expires_at`. A constant: it contains
 * no values, so it can sit in any statement's WHERE clause (the cron, the
 * approve path's targeted sweep, the queue). Mirrored in JavaScript by
 * isNoticeForCurrentDeadline.
 */
export const NOTICE_PROTECTED_SQL = `
  EXISTS (
    SELECT 1
    FROM booking_events AS notice
    WHERE notice.booking_id = b.id
      AND notice.event = 'deposit_notice_sent'
      AND json_type(notice.details, '$.holdExpiresAt') = 'text'
      AND json_extract(notice.details, '$.holdExpiresAt') = b.hold_expires_at
  )`

/**
 * What the SYSTEM may expire on booking alias `b`, inside the writing
 * statement itself (TM-15): a flow-2 hold that still owes a receipt, is not
 * notice-protected, and while the D1 kill switch is on (H3). The caller adds
 * its own deadline condition and checks EM in the Worker first (AX = EM ∧
 * OCe, worker/settings/features.ts readHoldAutoExpiry), because the email
 * settings are not in D1.
 */
export const SYSTEM_EXPIRABLE_HOLD_SQL = `
  ${OWED_HOLD_PREDICATE_SQL}
  AND NOT ${NOTICE_PROTECTED_SQL}
  AND ${ONLINE_CONFIRMATION_SWITCH_ON_SQL}`

/** The latest receipt's status for booking alias `b`, as a selected column. */
export const LATEST_RECEIPT_STATUS_SQL = `(
    SELECT r.status
    FROM booking_receipts AS r
    WHERE r.booking_id = b.id
    ORDER BY r.attempt_no DESC
    LIMIT 1
  )`

/** NOTICE_PROTECTED for booking alias `b`, as a selected 0/1 column. */
export const NOTICE_PROTECTED_COLUMN_SQL = `CASE WHEN ${NOTICE_PROTECTED_SQL} THEN 1 ELSE 0 END`

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
  /** She accepted the booking terms (`terms_accepted_at` is set). */
  readonly termsAccepted: boolean
  /** A `deposit_notice_sent` event exists for this exact deadline (B1). */
  readonly noticeProtected: boolean
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
 * The JavaScript twin of NOTICE_PROTECTED_SQL for one notice: true only when
 * the notice's `holdExpiresAt` is exactly the current canonical deadline. A
 * notice for an earlier deadline, or a malformed one, protects nothing.
 */
export function isNoticeForCurrentDeadline(
  noticeHoldExpiresAt: unknown,
  currentHoldExpiresAt: unknown,
): boolean {
  return (
    isCanonicalInstant(currentHoldExpiresAt) &&
    typeof noticeHoldExpiresAt === 'string' &&
    noticeHoldExpiresAt === currentHoldExpiresAt
  )
}

/**
 * What she still owes for a booking in `status` whose latest receipt has
 * `latestReceiptStatus`, or null when she owes nothing right now. An
 * `approved_hold` owes the terms first, then the deposit receipt.
 */
export function owedStepFor(
  status: string,
  latestReceiptStatus: string | null,
  termsAccepted: boolean,
): HoldOwedStep | null {
  if (status === 'approved_hold') {
    return termsAccepted ? 'deposit_receipt' : 'accept_terms'
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

/** A 0/1 column; anything else (a missing column) is unusable. */
function readFlag(value: unknown): boolean | null {
  return value === 1 ? true : value === 0 ? false : null
}

/**
 * Reads the shared columns `id, flow_version, status, event_date,
 * hold_expires_at, terms_accepted_at, latest_receipt_status,
 * notice_protected, customer_email, customer_first_name`. Returns null for
 * anything that is not a flow-2 hold whose customer still owes a receipt,
 * or whose columns are missing or malformed, so a legacy row can never be
 * touched.
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
    terms_accepted_at: termsAcceptedAt,
    latest_receipt_status: latestReceiptStatus,
    notice_protected: noticeProtectedValue,
    customer_email: customerEmail,
    customer_first_name: customerFirstName,
  } = value
  const noticeProtected = readFlag(noticeProtectedValue)

  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > MAXIMUM_BOOKING_ID_LENGTH ||
    flowVersion !== 2 ||
    !isOwedHoldStatus(status) ||
    typeof eventDate !== 'string' ||
    !isCanonicalInstant(holdExpiresAt) ||
    (termsAcceptedAt !== null && !isCanonicalInstant(termsAcceptedAt)) ||
    (latestReceiptStatus !== null && typeof latestReceiptStatus !== 'string') ||
    noticeProtected === null
  ) {
    return null
  }

  const termsAccepted = termsAcceptedAt !== null
  const owedStep = owedStepFor(status, latestReceiptStatus, termsAccepted)

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
    termsAccepted,
    noticeProtected,
    customerEmail: readOptionalString(customerEmail),
    customerFirstName: readOptionalString(customerFirstName) ?? '',
  }
}
