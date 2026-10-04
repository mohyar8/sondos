import {
  ADMIN_SESSION_MAX_AGE_SECONDS,
  RECENT_SIGN_IN_GUARD_SECONDS,
  REQUIRED_ADMIN_SECOND_FACTOR,
  unixSecondsToInstant,
} from '../shared/admin-session.js'
import type { AuthenticatedFirebaseUser } from './auth.js'
import { errorResponse } from './http.js'

/**
 * Session freshness and second-factor guards over verified token claims
 * (plan 11 §3.1 and §4.1: RA, CR, CM, 2F, 2S; E6; C-1, TM-07, TM-08,
 * TM-21, M1, SB-14, SB-18).
 *
 * Every rule reads `auth_time`, the moment of the last real sign-in, never
 * `iat`: a silently refreshed ID token has a new `iat` and the old
 * `auth_time`, so refreshing never makes a session fresh again and never
 * outlives a revocation. The claims come only from worker/auth.ts
 * authenticateFirebaseRequest, which drops `iat` once it is checked, so no
 * code here can read it by mistake.
 *
 * A guard returns null when the request may go on, or the finished 403
 * response otherwise. Nothing here logs anything.
 *
 * - requireRecentSignIn (AD+R) and requireRecentCustomerSignIn (CO+R): a
 *   sign-in at most 9.5 minutes old, RECENT_SIGN_IN_GUARD_SECONDS: the
 *   10-minute window less a margin that keeps the guard strictly inside
 *   the D1 CHECK on the `reauth_at` a write stores (shared/admin-session.ts).
 * - requireMediaFreshSignIn (CO+M): private-media reads, a sign-in at most
 *   12 hours old; media writes that the plan names (submit-and-lock) add
 *   requireRecentCustomerSignIn.
 * - requireSecondFactor (AD+2F): a TOTP sign-in unless ADMIN_MEDIA_MFA is
 *   exactly "off" (TM-21); any other value, a missing one included, keeps
 *   it required.
 * - requireSettingsSecondFactor (AD+S, on top of AD+R): a TOTP sign-in once
 *   ADMIN_SETTINGS_2F is exactly "required"; otherwise bank and contact
 *   changes are delayed instead (TM-03, worker/settings).
 * - reauthAtFromToken: the only source of a stored `reauth_at`.
 *
 * The admin guard (worker/admin-auth.ts) already holds every admin request
 * to a sign-in at most 12 hours old and not older than the account's
 * revocation mark; these guards narrow a single route further.
 */

/** The only value of ADMIN_MEDIA_MFA that switches the second factor off. */
const ADMIN_MEDIA_MFA_OFF_VALUE = 'off'
/** The only value of ADMIN_SETTINGS_2F that switches the second factor on. */
const ADMIN_SETTINGS_2F_REQUIRED_VALUE = 'required'

/** CO+M: private-media reads accept a sign-in this many seconds old. */
export const MEDIA_SIGN_IN_MAX_AGE_SECONDS = ADMIN_SESSION_MAX_AGE_SECONDS

/** The verified claims a guard reads. */
export type SignInClaims = Pick<
  AuthenticatedFirebaseUser,
  'authTime' | 'secondFactor'
>

/**
 * Unix seconds with the milliseconds kept: whole seconds would accept up to
 * one more second than a window allows.
 */
function currentUnixSeconds(): number {
  return Date.now() / 1000
}

/**
 * True when the sign-in happened at most `maximumAgeSeconds` ago. A claim
 * that is not a finite number, or lies in the future, is never recent.
 */
export function isRecentAuthentication(
  claims: Pick<SignInClaims, 'authTime'>,
  maximumAgeSeconds: number,
  nowSeconds: number = currentUnixSeconds(),
): boolean {
  const { authTime } = claims

  return (
    Number.isFinite(authTime) &&
    Number.isFinite(nowSeconds) &&
    authTime <= nowSeconds &&
    nowSeconds - authTime <= maximumAgeSeconds
  )
}

/**
 * True when the sign-in behind the token is earlier than the account's
 * revocation mark (users.tokens_valid_after, Unix seconds; C-14). Every
 * token of that session, refreshed or not, carries the same `auth_time`,
 * so all of them are refused; only a new sign-in passes. A mark that is
 * not a finite number revokes (fail closed). The admin guard applies the
 * same rule inside its D1 query (worker/admin-auth.ts).
 */
export function isSessionRevoked(
  claims: Pick<SignInClaims, 'authTime'>,
  tokensValidAfter: number | null,
): boolean {
  if (tokensValidAfter === null) {
    return false
  }

  return !(
    Number.isFinite(tokensValidAfter) &&
    Number.isFinite(claims.authTime) &&
    claims.authTime >= tokensValidAfter
  )
}

