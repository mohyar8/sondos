import type { AdminWorkspaceTab } from '../admin-portal/sections'

/**
 * Slot for the customers tab (W3-09): position `customers` (order 30), under
 * «المزيد» on phones (UX-05). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits
 * the registry. Null adds no tab.
 */
export const adminCustomersTab: AdminWorkspaceTab<'customers'> | null = null
