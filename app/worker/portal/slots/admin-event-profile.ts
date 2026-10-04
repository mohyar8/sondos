import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin view of the event profile (11 §3.2 #22), filled by W2-06.
 * Templates are relative to `/api/admin/`:
 * - GET ['bookings', ':bookingId', 'event-profile']
 * Auth AD. Gate 'open'.
 */
export const adminEventProfileRoutes: readonly AdminPortalRoute[] = []
