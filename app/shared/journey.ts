/**
 * The customer journey — ADR-001 §2.1 (stage table) and 08-copy-ar §4.1
 * (labels). Stages are DERIVED from stored facts, never stored themselves.
 *
 * One pure function, `deriveJourneyStage`, is the single source of truth for
 * the Worker (GET /api/bookings/me, later the cron jobs and emails) and the
 * SPA (journey tracker). It performs no I/O. Callers should pass `now` (it
 * defaults to the current instant) so one request derives every booking
 * against the same clock; "today" is always the Asia/Riyadh calendar date of
 * that instant (`riyadhDateKey`).
 */

import type { BookingStatus } from './admin.js'
import {
  TIMING,
  addMsToInstant,
  isValidDateKey,
  parseInstant,
  riyadhDateKey,
} from './timing.js'

// ---------------------------------------------------------------------------
// Stage ids, labels and order
// ---------------------------------------------------------------------------

/** The 15 journey stages, in journey order (index 0 is stage 1). */
export const journeyStageIds = [
  'pending_review',
  'approved_hold',
  'terms_and_receipt_pending',
  'receipt_review',
  'confirmed',
  'pre_event_engagement',
  'gallery_open',
  'gallery_locked',
  'album_design',
  'album_printing',
  'album_ready',
  'handover_scheduling',
  'handover_day',
  'completed_feedback',
  'privacy_cleanup',
] as const

export type JourneyStageId = (typeof journeyStageIds)[number]

/** Exact Arabic labels from 08-copy-ar §4.1 (feminine singular address). */
export const journeyStageLabels: Readonly<Record<JourneyStageId, string>> =
  Object.freeze({
    pending_review: 'قيد المراجعة',
    approved_hold: 'تم القبول — التاريخ محجوز مؤقتًا',
    terms_and_receipt_pending: 'أكملي حجزكِ',
    receipt_review: 'مراجعة الإيصال',
    confirmed: 'الحجز مؤكد',
    pre_event_engagement: 'تفاصيل يومكِ',
    gallery_open: 'معرض صوركِ',
    gallery_locked: 'تم إرسال اختياركِ',
    album_design: 'الألبوم قيد التصميم',
    album_printing: 'الألبوم قيد الطباعة',
    album_ready: 'الألبوم جاهز',
    handover_scheduling: 'احجزي موعد الاستلام',
    handover_day: 'يوم التسليم',
    completed_feedback: 'تم التسليم',
    privacy_cleanup: 'الخصوصية والحذف التلقائي',
  } satisfies Record<JourneyStageId, string>)

export const JOURNEY_STAGE_COUNT = journeyStageIds.length

export function isJourneyStageId(value: unknown): value is JourneyStageId {
  return journeyStageIds.some((stage) => stage === value)
}

/** The 1-based position of a stage in the journey (1–15). */
export function getJourneyStageNumber(stage: JourneyStageId): number {
  return journeyStageIds.indexOf(stage) + 1
}

// ---------------------------------------------------------------------------
// Deadlines: what a stage's deadline IS is fixed by the stage itself
// ---------------------------------------------------------------------------

/**
 * `instant` — an ISO-8601 UTC instant (hold deadline, selection deadline,
 * slot start, preview purge date). `date` — a `YYYY-MM-DD` Asia/Riyadh
 * calendar date (the event day). `none` — the stage never has a deadline.
 */
export type JourneyDeadlineKind = 'instant' | 'date' | 'none'

export const journeyStageDeadlineKinds: Readonly<
  Record<JourneyStageId, JourneyDeadlineKind>
> = Object.freeze({
  pending_review: 'none',
  approved_hold: 'instant',
  terms_and_receipt_pending: 'instant',
  receipt_review: 'none',
  confirmed: 'date',
  pre_event_engagement: 'date',
  gallery_open: 'instant',
  gallery_locked: 'none',
  album_design: 'none',
  album_printing: 'none',
  album_ready: 'none',
  handover_scheduling: 'instant',
  handover_day: 'instant',
  completed_feedback: 'instant',
  privacy_cleanup: 'none',
} satisfies Record<JourneyStageId, JourneyDeadlineKind>)

export type JourneyDeadline =
  | { readonly kind: 'instant'; readonly value: string }
  | { readonly kind: 'date'; readonly value: string }

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/** True for a real ISO-8601 instant with an explicit offset (e.g. `…Z`). */
export function isIsoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_INSTANT_PATTERN.test(value) &&
    parseInstant(value) !== null
  )
}

