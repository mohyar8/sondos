import type { AdminBookingSection } from '../admin-portal/sections'

/**
 * Slot for the booking detail's album production section (position
 * `production`, order 50; W3-11). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits the
 * registry. Null renders nothing.
 */
export const adminProductionSection: AdminBookingSection<'production'> | null =
  null
