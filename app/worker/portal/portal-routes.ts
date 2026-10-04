import {
  errorResponse,
  methodNotAllowedResponse,
} from '../http.js'
import { requireMediaFreshSignIn } from '../recent-auth.js'
import {
  assertPrivateMediaRoutesGated,
  effectiveRouteGate,
  featureUnavailableResponse,
  isPrivateMediaAllowed,
  isRouteGateOpen,
  type GatedRoute,
  type RouteGate,
} from './gates.js'
import {
  bookingNotFoundResponse,
  resolveOwnedBooking,
  type OwnedBooking,
} from './owned-booking.js'
import {
  requireVerifiedCustomer,
  verifySignedMediaRequest,
  type VerifiedCustomer,
  type VerifiedMediaRequest,
} from './request.js'
import { confirmationRoutes } from './slots/confirmation.js'
import { eventProfileRoutes } from './slots/event-profile.js'
import { feedbackRoutes } from './slots/feedback.js'
import { galleryRoutes } from './slots/gallery.js'
import { handoverRoutes } from './slots/handover.js'
import { signedMediaRoutes } from './slots/media.js'
import { receiptRoutes } from './slots/receipts.js'

/**
 * Route registries and dispatchers for the customer portal (ADR-001 §2.6;
 * 11 §3.1, §4.3 E0–E2; decision D10).
 *
 * worker/index.ts sends two namespaces here:
 * - `/api/bookings/{bookingId}/...` (customer-owner endpoints), and
 * - `/api/media` and `/api/media/...` (signed-url files, gated as private media).
 *
 * Every route lives in a per-feature slot file under worker/portal/slots/.
 * A feature fills ONLY its own slot file and never edits this module or the
 * registries below. Slot files import nothing but types from here
 * (`import type`), so there is no runtime import cycle, and no route is
 * ever loaded through a dynamic import. When this module loads:
 * - assembleRouteRegistry concatenates the slots and refuses an invalid
 *   template, a request path that routes of two different slots would both
 *   match (so the slot order never decides which handler runs), and a
 *   route shadowed by an earlier route of its own slot;
 * - assertPrivateMediaRoutesGated (E1) refuses a route whose template names
 *   a receipt, gallery, album, photo, media, upload, file, ... resource
 *   (gates.ts PRIVATE_MEDIA_SEGMENTS) without `gate: 'private-media'`.
 * Either one stops the Worker from starting instead of serving the route.
 *
 * What the customer dispatcher guarantees for every route, in this order:
 * 1. no registered route → 404 NOT_FOUND (the same envelope as today);
 * 2. gate closed → 503 SERVICE_UNAVAILABLE, before any authentication. The
 *    gate is the route's own, or 'private-media' whenever its template or
 *    the request path names private media (gates.ts effectiveRouteGate);
 * 3. method not registered → 405 with an Allow header;
 * 4. no valid Firebase token → 401 UNAUTHORIZED;
 * 5. email not verified → 403 EMAIL_NOT_VERIFIED; a revoked token → 401;
 *    an erased account → 410 ACCOUNT_ERASED (4 and 5 are request.ts
 *    requireVerifiedCustomer, over worker/auth.ts and worker/users.ts);
 * 6. a private-media route with a sign-in more than 12 hours old → 403
 *    REAUTH_REQUIRED (CO+M: recent-auth.ts requireMediaFreshSignIn; audit
 *    SEC-20). This is the read window only: a route the plan marks CO+R
 *    (gallery submit-and-lock, consent, delivery booking) MUST also call
 *    recent-auth.ts requireRecentCustomerSignIn (10 minutes, TM-08) in its
 *    own handler; the dispatcher never applies it;
 * 7. malformed path capture → 404 NOT_FOUND;
 * 8. malformed booking id, or a booking that does not exist or is not this
 *    customer's → the same 404 BOOKING_NOT_FOUND, byte for byte
 *    (owned-booking.ts resolveOwnedBooking, one query; C-16, TM-06).
 * The handler then receives the verified customer and the OwnedBooking.
 * It MUST still bind `booking_requests.user_id = ?` to `customer.uid` in
 * its own statements and re-check status, flow and deadline inside every
 * write (SB-5, SB-20); nested ids (gallery, photo, slot, delivery area)
 * are validated through the owned booking, never taken on their own.
 * request.ts still exports Wave 0's requireRecentAuthentication (its docs
 * say 10 minutes and 401; it applies RECENT_SIGN_IN_GUARD_SECONDS and
 * answers 403) and loadOwnedBooking (with its own, narrower OwnedBooking,
 * OwnedBookingResult and 404 helper). Both are superseded, their docs are
 * wrong, and no Worker module may use them: freshness comes only from
 * recent-auth.ts and ownership only from owned-booking.ts
 * (tests/portal-routes.test.mjs fails any Worker module that reaches them).
 *
 * Media routes: the whole namespace is 503 until isPrivateMediaAllowed(env);
 * then no route → 404, method → 405, and the signed-url check (request.ts
 * verifySignedMediaRequest: 400 INVALID_MEDIA_KEY, 403 SIGNATURE_INVALID)
 * runs before any media handler, which receives the verified key.
 */

