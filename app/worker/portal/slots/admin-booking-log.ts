import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin booking timeline and contact log (11 §3.2 #20–#21), filled
 * by W2-05. Templates are relative to `/api/admin/`:
 * - GET  ['bookings', ':bookingId', 'timeline']
 * - POST ['bookings', ':bookingId', 'contact-log']
 * Auth AD. Gate 'open'.
 */
export const adminBookingLogRoutes: readonly AdminPortalRoute[] = []
