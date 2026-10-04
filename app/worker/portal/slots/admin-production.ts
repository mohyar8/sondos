import type { AdminPortalRoute } from '../admin-portal-routes.js'
import { handleGetProduction, handlePutProduction } from '../production.js'

/**
 * Slot: album production status (11 §3.2 #23), filled by W2-07. Templates
 * are relative to `/api/admin/`:
 * - GET, PUT ['bookings', ':bookingId', 'production']
 * Auth AD. Gate 'open' (the path deliberately avoids the word 'album').
 */
export const adminProductionRoutes: readonly AdminPortalRoute[] = [
  {
    path: ['bookings', ':bookingId', 'production'],
    gate: 'open',
    handlers: {
      GET: handleGetProduction,
      PUT: handlePutProduction,
    },
  },
]
