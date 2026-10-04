import { bookingStatuses, type BookingStatus } from '../../shared/admin.js'
import { bookingsExportedAudit } from '../../shared/audit.js'
import {
  deriveJourneyStage,
  isFlowVersion,
  isJourneyAlbumStage,
  isJourneyGalleryStatus,
  isJourneyHandoverStatus,
  isJourneyReceiptStatus,
  journeyStageLabels,
  type JourneyAlbumStage,
  type JourneyFacts,
  type JourneyGalleryFacts,
  type JourneyHandoverFacts,
} from '../../shared/journey.js'
import { toAsciiDigits } from '../../shared/text.js'
import {
  daysBetweenDateKeys,
  isValidDateKey,
  riyadhDateKey,
  riyadhHour,
} from '../../shared/timing.js'
import { auditStatement } from '../audit/admin-audit.js'
import {
  buildCsvDocument,
  csvInteger,
  csvText,
  type CsvCell,
} from '../csv.js'
import { errorResponse } from '../http.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import { reauthAtFromToken, requireRecentSignIn } from '../recent-auth.js'
import type { AdminPortalContext } from './admin-portal-routes.js'

/**
 * GET /api/admin/exports/bookings.csv?from=&to=&status= (plan 11 §3.2 #38,
 * AD+R; TM-13, SB-6, SB-10, SB-14; N-09, N-10, N-26, N-42).
 *
 * Order: the admin guard (dispatcher) → AD+R (403 REAUTH_REQUIRED) →
 * RL_ADMIN_READ burst per uid (429) → query validation (400) → one bounded
 * read → the file is built in memory → the admin_audit_log row
 * `bookings_exported` is written, with `reauth_at` from the token's
 * `auth_time`, and must have changed exactly one row → only then is the
 * body returned. A failed read, a row of an unexpected shape or a failed
 * audit write throws (the Worker's top level answers 500), so no file ever
 * leaves without its audit row.
 *
 * - `from` and `to` (event dates, `YYYY-MM-DD`, inclusive) are required;
 *   `status` is optional. Any other key, or a key given twice, is refused.
 *   A span over MAXIMUM_EXPORT_SPAN_DAYS days, or more than
 *   MAXIMUM_EXPORT_ROWS matching bookings, answers 400 EXPORT_TOO_LARGE
 *   (read with one row over the cap, and no audit row).
 * - Cells go through worker/csv.ts: text neutralised and quoted, totals and
 *   amounts written from integers without a prefix, the phone as digits.
 *   Internal notes (admin_notes) are never selected, and neither is any
 *   address, receipt, gallery or event-profile text.
 * - Attachment with an ASCII file name built only from the two validated
 *   dates; no-store, nosniff, X-Frame-Options DENY and a CSP that allows
 *   nothing, so the file is never rendered or cached as a page.
 * Nothing here logs a value.
 */

/** Longest span, `to` minus `from` in days (N-26). */
export const MAXIMUM_EXPORT_SPAN_DAYS = 400
/** Most bookings in one file (N-26). */
export const MAXIMUM_EXPORT_ROWS = 5000

/** The same HSTS value as worker/http.ts jsonResponse (a test compares them). */
const STRICT_TRANSPORT_SECURITY = 'max-age=63072000; includeSubDomains'
const EXPORT_QUERY_KEYS: ReadonlySet<string> = new Set(['from', 'to', 'status'])
const LEGACY_SQL_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const NON_DIGITS = /\D/g

/**
 * The admin status labels of src/features/admin-portal/booking-status.ts,
 * which the Worker cannot import (a test keeps the two equal).
 */
export const exportStatusLabels: Readonly<Record<BookingStatus, string>> =
  Object.freeze({
    pending_review: 'قيد المراجعة',
    approved_hold: 'مقبول — التاريخ محجوز مؤقتًا',
    contract_pending: 'بانتظار توقيع العقد',
    contract_signed: 'تم توقيع العقد',
    payment_pending: 'بانتظار العربون',
    confirmed: 'الحجز مؤكد',
    rejected: 'مرفوض',
    cancelled: 'ملغي',
    expired: 'انتهت المهلة',
  } satisfies Record<BookingStatus, string>)

/** 08-copy-ar §9.4: «الطريقة (استلام/توصيل)». */
const handoverMethodLabels: Readonly<Record<'pickup' | 'delivery', string>> =
  Object.freeze({
    pickup: 'استلام',
    delivery: 'توصيل',
  })

/** The album stages read as their journey stage labels. */
const productionStageLabels: Readonly<Record<JourneyAlbumStage, string>> =
  Object.freeze({
    design: journeyStageLabels.album_design,
    printing: journeyStageLabels.album_printing,
    ready: journeyStageLabels.album_ready,
  })

