import { bookingStatuses, type BookingStatus } from '../../shared/admin.js'
import {
  PRIVATE_MEDIA_MAX_AUTH_AGE_SECONDS,
  authenticateFirebaseRequest,
  isRecentAuthentication,
  reauthRequiredResponse,
  requireVerifiedEmail,
  type AuthenticatedFirebaseUser,
} from '../auth.js'
import {
  errorResponse,
  readBoundedBytes,
  readJsonBody as readBoundedJsonBody,
} from '../http.js'
import { checkCustomerAccount } from '../users.js'
import { featureUnavailableResponse } from './gates.js'

/**
 * Request guards for the client portal (ADR-001 §2.1 step 1, §2.7 "Upload
 * abuse"; API contract §1.3–§1.5).
 *
 * - requireVerifiedCustomer: the customer-owner auth chain over
 *   worker/auth.ts and worker/users.ts: 401 UNAUTHORIZED → 403
 *   EMAIL_NOT_VERIFIED → 401 for a revoked token → 410 ACCOUNT_ERASED.
 * - requireRecentAuthentication: private-media routes also need a sign-in
 *   at most 10 minutes old (401 REAUTH_REQUIRED, audit SEC-20).
 * - loadOwnedBooking: the one ownership query the dispatcher runs before any
 *   customer handler (audit SEC-16). Handlers still filter
 *   `booking_requests.user_id = customer.uid` inside their own SQL as a
 *   second layer.
 * - verifySignedMediaRequest / signMediaPath: the signed-url check the media
 *   dispatcher runs before any media handler, and the one way to mint such a
 *   URL (API contract §3.C).
 * - readJsonBody: worker/http.ts's bounded reader (`application/json` only,
 *   415; a UTF-8 byte cap enforced against Content-Length AND while reading;
 *   strict UTF-8), then a plain JSON object with an exact key set (unknown or
 *   missing keys → 400 INVALID_REQUEST_BODY).
 * - readMultipartBody: Content-Length is REQUIRED and checked before a single
 *   byte is read (missing → 411 LENGTH_REQUIRED, over the cap → 413
 *   FILE_TOO_LARGE), then `multipart/form-data` with a boundary (415), then
 *   exactly the declared parts, each at most once, file parts as files and
 *   text parts as text, each within its own cap.
 *
 * Every failure carries the finished Arabic error response AND a typed
 * `failure` kind, so a handler can return the response as it is or swap it
 * for its own (e.g. FIELD_TOO_LONG for an over-cap JSON body).
 * Nothing here logs anything.
 */

/** A customer whose Firebase token is valid and whose email is verified. */
export interface VerifiedCustomer extends AuthenticatedFirebaseUser {
  readonly emailVerified: true
}

/** A booking the dispatcher has proven belongs to the verified customer. */
export interface OwnedBooking {
  readonly id: string
  readonly eventDate: string
  readonly status: BookingStatus
}

export type OwnedBookingResult =
  | {
      readonly ok: true
      readonly booking: OwnedBooking
    }
  | {
      readonly ok: false
      readonly response: Response
    }

/** A /api/media request whose signature and expiry verified. */
export interface VerifiedMediaRequest {
  /** The media key, exactly as signed (never percent-decoded). */
  readonly key: string
  /** The link's expiry, Unix seconds. */
  readonly expiresAt: number
}

export type SignedMediaResult =
  | {
      readonly ok: true
      readonly media: VerifiedMediaRequest
    }
  | {
      readonly ok: false
      readonly response: Response
    }

export type VerifiedCustomerResult =
  | {
      readonly ok: true
      readonly customer: VerifiedCustomer
    }
  | {
      readonly ok: false
      readonly response: Response
    }

export type BodyFailureKind =
  | 'unsupported-media-type'
  | 'length-required'
  | 'too-large'
  | 'invalid'

export interface BodyReadFailure {
  readonly ok: false
  readonly failure: BodyFailureKind
  readonly response: Response
}

export interface JsonBodySpec {
  /** Cap on the body in UTF-8 bytes. */
  readonly maxBytes: number
  /** Keys that must be present. */
  readonly requiredKeys: readonly string[]
  /** Keys that may be present. Any key outside both lists rejects the body. */
  readonly optionalKeys?: readonly string[]
}

export type JsonBodyResult =
  | {
      readonly ok: true
      /**
       * A plain object holding only declared keys, every required key
       * present. The values are still untrusted: validate each one with a
       * runtime guard before use.
       */
      readonly body: Readonly<Record<string, unknown>>
    }
  | BodyReadFailure

