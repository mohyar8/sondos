import { toAsciiDigits } from '../text.js'
import {
  addDaysToDateKey,
  BOOKING_HORIZON_DAYS,
  daysBetweenDateKeys,
  isValidDateKey,
  isValidLocalTime,
  riyadhLocalToInstant,
} from '../timing.js'

/**
 * Handover slot and admin handover contract (plan 11 §3.2 #24, #28, §3.3
 * #24, #28; TM-15, M2). Shared by the Worker (worker/portal/
 * admin-handover-slots.ts, worker/portal/admin-handover.ts), which has the
 * final word, and the admin handover section and slots tab (W3-10), which
 * read the same shapes and show the same verdicts. Pure: no I/O, no
 * logging, no clock (the caller passes today's Riyadh date key and now).
 *
 * - `GET    /api/admin/handover-slots?from&to` (Riyadh date keys, at most
 *   92 days apart) → AdminHandoverSlotsResponse, each slot with its
 *   bookedCount (scheduled handovers).
 * - `POST   /api/admin/handover-slots` `{ startsAt, endsAt, method,
 *   capacity }` → 201 AdminHandoverSlotResponse (409 SLOT_ALREADY_EXISTS
 *   for the same start and method).
 * - `POST   /api/admin/handover-slots/generate` `{ fromDate, toDate,
 *   weekdays, times: [{ start, end }], method, capacity }` → at most
 *   HANDOVER_SLOT_GENERATION_MAX slots, Riyadh wall-clock times converted
 *   with riyadhLocalToInstant; existing slots skipped →
 *   AdminHandoverSlotsGeneratedResponse.
 * - `PATCH  /api/admin/handover-slots/{slotId}` `{ capacity?, isActive? }`
 *   → AdminHandoverSlotResponse (409 CAPACITY_BELOW_BOOKED,
 *   SLOT_HAS_BOOKINGS).
 * - `DELETE /api/admin/handover-slots/{slotId}` → `{ deleted }`, only for a
 *   slot no handover ever referenced (409 SLOT_HAS_BOOKINGS).
 * - `GET    /api/admin/bookings/{id}/handover` → AdminHandoverResponse.
 * - `PATCH  /api/admin/bookings/{id}/handover` `{ action: "complete" |
 *   "no_show" | "cancel" }` or `{ action: "reassign", slotId }` → the same
 *   shape, after the change (or unchanged when it was already done).
 *
 * Digits typed on an Arabic keyboard (dates, times) are normalised with
 * toAsciiDigits before validation (UX-07, N-55). Every check here is
 * repeated inside the Worker's writing statement where it guards capacity
 * or state (TM-15); these parsers only shape the input.
 */

/** handover_slots.method (0005 CHECK). */
export const HANDOVER_SLOT_METHODS = ['pickup', 'delivery', 'both'] as const

export type HandoverSlotMethod = (typeof HANDOVER_SLOT_METHODS)[number]

/** handovers.method (0005 CHECK). */
export const HANDOVER_METHODS = ['pickup', 'delivery'] as const

export type HandoverMethod = (typeof HANDOVER_METHODS)[number]

/** handovers.status (0005 CHECK). */
export const HANDOVER_STATUSES = [
  'scheduled',
  'completed',
  'no_show',
  'cancelled',
] as const

export type HandoverStatus = (typeof HANDOVER_STATUSES)[number]

/** The admin's actions on one booking's handover (#24). */
export const ADMIN_HANDOVER_ACTIONS = [
  'complete',
  'no_show',
  'cancel',
  'reassign',
] as const

export type AdminHandoverAction = (typeof ADMIN_HANDOVER_ACTIONS)[number]

/** handover_slots.capacity CHECK: 1–20. */
export const HANDOVER_SLOT_CAPACITY_MIN = 1
export const HANDOVER_SLOT_CAPACITY_MAX = 20

/** handover_slots CHECK: a slot lasts at most 12 hours. */
export const HANDOVER_SLOT_MAX_DURATION_MS = 12 * 60 * 60 * 1000

/** `from` and `to` of a slot listing or generation are at most this many days apart (93 dates). */
export const HANDOVER_SLOT_RANGE_MAX_DAYS = 92

/** Slots one generate call may create (created + skipped). */
export const HANDOVER_SLOT_GENERATION_MAX = 200

/** Time pairs one generate call may carry. */
export const HANDOVER_SLOT_GENERATION_MAX_TIMES = 24