/** The columns of #38, in order. */
export const EXPORT_COLUMNS: readonly string[] = Object.freeze([
  'رقم الحجز',
  'تاريخ الإنشاء (توقيت الرياض)',
  'تاريخ المناسبة',
  'رمز الحالة',
  'الحالة',
  'المرحلة',
  'الباقة',
  'الإجمالي',
  'العربون المطلوب',
  'العربون المستلم',
  'تاريخ استلام العربون',
  'الاسم الأول',
  'اسم العائلة',
  'الجوال',
  'البريد الإلكتروني',
  'نسخة الشروط',
  'تاريخ قبول الشروط',
  'طريقة الاستلام',
  'موعد الاستلام',
  'مرحلة الإنتاج',
])

/*
 * ?1 from | ?2 to | ?3 status or NULL | ?4 row cap + 1.
 * Every child join is 1:1 with the booking (primary key or UNIQUE on
 * booking_id; the latest receipt by UNIQUE(booking_id, attempt_no)), so the
 * LIMIT counts bookings. admin_notes is deliberately absent.
 */
const EXPORT_SQL = `
  SELECT
    b.id AS id,
    b.created_at AS createdAt,
    b.event_date AS eventDate,
    b.status AS status,
    b.flow_version AS flowVersion,
    CASE
      WHEN json_valid(b.package_snapshot)
        AND json_type(b.package_snapshot, '$.package.name') = 'text'
      THEN json_extract(b.package_snapshot, '$.package.name')
    END AS packageName,
    b.estimated_total AS estimatedTotal,
    b.deposit_amount AS depositAmount,
    b.deposit_received_amount AS depositReceivedAmount,
    b.deposit_received_at AS depositReceivedAt,
    b.hold_expires_at AS holdExpiresAt,
    b.completed_at AS completedAt,
    b.terms_version AS termsVersion,
    b.terms_accepted_at AS termsAcceptedAt,
    u.first_name AS firstName,
    u.last_name AS lastName,
    u.phone AS phone,
    u.email AS email,
    lr.status AS latestReceiptStatus,
    CASE WHEN ep.booking_id IS NULL THEN 0 ELSE 1 END AS hasEventProfile,
    g.status AS galleryStatus,
    g.selection_deadline AS gallerySelectionDeadline,
    g.submitted_at AS gallerySubmittedAt,
    ap.stage AS albumStage,
    h.method AS handoverMethod,
    h.status AS handoverStatus,
    s.starts_at AS handoverStartsAt,
    h.completed_at AS handoverCompletedAt
  FROM booking_requests AS b
  JOIN users AS u ON u.id = b.user_id
  LEFT JOIN booking_receipts AS lr
    ON lr.booking_id = b.id
   AND lr.attempt_no = (
     SELECT MAX(r.attempt_no)
     FROM booking_receipts AS r
     WHERE r.booking_id = b.id
   )
  LEFT JOIN event_profiles AS ep ON ep.booking_id = b.id
  LEFT JOIN galleries AS g ON g.booking_id = b.id
  LEFT JOIN album_production AS ap ON ap.booking_id = b.id
  LEFT JOIN handovers AS h ON h.booking_id = b.id
  LEFT JOIN handover_slots AS s ON s.id = h.slot_id
  WHERE b.event_date BETWEEN ?1 AND ?2
    AND (?3 IS NULL OR b.status = ?3)
  ORDER BY b.event_date ASC, b.created_at ASC, b.id ASC
  LIMIT ?4
`

interface ExportQuery {
  readonly from: string
  readonly to: string
  readonly status: BookingStatus | null
}

type Row = Record<string, unknown>

function invalidQueryResponse(): Response {
  return errorResponse(
    400,
    'INVALID_QUERY',
    'معايير التصدير غير صحيحة. اختاري الفترة والحالة من جديد.',
  )
}

function invalidDateResponse(): Response {
  return errorResponse(
    400,
    'INVALID_DATE',
    'يجب أن يكون التاريخ بصيغة YYYY-MM-DD وأن يمثل تاريخًا صحيحًا.',
  )
}

function invalidDateRangeResponse(): Response {
  return errorResponse(
    400,
    'INVALID_DATE_RANGE',
    'يجب أن يكون تاريخ البداية قبل تاريخ النهاية أو مساويًا له.',
  )
}

function invalidStatusResponse(): Response {
  return errorResponse(
    400,
    'INVALID_STATUS',
    'حالة الحجز المطلوبة غير صحيحة.',
  )
}

