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

/**
 * Stage 2 on flow 2 once she accepted the terms (plan 11 §3.3 #1, UX-02).
 * Kept apart from `journeySubStates`, which each carry a tracker note
 * (src/features/journey/journey-phases.ts): these two are the hub's own
 * copy for the deposit step, and they only ever refine `approved_hold`.
 */
export const journeyDepositSubStates = [
  /** Terms accepted; no deposit notice for the current hold deadline yet. */
  'awaiting_deposit',
  /**
   * She reported the transfer: a `deposit_notice_sent` event exists for the
   * CURRENT hold deadline («أبلغتِنا بالتحويل، وسنؤكد استلام العربون
   * ونبلغكِ»). A notice never moves the deadline (N-19); it only protects
   * the hold until the studio confirms or cancels (B1).
   */
  'deposit_reported',
] as const

export type JourneyDepositSubState = (typeof journeyDepositSubStates)[number]

export function isJourneyDepositSubState(
  value: unknown,
): value is JourneyDepositSubState {
  return journeyDepositSubStates.some((subState) => subState === value)
}

/** Every value `stageSubState` of GET /api/bookings/me can carry. */
export type JourneyStageSubState = JourneySubState | JourneyDepositSubState

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

/**
 * When each fact that can define a stage last changed (UX-14). Values are
 * stored instants; only an ISO instant with an explicit offset is used (a
 * legacy `YYYY-MM-DD HH:MM:SS` default would be read in local time), so
 * anything else counts as unknown.
 */
export interface JourneyStageTimes {
  /** The latest `booking_status_history` row INTO the current status. */
  readonly statusChangedAt: string | null
  /** The current-deadline `deposit_notice_sent` event (with the notice fact). */
  readonly depositNoticeSentAt: string | null
  /** The latest receipt: its review, else its upload. */
  readonly latestReceiptAt: string | null
  /** `event_profiles.created_at`: when she first sent her event details. */
  readonly eventProfileCreatedAt: string | null
  readonly galleryOpenedAt: string | null
  readonly galleryPurgedAt: string | null
  /** `album_production.updated_at`: the last album stage change. */
  readonly albumStageChangedAt: string | null
  /** `handovers.updated_at`: booked, rescheduled, missed or completed. */
  readonly handoverChangedAt: string | null
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
  /*
   * Journey facts v2 (plan 11 §3.3 #1). They never change the stage or the
   * deadline, only the deposit sub-state and `updatedAt`, so a reader that
   * needs the stage alone (the admin calendar and export) may leave them
   * out: without them no deposit sub-state is derived and `updatedAt` is
   * null. worker/portal/journey-loader.ts always sets all three.
   */
  /** `booking_requests.terms_accepted_at` (flow 2). */
  readonly termsAcceptedAt?: string | null
  /**
   * A `deposit_notice_sent` event exists whose `details.holdExpiresAt` is
   * the booking's CURRENT `hold_expires_at` (B1, UX-02): the definition the
   * hold jobs and the queue use. A notice for an earlier deadline is false.
   */
  readonly noticeForCurrentDeadline?: boolean
  readonly stageUpdatedAt?: JourneyStageTimes
}

/** Why a booking has no journey stage (it then renders exactly as today). */
export type JourneyNoStageReason = 'legacy_status' | 'terminal_status'

