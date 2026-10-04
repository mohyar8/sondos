import type {
  AdminBookingSection,
  AdminWorkspaceTab,
} from '../admin-portal/sections'

/**
 * Slots for the handover feature (W3-10): the booking detail's handover
 * section (position `handover`, order 40) and the handover-slots tab
 * (position `handoverSlots`, order 40), which sits under «المزيد» on phones.
 * The admin registry (../admin-portal/sections.ts) reads both; this feature
 * never edits the registry. Null renders nothing.
 */
export const adminHandoverSection: AdminBookingSection<'handover'> | null =
  null

export const adminHandoverSlotsTab: AdminWorkspaceTab<'handoverSlots'> | null =
  null