function exportTooLargeResponse(): Response {
  return errorResponse(
    400,
    'EXPORT_TOO_LARGE',
    'نطاق التصدير كبير جدًا. اختاري فترة لا تتجاوز 400 يوم ولا يزيد عدد حجوزاتها على 5000 حجز.',
  )
}

function isBookingStatus(value: unknown): value is BookingStatus {
  return bookingStatuses.some((status) => status === value)
}

/** A required date key; Arabic-Indic and Persian digits are accepted (N-05). */
function readDateKey(value: string | undefined): string | null {
  if (value === undefined) {
    return null
  }

  const ascii = toAsciiDigits(value)

  return isValidDateKey(ascii) ? ascii : null
}

/** Validates the query string; the response is the refusal. */
export function parseExportQuery(
  url: URL,
): { ok: true; query: ExportQuery } | { ok: false; response: Response } {
  const values = new Map<string, string>()

  for (const [key, value] of url.searchParams) {
    if (!EXPORT_QUERY_KEYS.has(key) || values.has(key)) {
      return { ok: false, response: invalidQueryResponse() }
    }

    values.set(key, value)
  }

  const from = readDateKey(values.get('from'))
  const to = readDateKey(values.get('to'))

  if (from === null || to === null) {
    return { ok: false, response: invalidDateResponse() }
  }

  const span = daysBetweenDateKeys(from, to)

  if (span === null || span < 0) {
    return { ok: false, response: invalidDateRangeResponse() }
  }

  if (span > MAXIMUM_EXPORT_SPAN_DAYS) {
    return { ok: false, response: exportTooLargeResponse() }
  }

  const statusValue = values.get('status')

  if (statusValue !== undefined && !isBookingStatus(statusValue)) {
    return { ok: false, response: invalidStatusResponse() }
  }

  return {
    ok: true,
    query: { from, to, status: statusValue ?? null },
  }
}