/**
 * The latest slot: today (Riyadh) plus the booking horizon. A slot further
 * out than any bookable event is a typo.
 */
export const HANDOVER_SLOT_HORIZON_DAYS = BOOKING_HORIZON_DAYS

/** Body caps in UTF-8 bytes; every valid body is far below them. */
export const HANDOVER_SLOT_BODY_MAX_BYTES = 512
export const HANDOVER_SLOT_GENERATE_BODY_MAX_BYTES = 4_096
export const HANDOVER_SLOT_PATCH_BODY_MAX_BYTES = 256
export const ADMIN_HANDOVER_BODY_MAX_BYTES = 256

/** Exact key sets (11 §3.1). */
export const HANDOVER_SLOT_BODY_KEYS = [
  'startsAt',
  'endsAt',
  'method',
  'capacity',
] as const
export const HANDOVER_SLOT_GENERATE_BODY_KEYS = [
  'fromDate',
  'toDate',
  'weekdays',
  'times',
  'method',
  'capacity',
] as const
export const HANDOVER_SLOT_PATCH_BODY_KEYS = ['capacity', 'isActive'] as const
export const ADMIN_HANDOVER_BODY_REQUIRED_KEYS = ['action'] as const
export const ADMIN_HANDOVER_BODY_OPTIONAL_KEYS = ['slotId'] as const

/**
 * The refusals of #24 and #28 besides the dispatcher's own (401, 403, 404
 * for a malformed path, 405, 503) and the body reader's 400/415.
 */
export const HANDOVER_ERROR_CODES = [
  'INVALID_REQUEST_BODY',
  'MISSING_DATE_RANGE',
  'INVALID_DATE',
  'INVALID_DATE_RANGE',
  'DATE_RANGE_TOO_LARGE',
  'DATE_IN_PAST',
  'DATE_BEYOND_HORIZON',
  'INVALID_TIME_RANGE',
  'TOO_MANY_SLOTS',
  'BOOKING_NOT_FOUND',
  'HANDOVER_NOT_FOUND',
  'SLOT_NOT_FOUND',
  'SLOT_ALREADY_EXISTS',
  'SLOT_HAS_BOOKINGS',
  'CAPACITY_BELOW_BOOKED',
  'SLOT_CHANGED',
  'SLOT_UNAVAILABLE',
  'SLOT_FULL',
  'BOOKING_NOT_CONFIRMED',
  'HANDOVER_ALREADY_COMPLETED',
  'HANDOVER_NOT_SCHEDULED',
  'HANDOVER_NOT_DUE',
  'HANDOVER_CHANGED',
  'RATE_LIMITED',
] as const

export type HandoverErrorCode = (typeof HANDOVER_ERROR_CODES)[number]

/** The input errors a parser below can report. */
export type HandoverInputError = Extract<
  HandoverErrorCode,
  | 'INVALID_REQUEST_BODY'
  | 'MISSING_DATE_RANGE'
  | 'INVALID_DATE'
  | 'INVALID_DATE_RANGE'
  | 'DATE_RANGE_TOO_LARGE'
  | 'DATE_IN_PAST'
  | 'DATE_BEYOND_HORIZON'
  | 'INVALID_TIME_RANGE'
  | 'TOO_MANY_SLOTS'
>

