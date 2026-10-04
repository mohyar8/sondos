import type { AdminWorkspaceTab } from '../admin-portal/sections'

/**
 * Slot for the account-security tab (W5-01): position `security` (order
 * 70), under «المزيد» on phones (UX-05). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits
 * the registry. Null adds no tab: the dashboard's built-in «أمان الحساب» tab
 * (id `security`) stays as it is, and a tab registered here must use
 * another id.
 */
export const adminSecurityTab: AdminWorkspaceTab<'security'> | null = null
