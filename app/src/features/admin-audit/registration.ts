import type { AdminWorkspaceTab } from '../admin-portal/sections'

/**
 * Slot for the audit-log tab (W3-12): position `audit` (order 60), under
 * «المزيد» on phones (UX-05). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits
 * the registry. Null adds no tab.
 */
export const adminAuditTab: AdminWorkspaceTab<'audit'> | null = null
