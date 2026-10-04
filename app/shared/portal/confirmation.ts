import type { BookingStatus } from '../admin.js'
import type { JourneyReceiptStatus } from '../journey.js'

/**
 * Customer confirmation contract (plan 11 §3.2 #2–#4, §3.3 #2–#4; threat
 * model TM-03, TM-16, TM-18; reviews B1, UX-02, UX-08; amendment GAP-05).
 * Shared by the Worker (worker/portal/confirmation.ts), which has the final
 * word, and the customer's confirmation panel. Pure: no I/O, no logging.
 *
 * - GET  /api/bookings/{id}/confirmation                  → ConfirmationView
 * - POST /api/bookings/{id}/confirmation/accept-terms     → AcceptTermsResult
 * - POST /api/bookings/{id}/confirmation/whatsapp-notice  → DepositNoticeResult
 *
 * Every field below is presentation input for the panel; the Worker
 * re-checks ownership, flow, status and deadline inside each write.
 */

/** Statuses of a flow-2 booking that the confirmation panel shows (#2). */
export const CONFIRMATION_VIEW_STATUSES = [
  'approved_hold',
  'payment_pending',
  'confirmed',
] as const satisfies readonly BookingStatus[]

export type ConfirmationViewStatus = (typeof CONFIRMATION_VIEW_STATUSES)[number]

/**
 * Statuses in which the deposit is still owed, so the bank details may be
 * shown (after the terms are accepted). Never `confirmed`: once the deposit
 * is recorded nobody needs the account number again.
 */
export const DEPOSIT_OWED_STATUSES = [
  'approved_hold',
  'payment_pending',
] as const satisfies readonly ConfirmationViewStatus[]

export function isConfirmationViewStatus(
  value: unknown,
): value is ConfirmationViewStatus {
  return CONFIRMATION_VIEW_STATUSES.some((status) => status === value)
}

