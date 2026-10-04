import type { CustomerPortalRoute } from '../portal-routes.js'

/**
 * Slot: customer handover (11 §3.2 #9–#11), filled by W3-01. Templates are
 * relative to `/api/bookings/{bookingId}/`:
 * - GET, POST ['handover'] (a delivery booking needs CO+R in the handler)
 * - GET       ['handover', 'slots']
 * Auth CO. Gate 'open'.
 * Handlers get the OwnedBooking as `booking` and still bind `user_id = ?`
 * to `customer.uid` in every statement they run (SB-20).
 */
export const handoverRoutes: readonly CustomerPortalRoute[] = []
