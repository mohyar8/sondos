import {
  DEFAULT_EXTEND_HOURS,
  FLOW_TWO_HOLD_HOURS,
  FLOW_TWO_MINIMUM_LEAD_DAYS,
  MAXIMUM_EXTEND_HOURS,
  MINIMUM_EXTEND_HOURS,
  MINIMUM_OFFLINE_NOTE_CODE_POINTS,
  adminBookingActions,
  bookingStatuses,
  getAdminActionTargetStatus,
  getAdminActionTargetStatusForBooking,
  getAdminActionsForBooking,
  hasEventStarted,
  isAdminFlowVersion,
  isHoldOverdue,
  type AdminApprovalPreview,
  type AdminBookingAction,
  type AdminBookingFlowFacts,
  type AdminBookingNotesRequest,
  type AdminBookingNotesResponse,
  type AdminFlowVersion,
  type BookingStatus,
} from '../shared/admin.js'
import { computeDeposit } from '../shared/deposit.js'
import type { EmailTemplate } from '../shared/notifications.js'
import {
  countCodePoints,
  findPaymentInstructionLike,
  normalizeFreeText,
  toAsciiDigits,
  type FreeTextRule,
} from '../shared/text.js'
import {
  HOLD_GRACE_HOURS,
  TIMING,
  addDaysToDateKey,
  parseInstant,
  riyadhDateKey,
  riyadhStartOfDay,
} from '../shared/timing.js'
import type { AuthenticatedAdmin } from './admin-auth.js'
import {
  BRAND_NAME,
  WHATSAPP_NOTE,
  buildMyBookingDeepLinkUrl,
  formatEmailDate,
  formatEmailInstant,
  isolateLtrText,
  isolatePersonName,
  ltrValue,
  plainTextLink,
  renderEmailLayout,
  stripBidiControls,
} from './email-templates.js'
import { sanitizeFirstName } from './emails/hold.js'
import { errorResponse, readJsonBody } from './http.js'
import { expireOverdueHolds } from './jobs/hold-expiry.js'
import {
  LATEST_RECEIPT_STATUS_SQL,
  NOTICE_PROTECTED_COLUMN_SQL,
} from './jobs/hold-state.js'
import { outboxInsertStatement, prepareOutboxRow } from './notify/outbox.js'
import { requireRecentSignIn } from './recent-auth.js'
import {
  getReceiptChannel,
  onlineConfirmationUnavailableReason,
  resolveFeatures,
} from './settings/features.js'
import {
  ONLINE_CONFIRMATION_SWITCH_ON_SQL,
  effectiveRevisionIdSql,
  readSettingsSnapshot,
  readStudioContact,
  type SettingsSnapshot,
} from './settings/settings-read.js'

/**
 * The admin booking state machine (plan 11 §3.3 #18, #19; C-17, B1, H3,
 * TM-15, TM-20; SB-2, SB-3, SB-5, SB-9, SB-10).
 *
 * A row with flow_version 1 takes exactly the path it always took (N-29):
 * the legacy action map, the one UPDATE below with its date predicates,
 * the same history row and the same errors. Flow 2 begins only with
 * `approve`, and only when the online confirmation is offered: the env var
 * and the D1 kill switch are on, the deposit rule, the bank details and a
 * terms version exist, and the event is at least three Riyadh days away
 * (never a past date, SEC-19). From then on the row follows the flow-2 map
 * of shared/admin.ts, whose grace rules (B1) are re-checked here from the
 * Worker clock only, never from anything the client sent.
 *
 * Every transition is ONE D1 batch (one transaction): a conditional UPDATE
 * that repeats, inside the statement, the status, the flow, the deadline
 * it read (a compare-and-swap, TM-15), the event start, the settings
 * predicates and the date's freedom, followed by the status-history row
 * whose `CASE WHEN changes() = 1` guard fails the batch when the UPDATE
 * changed nothing. A failed batch commits nothing; the row is then re-read
 * to name the reason (409 with a fixed code), and any other outcome is an
 * error. Deadlines and amounts are whole numbers within their columns'
 * CHECKs; the customer's email address is read only to queue her email
 * and never logged.
 */

/** Note lengths are counted in code points, as SQLite's length() counts. */
const MAXIMUM_ACTION_NOTE_LENGTH = 500
const MAXIMUM_ADMIN_NOTES_LENGTH = 2_000
/**
 * Body caps are in UTF-8 BYTES (inspection #14: the old 4,000 cap was
 * compared with the byte Content-Length, so ~1,990 Arabic characters, at two
 * bytes each, were already rejected). JSON.stringify spends at most 6 bytes
 * on one code point (a \uXXXX escape; Arabic takes 2, an emoji 4), so every
 * body a real client builds for a note within its limit fits: 500 × 6 + the
 * envelope (the two numeric keys add under 60 bytes) < 4 KiB, and 2,000 × 6
 * + the envelope < 16 KiB. A body over its cap can therefore only carry an
 * over-long note, and gets that error.
 */
const MAXIMUM_ACTION_BODY_BYTES = 4_096
const MAXIMUM_NOTES_BODY_BYTES = 16_384
const APPROVAL_HOLD_DURATION_MILLISECONDS = 24 * 60 * 60 * 1_000
const HOUR_MILLISECONDS = 60 * 60 * 1_000
const HOLD_GRACE_MILLISECONDS = HOLD_GRACE_HOURS * HOUR_MILLISECONDS
/** A whole riyal amount or an hour count, as digits (UX-07): 1..99,999,999. */
const MAXIMUM_NUMBER_DIGITS = 8

const actionBodyKeys: ReadonlySet<string> = new Set([
  'action',
  'note',
  'extendHours',
  'depositAmount',
])
const notesBodyKeys: ReadonlySet<string> = new Set(['notes'])

/** The actions that take `depositAmount` (#18). */
const depositAmountActions: ReadonlySet<AdminBookingAction> = new Set<AdminBookingAction>([
  'confirm_payment',
  'confirm_offline',
])

/**
 * A flow-2 action note (SB-16): line breaks allowed, no invisible or bidi
 * characters, at most the history column's 500 code points; blank means
 * no note. Legacy rows keep the older check (N-29).
 */
const FLOW_TWO_NOTE_RULE: FreeTextRule = {
  kind: 'multi-line',
  maxCodePoints: MAXIMUM_ACTION_NOTE_LENGTH,
  minCodePoints: 0,
}

const HOLD_EXTENDED_SUBJECT_PREFIX = 'تم تمديد مهلة حجزكِ'
const HOLD_EXTENDED_LINK_FALLBACK_LABEL = 'إذا لم يعمل الزر، افتحي الرابط:'

/** The whole booking state a transition decides on, as one row. */
interface BookingStateRow {
  id: string
  eventDate: string
  status: string
  flowVersion: unknown
  holdExpiresAt: unknown
  termsAcceptedAt: unknown
  termsVersion: unknown
  depositAmount: unknown
  estimatedTotal: unknown
  latestReceiptStatus: unknown
  noticeProtected: unknown
  customerEmail: unknown
  customerFirstName: unknown
}

