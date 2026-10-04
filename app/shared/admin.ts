import type {
  BookingCalculationBreakdown,
  BookingPackageSnapshot,
} from './booking.js'
import { HOLD_GRACE_HOURS, TIMING } from './timing.js'

export const bookingStatuses = [
  'pending_review',
  'approved_hold',
  'contract_pending',
  'contract_signed',
  'payment_pending',
  'confirmed',
  'rejected',
  'cancelled',
  'expired',
] as const

export type BookingStatus = (typeof bookingStatuses)[number]

/**
 * Every admin action, the seven of the legacy flow first (their order is
 * the order the buttons render in) and the four of flow 2 after them
 * (plan 11 §3.3 #18; B1, H3). An admin bundle from before an action was
 * added skips its name (L1, src/api/admin.ts readAllowedActions).
 */
export const adminBookingActions = [
  'approve',
  'reject',
  'mark_contract_sent',
  'mark_contract_signed',
  'request_payment',
  'confirm_payment',
  'cancel',
  'extend_hold',
  'expire_hold',
  'reinstate_hold',
  'confirm_offline',
] as const

export type AdminBookingAction = (typeof adminBookingActions)[number]

/** booking_requests.flow_version: 1 the manual (legacy) path, 2 online confirmation. */
export type AdminFlowVersion = 1 | 2

export function isAdminFlowVersion(value: unknown): value is AdminFlowVersion {
  return value === 1 || value === 2
}

/** The actions only a flow-2 row ever offers; seeing one proves the flow. */
export const flowTwoOnlyAdminActions = [
  'extend_hold',
  'expire_hold',
  'reinstate_hold',
  'confirm_offline',
] as const

export function isFlowTwoOnlyAdminAction(action: AdminBookingAction): boolean {
  return flowTwoOnlyAdminActions.some((known) => known === action)
}

/**
 * `extendHours` of `extend_hold` (#18): whole hours added to the later of
 * the current deadline and now, 1–168, 24 when the key is left out.
 */
export const MINIMUM_EXTEND_HOURS = 1
export const MAXIMUM_EXTEND_HOURS = 168
export const DEFAULT_EXTEND_HOURS = 24

/** The flow-2 hold window from approval (and from a reinstatement). */
export const FLOW_TWO_HOLD_HOURS = TIMING.holdWindowMs / (60 * 60 * 1000)

/** Flow 2 is offered only when the event is at least this many Riyadh days away. */
export const FLOW_TWO_MINIMUM_LEAD_DAYS = 3

/** `confirm_offline` (H3): the reason is required and must say something. */
export const MINIMUM_OFFLINE_NOTE_CODE_POINTS = 10

function immutableActions(
  ...actions: AdminBookingAction[]
): readonly AdminBookingAction[] {
  return Object.freeze(actions)
}

/**
 * The legacy (flow-1) map, exactly as before flow 2 existed (N-29): every
 * row with flow_version 1 offers these and nothing else.
 */
export const allowedAdminActionsByStatus: Readonly<
  Record<BookingStatus, readonly AdminBookingAction[]>
> = Object.freeze<Record<BookingStatus, readonly AdminBookingAction[]>>({
  pending_review: immutableActions('approve', 'reject'),
  approved_hold: immutableActions('mark_contract_sent', 'cancel'),
  contract_pending: immutableActions('mark_contract_signed', 'cancel'),
  contract_signed: immutableActions('request_payment', 'cancel'),
  payment_pending: immutableActions('confirm_payment', 'cancel'),
  confirmed: immutableActions('cancel'),
  rejected: immutableActions(),
  cancelled: immutableActions(),
  expired: immutableActions(),
})

const targetStatusByAction: Readonly<
  Record<AdminBookingAction, BookingStatus | null>
> = Object.freeze<Record<AdminBookingAction, BookingStatus | null>>({
  approve: 'approved_hold',
  reject: 'rejected',
  mark_contract_sent: 'contract_pending',
  mark_contract_signed: 'contract_signed',
  request_payment: 'payment_pending',
  confirm_payment: 'confirmed',
  cancel: 'cancelled',
  // extend_hold moves the deadline, never the status.
  extend_hold: null,
  expire_hold: 'expired',
  reinstate_hold: 'approved_hold',
  confirm_offline: 'confirmed',
})

export function getAllowedAdminActions(
  status: BookingStatus,
): readonly AdminBookingAction[] {
  return allowedAdminActionsByStatus[status]
}

export function getAdminActionTargetStatus(
  status: BookingStatus,
  action: AdminBookingAction,
): BookingStatus | null {
  return allowedAdminActionsByStatus[status].includes(action)
    ? targetStatusByAction[action]
    : null
}

