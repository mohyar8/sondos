import type { JourneyStageId } from '../../../shared/journey'
import type { CustomerBooking } from '../../api/bookings'
import type { RetryableLazyComponent } from '../../layout/retryable-lazy'
import { confirmationStageView } from '../confirmation/registration'
import { eventProfileStageView } from '../event-profile/registration'
import { feedbackStageView } from '../feedback/registration'
import { galleryStageView } from '../gallery/registration'
import { handoverStageView } from '../handover/registration'

/**
 * Stage-view registry (ADR-001 §2.6; golive plan D10, W1-05).
 *
 * The customer hub is `/my-bookings?booking=<id>&view=<view id>`. A view is a
 * panel that replaces the booking card for one step of her journey. Each view
 * id has ONE slot, a `registration.ts` owned by its feature, and this file
 * only reads the slots, so features never edit it (or MyBookings.tsx):
 *   complete → confirmation/registration.ts   (W4-01)
 *   details  → event-profile/registration.ts  (W3-13)
 *   gallery  → gallery/registration.ts        (W11-03)
 *   handover → handover/registration.ts       (W4-02)
 *   feedback → feedback/registration.ts       (W3-14)
 * A slot holds null until its feature fills it; with every slot empty the
 * hub shows the booking card for every `?view=`, exactly as in Run 3.
 *
 * A filled slot is a descriptor whose component is code-split, e.g.
 *   export const galleryStageView: StageViewEntry | null = {
 *     title: 'معرض صوركِ',
 *     stages: ['gallery_open', 'gallery_locked'],
 *     Component: createRetryableLazy(
 *       () => import('./GalleryStageView'),
 *       'GalleryStageView',
 *     ),
 *   }
 * `Component` only accepts a createRetryableLazy component, and
 * tests/ui-registry.test.mjs refuses a slot whose static imports reach a
 * component or a stylesheet, so this registry never grows the hub chunk.
 * Slot files import this module with `import type` only (it imports them).
 * A view styles itself with the classes of ./stage-panels.css, which the
 * view component imports; descriptors carry no styles.
 *
 * Registering a view is presentation only (plan §4.3 E8): the Worker decides
 * what she may read or change whatever this file allows. The confirmation
 * routes answer only while online confirmation is effective, and the gallery
 * routes are private media (503 until the whole PM gate holds).
 */

/** Every `?view=` value the hub understands (ADR-001 §2.6). */
export const stageViewIds = [
  'complete',
  'details',
  'gallery',
  'handover',
  'feedback',
] as const

export type StageViewId = (typeof stageViewIds)[number]

export function isStageViewId(value: unknown): value is StageViewId {
  return stageViewIds.some((viewId) => viewId === value)
}

/**
 * What the host hands to every stage view. A view calls the Worker through
 * `useApiClient()` (src/lib/api-client.ts), which supplies her token and
 * turns a missing token into a retryable TOKEN_UNAVAILABLE, never a sign-out.
 */
export interface StageViewProps {
  booking: CustomerBooking
  /** MyBookingsResponse.serverClockOffsetMs, for any countdown in the view. */
  clockOffsetMs: number | null
  /** Closes the view and returns to the booking card. */
  onClose: () => void
  /** Asks the hub to reload her bookings after the view changed something. */
  onBookingChanged: () => void
}

export interface StageViewEntry {
  /** The view's visible Arabic heading. */
  readonly title: string
  /**
   * The journey stages at which the view may open. At any other stage (and
   * for legacy or terminal bookings, which have no stage) the host shows the
   * booking card instead.
   */
  readonly stages: readonly JourneyStageId[]
  /** Optional extra condition (pure; no requests), e.g. online flow only. */
  readonly appliesTo?: (booking: CustomerBooking) => boolean
  /** Code-split only: the result of createRetryableLazy (src/layout). */
  readonly Component: RetryableLazyComponent<StageViewProps>
}

export type StageViewRegistry = Readonly<Partial<Record<StageViewId, StageViewEntry>>>

/**
 * Exactly one slot per view id: the Record type makes a missing or an extra
 * id a compile error.
 */
const stageViewSlots: Readonly<Record<StageViewId, StageViewEntry | null>> = {
  complete: confirmationStageView,
  details: eventProfileStageView,
  gallery: galleryStageView,
  handover: handoverStageView,
  feedback: feedbackStageView,
}

function collectRegisteredViews(
  slots: Readonly<Record<StageViewId, StageViewEntry | null>>,
): StageViewRegistry {
  const registry: Partial<Record<StageViewId, StageViewEntry>> = {}

  for (const viewId of stageViewIds) {
    const entry = slots[viewId]

    if (entry !== null) {
      registry[viewId] = entry
    }
  }

  return registry
}

/** The registered views: the filled slots only (none while all are empty). */
export const stageViews: StageViewRegistry =
  collectRegisteredViews(stageViewSlots)

export interface ResolvedStageView {
  readonly id: StageViewId
  readonly entry: StageViewEntry
}

/**
 * The view to show for a raw `?view=` value, or null for the booking card:
 * no value, an unknown value, a view that is not registered, or one that is
 * not allowed at her current stage.
 */
export function resolveStageView(
  requestedView: string | null,
  booking: CustomerBooking,
  registry: StageViewRegistry = stageViews,
): ResolvedStageView | null {
  if (requestedView === null || !isStageViewId(requestedView)) {
    return null
  }

  const entry = registry[requestedView]
  const stage = booking.stage

  if (entry === undefined || stage === null || !entry.stages.includes(stage)) {
    return null
  }

  if (entry.appliesTo !== undefined && !entry.appliesTo(booking)) {
    return null
  }

  return { id: requestedView, entry }
}

/**
 * The view that serves her current stage, if one is registered and allowed
 * (for the card's next-step button). Null while no slot is filled.
 */
export function findStageViewForBooking(
  booking: CustomerBooking,
  registry: StageViewRegistry = stageViews,
): StageViewId | null {
  for (const viewId of stageViewIds) {
    if (resolveStageView(viewId, booking, registry) !== null) {
      return viewId
    }
  }

  return null
}
