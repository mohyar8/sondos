import type { AdminBookingSection } from '../admin-portal/sections'

/**
 * Slot for the booking detail's read-only feedback section (position
 * `feedback`, order 80; W3-12). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits the
 * registry. Null renders nothing.
 */
export const adminFeedbackSection: AdminBookingSection<'feedback'> | null = null