export interface MultipartFileField<Name extends string> {
  readonly name: Name
  /** Cap on this part's bytes; a larger file answers 413 FILE_TOO_LARGE. */
  readonly maxBytes: number
}

export interface MultipartTextField<Name extends string> {
  readonly name: Name
  /** Cap in code points (what SQLite's length() counts). */
  readonly maxLength: number
}

/**
 * The exact part list of one multipart endpoint. Every declared part is
 * required, appears once, and no other part name is accepted (the multipart
 * form of the exact-key rule, API contract §1.4). File and text names must
 * not overlap.
 */
export interface MultipartSpec<FileName extends string, TextName extends string> {
  /**
   * Cap on the whole request in bytes (parts plus multipart overhead). The
   * declared Content-Length is checked against it before anything is read.
   */
  readonly maxBytes: number
  readonly files: readonly MultipartFileField<FileName>[]
  readonly texts: readonly MultipartTextField<TextName>[]
}

export interface MultipartFile {
  /** The raw bytes. The client's declared part type is ignored: sniff these. */
  readonly bytes: Uint8Array
  readonly size: number
}

/** Typed access to the declared parts; every one of them is present. */
export interface MultipartBody<FileName extends string, TextName extends string> {
  file(name: FileName): MultipartFile
  /** The text exactly as sent (not trimmed or normalised). */
  text(name: TextName): string
}

export type MultipartBodyResult<FileName extends string, TextName extends string> =
  | {
      readonly ok: true
      readonly body: MultipartBody<FileName, TextName>
    }
  | BodyReadFailure

type DeclaredLength =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'value'; readonly bytes: number }

const DECLARED_LENGTH_PATTERN = /^\d{1,15}$/
const MULTIPART_MEDIA_TYPE = 'multipart/form-data'
/** API contract §3.C: receipt `r/<booking>/<receipt>` or gallery `g/<gallery>/<photo>[/p|/t]`. */
const MEDIA_KEY_PATTERN = /^(r|g)\/[0-9a-f-]{36}\/[0-9a-f-]{36}(\/(p|t))?$/
const MEDIA_EXPIRY_PATTERN = /^\d{1,12}$/
/** base64url of a 32-byte HMAC-SHA256, unpadded. */
const MEDIA_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MEDIA_SIGNATURE_VERSION = 'v1'
const MAXIMUM_MEDIA_LINK_LIFETIME_SECONDS = 2 * 60 * 60
const MINIMUM_MEDIA_SIGNING_KEY_LENGTH = 32
const mediaQueryParameters: ReadonlySet<string> = new Set(['e', 's'])
const utf8Encoder = new TextEncoder()

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

function invalidRequestBodyResponse(): Response {
  return errorResponse(
    400,
    'INVALID_REQUEST_BODY',
    'بيانات الطلب غير صحيحة.',
  )
}

function jsonMediaTypeResponse(): Response {
  return errorResponse(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'يجب إرسال بيانات الطلب بصيغة JSON.',
  )
}

function multipartMediaTypeResponse(): Response {
  return errorResponse(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'يجب إرسال الملف بصيغة multipart/form-data.',
  )
}

function lengthRequiredResponse(): Response {
  return errorResponse(
    411,
    'LENGTH_REQUIRED',
    'يجب أن يتضمّن الطلب حجم الملف. أعيدي المحاولة.',
  )
}

function fileTooLargeResponse(): Response {
  return errorResponse(
    413,
    'FILE_TOO_LARGE',
    'حجم الملف أكبر من الحد المسموح به.',
  )
}

function bookingNotFoundResponse(): Response {
  return errorResponse(
    404,
    'BOOKING_NOT_FOUND',
    'لم يتم العثور على طلب الحجز.',
  )
}

function invalidMediaKeyResponse(): Response {
  return errorResponse(
    400,
    'INVALID_MEDIA_KEY',
    'رابط الملف غير صحيح.',
  )
}

function signatureInvalidResponse(): Response {
  return errorResponse(
    403,
    'SIGNATURE_INVALID',
    'انتهت صلاحية رابط الملف أو أنه غير صالح. حدّثي الصفحة ثم أعيدي المحاولة.',
  )
}

function bodyFailure(
  failure: BodyFailureKind,
  response: Response,
): BodyReadFailure {
  return {
    ok: false,
    failure,
    response,
  }
}

