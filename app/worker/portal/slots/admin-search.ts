import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin search by POST, so the query text never appears in a URL
 * (11 §3.2 #41–#42, TM-17), filled by W3-02. Templates are relative to
 * `/api/admin/`:
 * - POST ['search', 'bookings'], ['search', 'customers']
 * Auth AD. Gate 'open'.
 */
export const adminSearchRoutes: readonly AdminPortalRoute[] = []
