import type { AdminPortalRoute } from '../admin-portal-routes.js'

/**
 * Slot: admin settings (11 §3.2 #29–#34, #43), filled by W2-01. Templates
 * are relative to `/api/admin/`:
 * - GET       ['settings']
 * - PUT       ['settings', 'deposit'], ['settings', 'bank'],
 *             ['settings', 'contact'] (all three AD+S)
 * - PUT       ['settings', 'pickup'] (AD+R)
 * - GET, POST ['settings', 'terms'] (POST publishes: AD+S)
 * - GET       ['settings', 'history']
 * - GET, POST ['settings', 'delivery-areas']
 * - PATCH     ['settings', 'delivery-areas', ':areaId']
 * - PUT       ['settings', 'switch'] (to off: AD; to on: AD+R)
 * Auth AD unless noted. Gate 'open'.
 */
export const adminSettingsRoutes: readonly AdminPortalRoute[] = []
