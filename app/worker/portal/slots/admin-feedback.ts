import type { AdminPortalRoute } from '../admin-portal-routes.js'
import { handleAdminGetFeedback } from '../feedback.js'

/**
 * Slot: admin view of customer feedback (11 §3.2 #25), filled by W2-09.
 * Templates are relative to `/api/admin/`:
 * - GET ['bookings', ':bookingId', 'feedback']
 * Auth AD. Gate 'open'. Read-only: no route edits, deletes or publishes
 * feedback (D7).
 */
export const adminFeedbackRoutes: readonly AdminPortalRoute[] = [
  {
    path: ['bookings', ':bookingId', 'feedback'],
    gate: 'open',
    handlers: {
      GET: handleAdminGetFeedback,
    },
  },
]