export type JourneyStageResult =
  | {
      readonly stage: null
      readonly reason: JourneyNoStageReason
      readonly deadline: null
      readonly subState: null
      readonly updatedAt: null
    }
  | {
      readonly stage: JourneyStageId
      readonly reason: null
      readonly deadline: JourneyDeadline | null
      readonly subState: JourneyStageSubState | null
      /**
       * `stageUpdatedAt` of GET /api/bookings/me: the canonical instant of
       * the status change or stage event behind the current stage (UX-14),
       * or null when it is not known.
       */
      readonly updatedAt: string | null
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

/**
 * A stored instant as the wire `stageUpdatedAt` (canonical), or null: an
 * absent v2 fact, a NULL column, or a value without an explicit offset (the
 * `CURRENT_TIMESTAMP` default of the 0003 status history) all read as
 * unknown rather than as a guessed time.
 */
function stageTime(value: string | null | undefined): string | null {
  return isIsoInstant(value) ? toCanonicalInstant(value) : null
}

function noStage(reason: JourneyNoStageReason): JourneyStageResult {
  return { stage: null, reason, deadline: null, subState: null, updatedAt: null }
}

function atStage(
  stage: JourneyStageId,
  deadline: JourneyDeadline | null = null,
  subState: JourneyStageSubState | null = null,
  updatedAt: string | null = null,
): JourneyStageResult {
  return { stage, reason: null, deadline, subState, updatedAt }
}

/**
 * The deposit step of a flow-2 hold (UX-02): once she accepted the terms,
 * `awaiting_deposit`, and `deposit_reported` from the moment a notice for
 * the CURRENT deadline exists. Null before the terms, on flow 1, outside
 * `approved_hold`, and when the caller passed no v2 facts.
 */
function deriveDepositSubState(
  facts: JourneyFacts,
): JourneyDepositSubState | null {
  if (
    facts.status !== 'approved_hold' ||
    facts.flowVersion !== 2 ||
    !isIsoInstant(facts.termsAcceptedAt)
  ) {
    return null
  }

  return facts.noticeForCurrentDeadline === true
    ? 'deposit_reported'
    : 'awaiting_deposit'
}

/** Stage 2 on flow 2: the deadline, the deposit step and its defining instant. */
function deriveApprovedHoldStage(facts: JourneyFacts): JourneyStageResult {
  const times = facts.stageUpdatedAt
  const statusChangedAt = stageTime(times?.statusChangedAt)
  const subState = deriveDepositSubState(facts)
  let updatedAt = statusChangedAt

  if (subState === 'deposit_reported') {
    updatedAt = stageTime(times?.depositNoticeSentAt) ?? statusChangedAt
  } else if (subState === 'awaiting_deposit') {
    updatedAt = stageTime(facts.termsAcceptedAt) ?? statusChangedAt
  }

  return atStage(
    'approved_hold',
    instantDeadline(facts.holdExpiresAt),
    subState,
    updatedAt,
  )
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
    return atStage(
      'privacy_cleanup',
      null,
      null,
      stageTime(facts.stageUpdatedAt?.galleryPurgedAt) ?? completedAt,
    )
  }

  // Previews are purged `previewRetentionMs` after completion (D5).
  const completed = parseInstant(completedAt)
  const purgeAt =
    completed === null ? null : addMsToInstant(completed, TIMING.previewRetentionMs)

  return atStage('completed_feedback', instantDeadline(purgeAt), null, completedAt)
}

function deriveHandoverStage(
  handover: JourneyHandoverFacts,
  today: string,
  changedAt: string | null,
): JourneyStageResult | null {
  switch (handover.status) {
    case 'scheduled': {
      const startsAt = parseInstant(handover.slotStartsAt)

      if (startsAt === null) {
        return atStage('handover_scheduling', null, null, changedAt)
      }

      const slotDate = riyadhDateKey(startsAt)
      const deadline: JourneyDeadline = {
        kind: 'instant',
        value: startsAt.toISOString(),
      }

      return today < slotDate
        ? atStage('handover_scheduling', deadline, null, changedAt)
        : atStage('handover_day', deadline, null, changedAt)
    }
    case 'no_show':
      return atStage('handover_scheduling', null, 'handover_missed', changedAt)
    case 'completed':
      // Handled earlier by the completion branch of deriveConfirmedStage.
      return null
    case 'cancelled':
      // A cancelled appointment no longer holds a slot: fall back to the album.
      return null
  }
}

function deriveAlbumStage(
  albumStage: JourneyAlbumStage,
  changedAt: string | null,
): JourneyStageResult {
  switch (albumStage) {
    case 'design':
      return atStage('album_design', null, null, changedAt)
    case 'printing':
      return atStage('album_printing', null, null, changedAt)
    case 'ready':
      return atStage('album_ready', null, null, changedAt)
  }
}

