import type { AdminWorkspaceTab } from '../admin-portal/sections'

/**
 * Slot for the settings tab «الإعدادات» (W3-04): position `settings` (order
 * 50), under «المزيد» on phones (UX-05). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits
 * the registry. Null adds no tab.
 */
export const adminSettingsTab: AdminWorkspaceTab<'settings'> | null = null
