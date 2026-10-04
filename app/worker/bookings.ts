import {
  isBookingPackageSnapshot,
  validateBookingSelection,
  type BookingPackageSnapshot,
} from '../shared/booking.js'
import type { BookingStatus } from '../shared/admin.js'
import {
  deriveJourneyStage,
  journeyStageLabels,
  serializeJourneyDeadline,
  type FlowVersion,
  type JourneyStageId,
  type JourneyStageSubState,
} from '../shared/journey.js'
import { OPEN_BOOKING_REQUESTS_MAX } from '../shared/limits.js'
import type { EmailDeliveryResult } from '../shared/notifications.js'
import type { StudioContact } from '../shared/settings.js'
import { latestBookableDateKey, riyadhDateKey } from '../shared/timing.js'
import {
  authenticateFirebaseRequest,
  requireVerifiedEmail,
  type AuthenticatedFirebaseUser,
} from './auth.js'
import {
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  payloadTooLargeResponse,
  readBoundedJson,
} from './http.js'
import {
  buildAdminBookingUrl,
  buildMyBookingsUrl,
  renderAdminNewBookingTemplate,
  renderCustomerBookingReceivedTemplate,
} from './email-templates.js'
import { sendEmail } from './email.js'
import {
  MAXIMUM_JOURNEY_ROWS,
  isMissingPortalSchemaError,
  loadCustomerBookingRecords,
  type CustomerBookingRecord,
} from './portal/journey-loader.js'
import {
  isRateLimited,
  openRequestLimitResponse,
  rateLimitedResponse,
} from './rate-limit.js'
import { readStudioContact } from './settings/settings-read.js'
import {
  checkCustomerAccount,
  isEmailBoundToToken,
  readAccountStanding,
} from './users.js'

/** UTF-8 bytes (audit SEC-05). */
const MAXIMUM_REQUEST_BODY_BYTES = 20_000
const MAXIMUM_BOOKINGS_PER_RESPONSE = MAXIMUM_JOURNEY_ROWS

const bookingBodyKeys: ReadonlySet<string> = new Set([
  'eventDate',
  'selection',
])

interface BookingBody {
  eventDate: string
  selection: unknown
}

/**
 * One item of GET /api/bookings/me (07-api-contracts §3.A; plan 11 §3.3
 * #1). The first nine fields are unchanged; the rest are the additive
 * journey fields, the last two from Wave 2 (W2-16).
 */
interface CustomerBookingPayload {
  id: string
  eventDate: string
  status: BookingStatus
  estimatedTotal: number
  packageSnapshot: BookingPackageSnapshot | null
  holdExpiresAt: string | null
  confirmedAt: string | null
  createdAt: string
  updatedAt: string
  flowVersion: FlowVersion
  stage: JourneyStageId | null
  stageLabel: string | null
  /** Also `awaiting_deposit` / `deposit_reported` on a flow-2 hold (UX-02). */
  stageSubState: JourneyStageSubState | null
  /** ISO instant, or a `YYYY-MM-DD` Riyadh date at stages 5–6; see shared/journey.ts. */
  stageDeadline: string | null
  depositAmount: number | null
  /** When she accepted the terms (flow 2), or null. */
  termsAcceptedAt: string | null
  /** The instant of the status change or stage event behind `stage` (UX-14). */
  stageUpdatedAt: string | null
}

/**
 * Top-level `studio` of GET /api/bookings/me: the effective contact number
 * and, within 72 h of a change, when it changed (TM-03, TM-19). Both null
 * when no contact revision is in force; the SPA then uses its compiled
 * number (src/lib/whatsapp.ts).
 */
type StudioContactPayload = StudioContact

interface ExistenceRow {
  found: number
}

interface CustomerNotificationProfile {
  firstName: string
  lastName: string
  phone: string
}

interface SubmissionConflicts {
  profileMissing: boolean
  emailNotBound: boolean
  dateUnavailable: boolean
  duplicateRequest: boolean
  openRequestLimitReached: boolean
}