/**
 * The stored facts the flow-2 map depends on (#18; B1, TM-15), read from
 * the row and the server clock by the Worker. Instants are milliseconds so
 * the grace arithmetic needs no parsing here; null means "not set" (no
 * deadline) or "not computable" (an unusable event date), and then every
 * rule that needs the value refuses.
 */
export interface AdminBookingFlowFacts {
  readonly status: BookingStatus
  readonly flowVersion: AdminFlowVersion
  /** `terms_accepted_at IS NOT NULL`. */
  readonly termsAccepted: boolean
  /** `hold_expires_at`, or null. */
  readonly holdExpiresAtMs: number | null
  /** Status of the receipt with the highest attempt_no (Train B), or null. */
  readonly latestReceiptStatus: string | null
  /** riyadhStartOfDay(event_date): the "event start" of the grace rules. */
  readonly eventStartMs: number | null
  /** The server clock. */
  readonly nowMs: number
}

const HOLD_GRACE_MS = HOLD_GRACE_HOURS * 60 * 60 * 1000

/** The deadline has passed (`hold_expires_at <= now`, as the cron reads it). */
export function isHoldOverdue(facts: AdminBookingFlowFacts): boolean {
  return facts.holdExpiresAtMs !== null && facts.holdExpiresAtMs <= facts.nowMs
}

/** The event day has begun in Riyadh; nothing about the hold may change. */
export function hasEventStarted(facts: AdminBookingFlowFacts): boolean {
  return facts.eventStartMs === null || facts.eventStartMs <= facts.nowMs
}

/**
 * B1 #2: `confirm_payment` and `extend_hold` stay possible until
 * HOLD_GRACE_HOURS after the deadline, never past the event start.
 */
export function isWithinHoldGrace(facts: AdminBookingFlowFacts): boolean {
  return (
    facts.holdExpiresAtMs !== null &&
    facts.nowMs < facts.holdExpiresAtMs + HOLD_GRACE_MS &&
    !hasEventStarted(facts)
  )
}

/**
 * The flow-2 map of plan 11 §3.3 #18 for a row whose flow_version is 2.
 * `reject_receipt` (Train B) is not offered: no receipt can be uploaded
 * before private media ships. The legacy statuses a flow-2 row can never be
 * in fall back to the legacy map.
 */
export function getFlowTwoAdminActions(
  facts: AdminBookingFlowFacts,
): readonly AdminBookingAction[] {
  const actions: AdminBookingAction[] = []

  switch (facts.status) {
    case 'pending_review':
      return allowedAdminActionsByStatus.pending_review
    case 'approved_hold':
      if (facts.termsAccepted) {
        if (isWithinHoldGrace(facts)) {
          actions.push('confirm_payment')
        }
      } else if (!hasEventStarted(facts)) {
        actions.push('confirm_offline')
      }

      if (isWithinHoldGrace(facts)) {
        actions.push('extend_hold')
      }

      if (isHoldOverdue(facts)) {
        actions.push('expire_hold')
      }

      actions.push('cancel')
      return immutableActions(...actions)
    case 'payment_pending':
      actions.push('confirm_payment')

      if (facts.latestReceiptStatus === 'rejected' && isWithinHoldGrace(facts)) {
        actions.push('extend_hold')
      }

      actions.push('cancel')
      return immutableActions(...actions)
    case 'expired':
      return hasEventStarted(facts)
        ? immutableActions()
        : immutableActions('reinstate_hold')
    case 'confirmed':
      return immutableActions('cancel')
    case 'contract_pending':
    case 'contract_signed':
    case 'rejected':
    case 'cancelled':
      return allowedAdminActionsByStatus[facts.status]
  }
}

/** The map for any row: the legacy one for flow 1, the flow-2 one otherwise. */
export function getAdminActionsForBooking(
  facts: AdminBookingFlowFacts,
): readonly AdminBookingAction[] {
  return facts.flowVersion === 1
    ? allowedAdminActionsByStatus[facts.status]
    : getFlowTwoAdminActions(facts)
}

/**
 * The status `action` leads to from this row, or null when the row does
 * not offer it. `extend_hold` keeps the status: its target is the current
 * one.
 */
export function getAdminActionTargetStatusForBooking(
  facts: AdminBookingFlowFacts,
  action: AdminBookingAction,
): BookingStatus | null {
  if (!getAdminActionsForBooking(facts).includes(action)) {
    return null
  }

  return action === 'extend_hold' ? facts.status : targetStatusByAction[action]
}

