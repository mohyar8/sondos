import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { RECENT_SIGN_IN_GUARD_SECONDS } from '../shared/admin-session.js'
import { errorResponse } from './http.js'

const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
const SECOND_FACTOR_PATTERN = /^[a-z_]{1,32}$/

/**
 * Wave 0 names of the session-freshness helpers, kept only for
 * worker/portal/request.ts. They live in worker/recent-auth.ts; new code
 * imports them from there. reauthRequiredResponse answers 403
 * REAUTH_REQUIRED (not Wave 0's 401).
 */
export {
  isRecentAuthentication,
  reauthRequiredResponse,
} from './recent-auth.js'

/**
 * @deprecated Wave 0 name, kept only for worker/portal/request.ts
 * requireRecentAuthentication, which no route calls any more. Use the
 * guards of worker/recent-auth.ts instead: requireMediaFreshSignIn (CO+M,
 * private-media reads, 12 hours) or requireRecentCustomerSignIn (CO+R).
 * Fail-safe: it stays the short CO+R window, RECENT_SIGN_IN_GUARD_SECONDS,
 * so a route that still reaches for the old helper gets a guard stricter
 * than its "10 minutes" docs, never a 12-hour one.
 */
export const PRIVATE_MEDIA_MAX_AUTH_AGE_SECONDS = RECENT_SIGN_IN_GUARD_SECONDS

const firebasePublicKeys = createRemoteJWKSet(
  new URL(FIREBASE_JWKS_URL),
)

export interface AuthenticatedFirebaseUser {
  uid: string
  email: string
  emailVerified: boolean
  /**
   * `auth_time`, Unix seconds: when the user last actually signed in (a
   * refreshed token keeps it). Every session rule reads it, never `iat`:
   * the sign-in ages of worker/recent-auth.ts and worker/admin-auth.ts, the
   * revocation mark users.tokens_valid_after (C-14) and a stored
   * `reauth_at` (reauthAtFromToken, M1).
   */
  authTime: number
  /**
   * `firebase.sign_in_second_factor` ('totp', 'phone'), or null for a
   * single-factor sign-in.
   */
  secondFactor: string | null
}

export function requireVerifiedEmail(
  identity: AuthenticatedFirebaseUser,
): Response | null {
  if (identity.emailVerified) {
    return null
  }

  return errorResponse(
    403,
    'EMAIL_NOT_VERIFIED',
    'يجب تأكيد البريد الإلكتروني قبل متابعة هذه العملية.',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index)

    if (
      characterCode <= 0x1f ||
      (characterCode >= 0x7f && characterCode <= 0x9f)
    ) {
      return true
    }
  }

  return false
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get('Authorization')

  if (!authorization) {
    return null
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization)

  if (!match || !match[1]) {
    return null
  }

  return match[1]
}

/** A NumericDate claim: a finite, non-negative number of Unix seconds. */
function isValidNumericDate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  )
}

/**
 * The second factor of this sign-in from the `firebase` claim. Absent or
 * malformed reads as none, which can only ever deny (never grant) MFA.
 */
function readSecondFactor(firebaseClaim: unknown): string | null {
  if (!isRecord(firebaseClaim)) {
    return null
  }

  const factor = firebaseClaim.sign_in_second_factor

  return typeof factor === 'string' && SECOND_FACTOR_PATTERN.test(factor)
    ? factor
    : null
}

export async function authenticateFirebaseRequest(
  request: Request,
  env: Env,
): Promise<AuthenticatedFirebaseUser | null> {
  const token = extractBearerToken(request)
  const configuredProjectId: unknown = env.FIREBASE_PROJECT_ID
  const projectId =
    typeof configuredProjectId === 'string' ? configuredProjectId.trim() : ''

  if (!token || !projectId) {
    return null
  }

  try {
    const issuer =
      `https://securetoken.google.com/${projectId}`

    const { payload, protectedHeader } = await jwtVerify(
      token,
      firebasePublicKeys,
      {
        algorithms: ['RS256'],
        audience: projectId,
        issuer,
        requiredClaims: [
          'exp',
          'iat',
          'sub',
          'auth_time',
        ],
      },
    )

    // Fail closed: a missing, non-numeric, negative or future time claim,
    // or a missing subject or email, is no sign-in at all.
    const currentTime = Math.floor(Date.now() / 1000)
    const authTime = payload.auth_time

    if (
      protectedHeader.alg !== 'RS256' ||
      typeof protectedHeader.kid !== 'string' ||
      protectedHeader.kid.length === 0 ||
      !isValidNumericDate(payload.exp) ||
      payload.exp <= currentTime ||
      !isValidNumericDate(payload.iat) ||
      payload.iat > currentTime ||
      !isValidNumericDate(authTime) ||
      authTime > currentTime ||
      typeof payload.sub !== 'string' ||
      payload.sub.trim().length === 0 ||
      payload.sub.length > 128 ||
      containsControlCharacter(payload.sub) ||
      typeof payload.email !== 'string'
    ) {
      return null
    }

    const email = payload.email.trim()

    if (
      email.length === 0 ||
      email.length > 320 ||
      containsControlCharacter(email)
    ) {
      return null
    }

    return {
      uid: payload.sub,
      email,
      emailVerified: payload.email_verified === true,
      authTime,
      secondFactor: readSecondFactor(payload.firebase),
    }
  } catch (error) {
    // Every rejected token (bad signature, claims or format, unknown kid, a
    // JWKS timeout) is a JOSEError: unauthenticated. Anything else (a network
    // error while fetching the JWKS, a runtime fault) is no verdict on the
    // token, so it propagates and becomes a 500 INTERNAL_ERROR.
    if (error instanceof errors.JOSEError) {
      return null
    }

    throw error
  }
}
