import type { AuthenticatedFirebaseUser } from './auth.js'
import { errorResponse } from './http.js'
import { isSessionRevoked } from './recent-auth.js'

/**
 * The caller's `users` row and the rules every authenticated customer route
 * applies to it (audit SEC-01, SEC-04, SEC-11, SEC-14; migration 0007). The
 * admin guard reads its own row in one query (worker/admin-auth.ts); token
 * claims and session rules live in worker/auth.ts and worker/recent-auth.ts.
 *
 * - Revocation: a token whose sign-in (`auth_time`) is earlier than
 *   `users.tokens_valid_after` is refused as unauthenticated (401; the
 *   admin guard answers 403 REAUTH_REQUIRED instead). A refreshed token
 *   keeps its session's `auth_time`, so a stolen refresh token cannot mint
 *   an accepted token after the mark (the rule of Firebase Admin's
 *   `verifyIdToken(token, true)`; recent-auth.ts isSessionRevoked). "Sign
 *   out everywhere" and the admin script set the column.
 * - Erasure: a pseudonymised row (`erased_at` set) answers 410
 *   ACCOUNT_ERASED and is never written again.
 * - Email: `users.email` only ever takes an address from a VERIFIED token;
 *   `email_verified_at` records when that last happened. An unverified token
 *   may create the row (registration saves the profile before the email is
 *   verified) but never changes a stored address. A verified caller reclaims
 *   an address held by another row only if that row is an unverified,
 *   booking-less customer row. A booking attaches only to a row that holds
 *   the token's verified address, proven (isEmailBoundToToken), so a new
 *   booking can never keep an unproven address out of reclaim's reach (rows
 *   with bookings from before migration 0007 are stamped on their owner's
 *   next verified request). An admin row's address never follows the
 *   token: admin access is bound to uid + stored email (admin-auth.ts) and
 *   the address is changed only by the admin script
 *   (scripts/promote-admin.mjs).
 */

export interface UserAccount {
  readonly id: string
  readonly email: string
  readonly emailVerifiedAt: string | null
  readonly role: string
  readonly erasedAt: string | null
  /** Unix seconds, or null when no revocation was ever recorded. */
  readonly tokensValidAfter: number | null
}

export type AccountStanding =
  | {
      readonly ok: true
      /** Null when the caller has no users row yet. */
      readonly account: UserAccount | null
    }
  | {
      readonly ok: false
      readonly response: Response
    }

const ASCII_UPPERCASE = /[A-Z]/g

/**
 * Case-insensitive email equality with SQLite's NOCASE rule (ASCII letters
 * only), the collation of users.email.
 */
export function isSameEmailAddress(first: string, second: string): boolean {
  const fold = (value: string): string =>
    value.replace(ASCII_UPPERCASE, (letter) => letter.toLowerCase())

  return fold(first) === fold(second)
}

export async function loadUserAccount(
  db: D1Database,
  uid: string,
): Promise<UserAccount | null> {
  return db
    .prepare(
      `
        SELECT
          id,
          email,
          email_verified_at AS emailVerifiedAt,
          role,
          erased_at AS erasedAt,
          tokens_valid_after AS tokensValidAfter
        FROM users
        WHERE id = ?
        LIMIT 1
      `,
    )
    .bind(uid)
    .first<UserAccount>()
}

/**
 * True when the row holds the token's own verified address and that address
 * was proven (email_verified_at). A booking may attach only to such a row
 * (audit SEC-04, also enforced inside the booking INSERT): then a row that
 * owns a booking holds a proven address, so the booking-less condition of
 * reclaimUnverifiedEmailStatement never protects a squatted one.
 */
export function isEmailBoundToToken(
  identity: AuthenticatedFirebaseUser,
  account: UserAccount,
): boolean {
  return (
    identity.emailVerified &&
    account.emailVerifiedAt !== null &&
    isSameEmailAddress(account.email, identity.email)
  )
}

export function unauthorizedResponse(): Response {
  return errorResponse(
    401,
    'UNAUTHORIZED',
    'تعذر التحقق من تسجيل الدخول.',
    {
      'WWW-Authenticate': 'Bearer',
    },
  )
}

export function accountErasedResponse(): Response {
  return errorResponse(
    410,
    'ACCOUNT_ERASED',
    'تم حذف بيانات هذا الحساب بناءً على طلبكِ، ولا يمكن استخدامه بعد الآن.',
  )
}

/**
 * The address this caller may store: a verified token's own address for a
 * new row or a customer row; otherwise the stored address is kept.
 */
