// The registry type comes first: tests/portal-routes.test.mjs reads a slot's
// imports up to the first `from '../portal-routes.js'` and requires that
// statement to take types only, so no runtime cycle can form.
import type { CustomerPortalRoute } from '../portal-routes.js'
import {
  handleAcceptTerms,
  handleConfirmationView,
  handleDepositNotice,
} from '../confirmation.js'

/**
 * Slot: customer confirmation (11 §3.2 #2–#4), filled by W2-13. Templates
 * are relative to `/api/bookings/{bookingId}/`:
 * - GET  ['confirmation']
 * - POST ['confirmation', 'accept-terms']
 * - POST ['confirmation', 'whatsapp-notice']
 * Auth CO. Route gate 'open'; the handlers answer 503 while effective online
 * confirmation is off (OC, 11 §4.3 E7).
 * Handlers get the OwnedBooking as `booking` and still bind `user_id = ?`
 * to `customer.uid` in every statement they run (SB-20).
 */
export const confirmationRoutes: readonly CustomerPortalRoute[] = [
  {
    path: ['confirmation'],
    gate: 'open',
    handlers: { GET: handleConfirmationView },
  },
  {
    path: ['confirmation', 'accept-terms'],
    gate: 'open',
    handlers: { POST: handleAcceptTerms },
  },
  {
    path: ['confirmation', 'whatsapp-notice'],
    gate: 'open',
    handlers: { POST: handleDepositNotice },
  },
]
