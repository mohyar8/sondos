// The registry type comes first: tests/portal-routes.test.mjs reads the
// first import statement that names the registry module.
import type { AdminPortalRoute } from '../admin-portal-routes.js'
import { handleAdminCalendar } from '../admin-calendar.js'
import {
  handleAdminCustomerDetail,
  handleAdminCustomerList,
} from '../admin-customers.js'

/**
 * Slot: admin calendar and customer directory (11 §3.2 #36–#37), filled by
 * W2-11. Templates are relative to `/api/admin/`:
 * - GET ['calendar'] (?month=YYYY-MM&includeClosed=1)
 * - GET ['customers'], ['customers', ':customerId'] (no free-text query;
 *   search is POST in the admin-search slot)
 * Auth AD. Gate 'open'.
 */
export const adminDirectoryRoutes: readonly AdminPortalRoute[] = [
  {
    path: ['calendar'],
    gate: 'open',
    handlers: { GET: handleAdminCalendar },
  },
  {
    path: ['customers'],
    gate: 'open',
    handlers: { GET: handleAdminCustomerList },
  },
  {
    path: ['customers', ':customerId'],
    gate: 'open',
    handlers: { GET: handleAdminCustomerDetail },
  },
]
