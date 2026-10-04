import type { AdminBookingSection } from '../admin-portal/sections'

/**
 * Slot for the booking detail's event details and consent history (position
 * `eventProfile`, order 60; W3-11). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits the
 * registry. Null renders nothing.
 */
export const adminEventProfileSection: AdminBookingSection<'eventProfile'> | null =
  null
