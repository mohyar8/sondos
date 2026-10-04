import { WINDOWED_CAPS, windowStart } from '../../shared/limits.js'
import {
  CONSENT_BODY_MAX_BYTES,
  CONSENT_TEXT_VERSION,
  EVENT_PROFILE_BODY_MAX_BYTES,
  EVENT_PROFILE_ERROR_MESSAGES,
  EVENT_PROFILE_HISTORY_LIMIT,
  isEventProfileEditable,
  isEventProfileHistoryEvent,
  parseConsentUpdateInput,
  parseEventProfileInput,
  type AdminEventProfileView,
  type ConsentUpdateView,
  type EventProfile,
  type EventProfileField,
  type EventProfileFieldIssue,
  type EventProfileHistoryEntry,
  type EventProfileInput,
  type EventProfileInputErrorCode,
  type EventProfileView,
  type PublishPhotosConsent,
} from '../../shared/portal/event-profile.js'
import { riyadhTodayKey } from '../../shared/timing.js'
import { errorResponse, jsonResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import { requireRecentCustomerSignIn } from '../recent-auth.js'
import type { AdminPortalContext } from './admin-portal-routes.js'
import { bookingNotFoundResponse } from './owned-booking.js'
import type { CustomerPortalContext } from './portal-routes.js'
import { readJsonBody } from './request.js'

/**
 * Event profile and publishing consent (plan 11 §3.2 #6–#8, #22, §3.3;
 * decision D2; TM-06, TM-08, TM-11, TM-12; SB-2, SB-3, SB-5, SB-13, SB-15,
 * SB-16). Routed from worker/portal/slots/event-profile.ts (CO) and
 * worker/portal/slots/admin-event-profile.ts (AD), both gate 'open'.
 *
 * - Ownership: the dispatcher proved it once (owned-booking.ts); every
 *   statement here binds `booking_requests.user_id = ?` to the verified uid
 *   again, and status, event day and caps are re-checked inside the writing
 *   statement itself, never taken from the OwnedBooking snapshot (SB-5).
 * - #7 upserts event_profiles only when a value differs, and writes
 *   booking_events('event_profile_saved') only when the upsert changed the
 *   row (TM-11): identical saves write nothing. A purged profile
 *   (text_purged_at) is never written again.
 * - #8 consent: no row = NO. A grant needs CO+R (sign-in ≤ 10 minutes,
 *   TM-08, N-39) and the current consent text version; a withdrawal needs
 *   neither, works in every booking status and is never capped. Each change
 *   writes consent_granted / consent_withdrawn, and a grant is refused once
 *   the booking has CONSENT_GRANT_CAP consent events in the last 24 hours,
 *   counted inside the INSERT (N-40). One slot of the daily cap is kept for
 *   the withdrawal that can follow the last grant, so a booking never has
 *   more than WINDOWED_CAPS.consentChangesPerBooking.max changes a day and
 *   a withdrawal is always possible.
 * - Bursts: every customer write goes through RL_CUSTOMER_WRITE and the
 *   admin read through RL_ADMIN_READ, keyed by the verified uid (§3.1).
 * - Free text is personal data: it is validated with the shared validator,
 *   stored, returned to its owner and the admin, and nothing else. Nothing
 *   in this module logs, and booking_events rows carry no details.
 *
 * D1 rows are a trust boundary: a row with an unexpected shape throws a
 * fixed code without any row data, which worker/index.ts answers with 500.
 */

const CONSENT_CHANGES_CAP = WINDOWED_CAPS.consentChangesPerBooking

/** Consent events a booking may already have in the window for a grant. */
const CONSENT_GRANT_CAP = CONSENT_CHANGES_CAP.max - 1

/*
 * One read for #6, #7 and #8 after their writes, and #22: the booking with
 * its profile and its publish_photos consent (LEFT JOINs: either may be
 * missing). Only constant fragments are joined (SB-4).
 */
const EVENT_PROFILE_VIEW_SELECT = `
  SELECT
    br.status AS status,
    br.event_date AS eventDate,
    ep.booking_id AS profileBookingId,
    ep.venue_name AS venueName,
    ep.venue_area AS venueArea,
    ep.event_start_time AS startTime,
    ep.special_requests AS specialRequests,
    ep.updated_at AS profileUpdatedAt,
    ep.text_purged_at AS textPurgedAt,
    bc.granted AS consentGranted,
    bc.text_version AS consentTextVersion,
    bc.updated_at AS consentUpdatedAt
  FROM booking_requests AS br
  LEFT JOIN event_profiles AS ep
    ON ep.booking_id = br.id
  LEFT JOIN booking_consents AS bc
    ON bc.booking_id = br.id
    AND bc.purpose = 'publish_photos'
`

/** Binds: booking id, customer uid. */
const CUSTOMER_VIEW_SQL = `${EVENT_PROFILE_VIEW_SELECT}
  WHERE br.id = ?1
    AND br.user_id = ?2
  LIMIT 1
`

/** Binds: booking id. Admin only (#22). */
const ADMIN_VIEW_SQL = `${EVENT_PROFILE_VIEW_SELECT}
  WHERE br.id = ?1
  LIMIT 1
`

/** Binds: booking id, row limit. Newest first; kinds and instants only. */
const ADMIN_HISTORY_SQL = `
  SELECT
    event,
    created_at AS createdAt
  FROM booking_events
  WHERE booking_id = ?1
    AND event IN ('event_profile_saved', 'consent_granted', 'consent_withdrawn')
  ORDER BY id DESC
  LIMIT ?2
`

/**
 * #7. Binds: ?1 booking id, ?2 uid, ?3 venue name, ?4 venue area, ?5 start
 * time, ?6 special requests, ?7 now, ?8 Riyadh today. Inserts or updates
 * only for the owner's confirmed booking whose event day has not passed,
 * and updates only when a value differs and the text was never purged.
 */
const UPSERT_EVENT_PROFILE_SQL = `
  INSERT INTO event_profiles (
    booking_id,
    venue_name,
    venue_area,
    event_start_time,
    special_requests,
    created_at,
    updated_at
  )
  SELECT br.id, ?3, ?4, ?5, ?6, ?7, ?7
  FROM booking_requests AS br
  WHERE br.id = ?1
    AND br.user_id = ?2
    AND br.status = 'confirmed'
    AND br.event_date >= ?8
  ON CONFLICT (booking_id) DO UPDATE SET
    venue_name = excluded.venue_name,
    venue_area = excluded.venue_area,
    event_start_time = excluded.event_start_time,
    special_requests = excluded.special_requests,
    updated_at = excluded.updated_at
  WHERE event_profiles.text_purged_at IS NULL
    AND (
      event_profiles.venue_name IS NOT excluded.venue_name
      OR event_profiles.venue_area IS NOT excluded.venue_area
      OR event_profiles.event_start_time IS NOT excluded.event_start_time
      OR event_profiles.special_requests IS NOT excluded.special_requests
    )
`

/*
 * The event rows read changes(), which still describes the previous
 * statement of the batch while this one runs: no row unless that write
 * changed the profile or the consent. No details (SB-13).
 */

/** Binds: ?1 booking id, ?2 now. Right after UPSERT_EVENT_PROFILE_SQL. */
const EVENT_PROFILE_SAVED_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, event, created_at)
  SELECT ?1, 'customer', 'event_profile_saved', ?2
  WHERE changes() = 1
