import type { CustomerPortalRoute } from '../portal-routes.js'

/**
 * Slot: customer gallery (11 §3.2 #13–#14, Train B), filled by W10-02.
 * Templates are relative to `/api/bookings/{bookingId}/`:
 * - GET  ['gallery'], ['gallery', 'photos']
 * - POST ['gallery', 'selection'], ['gallery', 'submit'] (submit needs CO+R
 *   in the handler)
 * Auth CO+M (applied by the dispatcher). Gate 'private-media' (G). The
 * gallery id comes only from the owned booking; photo ids are checked
 * through (gallery_id, photo_id).
 * Handlers get the OwnedBooking as `booking` and still bind `user_id = ?`
 * to `customer.uid` in every statement they run (SB-20).
 */
export const galleryRoutes: readonly CustomerPortalRoute[] = []
