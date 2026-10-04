import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: album production status (11 §3.2 #23), filled by W2-07. Templates
 * are relative to `/api/admin/`:
 * - GET, PUT ['bookings', ':bookingId', 'production']
 * Auth AD. Gate 'open' (the path deliberately avoids the word 'album').
 */
export const adminProductionRoutes: readonly AdminPortalRoute[] = []