`

/**
 * #8 grant. Binds: ?1 booking id, ?2 uid, ?3 text version, ?4 now, ?5 cap
 * window start, ?6 CONSENT_GRANT_CAP. Only for the owner's confirmed
 * booking, below the cap, and only when the consent is not already granted
 * for this text version.
 */
const GRANT_CONSENT_SQL = `
  INSERT INTO booking_consents (
    booking_id,
    purpose,
    granted,
    text_version,
    created_at,
    updated_at
  )
  SELECT br.id, 'publish_photos', 1, ?3, ?4, ?4
  FROM booking_requests AS br
  WHERE br.id = ?1
    AND br.user_id = ?2
    AND br.status = 'confirmed'
    AND (
      SELECT COUNT(*)
      FROM booking_events
      WHERE booking_id = ?1
        AND event IN ('consent_granted', 'consent_withdrawn')
        AND created_at > ?5
    ) < ?6
  ON CONFLICT (booking_id, purpose) DO UPDATE SET
    granted = 1,
    text_version = excluded.text_version,
    updated_at = excluded.updated_at
  WHERE booking_consents.granted = 0
    OR booking_consents.text_version IS NOT excluded.text_version
`

/** Binds: ?1 booking id, ?2 now. Right after GRANT_CONSENT_SQL. */
const CONSENT_GRANTED_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, event, created_at)
  SELECT ?1, 'customer', 'consent_granted', ?2
  WHERE changes() = 1
`

