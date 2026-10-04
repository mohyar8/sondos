import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin view of customer feedback (11 §3.2 #25), filled by W2-09.
 * Templates are relative to `/api/admin/`:
 * - GET ['bookings', ':bookingId', 'feedback']
 * Auth AD. Gate 'open'.
 */
export const adminFeedbackRoutes: readonly AdminPortalRoute[] = []