export const portalMethods = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const

export type PortalMethod = (typeof portalMethods)[number]

/** Decoded path parameters, keyed by the template names without ':'. */
export type PathParams = Readonly<Record<string, string>>

export type PortalHandler<Context> = (context: Context) => Promise<Response>

export interface PortalRoute<Context> {
  /**
   * Path template, one entry per segment, relative to the namespace:
   * a literal segment (RFC 3986 unreserved characters only), ':name' to
   * capture one segment, or a final '*name' to capture the non-empty rest
   * of the path (slashes included). Names are ASCII letters and digits,
   * starting with a letter, and unique within the template.
   */
  readonly path: readonly string[]
  /**
   * Every route names its gate; receipts, galleries and media use
   * 'private-media'. A template that names private media (gates.ts
   * PRIVATE_MEDIA_SEGMENTS) with any other gate is refused when the registry
   * loads.
   */
  readonly gate: RouteGate
  /** At least one method; an unlisted method answers 405. */
  readonly handlers: Readonly<Partial<Record<PortalMethod, PortalHandler<Context>>>>
}

export interface PortalRouteMatch<Context> {
  readonly route: PortalRoute<Context>
  /** Raw (still percent-encoded) captures. */
  readonly rawParams: PathParams
}

export interface CustomerPortalContext {
  readonly request: Request
  readonly env: Env
  readonly ctx: ExecutionContext
  readonly url: URL
  /**
   * Verified identity (request.ts requireVerifiedCustomer): the token was
   * valid and the email is verified. Bind `customer.uid` as `user_id = ?`
   * in every statement of the handler.
   */
  readonly customer: VerifiedCustomer
  /** Decoded booking id from the path; the same value as `booking.id`. */
  readonly bookingId: string
  /**
   * The booking, already proven to exist and to belong to `customer`
   * (owned-booking.ts resolveOwnedBooking). A snapshot: writes re-check
   * ownership and state inside their own statements.
   */
  readonly booking: OwnedBooking
  /** Decoded captures from the route template. */
  readonly params: PathParams
}

export interface MediaContext {
  readonly request: Request
  readonly env: Env
  readonly ctx: ExecutionContext
  readonly url: URL
  /**
   * Raw captures. The media key is matched on the raw pathname, not decoded
   * (API contract §3.C).
   */
  readonly params: PathParams
  /**
   * The key and expiry of a link whose signature already verified
   * (request.ts verifySignedMediaRequest). Serve exactly `media.key`.
   */
  readonly media: VerifiedMediaRequest
}

/** A route under `/api/bookings/{bookingId}/`, as a slot file declares it. */
export type CustomerPortalRoute = PortalRoute<CustomerPortalContext>

export interface MediaRoute extends PortalRoute<MediaContext> {
  readonly gate: 'private-media'
}

/** The part of a route the registry checks read. */
export interface RegistrableRoute extends GatedRoute {
  readonly handlers: Readonly<Partial<Record<PortalMethod, unknown>>>
}

type TemplateSegment =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'capture' }

interface ParsedTemplate {
  /** Every part before a final '*name' rest capture. */
  readonly segments: readonly TemplateSegment[]
  /** True when the template ends with a '*name' rest capture. */
  readonly hasRest: boolean
}

interface RegisteredRoute<Route> {
  readonly slot: string
  readonly route: Route
  readonly template: ParsedTemplate
}

