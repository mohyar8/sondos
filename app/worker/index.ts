import { handleAdminRequest } from './admin.js'
import {
  handleCreateBooking,
  handleMyBookings,
} from './bookings.js'
import {
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
} from './http.js'
import {
  handleAdminPortalRequest,
  isAdminPortalPath,
} from './portal/admin-portal-routes.js'
import {
  handlePortalRequest,
  isPortalPath,
} from './portal/portal-routes.js'
import { handleProfile } from './profile.js'
import { runScheduledTick } from './scheduled.js'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const MAXIMUM_RANGE_DAYS = 93
const ENABLED_VALUE = 'on'

/**
 * The only API reads a browse-only preview serves (audit SEC-08): both are
 * public and unauthenticated. Every other /api request, including every
 * authenticated GET, answers 403 PREVIEW_READ_ONLY there.
 */
const previewReadablePaths: ReadonlySet<string> = new Set([
  '/api/health',
  '/api/availability',
])

type PublicDateStatus = 'pending' | 'unavailable'

interface ParsedDate {
  timestamp: number
}

interface AvailabilityDate {
  date: string
  status: PublicDateStatus
}

type DateRow = {
  event_date: string
}

function parseCalendarDate(value: string): ParsedDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }

  const parsedDate = new Date(0)

  parsedDate.setUTCHours(0, 0, 0, 0)
  parsedDate.setUTCFullYear(year, month - 1, day)

  if (
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    return null
  }

  return {
    timestamp: parsedDate.getTime(),
  }
}

