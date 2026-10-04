import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: audit log, admin session and sign-out everywhere (11 §3.2 #39,
 * #40, #44), filled by W2-05. Templates are relative to `/api/admin/`:
 * - GET  ['audit-log']
 * - GET  ['session']
 * - POST ['session', 'revoke-all'] (AD+R)
 * Auth AD. Gate 'open'.
 */
export const adminAuditRoutes: readonly AdminPortalRoute[] = []
