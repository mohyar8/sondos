import type { CustomerPortalRoute } from '../portal-routes.js'
import { handleGetFeedback, handleSubmitFeedback } from '../feedback.js'

/**
 * Slot: customer feedback (11 §3.2 #12), filled by W2-09. Templates are
 * relative to `/api/bookings/{bookingId}/`:
 * - GET, POST ['feedback']
 * Auth CO. Gate 'open'.
 * Handlers get the OwnedBooking as `booking` and still bind `user_id = ?`
 * to `customer.uid` in every statement they run (SB-20).
 */
export const feedbackRoutes: readonly CustomerPortalRoute[] = [
  {
    path: ['feedback'],
    gate: 'open',
    handlers: {
      GET: handleGetFeedback,
      POST: handleSubmitFeedback,
    },
  },
]
