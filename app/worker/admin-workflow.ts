import {
  adminBookingActions,
  bookingStatuses,
  getAdminActionTargetStatus,
  type AdminBookingAction,
  type AdminBookingActionRequest,
  type AdminBookingNotesRequest,
  type AdminBookingNotesResponse,
  type BookingStatus,
} from '../shared/admin.js'
import { riyadhDateKey } from '../shared/timing.js'
import type { AuthenticatedAdmin } from './admin-auth.js'
import { errorResponse, readJsonBody } from './http.js'

/** Note lengths are counted in code points, as SQLite's length() counts. */
const MAXIMUM_ACTION_NOTE_LENGTH = 500
const MAXIMUM_ADMIN_NOTES_LENGTH = 2_000
/**
 * Body caps are in UTF-8 BYTES (inspection #14: the old 4,000 cap was
 * compared with the byte Content-Length, so ~1,990 Arabic characters, at two
 * bytes each, were already rejected). JSON.stringify spends at most 6 bytes
 * on one code point (a \uXXXX escape; Arabic takes 2, an emoji 4), so every
 * body a real client builds for a note within its limit fits: 500 × 6 + the
 * envelope < 4 KiB, and 2,000 × 6 + the envelope < 16 KiB. A body over its
 * cap can therefore only carry an over-long note, and gets that error.
 */
const MAXIMUM_ACTION_BODY_BYTES = 4_096
const MAXIMUM_NOTES_BODY_BYTES = 16_384
const APPROVAL_HOLD_DURATION_MILLISECONDS = 24 * 60 * 60 * 1_000

const actionBodyKeys: ReadonlySet<string> = new Set(['action', 'note'])
const notesBodyKeys: ReadonlySet<string> = new Set(['notes'])

interface BookingStateRow {
  id: string
  eventDate: string
  status: string
}

interface ExistenceRow {
  found: number
}

interface SavedNotesRow {
  adminNotes: string | null
  updatedAt: string
}

interface ParsedActionBody {
  action: AdminBookingAction
  note: string | null
}

type ActionBodyResult =
  | {
      ok: true
      value: ParsedActionBody
    }
  | {
      ok: false
      response: Response
    }

type NotesBodyResult =
  | {
      ok: true
      value: AdminBookingNotesRequest
    }
  | {
      ok: false
      response: Response
    }

export type AdminWorkflowResult =
  | {
      ok: true
      bookingId: string
      previousStatus: BookingStatus
      newStatus: BookingStatus
    }
  | {
      ok: false
      response: Response
    }

export type AdminNotesUpdateResult =
  | {
      ok: true
      responseBody: AdminBookingNotesResponse
    }
  | {
      ok: false
      response: Response
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return (
    typeof value === 'string' &&
    bookingStatuses.some((status) => status === value)
  )
}

function isAdminBookingAction(value: unknown): value is AdminBookingAction {
  return (
    typeof value === 'string' &&
    adminBookingActions.some((action) => action === value)
  )
}

function containsDisallowedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index)
    const isAllowedWhitespace =
      characterCode === 0x09 ||
      characterCode === 0x0a ||
      characterCode === 0x0d

    if (
      (!isAllowedWhitespace && characterCode <= 0x1f) ||
      (characterCode >= 0x7f && characterCode <= 0x9f)
    ) {
      return true
    }
  }

  return false
}

function invalidRequestBodyResponse(): Response {
  return errorResponse(
    400,
    'INVALID_REQUEST_BODY',
    'بيانات الطلب غير صحيحة.',
  )
}

function invalidActionResponse(): Response {
  return errorResponse(
    400,
    'INVALID_ACTION',
    'إجراء الحجز المطلوب غير صحيح.',
  )
}

function unsupportedMediaTypeResponse(): Response {
  return errorResponse(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'يجب إرسال بيانات الطلب بصيغة JSON.',
  )
}

function noteTooLongResponse(maximumLength: number): Response {
  return errorResponse(
    400,
    'NOTE_TOO_LONG',
    `يجب ألا يتجاوز نص الملاحظة ${maximumLength} حرفًا.`,
  )
}

