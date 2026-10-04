import type {
  BookingCalculationBreakdown,
  BookingPackageSnapshot,
} from './booking.js'

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

export const adminBookingActions = [
  'approve',
  'reject',
  'mark_contract_sent',
  'mark_contract_signed',
  'request_payment',
  'confirm_payment',
  'cancel',
] as const

export type AdminBookingAction = (typeof adminBookingActions)[number]

function immutableActions(
  ...actions: AdminBookingAction[]
): readonly AdminBookingAction[] {
  return Object.freeze(actions)
}

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
  Record<AdminBookingAction, BookingStatus>
> = Object.freeze<Record<AdminBookingAction, BookingStatus>>({
  approve: 'approved_hold',
  reject: 'rejected',
  mark_contract_sent: 'contract_pending',
  mark_contract_signed: 'contract_signed',
  request_payment: 'payment_pending',
  confirm_payment: 'confirmed',
  cancel: 'cancelled',
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

export interface AdminBookingActionRequest {
  action: AdminBookingAction
  note?: string
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