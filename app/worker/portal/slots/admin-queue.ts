import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: the admin work queue (11 §3.2 #35), filled by W2-10. Templates are
 * relative to `/api/admin/`:
 * - GET ['queue']
 * Auth AD. Gate 'open'.
 */
export const adminQueueRoutes: readonly AdminPortalRoute[] = []
