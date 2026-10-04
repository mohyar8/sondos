import type { AdminWorkspaceTab } from '../admin-portal/sections'

/**
 * Slot for the work-queue tab «اليوم» (W3-05): position `queue` (order 10),
 * one of the primary phone destinations (UX-05). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits
 * the registry. Null adds no tab.
 */
export const adminQueueTab: AdminWorkspaceTab<'queue'> | null = null