type BookingBodyResult =
  | {
      ok: true
      value: BookingBody
    }
  | {
      ok: false
      response: Response
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactBookingBodyKeys(
  value: Record<string, unknown>,
): boolean {
  const keys = Object.keys(value)

  return (
    keys.length === bookingBodyKeys.size &&
    keys.every((key) => bookingBodyKeys.has(key))
  )
}

function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false
  }

  const parsedDate = new Date(0)

  parsedDate.setUTCHours(0, 0, 0, 0)
  parsedDate.setUTCFullYear(year, month - 1, day)

  return (
    parsedDate.getUTCFullYear() === year &&
    parsedDate.getUTCMonth() === month - 1 &&
    parsedDate.getUTCDate() === day
  )
}

function invalidBookingJsonResponse(): Response {
  return errorResponse(
    400,
    'INVALID_JSON',
    'تعذر قراءة بيانات طلب الحجز.',
  )
}

/**
 * Reads the POST /api/bookings body through the bounded reader in
 * worker/http.ts (audit SEC-05): 415 for a non-JSON type, 413 over 20,000
 * bytes, 400 INVALID_JSON for anything malformed or with other keys than
 * `eventDate` and `selection`.
 */
async function parseBookingBody(request: Request): Promise<BookingBodyResult> {
  const body = await readBoundedJson(request, MAXIMUM_REQUEST_BODY_BYTES)

  if (body.kind === 'unsupported-media-type') {
    return {
      ok: false,
      response: errorResponse(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'يجب إرسال بيانات طلب الحجز بصيغة JSON.',
      ),
    }
  }

  if (body.kind === 'too-large') {
    return { ok: false, response: payloadTooLargeResponse() }
  }

  if (
    body.kind !== 'parsed' ||
    !isRecord(body.value) ||
    !hasExactBookingBodyKeys(body.value)
  ) {
    return { ok: false, response: invalidBookingJsonResponse() }
  }

  return {
    ok: true,
    value: {
      eventDate:
        typeof body.value.eventDate === 'string'
          ? body.value.eventDate
          : '',
      selection: body.value.selection,
    },
  }
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

function profileRequiredResponse(): Response {
  return errorResponse(
    409,
    'PROFILE_REQUIRED',
    'يلزم استكمال الملف الشخصي قبل إرسال طلب الحجز.',
  )
}

/**
 * 409 EMAIL_ALREADY_IN_USE (the profile's code): the caller's row does not
 * hold her verified address with a proof, because another account already
 * holds that address (audit SEC-04). No booking may attach to such a row.
 */
function emailNotBoundResponse(): Response {
  return errorResponse(
    409,
    'EMAIL_ALREADY_IN_USE',
    'تعذر ربط بريدكِ الإلكتروني المؤكَّد بهذا الحساب، لذلك لم يُرسَل طلب الحجز. تواصلي معنا عبر واتساب لمساعدتكِ.',
  )
}

function dateUnavailableResponse(): Response {
  return errorResponse(
    409,
    'DATE_UNAVAILABLE',
    'التاريخ المحدد غير متاح للحجز.',
  )
}

function duplicateRequestResponse(): Response {
  return errorResponse(
    409,
    'DUPLICATE_BOOKING_REQUEST',
    'لديكِ طلب حجز مفتوح لهذا التاريخ بالفعل.',
  )
}

function bookingTooFarAheadResponse(): Response {
  return errorResponse(
    400,
    'BOOKING_TOO_FAR_AHEAD',
    'لا يمكن الحجز لأكثر من سنتين مقدمًا. اختاري تاريخًا أقرب.',
  )
}

async function loadCustomerNotificationProfile(
  env: Env,
  uid: string,
): Promise<CustomerNotificationProfile | null> {
  return env.DB.prepare(
    `
      SELECT
        first_name AS firstName,
        last_name AS lastName,
        phone
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
  )
    .bind(uid)
    .first<CustomerNotificationProfile>()
}

/**
 * The same conditions as the INSERT's guard in createBooking, read one by
 * one to name the one that failed. `email` is the token's verified address;
 * `riyadhToday` bounds the open-request count.
 */
async function readSubmissionConflicts(
  env: Env,
  uid: string,
  email: string,
  eventDate: string,
  riyadhToday: string,
): Promise<SubmissionConflicts> {
  const profileStatement = env.DB.prepare(
    `
      SELECT 1 AS found
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
  ).bind(uid)

  const emailBoundStatement = env.DB.prepare(
    `
      SELECT 1 AS found
      FROM users
      WHERE id = ?
        AND erased_at IS NULL
        AND email_verified_at IS NOT NULL
        AND email = ? COLLATE NOCASE
      LIMIT 1
    `,
  ).bind(uid, email)

  const blockedDateStatement = env.DB.prepare(
    `
      SELECT 1 AS found
      FROM blocked_dates
      WHERE event_date = ?
      LIMIT 1
    `,
  ).bind(eventDate)

  const blockingBookingStatement = env.DB.prepare(
    `
      SELECT 1 AS found
      FROM booking_requests
      WHERE event_date = ?
        AND status IN (
          'approved_hold',
          'contract_pending',
          'contract_signed',
          'payment_pending',
          'confirmed'
        )
      LIMIT 1
    `,
  ).bind(eventDate)

  const duplicateRequestStatement = env.DB.prepare(
    `
      SELECT 1 AS found
      FROM booking_requests
      WHERE user_id = ?
        AND event_date = ?
        AND status IN (
          'pending_review',
          'approved_hold',
          'contract_pending',
          'contract_signed',
          'payment_pending',
          'confirmed'
        )
      LIMIT 1
    `,
  ).bind(uid, eventDate)

  const openRequestLimitStatement = env.DB.prepare(
    `
      SELECT 1 AS found
      WHERE (
        SELECT COUNT(*)
        FROM booking_requests
        WHERE user_id = ?
          AND event_date >= ?
          AND status IN (
            'pending_review',
            'approved_hold',
            'contract_pending',
            'contract_signed',
            'payment_pending'
          )
      ) >= ?
    `,
  ).bind(uid, riyadhToday, OPEN_BOOKING_REQUESTS_MAX)

  const [
    profileResult,
    emailBoundResult,
    blockedDateResult,
    blockingBookingResult,
    duplicateRequestResult,
    openRequestLimitResult,
  ] = await env.DB.batch<ExistenceRow>([
    profileStatement,
    emailBoundStatement,
    blockedDateStatement,
    blockingBookingStatement,
    duplicateRequestStatement,
    openRequestLimitStatement,
  ])

  const profileMissing = profileResult.results.length === 0

  return {
    profileMissing,
    emailNotBound:
      !profileMissing && emailBoundResult.results.length === 0,
    dateUnavailable:
      blockedDateResult.results.length > 0 ||
      blockingBookingResult.results.length > 0,
    duplicateRequest: duplicateRequestResult.results.length > 0,
    openRequestLimitReached: openRequestLimitResult.results.length > 0,
  }
}

function conflictResponse(conflicts: SubmissionConflicts): Response | null {
  if (conflicts.profileMissing) {
    return profileRequiredResponse()
  }

  if (conflicts.emailNotBound) {
    return emailNotBoundResponse()
  }

  if (conflicts.dateUnavailable) {
    return dateUnavailableResponse()
  }

  if (conflicts.duplicateRequest) {
    return duplicateRequestResponse()
  }

  // The plan's 409 OPEN_REQUEST_LIMIT (rate-limit.ts). The booking form
  // reads it, and a Wave 0 Worker's TOO_MANY_OPEN_REQUESTS, as the same cap.
  if (conflicts.openRequestLimitReached) {
    return openRequestLimitResponse()
  }

  return null
}

function parseStoredSnapshot(value: string): BookingPackageSnapshot | null {
  try {
    const parsedValue: unknown = JSON.parse(value)

    return isBookingPackageSnapshot(parsedValue) ? parsedValue : null
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

async function deliverNewBookingNotifications(
  env: Env,
  identity: AuthenticatedFirebaseUser,
  profile: CustomerNotificationProfile,
  bookingId: string,
  eventDate: string,
  snapshot: BookingPackageSnapshot,
  estimatedTotal: number,
): Promise<void> {
  try {
    const adminBookingUrl = buildAdminBookingUrl(
      env.APP_BASE_URL,
      bookingId,
    )
    const myBookingsUrl = buildMyBookingsUrl(env.APP_BASE_URL)

    if (!adminBookingUrl || !myBookingsUrl) {
      return
    }

    const deliveryTasks: Array<Promise<EmailDeliveryResult>> = []
    const adminRecipient = env.ADMIN_NOTIFICATION_EMAIL?.trim()

    if (adminRecipient) {
      const adminTemplate = renderAdminNewBookingTemplate({
        bookingReference: bookingId,
        customerFirstName: profile.firstName,
        customerLastName: profile.lastName,
        customerEmail: identity.email,
        customerPhone: profile.phone,
        eventDate,
        packageName: snapshot.package.name,
        finalTotal: estimatedTotal,
        adminBookingUrl,
      })

      deliveryTasks.push(
        sendEmail(env, {
          to: adminRecipient,
          ...adminTemplate,
          idempotencyKey: `booking-created-admin:${bookingId}`,
        }),
      )
    }

    const customerTemplate = renderCustomerBookingReceivedTemplate({
      customerFirstName: profile.firstName,
      bookingReference: bookingId,
      eventDate,
      packageName: snapshot.package.name,
      finalTotal: estimatedTotal,
      myBookingsUrl,
    })

    deliveryTasks.push(
      sendEmail(env, {
        to: identity.email,
        ...customerTemplate,
        idempotencyKey: `booking-created-customer:${bookingId}`,
      }),
    )

    const results = await Promise.allSettled(deliveryTasks)
    const deliveryFailed = results.some(
      (result) =>
        result.status === 'rejected' ||
        (result.status === 'fulfilled' &&
          result.value.status === 'failed'),
    )

    if (deliveryFailed) {
      console.error('BOOKING_NOTIFICATION_FAILED')
    }
  } catch (error) {
    // The booking is already saved; a failed notice only costs the email.
    if (error instanceof Error) {
      console.error('BOOKING_NOTIFICATION_FAILED')

      return
    }

    throw error
  }
}

function scheduleNewBookingNotifications(
  ctx: ExecutionContext,
  env: Env,
  identity: AuthenticatedFirebaseUser,
  profile: CustomerNotificationProfile,
  bookingId: string,
  eventDate: string,
  snapshot: BookingPackageSnapshot,
  estimatedTotal: number,
): void {
  try {
    ctx.waitUntil(
      deliverNewBookingNotifications(
        env,
        identity,
        profile,
        bookingId,
        eventDate,
        snapshot,
        estimatedTotal,
      ),
    )
  } catch (error) {
    if (error instanceof Error) {
      console.error('BOOKING_NOTIFICATION_FAILED')

      return
    }

    throw error
  }
}

async function createBooking(
  env: Env,
  ctx: ExecutionContext,
  identity: AuthenticatedFirebaseUser,
  profile: CustomerNotificationProfile,
  eventDate: string,
  riyadhToday: string,
  snapshot: BookingPackageSnapshot,
  estimatedTotal: number,
): Promise<Response> {
  const readConflicts = (): Promise<SubmissionConflicts> =>
    readSubmissionConflicts(
      env,
      identity.uid,
      identity.email,
      eventDate,
      riyadhToday,
    )
  const initialConflicts = await readConflicts()
  const initialConflictResponse = conflictResponse(initialConflicts)

  if (initialConflictResponse) {
    return initialConflictResponse
  }

  const bookingId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const serializedSnapshot = JSON.stringify(snapshot)

  // The users clause is the SEC-04 binding: the row must hold the token's
  // verified address, proven, and not be erased. The COUNT is the SEC-03 cap
  // (OPEN_BOOKING_REQUESTS_MAX, 409 OPEN_REQUEST_LIMIT) on requests
  // before `confirmed` whose date is today (Riyadh) or later: a request whose
  // date has passed can never be approved (admin-workflow.ts), so requests
  // the owner never got to cannot lock her out. Inside the INSERT, so
  // concurrent submissions cannot pass it together.
  const insertBookingStatement = env.DB.prepare(
    `
      INSERT INTO booking_requests (
        id,
        user_id,
        event_date,
        status,
        package_snapshot,
        estimated_total,
        created_at,
        updated_at
      )
      SELECT ?, ?, ?, 'pending_review', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM users
        WHERE id = ?
          AND erased_at IS NULL
          AND email_verified_at IS NOT NULL
          AND email = ? COLLATE NOCASE
      )
        AND NOT EXISTS (
          SELECT 1
          FROM blocked_dates
          WHERE event_date = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM booking_requests
          WHERE event_date = ?
            AND status IN (
              'approved_hold',
              'contract_pending',
              'contract_signed',
              'payment_pending',
              'confirmed'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM booking_requests
          WHERE user_id = ?
            AND event_date = ?
            AND status IN (
              'pending_review',
              'approved_hold',
              'contract_pending',
              'contract_signed',
              'payment_pending',
              'confirmed'
            )
        )
        AND (
          SELECT COUNT(*)
          FROM booking_requests
          WHERE user_id = ?
            AND event_date >= ?
            AND status IN (
              'pending_review',
              'approved_hold',
              'contract_pending',
              'contract_signed',
              'payment_pending'
            )
        ) < ?
    `,
  ).bind(
    bookingId,
    identity.uid,
    eventDate,
    serializedSnapshot,
    estimatedTotal,
    createdAt,
    createdAt,
    identity.uid,
    identity.email,
    eventDate,
    eventDate,
    identity.uid,
    eventDate,
    identity.uid,
    riyadhToday,
    OPEN_BOOKING_REQUESTS_MAX,
  )

  const insertHistoryStatement = env.DB.prepare(
    `
      INSERT INTO booking_status_history (
        booking_id,
        from_status,
        to_status,
        changed_by,
        created_at
      )
      SELECT id, NULL, 'pending_review', ?, ?
      FROM booking_requests
      WHERE id = ?
    `,
  ).bind(identity.uid, createdAt, bookingId)

  // A write that lost a race (the guard's WHERE left it out, or a constraint
  // aborted the batch) answers with the condition that fails now; anything
  // else is a 500.
  let batchResults: D1Result[]

  try {
    batchResults = await env.DB.batch([
      insertBookingStatement,
      insertHistoryStatement,
    ])
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }

    const currentConflictResponse = conflictResponse(await readConflicts())

    if (currentConflictResponse) {
      return currentConflictResponse
    }

    throw new Error('Booking persistence failed', { cause: error })
  }

  const bookingChanges = batchResults[0]?.meta.changes ?? 0
  const historyChanges = batchResults[1]?.meta.changes ?? 0

  if (bookingChanges !== 1 || historyChanges !== 1) {
    const currentConflictResponse = conflictResponse(await readConflicts())

    if (currentConflictResponse) {
      return currentConflictResponse
    }

    throw new Error('Booking batch did not persist both records')
  }

  scheduleNewBookingNotifications(
    ctx,
    env,
    identity,
    profile,
    bookingId,
    eventDate,
    snapshot,
    estimatedTotal,
  )

  return jsonResponse(
    {
      ok: true,
      booking: {
        id: bookingId,
        eventDate,
        status: 'pending_review',
        estimatedTotal,
        createdAt,
      },
    },
    201,
  )
}

export async function handleCreateBooking(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowedResponse(['POST'])
  }

  const identity = await authenticateFirebaseRequest(request, env)

  if (!identity) {
    return unauthorizedResponse()
  }

  const verificationError = requireVerifiedEmail(identity)

  if (verificationError) {
    return verificationError
  }

  // Revoked token → 401, erased account → 410 (audit SEC-11, SEC-14), before
  // the limiter, so a revoked token cannot use up the owner's allowance.
  // A gate only: the row is read again after the body.
  const standing = await readAccountStanding(env.DB, identity)

  if (!standing.ok) {
    return standing.response
  }

  // Audit SEC-03: a per-uid burst limit (RL_BOOKING → 429 RATE_LIMITED)
  // before the body and any D1 write.
  if (await isRateLimited(env, 'booking-create', identity.uid)) {
    return rateLimitedResponse()
  }

  const parsedBody = await parseBookingBody(request)

  if (!parsedBody.ok) {
    return parsedBody.response
  }

  const requestBody = parsedBody.value
  // One instant for today and the horizon (shared/timing.ts, the same
  // computation as the SPA calendar's last day).
  const now = new Date()
  const riyadhToday = riyadhDateKey(now)

  if (
    !isValidCalendarDate(requestBody.eventDate) ||
    requestBody.eventDate < riyadhToday
  ) {
    return errorResponse(
      400,
      'INVALID_EVENT_DATE',
      'تاريخ المناسبة غير صحيح أو يقع قبل تاريخ اليوم.',
    )
  }

  if (requestBody.eventDate > latestBookableDateKey(now)) {
    return bookingTooFarAheadResponse()
  }

  const selectionResult = validateBookingSelection(requestBody.selection)

  if (!selectionResult.ok) {
    return errorResponse(
      400,
      'INVALID_BOOKING_SELECTION',
      'اختيارات الحجز غير صحيحة. يرجى مراجعتها والمحاولة مرة أخرى.',
    )
  }

  // The row is read again after the body, whose duration the client
  // decides: the read before the limiter only gates, so revocation or
  // erasure during the upload still answers 401/410 here. The verified token
  // re-syncs the stored email (audit SEC-04). A booking attaches only to a
  // row that then holds the token's address, proven: a row whose address
  // another account holds gets 409 EMAIL_ALREADY_IN_USE.
  const current = await checkCustomerAccount(env.DB, identity)

  if (!current.ok) {
    return current.response
  }

  const account = current.account

  if (!account) {
    return profileRequiredResponse()
  }

  if (!isEmailBoundToToken(identity, account)) {
    return emailNotBoundResponse()
  }

  const profile = await loadCustomerNotificationProfile(env, identity.uid)

  if (!profile) {
    return profileRequiredResponse()
  }

  return createBooking(
    env,
    ctx,
    identity,
    profile,
    requestBody.eventDate,
    riyadhToday,
    selectionResult.snapshot,
    selectionResult.estimatedTotal,
  )
}

export async function handleMyBookings(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowedResponse(['GET'])
  }

  const identity = await authenticateFirebaseRequest(request, env)

  if (!identity) {
    return unauthorizedResponse()
  }

  const verificationError = requireVerifiedEmail(identity)

  if (verificationError) {
    return verificationError
  }

  const standing = await checkCustomerAccount(env.DB, identity)

  if (!standing.ok) {
    return standing.response
  }

  // One instant for every derivation, for the studio's 72 h change window
  // and for `serverTime`, so the stages and the client's countdown
  // correction agree with each other.
  const now = new Date()
  const [{ records }, studio] = await Promise.all([
    loadCustomerBookingRecords(
      env.DB,
      identity.uid,
      MAXIMUM_BOOKINGS_PER_RESPONSE,
    ),
    readStudioContactPayload(env, now),
  ])
  const bookings = records.map((record) =>
    toCustomerBookingPayload(record, now),
  )

  return jsonResponse({
    ok: true,
    bookings,
    serverTime: now.toISOString(),
    studio,
  })
}