export function nextStoredEmail(
  identity: AuthenticatedFirebaseUser,
  account: UserAccount | null,
): string {
  if (!account) {
    return identity.email
  }

  return identity.emailVerified && account.role === 'customer'
    ? identity.email
    : account.email
}

/**
 * Deletes a row that squats on `email` (audit SEC-04 fix 3): another uid, a
 * customer, never verified, not erased and without any booking. Run it only
 * for a verified caller, in the same batch as (and before) the write that
 * takes the address; a failure of that write rolls it back too. The other
 * references to users(id) are ON DELETE SET NULL.
 */
export function reclaimUnverifiedEmailStatement(
  db: D1Database,
  email: string,
  uid: string,
): D1PreparedStatement {
  return db
    .prepare(
      `
        DELETE FROM users
        WHERE email = ? COLLATE NOCASE
          AND id <> ?
          AND role = 'customer'
          AND email_verified_at IS NULL
          AND erased_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM booking_requests
            WHERE booking_requests.user_id = users.id
          )
      `,
    )
    .bind(email, uid)
}

/**
 * Brings the stored address in line with a verified token (SEC-04 fix 4).
 * A no-op unless the token is verified and the row is not already the
 * token's address with a proof timestamp. Returns true when the row changed.
 * A conflict with another verified row, or a row with bookings, leaves the
 * stored address as it is.
 */
async function syncVerifiedEmail(
  db: D1Database,
  identity: AuthenticatedFirebaseUser,
  account: UserAccount,
): Promise<boolean> {
  if (!identity.emailVerified || account.erasedAt !== null) {
    return false
  }

  const email = nextStoredEmail(identity, account)
  const alreadyProven =
    account.emailVerifiedAt !== null && account.email === email

  if (alreadyProven || !isSameEmailAddress(email, identity.email)) {
    return false
  }

  const verifiedAt = new Date().toISOString()
  const changesAddress = !isSameEmailAddress(email, account.email)
  const updateStatement = db
    .prepare(
      `
        UPDATE users
        SET
          email = ?,
          email_verified_at = CASE
            WHEN email_verified_at IS NOT NULL AND email = ? THEN email_verified_at
            ELSE ?
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND erased_at IS NULL
          AND (role = 'customer' OR email = ?)
          AND NOT EXISTS (
            SELECT 1
            FROM users AS other
            WHERE other.email = ? COLLATE NOCASE
              AND other.id <> ?
          )
      `,
    )
    .bind(
      email,
      email,
      verifiedAt,
      account.id,
      email,
      email,
      account.id,
    )
  const statements = changesAddress
    ? [reclaimUnverifiedEmailStatement(db, email, account.id), updateStatement]
    : [updateStatement]
  const results = await db.batch(statements)

  return (results.at(-1)?.meta.changes ?? 0) === 1
}

/**
 * Revocation and erasure only: revoked token → 401 UNAUTHORIZED, erased row
 * → 410 ACCOUNT_ERASED. One primary-key read and no write, so a route runs
 * it before its rate limiter and a revoked token never uses up the owner's
 * allowance. A caller with no row passes with `account: null`.
 */
export async function readAccountStanding(
  db: D1Database,
  identity: AuthenticatedFirebaseUser,
): Promise<AccountStanding> {
  const account = await loadUserAccount(db, identity.uid)

  if (!account) {
    return { ok: true, account: null }
  }

  if (isSessionRevoked(identity, account.tokensValidAfter)) {
    return { ok: false, response: unauthorizedResponse() }
  }

  if (account.erasedAt !== null) {
    return { ok: false, response: accountErasedResponse() }
  }

  return { ok: true, account }
}

/**
 * The verified-email re-sync for a row that passed readAccountStanding.
 * Returns the row as stored afterwards: re-read when it changed, otherwise
 * the row passed in (whose address may then still be unproven or differ
 * from the token's; see isEmailBoundToToken).
 */
export async function syncAccountEmail(
  db: D1Database,
  identity: AuthenticatedFirebaseUser,
  account: UserAccount,
): Promise<UserAccount | null> {
  if (await syncVerifiedEmail(db, identity, account)) {
    return loadUserAccount(db, identity.uid)
  }

  return account
}

/**
 * The account rules shared by every authenticated customer route:
 * readAccountStanding, then the verified-email re-sync. A caller with no row
 * passes with `account: null`; the route decides what a missing profile
 * means.
 */
export async function checkCustomerAccount(
  db: D1Database,
  identity: AuthenticatedFirebaseUser,
): Promise<AccountStanding> {
  const standing = await readAccountStanding(db, identity)

  if (!standing.ok || standing.account === null) {
    return standing
  }

  return {
    ok: true,
    account: await syncAccountEmail(db, identity, standing.account),
  }
}
