import type { AdminPortalRoute } from '../admin-portal-routes.js'
import {
  handleAdminAuditLog,
  handleAdminSession,
  handleRevokeAllSessions,
} from '../../audit/admin-audit-handlers.js'

/**
 * Slot: audit log, admin session and sign-out everywhere (11 §3.2 #39,
 * #40, #44), filled by W2-05. Templates are relative to `/api/admin/`:
 * - GET  ['audit-log']
 * - GET  ['session']
 * - POST ['session', 'revoke-all'] (AD+R, checked by the handler)
 * Auth AD. Gate 'open'.
 */
export const adminAuditRoutes: readonly AdminPortalRoute[] = [
  {
    path: ['audit-log'],
    gate: 'open',
    handlers: { GET: handleAdminAuditLog },
  },
  {
    path: ['session'],
    gate: 'open',
    handlers: { GET: handleAdminSession },
  },
  {
    path: ['session', 'revoke-all'],
    gate: 'open',
    handlers: { POST: handleRevokeAllSessions },
  },
]
