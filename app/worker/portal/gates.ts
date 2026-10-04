import { errorResponse } from '../http.js'

/**
 * Feature gates for the client portal (ADR-001 §4.5, decisions D2, D10 and
 * D17, red-team amendment R2, plan 11 §4 and threat model TM-10).
 *
 * Receipts, galleries and every /api/media/* file are private personal data.
 * They stay unreachable in code, not by convention, until ALL of these hold
 * (getPrivateMediaBlockers names each one that does not):
 * - ONLINE_CONFIRMATION is exactly "on";
 * - PDPL_SIGNOFF_REF names the dated PDPL sign-off record (non-blank);
 * - the R2 binding MEDIA exists and passes a runtime shape check (production
 *   declares none; only the local env.mediatest does);
 * - MEDIA_SIGNING_KEY is at least 32 characters (so at least 32 bytes) long;
 * - ADMIN_MEDIA_MFA is not exactly "off" (audit SEC-02, red-team R1, TM-21):
 *   the admin portal reads every customer's receipts and galleries, so it
 *   must not open to a password-only admin sign-in. This holds in every
 *   environment, env.mediatest included: "off" is no way to test admin
 *   media flows without TOTP. Tests mint tokens with and without the second
 *   factor; a browser walk needs a tester admin with TOTP enrolled.
 * Every missing or malformed value closes the gate.
 *
 * Three layers enforce it:
 * - E1: the registries in portal-routes.ts and admin-portal-routes.ts call
 *   assertPrivateMediaRoutesGated() when the module loads, so a route whose
 *   template names private media (PRIVATE_MEDIA_SEGMENTS) but declares
 *   `gate: 'open'` stops the Worker from starting;
 * - E2: the dispatchers run every request under effectiveRouteGate(), which
 *   is 'private-media' when the route declares it OR its template OR the
 *   request path names private media (a ':name' capture is read as a whole
 *   token, so an id never reads as a word), and answer 503 while the gate
 *   is closed, before any handler code runs;
 * - E3: getMediaBucket() is the only door to the R2 bucket, and it returns
 *   null unless the whole gate holds. No other module reads the MEDIA
 *   binding (a verify grep gate), so a route on a path the word list does
 *   not know still cannot reach a single object.
 */

const ENABLED_VALUE = 'on'
/** The only value of ADMIN_MEDIA_MFA that switches the second factor off. */
const ADMIN_MEDIA_MFA_OFF_VALUE = 'off'
const MEDIA_BINDING_NAME = 'MEDIA'
/**
 * In UTF-16 code units, as request.ts counts the key before signing with
 * it: 32 of them are at least 32 bytes of HMAC-SHA256 key material.
 */
const MINIMUM_MEDIA_SIGNING_KEY_LENGTH = 32
/** The methods of the Workers R2Bucket binding that media code relies on. */
const R2_BUCKET_METHODS = [
  'head',
  'get',
  'put',
  'delete',
  'list',
  'createMultipartUpload',
  'resumeMultipartUpload',
] as const
/**
 * Never on an R2Bucket, always on a service binding (Fetcher), a Durable
 * Object stub or an RPC stub: those answer every property name with a
 * callable, so they would pass the method check alone.
 */
const NON_R2_BUCKET_METHOD = 'fetch'

/** Route gates. Every registered portal route must name one. */
export type RouteGate = 'open' | 'private-media'

/** The part of a portal route the gate checks read. */
export interface GatedRoute {
  /** Path template, one entry per segment (see portal-routes.ts PortalRoute). */
  readonly path: readonly string[]
  readonly gate: RouteGate
}

/**
 * Why private media is closed, one code per unmet condition, in this order
 * (plan 11 §3.3 #29 `features.privateMedia.blockers`). Codes only: never the
 * values behind them.
 */
export const PRIVATE_MEDIA_BLOCKERS = [
  'ONLINE_CONFIRMATION',
  'PDPL_SIGNOFF_REF',
  'MEDIA_BINDING',
  'MEDIA_SIGNING_KEY',
  'ADMIN_MFA_DISABLED',
] as const

export type PrivateMediaBlocker = (typeof PRIVATE_MEDIA_BLOCKERS)[number]

/**
 * Path words that name a receipt, gallery, album, photo, media or other file
 * resource, including the synonyms of TM-10 (upload, file, image, proof,
 * slip, pdf, ...). A portal route template or request path containing one of
 * them (in any case, percent-encoded or not, as a whole segment or as one
 * word of it, e.g. `receipt-upload` or `:receiptId`) is private media,
 * whatever gate its route declares (red-team R2); the value of a ':name'
 * capture counts only as a whole token (captureValueTokens). No open path of
 * plan 11 §3.2 contains one; album status therefore lives at `/production`.
 */
