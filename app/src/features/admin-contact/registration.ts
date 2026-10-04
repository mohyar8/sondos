import type { AdminBookingSection } from '../admin-portal/sections'

/**
 * Slot for the booking detail's contact section (position `contact`, order
 * 20): contact details, templates and the contact log (W3-07). The admin
 * registry (../admin-portal/sections.ts) reads this slot; this feature never
 * edits the registry. Null renders nothing.
 */
export const adminContactSection: AdminBookingSection<'contact'> | null = null
