import {
  FEEDBACK_BODY_MAX_BYTES,
  FEEDBACK_BODY_OPTIONAL_KEYS,
  FEEDBACK_BODY_REQUIRED_KEYS,
  isSameFeedback,
  parseFeedbackView,
  validateFeedbackSubmission,
  type FeedbackSubmissionProblem,
  type FeedbackView,
} from '../../shared/portal/feedback.js'
import { errorResponse, jsonResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import type { AdminPortalContext } from './admin-portal-routes.js'
import { bookingNotFoundResponse } from './owned-booking.js'
import type { CustomerPortalContext } from './portal-routes.js'
import { readJsonBody } from './request.js'

/**
 * Private feedback (plan 11 §3.3 #12, §3.2 #25; API contract 07 §3.H;
 * decision D7, HND-09). Three handlers, plugged in by
 * slots/feedback.ts and slots/admin-feedback.ts:
 *
 * - GET  /api/bookings/{id}/feedback (CO): `{ ok, feedback: null | {…} }`.
 * - POST /api/bookings/{id}/feedback (CO): one submission per booking, only
 *   after the album was handed over. First submission 201; a retry with
 *   the same rating and (normalised) comment 200, unchanged; a different
 *   one 409 FEEDBACK_ALREADY_SUBMITTED (compare-on-retry, 07 §3.H.1).
 * - GET  /api/admin/bookings/{id}/feedback (AD): the same shape, read-only.
 *
 * There is no update, delete or publish path: feedback is never shown to
 * anyone but the customer who wrote it and the admin.
 *
 * Security (SB-2, SB-3, SB-6, SB-15, SB-16; TM-06, TM-11, TM-12):
 * - The dispatcher proved ownership (owned-booking.ts). Every statement
 *   here still binds `booking_requests.user_id = ?` to the verified uid, and
 *   the write checks the handover inside its own INSERT, so a booking that
 *   changed hands or state after the ownership read is never written.
 * - The body is exact-key JSON under a byte cap (request.ts readJsonBody);
 *   the rating is an integer 1–5 and the comment goes through
 *   shared/text.ts normalizeFreeText (shared/portal/feedback.ts). Errors
 *   are fixed codes and messages that never echo the request.
 * - One row per booking is the table's primary key: the INSERT does
 *   nothing on a conflict, so two concurrent submissions store one row and
 *   one `feedback_submitted` event (written only when the row was inserted,
 *   behind the changes() guard, in the same batch).
 * - Writes are behind the RL_CUSTOMER_WRITE burst (keyed by uid), admin
 *   reads behind RL_ADMIN_READ; the primary key is the hard cap.
 * - Output goes through jsonResponse; the comment is plain text, never
 *   logged. Nothing here logs.
 * - D1 rows are a trust boundary: a row of an unexpected shape throws a
 *   fixed code without row data (worker/index.ts answers 500).
 */

/**
 * The write. Inserts the row only when the booking belongs to the verified
 * customer and its handover is completed; an existing row is left as it is.
 * Binds: booking id, rating, comment, now, now, booking id, uid.
 */
const INSERT_FEEDBACK_SQL = `
  INSERT INTO feedback (booking_id, rating, comment, created_at, updated_at)
  SELECT ?, ?, ?, ?, ?
  WHERE EXISTS (
    SELECT 1
    FROM booking_requests AS booking
    INNER JOIN handovers AS handover ON handover.booking_id = booking.id
    WHERE booking.id = ?
      AND booking.user_id = ?
      AND handover.status = 'completed'
  )
  ON CONFLICT (booking_id) DO NOTHING
`

/*
 * changes() and the guard: this statement runs right after the INSERT above
 * in the same batch, while changes() still describes that INSERT. It adds
 * nothing when no row was inserted (an ineligible booking or a retry). If
 * it ever saw more than one changed row, event would be NULL, the NOT NULL
 * constraint would fail and the whole batch would roll back; the same guard
 * as worker/audit/admin-audit.ts. No details: the event records that
 * feedback exists, never what it says.
 * Binds: booking id, now.
 */
const INSERT_FEEDBACK_EVENT_SQL = `
  INSERT INTO booking_events (
    booking_id,
    actor,
    actor_uid,
    event,
    subject_id,
    details,
    note,
    created_at
  )
  SELECT
    ?,
    'customer',
    NULL,
    CASE WHEN changes() = 1 THEN 'feedback_submitted' END,
    NULL,
    NULL,
    NULL,
    ?
  WHERE changes() <> 0
`

/**
 * The state after the write, read in the same batch: the stored feedback,
 * if any, and whether the handover is completed. No row: the booking is no
 * longer this customer's. Binds: booking id, uid.
 */
const SELECT_OWNED_FEEDBACK_STATE_SQL = `
  SELECT
    feedback.rating AS rating,
    feedback.comment AS comment,
    feedback.created_at AS submittedAt,
    EXISTS (
      SELECT 1
      FROM handovers AS handover
      WHERE handover.booking_id = booking.id
        AND handover.status = 'completed'
    ) AS handedOver
  FROM booking_requests AS booking
  LEFT JOIN feedback ON feedback.booking_id = booking.id
  WHERE booking.id = ?
    AND booking.user_id = ?
  LIMIT 1
`

/** The customer's read. Binds: booking id, uid. */
const SELECT_OWNED_FEEDBACK_SQL = `
  SELECT
    feedback.rating AS rating,
    feedback.comment AS comment,
    feedback.created_at AS submittedAt
  FROM booking_requests AS booking
  LEFT JOIN feedback ON feedback.booking_id = booking.id
  WHERE booking.id = ?
    AND booking.user_id = ?
  LIMIT 1
`

/** The admin's read: any booking. Binds: booking id. */
const SELECT_ADMIN_FEEDBACK_SQL = `
  SELECT
    feedback.rating AS rating,
    feedback.comment AS comment,
    feedback.created_at AS submittedAt
  FROM booking_requests AS booking
  LEFT JOIN feedback ON feedback.booking_id = booking.id
  WHERE booking.id = ?
  LIMIT 1
`

type FeedbackRow = Readonly<Record<string, unknown>>

/**
 * A row of the LEFT JOIN: null when the booking has no feedback (every
 * feedback column NULL), else the view. Anything else throws.
 */
function readFeedbackColumns(row: FeedbackRow): FeedbackView | null {
  if (
    row.rating === null &&
    row.comment === null &&
    row.submittedAt === null
  ) {
    return null
  }

  const view = parseFeedbackView({
    rating: row.rating,
    comment: row.comment,
    submittedAt: row.submittedAt,
  })

  if (!view) {
    throw new Error('FEEDBACK_ROW_INVALID')
  }

  return view
}

/** SQLite's EXISTS answers the integer 0 or 1. */
function readFlag(value: unknown): boolean {
  if (value === 0 || value === 1) {
    return value === 1
  }

  throw new Error('FEEDBACK_ROW_INVALID')
}

function firstRow(result: D1Result<FeedbackRow> | undefined): FeedbackRow | null {
  if (!result || !Array.isArray(result.results)) {
    throw new Error('FEEDBACK_BATCH_INVALID')
  }

  return result.results[0] ?? null
}

function insertedOneRow(result: D1Result<FeedbackRow> | undefined): boolean {
  const changes = result?.meta.changes

  if (changes === 0 || changes === 1) {
    return changes === 1
  }

  throw new Error('FEEDBACK_BATCH_INVALID')
}

function feedbackResponse(
  feedback: FeedbackView | null,
  status = 200,
): Response {
  return jsonResponse({ ok: true, feedback }, status)
}

function submissionProblemResponse(problem: FeedbackSubmissionProblem): Response {
  switch (problem) {
    case 'too-long':
      return errorResponse(
        400,
        'FIELD_TOO_LONG',
        'أحد الحقول يتجاوز الحد الأقصى المسموح به لعدد الأحرف.',
      )
    case 'invalid-text':
      return errorResponse(
        400,
        'INVALID_TEXT',
        'يحتوي النص على رموز غير مسموح بها.',
      )
    case 'invalid-body':
      return errorResponse(
        400,
        'INVALID_REQUEST_BODY',
        'بيانات الطلب غير صحيحة.',
      )
  }
}

function notYetHandedOverResponse(): Response {
  return errorResponse(
    409,
    'NOT_YET_HANDED_OVER',
    'يمكن إرسال التقييم بعد استلام الألبوم فقط.',
  )
}

function feedbackAlreadySubmittedResponse(): Response {
  return errorResponse(
    409,
    'FEEDBACK_ALREADY_SUBMITTED',
    'تم إرسال تقييمكِ لهذا الحجز بالفعل.',
  )
}

/** GET /api/bookings/{id}/feedback (CO). */
export async function handleGetFeedback(
  context: CustomerPortalContext,
): Promise<Response> {
  const { env, booking, customer } = context
  const row = await env.DB.prepare(SELECT_OWNED_FEEDBACK_SQL)
    .bind(booking.id, customer.uid)
    .first<FeedbackRow>()

  if (!row) {
    return bookingNotFoundResponse()
  }

  return feedbackResponse(readFeedbackColumns(row))
}

/** POST /api/bookings/{id}/feedback (CO). */
export async function handleSubmitFeedback(
  context: CustomerPortalContext,
): Promise<Response> {
  const { request, env, booking, customer } = context

  if ((await limitBurst(env.RL_CUSTOMER_WRITE, customer.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const read = await readJsonBody(request, {
    maxBytes: FEEDBACK_BODY_MAX_BYTES,
    requiredKeys: FEEDBACK_BODY_REQUIRED_KEYS,
    optionalKeys: FEEDBACK_BODY_OPTIONAL_KEYS,
  })

  if (!read.ok) {
    return read.response
  }

  const validated = validateFeedbackSubmission(read.body)

  if (!validated.ok) {
    return submissionProblemResponse(validated.problem)
  }

  const { submission } = validated
  const now = new Date().toISOString()
  const [inserted, , state] = await env.DB.batch<FeedbackRow>([
    env.DB.prepare(INSERT_FEEDBACK_SQL).bind(
      booking.id,
      submission.rating,
      submission.comment,
      now,
      now,
      booking.id,
      customer.uid,
    ),
    env.DB.prepare(INSERT_FEEDBACK_EVENT_SQL).bind(booking.id, now),
    env.DB.prepare(SELECT_OWNED_FEEDBACK_STATE_SQL).bind(
      booking.id,
      customer.uid,
    ),
  ])
  const created = insertedOneRow(inserted)
  const row = firstRow(state)

  // The booking stopped being hers between the ownership read and the
  // batch: the same 404 as an unknown id (TM-06).
  if (!row) {
    return bookingNotFoundResponse()
  }

  const stored = readFeedbackColumns(row)

  if (created) {
    if (!stored || !isSameFeedback(stored, submission)) {
      throw new Error('FEEDBACK_WRITE_INVALID')
    }

    return feedbackResponse(stored, 201)
  }

  if (stored) {
    return isSameFeedback(stored, submission)
      ? feedbackResponse(stored)
      : feedbackAlreadySubmittedResponse()
  }

  if (readFlag(row.handedOver)) {
    // Eligible, not stored and not a conflict: the INSERT's own check and
    // this read disagree, which one batch cannot produce.
    throw new Error('FEEDBACK_WRITE_INVALID')
  }

  return notYetHandedOverResponse()
}

/** GET /api/admin/bookings/{id}/feedback (AD). Read-only. */
export async function handleAdminGetFeedback(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, admin, params } = context
  const bookingId = params.bookingId

  if (bookingId === undefined) {
    // The slot's template always captures it.
    throw new Error('FEEDBACK_ROUTE_INVALID')
  }

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const row = await env.DB.prepare(SELECT_ADMIN_FEEDBACK_SQL)
    .bind(bookingId)
    .first<FeedbackRow>()

  if (!row) {
    return bookingNotFoundResponse()
  }

  return feedbackResponse(readFeedbackColumns(row))
}
