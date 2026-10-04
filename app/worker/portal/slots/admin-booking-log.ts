import type { AdminPortalRoute } from '../admin-portal-routes.js'
import {
  handleAdminContactLog,
  handleAdminTimeline,
} from '../admin-booking-log.js'

/**
 * Slot: admin booking timeline and contact log (11 §3.2 #20–#21), filled
 * by W2-05. Templates are relative to `/api/admin/`:
 * - GET  ['bookings', ':bookingId', 'timeline']
 * - POST ['bookings', ':bookingId', 'contact-log']
 * Auth AD. Gate 'open'.
 */
export const adminBookingLogRoutes: readonly AdminPortalRoute[] = [
  {
    path: ['bookings', ':bookingId', 'timeline'],
    gate: 'open',
    handlers: { GET: handleAdminTimeline },
  },
  {
    path: ['bookings', ':bookingId', 'contact-log'],
    gate: 'open',
    handlers: { POST: handleAdminContactLog },
  },
]
