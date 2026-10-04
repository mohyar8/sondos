import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin receipt review (11 §3.2 #26, Train B), filled by W10-01.
 * Templates are relative to `/api/admin/`:
 * - GET ['bookings', ':bookingId', 'receipts']
 * Auth AD+2F (the dispatcher applies the second factor to every
 * private-media route). Gate 'private-media' (G).
 */
export const adminReceiptRoutes: readonly AdminPortalRoute[] = []