/** The same row, every column checked. */
interface BookingState {
  readonly id: string
  readonly eventDate: string
  readonly status: BookingStatus
  readonly flowVersion: AdminFlowVersion
  readonly holdExpiresAt: string | null
  readonly termsAcceptedAt: string | null
  readonly termsVersion: string | null
  readonly depositAmount: number | null
  readonly estimatedTotal: number
  readonly latestReceiptStatus: string | null
  readonly noticeProtected: boolean
  /** Null when no email may go to her (unproven or erased address, SEC-04). */
  readonly customerEmail: string | null
  readonly customerFirstName: string
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
  /** Only with `extend_hold`; the default when the key is left out. */
  extendHours: number | null
  /** Only with `confirm_payment` and `confirm_offline`. */
  depositAmount: number | null
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

/** The facts of a flow-2 approval its status email needs (W2-04 template). */
export interface FlowTwoApprovalFacts {
  readonly holdExpiresAt: string
  readonly depositAmount: number
}

export type AdminWorkflowResult =
  | {
      ok: true
      bookingId: string
      previousStatus: BookingStatus
      /** Equal to previousStatus for `extend_hold` (no status email then). */
      newStatus: BookingStatus
      /** The row's flow after the transition. */
      flowVersion: AdminFlowVersion
      /**
       * Set when the row now holds a flow-2 deadline she has to meet: an
       * `approve` that opened the online confirmation, or a `reinstate_hold`
       * (a fresh deadline, B1 #3). The caller sends the flow-2 approval
       * copy (B1 #5) instead of the generic status email.
       */
      flowTwoApproval: FlowTwoApprovalFacts | null
      /**
       * The batch itself queued an email to her in the outbox (the
       * `hold_extended` copy of `extend_hold`), so the caller sends no
       * status email and still reports that she was emailed.
       */
      outboxEmailQueued: boolean
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

/** What the transition's clock and calendar say, computed once per request. */
interface TransitionClock {
  readonly now: Date
  readonly nowIso: string
  readonly riyadhToday: string
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

/**
 * True for an instant in the exact `YYYY-MM-DDTHH:MM:SS.sssZ` form the
 * Worker writes, so the string comparisons in the SQL below agree with time
 * order.
 */
function isCanonicalInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    parseInstant(value)?.toISOString() === value
  )
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

function invalidExtendHoursResponse(): Response {
  return errorResponse(
    400,
    'INVALID_EXTEND_HOURS',
    `يجب أن تكون ساعات التمديد عددًا صحيحًا بين ${MINIMUM_EXTEND_HOURS} و${MAXIMUM_EXTEND_HOURS}.`,
  )
}

function invalidAmountResponse(): Response {
  return errorResponse(
    400,
    'INVALID_AMOUNT',
    'يجب إدخال مبلغ العربون المستلم بالريال كعدد صحيح لا يقل عن 1 ولا يتجاوز إجمالي الحجز.',
  )
}

function noteRequiredResponse(): Response {
  return errorResponse(
    400,
    'NOTE_REQUIRED',
    `هذا الإجراء يتطلب ملاحظة توضّح السبب (${MINIMUM_OFFLINE_NOTE_CODE_POINTS} أحرف على الأقل).`,
  )
}

function invalidTextResponse(): Response {
  return errorResponse(
    400,
    'INVALID_TEXT',
    'تحتوي الملاحظة على رموز غير مسموح بها.',
  )
}

function contentNotAllowedResponse(): Response {
  return errorResponse(
    400,
    'CONTENT_NOT_ALLOWED',
    'لا يجوز أن تحتوي الملاحظة على روابط أو أرقام حسابات أو أرقام جوال؛ تعليمات الدفع تُدخل في إعدادات الحساب البنكي فقط.',
  )
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

function dateNotFreeResponse(): Response {
  return errorResponse(
    409,
    'DATE_NOT_FREE',
    'تاريخ المناسبة محجوز بطلب آخر لا يزال ساريًا.',
  )
}

function eventDatePassedResponse(): Response {
  return errorResponse(
    409,
    'EVENT_DATE_PASSED',
    'لا يمكن اعتماد الطلب لأن تاريخ المناسبة قد مضى.',
  )
}

function eventStartedResponse(): Response {
  return errorResponse(
    409,
    'EVENT_DATE_PASSED',
    'بدأ يوم المناسبة، لذلك لم يعد تغيير الحجز المؤقت ممكنًا.',
  )
}

function gracePeriodOverResponse(): Response {
  return errorResponse(
    409,
    'GRACE_PERIOD_OVER',
    `انقضت فترة السماح (${HOLD_GRACE_HOURS} ساعة بعد المهلة)، فلم يعد التمديد أو تأكيد العربون ممكنًا لهذا الحجز.`,
  )
}

function holdBeyondEventResponse(): Response {
  return errorResponse(
    409,
    'HOLD_BEYOND_EVENT',
    'لا يمكن أن تتجاوز مهلة الحجز المؤقت بداية يوم المناسبة.',
  )
}

function holdNotOverdueResponse(): Response {
  return errorResponse(
    409,
    'HOLD_NOT_OVERDUE',
    'لم تنتهِ مهلة الحجز المؤقت بعد.',
  )
}

function termsNotAcceptedResponse(): Response {
  return errorResponse(
    409,
    'TERMS_NOT_ACCEPTED',
    'لم توافق العميلة على شروط الحجز بعد؛ استخدمي التأكيد اليدوي بعد تسجيل موافقتها.',
  )
}

function termsAlreadyAcceptedResponse(): Response {
  return errorResponse(
    409,
    'TERMS_ALREADY_ACCEPTED',
    'وافقت العميلة على الشروط إلكترونيًا؛ استخدمي تأكيد استلام العربون.',
  )
}

function settingsChangedResponse(): Response {
  return errorResponse(
    409,
    'SETTINGS_CHANGED',
    'تغيّرت إعدادات التأكيد الإلكتروني أثناء تنفيذ الإجراء. حدّثي التفاصيل ثم أعيدي المحاولة.',
  )
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

/**
 * A whole number from JSON: a safe integer, or a string of digits in any
 * script toAsciiDigits reads (UX-07), at most MAXIMUM_NUMBER_DIGITS long.
 * Null for anything else; the caller applies its own range.
 */
function readWholeNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null
  }

  if (typeof value !== 'string' || value.length > MAXIMUM_NUMBER_DIGITS * 4) {
    return null
  }

  const digits = toAsciiDigits(value.trim())

  return /^[0-9]{1,8}$/.test(digits) ? Number(digits) : null
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

  const { action } = parsedBody
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

  // A key that is not valid for the action is a malformed body (#18).
  const hasExtendHours = Object.prototype.hasOwnProperty.call(
    parsedBody,
    'extendHours',
  )
  const hasDepositAmount = Object.prototype.hasOwnProperty.call(
    parsedBody,
    'depositAmount',
  )

  if (
    (hasExtendHours && action !== 'extend_hold') ||
    (hasDepositAmount && !depositAmountActions.has(action))
  ) {
    return {
      ok: false,
      response: invalidRequestBodyResponse(),
    }
  }

  let extendHours: number | null = null

  if (action === 'extend_hold') {
    extendHours = hasExtendHours
      ? readWholeNumber(parsedBody.extendHours)
      : DEFAULT_EXTEND_HOURS

    if (
      extendHours === null ||
      extendHours < MINIMUM_EXTEND_HOURS ||
      extendHours > MAXIMUM_EXTEND_HOURS
    ) {
      return {
        ok: false,
        response: invalidExtendHoursResponse(),
      }
    }
  }

  let depositAmount: number | null = null

  if (hasDepositAmount) {
    depositAmount = readWholeNumber(parsedBody.depositAmount)

    // The upper bound (the booking's total) is applied once the row is read.
    if (depositAmount === null || depositAmount < 1) {
      return {
        ok: false,
        response: invalidAmountResponse(),
      }
    }
  }

  return {
    ok: true,
    value: {
      action,
      note: note || null,
      extendHours,
      depositAmount,
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

// ---------------------------------------------------------------------------
// Reading the row
// ---------------------------------------------------------------------------

// ?1 booking id. The latest receipt and the notice protection come from the
// hold jobs' constant fragments (alias b), so every reader agrees.
const BOOKING_STATE_SQL = `
  SELECT
    b.id AS id,
    b.event_date AS eventDate,
    b.status AS status,
    b.flow_version AS flowVersion,
    b.hold_expires_at AS holdExpiresAt,
    b.terms_accepted_at AS termsAcceptedAt,
    b.terms_version AS termsVersion,
    b.deposit_amount AS depositAmount,
    b.estimated_total AS estimatedTotal,
    ${LATEST_RECEIPT_STATUS_SQL} AS latestReceiptStatus,
    ${NOTICE_PROTECTED_COLUMN_SQL} AS noticeProtected,
    CASE WHEN u.erased_at IS NULL AND u.email_verified_at IS NOT NULL THEN u.email END AS customerEmail,
    CASE WHEN u.erased_at IS NULL THEN u.first_name END AS customerFirstName
  FROM booking_requests AS b
  LEFT JOIN users AS u ON u.id = b.user_id
  WHERE b.id = ?1
  LIMIT 1
`

function readOptionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * The stored row, every column checked (D1 rows are a trust boundary). A
 * column outside its CHECK is a broken database, not a request error, and
 * throws like the status check always did.
 */
function readBookingState(row: BookingStateRow): BookingState {
  const {
    flowVersion,
    holdExpiresAt,
    termsAcceptedAt,
    depositAmount,
    estimatedTotal,
    noticeProtected,
  } = row

  if (!isBookingStatus(row.status)) {
    throw new Error('Stored booking status is invalid')
  }

  if (
    !isAdminFlowVersion(flowVersion) ||
    (holdExpiresAt !== null && typeof holdExpiresAt !== 'string') ||
    (termsAcceptedAt !== null && !isCanonicalInstant(termsAcceptedAt)) ||
    (depositAmount !== null && !Number.isSafeInteger(depositAmount)) ||
    typeof estimatedTotal !== 'number' ||
    !Number.isSafeInteger(estimatedTotal) ||
    (noticeProtected !== 0 && noticeProtected !== 1)
  ) {
    throw new Error('Stored booking row is invalid')
  }

  return {
    id: row.id,
    eventDate: row.eventDate,
    status: row.status,
    flowVersion,
    holdExpiresAt: readOptionalText(holdExpiresAt),
    termsAcceptedAt: readOptionalText(termsAcceptedAt),
    termsVersion: readOptionalText(row.termsVersion),
    depositAmount: typeof depositAmount === 'number' ? depositAmount : null,
    estimatedTotal,
    latestReceiptStatus: readOptionalText(row.latestReceiptStatus),
    noticeProtected: noticeProtected === 1,
    customerEmail: readOptionalText(row.customerEmail),
    customerFirstName: readOptionalText(row.customerFirstName) ?? '',
  }
}

async function loadBookingState(
  env: Env,
  bookingId: string,
): Promise<BookingState | null> {
  const row = await env.DB.prepare(BOOKING_STATE_SQL)
    .bind(bookingId)
    .first<BookingStateRow>()

  return row === null ? null : readBookingState(row)
}

/** The facts the flow maps decide on (shared/admin.ts), from a row and a clock. */
export function buildAdminFlowFacts(
  row: {
    readonly status: BookingStatus
    readonly flowVersion: AdminFlowVersion
    readonly eventDate: string
    readonly holdExpiresAt: string | null
    readonly termsAcceptedAt: string | null
    readonly latestReceiptStatus: string | null
  },
  now: Date,
): AdminBookingFlowFacts {
  const eventStart = riyadhStartOfDay(row.eventDate)

  return {
    status: row.status,
    flowVersion: row.flowVersion,
    termsAccepted: row.termsAcceptedAt !== null,
    holdExpiresAtMs: parseInstant(row.holdExpiresAt)?.getTime() ?? null,
    latestReceiptStatus: row.latestReceiptStatus,
    eventStartMs: eventStart === null ? null : Date.parse(eventStart),
    nowMs: now.getTime(),
  }
}

function makeClock(): TransitionClock {
  const now = new Date()

  return {
    now,
    nowIso: now.toISOString(),
    riyadhToday: riyadhDateKey(now),
  }
}

// ---------------------------------------------------------------------------
// The approval preview (#17) and the flow decision of `approve`
// ---------------------------------------------------------------------------

/**
 * What `approve` will do to a `pending_review` row, from the settings in
 * force at `now` and the Worker calendar (§3.3 #17 approvalPreview). The
 * first reason found wins, in the order the customer-facing rules apply:
 * a past date is never approved (SEC-19), then the switches and settings
 * (features.ts), then the three-day lead, then a computable deposit. The
 * approve UPDATE re-checks every part inside the statement.
 */
export function computeApprovalPreview(
  env: Env,
  snapshot: SettingsSnapshot,
  booking: {
    readonly eventDate: string
    readonly estimatedTotal: number
  },
  now: Date,
): AdminApprovalPreview {
  const riyadhToday = riyadhDateKey(now)

  if (booking.eventDate < riyadhToday) {
    return { flowVersion: 1, reason: 'EVENT_PASSED' }
  }

  const features = resolveFeatures(env, snapshot)
  const reason = onlineConfirmationUnavailableReason(features.onlineConfirmation)

  if (reason !== null) {
    return { flowVersion: 1, reason }
  }

  const earliestFlowTwoDate = addDaysToDateKey(
    riyadhToday,
    FLOW_TWO_MINIMUM_LEAD_DAYS,
  )

  if (earliestFlowTwoDate === null || booking.eventDate < earliestFlowTwoDate) {
    return { flowVersion: 1, reason: 'EVENT_TOO_SOON' }
  }

  const deposit = snapshot.effective.deposit

  // Unreachable after the reason check; it narrows the type without a cast.
  if (deposit === null) {
    return { flowVersion: 1, reason: 'SETTINGS_INCOMPLETE' }
  }

  const depositAmount = computeDeposit(deposit.rule, booking.estimatedTotal)

  // A zero deposit (a zero total) has nothing to confirm online.
  if (depositAmount < 1) {
    return { flowVersion: 1, reason: 'SETTINGS_INCOMPLETE' }
  }

  return {
    flowVersion: 2,
    depositAmount,
    holdHours: FLOW_TWO_HOLD_HOURS,
  }
}

/** min(now + 48 h, event start) as the canonical instant the row stores. */
function flowTwoHoldDeadline(nowMs: number, eventStartMs: number): string {
  return new Date(Math.min(nowMs + TIMING.holdWindowMs, eventStartMs)).toISOString()
}

// ---------------------------------------------------------------------------
// Legacy (flow 1) path: unchanged behaviour (N-29)
// ---------------------------------------------------------------------------

async function isDateBlocked(env: Env, eventDate: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `
      SELECT 1 AS found
      FROM blocked_dates
      WHERE event_date = ?
      LIMIT 1
    `,
  )
    .bind(eventDate)
    .first<ExistenceRow>()

  return row !== null
}

async function isDateHeldByAnotherBooking(
  env: Env,
  eventDate: string,
  bookingId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
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
  )
    .bind(eventDate, bookingId)
    .first<ExistenceRow>()

  return row !== null
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

async function resolveLegacyTransitionFailure(
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

  if (currentBooking.status !== expectedStatus) {
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

/**
 * The transition of a flow-1 row, exactly as before flow 2 (N-29): the
 * legacy map, the 24 h hold, the date predicates inside the UPDATE (SEC-19)
 * and the guarded history row.
 */
async function performLegacyTransition(
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  body: ParsedActionBody,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const targetStatus = getAdminActionTargetStatus(booking.status, body.action)

  if (!targetStatus) {
    return {
      ok: false,
      response: invalidTransitionResponse(),
    }
  }

  // Audit SEC-19: a request whose event date has passed is never approved
  // (checked here for the answer, and again inside the UPDATE for the race).
  const { riyadhToday } = clock

  if (body.action === 'approve' && booking.eventDate < riyadhToday) {
    return {
      ok: false,
      response: eventDatePassedResponse(),
    }
  }

  if (
    body.action === 'approve' &&
    (await isDateUnavailableForApproval(env, booking.eventDate, booking.id))
  ) {
    return {
      ok: false,
      response: dateUnavailableResponse(),
    }
  }

  const transitionAt = clock.nowIso
  const holdExpiresAt = new Date(
    clock.now.getTime() + APPROVAL_HOLD_DURATION_MILLISECONDS,
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
    booking.id,
    booking.status,
    targetStatus,
    riyadhToday,
    booking.eventDate,
    booking.eventDate,
    booking.id,
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
    booking.id,
    booking.status,
    targetStatus,
    admin.uid,
    body.note,
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
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }

    return resolveLegacyTransitionFailure(
      env,
      booking.id,
      booking.status,
      body.action,
      riyadhToday,
    )
  }

  return {
    ok: true,
    bookingId: booking.id,
    previousStatus: booking.status,
    newStatus: targetStatus,
    flowVersion: booking.flowVersion,
    flowTwoApproval: null,
    outboxEmailQueued: false,
  }
}

// ---------------------------------------------------------------------------
// Flow-2 SQL (constant text; every value bound, SB-4)
// ---------------------------------------------------------------------------

/**
 * The status-history row after a status UPDATE: to_status is NULL when the
 * UPDATE changed nothing, which fails NOT NULL and rolls the batch back.
 * ?1 booking id | ?2 from | ?3 to | ?4 admin uid | ?5 note | ?6 now
 */
const HISTORY_SQL = `
  INSERT INTO booking_status_history (
    booking_id,
    from_status,
    to_status,
    changed_by,
    note,
    created_at
  )
  VALUES (?1, ?2, CASE WHEN changes() = 1 THEN ?3 END, ?4, ?5, ?6)
`

/**
 * An admin booking event after a guarded statement (SB-10). Runs third in a
 * batch, after the history row proved the UPDATE changed one row. The kind
 * is a foreign key into event_kinds: a database without it (migrations not
 * applied) fails the whole batch rather than committing a transition that
 * leaves no event behind.
 * ?1 booking id | ?2 admin uid | ?3 kind | ?4 details JSON | ?5 note | ?6 now
 */
const ADMIN_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, note, created_at)
  VALUES (?1, 'admin', ?2, ?3, ?4, ?5, ?6)
`

/**
 * The same event as the FIRST statement after an UPDATE that changes no
 * status (`extend_hold`): its kind is NULL when the UPDATE changed nothing,
 * which fails NOT NULL and rolls the batch back.
 */
const GUARDED_ADMIN_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, note, created_at)
  VALUES (?1, 'admin', ?2, CASE WHEN changes() = 1 THEN ?3 END, ?4, ?5, ?6)
`

/**
 * Pending hold reminders keyed on the old deadline are superseded whenever
 * the deadline or the status changes (the reminders job re-plans them for a
 * new deadline). ?1 booking id | ?2 now
 */
const SUPERSEDE_REMINDERS_SQL = `
  UPDATE notification_log
  SET status = 'superseded',
      recipient = NULL,
      payload = NULL,
      finished_at = ?2,
      updated_at = ?2
  WHERE booking_id = ?1
    AND status = 'pending'
    AND kind IN ('hold_reminder_24h', 'hold_reminder_6h')
`

const BLOCKING_STATUSES_SQL = `(
  'approved_hold',
  'contract_pending',
  'contract_signed',
  'payment_pending',
  'confirmed'
)`

/**
 * `approve` into flow 2. The date predicates of the legacy UPDATE, then
 * the flow-2 ones (E4): the deposit rule the Worker priced with is still
 * the effective one at ?6 (SETTINGS_CHANGED otherwise), effective bank
 * details and a terms version exist, and the kill switch is on (H3). A
 * notice-protected hold on the date is a conflicting booking here, so it
 * refuses the approval (DATE_NOT_FREE, N-30b).
 * ?1 booking id | ?2 event date | ?3 deposit amount | ?4 deposit rule id
 * ?5 hold deadline | ?6 now | ?7 Riyadh today
 */
const APPROVE_FLOW_TWO_SQL = `
  UPDATE booking_requests AS b
  SET status = 'approved_hold',
      flow_version = 2,
      deposit_amount = ?3,
      deposit_rule_revision_id = ?4,
      hold_expires_at = ?5,
      updated_at = ?6
  WHERE b.id = ?1
    AND b.status = 'pending_review'
    AND b.event_date = ?2
    AND b.event_date >= ?7
    AND ?3 BETWEEN 1 AND b.estimated_total
    AND NOT EXISTS (
      SELECT 1 FROM blocked_dates WHERE event_date = ?2
    )
    AND NOT EXISTS (
      SELECT 1
      FROM booking_requests AS conflicting_booking
      WHERE conflicting_booking.event_date = ?2
        AND conflicting_booking.id <> ?1
        AND conflicting_booking.status IN ${BLOCKING_STATUSES_SQL}
    )
    AND ?4 = ${effectiveRevisionIdSql('deposit', '?6')}
    AND ${effectiveRevisionIdSql('bank', '?6')} IS NOT NULL
    AND EXISTS (SELECT 1 FROM terms_versions)
    AND ${ONLINE_CONFIRMATION_SWITCH_ON_SQL}
`

/**
 * `extend_hold`: a compare-and-swap on the status and the exact deadline
 * read (TM-15), while the grace lasts (deadline > now − G) and the new
 * deadline is before the event start. On payment_pending only after a
 * rejected receipt.
 * ?1 booking id | ?2 status read | ?3 new deadline | ?4 now
 * ?5 deadline read | ?6 grace cutoff (now − G) | ?7 event start
 */
const EXTEND_HOLD_SQL = `
  UPDATE booking_requests AS b
  SET hold_expires_at = ?3,
      updated_at = ?4
  WHERE b.id = ?1
    AND b.flow_version = 2
    AND b.status = ?2
    AND b.hold_expires_at = ?5
    AND b.hold_expires_at > ?6
    AND ?3 > b.hold_expires_at
    AND ?3 < ?7
    AND (
      b.status = 'approved_hold'
      OR (
        b.status = 'payment_pending'
        AND ${LATEST_RECEIPT_STATUS_SQL} = 'rejected'
      )
    )
`

/**
 * `expire_hold` (B1 #4): the admin's own expiry of an overdue hold, notice
 * protection or not (a deliberate, audited decision; only the jobs honour
 * the protection). ?1 booking id | ?2 deadline read | ?3 now
 */
const EXPIRE_HOLD_SQL = `
  UPDATE booking_requests AS b
  SET status = 'expired',
      updated_at = ?3
  WHERE b.id = ?1
    AND b.flow_version = 2
    AND b.status = 'approved_hold'
    AND b.hold_expires_at = ?2
    AND b.hold_expires_at <= ?3
`

/**
 * `reinstate_hold` (B1 #3): back to approved_hold with a fresh deadline
 * while the event has not started and the date is not blocked. Another
 * blocking booking on the date fails ux_booking_requets_blocking_event_date
 * (the partial unique index), which rolls the batch back: DATE_NOT_FREE.
 * ?1 booking id | ?2 event date | ?3 new deadline | ?4 now | ?5 event start
 */
const REINSTATE_HOLD_SQL = `
  UPDATE booking_requests AS b
  SET status = 'approved_hold',
      hold_expires_at = ?3,
      updated_at = ?4
  WHERE b.id = ?1
    AND b.flow_version = 2
    AND b.status = 'expired'
    AND b.event_date = ?2
    AND ?4 < ?5
    AND NOT EXISTS (
      SELECT 1 FROM blocked_dates WHERE event_date = ?2
    )
`

/**
 * `confirm_payment` on flow 2 (TM-20): the amount seen in the bank
 * statement, 1..the total (the column CHECK repeated so a wrong amount is
 * a refused row, never a thrown CHECK). From approved_hold only with the
 * terms accepted, the deadline read unchanged, within the grace and before
 * the event start; from payment_pending as it is.
 * ?1 booking id | ?2 status read | ?3 amount | ?4 now | ?5 deadline read
 * ?6 grace cutoff | ?7 event start
 */
const CONFIRM_PAYMENT_FLOW_TWO_SQL = `
  UPDATE booking_requests AS b
  SET status = 'confirmed',
      confirmed_at = ?4,
      deposit_received_amount = ?3,
      deposit_received_at = ?4,
      updated_at = ?4
  WHERE b.id = ?1
    AND b.flow_version = 2
    AND b.status = ?2
    AND ?3 BETWEEN 1 AND b.estimated_total
    AND (
      b.status = 'payment_pending'
      OR (
        b.status = 'approved_hold'
        AND b.terms_accepted_at IS NOT NULL
        AND b.hold_expires_at = ?5
        AND b.hold_expires_at > ?6
        AND ?4 < ?7
      )
    )
`

/**
 * `confirm_offline` (H3): records the terms acceptance the admin took on
 * WhatsApp against the CURRENT terms version (re-read inside: SETTINGS_
 * CHANGED when it moved) and the deposit, on a hold whose terms were not
 * accepted online, before the event start.
 * ?1 booking id | ?2 deadline read | ?3 amount | ?4 now | ?5 terms version
 * ?6 event start
 */
const CONFIRM_OFFLINE_SQL = `
  UPDATE booking_requests AS b
  SET status = 'confirmed',
      confirmed_at = ?4,
      terms_version = ?5,
      terms_accepted_at = ?4,
      deposit_received_amount = ?3,
      deposit_received_at = ?4,
      updated_at = ?4
  WHERE b.id = ?1
    AND b.flow_version = 2
    AND b.status = 'approved_hold'
    AND b.terms_accepted_at IS NULL
    AND b.hold_expires_at = ?2
    AND ?3 BETWEEN 1 AND b.estimated_total
    AND ?4 < ?6
    AND ?5 = (SELECT version FROM terms_versions ORDER BY seq DESC LIMIT 1)
`

/** `cancel` on flow 2, from any of its live statuses. ?1 id | ?2 status read | ?3 now */
const CANCEL_FLOW_TWO_SQL = `
  UPDATE booking_requests AS b
  SET status = 'cancelled',
      hold_expires_at = NULL,
      updated_at = ?3
  WHERE b.id = ?1
    AND b.flow_version = 2
    AND b.status = ?2
`

// ---------------------------------------------------------------------------
// Flow-2 helpers
// ---------------------------------------------------------------------------

function historyStatement(
  env: Env,
  booking: BookingState,
  toStatus: BookingStatus,
  admin: AuthenticatedAdmin,
  note: string | null,
  nowIso: string,
): D1PreparedStatement {
  return env.DB.prepare(HISTORY_SQL).bind(
    booking.id,
    booking.status,
    toStatus,
    admin.uid,
    note,
    nowIso,
  )
}

function adminEventStatement(
  env: Env,
  sql: string,
  booking: BookingState,
  admin: AuthenticatedAdmin,
  kind: string,
  details: Record<string, string | number>,
  note: string | null,
  nowIso: string,
): D1PreparedStatement {
  return env.DB.prepare(sql).bind(
    booking.id,
    admin.uid,
    kind,
    JSON.stringify(details),
    note,
    nowIso,
  )
}

function supersedeRemindersStatement(
  env: Env,
  booking: BookingState,
  nowIso: string,
): D1PreparedStatement {
  return env.DB.prepare(SUPERSEDE_REMINDERS_SQL).bind(booking.id, nowIso)
}

/**
 * Runs one transition batch and checks that its first two statements each
 * changed exactly one row. Returns false when the batch threw or came back
 * incomplete (nothing committed in either case), so the caller can re-read
 * the row and name the reason.
 */
async function runGuardedBatch(
  env: Env,
  statements: readonly D1PreparedStatement[],
): Promise<boolean> {
  try {
    const results = await env.DB.batch([...statements])
    const firstChanges = results[0]?.meta.changes ?? 0
    const secondChanges = results[1]?.meta.changes ?? 0

    if (firstChanges !== 1 || secondChanges !== 1) {
      throw new Error('Admin transition batch was incomplete')
    }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }

    return false
  }

  return true
}

/**
 * Why a flow-2 action is not offered right now (409 with the rule that
 * refused it), for an action the map of shared/admin.ts left out.
 */
function refuseFlowTwoAction(
  facts: AdminBookingFlowFacts,
  action: AdminBookingAction,
): Response {
  const graceRefusal = hasEventStarted(facts)
    ? eventStartedResponse()
    : gracePeriodOverResponse()

  switch (action) {
    case 'extend_hold':
      if (
        facts.status === 'approved_hold' ||
        (facts.status === 'payment_pending' &&
          facts.latestReceiptStatus === 'rejected')
      ) {
        return hasEventStarted(facts)
          ? holdBeyondEventResponse()
          : gracePeriodOverResponse()
      }

      return invalidTransitionResponse()
    case 'confirm_payment':
      if (facts.status === 'approved_hold') {
        return facts.termsAccepted ? graceRefusal : termsNotAcceptedResponse()
      }

      return invalidTransitionResponse()
    case 'confirm_offline':
      if (facts.status === 'approved_hold') {
        return facts.termsAccepted
          ? termsAlreadyAcceptedResponse()
          : eventStartedResponse()
      }

      return invalidTransitionResponse()
    case 'expire_hold':
      return facts.status === 'approved_hold' && !isHoldOverdue(facts)
        ? holdNotOverdueResponse()
        : invalidTransitionResponse()
    case 'reinstate_hold':
      return facts.status === 'expired'
        ? eventStartedResponse()
        : invalidTransitionResponse()
    default:
      return invalidTransitionResponse()
  }
}

/**
 * The flow-2 state a transition needs, checked once: the row is flow 2,
 * its deadline (when it has one) is canonical, and its event start is
 * computable. A row that fails is a broken database.
 */
interface FlowTwoHold {
  readonly holdExpiresAt: string
  readonly holdExpiresAtMs: number
  readonly eventStart: string
  readonly eventStartMs: number
}

function readFlowTwoHold(booking: BookingState): FlowTwoHold {
  const eventStart = riyadhStartOfDay(booking.eventDate)

  if (
    booking.flowVersion !== 2 ||
    !isCanonicalInstant(booking.holdExpiresAt) ||
    eventStart === null
  ) {
    throw new Error('Stored flow-2 hold is invalid')
  }

  return {
    holdExpiresAt: booking.holdExpiresAt,
    holdExpiresAtMs: Date.parse(booking.holdExpiresAt),
    eventStart,
    eventStartMs: Date.parse(eventStart),
  }
}

function graceCutoff(clock: TransitionClock): string {
  return new Date(clock.now.getTime() - HOLD_GRACE_MILLISECONDS).toISOString()
}

type FlowTwoNoteResult =
  | { ok: true; note: string | null }
  | { ok: false; response: Response }

/**
 * The note of a flow-2 action (SB-16), and for `confirm_offline` the
 * content rules of every admin text that can reach her (SB-17, TM-04): at
 * least MINIMUM_OFFLINE_NOTE_CODE_POINTS, and no link, handle, IBAN or
 * account or phone number other than the studio's own.
 */
function checkFlowTwoNote(
  note: string | null,
  action: AdminBookingAction,
  studioDigits: string | null,
): FlowTwoNoteResult {
  const normalized = normalizeFreeText(note ?? '', FLOW_TWO_NOTE_RULE)

  if (!normalized.ok) {
    switch (normalized.problem) {
      case 'too-long':
        return { ok: false, response: noteTooLongResponse(MAXIMUM_ACTION_NOTE_LENGTH) }
      case 'not-text':
        return { ok: false, response: invalidRequestBodyResponse() }
      case 'empty':
      case 'too-short':
      case 'forbidden-character':
      case 'link-or-handle':
        return { ok: false, response: invalidTextResponse() }
    }
  }

  const value = normalized.value.length === 0 ? null : normalized.value

  if (action !== 'confirm_offline') {
    return { ok: true, note: value }
  }

  if (value === null || countCodePoints(value) < MINIMUM_OFFLINE_NOTE_CODE_POINTS) {
    return { ok: false, response: noteRequiredResponse() }
  }

  if (findPaymentInstructionLike(value, studioDigits) !== null) {
    return { ok: false, response: contentNotAllowedResponse() }
  }

  return { ok: true, note: value }
}

/**
 * A failed flow-2 batch: the row is re-read and the reason named. The
 * status or deadline moved under the request (a customer step, the cron,
 * another admin tab): INVALID_STATUS_TRANSITION, which makes the SPA
 * refresh. `reinstate_hold` names the date's occupant instead; `confirm_
 * offline` names a terms version that moved. Anything else is an error.
 */
async function resolveFlowTwoFailure(
  env: Env,
  booking: BookingState,
  action: AdminBookingAction,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const current = await loadBookingState(env, booking.id)

  if (!current) {
    return { ok: false, response: bookingNotFoundResponse() }
  }

  if (
    current.status !== booking.status ||
    current.holdExpiresAt !== booking.holdExpiresAt ||
    current.termsAcceptedAt !== booking.termsAcceptedAt
  ) {
    return { ok: false, response: invalidTransitionResponse() }
  }

  const facts = buildAdminFlowFacts(current, clock.now)

  if (!getAdminActionsForBooking(facts).includes(action)) {
    return { ok: false, response: refuseFlowTwoAction(facts, action) }
  }

  if (action === 'reinstate_hold') {
    if (await isDateBlocked(env, current.eventDate)) {
      return { ok: false, response: dateUnavailableResponse() }
    }

    if (await isDateHeldByAnotherBooking(env, current.eventDate, current.id)) {
      return { ok: false, response: dateNotFreeResponse() }
    }
  }

  if (action === 'confirm_offline') {
    return { ok: false, response: settingsChangedResponse() }
  }

  throw new Error('Admin booking transition failed')
}

// ---------------------------------------------------------------------------
// The hold-extended email (queued in the outbox with the batch)
// ---------------------------------------------------------------------------

interface HoldExtendedEmailInput {
  readonly customerFirstName: string
  readonly bookingId: string
  readonly eventDate: string
  readonly holdExpiresAt: string
  readonly appBaseUrl: string | undefined
}

/**
 * The `hold_extended` email: the new deadline in Riyadh time and where to
 * finish (the other hold emails live in worker/emails/hold.ts, W2-03).
 * Every string reaches the HTML through renderEmailLayout, which escapes
 * it (SB-6); no bank details. Null when the deadline is not renderable.
 */
function renderHoldExtendedEmail(
  input: HoldExtendedEmailInput,
): EmailTemplate | null {
  const deadline = formatEmailInstant(input.holdExpiresAt)

  if (deadline === null) {
    return null
  }

  const name = isolatePersonName(sanitizeFirstName(input.customerFirstName))
  const greeting = name.length > 0 ? `أهلًا ${name}،` : 'أهلًا،'
  const intro = `${greeting} مدّدنا لكِ مهلة إكمال حجزكِ المبدئي حتى ${deadline}.`
  const eventDate = formatEmailDate(input.eventDate)
  const deepLink = buildMyBookingDeepLinkUrl(input.appBaseUrl, input.bookingId)
  const body =
    'أكملي الخطوات المتبقية من صفحة حجوزاتي قبل الموعد الجديد: الموافقة على شروط الحجز ثم تحويل العربون وإرسال إشعار التحويل. إذا انتهت المهلة الجديدة دون ذلك، قد يُلغى الحجز المبدئي ويصبح التاريخ متاحًا للطلبات الأخرى.'
  const text = [
    BRAND_NAME,
    '',
    intro,
    '',
    `رقم الطلب: ${isolateLtrText(input.bookingId)}`,
    `تاريخ المناسبة: ${eventDate}`,
    `تنتهي المهلة الجديدة في: ${deadline}`,
    '',
    body,
    '',
    ...(deepLink === null
      ? ['يمكنكِ إكمال حجزكِ من صفحة حجوزاتي في موقعنا.']
      : ['أكملي حجزكِ من صفحة حجوزاتي:', plainTextLink(deepLink)]),
    '',
    WHATSAPP_NOTE,
  ].join('\n')

  return {
    subject: `${HOLD_EXTENDED_SUBJECT_PREFIX} — ${stripBidiControls(input.bookingId).trim()}`,
    text,
    html: renderEmailLayout({
      heading: HOLD_EXTENDED_SUBJECT_PREFIX,
      intro,
      summaryRows: [
        ['رقم الطلب', ltrValue(input.bookingId)],
        ['تاريخ المناسبة', eventDate],
        ['تنتهي المهلة الجديدة في', deadline],
      ],
      body,
      actionUrl: deepLink,
      actionLabel: 'أكملي حجزكِ',
      linkFallbackLabel: HOLD_EXTENDED_LINK_FALLBACK_LABEL,
    }),
  }
}

/** The outbox INSERT for the hold-extended email, or null with a fixed code. */
function holdExtendedOutboxStatement(
  env: Env,
  booking: BookingState,
  holdExpiresAt: string,
  nowIso: string,
): D1PreparedStatement | null {
  if (booking.customerEmail === null) {
    console.warn('HOLD_EXTENDED_EMAIL_NOT_QUEUED code=NO_RECIPIENT')

    return null
  }

  const template = renderHoldExtendedEmail({
    customerFirstName: booking.customerFirstName,
    bookingId: booking.id,
    eventDate: booking.eventDate,
    holdExpiresAt,
    appBaseUrl: env.APP_BASE_URL,
  })

  if (template === null) {
    console.warn('HOLD_EXTENDED_EMAIL_NOT_QUEUED code=UNRENDERABLE')

    return null
  }

  const prepared = prepareOutboxRow({
    ...template,
    kind: 'hold_extended',
    bookingId: booking.id,
    anchor: holdExpiresAt,
    recipient: booking.customerEmail,
  })

  if (!prepared.ok) {
    console.warn(`HOLD_EXTENDED_EMAIL_NOT_QUEUED code=${prepared.code}`)

    return null
  }

  return outboxInsertStatement(env.DB, prepared.row, nowIso)
}

// ---------------------------------------------------------------------------
// Flow-2 transitions
// ---------------------------------------------------------------------------

/**
 * `approve` when the online confirmation is offered: the targeted sweep of
 * stale flow-2 holds on the date first (worker/jobs/hold-expiry.ts: only
 * while AX is on, never a notice-protected hold, N-30b), then the one
 * batch of APPROVE_FLOW_TWO_SQL and its guarded history row.
 */
async function performFlowTwoApproval(
  request: Request,
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  body: ParsedActionBody,
  clock: TransitionClock,
  snapshot: SettingsSnapshot,
  preview: Extract<AdminApprovalPreview, { flowVersion: 2 }>,
): Promise<AdminWorkflowResult> {
  const deposit = snapshot.effective.deposit
  const eventStart = riyadhStartOfDay(booking.eventDate)

  if (deposit === null || eventStart === null) {
    throw new Error('Flow-2 approval facts are missing')
  }

  await expireOverdueHolds(env, {
    nowIso: clock.nowIso,
    signal: request.signal,
    appBaseUrl: env.APP_BASE_URL,
    eventDate: booking.eventDate,
  })

  if (await isDateBlocked(env, booking.eventDate)) {
    return { ok: false, response: dateUnavailableResponse() }
  }

  if (await isDateHeldByAnotherBooking(env, booking.eventDate, booking.id)) {
    return { ok: false, response: dateNotFreeResponse() }
  }

  const holdExpiresAt = flowTwoHoldDeadline(
    clock.now.getTime(),
    Date.parse(eventStart),
  )
  const approveStatement = env.DB.prepare(APPROVE_FLOW_TWO_SQL).bind(
    booking.id,
    booking.eventDate,
    preview.depositAmount,
    deposit.revisionId,
    holdExpiresAt,
    clock.nowIso,
    clock.riyadhToday,
  )
  const committed = await runGuardedBatch(env, [
    approveStatement,
    historyStatement(env, booking, 'approved_hold', admin, body.note, clock.nowIso),
  ])

  if (!committed) {
    return resolveFlowTwoApprovalFailure(env, booking, clock, deposit.revisionId)
  }

  return {
    ok: true,
    bookingId: booking.id,
    previousStatus: booking.status,
    newStatus: 'approved_hold',
    flowVersion: 2,
    flowTwoApproval: {
      holdExpiresAt,
      depositAmount: preview.depositAmount,
    },
    outboxEmailQueued: false,
  }
}

async function resolveFlowTwoApprovalFailure(
  env: Env,
  booking: BookingState,
  clock: TransitionClock,
  depositRuleRevisionId: number,
): Promise<AdminWorkflowResult> {
  const current = await loadBookingState(env, booking.id)

  if (!current) {
    return { ok: false, response: bookingNotFoundResponse() }
  }

  if (current.status !== 'pending_review') {
    return { ok: false, response: invalidTransitionResponse() }
  }

  if (current.eventDate < clock.riyadhToday) {
    return { ok: false, response: eventDatePassedResponse() }
  }

  if (await isDateBlocked(env, current.eventDate)) {
    return { ok: false, response: dateUnavailableResponse() }
  }

  if (await isDateHeldByAnotherBooking(env, current.eventDate, current.id)) {
    return { ok: false, response: dateNotFreeResponse() }
  }

  // The date is free and the row unchanged: a settings predicate moved.
  const snapshot = await readSettingsSnapshot(env.DB, new Date())
  const preview = computeApprovalPreview(env, snapshot, current, clock.now)

  if (
    preview.flowVersion === 1 ||
    snapshot.effective.deposit?.revisionId !== depositRuleRevisionId
  ) {
    return { ok: false, response: settingsChangedResponse() }
  }

  throw new Error('Admin booking transition failed')
}

async function performApproval(
  request: Request,
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  body: ParsedActionBody,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  if (booking.status !== 'pending_review') {
    return { ok: false, response: invalidTransitionResponse() }
  }

  // Audit SEC-19: never a past date, on either path.
  if (booking.eventDate < clock.riyadhToday) {
    return { ok: false, response: eventDatePassedResponse() }
  }

  const snapshot = await readSettingsSnapshot(env.DB, clock.now)
  const preview = computeApprovalPreview(env, snapshot, booking, clock.now)

  if (preview.flowVersion === 2) {
    return performFlowTwoApproval(
      request,
      env,
      admin,
      booking,
      body,
      clock,
      snapshot,
      preview,
    )
  }

  // The legacy path, after the same sweep (a no-op while AX is off), so a
  // hold the cron would have expired within the quarter hour never blocks
  // the approval with a false DATE_UNAVAILABLE.
  await expireOverdueHolds(env, {
    nowIso: clock.nowIso,
    signal: request.signal,
    appBaseUrl: env.APP_BASE_URL,
    eventDate: booking.eventDate,
  })

  return performLegacyTransition(env, admin, booking, body, clock)
}

async function performExtendHold(
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  body: ParsedActionBody,
  note: string | null,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const hold = readFlowTwoHold(booking)
  const hours = body.extendHours ?? DEFAULT_EXTEND_HOURS
  const newDeadline = new Date(
    Math.max(hold.holdExpiresAtMs, clock.now.getTime()) + hours * HOUR_MILLISECONDS,
  ).toISOString()

  if (newDeadline >= hold.eventStart) {
    return { ok: false, response: holdBeyondEventResponse() }
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(EXTEND_HOLD_SQL).bind(
      booking.id,
      booking.status,
      newDeadline,
      clock.nowIso,
      hold.holdExpiresAt,
      graceCutoff(clock),
      hold.eventStart,
    ),
    adminEventStatement(
      env,
      GUARDED_ADMIN_EVENT_SQL,
      booking,
      admin,
      'hold_extended',
      {
        previousHoldExpiresAt: hold.holdExpiresAt,
        holdExpiresAt: newDeadline,
        hours,
      },
      note,
      clock.nowIso,
    ),
    supersedeRemindersStatement(env, booking, clock.nowIso),
  ]
  const outboxStatement = holdExtendedOutboxStatement(
    env,
    booking,
    newDeadline,
    clock.nowIso,
  )

  if (outboxStatement !== null) {
    statements.push(outboxStatement)
  }

  if (!(await runGuardedBatch(env, statements))) {
    return resolveFlowTwoFailure(env, booking, 'extend_hold', clock)
  }

  return {
    ok: true,
    bookingId: booking.id,
    previousStatus: booking.status,
    newStatus: booking.status,
    flowVersion: 2,
    flowTwoApproval: null,
    outboxEmailQueued: outboxStatement !== null,
  }
}

async function performExpireHold(
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  note: string | null,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const hold = readFlowTwoHold(booking)
  const committed = await runGuardedBatch(env, [
    env.DB.prepare(EXPIRE_HOLD_SQL).bind(
      booking.id,
      hold.holdExpiresAt,
      clock.nowIso,
    ),
    historyStatement(env, booking, 'expired', admin, note, clock.nowIso),
    adminEventStatement(
      env,
      ADMIN_EVENT_SQL,
      booking,
      admin,
      'hold_expired',
      { fromStatus: booking.status, holdExpiresAt: hold.holdExpiresAt },
      null,
      clock.nowIso,
    ),
    supersedeRemindersStatement(env, booking, clock.nowIso),
  ])

  if (!committed) {
    return resolveFlowTwoFailure(env, booking, 'expire_hold', clock)
  }

  return {
    ok: true,
    bookingId: booking.id,
    previousStatus: booking.status,
    newStatus: 'expired',
    flowVersion: 2,
    flowTwoApproval: null,
    outboxEmailQueued: false,
  }
}

async function performReinstateHold(
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  note: string | null,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const eventStart = riyadhStartOfDay(booking.eventDate)

  if (booking.flowVersion !== 2 || eventStart === null) {
    throw new Error('Stored flow-2 hold is invalid')
  }

  const holdExpiresAt = flowTwoHoldDeadline(
    clock.now.getTime(),
    Date.parse(eventStart),
  )
  const committed = await runGuardedBatch(env, [
    env.DB.prepare(REINSTATE_HOLD_SQL).bind(
      booking.id,
      booking.eventDate,
      holdExpiresAt,
      clock.nowIso,
      eventStart,
    ),
    historyStatement(env, booking, 'approved_hold', admin, note, clock.nowIso),
    adminEventStatement(
      env,
      ADMIN_EVENT_SQL,
      booking,
      admin,
      'hold_reinstated',
      { holdExpiresAt },
      null,
      clock.nowIso,
    ),
  ])

  if (!committed) {
    return resolveFlowTwoFailure(env, booking, 'reinstate_hold', clock)
  }

  return {
    ok: true,
    bookingId: booking.id,
    previousStatus: booking.status,
    newStatus: 'approved_hold',
    flowVersion: 2,
    // The row keeps the deposit it was approved with; a fresh deadline
    // deserves the same email as the approval (B1 #5).
    flowTwoApproval:
      booking.depositAmount === null
        ? null
        : { holdExpiresAt, depositAmount: booking.depositAmount },
    outboxEmailQueued: false,
  }
}

async function performFlowTwoConfirmPayment(
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  body: ParsedActionBody,
  note: string | null,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const amount = body.depositAmount

  if (amount === null || amount > booking.estimatedTotal) {
    return { ok: false, response: invalidAmountResponse() }
  }

  // TM-20: less than she was asked for is recorded only with a reason.
  if (booking.depositAmount !== null && amount < booking.depositAmount && note === null) {
    return { ok: false, response: noteRequiredResponse() }
  }

  const hold = readFlowTwoHold(booking)
  const committed = await runGuardedBatch(env, [
    env.DB.prepare(CONFIRM_PAYMENT_FLOW_TWO_SQL).bind(
      booking.id,
      booking.status,
      amount,
      clock.nowIso,
      hold.holdExpiresAt,
      graceCutoff(clock),
      hold.eventStart,
    ),
    historyStatement(env, booking, 'confirmed', admin, note, clock.nowIso),
    adminEventStatement(
      env,
      ADMIN_EVENT_SQL,
      booking,
      admin,
      'deposit_recorded',
      { amount, channel: getReceiptChannel(env) },
      null,
      clock.nowIso,
    ),
    supersedeRemindersStatement(env, booking, clock.nowIso),
  ])

  if (!committed) {
    return resolveFlowTwoFailure(env, booking, 'confirm_payment', clock)
  }

  return {
    ok: true,
    bookingId: booking.id,
    previousStatus: booking.status,
    newStatus: 'confirmed',
    flowVersion: 2,
    flowTwoApproval: null,
    outboxEmailQueued: false,
  }
}

async function performConfirmOffline(
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  body: ParsedActionBody,
  note: string | null,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const amount = body.depositAmount

  if (amount === null || amount > booking.estimatedTotal) {
    return { ok: false, response: invalidAmountResponse() }
  }

  if (note === null) {
    return { ok: false, response: noteRequiredResponse() }
  }

  const hold = readFlowTwoHold(booking)
  const snapshot = await readSettingsSnapshot(env.DB, clock.now)

  if (snapshot.terms === null) {
    return { ok: false, response: settingsChangedResponse() }
  }

  const committed = await runGuardedBatch(env, [
    env.DB.prepare(CONFIRM_OFFLINE_SQL).bind(
      booking.id,
      hold.holdExpiresAt,
      amount,
      clock.nowIso,
      snapshot.terms.version,
      hold.eventStart,
    ),
    historyStatement(env, booking, 'confirmed', admin, note, clock.nowIso),
    adminEventStatement(
      env,
      ADMIN_EVENT_SQL,
      booking,
      admin,
      'terms_accepted_offline',
      {
        termsVersion: snapshot.terms.version,
        bodySha256: snapshot.terms.bodySha256,
      },
      null,
      clock.nowIso,
    ),
    adminEventStatement(
      env,
      ADMIN_EVENT_SQL,
      booking,
      admin,
      'deposit_recorded',
      { amount, channel: 'offline' },
      null,
      clock.nowIso,
    ),
    supersedeRemindersStatement(env, booking, clock.nowIso),
  ])

  if (!committed) {
    return resolveFlowTwoFailure(env, booking, 'confirm_offline', clock)
  }

  return {
    ok: true,
    bookingId: booking.id,
    previousStatus: booking.status,
    newStatus: 'confirmed',
    flowVersion: 2,
    flowTwoApproval: null,
    outboxEmailQueued: false,
  }
}

async function performFlowTwoCancel(
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  note: string | null,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const committed = await runGuardedBatch(env, [
    env.DB.prepare(CANCEL_FLOW_TWO_SQL).bind(
      booking.id,
      booking.status,
      clock.nowIso,
    ),
    historyStatement(env, booking, 'cancelled', admin, note, clock.nowIso),
    supersedeRemindersStatement(env, booking, clock.nowIso),
  ])

  if (!committed) {
    return resolveFlowTwoFailure(env, booking, 'cancel', clock)
  }

  return {
    ok: true,
    bookingId: booking.id,
    previousStatus: booking.status,
    newStatus: 'cancelled',
    flowVersion: 2,
    flowTwoApproval: null,
    outboxEmailQueued: false,
  }
}

/** A flow-2 row: the map of shared/admin.ts, then the action's own batch. */
async function performFlowTwoTransition(
  env: Env,
  admin: AuthenticatedAdmin,
  booking: BookingState,
  body: ParsedActionBody,
  clock: TransitionClock,
): Promise<AdminWorkflowResult> {
  const facts = buildAdminFlowFacts(booking, clock.now)

  if (getAdminActionTargetStatusForBooking(facts, body.action) === null) {
    return { ok: false, response: refuseFlowTwoAction(facts, body.action) }
  }

  // The studio number is read only for the one note the content rules apply to.
  const studioDigits =
    body.action === 'confirm_offline'
      ? (await readStudioContact(env.DB, clock.now)).whatsappNumber
      : null
  const checkedNote = checkFlowTwoNote(body.note, body.action, studioDigits)

  if (!checkedNote.ok) {
    return { ok: false, response: checkedNote.response }
  }

  const { note } = checkedNote

  switch (body.action) {
    case 'extend_hold':
      return performExtendHold(env, admin, booking, body, note, clock)
    case 'expire_hold':
      return performExpireHold(env, admin, booking, note, clock)
    case 'reinstate_hold':
      return performReinstateHold(env, admin, booking, note, clock)
    case 'confirm_payment':
      return performFlowTwoConfirmPayment(env, admin, booking, body, note, clock)
    case 'confirm_offline':
      return performConfirmOffline(env, admin, booking, body, note, clock)
    case 'cancel':
      return performFlowTwoCancel(env, admin, booking, note, clock)
    case 'approve':
    case 'reject':
    case 'mark_contract_sent':
    case 'mark_contract_signed':
    case 'request_payment':
      // Never offered on a flow-2 row (the map above refused them).
      return { ok: false, response: invalidTransitionResponse() }
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

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

  const body = parsedBody.value

  // AD+R (H3): the offline confirmation needs a recent sign-in, decided
  // before any row is read.
  if (body.action === 'confirm_offline') {
    const reauthResponse = requireRecentSignIn(admin)

    if (reauthResponse !== null) {
      return { ok: false, response: reauthResponse }
    }
  }

  const booking = await loadBookingState(env, bookingId)

  if (!booking) {
    return {
      ok: false,
      response: bookingNotFoundResponse(),
    }
  }

  const clock = makeClock()

  if (body.action === 'approve') {
    return performApproval(request, env, admin, booking, body, clock)
  }

  if (booking.flowVersion === 2) {
    return performFlowTwoTransition(env, admin, booking, body, clock)
  }

  // A flow-1 row never takes an amount: the legacy contract is exact (N-29).
  if (body.depositAmount !== null) {
    return { ok: false, response: invalidRequestBodyResponse() }
  }

  return performLegacyTransition(env, admin, booking, body, clock)
}

// ?1 booking id | ?2 admin uid | ?3 now. The kind comes from event_kinds
// (seeded by migration 0008), so an older database records nothing rather
// than failing the save; changes() is the notes UPDATE just before it.
const NOTES_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, actor_uid, event, created_at)
  SELECT ?1, 'admin', ?2, k.kind, ?3
  FROM event_kinds AS k
  WHERE k.kind = 'internal_notes_updated'
    AND changes() = 1
`

export async function updateAdminBookingNotes(
  request: Request,
  env: Env,
  admin: AuthenticatedAdmin,
  bookingId: string,
): Promise<AdminNotesUpdateResult> {
  const parsedBody = await parseNotesBody(request)

  if (!parsedBody.ok) {
    return parsedBody
  }

  const updatedAt = new Date().toISOString()
  const normalizedNotes = parsedBody.value.notes || null
  // The save and its `internal_notes_updated` event (#19) commit together.
  const [result] = await env.DB.batch([
    env.DB.prepare(
      `
        UPDATE booking_requests
        SET
          admin_notes = ?,
          updated_at = ?
        WHERE id = ?
      `,
    ).bind(normalizedNotes, updatedAt, bookingId),
    env.DB.prepare(NOTES_EVENT_SQL).bind(bookingId, admin.uid, updatedAt),
  ])

  if ((result?.meta.changes ?? 0) === 0) {
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
