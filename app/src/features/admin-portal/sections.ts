import type { AdminBookingDetail } from '../../../shared/admin'
import type { RetryableLazyComponent } from '../../layout/retryable-lazy'
import { adminAuditTab } from '../admin-audit/registration'
import { adminCalendarTab } from '../admin-calendar/registration'
import { adminContactSection } from '../admin-contact/registration'
import { adminCustomersTab } from '../admin-customers/registration'
import { adminDepositSection } from '../admin-deposit/registration'
import { adminEventProfileSection } from '../admin-event-profile/registration'
import { adminFeedbackSection } from '../admin-feedback/registration'
import { adminGallerySection } from '../admin-gallery/registration'
import {
  adminHandoverSection,
  adminHandoverSlotsTab,
} from '../admin-handover/registration'
import { adminProductionSection } from '../admin-production/registration'
import { adminQueueTab } from '../admin-queue/registration'
import { adminReceiptSection } from '../admin-receipt/registration'
import { adminSecurityTab } from '../admin-security/registration'
import { adminSettingsTab } from '../admin-settings/registration'
import { adminTimelineSection } from '../admin-timeline/registration'

/**
 * Admin portal registry (ADR-001 §2.6; golive plan D10, W1-05).
 *
 * Features plug into the admin dashboard here instead of editing
 * AdminDashboard.tsx, and never edit this file either: each feature owns ONE
 * slot, its `registration.ts`, which this file reads. A slot holds null until
 * its feature fills it; with every slot empty the dashboard renders exactly
 * as in Run 3.
 *
 * - `adminBookingSections` render inside the booking detail panel, through
 *   <AdminBookingPortal>. Each position has a fixed order (UX-05, see
 *   ADMIN_SECTION_ORDER), and a slot's type only accepts its own value.
 * - `adminWorkspaceTabs` add a tab after «طلبات الحجز» and «الأيام
 *   المحجوبة». A tab id is also its `?tab=` value in the address bar. Each
 *   position has a fixed order (ADMIN_TAB_ORDER: the primary destinations
 *   first, then «المزيد») and a fixed phone group (ADMIN_TAB_GROUP), and a
 *   slot's type only accepts its own values. On phones at most four
 *   destinations are primary (UX-05): «اليوم» (queue), «الحجوزات» (built
 *   in), «التقويم» (calendar) and «المزيد»; so only the queue and calendar
 *   positions are `'primary'`.
 *
 * A filled slot is a descriptor whose component is code-split, e.g. in
 * features/admin-receipt/registration.ts:
 *   export const adminReceiptSection: AdminBookingSection<'receipts'> | null = {
 *     id: 'receipt', title: 'مراجعة الإيصال', order: 35,
 *     appliesTo: (booking) => booking.status === 'payment_pending',
 *     Component: createRetryableLazy(
 *       () => import('./AdminReceiptSection'),
 *       'AdminReceiptSection',
 *     ),
 *   }
 * `Component` only accepts a createRetryableLazy component, and
 * tests/ui-registry.test.mjs refuses a slot whose static imports reach a
 * component or a stylesheet, so nothing here grows the admin chunk. Slot
 * files import this module with `import type` only (it imports them). A
 * section or tab styles itself with the classes of ./admin-panels.css, which
 * its component imports; descriptors carry no styles.
 *
 * `appliesTo` and every registration are presentation only (plan §4.3 E8):
 * the Worker refuses every request it is not allowed to serve, whatever the
 * UI shows. Receipt and gallery sections talk to private-media routes that
 * answer 503 until the whole PM gate holds.
 */

/**
 * Fixed positions inside the booking detail (UX-05). `summary` and `actions`
 * are the dashboard's own built-in parts; every other position is one slot.
 */
export const ADMIN_SECTION_ORDER = Object.freeze({
  summary: 0,
  actions: 10,
  contact: 20,
  deposit: 30,
  receipts: 35,
  handover: 40,
  production: 50,
  gallery: 55,
  eventProfile: 60,
  timeline: 70,
  feedback: 80,
} as const)

export type AdminSectionPosition = keyof typeof ADMIN_SECTION_ORDER

/** The positions a registered section may take (not the built-in parts). */
export type AdminFeatureSectionPosition = Exclude<
  AdminSectionPosition,
  'summary' | 'actions'
>