/** True when this sign-in passed the admin second factor (TOTP). */
export function hasAdminSecondFactor(
  claims: Pick<SignInClaims, 'secondFactor'>,
): boolean {
  return claims.secondFactor === REQUIRED_ADMIN_SECOND_FACTOR
}

/**
 * 403 REAUTH_REQUIRED (admin and customer): the SPA asks for the password
 * again (reauthenticateWithCredential) and retries once.
 */
export function reauthRequiredResponse(): Response {
  return errorResponse(
    403,
    'REAUTH_REQUIRED',
    'لحماية الحساب، أعيدي إدخال كلمة المرور لإتمام هذا الإجراء.',
  )
}

/** 403 SECOND_FACTOR_REQUIRED: the route needs a TOTP sign-in. */
export function secondFactorRequiredResponse(): Response {
  return errorResponse(
    403,
    'SECOND_FACTOR_REQUIRED',
    'هذا الإجراء يتطلب التحقق بخطوتين لحساب الإدارة.',
  )
}

function requireSignInWithin(
  claims: Pick<SignInClaims, 'authTime'>,
  maximumAgeSeconds: number,
  nowSeconds: number,
): Response | null {
  return isRecentAuthentication(claims, maximumAgeSeconds, nowSeconds)
    ? null
    : reauthRequiredResponse()
}

/** AD+R: an admin sign-in at most RECENT_SIGN_IN_GUARD_SECONDS old. */
export function requireRecentSignIn(
  admin: Pick<SignInClaims, 'authTime'>,
  nowSeconds: number = currentUnixSeconds(),
): Response | null {
  return requireSignInWithin(admin, RECENT_SIGN_IN_GUARD_SECONDS, nowSeconds)
}

/** CO+R: a customer sign-in at most RECENT_SIGN_IN_GUARD_SECONDS old (TM-08). */
export function requireRecentCustomerSignIn(
  customer: Pick<SignInClaims, 'authTime'>,
  nowSeconds: number = currentUnixSeconds(),
): Response | null {
  return requireSignInWithin(
    customer,
    RECENT_SIGN_IN_GUARD_SECONDS,
    nowSeconds,
  )
}

/** CO+M: a customer sign-in at most 12 hours old, for private-media reads. */
export function requireMediaFreshSignIn(
  customer: Pick<SignInClaims, 'authTime'>,
  nowSeconds: number = currentUnixSeconds(),
): Response | null {
  return requireSignInWithin(
    customer,
    MEDIA_SIGN_IN_MAX_AGE_SECONDS,
    nowSeconds,
  )
}

/**
 * AD+2F (private-media admin routes): a TOTP sign-in, unless ADMIN_MEDIA_MFA
 * is exactly "off" (TM-21: "OFF", " off", "false" or a missing var keep it
 * required; the release preflight refuses "off" for production).
 */
export function requireSecondFactor(
  env: Pick<Env, 'ADMIN_MEDIA_MFA'>,
  admin: Pick<SignInClaims, 'secondFactor'>,
): Response | null {
  const setting: unknown = env.ADMIN_MEDIA_MFA

  if (setting === ADMIN_MEDIA_MFA_OFF_VALUE || hasAdminSecondFactor(admin)) {
    return null
  }

  return secondFactorRequiredResponse()
}

/**
 * AD+S: a TOTP sign-in once ADMIN_SETTINGS_2F is exactly "required"; any
 * other value leaves the second factor optional. Call it after
 * requireRecentSignIn.
 */
export function requireSettingsSecondFactor(
  env: Pick<Env, 'ADMIN_SETTINGS_2F'>,
  admin: Pick<SignInClaims, 'secondFactor'>,
): Response | null {
  const setting: unknown = env.ADMIN_SETTINGS_2F

  if (
    setting !== ADMIN_SETTINGS_2F_REQUIRED_VALUE ||
    hasAdminSecondFactor(admin)
  ) {
    return null
  }

  return secondFactorRequiredResponse()
}

/**
 * The `reauth_at` a sensitive row stores (M1): the token's `auth_time` as an
 * ISO-8601 instant. Never `iat` (a refresh moves it) and never "now" (the
 * D1 CHECK on `created_at - reauth_at` would then prove nothing). The only
 * place a Worker turns a sign-in into a stored `reauth_at`.
 */
export function reauthAtFromToken(
  claims: Pick<SignInClaims, 'authTime'>,
): string {
  return unixSecondsToInstant(claims.authTime)
}
