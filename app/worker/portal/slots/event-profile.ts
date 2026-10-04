import type { CustomerPortalRoute } from '../portal-routes.js'
import {
  handleGetEventProfile,
  handlePutConsent,
  handlePutEventProfile,
} from '../event-profile.js'

/**
 * Slot: event profile and consent (11 §3.2 #6–#8), filled by W2-06.
 * Templates are relative to `/api/bookings/{bookingId}/`:
 * - GET, PUT ['event-profile']
 * - PUT      ['consent'] (granting needs CO+R in the handler)
 * Auth CO. Gate 'open'.
 * Handlers get the OwnedBooking as `booking` and still bind `user_id = ?`
 * to `customer.uid` in every statement they run (SB-20).
 */
export const eventProfileRoutes: readonly CustomerPortalRoute[] = [
  {
    path: ['event-profile'],
    gate: 'open',
    handlers: {
      GET: handleGetEventProfile,
      PUT: handlePutEventProfile,
    },
  },
  {
    path: ['consent'],
    gate: 'open',
    handlers: {
      PUT: handlePutConsent,
    },
  },
]