function notesTooLongResponse(): Response {
  return errorResponse(
    400,
    'NOTES_TOO_LONG',
    `يجب ألا تتجاوز الملاحظات الداخلية ${MAXIMUM_ADMIN_NOTES_LENGTH} حرف.`,
  )
}

function countCodePoints(value: string): number {
  return Array.from(value).length
}

function bookingNotFoundResponse(): Response {
  return errorResponse(
    404,
    'BOOKING_NOT_FOUND',
    'لم يتم العثور على طلب الحجز.',
  )
}

function invalidTransitionResponse(): Response {
  return errorResponse(
    409,
    'INVALID_STATUS_TRANSITION',
    'لا يمكن تنفيذ هذا الإجراء من حالة الحجز الحالية.',
  )
}

function dateUnavailableResponse(): Response {
  return errorResponse(
    409,
    'DATE_UNAVAILABLE',
    'لا يمكن اعتماد الطلب لأن تاريخ المناسبة غير متاح.',
  )
}

function eventDatePassedResponse(): Response {
  return errorResponse(
    409,
    'EVENT_DATE_PASSED',
    'لا يمكن اعتماد الطلب لأن تاريخ المناسبة قد مضى.',
  )
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

async function parseActionBody(request: Request): Promise<ActionBodyResult> {
  const body = await readJsonBody(request, MAXIMUM_ACTION_BODY_BYTES)

  if (body.kind === 'unsupported-media-type') {
    return {
      ok: false,
      response: unsupportedMediaTypeResponse(),
    }
  }

  if (body.kind === 'too-large') {
    return {
      ok: false,
      response: noteTooLongResponse(MAXIMUM_ACTION_NOTE_LENGTH),
    }
  }

  const parsedBody = body.kind === 'parsed' ? body.value : null

  if (
    !isRecord(parsedBody) ||
    !hasOnlyKeys(parsedBody, actionBodyKeys) ||
    !Object.prototype.hasOwnProperty.call(parsedBody, 'action')
  ) {
    return {
      ok: false,
      response: invalidRequestBodyResponse(),
    }
  }

  if (!isAdminBookingAction(parsedBody.action)) {
    return {
      ok: false,
      response: invalidActionResponse(),
    }
  }

  const noteValue = parsedBody.note

  if (
    noteValue !== undefined &&
    typeof noteValue !== 'string'
  ) {
    return {
      ok: false,
      response: invalidRequestBodyResponse(),
    }
  }

  const note = typeof noteValue === 'string' ? noteValue.trim() : null

  if (note !== null && countCodePoints(note) > MAXIMUM_ACTION_NOTE_LENGTH) {
    return {
      ok: false,
      response: noteTooLongResponse(MAXIMUM_ACTION_NOTE_LENGTH),
    }
  }

  if (note !== null && containsDisallowedControlCharacter(note)) {
    return {
      ok: false,
      response: invalidRequestBodyResponse(),
    }
  }

  const value: AdminBookingActionRequest = {
    action: parsedBody.action,
    ...(note ? { note } : {}),
  }

  return {
    ok: true,
    value: {
      action: value.action,
      note: value.note ?? null,
    },
  }
}

async function parseNotesBody(request: Request): Promise<NotesBodyResult> {
  const body = await readJsonBody(request, MAXIMUM_NOTES_BODY_BYTES)

  if (body.kind === 'unsupported-media-type') {
    return {
      ok: false,
      response: unsupportedMediaTypeResponse(),
    }
  }

  if (body.kind === 'too-large') {
    return {
      ok: false,
      response: notesTooLongResponse(),
    }
  }

  const parsedBody = body.kind === 'parsed' ? body.value : null

  if (
    !isRecord(parsedBody) ||
    !hasOnlyKeys(parsedBody, notesBodyKeys) ||
    Object.keys(parsedBody).length !== notesBodyKeys.size ||
    typeof parsedBody.notes !== 'string'
  ) {
    return {
      ok: false,
      response: invalidRequestBodyResponse(),
    }
  }

  const notes = parsedBody.notes.trim()

  if (countCodePoints(notes) > MAXIMUM_ADMIN_NOTES_LENGTH) {
    return {
      ok: false,
      response: notesTooLongResponse(),
    }
  }

  if (containsDisallowedControlCharacter(notes)) {
    return {
      ok: false,
      response: invalidRequestBodyResponse(),
    }
  }

  return {
    ok: true,
    value: {
      notes,
    },
  }
}

async function loadBookingState(
  env: Env,
  bookingId: string,
): Promise<BookingStateRow | null> {
  return env.DB.prepare(
    `
      SELECT
        id,
        event_date AS eventDate,
        status
      FROM booking_requests
      WHERE id = ?
      LIMIT 1
    `,
  )
    .bind(bookingId)
    .first<BookingStateRow>()
}

async function isDateUnavailableForApproval(
  env: Env,
  eventDate: string,
  bookingId: string,
): Promise<boolean> {
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
        AND id <> ?
        AND status IN (
          'approved_hold',
          'contract_pending',
          'contract_signed',
          'payment_pending',
          'confirmed'
        )
      LIMIT 1
    `,
  ).bind(eventDate, bookingId)
  const [blockedDateResult, blockingBookingResult] =
    await env.DB.batch<ExistenceRow>([
      blockedDateStatement,
      blockingBookingStatement,
    ])

  return (
    blockedDateResult.results.length > 0 ||
    blockingBookingResult.results.length > 0
  )
}

async function resolveTransitionFailure(
  env: Env,
  bookingId: string,
  expectedStatus: BookingStatus,
  action: AdminBookingAction,
  riyadhToday: string,
): Promise<AdminWorkflowResult> {
  const currentBooking = await loadBookingState(env, bookingId)

  if (!currentBooking) {
    return {
      ok: false,
      response: bookingNotFoundResponse(),
    }
  }

  if (
    !isBookingStatus(currentBooking.status) ||
    currentBooking.status !== expectedStatus
  ) {
    return {
      ok: false,
      response: invalidTransitionResponse(),
    }
  }

  if (action === 'approve' && currentBooking.eventDate < riyadhToday) {
    return {
      ok: false,
      response: eventDatePassedResponse(),
    }
  }

  if (
    action === 'approve' &&
    (await isDateUnavailableForApproval(
      env,
      currentBooking.eventDate,
      bookingId,
    ))
  ) {
    return {
      ok: false,
      response: dateUnavailableResponse(),
    }
  }

  throw new Error('Admin booking transition failed')
}

export async function performAdminBookingAction(
  request: Request,
  env: Env,
  admin: AuthenticatedAdmin,
  bookingId: string,
): Promise<AdminWorkflowResult> {
  const parsedBody = await parseActionBody(request)

  if (!parsedBody.ok) {
    return parsedBody
  }

  const booking = await loadBookingState(env, bookingId)

  if (!booking) {
    return {
      ok: false,
      response: bookingNotFoundResponse(),
    }
  }

  if (!isBookingStatus(booking.status)) {
    throw new Error('Stored booking status is invalid')
  }

  const targetStatus = getAdminActionTargetStatus(
    booking.status,
    parsedBody.value.action,
  )

  if (!targetStatus) {
    return {
      ok: false,
      response: invalidTransitionResponse(),
    }
  }

  // Audit SEC-19: a request whose event date has passed is never approved
  // (checked here for the answer, and again inside the UPDATE for the race).
  const riyadhToday = riyadhDateKey()

  if (
    parsedBody.value.action === 'approve' &&
    booking.eventDate < riyadhToday
  ) {
    return {
      ok: false,
      response: eventDatePassedResponse(),
    }
  }

  if (
    parsedBody.value.action === 'approve' &&
    (await isDateUnavailableForApproval(env, booking.eventDate, bookingId))
  ) {
    return {
      ok: false,
      response: dateUnavailableResponse(),
    }
  }

  const transitionAt = new Date().toISOString()
  const holdExpiresAt = new Date(
    Date.now() + APPROVAL_HOLD_DURATION_MILLISECONDS,
  ).toISOString()
  const updateStatement = env.DB.prepare(
    `
      UPDATE booking_requests
      SET
        status = ?,
        hold_expires_at = CASE
          WHEN ? = 'approved_hold' THEN ?
          WHEN ? IN ('rejected', 'cancelled') THEN NULL
          ELSE hold_expires_at
        END,
        confirmed_at = CASE
          WHEN ? = 'confirmed' THEN ?
          ELSE confirmed_at
        END,
        updated_at = ?
      WHERE id = ?
        AND status = ?
        AND (
          ? <> 'approved_hold'
          OR (
            event_date >= ?
            AND NOT EXISTS (
              SELECT 1
              FROM blocked_dates
              WHERE event_date = ?
            )
            AND NOT EXISTS (
              SELECT 1
              FROM booking_requests AS conflicting_booking
              WHERE conflicting_booking.event_date = ?
                AND conflicting_booking.id <> ?
                AND conflicting_booking.status IN (
                  'approved_hold',
                  'contract_pending',
                  'contract_signed',
                  'payment_pending',
                  'confirmed'
                )
            )
          )
        )
    `,
  ).bind(
    targetStatus,
    targetStatus,
    holdExpiresAt,
    targetStatus,
    targetStatus,
    transitionAt,
    transitionAt,
    bookingId,
    booking.status,
    targetStatus,
    riyadhToday,
    booking.eventDate,
    booking.eventDate,
    bookingId,
  )
  const historyStatement = env.DB.prepare(
    `
      INSERT INTO booking_status_history (
        booking_id,
        from_status,
        to_status,
        changed_by,
        note,
        created_at
      )
      VALUES (
        ?,
        ?,
        CASE WHEN changes() = 1 THEN ? ELSE NULL END,
        ?,
        ?,
        ?
      )
    `,
  ).bind(
    bookingId,
    booking.status,
    targetStatus,
    admin.uid,
    parsedBody.value.note,
    transitionAt,
  )

  try {
    const results = await env.DB.batch([
      updateStatement,
      historyStatement,
    ])
    const updateChanges = results[0]?.meta.changes ?? 0
    const historyChanges = results[1]?.meta.changes ?? 0

    if (updateChanges !== 1 || historyChanges !== 1) {
      throw new Error('Admin transition batch was incomplete')
    }
  } catch {
    return resolveTransitionFailure(
      env,
      bookingId,
      booking.status,
      parsedBody.value.action,
      riyadhToday,
    )
  }

  return {
    ok: true,
    bookingId,
    previousStatus: booking.status,
    newStatus: targetStatus,
  }
}

export async function updateAdminBookingNotes(
  request: Request,
  env: Env,
  bookingId: string,
): Promise<AdminNotesUpdateResult> {
  const parsedBody = await parseNotesBody(request)

  if (!parsedBody.ok) {
    return parsedBody
  }

  const updatedAt = new Date().toISOString()
  const normalizedNotes = parsedBody.value.notes || null
  const result = await env.DB.prepare(
    `
      UPDATE booking_requests
      SET
        admin_notes = ?,
        updated_at = ?
      WHERE id = ?
    `,
  )
    .bind(normalizedNotes, updatedAt, bookingId)
    .run()

  if ((result.meta.changes ?? 0) === 0) {
    const booking = await loadBookingState(env, bookingId)

    if (!booking) {
      return {
        ok: false,
        response: bookingNotFoundResponse(),
      }
    }
  }

  const savedNotes = await env.DB.prepare(
    `
      SELECT
        admin_notes AS adminNotes,
        updated_at AS updatedAt
      FROM booking_requests
      WHERE id = ?
      LIMIT 1
    `,
  )
    .bind(bookingId)
    .first<SavedNotesRow>()

  if (!savedNotes) {
    return {
      ok: false,
      response: bookingNotFoundResponse(),
    }
  }

  return {
    ok: true,
    responseBody: {
      ok: true,
      bookingId,
      adminNotes: savedNotes.adminNotes,
      updatedAt: savedNotes.updatedAt,
    },
  }
}