import { normalizePersonName } from '../shared/text.js'
import {
  authenticateFirebaseRequest,
  type AuthenticatedFirebaseUser,
} from './auth.js'
import {
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  payloadTooLargeResponse,
  readBoundedJson,
} from './http.js'
import { isRateLimited, rateLimitedResponse } from './rate-limit.js'
import {
  accountErasedResponse,
  checkCustomerAccount,
  isSameEmailAddress,
  loadUserAccount,
  nextStoredEmail,
  readAccountStanding,
  reclaimUnverifiedEmailStatement,
} from './users.js'

const MAXIMUM_PHONE_INPUT_LENGTH = 32
/** UTF-8 bytes (audit SEC-05); a real profile body is well under 1 KiB. */
const MAXIMUM_PROFILE_BODY_BYTES = 4_096
const allowedProfileFields = new Set([
  'firstName',
  'lastName',
  'phone',
])

interface ProfileUpdate {
  firstName: string
  lastName: string
  phone: string
}

interface ValidProfileUpdate {
  ok: true
  value: ProfileUpdate
}

interface InvalidProfileUpdate {
  ok: false
  message: string
}

type ProfileUpdateResult =
  | ValidProfileUpdate
  | InvalidProfileUpdate

type UserProfileRow = {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string
  role: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
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

function normalizePhone(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmedValue = value.trim()

  if (
    trimmedValue.length === 0 ||
    trimmedValue.length > MAXIMUM_PHONE_INPUT_LENGTH ||
    containsControlCharacter(trimmedValue)
  ) {
    return null
  }

  const compactValue = trimmedValue.replace(/[\s()-]/g, '')

  if (/^05\d{8}$/.test(compactValue)) {
    return `+966${compactValue.slice(1)}`
  }

  if (/^5\d{8}$/.test(compactValue)) {
    return `+966${compactValue}`
  }

  if (/^9665\d{8}$/.test(compactValue)) {
    return `+${compactValue}`
  }

  if (/^\+9665\d{8}$/.test(compactValue)) {
    return compactValue
  }

  if (/^\+[1-9]\d{7,14}$/.test(compactValue)) {
    return compactValue
  }

  return null
}

function parseProfileUpdate(value: unknown): ProfileUpdateResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      message: 'بيانات الملف الشخصي غير صحيحة.',
    }
  }

  const hasUnexpectedField = Object.keys(value).some(
    (key) => !allowedProfileFields.has(key),
  )

  if (hasUnexpectedField) {
    return {
      ok: false,
      message: 'تحتوي البيانات على حقول غير مسموحة.',
    }
  }

  // One name rule for the forms and the Worker (audit SEC-10, plan R-07):
  // a name the sign-up form accepts is never refused here.
  const firstName = normalizePersonName(value.firstName)
  const lastName = normalizePersonName(value.lastName)
  const phone = normalizePhone(value.phone)

  if (!firstName) {
    return {
      ok: false,
      message:
        'اكتبي الاسم الأول بحروف عربية أو لاتينية فقط، دون أرقام أو رموز أو روابط، وبما لا يتجاوز 80 حرفًا.',
    }
  }

  if (!lastName) {
    return {
      ok: false,
      message:
        'اكتبي اسم العائلة بحروف عربية أو لاتينية فقط، دون أرقام أو رموز أو روابط، وبما لا يتجاوز 80 حرفًا.',
    }
  }

  if (!phone) {
    return {
      ok: false,
      message: 'رقم الجوال غير صحيح.',
    }
  }

  return {
    ok: true,
    value: {
      firstName,
      lastName,
      phone,
    },
  }
}