/** The wire form of a deadline (`stageDeadline` in GET /api/bookings/me). */
export function serializeJourneyDeadline(
  deadline: JourneyDeadline | null,
): string | null {
  return deadline === null ? null : deadline.value
}

/**
 * Reads a wire `stageDeadline` back into a typed deadline. The kind is taken
 * from the stage, so a value of the wrong shape for its stage is rejected
 * (null) instead of being misread.
 */
export function parseJourneyDeadline(
  stage: JourneyStageId,
  value: unknown,
): JourneyDeadline | null {
  if (typeof value !== 'string') {
    return null
  }

  switch (journeyStageDeadlineKinds[stage]) {
    case 'instant': {
      const instant = isIsoInstant(value) ? toCanonicalInstant(value) : null
      return instant === null ? null : { kind: 'instant', value: instant }
    }
    case 'date':
      return isValidDateKey(value) ? { kind: 'date', value } : null
    case 'none':
      return null
  }
}

// ---------------------------------------------------------------------------
// Sub-states: refinements of a stage that change what she is shown
// ---------------------------------------------------------------------------

export const journeySubStates = [
  /** Stage 2 on the legacy manual path (flow 1): legacy guidance, no button. */
  'legacy_flow',
  /** Stage 3 because her latest receipt was rejected (she sees the reason). */
  'receipt_rejected',
  /** Stage 6 after the event day, until a gallery opens («نجهّز معاينات صوركِ»). */
  'awaiting_previews',
  /** Stage 12 after a missed handover appointment: she books a new slot. */
  'handover_missed',
] as const

export type JourneySubState = (typeof journeySubStates)[number]

export function isJourneySubState(value: unknown): value is JourneySubState {
  return journeySubStates.some((subState) => subState === value)
}

// ---------------------------------------------------------------------------
// Facts (what the loader reads) and the derivation result
// ---------------------------------------------------------------------------

export const flowVersions = [1, 2] as const
export type FlowVersion = (typeof flowVersions)[number]

export function isFlowVersion(value: unknown): value is FlowVersion {
  return flowVersions.some((version) => version === value)
}

export const journeyReceiptStatuses = [
  'pending',
  'verified',
  'rejected',
  'void',
] as const
export type JourneyReceiptStatus = (typeof journeyReceiptStatuses)[number]

export const journeyGalleryStatuses = [
  'draft',
  'open',
  'locked',
  'purged',
] as const
export type JourneyGalleryStatus = (typeof journeyGalleryStatuses)[number]

export const journeyAlbumStages = ['design', 'printing', 'ready'] as const
export type JourneyAlbumStage = (typeof journeyAlbumStages)[number]

export const journeyHandoverStatuses = [
  'scheduled',
  'completed',
  'no_show',
  'cancelled',
] as const
export type JourneyHandoverStatus = (typeof journeyHandoverStatuses)[number]

export function isJourneyReceiptStatus(
  value: unknown,
): value is JourneyReceiptStatus {
  return journeyReceiptStatuses.some((status) => status === value)
}

export function isJourneyGalleryStatus(
  value: unknown,
): value is JourneyGalleryStatus {
  return journeyGalleryStatuses.some((status) => status === value)
}

export function isJourneyAlbumStage(value: unknown): value is JourneyAlbumStage {
  return journeyAlbumStages.some((stage) => stage === value)
}

export function isJourneyHandoverStatus(
  value: unknown,
): value is JourneyHandoverStatus {
  return journeyHandoverStatuses.some((status) => status === value)
}

export interface JourneyGalleryFacts {
  readonly status: JourneyGalleryStatus
  /** ISO instant; set while the gallery is open (soft deadline). */
  readonly selectionDeadline: string | null
  /** ISO instant; set once she submitted her selection. */
  readonly submittedAt: string | null
}

export interface JourneyHandoverFacts {
  readonly status: JourneyHandoverStatus
  /** ISO instant of the booked slot's start; its Riyadh date is `slot_date`. */
  readonly slotStartsAt: string | null
  /** ISO instant; set when the handover was completed. */
  readonly completedAt: string | null
}