/**
 * #8 withdrawal. Binds: ?1 booking id, ?2 uid, ?3 now. Turns an existing
 * grant off for the owner, whatever the booking's status; no row stays no
 * row (already NO).
 */
const WITHDRAW_CONSENT_SQL = `
  UPDATE booking_consents
  SET granted = 0,
    updated_at = ?3
  WHERE booking_id = ?1
    AND purpose = 'publish_photos'
    AND granted = 1
    AND EXISTS (
      SELECT 1
      FROM booking_requests
      WHERE id = ?1
        AND user_id = ?2
    )
`

/** Binds: ?1 booking id, ?2 now. Right after WITHDRAW_CONSENT_SQL. */
const CONSENT_WITHDRAWN_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, event, created_at)
  SELECT ?1, 'customer', 'consent_withdrawn', ?2
  WHERE changes() = 1
`

// ---------------------------------------------------------------------------
// Rows (trust boundary)
// ---------------------------------------------------------------------------

type Row = Readonly<Record<string, unknown>>

interface EventProfileRecord {
  readonly status: string
  readonly eventDate: string
  /** Null when no event_profiles row exists. */
  readonly profile: EventProfile | null
  readonly textPurged: boolean
  readonly consent: PublishPhotosConsent
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function invalidRow(): never {
  throw new Error('EVENT_PROFILE_ROW_INVALID')
}

function readConsent(row: Row): PublishPhotosConsent {
  const { consentGranted, consentTextVersion, consentUpdatedAt } = row

  if (
    consentGranted === null &&
    consentTextVersion === null &&
    consentUpdatedAt === null
  ) {
    return {
      granted: false,
      textVersion: CONSENT_TEXT_VERSION,
      updatedAt: null,
    }
  }

  if (
    (consentGranted !== 0 && consentGranted !== 1) ||
    typeof consentTextVersion !== 'string' ||
    typeof consentUpdatedAt !== 'string'
  ) {
    return invalidRow()
  }

  return {
    granted: consentGranted === 1,
    textVersion: consentTextVersion,
    updatedAt: consentUpdatedAt,
  }
}

function readEventProfileRecord(row: Row): EventProfileRecord {
  const {
    status,
    eventDate,
    profileBookingId,
    venueName,
    venueArea,
    startTime,
    specialRequests,
    profileUpdatedAt,
    textPurgedAt,
  } = row

  if (
    typeof status !== 'string' ||
    typeof eventDate !== 'string' ||
    !isNullableString(profileBookingId) ||
    !isNullableString(venueName) ||
    !isNullableString(venueArea) ||
    !isNullableString(startTime) ||
    !isNullableString(specialRequests) ||
    !isNullableString(profileUpdatedAt) ||
    !isNullableString(textPurgedAt)
  ) {
    return invalidRow()
  }

  let profile: EventProfile | null = null

  if (profileBookingId !== null) {
    if (profileUpdatedAt === null) {
      return invalidRow()
    }

    profile = {
      venueName,
      venueArea,
      startTime,
      specialRequests,
      updatedAt: profileUpdatedAt,
    }
  }

  return {
    status,
    eventDate,
    profile,
    textPurged: textPurgedAt !== null,
    consent: readConsent(row),
  }
}

function readHistoryEntry(row: Row): EventProfileHistoryEntry {
  const { event, createdAt } = row

  if (!isEventProfileHistoryEvent(event) || typeof createdAt !== 'string') {
    return invalidRow()
  }

  return { event, createdAt }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function customerView(
  record: EventProfileRecord,
  todayKey: string,
): EventProfileView {
  return {
    eventProfile: record.profile,
    consent: { publishPhotos: record.consent },
    editable:
      !record.textPurged &&
      isEventProfileEditable(record.status, record.eventDate, todayKey),
    eventDate: record.eventDate,
  }
}

function inputErrorResponse(
  code: EventProfileInputErrorCode,
  field: EventProfileField | null,
  issue: EventProfileFieldIssue | null,
): Response {
  if (code === 'INVALID_REQUEST_BODY') {
    return invalidRequestBodyResponse()
  }

  // The optional `details` array (07 §1.2): the field name, never its value.
  return jsonResponse(
    {
      ok: false,
      error: {
        code,
        message: EVENT_PROFILE_ERROR_MESSAGES[code],
        ...(field !== null && issue !== null
          ? { details: [{ field, issue }] }
          : {}),
      },
    },
    400,
  )
}

/** The same answer as request.ts gives for a malformed body. */
function invalidRequestBodyResponse(): Response {
  return errorResponse(
    400,
    'INVALID_REQUEST_BODY',
    'بيانات الطلب غير صحيحة.',
  )
}

function bookingNotConfirmedResponse(): Response {
  return errorResponse(
    409,
    'BOOKING_NOT_CONFIRMED',
    EVENT_PROFILE_ERROR_MESSAGES.BOOKING_NOT_CONFIRMED,
  )
}

function eventDatePassedResponse(): Response {
  return errorResponse(
    409,
    'EVENT_DATE_PASSED',
    EVENT_PROFILE_ERROR_MESSAGES.EVENT_DATE_PASSED,
  )
}

function consentTextOutdatedResponse(): Response {
  return errorResponse(
    409,
    'CONSENT_TEXT_OUTDATED',
    EVENT_PROFILE_ERROR_MESSAGES.CONSENT_TEXT_OUTDATED,
  )
}

/** The read-back statement's single row, or null when the booking is gone. */
function readBackRecord(
  result: D1Result<Row> | undefined,
): EventProfileRecord | null {
  if (!result) {
    throw new Error('EVENT_PROFILE_BATCH_INCOMPLETE')
  }

  const [row] = result.results

  return row ? readEventProfileRecord(row) : null
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** #6 GET /api/bookings/{id}/event-profile (CO). */
export async function handleGetEventProfile(
  context: CustomerPortalContext,
): Promise<Response> {
  const { env, customer, booking } = context
  const now = new Date()
  const row = await env.DB.prepare(CUSTOMER_VIEW_SQL)
    .bind(booking.id, customer.uid)
    .first<Row>()

  if (!row) {
    return bookingNotFoundResponse()
  }

  return jsonResponse({
    ok: true,
    ...customerView(readEventProfileRecord(row), riyadhTodayKey(now)),
  })
}

/** #7 PUT /api/bookings/{id}/event-profile (CO). */
export async function handlePutEventProfile(
  context: CustomerPortalContext,
): Promise<Response> {
  const { request, env, customer, booking } = context

  if ((await limitBurst(env.RL_CUSTOMER_WRITE, customer.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const read = await readJsonBody(request, {
    maxBytes: EVENT_PROFILE_BODY_MAX_BYTES,
    requiredKeys: [
      'venueName',
      'venueArea',
      'startTime',
      'specialRequests',
    ],
  })

  if (!read.ok) {
    // The cap fits every legal body, so only an over-long field exceeds it.
    return read.failure === 'too-large'
      ? inputErrorResponse('FIELD_TOO_LONG', null, null)
      : read.response
  }

  const parsed = parseEventProfileInput(read.body)

  if (!parsed.ok) {
    return inputErrorResponse(parsed.code, parsed.field, parsed.issue)
  }

  const input: EventProfileInput = parsed.value
  const now = new Date()
  const nowIso = now.toISOString()
  const todayKey = riyadhTodayKey(now)
  const [upsertResult, , readBack] = await env.DB.batch<Row>([
    env.DB.prepare(UPSERT_EVENT_PROFILE_SQL).bind(
      booking.id,
      customer.uid,
      input.venueName,
      input.venueArea,
      input.startTime,
      input.specialRequests,
      nowIso,
      todayKey,
    ),
    env.DB.prepare(EVENT_PROFILE_SAVED_EVENT_SQL).bind(booking.id, nowIso),
    env.DB.prepare(CUSTOMER_VIEW_SQL).bind(booking.id, customer.uid),
  ])
  const record = readBackRecord(readBack)

  if (!record) {
    return bookingNotFoundResponse()
  }

  if ((upsertResult?.meta.changes ?? 0) === 0) {
    // Nothing written: a refused precondition, or the same values again.
    if (record.status !== 'confirmed') {
      return bookingNotConfirmedResponse()
    }

    if (record.eventDate < todayKey || record.textPurged) {
      return eventDatePassedResponse()
    }
  }

  return jsonResponse({ ok: true, ...customerView(record, todayKey) })
}

/** #8 PUT /api/bookings/{id}/consent (CO; granting CO+R). */
export async function handlePutConsent(
  context: CustomerPortalContext,
): Promise<Response> {
  const { request, env, customer, booking } = context

  if ((await limitBurst(env.RL_CUSTOMER_WRITE, customer.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const read = await readJsonBody(request, {
    maxBytes: CONSENT_BODY_MAX_BYTES,
    requiredKeys: ['purpose', 'granted', 'textVersion'],
  })

  if (!read.ok) {
    return read.response
  }

  const parsed = parseConsentUpdateInput(read.body)

  if (!parsed.ok) {
    return invalidRequestBodyResponse()
  }

  const { granted, textVersion } = parsed.value
  const nowIso = new Date().toISOString()

  if (!granted) {
    // Withdrawal: no sign-in age, no status, no cap, no text version.
    const [, , readBack] = await env.DB.batch<Row>([
      env.DB.prepare(WITHDRAW_CONSENT_SQL).bind(
        booking.id,
        customer.uid,
        nowIso,
      ),
      env.DB.prepare(CONSENT_WITHDRAWN_EVENT_SQL).bind(booking.id, nowIso),
      env.DB.prepare(CUSTOMER_VIEW_SQL).bind(booking.id, customer.uid),
    ])
    const record = readBackRecord(readBack)

    if (!record) {
      return bookingNotFoundResponse()
    }

    const view: ConsentUpdateView = {
      consent: { publishPhotos: record.consent },
    }

    return jsonResponse({ ok: true, ...view })
  }

  if (textVersion !== CONSENT_TEXT_VERSION) {
    return consentTextOutdatedResponse()
  }

  // A snapshot answer only; the INSERT re-checks the status itself.
  if (booking.status !== 'confirmed') {
    return bookingNotConfirmedResponse()
  }

  // CO+R (TM-08, N-39): a grant needs a sign-in at most 10 minutes old.
  const reauthentication = requireRecentCustomerSignIn(customer)

  if (reauthentication) {
    return reauthentication
  }

  const now = new Date()
  const grantedAt = now.toISOString()
  const [grantResult, , readBack] = await env.DB.batch<Row>([
    env.DB.prepare(GRANT_CONSENT_SQL).bind(
      booking.id,
      customer.uid,
      CONSENT_TEXT_VERSION,
      grantedAt,
      windowStart(CONSENT_CHANGES_CAP, now),
      CONSENT_GRANT_CAP,
    ),
    env.DB.prepare(CONSENT_GRANTED_EVENT_SQL).bind(booking.id, grantedAt),
    env.DB.prepare(CUSTOMER_VIEW_SQL).bind(booking.id, customer.uid),
  ])
  const record = readBackRecord(readBack)

  if (!record) {
    return bookingNotFoundResponse()
  }

  if ((grantResult?.meta.changes ?? 0) === 0) {
    const alreadyGranted =
      record.consent.granted &&
      record.consent.textVersion === CONSENT_TEXT_VERSION

    if (!alreadyGranted) {
      return record.status !== 'confirmed'
        ? bookingNotConfirmedResponse()
        : rateLimitedResponse(CONSENT_CHANGES_CAP.windowSeconds)
    }
  }

  const view: ConsentUpdateView = {
    consent: { publishPhotos: record.consent },
  }

  return jsonResponse({ ok: true, ...view })
}

/** #22 GET /api/admin/bookings/{id}/event-profile (AD). */
export async function handleAdminGetEventProfile(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin, params } = context
  const bookingId = params.bookingId

  if (bookingId === undefined) {
    // Unreachable: the route template captures :bookingId.
    throw new Error('EVENT_PROFILE_ROUTE_PARAMETER_MISSING')
  }

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const [viewResult, historyResult] = await env.DB.batch<Row>([
    env.DB.prepare(ADMIN_VIEW_SQL).bind(bookingId),
    env.DB.prepare(ADMIN_HISTORY_SQL).bind(
      bookingId,
      EVENT_PROFILE_HISTORY_LIMIT,
    ),
  ])
  const record = readBackRecord(viewResult)

  if (!record) {
    return bookingNotFoundResponse()
  }

  if (!historyResult) {
    throw new Error('EVENT_PROFILE_BATCH_INCOMPLETE')
  }

  const view: AdminEventProfileView = {
    eventProfile: record.profile,
    textPurged: record.textPurged,
    consent: {
      publishPhotos: {
        ...record.consent,
        // While granted, updated_at is the grant: a withdrawal turns it off.
        grantedAt: record.consent.granted ? record.consent.updatedAt : null,
      },
    },
    history: historyResult.results.map(readHistoryEntry),
    eventDate: record.eventDate,
  }

  return jsonResponse({ ok: true, ...view })
}