const TEMPLATE_CAPTURE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/
/** RFC 3986 unreserved characters: a literal must match the raw path as is. */
const TEMPLATE_LITERAL_PATTERN = /^[A-Za-z0-9._~-]+$/

/** Null for a template the dispatcher could never match as written. */
function parseRouteTemplate(template: readonly string[]): ParsedTemplate | null {
  if (template.length === 0) {
    return null
  }

  const captureNames = new Set<string>()
  const segments: TemplateSegment[] = []

  for (const [index, part] of template.entries()) {
    const marker = part.charAt(0)

    if (marker !== ':' && marker !== '*') {
      if (!TEMPLATE_LITERAL_PATTERN.test(part)) {
        return null
      }

      segments.push({ kind: 'literal', value: part })
      continue
    }

    const name = part.slice(1)

    if (!TEMPLATE_CAPTURE_NAME_PATTERN.test(name) || captureNames.has(name)) {
      return null
    }

    captureNames.add(name)

    if (marker === '*') {
      return index === template.length - 1
        ? { segments, hasRest: true }
        : null
    }

    segments.push({ kind: 'capture' })
  }

  return { segments, hasRest: false }
}

/** True when some request path is matched by both templates. */
function templatesOverlap(first: ParsedTemplate, second: ParsedTemplate): boolean {
  const literalsDiffer = first.segments.some((segment, index) => {
    const other = second.segments.at(index)

    return (
      segment.kind === 'literal' &&
      other?.kind === 'literal' &&
      other.value !== segment.value
    )
  })

  if (literalsDiffer) {
    return false
  }

  if (first.hasRest && second.hasRest) {
    return true
  }

  if (first.hasRest) {
    // The rest capture needs at least one more segment.
    return second.segments.length > first.segments.length
  }

  if (second.hasRest) {
    return first.segments.length > second.segments.length
  }

  return first.segments.length === second.segments.length
}

/** True when `earlier` matches every request path that `later` matches. */
function templateCovers(earlier: ParsedTemplate, later: ParsedTemplate): boolean {
  if (later.hasRest) {
    if (!earlier.hasRest || earlier.segments.length > later.segments.length) {
      return false
    }
  } else if (earlier.hasRest) {
    if (earlier.segments.length >= later.segments.length) {
      return false
    }
  } else if (earlier.segments.length !== later.segments.length) {
    return false
  }

  return earlier.segments.every((segment, index) => {
    const other = later.segments.at(index)

    return (
      segment.kind === 'capture' ||
      (other?.kind === 'literal' && other.value === segment.value)
    )
  })
}

function hasAnyHandler(route: RegistrableRoute): boolean {
  return portalMethods.some((method) => route.handlers[method] !== undefined)
}

/**
 * Builds one registry from its slot arrays, in the order given, and refuses
 * (throws while the module loads) a registry the dispatcher could not serve
 * as written:
 * - PORTAL_ROUTE_INVALID: a template parseRouteTemplate rejects, or a route
 *   without any method;
 * - PORTAL_ROUTE_OVERLAP: a request path that routes of two different slots
 *   would both match;
 * - PORTAL_ROUTE_SHADOWED: a route that an earlier route of the same slot
 *   matches for every path, so it could never run. Inside one slot a
 *   literal may come before a capture in the same position (e.g. 'generate'
 *   before ':slotId'); the first match wins.
 * The messages name templates and slots only.
 */
export function assembleRouteRegistry<Route extends RegistrableRoute>(
  namespace: string,
  slots: Readonly<Record<string, readonly Route[]>>,
): readonly Route[] {
  const registered: RegisteredRoute<Route>[] = []

  for (const [slot, routes] of Object.entries(slots)) {
    for (const route of routes) {
      const label = `${namespace}/${route.path.join('/')}`
      const template = parseRouteTemplate(route.path)

      if (!template || !hasAnyHandler(route)) {
        throw new Error(`PORTAL_ROUTE_INVALID ${label} (slot ${slot})`)
      }

      for (const earlier of registered) {
        const earlierLabel = `${namespace}/${earlier.route.path.join('/')}`

        if (
          earlier.slot !== slot &&
          templatesOverlap(earlier.template, template)
        ) {
          throw new Error(
            `PORTAL_ROUTE_OVERLAP ${label} (slot ${slot}) and ${earlierLabel} (slot ${earlier.slot})`,
          )
        }

        if (
          earlier.slot === slot &&
          templateCovers(earlier.template, template)
        ) {
          throw new Error(
            `PORTAL_ROUTE_SHADOWED ${label} is unreachable behind ${earlierLabel} (slot ${slot})`,
          )
        }
      }

      registered.push({ slot, route, template })
    }
  }

  return Object.freeze(registered.map((entry) => entry.route))
}