export const PRIVATE_MEDIA_SEGMENTS: ReadonlySet<string> = new Set([
  'receipt',
  'receipts',
  'gallery',
  'galleries',
  'album',
  'albums',
  'photo',
  'photos',
  'photograph',
  'photographs',
  'media',
  'upload',
  'uploads',
  'file',
  'files',
  'image',
  'images',
  'picture',
  'pictures',
  'attachment',
  'attachments',
  'proof',
  'proofs',
  'slip',
  'slips',
  'document',
  'documents',
  'download',
  'downloads',
  'pdf',
  'pdfs',
  'thumb',
  'thumbs',
  'thumbnail',
  'thumbnails',
  'preview',
  'previews',
])

/** True only when the ONLINE_CONFIRMATION var is exactly "on". */
export function isOnlineConfirmationOn(env: Env): boolean {
  const value: unknown = env.ONLINE_CONFIRMATION

  return value === ENABLED_VALUE
}

/** True when PDPL_SIGNOFF_REF is a string with at least one non-space character. */
export function hasPdplSignoffRecord(env: Env): boolean {
  const reference: unknown = env.PDPL_SIGNOFF_REF

  return typeof reference === 'string' && reference.trim().length > 0
}

/**
 * True when MEDIA_SIGNING_KEY is at least 32 characters long, leading and
 * trailing whitespace not counted, so the signer in request.ts accepts it
 * too. Only the length is read; the key never leaves this function.
 */
function hasMediaSigningKey(env: Env): boolean {
  const key: unknown = env.MEDIA_SIGNING_KEY

  return (
    typeof key === 'string' &&
    key.trim().length >= MINIMUM_MEDIA_SIGNING_KEY_LENGTH
  )
}

/**
 * True only for the exact value "off". A missing, misspelt or differently
 * cased value keeps the second factor required (TM-21).
 */
function isAdminMediaMfaDisabled(env: Env): boolean {
  const value: unknown = env.ADMIN_MEDIA_MFA

  return value === ADMIN_MEDIA_MFA_OFF_VALUE
}

/**
 * Structural guard for the Workers R2 binding: an object carrying every
 * R2Bucket method and no `fetch`. A var, a KV namespace, a service binding,
 * a Durable Object stub or any other binding named MEDIA fails it.
 */
function isR2BucketShape(value: unknown): value is R2Bucket {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  return (
    R2_BUCKET_METHODS.every(
      (method) => typeof Reflect.get(value, method) === 'function',
    ) && Reflect.get(value, NON_R2_BUCKET_METHOD) === undefined
  )
}

/**
 * The MEDIA binding when it passes the shape check. Read at runtime, never
 * through the generated Env type, which merges env.mediatest's binding into
 * every environment (plan 11 §1.3 D13).
 */
function readMediaBinding(env: Env): R2Bucket | null {
  const binding: unknown = Reflect.get(env, MEDIA_BINDING_NAME)

  return isR2BucketShape(binding) ? binding : null
}

/**
 * Every unmet condition of the private-media gate, in PRIVATE_MEDIA_BLOCKERS
 * order; empty exactly when the gate is open. For the admin settings view
 * (`features.privateMedia.blockers`) and for tests.
 */
export function getPrivateMediaBlockers(
  env: Env,
): readonly PrivateMediaBlocker[] {
  const blockers: PrivateMediaBlocker[] = []

  if (!isOnlineConfirmationOn(env)) {
    blockers.push('ONLINE_CONFIRMATION')
  }

  if (!hasPdplSignoffRecord(env)) {
    blockers.push('PDPL_SIGNOFF_REF')
  }

  if (readMediaBinding(env) === null) {
    blockers.push('MEDIA_BINDING')
  }

  if (!hasMediaSigningKey(env)) {
    blockers.push('MEDIA_SIGNING_KEY')
  }

  if (isAdminMediaMfaDisabled(env)) {
    blockers.push('ADMIN_MFA_DISABLED')
  }

  return blockers
}

/**
 * True only when every private-media condition holds (red-team R2, TM-10):
 * receipt, gallery and media routes depend on this.
 */
export function isPrivateMediaAllowed(env: Env): boolean {
  return getPrivateMediaBlockers(env).length === 0
}

/**
 * The single door to the private-media R2 bucket (E3, TM-10): null unless
 * isPrivateMediaAllowed(env), so even a route on a path the word list does
 * not know reads nothing while the gate is closed. Callers answer
 * featureUnavailableResponse() on null.
 */
