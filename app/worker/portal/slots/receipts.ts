import type { CustomerPortalRoute } from '../portal-routes.js'

/**
 * Slot: customer receipt upload (11 §3.2 #5, Train B), filled by W9-02.
 * Templates are relative to `/api/bookings/{bookingId}/`:
 * - POST ['receipt'] (multipart)
 * Auth CO+M (applied by the dispatcher). Gate 'private-media' (G), and OC
 * in the handler.
 * Handlers get the OwnedBooking as `booking` and still bind `user_id = ?`
 * to `customer.uid` in every statement they run (SB-20).
 */
export const receiptRoutes: readonly CustomerPortalRoute[] = []