/** Everything `deriveJourneyStage` needs about one booking. */
export interface JourneyFacts {
  readonly status: BookingStatus
  readonly flowVersion: FlowVersion
  /** `YYYY-MM-DD`, Asia/Riyadh. */
  readonly eventDate: string
  /** ISO instant (flow 2 holds). */
  readonly holdExpiresAt: string | null
  /** `booking_requests.completed_at`: the completion signal for stages 14–15. */
  readonly completedAt: string | null
  /** Status of the receipt with the highest `attempt_no`, if any. */
  readonly latestReceiptStatus: JourneyReceiptStatus | null
  readonly hasEventProfile: boolean
  readonly gallery: JourneyGalleryFacts | null
  readonly albumStage: JourneyAlbumStage | null
  readonly handover: JourneyHandoverFacts | null
}

/** Why a booking has no journey stage (it then renders exactly as today). */
export type JourneyNoStageReason = 'legacy_status' | 'terminal_status'

export type JourneyStageResult =
  | {
      readonly stage: null
      readonly reason: JourneyNoStageReason
      readonly deadline: null
      readonly subState: null
    }
  | {
      readonly stage: JourneyStageId
      readonly reason: null
      readonly deadline: JourneyDeadline | null
      readonly subState: JourneySubState | null
    }

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** Canonical `YYYY-MM-DDTHH:MM:SS.sssZ`, or null when unparseable. */
function toCanonicalInstant(value: string | null): string | null {
  const parsed = parseInstant(value)
  return parsed === null ? null : parsed.toISOString()
}

function instantDeadline(value: string | null): JourneyDeadline | null {
  const instant = toCanonicalInstant(value)
  return instant === null ? null : { kind: 'instant', value: instant }
}

function noStage(reason: JourneyNoStageReason): JourneyStageResult {
  return { stage: null, reason, deadline: null, subState: null }
}

function atStage(
  stage: JourneyStageId,
  deadline: JourneyDeadline | null = null,
  subState: JourneySubState | null = null,
): JourneyStageResult {
  return { stage, reason: null, deadline, subState }
}

/** The instant the booking was completed, if it was (stages 14–15). */
function completionInstant(facts: JourneyFacts): string | null {
  const bookingCompletedAt = toCanonicalInstant(facts.completedAt)

  if (bookingCompletedAt !== null) {
    return bookingCompletedAt
  }

  // The admin stamps both columns in one batch (ADR §2.5); this fallback only
  // keeps a half-written completion from hiding the final stages.
  if (facts.handover?.status === 'completed') {
    return toCanonicalInstant(facts.handover.completedAt)
  }

  return null
}

function deriveCompletedStage(
  facts: JourneyFacts,
  completedAt: string | null,
): JourneyStageResult {
  const gallery = facts.gallery

  // A draft gallery was never shown to her, so it counts as "never one".
  if (gallery === null || gallery.status === 'draft' || gallery.status === 'purged') {
    return atStage('privacy_cleanup')
  }

  // Previews are purged `previewRetentionMs` after completion (D5).
  const completed = parseInstant(completedAt)
  const purgeAt =
    completed === null ? null : addMsToInstant(completed, TIMING.previewRetentionMs)

  return atStage('completed_feedback', instantDeadline(purgeAt))
}

function deriveHandoverStage(
  handover: JourneyHandoverFacts,
  today: string,
): JourneyStageResult | null {
  switch (handover.status) {
    case 'scheduled': {
      const startsAt = parseInstant(handover.slotStartsAt)

      if (startsAt === null) {
        return atStage('handover_scheduling')
      }

      const slotDate = riyadhDateKey(startsAt)
      const deadline: JourneyDeadline = {
        kind: 'instant',
        value: startsAt.toISOString(),
      }

      return today < slotDate
        ? atStage('handover_scheduling', deadline)
        : atStage('handover_day', deadline)
    }
    case 'no_show':
      return atStage('handover_scheduling', null, 'handover_missed')
    case 'completed':
      // Handled earlier by the completion branch of deriveConfirmedStage.
      return null
    case 'cancelled':
      // A cancelled appointment no longer holds a slot: fall back to the album.
      return null
  }
}

function deriveAlbumStage(albumStage: JourneyAlbumStage): JourneyStageResult {
  switch (albumStage) {
    case 'design':
      return atStage('album_design')
    case 'printing':
      return atStage('album_printing')
    case 'ready':
      return atStage('album_ready')
  }
}

function deriveGalleryStage(
  gallery: JourneyGalleryFacts,
): JourneyStageResult | null {
  switch (gallery.status) {
    case 'open':
      return atStage('gallery_open', instantDeadline(gallery.selectionDeadline))
    case 'locked':
      return atStage('gallery_locked')
    case 'purged':
      // Previews removed before completion (e.g. an erasure request): her
      // submitted choice still stands; without one she waits on the studio.
      return gallery.submittedAt === null ? null : atStage('gallery_locked')
    case 'draft':
      // Not visible to her yet.
      return null
  }
}

