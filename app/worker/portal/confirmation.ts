import { isFlowVersion, isJourneyReceiptStatus, type FlowVersion } from '../../shared/journey.js'
import {
  ACCEPT_TERMS_BODY_KEYS,
  ACCEPT_TERMS_BODY_MAX_BYTES,
  DEPOSIT_NOTICE_BODY_KEYS,
  DEPOSIT_NOTICE_BODY_MAX_BYTES,
  isConfirmationViewStatus,
  isDepositNoticeChannel,
  isDepositOwedStatus,
  parseTermsVersion,
  resolveVerificationContact,
  type AcceptTermsResult,
  type AcceptedTerms,
  type ConfirmationBankDetails,
  type ConfirmationReceipt,
  type ConfirmationTerms,
  type ConfirmationView,
  type DepositNotice,
  type DepositNoticeResult,
} from '../../shared/portal/confirmation.js'
import {
  SAUDI_IBAN_LENGTH,
  isWhatsappDigits,
  type BankSettings,
} from '../../shared/settings.js'
import { HOLD_GRACE_HOURS, parseInstant, riyadhTodayKey } from '../../shared/timing.js'
import { errorResponse, jsonResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import {
  getReceiptChannel,
  readOnlineConfirmationEffective,
} from '../settings/features.js'
import {
  ONLINE_CONFIRMATION_SWITCH_ON_SQL,
  effectiveRevisionIdSql,
  readEffectiveSettings,
  readStudioContact,
} from '../settings/settings-read.js'
import { featureUnavailableResponse } from './gates.js'
import { bookingNotFoundResponse } from './owned-booking.js'
import type { CustomerPortalContext } from './portal-routes.js'
import { readJsonBody } from './request.js'

/**
 * Customer confirmation handlers (plan 11 §3.2 #2–#4, §3.3 #2–#4; threat
 * model TM-03, TM-16, TM-18; reviews B1, UX-02, UX-08; amendment GAP-05),
 * registered by worker/portal/slots/confirmation.ts. Auth CO: the dispatcher
 * has verified the token and the email and proven, in one query, that the
 * booking is the customer's (a foreign id already answered 404).
 *
 * Every handler first requires effective online confirmation (OCe = the
 * ONLINE_CONFIRMATION var ∧ the D1 kill switch, E7) and answers 503
 * otherwise. The OwnedBooking snapshot only picks early answers; every
 * statement here binds `user_id = ?` to the verified uid again (SB-20), and
 * both writes re-check ownership, flow 2, status, deadline and the kill
 * switch inside the writing statement itself (E4, SB-5), with the server
 * clock bound as a parameter.
 *
 * - GET  confirmation: the panel. The bank details come from the EFFECTIVE
 *   bank revision only (a pending one is never read here, TM-03), only after
 *   she accepted the terms and only while the deposit is owed. No receipt
 *   URL or file key is ever returned.
 * - POST accept-terms: one batch, the conditional UPDATE (current version,
 *   whose stored body still hashes to its recorded SHA-256, and the
 *   effective bank revision the Worker read and validated) and the
 *   `terms_accepted` event with `{termsVersion, bodySha256}` (TM-18),
 *   written only when the UPDATE changed the row.
 * - POST whatsapp-notice: one INSERT … SELECT of `deposit_notice_sent`
 *   `{holdExpiresAt}`, at most once per deadline (NOT EXISTS in the same
 *   statement). It never changes the status or the deadline (N-19); it
 *   protects the hold from automatic expiry (B1).
 *
 * D1 rows are a trust boundary: a booking row with an unexpected shape
 * throws a fixed code (worker/index.ts answers 500); a settings, terms,
 * notice or receipt row that fails its guard is left out (fail closed).
 * Nothing here logs anything: no IBAN, number, text or id reaches a log.
 */

type Row = Record<string, unknown>

const HOUR_MS = 60 * 60 * 1000
const HOLD_GRACE_MS = HOLD_GRACE_HOURS * HOUR_MS
/** Receipts shown in the panel: the attempt_no CHECK allows at most 10. */
const MAXIMUM_RECEIPTS = 10
const SHA256_HEX = /^[0-9a-f]{64}$/
const TERMS_VERSION = /^v[1-9][0-9]{0,3}$/
const utf8Encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// SQL (constant fragments and bound values only, SB-4)
// ---------------------------------------------------------------------------

/**
 * A `deposit_notice_sent` event for the CURRENT deadline of booking alias
 * `b` (B1, N-50), the definition the hold jobs and the queue use. Only a
 * text `holdExpiresAt` equal to the stored deadline counts.
 */
const CURRENT_NOTICE_CONDITION = `
  notice.booking_id = b.id
  AND notice.event = 'deposit_notice_sent'
  AND json_type(notice.details, '$.holdExpiresAt') = 'text'
  AND json_extract(notice.details, '$.holdExpiresAt') = b.hold_expires_at`

// ?1 booking id | ?2 uid
const BOOKING_SQL = `
  SELECT
    b.id AS id,
    b.status AS status,
    b.flow_version AS flowVersion,
    b.event_date AS eventDate,
    b.hold_expires_at AS holdExpiresAt,
    b.estimated_total AS estimatedTotal,
    b.deposit_amount AS depositAmount,
    b.terms_version AS termsVersion,
    b.terms_accepted_at AS termsAcceptedAt,
    b.bank_revision_id AS bankRevisionId,
    b.deposit_received_amount AS depositReceivedAmount,
    b.deposit_received_at AS depositReceivedAt
  FROM booking_requests AS b
  WHERE b.id = ?1
    AND b.user_id = ?2
  LIMIT 1`

// The current (highest-seq) terms version with its body.
const CURRENT_TERMS_SQL = `
  SELECT
    version,
    seq,
    body,
    body_sha256 AS bodySha256,
    created_at AS publishedAt
  FROM terms_versions
  ORDER BY seq DESC
  LIMIT 1`

// ?1 booking id | ?2 uid: the version she accepted, and the body hash the
// acceptance recorded (online or offline), newest first.
const ACCEPTED_TERMS_SQL = `
  SELECT
    t.version AS version,
    t.body AS body,
    t.body_sha256 AS storedSha256,
    (
      SELECT json_extract(accepted.details, '$.bodySha256')
      FROM booking_events AS accepted
      WHERE accepted.booking_id = b.id
        AND accepted.event IN ('terms_accepted', 'terms_accepted_offline')
        AND json_type(accepted.details, '$.bodySha256') = 'text'
        AND json_type(accepted.details, '$.termsVersion') = 'text'
        AND json_extract(accepted.details, '$.termsVersion') = b.terms_version
      ORDER BY accepted.id DESC
      LIMIT 1
    ) AS acceptedSha256
  FROM booking_requests AS b
  INNER JOIN terms_versions AS t ON t.version = b.terms_version
  WHERE b.id = ?1
    AND b.user_id = ?2
    AND b.terms_accepted_at IS NOT NULL
  LIMIT 1`

// ?1 booking id | ?2 uid: the first notice for the current deadline.
const CURRENT_NOTICE_SQL = `
  SELECT notice.created_at AS sentAt
  FROM booking_requests AS b
  INNER JOIN booking_events AS notice ON ${CURRENT_NOTICE_CONDITION}
  WHERE b.id = ?1
    AND b.user_id = ?2
  ORDER BY notice.id ASC
  LIMIT 1`

// ?1 booking id | ?2 uid: when the booking was first approved
// (pending_review → approved_hold; a later reinstate is not an approval)
// and the contact revision in force at that instant, by the same rule as
// settings-read.ts (the highest id whose activeFrom is not later). GAP-05.
const APPROVAL_CONTACT_SQL = `
  SELECT
    approval.approvedAt AS approvedAt,
    contact.whatsapp_number AS whatsappNumber
  FROM (
    SELECT history.created_at AS approvedAt
    FROM booking_status_history AS history
    INNER JOIN booking_requests AS b ON b.id = history.booking_id
    WHERE b.id = ?1
      AND b.user_id = ?2
      AND history.from_status = 'pending_review'
      AND history.to_status = 'approved_hold'
    ORDER BY history.id ASC
    LIMIT 1
  ) AS approval
  LEFT JOIN settings_revisions AS contact ON contact.id = (
    SELECT MAX(candidate.id)
    FROM settings_revisions AS candidate
    WHERE candidate.section = 'contact'
      AND COALESCE(candidate.effective_at, candidate.created_at) <= approval.approvedAt
  )`

// ?1 booking id | ?2 uid: status and dates only, never object_key.
const RECEIPTS_SQL = `
  SELECT
    receipt.attempt_no AS attemptNo,
    receipt.status AS status,
    receipt.created_at AS uploadedAt,
    receipt.reviewed_at AS reviewedAt,
    receipt.rejection_reason AS rejectionReason
  FROM booking_receipts AS receipt
  INNER JOIN booking_requests AS b ON b.id = receipt.booking_id
  WHERE b.id = ?1
    AND b.user_id = ?2
  ORDER BY receipt.attempt_no DESC
  LIMIT ${MAXIMUM_RECEIPTS}`

// ?1 booking id | ?2 uid | ?3 accepted version | ?4 now | ?5 body SHA-256
// | ?6 effective bank revision id, as the Worker read and validated it.
const ACCEPT_TERMS_SQL = `
  UPDATE booking_requests
  SET
    terms_version = ?3,
    terms_accepted_at = ?4,
    bank_revision_id = ?6,
    updated_at = ?4
  WHERE id = ?1
    AND user_id = ?2
    AND flow_version = 2
    AND status = 'approved_hold'
    AND hold_expires_at > ?4
    AND terms_accepted_at IS NULL
    AND ?3 = (SELECT current.version FROM terms_versions AS current ORDER BY current.seq DESC LIMIT 1)
    AND ?5 = (SELECT accepted.body_sha256 FROM terms_versions AS accepted WHERE accepted.version = ?3)
    AND ?6 = ${effectiveRevisionIdSql('bank', '?4')}
    AND ${ONLINE_CONFIRMATION_SWITCH_ON_SQL}`

// ?1 booking id | ?2 accepted version | ?3 body SHA-256 | ?4 now. Runs right
// after ACCEPT_TERMS_SQL in the same batch and inserts only when that
// UPDATE changed the row. Its insert has no other condition, so it either
// inserts or fails, and a failure rolls the whole batch back.
const TERMS_ACCEPTED_EVENT_SQL = `
  INSERT INTO booking_events (booking_id, actor, actor_uid, event, subject_id, details, note, created_at)
  SELECT ?1, 'customer', NULL, 'terms_accepted', NULL,
    json_object('termsVersion', ?2, 'bodySha256', ?3), NULL, ?4
  WHERE changes() = 1`

// ?1 booking id | ?2 uid | ?3 now | ?4 now − HOLD_GRACE_HOURS | ?5 Riyadh
// today. Once per deadline; the deadline and status are only read.
const DEPOSIT_NOTICE_SQL = `
  INSERT INTO booking_events (booking_id, actor, actor_uid, event, subject_id, details, note, created_at)
  SELECT b.id, 'customer', NULL, 'deposit_notice_sent', NULL,
    json_object('holdExpiresAt', b.hold_expires_at), NULL, ?3
  FROM booking_requests AS b
  WHERE b.id = ?1
    AND b.user_id = ?2
    AND b.flow_version = 2
    AND b.status = 'approved_hold'
    AND b.terms_accepted_at IS NOT NULL
    AND b.hold_expires_at IS NOT NULL
    AND b.hold_expires_at > ?4
    AND b.event_date > ?5
    AND ${ONLINE_CONFIRMATION_SWITCH_ON_SQL}
    AND NOT EXISTS (
      SELECT 1 FROM booking_events AS notice
      WHERE ${CURRENT_NOTICE_CONDITION}
    )`

// ?1 booking id | ?2 uid: why a write changed nothing.
const WRITE_STATE_SQL = `
  SELECT
    b.flow_version AS flowVersion,
    b.status AS status,
    b.event_date AS eventDate,
    b.hold_expires_at AS holdExpiresAt,
    b.terms_version AS termsVersion,
    b.terms_accepted_at AS termsAcceptedAt,
    b.bank_revision_id AS bankRevisionId,
    (SELECT current.version FROM terms_versions AS current ORDER BY current.seq DESC LIMIT 1) AS currentTermsVersion,
    CASE WHEN ${ONLINE_CONFIRMATION_SWITCH_ON_SQL} THEN 1 ELSE 0 END AS switchOn,
    (
      SELECT notice.created_at FROM booking_events AS notice
      WHERE ${CURRENT_NOTICE_CONDITION}
      ORDER BY notice.id ASC
      LIMIT 1
    ) AS noticeSentAt
  FROM booking_requests AS b
  WHERE b.id = ?1
    AND b.user_id = ?2
  LIMIT 1`

/** Every statement this module prepares (tests prepare each one). */
export const CONFIRMATION_SQL = {
  booking: BOOKING_SQL,
  currentTerms: CURRENT_TERMS_SQL,
  acceptedTerms: ACCEPTED_TERMS_SQL,
  currentNotice: CURRENT_NOTICE_SQL,
  approvalContact: APPROVAL_CONTACT_SQL,
  receipts: RECEIPTS_SQL,
  acceptTerms: ACCEPT_TERMS_SQL,
  termsAcceptedEvent: TERMS_ACCEPTED_EVENT_SQL,
  depositNotice: DEPOSIT_NOTICE_SQL,
  writeState: WRITE_STATE_SQL,
} as const

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function invalidRequestBodyResponse(): Response {
  return errorResponse(400, 'INVALID_REQUEST_BODY', 'بيانات الطلب غير صحيحة.')
}

function legacyFlowResponse(): Response {
  return errorResponse(
    409,
    'LEGACY_FLOW_NOT_SUPPORTED',
    'يُستكمل هذا الحجز بالتواصل مع الاستوديو عبر واتساب.',
  )
}

function confirmationNotAvailableResponse(): Response {
  return errorResponse(
    409,
    'CONFIRMATION_NOT_AVAILABLE',
    'خطوة تأكيد الحجز غير متاحة لهذا الطلب حاليًا.',
  )
}

function termsVersionMismatchResponse(): Response {
  return errorResponse(
    409,
    'TERMS_VERSION_MISMATCH',
    'تم تحديث شروط الحجز. راجعي النسخة الحالية ثم وافقي عليها.',
  )
}

function termsNotAcceptedResponse(): Response {
  return errorResponse(
    409,
    'TERMS_NOT_ACCEPTED',
    'لم تتم الموافقة على شروط الحجز بعد.',
  )
}

function holdExpiredResponse(): Response {
  return errorResponse(
    409,
    'HOLD_EXPIRED',
    'انتهت مهلة الحجز المؤقت لهذا التاريخ. تواصلي معنا عبر واتساب إن رغبتِ في المتابعة.',
  )
}

function invalidTransitionResponse(): Response {
  return errorResponse(
    409,
    'INVALID_STATUS_TRANSITION',
    'لا يمكن تنفيذ هذا الإجراء من حالة الحجز الحالية.',
  )
}

// ---------------------------------------------------------------------------
// Row guards
// ---------------------------------------------------------------------------

/** The toISOString() form every instant column holds (0005 CHECKs). */
function isCanonicalInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    parseInstant(value)?.toISOString() === value
  )
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || isCount(value)
}

