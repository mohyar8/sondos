import { ADMIN_SESSION_MAX_AGE_SECONDS } from '../shared/admin-session.js'
import {
  authenticateFirebaseRequest,
  requireVerifiedEmail,
  type AuthenticatedFirebaseUser,
} from './auth.js'
import { errorResponse } from './http.js'
import {
  isRecentAuthentication,
  reauthRequiredResponse,
} from './recent-auth.js'
import { unauthorizedResponse } from './users.js'

/**
 * The admin of this request, from verified claims. `authTime` and
 * `secondFactor` feed the per-route guards of worker/recent-auth.ts
 * (requireRecentSignIn, requireSecondFactor, requireSettingsSecondFactor,
 * reauthAtFromToken).
 */
export interface AuthenticatedAdmin {
  readonly uid: string
  /** `auth_time`, Unix seconds. */
  readonly authTime: number
  /** `firebase.sign_in_second_factor`, or null for a password-only sign-in. */
  readonly secondFactor: string | null
}

/**
 * Why the guard refused. Callers rewrite only 'unauthenticated' into their
 * surface's own 401; every other failure passes through as it is.
 */
export type AdminAuthorizationFailure =
  | 'unauthenticated'
  | 'email-not-verified'
  | 'forbidden'
  | 'reauth-required'

export type AdminAuthorizationResult =
  | {
      ok: true
      admin: AuthenticatedAdmin
    }
  | {
      ok: false
      failure: AdminAuthorizationFailure
      response: Response
    }

/**
 * The admin binding of one users row, every predicate computed by SQLite in
 * the one query (1 = holds). Typed `unknown`: anything but the integer 1
 * reads as "does not hold".
 */
interface AdminBindingRow {
  readonly isAdmin: unknown
  readonly emailMatches: unknown
  readonly emailProven: unknown
  readonly notErased: unknown
  readonly signedInAfterRevocation: unknown
}

type AdminBinding = 'bound' | 'not-bound' | 'revoked'

function forbiddenResponse(): Response {
  return errorResponse(
    403,
    'FORBIDDEN',
    'لا يملك هذا الحساب صلاحية الوصول إلى لوحة الإدارة.',
  )
}

function refuse(
  failure: AdminAuthorizationFailure,
  response: Response,
): AdminAuthorizationResult {
  return {
    ok: false,
    failure,
    response,
  }
}

/**
 * Reads the caller's users row and decides, in the same D1 query, whether
 * it binds this token to the admin (TM-02, C-14):
 * - role 'admin', not erased, a proven stored address (email_verified_at)
 *   equal to the token's address, `lower(email) = lower(?)` (SQLite folds
 *   ASCII letters only, like the column's NOCASE collation);
 * - `tokens_valid_after IS NULL OR tokens_valid_after <= auth_time`: the
 *   sign-in is not older than the revocation mark. `auth_time`, never
 *   `iat`, so a token refreshed after "sign out everywhere" still fails.
 * The stored address never leaves the database.
 */
async function readAdminBinding(
  db: D1Database,
  identity: AuthenticatedFirebaseUser,
): Promise<AdminBinding> {
  const row = await db
    .prepare(
      `
        SELECT
          role = 'admin' AS isAdmin,
          lower(email) = lower(?) AS emailMatches,
          email_verified_at IS NOT NULL AS emailProven,
          erased_at IS NULL AS notErased,
          (tokens_valid_after IS NULL OR tokens_valid_after <= ?)
            AS signedInAfterRevocation
        FROM users
        WHERE id = ?
        LIMIT 1
      `,
    )
    .bind(identity.email, identity.authTime, identity.uid)
    .first<AdminBindingRow>()

  if (
    row === null ||
    row.isAdmin !== 1 ||
    row.emailMatches !== 1 ||
    row.emailProven !== 1 ||
    row.notErased !== 1
  ) {
    return 'not-bound'
  }

  return row.signedInAfterRevocation === 1 ? 'bound' : 'revoked'
}

/**
 * The admin guard for every /api/admin path (plan 11 §3.1 AD; C-1, TM-02,
 * TM-07, C-14). In order:
 * 1. a valid Firebase token (401; the callers answer UNAUTHENTICATED);
 * 2. a verified token email (403 EMAIL_NOT_VERIFIED);
 * 3. one D1 read of the uid's row: role 'admin', not erased, and its proven
 *    stored email equal to the token's email, else 403 FORBIDDEN. The
 *    stored address never follows the token for an admin (worker/users.ts)
 *    and changes only through the admin script (scripts/promote-admin.mjs),
 *    so a uid promoted under someone else's address, or an admin account
 *    whose Firebase email was changed, is refused;
 * 4. a session that is fresh (ADf): signed in at most 12 hours ago and not
 *    before users.tokens_valid_after, else 403 REAUTH_REQUIRED; the SPA asks
 *    for the password and retries once.
 * There is no global second-factor switch: routes that need one call
 * requireSecondFactor or requireSettingsSecondFactor (worker/recent-auth.ts).
 */
export async function authorizeAdminRequest(
  request: Request,
  env: Env,
): Promise<AdminAuthorizationResult> {
  const identity =
    await authenticateFirebaseRequest(request, env)

  if (!identity) {
    return refuse('unauthenticated', unauthorizedResponse())
  }

  const verificationError =
    requireVerifiedEmail(identity)

  if (verificationError) {
    return refuse('email-not-verified', verificationError)
  }

  const binding = await readAdminBinding(env.DB, identity)

  if (binding === 'not-bound') {
    return refuse('forbidden', forbiddenResponse())
  }

  if (
    binding === 'revoked' ||
    !isRecentAuthentication(identity, ADMIN_SESSION_MAX_AGE_SECONDS)
  ) {
    return refuse('reauth-required', reauthRequiredResponse())
  }

  return {
    ok: true,
    admin: {
      uid: identity.uid,
      authTime: identity.authTime,
      secondFactor: identity.secondFactor,
    },
  }
}