export function getMediaBucket(env: Env): R2Bucket | null {
  if (!isPrivateMediaAllowed(env)) {
    return null
  }

  return readMediaBinding(env)
}

/** True when a route with this gate may run in the current environment. */
export function isRouteGateOpen(env: Env, gate: RouteGate): boolean {
  switch (gate) {
    case 'open':
      return true
    case 'private-media':
      return isPrivateMediaAllowed(env)
  }
}

/** Percent-decodes a segment; a malformed encoding is read as it is. */
function decodeSegmentLeniently(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch (error) {
    if (error instanceof URIError) {
      return segment
    }

    throw error
  }
}

/** Lowercases and splits at every character that is not an ASCII letter. */
function letterRuns(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/)
}

/**
 * The lowercase words of one path segment or template part, so ':name' and
 * '*name' captures are read by their names. Three readings are joined, since
 * each one alone misses a spelling the others catch:
 * - whole letter runs, whatever their case ('RECEIPTs', 'rEceipts');
 * - split at camelCase humps ('receiptUpload', ':PDFsId' reads pdfs, id);
 * - split at humps and after an acronym ('PDFFile' reads pdf, file).
 */
function segmentWords(segment: string): string[] {
  const text = decodeSegmentLeniently(segment).normalize('NFKC')
  const humps = text.replace(/([a-z])([A-Z])/g, '$1 $2')
  const acronyms = humps.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')

  return [...letterRuns(text), ...letterRuns(humps), ...letterRuns(acronyms)]
}

/**
 * The lowercase tokens of a request segment taken by a ':name' capture:
 * split only at characters that are neither ASCII letters nor digits. A
 * UUID or a Firebase uid is one run of letters and digits per token and
 * never equals a word of the list (read word by word, the humps and digits
 * inside about one uid in 10,000 spell 'pdf' or 'slip', and that customer's
 * admin page would answer 503), while a word-like value such as 'receipts',
 * 'Receipt-Files' or '%70roof' still matches.
 */
function captureValueTokens(segment: string): string[] {
  return decodeSegmentLeniently(segment)
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
}

function namesPrivateMedia(words: readonly string[]): boolean {
  return words.some((word) => PRIVATE_MEDIA_SEGMENTS.has(word))
}

/** True when any segment names a private-media resource (PRIVATE_MEDIA_SEGMENTS). */
export function pathTouchesPrivateMedia(segments: readonly string[]): boolean {
  return segments.some((segment) => namesPrivateMedia(segmentWords(segment)))
}

/**
 * True when the request path a template matched names private media. A
 * segment taken by a ':name' capture is read as whole tokens (an id cannot
 * choose the handler); every other one, including each segment of a
 * '*name' rest capture, word by word.
 */
function requestTouchesPrivateMedia(
  template: readonly string[],
  requestSegments: readonly string[],
): boolean {
  return requestSegments.some((segment, index) =>
    template.at(index)?.startsWith(':') === true
      ? namesPrivateMedia(captureValueTokens(segment))
      : namesPrivateMedia(segmentWords(segment)),
  )
}

/**
 * The gate a matched route runs under: 'private-media' when the route
 * declares it, when its template names private media, or when the request's
 * own path segments do (a rest capture, for example). Otherwise 'open'.
 */
export function effectiveRouteGate(
  route: GatedRoute,
  requestSegments: readonly string[],
): RouteGate {
  if (
    route.gate === 'private-media' ||
    pathTouchesPrivateMedia(route.path) ||
    requestTouchesPrivateMedia(route.path, requestSegments)
  ) {
    return 'private-media'
  }

  return 'open'
}

/**
 * Refuses a registry in which a route template names private media but the
 * route declares any gate other than 'private-media' (red-team R2: such a
 * route must not register). Called when each registry module loads, so the
 * Worker fails to start instead of serving the route.
 */
export function assertPrivateMediaRoutesGated(
  namespace: string,
  routes: readonly GatedRoute[],
): void {
  for (const route of routes) {
    if (
      route.gate !== 'private-media' &&
      pathTouchesPrivateMedia(route.path)
    ) {
      throw new Error(
        `PORTAL_ROUTE_GATE_MISMATCH ${namespace}/${route.path.join('/')} must declare gate 'private-media'`,
      )
    }
  }
}

/** The 503 answer for a gated feature (same JSON envelope as every error). */
export function featureUnavailableResponse(): Response {
  return errorResponse(
    503,
    'SERVICE_UNAVAILABLE',
    'هذه الخدمة غير متاحة حاليًا.',
  )
}
