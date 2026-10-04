/**
 * The admin work queue (plan 11 §3.2 #35, W2-10; B1, UX-02, UX-03, UX-05,
 * UX-06, TM-03, GAP-04): the wire contract shared by the Worker
 * (worker/portal/admin-queue.ts) and the admin SPA «اليوم» tab (W3-05),
 * plus the pure rules both sides use. No I/O.
 *
 * One GET answers the whole queue: a «today» summary, the platform health
 * (cron heartbeat, email, outbox, CSP counts), the standing alerts and the
 * sections in ADMIN_QUEUE_SECTION_IDS order, `decide_now` first, each with
 * its fixed `order`, its `total` before the cap and at most
 * ADMIN_QUEUE_SECTION_MAX_ITEMS items; an empty section is omitted (UX-05).
 *
 * Every section has one suggested WhatsApp template (W2-14). An item is a
 * (booking, section) pair: a booking that meets several conditions is listed
 * under each of them, with that section's template, because each one is a
 * different message to her. An item leaves a section only when the
 * booking's state changes (it no longer meets the condition, or something
 * about it changed after the message) or when a `sent` or `dismissed`
 * contact-log row exists for the section's template (UX-06); an `opened`
 * row never removes it, it is only reported as `lastContact`.
 *
 * SB-13 minimisation note (admin-only fields, never sent to a customer):
 * - `waDigits`: the customer's number as E.164 digits, validated by
 *   ADMIN_QUEUE_WA_DIGITS_PATTERN on the server, for the `href` of the
 *   WhatsApp link only. The SPA never renders it as text (UX-03).
 * - `startTime` and `venueArea`: her event details, present only in
 *   `events_today_tomorrow` (null everywhere else).
 * - `templateInputs`: the amount, deadline, slot start, handover method and
 *   album stage one message needs; no free text.
 * - `customerFirstName`: her first name only (no last name, email or phone
 *   as text); null once her data was erased.
 * - `repeatHolds`: counts (GAP-04), never the bookings behind them.
 * Nothing here carries her address, email, notes or a receipt.
 */

import { bookingStatuses, type BookingStatus } from '../admin.js'
import { isJourneyStageId, type JourneyStageId } from '../journey.js'
import type { HandoverMethod } from './handover.js'

// ---------------------------------------------------------------------------
// Limits and thresholds
// ---------------------------------------------------------------------------

/** #35: items per section; `total` still counts every matching booking. */
export const ADMIN_QUEUE_SECTION_MAX_ITEMS = 50

/** `holds_expiring`: a hold whose deadline is at most this far ahead. */
export const ADMIN_QUEUE_HOLD_EXPIRING_HOURS = 24

/** `requests_over_sla`: a request waiting longer than this (TIMING.adminResponseSlaMs). */
export const ADMIN_QUEUE_REQUEST_SLA_HOURS = 24

/** `terms_pending`: terms still not accepted this long after approval. */
export const ADMIN_QUEUE_TERMS_PENDING_HOURS = 12

/** `receipts_pending`: `dueAt` is the upload plus this (TIMING.receiptReviewSlaMs). */
export const ADMIN_QUEUE_RECEIPT_REVIEW_HOURS = 24

/** `events_soon_without_details`: an event at most this many days ahead. */
export const ADMIN_QUEUE_EVENT_SOON_DAYS = 7

/** `feedback_due`: completed at least this long ago (TIMING.feedbackRequestDaysAfter). */
export const ADMIN_QUEUE_FEEDBACK_DUE_DAYS = 2

/** GAP-04: expired and abandoned holds are counted over this window. */
export const ADMIN_QUEUE_REPEAT_HOLD_DAYS = 90

/** GAP-04: `repeatHolds.flagged` from this many expired plus abandoned holds. */
export const ADMIN_QUEUE_REPEAT_HOLD_FLAG_COUNT = 2

/**
 * `health.cronStale`: the quarter-hourly heartbeat's last success is older
 * than this (three missed ticks), or there was never one.
 */
export const ADMIN_QUEUE_CRON_STALE_MINUTES = 45

/** `health.outboxFailed`: failed emails finished within this window. */
export const ADMIN_QUEUE_OUTBOX_FAILED_DAYS = 7

/** `health.outboxSkipped24h`: skipped emails finished within this window. */
export const ADMIN_QUEUE_OUTBOX_SKIPPED_HOURS = 24

/**
 * UX-03: `waDigits` is E.164 digits without the "+": a leading 1–9 and 8 to
 * 15 digits in all, the shape wa.me accepts and the SPA's builder re-checks
 * (src/lib/whatsapp.ts fromE164Digits).
 */
