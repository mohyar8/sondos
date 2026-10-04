import type { AdminBookingSection } from '../admin-portal/sections'

/**
 * Slot for the booking detail's receipt review (position `receipts`, order
 * 35; W11-01). The admin registry (../admin-portal/sections.ts) reads this
 * slot; this feature never edits the registry. Null renders nothing. Its
 * routes are private media: the Worker answers 503 until the whole PM gate
 * holds.
 */
export const adminReceiptSection: AdminBookingSection<'receipts'> | null = null