function isNullableInstant(value: unknown): value is string | null {
  return value === null || isCanonicalInstant(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

interface ConfirmationRow {
  readonly id: string
  readonly status: string
  readonly flowVersion: FlowVersion
  readonly eventDate: string
  readonly holdExpiresAt: string | null
  readonly estimatedTotal: number
  readonly depositAmount: number | null
  readonly termsVersion: string | null
  readonly termsAcceptedAt: string | null
  readonly bankRevisionId: number | null
  readonly depositReceivedAmount: number | null
  readonly depositReceivedAt: string | null
}

function readConfirmationRow(row: Row, bookingId: string): ConfirmationRow {
  const {
    id,
    status,
    flowVersion,
    eventDate,
    holdExpiresAt,
    estimatedTotal,
    depositAmount,
    termsVersion,
    termsAcceptedAt,
    bankRevisionId,
    depositReceivedAmount,
    depositReceivedAt,
  } = row

  if (
    id !== bookingId ||
    typeof status !== 'string' ||
    !isFlowVersion(flowVersion) ||
    typeof eventDate !== 'string' ||
    !isNullableInstant(holdExpiresAt) ||
    !isCount(estimatedTotal) ||
    !isNullableCount(depositAmount) ||
    !isNullableString(termsVersion) ||
    !isNullableInstant(termsAcceptedAt) ||
    !isNullableCount(bankRevisionId) ||
    !isNullableCount(depositReceivedAmount) ||
    !isNullableInstant(depositReceivedAt)
  ) {
    throw new Error('CONFIRMATION_ROW_INVALID')
  }

  return {
    id: bookingId,
    status,
    flowVersion,
    eventDate,
    holdExpiresAt,
    estimatedTotal,
    depositAmount,
    termsVersion,
    termsAcceptedAt,
    bankRevisionId,
    depositReceivedAmount,
    depositReceivedAt,
  }
}

interface WriteStateRow {
  readonly flowVersion: FlowVersion
  readonly status: string
  readonly eventDate: string
  readonly holdExpiresAt: string | null
  readonly termsVersion: string | null
  readonly termsAcceptedAt: string | null
  readonly bankRevisionId: number | null
  readonly currentTermsVersion: string | null
  readonly switchOn: boolean
  readonly noticeSentAt: string | null
}

function readWriteStateRow(row: Row): WriteStateRow {
  const {
    flowVersion,
    status,
    eventDate,
    holdExpiresAt,
    termsVersion,
    termsAcceptedAt,
    bankRevisionId,
    currentTermsVersion,
    switchOn,
    noticeSentAt,
  } = row

  if (
    !isFlowVersion(flowVersion) ||
    typeof status !== 'string' ||
    typeof eventDate !== 'string' ||
    !isNullableInstant(holdExpiresAt) ||
    !isNullableString(termsVersion) ||
    !isNullableInstant(termsAcceptedAt) ||
    !isNullableCount(bankRevisionId) ||
    !isNullableString(currentTermsVersion) ||
    (switchOn !== 0 && switchOn !== 1)
  ) {
    throw new Error('CONFIRMATION_STATE_ROW_INVALID')
  }

  return {
    flowVersion,
    status,
    eventDate,
    holdExpiresAt,
    termsVersion,
    termsAcceptedAt,
    bankRevisionId,
    currentTermsVersion,
    switchOn: switchOn === 1,
    // A malformed notice time protects nothing it can report.
    noticeSentAt: isCanonicalInstant(noticeSentAt) ? noticeSentAt : null,
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', utf8Encoder.encode(text)),
  )

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface CurrentTermsWithHash extends ConfirmationTerms {
  readonly bodySha256: string
}

/**
 * The current terms when the row is well formed AND its body still hashes
 * to the SHA-256 recorded when it was published (TM-18): a body changed
 * around the append-only trigger is never shown and cannot be accepted.
 */
async function readCurrentTermsRow(
  row: Row | undefined,
): Promise<CurrentTermsWithHash | null> {
  if (row === undefined) {
    return null
  }

  const { version, seq, body, bodySha256, publishedAt } = row

  if (
    typeof version !== 'string' ||
    !TERMS_VERSION.test(version) ||
    version !== `v${String(seq)}` ||
    typeof body !== 'string' ||
    typeof bodySha256 !== 'string' ||
    !SHA256_HEX.test(bodySha256) ||
    !isCanonicalInstant(publishedAt) ||
    (await sha256Hex(body)) !== bodySha256
  ) {
    return null
  }

  return { version, body, publishedAt, bodySha256 }
}

/**
 * The accepted version (TM-18). The hash she accepted is the one her
 * acceptance event recorded; a booking without such an event (accepted
 * before events carried it) falls back to the version's stored hash. The
 * body is shown only when it hashes to that value.
 */
async function readAcceptedTermsRow(row: Row | undefined): Promise<AcceptedTerms | null> {
  if (row === undefined) {
    return null
  }

  const { version, body, storedSha256, acceptedSha256 } = row
  const expectedSha256 =
    typeof acceptedSha256 === 'string' ? acceptedSha256 : storedSha256

  if (
    typeof version !== 'string' ||
    !TERMS_VERSION.test(version) ||
    typeof body !== 'string' ||
    typeof expectedSha256 !== 'string' ||
    !SHA256_HEX.test(expectedSha256) ||
    (await sha256Hex(body)) !== expectedSha256
  ) {
    return null
  }

  return { version, bodySha256: expectedSha256, body }
}

function readNoticeRow(row: Row | undefined): DepositNotice | null {
  return row !== undefined && isCanonicalInstant(row.sentAt)
    ? { sentAt: row.sentAt, holdProtected: true }
    : null
}

/**
 * GAP-05: the number in force at approval (null: none saved, so the
 * compiled number), or 'unknown' when there is no approval row or its time
 * is not a canonical instant (then the textual comparison with activeFrom
 * would be meaningless). A contact row that fails the E.164 rule reads as
 * none, as settings-read.ts reads it.
 */
function readApprovalContactRow(row: Row | undefined): string | null | 'unknown' {
  if (row === undefined || !isCanonicalInstant(row.approvedAt)) {
    return 'unknown'
  }

  const { whatsappNumber } = row

  return typeof whatsappNumber === 'string' && isWhatsappDigits(whatsappNumber)
    ? whatsappNumber
    : null
}

function readReceiptRows(rows: readonly Row[]): ConfirmationReceipt[] {
  const receipts: ConfirmationReceipt[] = []

  for (const { attemptNo, status, uploadedAt, reviewedAt, rejectionReason } of rows) {
    if (
      isCount(attemptNo) &&
      attemptNo >= 1 &&
      isJourneyReceiptStatus(status) &&
      isCanonicalInstant(uploadedAt) &&
      isNullableInstant(reviewedAt) &&
      isNullableString(rejectionReason)
    ) {
      receipts.push({
        attemptNo,
        status,
        uploadedAt,
        reviewedAt,
        rejectionReason: status === 'rejected' ? rejectionReason : null,
      })
    }
  }

  return receipts
}

/**
 * The customer-facing form of the effective bank revision. settings-read.ts
 * already refused a row whose IBAN fails its checksum or whose names fail
 * their text rule; the IBAN is stored normalised, and the length is
 * re-asserted here because the copy button copies exactly this value.
 */
function toBankDetails(bank: BankSettings | null): ConfirmationBankDetails | null {
  if (bank === null || bank.iban.length !== SAUDI_IBAN_LENGTH) {
    return null
  }

  return {
    bankName: bank.bankName,
    accountHolder: bank.accountHolder,
    iban: bank.iban,
    updatedAt: bank.activeFrom,
  }
}

interface BankView {
  readonly bankDetails: ConfirmationBankDetails | null
  readonly bankDetailsChangedSinceAcceptance: boolean
}

/**
 * Bank details only for a flow-2 booking whose terms she accepted and whose
 * deposit is still owed (TM-03). Changed = the revision recorded at her
 * acceptance is not the effective one, including no revision recorded
 * (UX-08, TM-16).
 */
function bankView(
  termsAccepted: boolean,
  status: string,
  acceptedBankRevisionId: number | null,
  effectiveBank: BankSettings | null,
): BankView {
  if (!termsAccepted || !isDepositOwedStatus(status)) {
    return { bankDetails: null, bankDetailsChangedSinceAcceptance: false }
  }

  return {
    bankDetails: toBankDetails(effectiveBank),
    bankDetailsChangedSinceAcceptance:
      acceptedBankRevisionId !== (effectiveBank?.revisionId ?? null),
  }
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** OCe (E7): the var, then the D1 kill switch. */
async function isConfirmationOpen(env: Env): Promise<boolean> {
  return readOnlineConfirmationEffective(env, env.DB)
}

/** RL_CUSTOMER_WRITE burst (TM-11, SB-15), keyed by the verified uid. */
async function isWriteBurstLimited(env: Env, uid: string): Promise<boolean> {
  return (await limitBurst(env.RL_CUSTOMER_WRITE, uid)) === 'limited'
}

function changesOf(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0
}

async function readWriteState(
  db: D1Database,
  bookingId: string,
  uid: string,
): Promise<WriteStateRow | null> {
  const row = await db
    .prepare(WRITE_STATE_SQL)
    .bind(bookingId, uid)
    .first<Row>()

  return row === null ? null : readWriteStateRow(row)
}

// ---------------------------------------------------------------------------
// GET /api/bookings/{id}/confirmation (#2)
// ---------------------------------------------------------------------------

export async function handleConfirmationView(
  context: CustomerPortalContext,
): Promise<Response> {
  const { env, customer, booking } = context

  if (!(await isConfirmationOpen(env))) {
    return featureUnavailableResponse()
  }

  if (booking.flowVersion !== 2) {
    return legacyFlowResponse()
  }

  const now = new Date()
  const receiptChannel = getReceiptChannel(env)
  const bind = (statement: D1PreparedStatement): D1PreparedStatement =>
    statement.bind(booking.id, customer.uid)
  const statements = [
    bind(env.DB.prepare(BOOKING_SQL)),
    env.DB.prepare(CURRENT_TERMS_SQL),
    bind(env.DB.prepare(ACCEPTED_TERMS_SQL)),
    bind(env.DB.prepare(CURRENT_NOTICE_SQL)),
    bind(env.DB.prepare(APPROVAL_CONTACT_SQL)),
    ...(receiptChannel === 'upload' ? [bind(env.DB.prepare(RECEIPTS_SQL))] : []),
  ]
  const [results, effective, studio] = await Promise.all([
    env.DB.batch<Row>(statements),
    readEffectiveSettings(env.DB, now),
    readStudioContact(env.DB, now),
  ])
  const bookingRow = results[0]?.results.at(0)

  if (bookingRow === undefined) {
    return bookingNotFoundResponse()
  }

  const row = readConfirmationRow(bookingRow, booking.id)

  if (row.flowVersion !== 2) {
    return legacyFlowResponse()
  }

  const { status } = row

  if (!isConfirmationViewStatus(status)) {
    return confirmationNotAvailableResponse()
  }

  const termsAccepted = row.termsAcceptedAt !== null
  const [currentTerms, acceptedTerms] = await Promise.all([
    readCurrentTermsRow(results[1]?.results.at(0)),
    termsAccepted
      ? readAcceptedTermsRow(results[2]?.results.at(0))
      : Promise.resolve(null),
  ])
  const bank = bankView(termsAccepted, status, row.bankRevisionId, effective.bank)
  const view: ConfirmationView = {
    booking: {
      id: row.id,
      status,
      flowVersion: 2,
      eventDate: row.eventDate,
      holdExpiresAt: row.holdExpiresAt,
      estimatedTotal: row.estimatedTotal,
      depositAmount: row.depositAmount,
      termsVersion: row.termsVersion,
      termsAcceptedAt: row.termsAcceptedAt,
      depositReceivedAmount: row.depositReceivedAmount,
      depositReceivedAt: row.depositReceivedAt,
    },
    terms:
      currentTerms === null
        ? null
        : {
            version: currentTerms.version,
            body: currentTerms.body,
            publishedAt: currentTerms.publishedAt,
          },
    acceptedTerms,
    bankDetails: bank.bankDetails,
    bankDetailsChangedSinceAcceptance: bank.bankDetailsChangedSinceAcceptance,
    receiptChannel,
    notice: readNoticeRow(results[3]?.results.at(0)),
    receipts:
      receiptChannel === 'upload' ? readReceiptRows(results[5]?.results ?? []) : [],
    studio,
    verificationContact: resolveVerificationContact(
      readApprovalContactRow(results[4]?.results.at(0)),
      studio.whatsappNumber,
    ),
    serverTime: now.toISOString(),
  }

  return jsonResponse({ ok: true, ...view })
}

// ---------------------------------------------------------------------------
// POST /api/bookings/{id}/confirmation/accept-terms (#3)
// ---------------------------------------------------------------------------

function acceptedResponse(result: AcceptTermsResult): Response {
  return jsonResponse({ ok: true, ...result })
}

export async function handleAcceptTerms(
  context: CustomerPortalContext,
): Promise<Response> {
  const { env, request, customer, booking } = context

  if (!(await isConfirmationOpen(env))) {
    return featureUnavailableResponse()
  }

  if (await isWriteBurstLimited(env, customer.uid)) {
    return rateLimitedResponse()
  }

  const body = await readJsonBody(request, {
    maxBytes: ACCEPT_TERMS_BODY_MAX_BYTES,
    requiredKeys: ACCEPT_TERMS_BODY_KEYS,
  })

  if (!body.ok) {
    return body.response
  }

  const termsVersion = parseTermsVersion(body.body.termsVersion)

  if (termsVersion === null) {
    return invalidRequestBodyResponse()
  }

  if (booking.flowVersion !== 2) {
    return legacyFlowResponse()
  }

  const now = new Date()
  const acceptedAt = now.toISOString()
  const [termsRow, effective] = await Promise.all([
    env.DB.prepare(CURRENT_TERMS_SQL).first<Row>(),
    readEffectiveSettings(env.DB, now),
  ])
  const terms = await readCurrentTermsRow(termsRow ?? undefined)
  const effectiveBank = effective.bank

  // The write runs only for the version she read, whose body is intact, and
  // with a validated effective bank revision; the UPDATE re-checks both.
  if (
    terms !== null &&
    terms.version === termsVersion &&
    effectiveBank !== null &&
    toBankDetails(effectiveBank) !== null
  ) {
    const [update, event] = await env.DB.batch([
      env.DB.prepare(ACCEPT_TERMS_SQL).bind(
        booking.id,
        customer.uid,
        termsVersion,
        acceptedAt,
        terms.bodySha256,
        effectiveBank.revisionId,
      ),
      env.DB.prepare(TERMS_ACCEPTED_EVENT_SQL).bind(
        booking.id,
        termsVersion,
        terms.bodySha256,
        acceptedAt,
      ),
    ])

    if (changesOf(update) === 1) {
      if (changesOf(event) !== 1) {
        throw new Error('TERMS_ACCEPTED_EVENT_MISSING')
      }

      return acceptedResponse({
        booking: { termsVersion, termsAcceptedAt: acceptedAt },
        bankDetails: toBankDetails(effectiveBank),
        bankDetailsChangedSinceAcceptance: false,
      })
    }
  }

  const state = await readWriteState(env.DB, booking.id, customer.uid)

  if (state === null) {
    return bookingNotFoundResponse()
  }

  if (state.flowVersion !== 2) {
    return legacyFlowResponse()
  }

  if (state.termsAcceptedAt !== null) {
    // Idempotent: the same version again is the acceptance she already made.
    if (state.termsVersion !== termsVersion) {
      return termsVersionMismatchResponse()
    }

    return acceptedResponse({
      booking: { termsVersion, termsAcceptedAt: state.termsAcceptedAt },
      ...bankView(true, state.status, state.bankRevisionId, effectiveBank),
    })
  }

  if (state.status === 'expired') {
    return holdExpiredResponse()
  }

  if (state.status !== 'approved_hold') {
    return invalidTransitionResponse()
  }

  if (state.holdExpiresAt === null || state.holdExpiresAt <= acceptedAt) {
    return holdExpiredResponse()
  }

  if (!state.switchOn) {
    return featureUnavailableResponse()
  }

  if (state.currentTermsVersion === null) {
    return confirmationNotAvailableResponse()
  }

  if (state.currentTermsVersion !== termsVersion) {
    return termsVersionMismatchResponse()
  }

  // A body that fails its hash, no valid effective bank revision, or a
  // revision that took effect meanwhile: nothing she can fix by retrying now.
  return confirmationNotAvailableResponse()
}

// ---------------------------------------------------------------------------
// POST /api/bookings/{id}/confirmation/whatsapp-notice (#4)
// ---------------------------------------------------------------------------

function noticeResponse(noticeRecordedAt: string): Response {
  const result: DepositNoticeResult = { noticeRecordedAt, holdProtected: true }

  return jsonResponse({ ok: true, ...result })
}

export async function handleDepositNotice(
  context: CustomerPortalContext,
): Promise<Response> {
  const { env, request, customer, booking } = context

  if (!(await isConfirmationOpen(env))) {
    return featureUnavailableResponse()
  }

  if (await isWriteBurstLimited(env, customer.uid)) {
    return rateLimitedResponse()
  }

  const body = await readJsonBody(request, {
    maxBytes: DEPOSIT_NOTICE_BODY_MAX_BYTES,
    requiredKeys: DEPOSIT_NOTICE_BODY_KEYS,
  })

  if (!body.ok) {
    return body.response
  }

  if (!isDepositNoticeChannel(body.body.channel)) {
    return invalidRequestBodyResponse()
  }

  if (booking.flowVersion !== 2) {
    return legacyFlowResponse()
  }

  const now = new Date()
  const recordedAt = now.toISOString()
  const graceStart = new Date(now.getTime() - HOLD_GRACE_MS).toISOString()
  const today = riyadhTodayKey(now)
  const inserted = await env.DB.prepare(DEPOSIT_NOTICE_SQL)
    .bind(booking.id, customer.uid, recordedAt, graceStart, today)
    .run()

  if (changesOf(inserted) === 1) {
    return noticeResponse(recordedAt)
  }

  const state = await readWriteState(env.DB, booking.id, customer.uid)

  if (state === null) {
    return bookingNotFoundResponse()
  }

  if (state.flowVersion !== 2) {
    return legacyFlowResponse()
  }

  // Once per deadline: a repeat answers with the notice already recorded
  // and moves nothing (N-19).
  if (state.status === 'approved_hold' && state.noticeSentAt !== null) {
    return noticeResponse(state.noticeSentAt)
  }

  if (state.status === 'expired') {
    return holdExpiredResponse()
  }

  if (state.status !== 'approved_hold') {
    return confirmationNotAvailableResponse()
  }

  if (state.termsAcceptedAt === null) {
    return termsNotAcceptedResponse()
  }

  if (
    state.holdExpiresAt === null ||
    state.holdExpiresAt <= graceStart ||
    state.eventDate <= today
  ) {
    return holdExpiredResponse()
  }

  if (!state.switchOn) {
    return featureUnavailableResponse()
  }

  return confirmationNotAvailableResponse()
}