export type HandoverParseResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly code: HandoverInputError }

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface AdminHandoverSlot {
  readonly id: string
  /** Riyadh date key of startsAt. */
  readonly slotDate: string
  readonly startsAt: string
  readonly endsAt: string
  readonly method: HandoverSlotMethod
  readonly capacity: number
  readonly isActive: boolean
  /** Scheduled handovers in this slot (admin only; never shown to brides). */
  readonly bookedCount: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AdminHandoverSlotsResponse {
  readonly ok: true
  readonly range: { readonly from: string; readonly to: string }
  readonly slots: readonly AdminHandoverSlot[]
  /** True when the range held more slots than HANDOVER_SLOT_LIST_MAX. */
  readonly truncated: boolean
}

/** Slots one listing returns at most, earliest first. */
export const HANDOVER_SLOT_LIST_MAX = 1_000

export interface AdminHandoverSlotResponse {
  readonly ok: true
  readonly slot: AdminHandoverSlot
}

export interface AdminHandoverSlotsGeneratedResponse {
  readonly ok: true
  readonly created: number
  readonly skipped: number
}

export interface AdminHandoverSlotDeletedResponse {
  readonly ok: true
  readonly deleted: boolean
}

export interface AdminHandoverDelivery {
  readonly areaId: string | null
  /** The area name as snapshotted when she booked (handovers.delivery_city). */
  readonly areaName: string | null
  readonly fee: number | null
  readonly district: string | null
  readonly street: string | null
  readonly landmark: string | null
  /** True once the retention job removed the address (fields above null). */
  readonly addressPurged: boolean
}

export interface AdminHandover {
  readonly method: HandoverMethod
  readonly status: HandoverStatus
  readonly slot: {
    readonly id: string
    readonly slotDate: string
    readonly startsAt: string
    readonly endsAt: string
    readonly method: HandoverSlotMethod
  }
  /** Null for a pickup. */
  readonly delivery: AdminHandoverDelivery | null
  readonly bookedAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

export interface AdminHandoverResponse {
  readonly ok: true
  readonly booking: {
    readonly id: string
    readonly status: string
    /** booking_requests.completed_at, stamped with the handover's completion. */
    readonly completedAt: string | null
  }
  readonly handover: AdminHandover | null
}

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MINUTES_PER_DAY = 24 * 60

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isHandoverSlotMethod(
  value: unknown,
): value is HandoverSlotMethod {
  return HANDOVER_SLOT_METHODS.some((method) => method === value)
}

export function isHandoverMethod(value: unknown): value is HandoverMethod {
  return HANDOVER_METHODS.some((method) => method === value)
}

export function isHandoverStatus(value: unknown): value is HandoverStatus {
  return HANDOVER_STATUSES.some((status) => status === value)
}

export function isAdminHandoverAction(
  value: unknown,
): value is AdminHandoverAction {
  return ADMIN_HANDOVER_ACTIONS.some((action) => action === value)
}

/** A lowercase UUID, the only form handover_slots.id takes (0005 CHECK). */
export function isHandoverSlotId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** A `new Date().toISOString()` instant, the only form the 0005 CHECKs accept. */
export function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value)) {
    return false
  }

  const parsed = new Date(value)

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

/** An integer capacity within the 0005 CHECK. */
export function isHandoverSlotCapacity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= HANDOVER_SLOT_CAPACITY_MIN &&
    value <= HANDOVER_SLOT_CAPACITY_MAX
  )
}

/** True when a slot of `slotMethod` can host a handover of `method`. */
export function slotAcceptsMethod(
  slotMethod: HandoverSlotMethod,
  method: HandoverMethod,
): boolean {
  return slotMethod === 'both' || slotMethod === method
}

/** A date key typed with any digits, or null. */
function readDateKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const key = toAsciiDigits(value.trim())

  return isValidDateKey(key) ? key : null
}

/** An `HH:MM` wall-clock time typed with any digits, as minutes after midnight, or null. */
function readLocalTime(value: unknown): { text: string; minutes: number } | null {
  if (typeof value !== 'string') {
    return null
  }

  const text = toAsciiDigits(value.trim())

  if (!isValidLocalTime(text)) {
    return null
  }

  return {
    text,
    minutes: Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5)),
  }
}

