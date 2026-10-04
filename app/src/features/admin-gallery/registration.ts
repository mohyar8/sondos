import type { AdminBookingSection } from '../admin-portal/sections'

/**
 * Slot for the booking detail's gallery section (position `gallery`, order
 * 55; W11-02). The admin registry (../admin-portal/sections.ts) reads this
 * slot; this feature never edits the registry. Null renders nothing. Its
 * routes are private media: the Worker answers 503 until the whole PM gate
 * holds.
 */
export const adminGallerySection: AdminBookingSection<'gallery'> | null = null
