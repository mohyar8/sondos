import type { AdminBookingSection } from '../admin-portal/sections'

/**
 * Slot for the booking detail's deposit and terms section (position
 * `deposit`, order 30; W4-04). The admin registry
 * (../admin-portal/sections.ts) reads this slot; this feature never edits the
 * registry. Null renders nothing.
 */
export const adminDepositSection: AdminBookingSection<'deposit'> | null = null
