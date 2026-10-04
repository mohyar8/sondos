import {
  authorizeAdminRequest,
  type AdminAuthorizationFailure,
  type AuthenticatedAdmin,
} from '../admin-auth.js'
import {
  errorResponse,
  methodNotAllowedResponse,
} from '../http.js'
import { requireSecondFactor } from '../recent-auth.js'
import {
  assertPrivateMediaRoutesGated,
  effectiveRouteGate,
  featureUnavailableResponse,
  isRouteGateOpen,
} from './gates.js'
import {
  allowedPortalMethods,
  assembleRouteRegistry,
  decodePathParameters,
  findPortalRoute,
  isPortalMethod,
  type PathParams,
  type PortalRoute,
} from './portal-routes.js'
import { adminAuditRoutes } from './slots/admin-audit.js'
import { adminBookingLogRoutes } from './slots/admin-booking-log.js'
import { adminDirectoryRoutes } from './slots/admin-directory.js'
import { adminEventProfileRoutes } from './slots/admin-event-profile.js'
import { adminExportRoutes } from './slots/admin-export.js'
import { adminFeedbackRoutes } from './slots/admin-feedback.js'
import { adminGalleryRoutes } from './slots/admin-gallery.js'
import { adminHandoverRoutes } from './slots/admin-handover.js'
import { adminProductionRoutes } from './slots/admin-production.js'
import { adminQueueRoutes } from './slots/admin-queue.js'
import { adminReceiptRoutes } from './slots/admin-receipts.js'
import { adminSearchRoutes } from './slots/admin-search.js'
import { adminSettingsRoutes } from './slots/admin-settings.js'

/**
 * Route registry for the admin side of the client portal (ADR-001 §2.6;
 * 11 §3.2, §4.3 E0–E2; decision D10).
 *
 * worker/index.ts checks isAdminPortalPath() BEFORE the generic /api/admin
 * branch. The legacy admin endpoints in worker/admin.ts are never matched here:
 * `/api/admin/bookings`, `/api/admin/bookings/{id}`,
 * `/api/admin/bookings/{id}/actions`, `/api/admin/bookings/{id}/notes` and
 * `/api/admin/blocked-dates[/{date}]`.
 *
 * The portal namespaces (11 §3.2) are, below `/api/admin/`:
 * - `bookings/{bookingId}/<sub-resource other than actions|notes>`
 *   (timeline, contact-log, event-profile, production, handover, feedback,
 *   receipts, gallery),
 * - `handover-slots`, `queue`, `settings`, `calendar`, `customers`,
 *   `exports`, `audit-log`, `session` and `search`, each with everything
 *   below it.
 * The list is complete for the plan: registries are never edited after
 * wave 1, so a slot route outside it would be unreachable, and this module
 * refuses to load with one (PORTAL_ROUTE_OUTSIDE_NAMESPACE).
 *
 * Every route lives in a per-feature slot file under worker/portal/slots/
 * (admin-*.ts). A feature fills ONLY its own slot file and never edits this
 * module; slot files import nothing but types from here. The registry is
 * assembled once by portal-routes.ts assembleRouteRegistry (valid
 * templates, no overlap between slots, nothing shadowed) and checked by
 * assertPrivateMediaRoutesGated (E1). Templates are relative to
 * `/api/admin/`, e.g. `['bookings', ':bookingId', 'receipts']`.
 *
 * Order of checks: admin guard (authorizeAdminRequest, with exactly the
 * refusals of worker/admin.ts: 401 UNAUTHENTICATED without a valid token)
 * → no route → 404 NOT_FOUND → gate closed → 503 → a private-media route
 * without a TOTP sign-in → 403 SECOND_FACTOR_REQUIRED → method → 405 with
 * Allow → malformed parameter → 404. With no route registered, every
 * namespace path therefore answers exactly what worker/admin.ts answers
 * for an unknown admin path.
 *
 * The gate is the route's own, or 'private-media' whenever its template or
 * the request path names a receipt, gallery, album, photo, media, upload,
 * file, ... resource (gates.ts effectiveRouteGate). A route here whose
 * template names one but declares `gate: 'open'` stops this module from
 * loading (red-team R2). The second factor on those routes (AD+2F, TM-21)
 * is enforced here, once, through recent-auth.ts requireSecondFactor, so a
 * receipt or gallery handler never runs for a password-only admin session
 * even if it forgets its own check. Routes that need a fresher sign-in
 * (AD+R) or the settings factor (AD+S) still call those guards themselves.
 */

export interface AdminPortalContext {
  readonly request: Request
  readonly env: Env
  readonly ctx: ExecutionContext
  readonly url: URL
  /** The admin, already authorised by authorizeAdminRequest. */
  readonly admin: AuthenticatedAdmin
  /** Decoded captures from the route template. */
  readonly params: PathParams
}

/** A route under `/api/admin/`, as a slot file declares it. */
export type AdminPortalRoute = PortalRoute<AdminPortalContext>

const ADMIN_PREFIX = '/api/admin/'