/**
 * Customer-owner routes under `/api/bookings/{bookingId}/`, one slot per
 * feature (11 §3.2). Templates are relative to that prefix, e.g.
 * `['gallery', 'selection']`.
 */
export const customerPortalRoutes: readonly CustomerPortalRoute[] =
  assembleRouteRegistry('/api/bookings/{bookingId}', {
    confirmation: confirmationRoutes,
    receipts: receiptRoutes,
    'event-profile': eventProfileRoutes,
    handover: handoverRoutes,
    feedback: feedbackRoutes,
    gallery: galleryRoutes,
  })

/**
 * Signed-url routes under `/api/media/`. The whole namespace answers 503 until
 * isPrivateMediaAllowed(env) is true (red-team R2).
 */
export const mediaRoutes: readonly MediaRoute[] = assembleRouteRegistry(
  '/api/media',
  {
    media: signedMediaRoutes,
  },
)

// E1 (red-team R2, TM-10): a receipt, gallery, album, photo, media, upload,
// file, ... route registered without the private-media gate stops the
// Worker from starting. Run over the assembled registries, never per slot.
assertPrivateMediaRoutesGated('/api/bookings/{bookingId}', customerPortalRoutes)
assertPrivateMediaRoutesGated('/api/media', mediaRoutes)

const CUSTOMER_PORTAL_PATH = /^\/api\/bookings\/([^/]+)\/(.+)$/
const MEDIA_NAMESPACE = '/api/media'
const MAXIMUM_PATH_PARAMETER_LENGTH = 128

export function isPortalMethod(value: string): value is PortalMethod {
  return portalMethods.some((method) => method === value)
}

/** The methods a route accepts, in a stable order, for the Allow header. */
export function allowedPortalMethods<Context>(
  route: PortalRoute<Context>,
): PortalMethod[] {
  return portalMethods.filter((method) => route.handlers[method] !== undefined)
}

function matchPathTemplate(
  template: readonly string[],
  segments: readonly string[],
): PathParams | null {
  const params: Record<string, string> = {}

  for (const [index, part] of template.entries()) {
    if (part.startsWith('*')) {
      if (index !== template.length - 1) {
        return null
      }

      const rest = segments.slice(index).join('/')

      if (rest.length === 0) {
        return null
      }

      params[part.slice(1)] = rest

      return params
    }

    const segment = segments.at(index)

    if (segment === undefined) {
      return null
    }

    if (part.startsWith(':')) {
      if (segment.length === 0) {
        return null
      }

      params[part.slice(1)] = segment
      continue
    }

    if (part !== segment) {
      return null
    }
  }

  return template.length === segments.length ? params : null
}