/**
 * The effective studio number (worker/settings/settings-read.ts). Rollout
 * safety only, as the loader's own fallback: a database without migration
 * 0008 has no revisions, which is the "no number" answer, not a reason to
 * hide her bookings. Any other failure still fails the request.
 */
async function readStudioContactPayload(
  env: Env,
  now: Date,
): Promise<StudioContactPayload> {
  try {
    return await readStudioContact(env.DB, now)
  } catch (error) {
    if (!isMissingPortalSchemaError(error)) {
      throw error
    }

    console.error('STUDIO_CONTACT_SCHEMA_UNAVAILABLE')

    return { whatsappNumber: null, whatsappNumberChangedAt: null }
  }
}

function toCustomerBookingPayload(
  record: CustomerBookingRecord,
  now: Date,
): CustomerBookingPayload {
  const journey = deriveJourneyStage(record.journeyFacts, now)

  return {
    id: record.id,
    eventDate: record.eventDate,
    status: record.status,
    estimatedTotal: record.estimatedTotal,
    packageSnapshot: parseStoredSnapshot(record.packageSnapshot),
    holdExpiresAt: record.holdExpiresAt,
    confirmedAt: record.confirmedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    flowVersion: record.flowVersion,
    stage: journey.stage,
    stageLabel:
      journey.stage === null ? null : journeyStageLabels[journey.stage],
    stageSubState: journey.subState,
    stageDeadline: serializeJourneyDeadline(journey.deadline),
    depositAmount: record.depositAmount,
    termsAcceptedAt: record.termsAcceptedAt,
    stageUpdatedAt: journey.updatedAt,
  }
}