/** `bookings-YYYYMMDD-YYYYMMDD.csv`, from the two validated date keys only. */
export function exportFileName(from: string, to: string): string {
  return `bookings-${from.replaceAll('-', '')}-${to.replaceAll('-', '')}.csv`
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * An instant as Riyadh wall time, `YYYY-MM-DD HH:MM`, or '' when absent or
 * unreadable. A legacy `YYYY-MM-DD HH:MM:SS` (SQLite CURRENT_TIMESTAMP) is
 * UTC. Riyadh's offset is a whole number of hours with no daylight saving,
 * so the minutes are the UTC minutes.
 */
export function formatRiyadhInstant(value: string | null): string {
  if (value === null) {
    return ''
  }

  const legacy = LEGACY_SQL_TIMESTAMP.exec(value)
  const iso = legacy ? `${legacy[1]}T${legacy[2]}Z` : value

  if (!ISO_INSTANT.test(iso)) {
    return ''
  }

  const instant = new Date(iso)

  if (Number.isNaN(instant.getTime())) {
    return ''
  }

  return `${riyadhDateKey(instant)} ${twoDigits(riyadhHour(instant))}:${twoDigits(instant.getUTCMinutes())}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value))
}

function isHandoverMethod(value: unknown): value is 'pickup' | 'delivery' {
  return value === 'pickup' || value === 'delivery'
}

function readGalleryFacts(row: Row): JourneyGalleryFacts | null | undefined {
  const { galleryStatus, gallerySelectionDeadline, gallerySubmittedAt } = row

  if (galleryStatus === null) {
    return null
  }

  if (
    !isJourneyGalleryStatus(galleryStatus) ||
    !isNullableString(gallerySelectionDeadline) ||
    !isNullableString(gallerySubmittedAt)
  ) {
    return undefined
  }

  return {
    status: galleryStatus,
    selectionDeadline: gallerySelectionDeadline,
    submittedAt: gallerySubmittedAt,
  }
}

function readHandoverFacts(row: Row): JourneyHandoverFacts | null | undefined {
  const { handoverStatus, handoverStartsAt, handoverCompletedAt } = row

  if (handoverStatus === null) {
    return null
  }

  if (
    !isJourneyHandoverStatus(handoverStatus) ||
    !isNullableString(handoverStartsAt) ||
    !isNullableString(handoverCompletedAt)
  ) {
    return undefined
  }

  return {
    status: handoverStatus,
    slotStartsAt: handoverStartsAt,
    completedAt: handoverCompletedAt,
  }
}

/**
 * One D1 row as its CSV cells, or null when any column has a shape the
 * schema forbids (D1 rows are a trust boundary; the caller fails the
 * export rather than write a partial file).
 */
export function exportRowCells(row: Row, now: Date): CsvCell[] | null {
  const {
    id,
    createdAt,
    eventDate,
    status,
    flowVersion,
    packageName,
    estimatedTotal,
    depositAmount,
    depositReceivedAmount,
    depositReceivedAt,
    holdExpiresAt,
    completedAt,
    termsVersion,
    termsAcceptedAt,
    firstName,
    lastName,
    phone,
    email,
    latestReceiptStatus,
    hasEventProfile,
    albumStage,
    handoverMethod,
  } = row
  const gallery = readGalleryFacts(row)
  const handover = readHandoverFacts(row)

  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(createdAt) ||
    !isNonEmptyString(eventDate) ||
    !isBookingStatus(status) ||
    !isFlowVersion(flowVersion) ||
    !isNullableString(packageName) ||
    typeof estimatedTotal !== 'number' ||
    !Number.isSafeInteger(estimatedTotal) ||
    !isNullableSafeInteger(depositAmount) ||
    !isNullableSafeInteger(depositReceivedAmount) ||
    !isNullableString(depositReceivedAt) ||
    !isNullableString(holdExpiresAt) ||
    !isNullableString(completedAt) ||
    !isNullableString(termsVersion) ||
    !isNullableString(termsAcceptedAt) ||
    typeof firstName !== 'string' ||
    typeof lastName !== 'string' ||
    typeof phone !== 'string' ||
    typeof email !== 'string' ||
    (latestReceiptStatus !== null &&
      !isJourneyReceiptStatus(latestReceiptStatus)) ||
    (hasEventProfile !== 0 && hasEventProfile !== 1) ||
    (albumStage !== null && !isJourneyAlbumStage(albumStage)) ||
    (handoverMethod !== null && !isHandoverMethod(handoverMethod)) ||
    gallery === undefined ||
    handover === undefined
  ) {
    return null
  }

  const facts: JourneyFacts = {
    status,
    flowVersion,
    eventDate,
    holdExpiresAt,
    completedAt,
    latestReceiptStatus,
    hasEventProfile: hasEventProfile === 1,
    gallery,
    albumStage,
    handover,
  }
  const { stage } = deriveJourneyStage(facts, now)

  return [
    csvText(id),
    csvText(formatRiyadhInstant(createdAt)),
    csvText(eventDate),
    csvText(status),
    csvText(exportStatusLabels[status]),
    csvText(stage === null ? null : journeyStageLabels[stage]),
    csvText(packageName),
    csvInteger(estimatedTotal),
    csvInteger(depositAmount),
    csvInteger(depositReceivedAmount),
    csvText(formatRiyadhInstant(depositReceivedAt)),
    csvText(firstName),
    csvText(lastName),
    csvText(toAsciiDigits(phone).replace(NON_DIGITS, '')),
    csvText(email),
    csvText(termsVersion),
    csvText(formatRiyadhInstant(termsAcceptedAt)),
    csvText(handoverMethod === null ? null : handoverMethodLabels[handoverMethod]),
    csvText(formatRiyadhInstant(handover?.slotStartsAt ?? null)),
    csvText(albumStage === null ? null : productionStageLabels[albumStage]),
  ]
}

function csvResponse(body: string, fileName: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      'Strict-Transport-Security': STRICT_TRANSPORT_SECURITY,
    },
  })
}

/** #38 GET handler. */
export async function handleBookingsExport(
  context: AdminPortalContext,
): Promise<Response> {
  const { env, url, admin } = context
  const reauthRefusal = requireRecentSignIn(admin)

  if (reauthRefusal) {
    return reauthRefusal
  }

  if ((await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited') {
    return rateLimitedResponse()
  }

  const parsed = parseExportQuery(url)

  if (!parsed.ok) {
    return parsed.response
  }

  const { from, to, status } = parsed.query
  const { results } = await env.DB.prepare(EXPORT_SQL)
    .bind(from, to, status, MAXIMUM_EXPORT_ROWS + 1)
    .all<Row>()

  if (results.length > MAXIMUM_EXPORT_ROWS) {
    return exportTooLargeResponse()
  }

  const now = new Date()
  const rows: CsvCell[][] = []

  for (const row of results) {
    const cells = exportRowCells(row, now)

    if (cells === null) {
      throw new TypeError('Export: a booking row has an unexpected shape.')
    }

    rows.push(cells)
  }

  const body = buildCsvDocument(EXPORT_COLUMNS, rows)
  const audit = await auditStatement(
    env.DB,
    { uid: admin.uid, reauthAt: reauthAtFromToken(admin) },
    bookingsExportedAudit({ from, to, status, rows: rows.length }),
  ).run()

  if (audit.meta.changes !== 1) {
    throw new Error('Export: the audit row was not written.')
  }

  return csvResponse(body, exportFileName(from, to))
}