function isValidSlotSpan(startsAt: string, endsAt: string): boolean {
  const duration = Date.parse(endsAt) - Date.parse(startsAt)

  return duration > 0 && duration <= HANDOVER_SLOT_MAX_DURATION_MS
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export interface HandoverSlotRange {
  readonly from: string
  readonly to: string
}

/**
 * `from`/`to` of GET /api/admin/handover-slots: both required, valid date
 * keys, from ≤ to, at most HANDOVER_SLOT_RANGE_MAX_DAYS apart (the same
 * codes as /api/availability and /api/admin/blocked-dates).
 */
export function parseHandoverSlotRange(
  fromValue: string | null,
  toValue: string | null,
): HandoverParseResult<HandoverSlotRange> {
  if (!fromValue || !toValue) {
    return { ok: false, code: 'MISSING_DATE_RANGE' }
  }

  const from = readDateKey(fromValue)
  const to = readDateKey(toValue)

  if (from === null || to === null) {
    return { ok: false, code: 'INVALID_DATE' }
  }

  const days = daysBetweenDateKeys(from, to)

  if (days === null || days < 0) {
    return { ok: false, code: 'INVALID_DATE_RANGE' }
  }

  if (days > HANDOVER_SLOT_RANGE_MAX_DAYS) {
    return { ok: false, code: 'DATE_RANGE_TOO_LARGE' }
  }

  return { ok: true, value: { from, to } }
}

export interface HandoverSlotInput {
  readonly startsAt: string
  readonly endsAt: string
  readonly method: HandoverSlotMethod
  readonly capacity: number
}

/**
 * The body of POST /api/admin/handover-slots (keys already exact).
 * Instants in toISOString form, the end after the start and at most 12
 * hours later, the start no later than today + the slot horizon (Riyadh).
 * A past start is accepted (07 §3.G.1: record-keeping); brides never see
 * past slots.
 */
export function parseHandoverSlotInput(
  body: Readonly<Record<string, unknown>>,
  riyadhTodayKey: string,
): HandoverParseResult<HandoverSlotInput> {
  const { startsAt, endsAt, method, capacity } = body

  if (
    !isCanonicalInstant(startsAt) ||
    !isCanonicalInstant(endsAt) ||
    !isHandoverSlotMethod(method) ||
    !isHandoverSlotCapacity(capacity)
  ) {
    return { ok: false, code: 'INVALID_REQUEST_BODY' }
  }

  if (!isValidSlotSpan(startsAt, endsAt)) {
    return { ok: false, code: 'INVALID_TIME_RANGE' }
  }

  const horizonKey = addDaysToDateKey(riyadhTodayKey, HANDOVER_SLOT_HORIZON_DAYS)
  const horizonEnd =
    horizonKey === null ? null : riyadhLocalToInstant(horizonKey, '23:59')

  if (horizonEnd === null) {
    throw new RangeError('Handover slots: today must be a Riyadh date key.')
  }

  if (startsAt > horizonEnd) {
    return { ok: false, code: 'DATE_BEYOND_HORIZON' }
  }

  return { ok: true, value: { startsAt, endsAt, method, capacity } }
}

export interface HandoverSlotGeneration {
  readonly fromDate: string
  readonly toDate: string
  readonly method: HandoverSlotMethod
  readonly capacity: number
  /** Every slot the call asks for, earliest first, no two with the same start. */
  readonly slots: readonly { readonly startsAt: string; readonly endsAt: string }[]
}

interface LocalTimePair {
  readonly start: string
  readonly end: string
  /** Minutes from start to end on the same day. */
  readonly minutes: number
}

/** 1–24 `{ start, end }` objects with exactly those keys and distinct starts, or null. */
function readTimePairs(value: unknown): LocalTimePair[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > HANDOVER_SLOT_GENERATION_MAX_TIMES
  ) {
    return null
  }

  const pairs: LocalTimePair[] = []
  const starts = new Set<string>()

  for (const entry of value) {
    if (!isRecord(entry)) {
      return null
    }

    const keys = Object.keys(entry)

    if (
      keys.length !== 2 ||
      !Object.hasOwn(entry, 'start') ||
      !Object.hasOwn(entry, 'end')
    ) {
      return null
    }

    const start = readLocalTime(entry.start)
    const end = readLocalTime(entry.end)

    if (start === null || end === null || starts.has(start.text)) {
      return null
    }

    starts.add(start.text)
    pairs.push({
      start: start.text,
      end: end.text,
      minutes: end.minutes - start.minutes,
    })
  }

  return pairs
}

/** The end after the start on the same day, at most 12 hours later. */
function isValidTimePair(pair: LocalTimePair): boolean {
  return (
    pair.minutes > 0 &&
    pair.minutes < MINUTES_PER_DAY &&
    pair.minutes * 60 * 1000 <= HANDOVER_SLOT_MAX_DURATION_MS
  )
}

function readWeekdays(value: unknown): ReadonlySet<number> | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) {
    return null
  }

  const weekdays = new Set<number>()

  for (const entry of value) {
    if (
      typeof entry !== 'number' ||
      !Number.isInteger(entry) ||
      entry < 0 ||
      entry > 6 ||
      weekdays.has(entry)
    ) {
      return null
    }

    weekdays.add(entry)
  }

  return weekdays
}

/** 0 = Sunday … 6 = Saturday, of a valid date key (UTC noon: no zone can move it). */
function weekdayOfDateKey(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)

  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()
}

