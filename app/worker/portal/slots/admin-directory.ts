import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin calendar and customer directory (11 §3.2 #36–#37), filled by
 * W2-11. Templates are relative to `/api/admin/`:
 * - GET ['calendar'] (?month=YYYY-MM)
 * - GET ['customers'], ['customers', ':customerId'] (no free-text query;
 *   search is POST in the admin-search slot)
 * Auth AD. Gate 'open'.
 */
export const adminDirectoryRoutes: readonly AdminPortalRoute[] = []
