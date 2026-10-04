// The registry type comes first: tests/portal-routes.test.mjs reads the
// first import statement that names the registry module.
import type { AdminPortalRoute } from '../admin-portal-routes.js'
import { handleAdminQueue } from '../admin-queue.js'

/**
 * Slot: the admin work queue (11 §3.2 #35), filled by W2-10. Templates are
 * relative to `/api/admin/`:
 * - GET ['queue'] (no parameters; any query string is refused)
 * Auth AD. Gate 'open': the sections that need private media are left out
 * of the answer while that gate is closed, inside the handler.
 */
export const adminQueueRoutes: readonly AdminPortalRoute[] = [
  {
    path: ['queue'],
    gate: 'open',
    handlers: { GET: handleAdminQueue },
  },
]