function deriveConfirmedStage(
  facts: JourneyFacts,
  today: string,
): JourneyStageResult {
  const completedAt = completionInstant(facts)

  if (completedAt !== null || facts.handover?.status === 'completed') {
    return deriveCompletedStage(facts, completedAt)
  }

  if (facts.handover !== null) {
    const handoverStage = deriveHandoverStage(facts.handover, today)

    if (handoverStage !== null) {
      return handoverStage
    }
  }

  if (facts.albumStage !== null) {
    return deriveAlbumStage(facts.albumStage)
  }

  if (facts.gallery !== null) {
    const galleryStage = deriveGalleryStage(facts.gallery)

    if (galleryStage !== null) {
      return galleryStage
    }
  }

  if (!isValidDateKey(facts.eventDate)) {
    return facts.hasEventProfile
      ? atStage('pre_event_engagement')
      : atStage('confirmed')
  }

  if (today > facts.eventDate) {
    // After the event and until a gallery opens (ADR §2.1, stage 6).
    return atStage('pre_event_engagement', null, 'awaiting_previews')
  }

  const eventDeadline: JourneyDeadline = { kind: 'date', value: facts.eventDate }

  return facts.hasEventProfile
    ? atStage('pre_event_engagement', eventDeadline)
    : atStage('confirmed', eventDeadline)
}

/**
 * Derives her current journey stage — ADR-001 §2.1, exactly:
 *
 * - `pending_review` → stage 1 (every new request is flow 1 until approval).
 * - `approved_hold` → stage 2; flow 2 counts down to `hold_expires_at`,
 *   flow 1 shows the legacy guidance (`legacy_flow`, no deadline).
 * - `payment_pending` (flow 2) → stage 4 while the latest receipt awaits
 *   review; stage 3 (`receipt_rejected`) when it was rejected.
 * - `confirmed` (either flow) → stages 5–15 from the child tables, the most
 *   advanced fact winning: completion, handover, album, gallery, then the
 *   event date and the pre-event questionnaire.
 * - Legacy statuses (`contract_pending`, `contract_signed`, flow-1
 *   `payment_pending`) and terminal statuses (`rejected`, `cancelled`,
 *   `expired`) → no stage.
 *
 * A passed hold or selection deadline does not change the stage: the server
 * enforces deadlines, and the client compares against `serverTime`.
 */
export function deriveJourneyStage(
  facts: JourneyFacts,
  now: Date = new Date(),
): JourneyStageResult {
  switch (facts.status) {
    case 'pending_review':
      return atStage('pending_review')

    case 'approved_hold':
      return facts.flowVersion === 2
        ? atStage('approved_hold', instantDeadline(facts.holdExpiresAt))
        : atStage('approved_hold', null, 'legacy_flow')

    case 'payment_pending':
      return facts.flowVersion === 2
        ? derivePaymentPendingStage(facts)
        : noStage('legacy_status')

    case 'confirmed':
      return deriveConfirmedStage(facts, riyadhDateKey(now))

    case 'contract_pending':
    case 'contract_signed':
      return noStage('legacy_status')

    case 'rejected':
    case 'cancelled':
    case 'expired':
      return noStage('terminal_status')

    default:
      return unknownStatus(facts.status)
  }
}

/** Flow 2 `payment_pending`: the latest receipt decides between stages 3 and 4. */
function derivePaymentPendingStage(facts: JourneyFacts): JourneyStageResult {
  switch (facts.latestReceiptStatus) {
    case 'pending':
    case 'verified':
      // A verified receipt on a still-pending booking is mid-confirmation:
      // she has nothing left to do.
      return atStage('receipt_review')
    case 'rejected':
      return atStage(
        'terms_and_receipt_pending',
        instantDeadline(facts.holdExpiresAt),
        'receipt_rejected',
      )
    case 'void':
    case null:
      return atStage(
        'terms_and_receipt_pending',
        instantDeadline(facts.holdExpiresAt),
      )
  }
}

/**
 * Compile-time exhaustiveness check over `BookingStatus`: adding a status to
 * shared/admin.ts fails the build here until the journey handles it. At run
 * time an unexpected value maps to no stage (the card renders as today).
 */
function unknownStatus(status: never): JourneyStageResult {
  void status
  return noStage('legacy_status')
}
