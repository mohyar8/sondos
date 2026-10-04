import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin handover and handover slots (11 §3.2 #24, #28), filled by
 * W2-08. Templates are relative to `/api/admin/`:
 * - GET, PATCH    ['bookings', ':bookingId', 'handover']
 * - GET, POST     ['handover-slots']
 * - POST          ['handover-slots', 'generate'] (before ':slotId')
 * - PATCH, DELETE ['handover-slots', ':slotId']
 * Auth AD. Gate 'open'.
 */
export const adminHandoverRoutes: readonly AdminPortalRoute[] = []
