import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: CSV export (11 §3.2 #38), filled by W2-12. Templates are relative
 * to `/api/admin/`:
 * - GET ['exports', 'bookings.csv']
 * Auth AD+R. Gate 'open'.
 */
export const adminExportRoutes: readonly AdminPortalRoute[] = []