function deriveGalleryStage(
  gallery: JourneyGalleryFacts,
  openedAt: string | null,
): JourneyStageResult | null {
  switch (gallery.status) {
    case 'open':
      return atStage(
        'gallery_open',
        instantDeadline(gallery.selectionDeadline),
        null,
        openedAt,
      )
    case 'locked':
      return atStage('gallery_locked', null, null, stageTime(gallery.submittedAt))
    case 'purged':
      // Previews removed before completion (e.g. an erasure request): her
      // submitted choice still stands; without one she waits on the studio.
      return gallery.submittedAt === null
        ? null
        : atStage('gallery_locked', null, null, stageTime(gallery.submittedAt))
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

  const times = facts.stageUpdatedAt

  if (facts.handover !== null) {
    const handoverStage = deriveHandoverStage(
      facts.handover,
      today,
      stageTime(times?.handoverChangedAt),
    )

    if (handoverStage !== null) {
      return handoverStage
    }
  }

  if (facts.albumStage !== null) {
    return deriveAlbumStage(
      facts.albumStage,
      stageTime(times?.albumStageChangedAt),
    )
  }

  if (facts.gallery !== null) {
    const galleryStage = deriveGalleryStage(
      facts.gallery,
      stageTime(times?.galleryOpenedAt),
    )

    if (galleryStage !== null) {
      return galleryStage
    }
  }

  // Stages 5–6 are defined by the confirmation, then by her event details.
  const confirmedAt = stageTime(times?.statusChangedAt)
  const detailsAt = facts.hasEventProfile
    ? (stageTime(times?.eventProfileCreatedAt) ?? confirmedAt)
    : confirmedAt

  if (!isValidDateKey(facts.eventDate)) {
    return facts.hasEventProfile
      ? atStage('pre_event_engagement', null, null, detailsAt)
      : atStage('confirmed', null, null, confirmedAt)
  }

  if (today > facts.eventDate) {
    // After the event and until a gallery opens (ADR §2.1, stage 6).
    return atStage('pre_event_engagement', null, 'awaiting_previews', detailsAt)
  }

  const eventDeadline: JourneyDeadline = { kind: 'date', value: facts.eventDate }

  return facts.hasEventProfile
    ? atStage('pre_event_engagement', eventDeadline, null, detailsAt)
    : atStage('confirmed', eventDeadline, null, confirmedAt)
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
 *
 * With the v2 facts (`termsAcceptedAt`, `noticeForCurrentDeadline`,
 * `stageUpdatedAt`) the result also carries the deposit sub-state of a
 * flow-2 hold (UX-02) and `updatedAt`, the instant of the status change or
 * stage event that defines the stage (UX-14). Without them the result is
 * exactly what it was before: no deposit sub-state, `updatedAt` null.
 */
export function deriveJourneyStage(
  facts: JourneyFacts,
  now: Date = new Date(),
): JourneyStageResult {
  const result = deriveStageFromFacts(facts, now)

  // The v1 facts can define an instant on their own (a gallery submission,
  // the completion), but a reader that passed no stage times asked for the
  // pre-Wave-2 result, so `updatedAt` stays null for it.
  return facts.stageUpdatedAt === undefined && result.stage !== null
    ? { ...result, updatedAt: null }
    : result
}

function deriveStageFromFacts(
  facts: JourneyFacts,
  now: Date,
): JourneyStageResult {
  switch (facts.status) {
    case 'pending_review':
      return atStage(
        'pending_review',
        null,
        null,
        stageTime(facts.stageUpdatedAt?.statusChangedAt),
      )

    case 'approved_hold':
      return facts.flowVersion === 2
        ? deriveApprovedHoldStage(facts)
        : atStage(
            'approved_hold',
            null,
            'legacy_flow',
            stageTime(facts.stageUpdatedAt?.statusChangedAt),
          )

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
  const times = facts.stageUpdatedAt
  const statusChangedAt = stageTime(times?.statusChangedAt)
  // The receipt's review, else its upload, defines stages 3 and 4.
  const receiptAt = stageTime(times?.latestReceiptAt) ?? statusChangedAt

  switch (facts.latestReceiptStatus) {
    case 'pending':
    case 'verified':
      // A verified receipt on a still-pending booking is mid-confirmation:
      // she has nothing left to do.
      return atStage('receipt_review', null, null, receiptAt)
    case 'rejected':
      return atStage(
        'terms_and_receipt_pending',
        instantDeadline(facts.holdExpiresAt),
        'receipt_rejected',
        receiptAt,
      )
    case 'void':
    case null:
      return atStage(
        'terms_and_receipt_pending',
        instantDeadline(facts.holdExpiresAt),
        null,
        statusChangedAt,
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