export function isDepositOwedStatus(value: unknown): boolean {
  return DEPOSIT_OWED_STATUSES.some((status) => status === value)
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** #3 and #4 body caps in UTF-8 bytes (§3.3 #3: ≤ 256 B). */
export const ACCEPT_TERMS_BODY_MAX_BYTES = 256
export const DEPOSIT_NOTICE_BODY_MAX_BYTES = 256

/** Exact key sets (SB-3): an unknown or missing key is 400. */
export const ACCEPT_TERMS_BODY_KEYS = ['termsVersion'] as const
export const DEPOSIT_NOTICE_BODY_KEYS = ['channel'] as const

/** The one notice channel: she tells us on WhatsApp that she transferred. */
export const DEPOSIT_NOTICE_CHANNEL = 'whatsapp'

/**
 * A terms version as terms_versions stores it: `v` and its seq, 1 to 9999
 * without a leading zero (0008 CHECK `version = 'v' || seq`).
 */
const TERMS_VERSION_PATTERN = /^v[1-9][0-9]{0,3}$/

/** The version she read, or null for anything that cannot name one. */
export function parseTermsVersion(value: unknown): string | null {
  return typeof value === 'string' && TERMS_VERSION_PATTERN.test(value)
    ? value
    : null
}

export function isDepositNoticeChannel(
  value: unknown,
): value is typeof DEPOSIT_NOTICE_CHANNEL {
  return value === DEPOSIT_NOTICE_CHANNEL
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ConfirmationBooking {
  readonly id: string
  readonly status: ConfirmationViewStatus
  readonly flowVersion: 2
  /** `YYYY-MM-DD`, Riyadh. */
  readonly eventDate: string
  readonly holdExpiresAt: string | null
  readonly estimatedTotal: number
  readonly depositAmount: number | null
  readonly termsVersion: string | null
  readonly termsAcceptedAt: string | null
  readonly depositReceivedAmount: number | null
  readonly depositReceivedAt: string | null
}

/** The current terms, to read before accepting. Plain text. */
export interface ConfirmationTerms {
  readonly version: string
  readonly body: string
  readonly publishedAt: string
}

/**
 * The exact version she accepted, read-only, even after a newer version
 * exists (TM-18). `bodySha256` is the hash recorded when she accepted, and
 * `body` hashes to it: a body that does not is never shown.
 */
export interface AcceptedTerms {
  readonly version: string
  readonly bodySha256: string
  readonly body: string
}

/**
 * The EFFECTIVE bank revision (TM-03: a pending one is never sent), only
 * after she accepted the terms and while the deposit is owed. `iban` is the
 * normalised 24-character value without spaces, which is what the copy
 * button copies (UX-08); group it for display only (groupIbanForDisplay).
 * `updatedAt` is when this revision reached customers («آخر تحديث لبيانات
 * الحساب»).
 */
export interface ConfirmationBankDetails {
  readonly bankName: string
  readonly accountHolder: string
  readonly iban: string
  readonly updatedAt: string
}

/**
 * A `deposit_notice_sent` event for the CURRENT deadline (B1, UX-02): the
 * hold is protected from automatic expiry until the studio confirms or
 * cancels it. A notice never moves the deadline (N-19).
 */
export interface DepositNotice {
  readonly sentAt: string
  readonly holdProtected: true
}

/** A deposit receipt as the customer sees it: never a URL or a file key. */
export interface ConfirmationReceipt {
  readonly attemptNo: number
  readonly status: JourneyReceiptStatus
  readonly uploadedAt: string
  readonly reviewedAt: string | null
  /** The studio's reason, plain text; only on a rejected receipt. */
  readonly rejectionReason: string | null
}

/** Where she sends the receipt (§4.2): upload only while private media is open. */
export type ConfirmationReceiptChannel = 'upload' | 'whatsapp'

/**
 * The studio number as `/api/bookings/me` reports it (§3.3 #1): the
 * effective contact revision (null: the panel uses its compiled number) and,
 * within 72 h of a change, when it changed (TM-03, TM-19).
 */
export interface ConfirmationStudio {
  readonly whatsappNumber: string | null
  readonly whatsappNumberChangedAt: string | null
}

/**
 * The number behind her «تأكدي منّا عبر واتساب» link and text, next to the
 * bank details and the changed-bank warning (GAP-05). When the studio number
 * changed after her booking was approved, this is the number that was in
 * force at approval, not the new one, and `changedSinceApproval` asks the
 * panel to show a visible notice: a stolen admin session that swaps the
 * number and later the IBAN cannot also answer the check. `whatsappNumber`
 * null means the compiled public number of src/lib/whatsapp.ts, which only a
 * deploy can change.
 */
export interface ConfirmationVerificationContact {
  readonly whatsappNumber: string | null
  readonly changedSinceApproval: boolean
}

/** 200 body of GET …/confirmation (#2), without the `ok` envelope field. */
export interface ConfirmationView {
  readonly booking: ConfirmationBooking
  /** Null only when no terms version passes its integrity check. */
  readonly terms: ConfirmationTerms | null
  readonly acceptedTerms: AcceptedTerms | null
  readonly bankDetails: ConfirmationBankDetails | null
  /**
   * She accepted the terms under another bank revision than the effective
   * one (or under none recorded): the panel shows the details only under the
   * changed-bank warning (UX-08, TM-16).
   */
  readonly bankDetailsChangedSinceAcceptance: boolean
  readonly receiptChannel: ConfirmationReceiptChannel
  readonly notice: DepositNotice | null
  /** Only while `receiptChannel` is 'upload'; newest attempt first. */
  readonly receipts: readonly ConfirmationReceipt[]
  readonly studio: ConfirmationStudio
  readonly verificationContact: ConfirmationVerificationContact
  readonly serverTime: string
}

/** 200 body of POST …/accept-terms (#3), without the `ok` envelope field. */
export interface AcceptTermsResult {
  readonly booking: {
    readonly termsVersion: string
    readonly termsAcceptedAt: string
  }
  readonly bankDetails: ConfirmationBankDetails | null
  readonly bankDetailsChangedSinceAcceptance: boolean
}

/** 200 body of POST …/whatsapp-notice (#4), without the `ok` envelope field. */
export interface DepositNoticeResult {
  readonly noticeRecordedAt: string
  readonly holdProtected: true
}

/** The error codes of #2–#4 beyond the common ones (plan 11 §3.1). */
export const confirmationErrorCodes = [
  'LEGACY_FLOW_NOT_SUPPORTED',
  'CONFIRMATION_NOT_AVAILABLE',
  'TERMS_VERSION_MISMATCH',
  'TERMS_NOT_ACCEPTED',
  'HOLD_EXPIRED',
] as const

export type ConfirmationErrorCode = (typeof confirmationErrorCodes)[number]

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * GAP-05: the number her verification link uses. `atApproval` is the studio
 * number in force when the booking was approved (null: none was saved yet,
 * so the compiled number was in use), or 'unknown' when the approval time
 * cannot be read; `current` is the effective number (null: compiled).
 * - unknown approval: the compiled number, no notice (it is the one number
 *   no admin session can change);
 * - unchanged: the current number, no notice;
 * - changed: the number in force at approval (null: compiled), with the
 *   notice. A change between the compiled number and a saved one counts as
 *   a change, because the server cannot see the compiled number: the notice
 *   then points at the compiled number, which is always safe to trust.
 */
export function resolveVerificationContact(
  atApproval: string | null | 'unknown',
  current: string | null,
): ConfirmationVerificationContact {
  if (atApproval === 'unknown') {
    return { whatsappNumber: null, changedSinceApproval: false }
  }

  if (atApproval === current) {
    return { whatsappNumber: current, changedSinceApproval: false }
  }

  return { whatsappNumber: atApproval, changedSinceApproval: true }
}

/**
 * The normalised IBAN in groups of four for display (UX-08, TM-16), e.g.
 * `SA03 8000 0000 6080 1016 7519`. Display only: render it inside
 * `<bdi dir="ltr">`, and copy the ungrouped value.
 */
export function groupIbanForDisplay(iban: string): string {
  return iban.replace(/(.{4})(?=.)/g, '$1 ')
}