/** The first route whose template matches the path segments, or null. */
export function findPortalRoute<Context>(
  routes: readonly PortalRoute<Context>[],
  segments: readonly string[],
): PortalRouteMatch<Context> | null {
  for (const route of routes) {
    const rawParams = matchPathTemplate(route.path, segments)

    if (rawParams) {
      return {
        route,
        rawParams,
      }
    }
  }

  return null
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

/**
 * Percent-decodes one path parameter. Returns null when the encoding is
 * malformed, or the value is empty, longer than 128 characters or contains a
 * control character.
 */
export function decodePathParameter(raw: string): string | null {
  let decoded: string

  try {
    decoded = decodeURIComponent(raw)
  } catch (error) {
    if (error instanceof URIError) {
      return null
    }

    throw error
  }

  if (
    decoded.length === 0 ||
    decoded.length > MAXIMUM_PATH_PARAMETER_LENGTH ||
    containsControlCharacter(decoded)
  ) {
    return null
  }

  return decoded
}

/** Decodes every capture; null if any one of them is invalid. */
export function decodePathParameters(rawParams: PathParams): PathParams | null {
  const decoded: Record<string, string> = {}

  for (const [name, raw] of Object.entries(rawParams)) {
    const value = decodePathParameter(raw)

    if (value === null) {
      return null
    }

    decoded[name] = value
  }

  return decoded
}

function apiNotFoundResponse(): Response {
  return errorResponse(
    404,
    'NOT_FOUND',
    'مسار API غير موجود.',
  )
}

function isMediaPath(pathname: string): boolean {
  return (
    pathname === MEDIA_NAMESPACE ||
    pathname.startsWith(`${MEDIA_NAMESPACE}/`)
  )
}

/**
 * True for the paths worker/index.ts must hand to handlePortalRequest:
 * `/api/bookings/{bookingId}/<something>` and the `/api/media` namespace.
 * `/api/bookings` and `/api/bookings/me` are exact paths that index.ts routes
 * before this check.
 */
export function isPortalPath(pathname: string): boolean {
  return CUSTOMER_PORTAL_PATH.test(pathname) || isMediaPath(pathname)
}

export async function dispatchCustomerPortalRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
  routes: readonly CustomerPortalRoute[],
): Promise<Response> {
  const pathMatch = CUSTOMER_PORTAL_PATH.exec(url.pathname)
  const rawBookingId = pathMatch?.[1]
  const subPath = pathMatch?.[2]

  if (rawBookingId === undefined || subPath === undefined) {
    return apiNotFoundResponse()
  }

  const segments = subPath.split('/')
  const match = findPortalRoute(routes, segments)

  if (!match) {
    return apiNotFoundResponse()
  }

  const gate = effectiveRouteGate(match.route, segments)

  if (!isRouteGateOpen(env, gate)) {
    return featureUnavailableResponse()
  }

  const handler = isPortalMethod(request.method)
    ? match.route.handlers[request.method]
    : undefined

  if (!handler) {
    return methodNotAllowedResponse(allowedPortalMethods(match.route))
  }

  const verified = await requireVerifiedCustomer(request, env)

  if (!verified.ok) {
    return verified.response
  }

  if (gate === 'private-media') {
    const reauthentication = requireMediaFreshSignIn(verified.customer)

    if (reauthentication) {
      return reauthentication
    }
  }

  const params = decodePathParameters(match.rawParams)

  if (!params) {
    return apiNotFoundResponse()
  }

  const bookingId = decodePathParameter(rawBookingId)

  // TM-06: a malformed id answers exactly like an unknown or foreign one.
  if (bookingId === null) {
    return bookingNotFoundResponse()
  }

  const owned = await resolveOwnedBooking(env.DB, bookingId, verified.customer)

  if (!owned.ok) {
    return owned.response
  }

  return handler({
    request,
    env,
    ctx,
    url,
    customer: verified.customer,
    bookingId: owned.booking.id,
    booking: owned.booking,
    params,
  })
}

export async function dispatchMediaRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
  routes: readonly MediaRoute[],
): Promise<Response> {
  // Red-team R2: the whole namespace is closed until both gates are satisfied.
  if (!isPrivateMediaAllowed(env)) {
    return featureUnavailableResponse()
  }

  const rest = url.pathname.slice(MEDIA_NAMESPACE.length + 1)
  const match = findPortalRoute(routes, rest.length === 0 ? [] : rest.split('/'))

  if (!match) {
    return apiNotFoundResponse()
  }

  const handler = isPortalMethod(request.method)
    ? match.route.handlers[request.method]
    : undefined

  if (!handler) {
    return methodNotAllowedResponse(allowedPortalMethods(match.route))
  }

  // Audit SEC-16: no media handler runs without a verified signature.
  const signed = await verifySignedMediaRequest(env, url, rest)

  if (!signed.ok) {
    return signed.response
  }

  return handler({
    request,
    env,
    ctx,
    url,
    params: match.rawParams,
    media: signed.media,
  })
}

/** Entry point from worker/index.ts for every path where isPortalPath() is true. */
export async function handlePortalRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  if (isMediaPath(url.pathname)) {
    return dispatchMediaRequest(request, env, url, ctx, mediaRoutes)
  }

  return dispatchCustomerPortalRequest(
    request,
    env,
    url,
    ctx,
    customerPortalRoutes,
  )
}
