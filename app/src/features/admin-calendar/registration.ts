import type { AdminWorkspaceTab } from '../admin-portal/sections'

/**
 * Slot for the calendar tab «التقويم» (W3-06): position `calendar` (order
 * 20), one of the primary phone destinations (UX-05). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits
 * the registry. Null adds no tab.
 */
export const adminCalendarTab: AdminWorkspaceTab<'calendar'> | null = null