/** What the detail panel hands to every booking section. */
export interface AdminBookingSectionProps {
  booking: AdminBookingDetail
  getIdToken: () => Promise<string | null>
  /** Reloads the booking detail (e.g. after the section changed its state). */
  onRefreshBooking: () => void
  /** Reloads the bookings list (e.g. after a status change). */
  onRefreshList: () => void
  /**
   * Report a request in flight (true) and its end (false). While any section
   * is busy, Escape and «إغلاق التفاصيل» never close the panel, so a request
   * is never cut off by unmounting it.
   */
  onBusyChange: (busy: boolean) => void
}

export interface AdminBookingSection<
  Position extends AdminFeatureSectionPosition = AdminFeatureSectionPosition,
> {
  /** Stable, unique, lowercase kebab-case; used in DOM ids. */
  readonly id: string
  /** The section's visible Arabic heading. */
  readonly title: string
  /** Ascending position inside the detail panel: fixed by the slot. */
  readonly order: (typeof ADMIN_SECTION_ORDER)[Position]
  /**
   * Whether the section is shown for this booking (pure; no requests). The
   * server still decides what the section may read or change.
   */
  readonly appliesTo: (booking: AdminBookingDetail) => boolean
  /** Code-split only: the result of createRetryableLazy (src/layout). */
  readonly Component: RetryableLazyComponent<AdminBookingSectionProps>
}

/** What the dashboard hands to every workspace tab. */
export interface AdminWorkspaceTabProps {
  getIdToken: () => Promise<string | null>
  /** Switches to «طلبات الحجز» and opens that booking's detail panel. */
  onOpenBooking: (bookingId: string) => void
}

/**
 * Fixed positions of the workspace tabs, after the built-in ones (UX-05):
 * the primary destinations first, then those under «المزيد». Every position
 * is one slot, so the slots, filled by different units, never have to agree
 * on numbers.
 */
export const ADMIN_TAB_ORDER = Object.freeze({
  queue: 10,
  calendar: 20,
  customers: 30,
  handoverSlots: 40,
  settings: 50,
  audit: 60,
  security: 70,
} as const)

export type AdminTabPosition = keyof typeof ADMIN_TAB_ORDER

/**
 * Where a tab sits on phones (UX-05): one of the primary destinations, or
 * under «المزيد».
 */
export type AdminWorkspaceTabGroup = 'primary' | 'more'

/** The phone group of each position: only «اليوم» and «التقويم» are primary. */
export const ADMIN_TAB_GROUP = Object.freeze({
  queue: 'primary',
  calendar: 'primary',
  customers: 'more',
  handoverSlots: 'more',
  settings: 'more',
  audit: 'more',
  security: 'more',
} as const satisfies Record<AdminTabPosition, AdminWorkspaceTabGroup>)

export interface AdminWorkspaceTab<
  Position extends AdminTabPosition = AdminTabPosition,
> {
  /**
   * The `?tab=` value; lowercase kebab-case. Must not be one of the built-in
   * tabs ('bookings', 'blocked-dates', 'security').
   */
  readonly id: string
  /** The tab's visible Arabic label. */
  readonly label: string
  /** Primary destination or «المزيد»: fixed by the slot. */
  readonly group: (typeof ADMIN_TAB_GROUP)[Position]
  /** Ascending position after the built-in tabs: fixed by the slot. */
  readonly order: (typeof ADMIN_TAB_ORDER)[Position]
  /** Code-split only: the result of createRetryableLazy (src/layout). */
  readonly Component: RetryableLazyComponent<AdminWorkspaceTabProps>
}

/** Booking-detail sections, listed in their fixed order. */
export const adminBookingSections: readonly AdminBookingSection[] = [
  adminContactSection,
  adminDepositSection,
  adminReceiptSection,
  adminHandoverSection,
  adminProductionSection,
  adminGallerySection,
  adminEventProfileSection,
  adminTimelineSection,
  adminFeedbackSection,
].filter((section) => section !== null)

/** Extra dashboard tabs, listed in their fixed order. */
export const adminWorkspaceTabs: readonly AdminWorkspaceTab[] = [
  adminQueueTab,
  adminCalendarTab,
  adminCustomersTab,
  adminHandoverSlotsTab,
  adminSettingsTab,
  adminAuditTab,
  adminSecurityTab,
].filter((tab) => tab !== null)