/**
 * POST …/actions body (#18). `extendHours` only with `extend_hold`;
 * `depositAmount` (whole riyals, 1..the booking's total, the amount seen in
 * the bank statement, TM-20) only with `confirm_payment` on a flow-2 row and
 * with `confirm_offline`. A key that is not valid for the action → 400.
 */
export interface AdminBookingActionRequest {
  action: AdminBookingAction
  note?: string
  extendHours?: number
  depositAmount?: number
}

export interface AdminBookingNotesRequest {
  notes: string
}

export interface AdminBookingFilters {
  status?: BookingStatus
  from?: string
  to?: string
  limit: number
}

export interface AdminCustomer {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string
}

export interface AdminBookingSummary {
  id: string
  eventDate: string
  status: BookingStatus
  packageName: string | null
  estimatedTotal: number
  customer: AdminCustomer
  createdAt: string
  updatedAt: string
}

export interface AdminBookingStatusHistoryEntry {
  id: number
  fromStatus: BookingStatus | null
  toStatus: BookingStatus
  changedBy: string | null
  note: string | null
  createdAt: string
}

/** Why `approve` will take the legacy path (#17 approvalPreview). */
export type AdminApprovalUnavailableReason =
  | 'SETTINGS_INCOMPLETE'
  | 'SWITCH_OFF'
  | 'KILL_SWITCH'
  | 'EVENT_TOO_SOON'
  | 'EVENT_PASSED'

/**
 * What `approve` will do to a `pending_review` row (#17): open the online
 * confirmation with this deposit and hold window, or take the legacy path
 * for the first reason found. Computed by the Worker from the effective
 * settings and its own clock; the approve UPDATE re-checks every part.
 */
export type AdminApprovalPreview =
  | {
      readonly flowVersion: 2
      readonly depositAmount: number
      readonly holdHours: number
    }
  | {
      readonly flowVersion: 1
      readonly reason: AdminApprovalUnavailableReason
    }

export interface AdminBookingDetail {
  id: string
  eventDate: string
  status: BookingStatus
  allowedActions: readonly AdminBookingAction[]
  packageName: string | null
  estimatedTotal: number
  packageSnapshot: BookingPackageSnapshot | null
  priceBreakdown: BookingCalculationBreakdown | null
  adminNotes: string | null
  holdExpiresAt: string | null
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
  customer: AdminCustomer
  statusHistory: AdminBookingStatusHistoryEntry[]
  /*
   * Flow-2 fields of GET …/{id} (#17), additive. The Worker always sends
   * them; they are optional so that a bundle whose parser predates them
   * (src/api/admin.ts before W3-02 forwards them) still type-checks and the
   * UI treats a missing value as "not known".
   */
  /** booking_requests.flow_version. */
  flowVersion?: AdminFlowVersion
  /** booking_requests.deposit_amount (flow 2), the amount she was asked for. */
  depositAmount?: number | null
  termsVersion?: string | null
  termsAcceptedAt?: string | null
  /** What the admin recorded as received, whole riyals (TM-20). */
  depositReceivedAmount?: number | null
  depositReceivedAt?: string | null
  /** A `deposit_notice_sent` event exists for the CURRENT deadline (B1). */
  noticeProtected?: boolean
  /** Only for a `pending_review` row; null otherwise. */
  approvalPreview?: AdminApprovalPreview | null
}

export interface AdminBlockedDate {
  date: string
  reason: string | null
  createdBy: string | null
  createdAt: string
}

export interface AdminBookingsResponse {
  ok: true
  filters: AdminBookingFilters
  bookings: AdminBookingSummary[]
  /**
   * Opaque keyset cursor for the next (older) page: pass it back unchanged as
   * `?cursor=` with the same filters. `null` on the last page. The Worker
   * always sends it; it is optional only so that a response from before
   * pagination still type-checks.
   */
  nextCursor?: string | null
}

export interface AdminBookingDetailResponse {
  ok: true
  booking: AdminBookingDetail
}

export interface AdminBookingActionResponse {
  ok: true
  booking: AdminBookingDetail
  allowedActions: readonly AdminBookingAction[]
}

export interface AdminBookingNotesResponse {
  ok: true
  bookingId: string
  adminNotes: string | null
  updatedAt: string
}

export interface AdminBlockedDatesResponse {
  ok: true
  range: {
    from: string
    to: string
  }
  blockedDates: AdminBlockedDate[]
}

export interface AdminBlockedDateResponse {
  ok: true
  blockedDate: AdminBlockedDate
}

export interface AdminDeleteBlockedDateResponse {
  ok: true
  date: string
  deleted: boolean
}

export interface AdminApiErrorResponse {
  ok: false
  error: {
    code: string
    message: string
  }
}