const adminPortalNamespaces: readonly RegExp[] = [
  /^\/api\/admin\/bookings\/[^/]+\/(?!(?:actions|notes)$).+$/,
  /^\/api\/admin\/handover-slots(?:\/.*)?$/,
  /^\/api\/admin\/queue(?:\/.*)?$/,
  /^\/api\/admin\/(?:settings|calendar|customers|exports|audit-log|session|search)(?:\/.*)?$/,
]

/** True for the admin paths worker/index.ts must hand to handleAdminPortalRequest. */
export function isAdminPortalPath(pathname: string): boolean {
  return adminPortalNamespaces.some((pattern) => pattern.test(pathname))
}

/**
 * Refuses a route that isAdminPortalPath would never send here: its
 * template, with every capture filled in, must lie inside a namespace.
 */
function assertAdminRoutesInNamespaces(
  routes: readonly AdminPortalRoute[],
): void {
  for (const route of routes) {
    const samplePath = route.path
      .map((part) => (part.startsWith(':') || part.startsWith('*') ? 'x' : part))
      .join('/')

    if (!isAdminPortalPath(`${ADMIN_PREFIX}${samplePath}`)) {
      throw new Error(
        `PORTAL_ROUTE_OUTSIDE_NAMESPACE /api/admin/${route.path.join('/')}`,
      )
    }
  }
}

/** Admin portal routes, one slot per feature, in the 11 §3.2 order. */
export const adminPortalRoutes: readonly AdminPortalRoute[] =
  assembleRouteRegistry('/api/admin', {
    'admin-booking-log': adminBookingLogRoutes,
    'admin-event-profile': adminEventProfileRoutes,
    'admin-production': adminProductionRoutes,
    'admin-handover': adminHandoverRoutes,
    'admin-feedback': adminFeedbackRoutes,
    'admin-receipts': adminReceiptRoutes,
    'admin-gallery': adminGalleryRoutes,
    'admin-settings': adminSettingsRoutes,
    'admin-queue': adminQueueRoutes,
    'admin-directory': adminDirectoryRoutes,
    'admin-export': adminExportRoutes,
    'admin-audit': adminAuditRoutes,
    'admin-search': adminSearchRoutes,
  })

// E1 (red-team R2, TM-10): a receipt, gallery, album, photo, media, upload,
// file, ... route registered without the private-media gate stops the
// Worker from starting. Run over the assembled registry, never per slot.
assertPrivateMediaRoutesGated('/api/admin', adminPortalRoutes)
assertAdminRoutesInNamespaces(adminPortalRoutes)

function adminNotFoundResponse(): Response {
  return errorResponse(
    404,
    'NOT_FOUND',
    'مسار API الإداري غير موجود.',
  )
}

/**
 * The same normalisation worker/admin.ts applies to authorizeAdminRequest
 * failures, so both admin surfaces answer identically: an unauthenticated
 * caller gets 401 UNAUTHENTICATED; every other refusal (FORBIDDEN,
 * EMAIL_NOT_VERIFIED, REAUTH_REQUIRED, ...) passes through unchanged.
 */
function normalizeAdminAuthorizationFailure(
  failure: AdminAuthorizationFailure,
  response: Response,
): Response {
  if (failure === 'unauthenticated') {
    return errorResponse(
      401,
      'UNAUTHENTICATED',
      'يجب تسجيل الدخول للوصول إلى لوحة الإدارة.',
      {
        'WWW-Authenticate': 'Bearer',
      },
    )
  }

  return response
}

export async function dispatchAdminPortalRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
  routes: readonly AdminPortalRoute[],
): Promise<Response> {
  const authorization = await authorizeAdminRequest(request, env)

  if (!authorization.ok) {
    return normalizeAdminAuthorizationFailure(
      authorization.failure,
      authorization.response,
    )
  }

  if (!url.pathname.startsWith(ADMIN_PREFIX)) {
    return adminNotFoundResponse()
  }

  const segments = url.pathname.slice(ADMIN_PREFIX.length).split('/')
  const match = findPortalRoute(routes, segments)

  if (!match) {
    return adminNotFoundResponse()
  }

  const gate = effectiveRouteGate(match.route, segments)

  if (!isRouteGateOpen(env, gate)) {
    return featureUnavailableResponse()
  }

  // AD+2F (TM-21): enforced in code for every private-media route, never
  // left to the handler.
  if (gate === 'private-media') {
    const secondFactorRefusal = requireSecondFactor(env, authorization.admin)

    if (secondFactorRefusal) {
      return secondFactorRefusal
    }
  }

  const handler = isPortalMethod(request.method)
    ? match.route.handlers[request.method]
    : undefined

  if (!handler) {
    return methodNotAllowedResponse(allowedPortalMethods(match.route))
  }

  const params = decodePathParameters(match.rawParams)

  if (!params) {
    return adminNotFoundResponse()
  }

  return handler({
    request,
    env,
    ctx,
    url,
    admin: authorization.admin,
    params,
  })
}

/** Entry point from worker/index.ts for every path where isAdminPortalPath() is true. */
export async function handleAdminPortalRequest(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  return dispatchAdminPortalRequest(request, env, url, ctx, adminPortalRoutes)
}