/** True only when the PREVIEW_READ_ONLY var is exactly "on" (env.preview). */
function isPreviewReadOnly(env: Env): boolean {
  return env.PREVIEW_READ_ONLY === ENABLED_VALUE
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function isAllowedInPreview(request: Request, url: URL): boolean {
  return request.method === 'GET' && previewReadablePaths.has(url.pathname)
}

function previewReadOnlyResponse(): Response {
  return errorResponse(
    403,
    'PREVIEW_READ_ONLY',
    'هذه نسخة معاينة للاطلاع فقط؛ لا يمكنكِ تسجيل الدخول أو إرسال طلب منها.',
  )
}

function handleHealth(request: Request): Response {
  if (request.method !== 'GET') {
    return methodNotAllowedResponse(['GET'])
  }

  return jsonResponse({
    ok: true,
    service: 'sundus-yar-booking-api',
    timestamp: new Date().toISOString(),
  })
}

async function handleAvailability(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowedResponse(['GET'])
  }

  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')

  if (!from || !to) {
    return errorResponse(
      400,
      'MISSING_DATE_RANGE',
      'يجب إرسال تاريخ البداية في from وتاريخ النهاية في to.',
    )
  }

  const parsedFrom = parseCalendarDate(from)
  const parsedTo = parseCalendarDate(to)

  if (!parsedFrom || !parsedTo) {
    return errorResponse(
      400,
      'INVALID_DATE',
      'يجب أن يكون التاريخان بصيغة YYYY-MM-DD وأن يمثلا تاريخين صحيحين.',
    )
  }

  if (parsedFrom.timestamp > parsedTo.timestamp) {
    return errorResponse(
      400,
      'INVALID_DATE_RANGE',
      'يجب أن يكون تاريخ البداية قبل تاريخ النهاية أو مساويًا له.',
    )
  }

  const inclusiveRangeDays =
    Math.floor(
      (parsedTo.timestamp - parsedFrom.timestamp) /
        MILLISECONDS_PER_DAY,
    ) + 1

  if (inclusiveRangeDays > MAXIMUM_RANGE_DAYS) {
    return errorResponse(
      400,
      'DATE_RANGE_TOO_LARGE',
      'يجب ألا تتجاوز المدة المطلوبة 93 يومًا شاملة تاريخي البداية والنهاية.',
    )
  }

  const blockedDatesStatement = env.DB.prepare(
    `
      SELECT event_date
      FROM blocked_dates
      WHERE event_date BETWEEN ? AND ?
      ORDER BY event_date ASC
    `,
  ).bind(from, to)

  const blockingBookingsStatement = env.DB.prepare(
    `
      SELECT DISTINCT event_date
      FROM booking_requests
      WHERE event_date BETWEEN ? AND ?
        AND status IN (
          'approved_hold',
          'contract_pending',
          'contract_signed',
          'payment_pending',
          'confirmed'
        )
      ORDER BY event_date ASC
    `,
  ).bind(from, to)

  const pendingBookingsStatement = env.DB.prepare(
    `
      SELECT DISTINCT event_date
      FROM booking_requests
      WHERE event_date BETWEEN ? AND ?
        AND status = 'pending_review'
      ORDER BY event_date ASC
    `,
  ).bind(from, to)

  const [
    blockedDatesResult,
    blockingBookingsResult,
    pendingBookingsResult,
  ] = await env.DB.batch<DateRow>([
    blockedDatesStatement,
    blockingBookingsStatement,
    pendingBookingsStatement,
  ])

  const statusesByDate = new Map<string, PublicDateStatus>()

  for (const row of pendingBookingsResult.results) {
    statusesByDate.set(row.event_date, 'pending')
  }

  for (const row of blockedDatesResult.results) {
    statusesByDate.set(row.event_date, 'unavailable')
  }

  for (const row of blockingBookingsResult.results) {
    statusesByDate.set(row.event_date, 'unavailable')
  }

  const dates: AvailabilityDate[] = Array.from(statusesByDate.entries())
    .sort(([firstDate], [secondDate]) => {
      if (firstDate < secondDate) {
        return -1
      }

      if (firstDate > secondDate) {
        return 1
      }

      return 0
    })
    .map(([date, status]) => ({
      date,
      status,
    }))

  return jsonResponse({
    ok: true,
    range: {
      from,
      to,
    },
    dates,
  })
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    let url: URL

    try {
      url = new URL(request.url)
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error
      }

      return errorResponse(
        400,
        'INVALID_REQUEST_URL',
        'تعذر قراءة عنوان الطلب.',
      )
    }

    try {
      // Before any routing, so no authenticated or writing handler can run
      // in the browse-only preview.
      if (
        isPreviewReadOnly(env) &&
        isApiPath(url.pathname) &&
        !isAllowedInPreview(request, url)
      ) {
        return previewReadOnlyResponse()
      }

      if (url.pathname === '/api/health') {
        return handleHealth(request)
      }

      if (url.pathname === '/api/availability') {
        return await handleAvailability(request, env, url)
      }

      // Admin portal namespaces (receipts, gallery, album, handover, slots,
      // queue) go to their own registry, guarded by the same admin check,
      // before the generic /api/admin branch. Legacy admin paths never match.
      if (isAdminPortalPath(url.pathname)) {
        return await handleAdminPortalRequest(request, env, url, ctx)
      }

      if (
        url.pathname === '/api/admin' ||
        url.pathname.startsWith('/api/admin/')
      ) {
        return await handleAdminRequest(request, env, url, ctx)
      }

      if (url.pathname === '/api/profile') {
        return await handleProfile(request, env)
      }

      if (url.pathname === '/api/bookings') {
        return await handleCreateBooking(request, env, ctx)
      }

      if (url.pathname === '/api/bookings/me') {
        return await handleMyBookings(request, env)
      }

      // /api/bookings/{bookingId}/... and /api/media/... (gated, see
      // portal/gates.ts).
      if (isPortalPath(url.pathname)) {
        return await handlePortalRequest(request, env, url, ctx)
      }

      if (isApiPath(url.pathname)) {
        return errorResponse(
          404,
          'NOT_FOUND',
          'مسار API غير موجود.',
        )
      }

      return errorResponse(
        404,
        'NOT_FOUND',
        'المسار غير موجود.',
      )
    } catch {
      console.error('Worker request failed.')

      return errorResponse(
        500,
        'INTERNAL_ERROR',
        'حدث خطأ غير متوقع. يرجى المحاولة لاحقًا.',
      )
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // The preview declares no crons; this also covers a manual trigger.
    if (isPreviewReadOnly(env)) {
      return
    }

    await runScheduledTick(controller, env, ctx)
  },
} satisfies ExportedHandler<Env>