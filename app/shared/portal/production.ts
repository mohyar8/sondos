import { isValidDateKey } from '../timing.js'

/**
 * Album production status contract (plan 11 §3.2 #23, §3.3 #23; decision D1:
 * the resource is `production`, a path without a private-media word, so it
 * stays open while private media is gated). Shared by the Worker
 * (worker/portal/production.ts), which has the final word, and the admin
 * section (W3-11), which reads the same shapes. Pure: no I/O, no logging.
 *
 * - `GET  /api/admin/bookings/{id}/production` →
 *   `{ "ok": true, "production": null | { "stage", "updatedAt" } }`
 * - `PUT  /api/admin/bookings/{id}/production` with exactly
 *   `{ "stage": "design" | "printing" | "ready" }` → the same shape, after
 *   the change (or unchanged when the stage was already the one asked for).
 *
 * The stage order is the journey's (album_design → album_printing →
 * album_ready); it is not enforced, so the admin can correct a stage she set
 * by mistake (07 §3.F.1).
 */

/** album_production.stage, as the 0005 CHECK allows it, in journey order. */
export const PRODUCTION_STAGES = ['design', 'printing', 'ready'] as const

export type ProductionStage = (typeof PRODUCTION_STAGES)[number]

export function isProductionStage(value: unknown): value is ProductionStage {
  return PRODUCTION_STAGES.some((stage) => stage === value)
}

/** The request body: exactly one key. */
export const PRODUCTION_BODY_KEYS = ['stage'] as const

/** UTF-8 bytes; `{"stage":"printing"}` is 20. */
export const PRODUCTION_BODY_MAX_BYTES = 256

export interface ProductionStatus {
  readonly stage: ProductionStage
  /** ISO instant of the last stage change (album_production.updated_at). */
  readonly updatedAt: string
}

export interface AdminProductionResponse {
  readonly ok: true
  readonly production: ProductionStatus | null
}

/**
 * The refusals of #23 besides the dispatcher's own (401, 403, 404 for a
 * malformed id, 405, 503) and the body reader's 400/415.
 */
export const PRODUCTION_ERROR_CODES = [
  'BOOKING_NOT_FOUND',
  'BOOKING_NOT_CONFIRMED',
  'EVENT_NOT_YET_HELD',
  'PRODUCTION_STAGE_CHANGED',
  'RATE_LIMITED',
] as const

export type ProductionErrorCode = (typeof PRODUCTION_ERROR_CODES)[number]

/**
 * The event day has passed in Riyadh: the event's date key is before today's
 * Riyadh date key (N-59: between 21:00 and 24:00 Riyadh, "today" is already
 * the Riyadh date, not the UTC one). On the event day itself it has not.
 * False for anything that is not a valid date key.
 */
export function hasEventDayPassed(
  eventDateKey: string,
  riyadhTodayKey: string,
): boolean {
  return (
    isValidDateKey(eventDateKey) &&
    isValidDateKey(riyadhTodayKey) &&
    eventDateKey < riyadhTodayKey
  )
}

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProductionStatus(value: unknown): value is ProductionStatus {
  return (
    isRecord(value) &&
    isProductionStage(value.stage) &&
    typeof value.updatedAt === 'string' &&
    ISO_INSTANT_PATTERN.test(value.updatedAt)
  )
}

/** Runtime guard for the admin client: a #23 success body, nothing looser. */
export function isAdminProductionResponse(
  value: unknown,
): value is AdminProductionResponse {
  return (
    isRecord(value) &&
    value.ok === true &&
    (value.production === null || isProductionStatus(value.production))
  )
}