export const ADMIN_QUEUE_WA_DIGITS_PATTERN = /^[1-9]\d{7,14}$/

export function isAdminQueueWaDigits(value: unknown): value is string {
  return typeof value === 'string' && ADMIN_QUEUE_WA_DIGITS_PATTERN.test(value)
}

// ---------------------------------------------------------------------------
// Sections: fixed order, one template each (UX-05, W2-14)
// ---------------------------------------------------------------------------

/**
 * The sections in their fixed order (#35, UX-05). What each one lists:
 * - decide_now: a flow-2 hold past its deadline that the admin must decide
 *   on: notice-protected (she reported the transfer, so no job ever expires
 *   it: confirm the deposit or cancel; B1, UX-02), or unprotected while
 *   automatic expiry is off (no email provider or kill switch pulled: the
 *   admin expires it herself with `expire_hold`; B1 #4).
 * - holds_expiring: an unprotected flow-2 hold whose deadline is within the
 *   next ADMIN_QUEUE_HOLD_EXPIRING_HOURS.
 * - deposit_notices: a notice-protected hold whose deadline has not passed:
 *   she reported the transfer, the deposit waits to be recorded (§6.2 seed:
 *   the notice-protected hold still inside its deadline).
 * - requests_over_sla: `pending_review` for more than the response SLA.
 * - events_today_tomorrow: a confirmed event today or tomorrow (Riyadh);
 *   items add `startTime` and `venueArea`.
 * - handovers_today_tomorrow: a scheduled handover slot today or tomorrow.
 * - terms_pending: a flow-2 hold whose terms are unaccepted more than
 *   ADMIN_QUEUE_TERMS_PENDING_HOURS after approval, deadline still ahead.
 * - bank_mismatch: the bank revision she accepted the terms under is not
 *   the effective one (TM-03): she may hold outdated transfer details.
 * - receipts_pending: a receipt awaiting review (private media open only).
 * - events_soon_without_details: a confirmed event within
 *   ADMIN_QUEUE_EVENT_SOON_DAYS without her event details.
 * - awaiting_production: the event has passed, no album production started
 *   and no gallery is open for selection.
 * - selection_overdue: an open gallery past its selection deadline
 *   (private media open only).
 * - ready_without_handover: the album is ready and no handover is booked
 *   (none, or a cancelled one).
 * - handover_no_show: a missed handover, not yet rebooked.
 * - feedback_due: completed ADMIN_QUEUE_FEEDBACK_DUE_DAYS ago or more, no
 *   feedback, no `feedback_request` email queued or sent.
 */
export const ADMIN_QUEUE_SECTION_IDS = [
  'decide_now',
  'holds_expiring',
  'deposit_notices',
  'requests_over_sla',
  'events_today_tomorrow',
  'handovers_today_tomorrow',
  'terms_pending',
  'bank_mismatch',
  'receipts_pending',
  'events_soon_without_details',
  'awaiting_production',
  'selection_overdue',
  'ready_without_handover',
  'handover_no_show',
  'feedback_due',
] as const

export type AdminQueueSectionId = (typeof ADMIN_QUEUE_SECTION_IDS)[number]

/**
 * The closed list of admin-to-customer WhatsApp template ids, exactly as
 * src/features/admin-contact/whatsapp-templates.ts and
 * worker/portal/admin-booking-log.ts hold it (tests keep the three equal).
 * Repeated here so neither the Worker nor the SPA imports the other side.
 */
export const ADMIN_QUEUE_TEMPLATE_IDS = [
  'request_received',
  'approved_online',
  'approved_legacy',
  'hold_reminder',
  'terms_reminder',
  'deposit_recorded',
  'event_details_request',
  'event_reminder',
  'production_update',
  'album_ready',
  'handover_confirmation',
  'handover_day',
  'feedback_request',
  'offline_selection',
] as const

export type AdminQueueTemplateId = (typeof ADMIN_QUEUE_TEMPLATE_IDS)[number]

/**
 * The one message each section suggests (W2-14). The contact-log row that
 * takes an item off its section (UX-06) is the one for this template.
 * `receipts_pending` suggests the confirmation she gets once the receipt is
 * verified and the deposit recorded; `selection_overdue` the selection nudge.
 */
export const adminQueueSectionTemplates: Readonly<
  Record<AdminQueueSectionId, AdminQueueTemplateId>