async function findProfile(
  env: Env,
  uid: string,
): Promise<UserProfileRow | null> {
  return env.DB.prepare(
    `
      SELECT
        id,
        email,
        first_name AS firstName,
        last_name AS lastName,
        phone,
        role
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
  )
    .bind(uid)
    .first<UserProfileRow>()
}

function unauthorizedResponse(): Response {
  return errorResponse(
    401,
    'UNAUTHORIZED',
    'تعذر التحقق من تسجيل الدخول.',
    {
      'WWW-Authenticate': 'Bearer',
    },
  )
}

function emailConflictResponse(): Response {
  return errorResponse(
    409,
    'EMAIL_ALREADY_IN_USE',
    'تعذر ربط البريد الإلكتروني بهذا الحساب.',
  )
}

function invalidJsonResponse(): Response {
  return errorResponse(
    400,
    'INVALID_JSON',
    'تعذر قراءة بيانات الملف الشخصي.',
  )
}

async function handleGetProfile(
  env: Env,
  identity: AuthenticatedFirebaseUser,
): Promise<Response> {
  const standing = await checkCustomerAccount(env.DB, identity)

  if (!standing.ok) {
    return standing.response
  }

  const profile = standing.account
    ? await findProfile(env, identity.uid)
    : null

  if (!profile) {
    return errorResponse(
      404,
      'PROFILE_NOT_FOUND',
      'لم يتم العثور على الملف الشخصي.',
    )
  }

  return jsonResponse({
    ok: true,
    profile,
  })
}

/**
 * Creates or updates the caller's row (audit SEC-04, SEC-14).
 *
 * - The row is read again AFTER the body: the client decides how long the
 *   body takes, so the read handleProfile made before the limiter may be
 *   stale by then. That read only gates (revocation, erasure).
 * - The address written is `nextStoredEmail`: the token's own address when
 *   the token is verified (or the row is new), otherwise the stored one. So
 *   registration still saves the profile before the email is verified, but
 *   an unverified token never re-points an existing row, and an admin row's
 *   address never follows the token.
 * - The upsert enforces that rule itself, whatever the read saw: on an
 *   existing row the address changes only together with a new proof stamp
 *   (a verified token's own address), so an unverified write that raced a
 *   verified one cannot leave the victim's address under the other
 *   address's proof, out of reclaim's reach.
 * - `email_verified_at` is stamped only when a verified token proves the
 *   written address; a changed address gets a new stamp.
 * - A verified caller first reclaims the address from an unverified,
 *   booking-less customer row (same batch). Any other holder of the address
 *   makes the write a no-op and the answer 409 EMAIL_ALREADY_IN_USE.
 * - An erased row is never written: 410 ACCOUNT_ERASED.
 */
async function handlePutProfile(
  request: Request,
  env: Env,
  identity: AuthenticatedFirebaseUser,
): Promise<Response> {
  const body = await readBoundedJson(request, MAXIMUM_PROFILE_BODY_BYTES)

  if (body.kind === 'unsupported-media-type') {
    return errorResponse(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'يجب إرسال بيانات الملف الشخصي بصيغة JSON.',
    )
  }

  if (body.kind === 'too-large') {
    return payloadTooLargeResponse()
  }

  if (body.kind !== 'parsed') {
    return invalidJsonResponse()
  }

  const parsedUpdate = parseProfileUpdate(body.value)

  if (!parsedUpdate.ok) {
    return errorResponse(
      400,
      'INVALID_PROFILE',
      parsedUpdate.message,
    )
  }

  const standing = await readAccountStanding(env.DB, identity)

  if (!standing.ok) {
    return standing.response
  }

  const account = standing.account
  const email = nextStoredEmail(identity, account)
  const emailProven =
    identity.emailVerified && isSameEmailAddress(email, identity.email)
  const verifiedAt = emailProven ? new Date().toISOString() : null
  const upsertStatement = env.DB.prepare(
    `
      INSERT INTO users (
        id,
        email,
        email_verified_at,
        first_name,
        last_name,
        phone,
        role
      )
      SELECT ?, ?, ?, ?, ?, ?, 'customer'
      WHERE NOT EXISTS (
        SELECT 1
        FROM users
        WHERE email = ? COLLATE NOCASE
          AND id <> ?
      )
      ON CONFLICT(id) DO UPDATE SET
        email = CASE
          WHEN users.role = 'customer'
            AND excluded.email_verified_at IS NOT NULL
            THEN excluded.email
          ELSE users.email
        END,
        email_verified_at = CASE
          WHEN excluded.email_verified_at IS NULL THEN users.email_verified_at
          WHEN users.email <> excluded.email AND users.role <> 'customer'
            THEN users.email_verified_at
          WHEN users.email_verified_at IS NOT NULL AND users.email = excluded.email
            THEN users.email_verified_at
          ELSE excluded.email_verified_at
        END,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        phone = excluded.phone,
        updated_at = CURRENT_TIMESTAMP
      WHERE users.erased_at IS NULL
    `,
  ).bind(
    identity.uid,
    email,
    verifiedAt,
    parsedUpdate.value.firstName,
    parsedUpdate.value.lastName,
    parsedUpdate.value.phone,
    email,
    identity.uid,
  )
  const takesNewAddress =
    emailProven && (!account || !isSameEmailAddress(account.email, email))
  const statements = takesNewAddress
    ? [
        reclaimUnverifiedEmailStatement(env.DB, email, identity.uid),
        upsertStatement,
      ]
    : [upsertStatement]
  const results = await env.DB.batch(statements)

  if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
    const current = await loadUserAccount(env.DB, identity.uid)

    return current && current.erasedAt !== null
      ? accountErasedResponse()
      : emailConflictResponse()
  }

  const savedProfile = await findProfile(env, identity.uid)

  if (!savedProfile) {
    throw new Error('Saved profile was not found')
  }

  return jsonResponse({
    ok: true,
    profile: savedProfile,
  })
}

export async function handleProfile(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'PUT') {
    return methodNotAllowedResponse(['GET', 'PUT'])
  }

  const identity = await authenticateFirebaseRequest(request, env)

  if (!identity) {
    return unauthorizedResponse()
  }

  if (request.method === 'GET') {
    return handleGetProfile(env, identity)
  }

  // Revoked token → 401, erased account → 410 (audit SEC-11, SEC-14), before
  // the limiter, so a revoked token cannot use up the owner's allowance.
  // A gate only: handlePutProfile reads the row again after the body.
  const standing = await readAccountStanding(env.DB, identity)

  if (!standing.ok) {
    return standing.response
  }

  // Audit SEC-03: a per-uid burst limit (RL_PROFILE → 429 RATE_LIMITED)
  // before the body and any D1 write.
  if (await isRateLimited(env, 'profile-write', identity.uid)) {
    return rateLimitedResponse()
  }

  return handlePutProfile(request, env, identity)
}
