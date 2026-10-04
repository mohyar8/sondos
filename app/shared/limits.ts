/**
 * Abuse limits (plan 11 §3.1, threat model TM-11, audit SEC-03). One source
 * of truth for the Worker and the SPA: change a number here, nowhere else.
 *
 * Two layers, because the Workers `ratelimits` binding only counts per 10 or
 * 60 seconds:
 * - Bursts: one binding per route class (wrangler.jsonc, 60 s), keyed by the
 *   verified Firebase uid or, on public routes, the connecting IP
 *   (worker/rate-limit.ts). The binding is fail-open, so it only brakes a
 *   burst.
 * - Hard caps: counts over rows that already exist, evaluated inside the
 *   writing statement (plan 11 §4.3 E4), so concurrent requests cannot pass
 *   one together. They are the bound that still holds when a binding is
 *   missing or failing.
 *
 * Over a burst or a windowed cap the Worker answers 429 RATE_LIMITED with
 * Retry-After. Over the open-request cap it answers Wave 0's 409
 * TOO_MANY_OPEN_REQUESTS until W2-16 moves it to the plan's 409
 * OPEN_REQUEST_LIMIT (see OPEN_BOOKING_REQUESTS_MAX). The booking horizon of
 * the same §3.1 row (400 DATE_BEYOND_HORIZON) is BOOKING_HORIZON_DAYS in
 * shared/timing.ts.
 */

/** The period of every `ratelimits` binding in wrangler.jsonc, in seconds. */
export const BURST_PERIOD_SECONDS = 60

/**
 * What a burst limit counts per: the verified Firebase uid, or the
 * connecting IP (connectingIpKey in worker/rate-limit.ts) on public routes.
 * Never a value the client chooses.
 */
export type BurstKey = 'uid' | 'ip'

export interface BurstLimit {
  /** Requests allowed per key in one BURST_PERIOD_SECONDS window. */
  readonly limit: number
  readonly keyedBy: BurstKey
}

/**
 * §3.1 bursts by binding name. wrangler.jsonc declares these limits in every
 * environment; tests/rate-limit.test.mjs fails when the two drift apart.
 */
export const BURST_LIMITS = {
  /** POST /api/bookings. */
  RL_BOOKING: { limit: 3, keyedBy: 'uid' },
  /** PUT /api/profile: an idempotent upsert, so no hard cap. */
  RL_PROFILE: { limit: 3, keyedBy: 'uid' },
  /** Customer writes #3, #4, #7, #8, #11, #12 and #14 together. */
  RL_CUSTOMER_WRITE: { limit: 10, keyedBy: 'uid' },
  /** Receipt upload #5 (Train B). */
  RL_UPLOAD: { limit: 2, keyedBy: 'uid' },
  /** GET /api/availability (public; the response is also edge-cached 60 s). */
  RL_AVAILABILITY: { limit: 60, keyedBy: 'ip' },
  /** POST /api/csp-report (public). */
  RL_CSP_REPORT: { limit: 30, keyedBy: 'ip' },
  /** Admin reads: slows a scripted scrape with a stolen admin session. */
  RL_ADMIN_READ: { limit: 100, keyedBy: 'uid' },
} as const satisfies Record<string, BurstLimit>

export type BurstLimitName = keyof typeof BURST_LIMITS

/**
 * A cap on rows created within a sliding window. The write goes ahead only
 * while fewer than `max` counted rows have a `created_at` later than
 * windowStart(cap, now), so at most `max` exist in any window afterwards.
 */
export interface WindowedCap {
  readonly max: number
  readonly windowSeconds: number
}

const HOUR_SECONDS = 60 * 60
const DAY_SECONDS = 24 * HOUR_SECONDS

/**
 * §3.1 windowed caps. Each count and its window start are bound parameters
 * of the writing statement, never spliced into the SQL text (SB-4), e.g.
 *
 *   INSERT INTO booking_requests (…) SELECT … WHERE …
 *     AND (SELECT COUNT(*) FROM booking_requests
 *          WHERE user_id = ? AND created_at > ?) < ?
 *
 * bound with (uid, windowStart(cap, now), cap.max). Over a cap → 429
 * RATE_LIMITED with Retry-After cap.windowSeconds (an upper bound: the oldest
 * counted row leaves the window within it).
 *
 * The comparison is textual, so the counted created_at must be a
 * toISOString() instant. booking_events and booking_receipts enforce that
 * with a CHECK (0005); booking_requests.created_at does not (0003 defaults to
 * CURRENT_TIMESTAMP, 'YYYY-MM-DD HH:MM:SS', which can sort before a window
 * start of the same day and go uncounted), so the capped INSERT binds its own
 * created_at from new Date().toISOString().
 */
export const WINDOWED_CAPS = {
  /** POST /api/bookings: requests created by one account in the last hour. */
  bookingRequestsPerAccount: { max: 5, windowSeconds: HOUR_SECONDS },
  /**
   * PUT consent: consent_granted / consent_withdrawn events of one booking in
   * the last 24 hours (events are written only when the value changes).
   */
  consentChangesPerBooking: { max: 10, windowSeconds: DAY_SECONDS },
  /** Receipt upload #5 (Train B): receipts of one booking in the last hour. */
  receiptsPerBooking: { max: 6, windowSeconds: HOUR_SECONDS },
} as const satisfies Record<string, WindowedCap>

/**
 * Open booking requests per account: a request before `confirmed` whose
 * event date is today (Riyadh) or later, counted inside the INSERT.
 *
 * Over the cap the Worker answers Wave 0's 409 TOO_MANY_OPEN_REQUESTS
 * (worker/bookings.ts), the only code the booking form (src/api/bookings.ts)
 * accepts. The plan's 409 OPEN_REQUEST_LIMIT (openRequestLimitResponse in
 * worker/rate-limit.ts) has no caller yet: W2-16 switches
 * worker/bookings.ts conflictResponse to it and teaches src/api/bookings.ts
 * the new code in one change, never one without the other. That message
 * spells the number out («ثلاثة»), so change it together with this one.
 */
export const OPEN_BOOKING_REQUESTS_MAX = 3

/**
 * Receipt attempts per booking: the booking_receipts.attempt_no CHECK
 * (migration 0005) refuses an eleventh, whatever the Worker does.
 */
export const RECEIPT_ATTEMPTS_MAX = 10

/**
 * POST /api/csp-report: distinct (directive, blocked origin) rows per `day`
 * in csp_report_counts. A report for a row that already exists only raises
 * its count.
 */
export const CSP_REPORT_ROWS_PER_DAY_MAX = 200

/** The longest window above: no Retry-After is ever longer. */
export const LONGEST_LIMIT_WINDOW_SECONDS = Math.max(
  BURST_PERIOD_SECONDS,
  ...Object.values(WINDOWED_CAPS).map((cap) => cap.windowSeconds),
)

/**
 * The window start to bind for a windowed cap, as a toISOString() instant
 * like every created_at the caps count. `now` is the Worker clock; an invalid
 * date throws a RangeError.
 */
export function windowStart(cap: WindowedCap, now: Date): string {
  return new Date(now.getTime() - cap.windowSeconds * 1000).toISOString()
}