> = Object.freeze({
  decide_now: 'hold_reminder',
  holds_expiring: 'hold_reminder',
  deposit_notices: 'hold_reminder',
  requests_over_sla: 'request_received',
  events_today_tomorrow: 'event_reminder',
  handovers_today_tomorrow: 'handover_day',
  terms_pending: 'terms_reminder',
  bank_mismatch: 'hold_reminder',
  receipts_pending: 'deposit_recorded',
  events_soon_without_details: 'event_details_request',
  awaiting_production: 'production_update',
  selection_overdue: 'offline_selection',
  ready_without_handover: 'album_ready',
  handover_no_show: 'handover_confirmation',
  feedback_due: 'feedback_request',
} satisfies Record<AdminQueueSectionId, AdminQueueTemplateId>)

/** The Arabic heading of each section (feminine singular, studio voice). */
export const adminQueueSectionLabels: Readonly<
  Record<AdminQueueSectionId, string>
> = Object.freeze({
  decide_now: 'قرار الآن',
  holds_expiring: 'حجوزات مبدئية تنتهي مهلتها خلال 24 ساعة',
  deposit_notices: 'إشعارات تحويل العربون',
  requests_over_sla: 'طلبات تجاوزت مهلة الرد',
  events_today_tomorrow: 'مناسبات اليوم وغدًا',
  handovers_today_tomorrow: 'مواعيد التسليم اليوم وغدًا',
  terms_pending: 'بانتظار الموافقة على الشروط',
  bank_mismatch: 'تغيّرت بيانات التحويل بعد الموافقة',
  receipts_pending: 'إيصالات بانتظار المراجعة',
  events_soon_without_details: 'مناسبات قريبة دون تفاصيل',
  awaiting_production: 'بانتظار بدء تجهيز الألبوم',
  selection_overdue: 'تأخر اختيار الصور',
  ready_without_handover: 'ألبومات جاهزة دون موعد تسليم',
  handover_no_show: 'مواعيد تسليم فائتة',
  feedback_due: 'بانتظار رأيها في التجربة',
} satisfies Record<AdminQueueSectionId, string>)

/** Sections listed only while private media is open (gate PM, TM-10). */
export const adminQueuePrivateMediaSections: readonly AdminQueueSectionId[] = [
  'receipts_pending',
  'selection_overdue',
]

export function isAdminQueueSectionId(value: unknown): value is AdminQueueSectionId {
  return ADMIN_QUEUE_SECTION_IDS.some((id) => id === value)
}

export function isAdminQueueTemplateId(value: unknown): value is AdminQueueTemplateId {
  return ADMIN_QUEUE_TEMPLATE_IDS.some((id) => id === value)
}

/** The 1-based fixed position of a section (UX-05 `order`). */
export function adminQueueSectionOrder(section: AdminQueueSectionId): number {
  return ADMIN_QUEUE_SECTION_IDS.indexOf(section) + 1
}

// ---------------------------------------------------------------------------
// Alerts (TM-03, H3, C-10)
// ---------------------------------------------------------------------------

/**
 * Standing alerts, in this fixed order:
 * - BANK_DETAILS_CHANGED_RECENTLY: a bank revision was saved within the
 *   72 h fraud-visibility window (`at` = when it was saved);
 * - SETTINGS_CHANGE_PENDING: a bank or contact change saved but not yet in
 *   force (`at` = when it takes effect; cancel = «إلغاء التغيير»);
 * - ONLINE_CONFIRMATION_NOT_OFFERED: flow 2 is not offered to new approvals
 *   (`detail` = SWITCH_OFF | KILL_SWITCH | SETTINGS_INCOMPLETE);
 * - KILL_SWITCH_OFF: the D1 kill switch is pulled (`at` = when);
 * - CRON_STALE: see `health.cronStale` (`at` = the last success, or null);
 * - CSP_VIOLATIONS: `health.cspViolations24h` is above zero.
 */
export const ADMIN_QUEUE_ALERT_CODES = [
  'BANK_DETAILS_CHANGED_RECENTLY',
  'SETTINGS_CHANGE_PENDING',
  'ONLINE_CONFIRMATION_NOT_OFFERED',
  'KILL_SWITCH_OFF',
  'CRON_STALE',
  'CSP_VIOLATIONS',
] as const

export type AdminQueueAlertCode = (typeof ADMIN_QUEUE_ALERT_CODES)[number]

export interface AdminQueueAlert {
  readonly code: AdminQueueAlertCode
  /** The instant the alert refers to (ISO-8601 UTC), when there is one. */
  readonly at: string | null
  /** A fixed code refining the alert (never free text), or null. */
  readonly detail: string | null
}

export function isAdminQueueAlertCode(value: unknown): value is AdminQueueAlertCode {
  return ADMIN_QUEUE_ALERT_CODES.some((code) => code === value)
}

