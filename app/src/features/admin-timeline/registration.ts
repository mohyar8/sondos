import type { AdminBookingSection } from '../admin-portal/sections'

/**
 * Slot for the booking detail's merged timeline (position `timeline`, order
 * 70; W3-08). The admin registry (../admin-portal/sections.ts) reads this
 * slot; this feature never edits the registry. Null renders nothing.
 */
export const adminTimelineSection: AdminBookingSection<'timeline'> | null = null
