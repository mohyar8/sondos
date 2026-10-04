import type { BookingStatus } from './admin.js'

export interface AdminNewBookingNotification {
  bookingReference: string
  customerFirstName: string
  customerLastName: string
  customerEmail: string
  customerPhone: string
  eventDate: string
  packageName: string
  finalTotal: number
  adminBookingUrl: string
}

export interface CustomerBookingReceivedNotification {
  customerFirstName: string
  bookingReference: string
  eventDate: string
  packageName: string
  finalTotal: number
  myBookingsUrl: string
}

export interface CustomerBookingStatusChangedNotification {
  customerFirstName: string
  bookingReference: string
  eventDate: string
  previousStatus: BookingStatus
  newStatus: BookingStatus
  myBookingsUrl: string
}

export interface EmailTemplate {
  subject: string
  text: string
  html: string
}

export interface EmailMessageInput extends EmailTemplate {
  to: string
  replyTo?: string
  idempotencyKey: string
}

export interface EmailDeliverySuccessResult {
  status: 'sent'
  providerMessageId: string
}

export interface EmailDeliverySkippedResult {
  status: 'skipped'
  reason: 'NOT_CONFIGURED'
}

export type EmailDeliveryFailureReason =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_MESSAGE'
  | 'PROVIDER_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'RATE_LIMITED'
  | 'PROVIDER_REJECTED'
  | 'INVALID_PROVIDER_RESPONSE'

export interface EmailDeliveryFailedResult {
  status: 'failed'
  reason: EmailDeliveryFailureReason
}

export type EmailDeliveryResult =
  | EmailDeliverySuccessResult
  | EmailDeliverySkippedResult
  | EmailDeliveryFailedResult