// ---------------------------------------------------------------------------
// #35 GET /api/admin/queue
// ---------------------------------------------------------------------------

export interface AdminQueueSummary {
  /** `decide_now` total. */
  readonly decideNow: number
  /** Items (over every section) whose `dueAt` falls on today's Riyadh date. */
  readonly dueToday: number
  /** Confirmed events on today's Riyadh date. */
  readonly eventsToday: number
  /** Scheduled handover slots on today's Riyadh date. */
  readonly handoversToday: number
}

export interface AdminQueueHealth {
  /** The quarter-hourly heartbeat's last successful tick, or null. */
  readonly cronLastOkAt: string | null
  readonly cronStale: boolean
  /** EM: an email provider is configured (worker/settings/features.ts). */
  readonly emailConfigured: boolean
  /** Emails that failed within ADMIN_QUEUE_OUTBOX_FAILED_DAYS. */
  readonly outboxFailed: number
  /** Emails skipped within ADMIN_QUEUE_OUTBOX_SKIPPED_HOURS. */
  readonly outboxSkipped24h: number
  /** CSP violation reports counted today and yesterday (Riyadh days). */
  readonly cspViolations24h: number
}

/** What one message needs (W2-14 AdminContactTemplateInput); no free text. */
export interface AdminQueueTemplateInputs {
  /** The deposit amount in whole riyals (recorded when known, else expected). */
  readonly amount: number | null
  /** The hold deadline, canonical ISO instant (flow 2). */
  readonly holdExpiresAt: string | null
  /** The booked handover slot's start, canonical ISO instant. */
  readonly slotStartsAt: string | null
  readonly method: HandoverMethod | null
  /** The album stage `production_update` speaks of. */
  readonly productionStage: 'design' | 'printing' | null
}

/** The latest contact-log row for the section's template (any outcome). */
export interface AdminQueueLastContact {
  readonly template: AdminQueueTemplateId
  readonly outcome: 'opened' | 'sent' | 'dismissed'
  readonly at: string
}

/**
 * GAP-04: this customer's hold history over ADMIN_QUEUE_REPEAT_HOLD_DAYS,
 * every booking of hers counted: holds that expired, and holds cancelled
 * while she still owed the deposit (abandoned). `flagged` from
 * ADMIN_QUEUE_REPEAT_HOLD_FLAG_COUNT in all, so the admin can decide before
 * approving her again.
 */
export interface AdminQueueRepeatHolds {
  readonly expired: number
  readonly abandoned: number
  readonly flagged: boolean
}

export interface AdminQueueItem {
  readonly bookingId: string
  /** The reference she sees on her bookings page (the booking id). */
  readonly reference: string
  /** `YYYY-MM-DD`, Asia/Riyadh. */
  readonly eventDate: string
  /** First name only; null once her data was erased. */
  readonly customerFirstName: string | null
  readonly status: BookingStatus
  /** Derived journey stage; null for legacy and closed statuses. */
  readonly stage: JourneyStageId | null
  /** When this item is due (ISO-8601 UTC), or null when nothing is timed. */
  readonly dueAt: string | null
  readonly suggestedTemplate: AdminQueueTemplateId
  /** For the WhatsApp `href` only, never rendered as text (UX-03). */
  readonly waDigits: string | null
  readonly templateInputs: AdminQueueTemplateInputs
  /** `HH:MM` Riyadh; `events_today_tomorrow` only. */
  readonly startTime: string | null
  /** Her venue area; `events_today_tomorrow` only. */
  readonly venueArea: string | null
  readonly lastContact: AdminQueueLastContact | null
  readonly repeatHolds: AdminQueueRepeatHolds
}

export interface AdminQueueSection {
  readonly id: AdminQueueSectionId
  /** The fixed position (UX-05), 1-based. */
  readonly order: number
  /** Matching bookings before the ADMIN_QUEUE_SECTION_MAX_ITEMS cap. */
  readonly total: number
  readonly items: readonly AdminQueueItem[]
}

export interface AdminQueueResponse {
  readonly ok: true
  readonly summary: AdminQueueSummary
  readonly health: AdminQueueHealth
  readonly alerts: readonly AdminQueueAlert[]
  /** Non-empty sections only, in ADMIN_QUEUE_SECTION_IDS order. */
  readonly sections: readonly AdminQueueSection[]
  readonly serverTime: string
}