function invalidBody(): BodyReadFailure {
  return bodyFailure('invalid', invalidRequestBodyResponse())
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

function countCodePoints(value: string): number {
  return Array.from(value).length
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The media type before any parameters, lower-cased; null when absent. */
function readMediaType(request: Request): string | null {
  const contentType = request.headers.get('Content-Type')

  if (contentType === null) {
    return null
  }

  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? null
}

/** True when a Content-Type header carries a non-empty boundary parameter. */
function hasMultipartBoundary(contentType: string): boolean {
  return contentType
    .split(';')
    .slice(1)
    .some((parameter) => {
      const separatorIndex = parameter.indexOf('=')

      if (separatorIndex === -1) {
        return false
      }

      const name = parameter.slice(0, separatorIndex).trim().toLowerCase()
      const value = parameter
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1')

      return name === 'boundary' && value.length > 0 && value.length <= 70
    })
}

function readDeclaredLength(request: Request): DeclaredLength {
  const declaredLength = request.headers.get('Content-Length')

  if (declaredLength === null) {
    return { kind: 'absent' }
  }

  const trimmedLength = declaredLength.trim()

  if (!DECLARED_LENGTH_PATTERN.test(trimmedLength)) {
    return { kind: 'invalid' }
  }

  return {
    kind: 'value',
    bytes: Number(trimmedLength),
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  spec: JsonBodySpec,
): boolean {
  const allowedKeys = new Set([
    ...spec.requiredKeys,
    ...(spec.optionalKeys ?? []),
  ])

  return (
    Object.keys(value).every((key) => allowedKeys.has(key)) &&
    spec.requiredKeys.every((key) => Object.hasOwn(value, key))
  )
}

/**
 * The customer-owner auth chain (API contract §1.5): a valid Firebase ID
 * token (401 UNAUTHORIZED otherwise, with `WWW-Authenticate: Bearer`), then a
 * verified email (403 EMAIL_NOT_VERIFIED, from worker/auth.ts). On success the
 * caller gets the uid to bind as `user_id = ?` inside its own SQL.
 */
export async function requireVerifiedCustomer(
  request: Request,
  env: Env,
): Promise<VerifiedCustomerResult> {
  const identity = await authenticateFirebaseRequest(request, env)

  if (!identity) {
    return {
      ok: false,
      response: unauthorizedResponse(),
    }
  }

  const verificationError = requireVerifiedEmail(identity)

  if (verificationError) {
    return {
      ok: false,
      response: verificationError,
    }
  }

  if (!identity.emailVerified) {
    // requireVerifiedEmail refuses this case already; fail closed if it ever
    // stops doing so.
    return {
      ok: false,
      response: unauthorizedResponse(),
    }
  }

  // Revoked token → 401, erased account → 410 (audit SEC-11, SEC-14).
  const standing = await checkCustomerAccount(env.DB, identity)

  if (!standing.ok) {
    return {
      ok: false,
      response: standing.response,
    }
  }

  return {
    ok: true,
    customer: {
      ...identity,
      emailVerified: identity.emailVerified,
    },
  }
}

/**
 * Private-media routes (receipts, galleries) also need a recent sign-in
 * (audit SEC-20): null when the customer signed in at most 10 minutes ago,
 * otherwise 401 REAUTH_REQUIRED for the SPA's password prompt.
 */
export function requireRecentAuthentication(
  customer: VerifiedCustomer,
): Response | null {
  return isRecentAuthentication(customer, PRIVATE_MEDIA_MAX_AUTH_AGE_SECONDS)
    ? null
    : reauthRequiredResponse()
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return (
    typeof value === 'string' &&
    bookingStatuses.some((status) => status === value)
  )
}

interface OwnedBookingRow {
  id: string
  eventDate: string
  status: string
}

/**
 * The ownership check for every `/api/bookings/{bookingId}/...` route (audit
 * SEC-16), run by the dispatcher before the handler: the booking must exist
 * AND belong to this customer, in one query. Someone else's booking and a
 * missing one both answer 404 BOOKING_NOT_FOUND, never 403.
 */
export async function loadOwnedBooking(
  db: D1Database,
  bookingId: string,
  customer: VerifiedCustomer,
): Promise<OwnedBookingResult> {
  const row = await db
    .prepare(
      `
        SELECT
          id,
          event_date AS eventDate,
          status
        FROM booking_requests
        WHERE id = ?
          AND user_id = ?
        LIMIT 1
      `,
    )
    .bind(bookingId, customer.uid)
    .first<OwnedBookingRow>()

  if (!row) {
    return { ok: false, response: bookingNotFoundResponse() }
  }

  if (!isBookingStatus(row.status)) {
    throw new Error('Stored booking status is invalid')
  }

  return {
    ok: true,
    booking: {
      id: row.id,
      eventDate: row.eventDate,
      status: row.status,
    },
  }
}

/** The signing keys in force: the current one, then the previous during a rotation. */
function mediaSigningKeys(env: Env): string[] {
  return [env.MEDIA_SIGNING_KEY, env.MEDIA_SIGNING_KEY_PREVIOUS].filter(
    (key): key is string =>
      typeof key === 'string' &&
      key.length >= MINIMUM_MEDIA_SIGNING_KEY_LENGTH,
  )
}

function importMediaSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    utf8Encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function mediaSignaturePayload(key: string, expiresAt: number): Uint8Array {
  return utf8Encoder.encode(
    `${MEDIA_SIGNATURE_VERSION}\n${key}\n${expiresAt}`,
  )
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (value.length % 4)) % 4)

  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

/**
 * Mints the path of a signed media link (API contract §3.C):
 * `/api/media/<key>?e=<expiresAt>&s=<base64url(HMAC-SHA256(MEDIA_SIGNING_KEY, "v1\n"+key+"\n"+e))>`.
 * Call it only AFTER the caller's ownership or admin check. Null when no
 * usable signing key is configured, the key is malformed or the expiry is
 * outside the next 2 hours.
 */
export async function signMediaPath(
  env: Env,
  key: string,
  expiresAt: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const signingKey = env.MEDIA_SIGNING_KEY

  if (
    typeof signingKey !== 'string' ||
    signingKey.length < MINIMUM_MEDIA_SIGNING_KEY_LENGTH ||
    !MEDIA_KEY_PATTERN.test(key) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds ||
    expiresAt > nowSeconds + MAXIMUM_MEDIA_LINK_LIFETIME_SECONDS
  ) {
    return null
  }

  const cryptoKey = await importMediaSigningKey(signingKey)
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      mediaSignaturePayload(key, expiresAt),
    ),
  )
  const query = new URLSearchParams({
    e: String(expiresAt),
    s: encodeBase64Url(signature),
  })

  return `/api/media/${key}?${query.toString()}`
}

