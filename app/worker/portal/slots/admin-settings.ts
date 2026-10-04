import type { AdminPortalRoute } from '../admin-portal-routes.js'
import {
  handleGetDeliveryAreas,
  handleGetHistory,
  handleGetSettings,
  handleGetTerms,
  handlePatchDeliveryArea,
  handlePostDeliveryArea,
  handlePostTerms,
  handlePutBank,
  handlePutContact,
  handlePutDeposit,
  handlePutIdentity,
  handlePutPickup,
  handlePutSwitch,
} from '../../settings/admin-settings-handlers.js'

/**
 * Slot: admin settings (11 §3.2 #29–#34, #43), filled by W2-01. Templates
 * are relative to `/api/admin/`:
 * - GET       ['settings']
 * - PUT       ['settings', 'deposit'], ['settings', 'bank'],
 *             ['settings', 'contact'] (all three AD+S)
 * - PUT       ['settings', 'pickup'] (AD+R)
 * - PUT       ['settings', 'identity'] (AD+R; GAP-03 business identity)
 * - GET, POST ['settings', 'terms'] (POST publishes: AD+S)
 * - GET       ['settings', 'history']
 * - GET, POST ['settings', 'delivery-areas']
 * - PATCH     ['settings', 'delivery-areas', ':areaId']
 * - PUT       ['settings', 'switch'] (to off: AD; to on: AD+R)
 * Auth AD unless noted; the handlers apply AD+R and AD+S themselves
 * (worker/settings/admin-settings-handlers.ts). Gate 'open'.
 */
export const adminSettingsRoutes: readonly AdminPortalRoute[] = [
  {
    path: ['settings'],
    gate: 'open',
    handlers: { GET: handleGetSettings },
  },
  {
    path: ['settings', 'deposit'],
    gate: 'open',
    handlers: { PUT: handlePutDeposit },
  },
  {
    path: ['settings', 'bank'],
    gate: 'open',
    handlers: { PUT: handlePutBank },
  },
  {
    path: ['settings', 'contact'],
    gate: 'open',
    handlers: { PUT: handlePutContact },
  },
  {
    path: ['settings', 'pickup'],
    gate: 'open',
    handlers: { PUT: handlePutPickup },
  },
  {
    path: ['settings', 'identity'],
    gate: 'open',
    handlers: { PUT: handlePutIdentity },
  },
  {
    path: ['settings', 'terms'],
    gate: 'open',
    handlers: { GET: handleGetTerms, POST: handlePostTerms },
  },
  {
    path: ['settings', 'history'],
    gate: 'open',
    handlers: { GET: handleGetHistory },
  },
  {
    path: ['settings', 'delivery-areas'],
    gate: 'open',
    handlers: { GET: handleGetDeliveryAreas, POST: handlePostDeliveryArea },
  },
  {
    path: ['settings', 'delivery-areas', ':areaId'],
    gate: 'open',
    handlers: { PATCH: handlePatchDeliveryArea },
  },
  {
    path: ['settings', 'switch'],
    gate: 'open',
    handlers: { PUT: handlePutSwitch },
  },
]