// ---------------------------------------------------------------------------
// Runtime guard for the SPA (an API answer is untrusted until it is checked)
// ---------------------------------------------------------------------------

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const VENUE_AREA_MAX_LENGTH = 120
const contactOutcomes: ReadonlySet<string> = new Set(['opened', 'sent', 'dismissed'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return bookingStatuses.some((status) => status === value)
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_INSTANT_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isInstant(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableString(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maxLength)
}

function isTemplateInputs(value: unknown): value is AdminQueueTemplateInputs {
  return (
    isRecord(value) &&
    (value.amount === null || isCount(value.amount)) &&
    isNullableInstant(value.holdExpiresAt) &&
    isNullableInstant(value.slotStartsAt) &&
    (value.method === null || value.method === 'pickup' || value.method === 'delivery') &&
    (value.productionStage === null ||
      value.productionStage === 'design' ||
      value.productionStage === 'printing')
  )
}

function isLastContact(value: unknown): value is AdminQueueLastContact | null {
  if (value === null) {
    return true
  }

  return (
    isRecord(value) &&
    isAdminQueueTemplateId(value.template) &&
    typeof value.outcome === 'string' &&
    contactOutcomes.has(value.outcome) &&
    isInstant(value.at)
  )
}

function isRepeatHolds(value: unknown): value is AdminQueueRepeatHolds {
  return (
    isRecord(value) &&
    isCount(value.expired) &&
    isCount(value.abandoned) &&
    typeof value.flagged === 'boolean'
  )
}

export function isAdminQueueItem(value: unknown): value is AdminQueueItem {
  return (
    isRecord(value) &&
    typeof value.bookingId === 'string' &&
    value.bookingId.length > 0 &&
    typeof value.reference === 'string' &&
    value.reference.length > 0 &&
    typeof value.eventDate === 'string' &&
    DATE_KEY_PATTERN.test(value.eventDate) &&
    isNullableString(value.customerFirstName, 80) &&
    isBookingStatus(value.status) &&
    (value.stage === null || isJourneyStageId(value.stage)) &&
    isNullableInstant(value.dueAt) &&
    isAdminQueueTemplateId(value.suggestedTemplate) &&
    (value.waDigits === null || isAdminQueueWaDigits(value.waDigits)) &&
    isTemplateInputs(value.templateInputs) &&
    (value.startTime === null ||
      (typeof value.startTime === 'string' && LOCAL_TIME_PATTERN.test(value.startTime))) &&
    isNullableString(value.venueArea, VENUE_AREA_MAX_LENGTH) &&
    isLastContact(value.lastContact) &&
    isRepeatHolds(value.repeatHolds)
  )
}

export function isAdminQueueSection(value: unknown): value is AdminQueueSection {
  return (
    isRecord(value) &&
    isAdminQueueSectionId(value.id) &&
    value.order === adminQueueSectionOrder(value.id) &&
    isCount(value.total) &&
    Array.isArray(value.items) &&
    value.items.length <= ADMIN_QUEUE_SECTION_MAX_ITEMS &&
    value.items.length <= value.total &&
    value.items.every(isAdminQueueItem)
  )
}

function isSummary(value: unknown): value is AdminQueueSummary {
  return (
    isRecord(value) &&
    isCount(value.decideNow) &&
    isCount(value.dueToday) &&
    isCount(value.eventsToday) &&
    isCount(value.handoversToday)
  )
}

function isHealth(value: unknown): value is AdminQueueHealth {
  return (
    isRecord(value) &&
    isNullableInstant(value.cronLastOkAt) &&
    typeof value.cronStale === 'boolean' &&
    typeof value.emailConfigured === 'boolean' &&
    isCount(value.outboxFailed) &&
    isCount(value.outboxSkipped24h) &&
    isCount(value.cspViolations24h)
  )
}

function isAlert(value: unknown): value is AdminQueueAlert {
  return (
    isRecord(value) &&
    isAdminQueueAlertCode(value.code) &&
    isNullableInstant(value.at) &&
    isNullableString(value.detail, 64)
  )
}

/** Sections in the fixed order, none repeated, none empty. */
function isSectionList(value: unknown): value is readonly AdminQueueSection[] {
  if (!Array.isArray(value) || !value.every(isAdminQueueSection)) {
    return false
  }

  return value.every(
    (section, index) =>
      section.items.length > 0 &&
      (index === 0 || value[index - 1].order < section.order),
  )
}

/** True for an answer in exactly the #35 shape. */
export function isAdminQueueResponse(value: unknown): value is AdminQueueResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isSummary(value.summary) &&
    isHealth(value.health) &&
    Array.isArray(value.alerts) &&
    value.alerts.every(isAlert) &&
    isSectionList(value.sections) &&
    isInstant(value.serverTime)
  )
}
