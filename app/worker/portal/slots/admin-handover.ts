import type { AdminPortalRoute } from '../admin-portal-routes.js'
import { getAdminHandover, patchAdminHandover } from '../admin-handover.js'
import {
  createHandoverSlot,
  deleteHandoverSlot,
  generateHandoverSlots,
  listHandoverSlots,
  updateHandoverSlot,
} from '../admin-handover-slots.js'

/**
 * Slot: admin handover and handover slots (11 §3.2 #24, #28), filled by
 * W2-08. Templates are relative to `/api/admin/`:
 * - GET, PATCH    ['bookings', ':bookingId', 'handover']
 * - GET, POST     ['handover-slots']
 * - POST          ['handover-slots', 'generate'] (before ':slotId')
 * - PATCH, DELETE ['handover-slots', ':slotId']
 * Auth AD. Gate 'open'.
 */
export const adminHandoverRoutes: readonly AdminPortalRoute[] = [
  {
    path: ['bookings', ':bookingId', 'handover'],
    gate: 'open',
    handlers: {
      GET: getAdminHandover,
      PATCH: patchAdminHandover,
    },
  },
  {
    path: ['handover-slots'],
    gate: 'open',
    handlers: {
      GET: listHandoverSlots,
      POST: createHandoverSlot,
    },
  },
  {
    path: ['handover-slots', 'generate'],
    gate: 'open',
    handlers: {
      POST: generateHandoverSlots,
    },
  },
  {
    path: ['handover-slots', ':slotId'],
    gate: 'open',
    handlers: {
      PATCH: updateHandoverSlot,
      DELETE: deleteHandoverSlot,
    },
  },
]
