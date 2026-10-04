import { ADMIN_SESSION_MAX_HOURS, RECENT_SIGN_IN_SECONDS } from './timing.js'

/**
 * Admin session rules shared by the Worker and the SPA (plan 11 §3.1 AD,
 * AD+R, AD+S, AD+2F and #40 `GET /api/admin/session`; C-1, TM-07, SB-14,
 * SB-18). The windows themselves are shared/timing.ts numbers.
 *
 * Every age is measured from the Firebase ID token's `auth_time`: when the
 * user last typed her password (or passed a second factor). A silently
 * refreshed token keeps that `auth_time`, so no window restarts without a
 * real sign-in. The Worker enforces the rules (worker/admin-auth.ts,
 * worker/recent-auth.ts); the SPA reads them only to ask for the password
 * before a form opens, never as a control.
 */

const SECONDS_PER_HOUR = 60 * 60
/** 9999-12-31T23:59:59Z: the last instant with a 24-character ISO form. */
const LAST_FOUR_DIGIT_YEAR_SECOND = 253_402_300_799

/** AD: an admin request needs a sign-in at most this many seconds old. */
export const ADMIN_SESSION_MAX_AGE_SECONDS =
  ADMIN_SESSION_MAX_HOURS * SECONDS_PER_HOUR

/**
 * How much earlier than the end of RECENT_SIGN_IN_SECONDS the AD+R, AD+S
 * and CO+R guards stop accepting a sign-in. A write behind them stores
 * `reauth_at` (the sign-in), and D1 refuses the row unless its SQL-stamped
 * `created_at` is at most 10 minutes later (the CHECKs of migrations
 * 0008/0009). That INSERT runs after the guard: after the handler's reads
 * and body parsing, on the database's clock, while a Worker's own clock
 * stands still until its next I/O. The margin keeps the guard strictly
 * inside the CHECK, so a sign-in near the end of the window gets 403
 * REAUTH_REQUIRED and the password prompt, never a refused row and a 500.
 */
export const RECENT_SIGN_IN_MARGIN_SECONDS = 30

/**
 * AD+R, AD+S and CO+R: a sign-in at most this many seconds old (570 s, 9.5
 * minutes). The plan's "≤ 10 min" is the D1 CHECK's bound, not the guard's:
 * the guard stops RECENT_SIGN_IN_MARGIN_SECONDS earlier. It is the one
 * recent-sign-in window: the Worker guards enforce it, #40 reports its end
 * as `reauthFreshUntil`, and an SPA line such as "valid until" reads this
 * constant (or that field), never its own 10-minute copy, so she is never
 * asked for her password again inside a window the page promised.
 */
export const RECENT_SIGN_IN_GUARD_SECONDS =
  RECENT_SIGN_IN_SECONDS - RECENT_SIGN_IN_MARGIN_SECONDS

/** The admin SPA signs out after this many minutes without activity. */
export const ADMIN_IDLE_SIGN_OUT_MINUTES = 30

/** The second factors #40 reports (Firebase `sign_in_second_factor`). */
export const adminSecondFactors = ['totp', 'phone'] as const

export type AdminSecondFactor = (typeof adminSecondFactors)[number]

/**
 * The only second factor that satisfies AD+2F and AD+S. SMS ('phone') is
 * reported but never accepted: a SIM swap would pass it.
 */
export const REQUIRED_ADMIN_SECOND_FACTOR: AdminSecondFactor = 'totp'

/** What the Worker knows about an admin's sign-in, from verified claims. */
export interface AdminSessionClaims {
  readonly uid: string
  /** `auth_time`, Unix seconds. */
  readonly authTime: number
  /** `firebase.sign_in_second_factor`, or null for a password-only sign-in. */
  readonly secondFactor: string | null
}

/** #40 `GET /api/admin/session`, without the `ok` envelope. */
export interface AdminSessionView {
  readonly admin: {
    readonly uid: string
    /** The sign-in instant (ISO-8601 UTC). */
    readonly authTime: string
    /** Until then the sign-in counts as recent (AD+R, AD+S). */
    readonly reauthFreshUntil: string
    /** After it every admin route answers 403 REAUTH_REQUIRED (AD). */
    readonly sessionFreshUntil: string
    readonly secondFactor: AdminSecondFactor | null
  }
  readonly idleMinutes: number
  readonly serverTime: string
}

/**
 * Unix seconds as the 24-character ISO-8601 instant the D1 CHECKs accept
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`). Throws a RangeError for a value that is not
 * a finite number from 1970 to the year 9999, so a bad claim never becomes
 * a stored instant.
 */
export function unixSecondsToInstant(seconds: number): string {
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > LAST_FOUR_DIGIT_YEAR_SECOND
  ) {
    throw new RangeError('unixSecondsToInstant: seconds out of range.')
  }

  return new Date(seconds * 1000).toISOString()
}

/** The factor #40 reports: a known one, else null (never the raw claim). */
function reportedSecondFactor(
  value: string | null,
): AdminSecondFactor | null {
  return adminSecondFactors.find((factor) => factor === value) ?? null
}

/**
 * The #40 body for a verified admin sign-in. `nowSeconds` is the Worker's
 * clock, the same one the guards compare against.
 */
export function describeAdminSession(
  claims: AdminSessionClaims,
  nowSeconds: number,
): AdminSessionView {
  return {
    admin: {
      uid: claims.uid,
      authTime: unixSecondsToInstant(claims.authTime),
      reauthFreshUntil: unixSecondsToInstant(
        claims.authTime + RECENT_SIGN_IN_GUARD_SECONDS,
      ),
      sessionFreshUntil: unixSecondsToInstant(
        claims.authTime + ADMIN_SESSION_MAX_AGE_SECONDS,
      ),
      secondFactor: reportedSecondFactor(claims.secondFactor),
    },
    idleMinutes: ADMIN_IDLE_SIGN_OUT_MINUTES,
    serverTime: unixSecondsToInstant(nowSeconds),
  }
}