/**
 * The body of POST /api/admin/handover-slots/generate (keys already exact),
 * expanded into the slots it asks for. Bounds (plan 11 W2-08): fromDate is
 * today or later in Riyadh (M2), toDate at most HANDOVER_SLOT_RANGE_MAX_DAYS
 * after it and within the slot horizon; weekdays 0 (Sunday) to 6, distinct;
 * 1–24 distinct start times, each pair `HH:MM` with the end after the
 * start on the same day and at most 12 hours later; at most
 * HANDOVER_SLOT_GENERATION_MAX slots in all, else TOO_MANY_SLOTS and
 * nothing is created. Each Riyadh wall-clock time becomes an instant through
 * riyadhLocalToInstant, which fails closed on a wrong time-zone database.
 */
export function planHandoverSlotGeneration(
  body: Readonly<Record<string, unknown>>,
  riyadhTodayKey: string,
): HandoverParseResult<HandoverSlotGeneration> {
  const { method, capacity } = body
  const weekdays = readWeekdays(body.weekdays)
  const times = readTimePairs(body.times)

  if (
    !isHandoverSlotMethod(method) ||
    !isHandoverSlotCapacity(capacity) ||
    weekdays === null ||
    times === null ||
    typeof body.fromDate !== 'string' ||
    typeof body.toDate !== 'string'
  ) {
    return { ok: false, code: 'INVALID_REQUEST_BODY' }
  }

  const fromDate = readDateKey(body.fromDate)
  const toDate = readDateKey(body.toDate)

  if (fromDate === null || toDate === null) {
    return { ok: false, code: 'INVALID_DATE' }
  }

  const days = daysBetweenDateKeys(fromDate, toDate)

  if (days === null || days < 0) {
    return { ok: false, code: 'INVALID_DATE_RANGE' }
  }

  if (days > HANDOVER_SLOT_RANGE_MAX_DAYS) {
    return { ok: false, code: 'DATE_RANGE_TOO_LARGE' }
  }

  const sinceToday = daysBetweenDateKeys(riyadhTodayKey, fromDate)

  if (sinceToday === null) {
    throw new RangeError('Handover slots: today must be a Riyadh date key.')
  }

  if (sinceToday < 0) {
    return { ok: false, code: 'DATE_IN_PAST' }
  }

  if (sinceToday + days > HANDOVER_SLOT_HORIZON_DAYS) {
    return { ok: false, code: 'DATE_BEYOND_HORIZON' }
  }

  if (!times.every(isValidTimePair)) {
    return { ok: false, code: 'INVALID_TIME_RANGE' }
  }

  const orderedTimes = [...times].sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  )
  const slots: { startsAt: string; endsAt: string }[] = []

  for (let offset = 0; offset <= days; offset += 1) {
    const dateKey = addDaysToDateKey(fromDate, offset)

    if (dateKey === null) {
      throw new RangeError('Handover slots: a date in the range is invalid.')
    }

    if (!weekdays.has(weekdayOfDateKey(dateKey))) {
      continue
    }

    for (const time of orderedTimes) {
      if (slots.length === HANDOVER_SLOT_GENERATION_MAX) {
        return { ok: false, code: 'TOO_MANY_SLOTS' }
      }

      const startsAt = riyadhLocalToInstant(dateKey, time.start)
      const endsAt = riyadhLocalToInstant(dateKey, time.end)

      if (
        startsAt === null ||
        endsAt === null ||
        !isValidSlotSpan(startsAt, endsAt)
      ) {
        return { ok: false, code: 'INVALID_TIME_RANGE' }
      }

      slots.push({ startsAt, endsAt })
    }
  }

  return {
    ok: true,
    value: { fromDate, toDate, method, capacity, slots },
  }
}

export interface HandoverSlotPatch {
  readonly capacity?: number
  readonly isActive?: boolean
}

/** The body of PATCH /api/admin/handover-slots/{slotId}: at least one known key. */
export function parseHandoverSlotPatch(
  body: Readonly<Record<string, unknown>>,
): HandoverParseResult<HandoverSlotPatch> {
  const hasCapacity = Object.hasOwn(body, 'capacity')
  const hasIsActive = Object.hasOwn(body, 'isActive')

  if (
    (!hasCapacity && !hasIsActive) ||
    (hasCapacity && !isHandoverSlotCapacity(body.capacity)) ||
    (hasIsActive && typeof body.isActive !== 'boolean')
  ) {
    return { ok: false, code: 'INVALID_REQUEST_BODY' }
  }

  const patch: { capacity?: number; isActive?: boolean } = {}

  if (hasCapacity && typeof body.capacity === 'number') {
    patch.capacity = body.capacity
  }

  if (hasIsActive && typeof body.isActive === 'boolean') {
    patch.isActive = body.isActive
  }

  return { ok: true, value: patch }
}