/**
 * The signed-url check (API contract §3.C), run by the media dispatcher
 * before any handler: the raw key must match the key pattern (400
 * INVALID_MEDIA_KEY); the query must be exactly one `e` and one `s`; `e` must
 * be in the future and at most 2 hours ahead; `s` must verify, in constant
 * time (crypto.subtle.verify), under the current or the previous signing key
 * (403 SIGNATURE_INVALID otherwise). No usable signing key → 503.
 */
export async function verifySignedMediaRequest(
  env: Env,
  url: URL,
  rawKey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SignedMediaResult> {
  if (!MEDIA_KEY_PATTERN.test(rawKey)) {
    return { ok: false, response: invalidMediaKeyResponse() }
  }

  const signingKeys = mediaSigningKeys(env)

  if (signingKeys.length === 0) {
    return { ok: false, response: featureUnavailableResponse() }
  }

  const parameterNames = Array.from(url.searchParams.keys())
  const expiry = url.searchParams.get('e')
  const signature = url.searchParams.get('s')

  if (
    parameterNames.length !== mediaQueryParameters.size ||
    parameterNames.some((name) => !mediaQueryParameters.has(name)) ||
    expiry === null ||
    signature === null ||
    !MEDIA_EXPIRY_PATTERN.test(expiry) ||
    !MEDIA_SIGNATURE_PATTERN.test(signature)
  ) {
    return { ok: false, response: signatureInvalidResponse() }
  }

  const expiresAt = Number(expiry)

  if (
    expiresAt <= nowSeconds ||
    expiresAt > nowSeconds + MAXIMUM_MEDIA_LINK_LIFETIME_SECONDS
  ) {
    return { ok: false, response: signatureInvalidResponse() }
  }

  const signatureBytes = decodeBase64Url(signature)
  const payload = mediaSignaturePayload(rawKey, expiresAt)

  for (const secret of signingKeys) {
    const cryptoKey = await importMediaSigningKey(secret)

    if (await crypto.subtle.verify('HMAC', cryptoKey, signatureBytes, payload)) {
      return {
        ok: true,
        media: {
          key: rawKey,
          expiresAt,
        },
      }
    }
  }

  return { ok: false, response: signatureInvalidResponse() }
}

/**
 * Reads a bounded JSON object with an exact key set. Order of checks:
 * Content-Type (415) → declared Content-Length, when present (malformed →
 * 400, over the cap → 'too-large') → bytes read under the cap → strict UTF-8
 * → JSON → plain object → exact keys (400).
 *
 * 'too-large' answers 400 INVALID_REQUEST_BODY (the API contract keeps 413
 * for binary uploads); a handler whose cap can only be exceeded by an
 * over-long field may answer its own FIELD_TOO_LONG instead.
 */
export async function readJsonBody(
  request: Request,
  spec: JsonBodySpec,
): Promise<JsonBodyResult> {
  const read = await readBoundedJsonBody(request, spec.maxBytes)

  if (read.kind === 'unsupported-media-type') {
    return bodyFailure('unsupported-media-type', jsonMediaTypeResponse())
  }

  if (read.kind === 'too-large') {
    return bodyFailure('too-large', invalidRequestBodyResponse())
  }

  if (
    read.kind !== 'parsed' ||
    !isPlainRecord(read.value) ||
    !hasExactKeys(read.value, spec)
  ) {
    return invalidBody()
  }

  return {
    ok: true,
    body: read.value,
  }
}

function requiredEntry<Name extends string, Value>(
  entries: ReadonlyMap<string, Value>,
  name: Name,
): Value {
  const value = entries.get(name)

  if (value === undefined) {
    // Unreachable: readMultipartBody only succeeds when every declared part
    // is present, and the accessor's type admits declared names only.
    throw new Error('MULTIPART_PART_NOT_DECLARED')
  }

  return value
}

/**
 * Reads a bounded multipart/form-data body with an exact part list. Order of
 * checks (API contract §3.B.2 steps 2–4): Content-Length present (411), well
 * formed (400) and within `spec.maxBytes` (413), all before any byte is read
 * → Content-Type multipart with a boundary (415) → bytes read under the
 * declared length → parts: only declared names, each once, file parts as
 * non-empty files within their own cap (413), text parts as text within
 * their code-point cap and free of control characters (400) → every
 * declared part present (400).
 */
export async function readMultipartBody<
  FileName extends string,
  TextName extends string,
>(
  request: Request,
  spec: MultipartSpec<FileName, TextName>,
): Promise<MultipartBodyResult<FileName, TextName>> {
  const declaredLength = readDeclaredLength(request)

  if (declaredLength.kind === 'absent') {
    return bodyFailure('length-required', lengthRequiredResponse())
  }

  if (declaredLength.kind === 'invalid' || declaredLength.bytes === 0) {
    return invalidBody()
  }

  if (declaredLength.bytes > spec.maxBytes) {
    return bodyFailure('too-large', fileTooLargeResponse())
  }

  const contentType = request.headers.get('Content-Type')

  if (
    contentType === null ||
    readMediaType(request) !== MULTIPART_MEDIA_TYPE ||
    !hasMultipartBoundary(contentType)
  ) {
    return bodyFailure('unsupported-media-type', multipartMediaTypeResponse())
  }

  // Never accept more bytes than the request declared.
  const read = await readBoundedBytes(request, declaredLength.bytes)

  if (!read.ok || read.bytes.byteLength !== declaredLength.bytes) {
    return invalidBody()
  }

  let formData: FormData

  try {
    formData = await new Response(read.bytes, {
      headers: {
        'Content-Type': contentType,
      },
    }).formData()
  } catch (error) {
    if (error instanceof TypeError) {
      return invalidBody()
    }

    throw error
  }

  const fileCaps = new Map<string, number>(
    spec.files.map((field) => [field.name, field.maxBytes]),
  )
  const textCaps = new Map<string, number>(
    spec.texts.map((field) => [field.name, field.maxLength]),
  )
  const filesByName = new Map<string, File>()
  const textsByName = new Map<string, string>()

  for (const [name, value] of formData.entries()) {
    const fileCap = fileCaps.get(name)
    const textCap = textCaps.get(name)

    if (filesByName.has(name) || textsByName.has(name)) {
      return invalidBody()
    }

    if (fileCap !== undefined) {
      if (typeof value === 'string' || value.size === 0) {
        return invalidBody()
      }

      if (value.size > fileCap) {
        return bodyFailure('too-large', fileTooLargeResponse())
      }

      filesByName.set(name, value)
      continue
    }

    if (textCap !== undefined) {
      if (
        typeof value !== 'string' ||
        countCodePoints(value) > textCap ||
        containsControlCharacter(value)
      ) {
        return invalidBody()
      }

      textsByName.set(name, value)
      continue
    }

    return invalidBody()
  }

  if (
    spec.files.some((field) => !filesByName.has(field.name)) ||
    spec.texts.some((field) => !textsByName.has(field.name))
  ) {
    return invalidBody()
  }

  const fileBytes = new Map<string, MultipartFile>()

  for (const [name, file] of filesByName) {
    const bytes = new Uint8Array(await file.arrayBuffer())

    fileBytes.set(name, {
      bytes,
      size: bytes.byteLength,
    })
  }

  return {
    ok: true,
    body: {
      file: (name) => requiredEntry(fileBytes, name),
      text: (name) => requiredEntry(textsByName, name),
    },
  }
}