export type AdminHandoverCommand =
  | { readonly action: 'complete' | 'no_show' | 'cancel' }
  | { readonly action: 'reassign'; readonly slotId: string }

/**
 * The body of PATCH /api/admin/bookings/{id}/handover: `slotId` exactly
 * when the action is `reassign`.
 */
export function parseAdminHandoverCommand(
  body: Readonly<Record<string, unknown>>,
): HandoverParseResult<AdminHandoverCommand> {
  const { action } = body
  const hasSlotId = Object.hasOwn(body, 'slotId')

  if (!isAdminHandoverAction(action)) {
    return { ok: false, code: 'INVALID_REQUEST_BODY' }
  }

  if (action === 'reassign') {
    return hasSlotId && isHandoverSlotId(body.slotId)
      ? { ok: true, value: { action, slotId: body.slotId } }
      : { ok: false, code: 'INVALID_REQUEST_BODY' }
  }

  return hasSlotId
    ? { ok: false, code: 'INVALID_REQUEST_BODY' }
    : { ok: true, value: { action } }
}

// ---------------------------------------------------------------------------
// Runtime guards for the admin client (W3-10)
// ---------------------------------------------------------------------------

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

export function isAdminHandoverSlot(value: unknown): value is AdminHandoverSlot {
  return (
    isRecord(value) &&
    isHandoverSlotId(value.id) &&
    typeof value.slotDate === 'string' &&
    isValidDateKey(value.slotDate) &&
    isCanonicalInstant(value.startsAt) &&
    isCanonicalInstant(value.endsAt) &&
    isHandoverSlotMethod(value.method) &&
    isHandoverSlotCapacity(value.capacity) &&
    typeof value.isActive === 'boolean' &&
    isCount(value.bookedCount) &&
    isCanonicalInstant(value.createdAt) &&
    isCanonicalInstant(value.updatedAt)
  )
}

export function isAdminHandoverSlotsResponse(
  value: unknown,
): value is AdminHandoverSlotsResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isRecord(value.range) &&
    typeof value.range.from === 'string' &&
    typeof value.range.to === 'string' &&
    Array.isArray(value.slots) &&
    value.slots.every(isAdminHandoverSlot) &&
    typeof value.truncated === 'boolean'
  )
}

export function isAdminHandoverSlotResponse(
  value: unknown,
): value is AdminHandoverSlotResponse {
  return isRecord(value) && value.ok === true && isAdminHandoverSlot(value.slot)
}

export function isAdminHandoverSlotsGeneratedResponse(
  value: unknown,
): value is AdminHandoverSlotsGeneratedResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isCount(value.created) &&
    isCount(value.skipped)
  )
}

function isAdminHandoverDelivery(value: unknown): value is AdminHandoverDelivery {
  return (
    isRecord(value) &&
    isNullableString(value.areaId) &&
    isNullableString(value.areaName) &&
    (value.fee === null || isCount(value.fee)) &&
    isNullableString(value.district) &&
    isNullableString(value.street) &&
    isNullableString(value.landmark) &&
    typeof value.addressPurged === 'boolean'
  )
}

export function isAdminHandover(value: unknown): value is AdminHandover {
  return (
    isRecord(value) &&
    isHandoverMethod(value.method) &&
    isHandoverStatus(value.status) &&
    isRecord(value.slot) &&
    isHandoverSlotId(value.slot.id) &&
    typeof value.slot.slotDate === 'string' &&
    isValidDateKey(value.slot.slotDate) &&
    isCanonicalInstant(value.slot.startsAt) &&
    isCanonicalInstant(value.slot.endsAt) &&
    isHandoverSlotMethod(value.slot.method) &&
    (value.delivery === null || isAdminHandoverDelivery(value.delivery)) &&
    isCanonicalInstant(value.bookedAt) &&
    isCanonicalInstant(value.updatedAt) &&
    (value.completedAt === null || isCanonicalInstant(value.completedAt))
  )
}

export function isAdminHandoverResponse(
  value: unknown,
): value is AdminHandoverResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    isRecord(value.booking) &&
    typeof value.booking.id === 'string' &&
    typeof value.booking.status === 'string' &&
    isNullableString(value.booking.completedAt) &&
    (value.handover === null || isAdminHandover(value.handover))
  )
}
