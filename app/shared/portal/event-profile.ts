import { normalizeFreeText, toAsciiDigits, type FreeTextRule } from '../text.js'
import { isValidLocalTime } from '../timing.js'

/**
 * Event profile and publishing consent contracts (plan 11 §3.2 #6–#8 and
 * #22, §3.3; decision D2; TM-08, TM-11, TM-12, SB-3, SB-13, SB-16). Shared
 * by the Worker, which has the final word, and the customer and admin
 * views, which show the same verdict before saving. Pure functions: no I/O,
 * no logging; a free-text value is never echoed in an error, only the
 * field name and the problem.
 *
 * Every limit equals the CHECK on its column (0005_portal_schema.sql,
 * event_profiles and booking_consents), so a value these guards accept is a
 * value the database accepts. Venue, area and special requests are the
 * bride's personal data: they are shown as plain text, never logged, never
 * copied into booking_events, and purged on schedule (text_purged_at).
 *
 * Consent defaults to NO by construction: no booking_consents row means no
 * consent, and a withdrawal only ever turns an existing grant off.
 */

// ---------------------------------------------------------------------------
// Vocabulary and limits
// ---------------------------------------------------------------------------

/** The consent purpose this API writes (booking_consents.purpose). */
export const PUBLISH_PHOTOS_PURPOSE = 'publish_photos'

/**
 * The version of the consent wording the customer view shows. A grant is
 * accepted only for this version (409 CONSENT_TEXT_OUTDATED otherwise);
 * change it together with the wording, never one without the other.
 * booking_consents.text_version CHECK: 1–32 of [0-9A-Za-z._-].
 */
export const CONSENT_TEXT_VERSION = 'consent-v1'

const CONSENT_TEXT_VERSION_PATTERN = /^[0-9A-Za-z._-]{1,32}$/

/**
 * The free-text fields (event_profiles CHECKs: venue_name and venue_area
 * 1–120, special_requests 1–1000 code points). minCodePoints 0: a blank
 * value clears the field (stored as NULL), like an explicit null.
 */
export const EVENT_PROFILE_TEXT_RULES = {
  venueName: { kind: 'single-line', minCodePoints: 0, maxCodePoints: 120 },
  venueArea: { kind: 'single-line', minCodePoints: 0, maxCodePoints: 120 },
  specialRequests: {
    kind: 'multi-line',
    minCodePoints: 0,
    maxCodePoints: 1000,
  },
} as const satisfies Record<string, FreeTextRule>

export const EVENT_PROFILE_FIELDS = [
  'venueName',
  'venueArea',
  'startTime',
  'specialRequests',
] as const

export type EventProfileField = (typeof EVENT_PROFILE_FIELDS)[number]

export const CONSENT_UPDATE_FIELDS = [
  'purpose',
  'granted',
  'textVersion',
] as const

/**
 * Body caps in UTF-8 bytes. The event profile allows its longest legal
 * body even with every character sent as a JSON \u escape (1,240 code
 * points × 12 bytes, plus the keys); the consent body is three short keys.
 */
export const EVENT_PROFILE_BODY_MAX_BYTES = 16 * 1024
export const CONSENT_BODY_MAX_BYTES = 256

/** Longest raw start time read at all, before digits are normalised. */
const MAXIMUM_START_TIME_INPUT_LENGTH = 16

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** A validated PUT event-profile body; null clears a field. */
export interface EventProfileInput {
  readonly venueName: string | null
  readonly venueArea: string | null
  /** `HH:MM`, 24 h, ASCII digits. */
  readonly startTime: string | null
  readonly specialRequests: string | null
}

/**
 * The 400 codes of #7 (plan 11 §3.3): INVALID_REQUEST_BODY for a wrong
 * shape or type, and the field codes for the rest.
 */
export type EventProfileInputErrorCode =
  | 'INVALID_REQUEST_BODY'
  | 'FIELD_TOO_LONG'
  | 'INVALID_TIME_FORMAT'
  | 'INVALID_TEXT'

/** The per-field issue of the optional `details` array (07 §1.2). */
export type EventProfileFieldIssue = 'TOO_LONG' | 'INVALID_TIME' | 'INVALID_TEXT'

export type EventProfileInputResult =
  | { readonly ok: true; readonly value: EventProfileInput }
  | {
      readonly ok: false
      readonly code: EventProfileInputErrorCode
      /** The body key at fault, or null for the body as a whole. */
      readonly field: EventProfileField | null
      readonly issue: EventProfileFieldIssue | null
    }

function invalidProfile(
  code: EventProfileInputErrorCode,
  field: EventProfileField | null,
  issue: EventProfileFieldIssue | null,
): EventProfileInputResult {
  return { ok: false, code, field, issue }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Exactly these own keys, no other (SB-3; `__proto__` counts as a key). */
function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value)

  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

type TextFieldResult =
  | { readonly ok: true; readonly value: string | null }
  | {
      readonly ok: false
      readonly code: EventProfileInputErrorCode
      readonly issue: EventProfileFieldIssue | null
    }

type TextFieldFailure = Extract<TextFieldResult, { readonly ok: false }>

/** A wrong type names no field: the body as a whole is malformed. */
function fieldFailure(
  field: EventProfileField,
  failure: TextFieldFailure,
): EventProfileInputResult {
  return invalidProfile(
    failure.code,
    failure.code === 'INVALID_REQUEST_BODY' ? null : field,
    failure.issue,
  )
}

function readOptionalText(value: unknown, rule: FreeTextRule): TextFieldResult {
  if (value === null) {
    return { ok: true, value: null }
  }

  const result = normalizeFreeText(value, rule)

  if (result.ok) {
    return { ok: true, value: result.value === '' ? null : result.value }
  }

  switch (result.problem) {
    case 'not-text':
      return { ok: false, code: 'INVALID_REQUEST_BODY', issue: null }
    case 'too-long':
      return { ok: false, code: 'FIELD_TOO_LONG', issue: 'TOO_LONG' }
    case 'empty':
    case 'too-short':
    case 'forbidden-character':
    case 'link-or-handle':
      return { ok: false, code: 'INVALID_TEXT', issue: 'INVALID_TEXT' }
  }
}

/**
 * The start time: null, a blank string (cleared) or `HH:MM` 00:00–23:59,
 * Arabic-Indic and Persian digits accepted (UX-07).
 */
function readStartTime(value: unknown): TextFieldResult {
  if (value === null) {
    return { ok: true, value: null }
  }

  if (typeof value !== 'string') {
    return { ok: false, code: 'INVALID_REQUEST_BODY', issue: null }
  }

  if (value.length > MAXIMUM_START_TIME_INPUT_LENGTH) {
    return { ok: false, code: 'INVALID_TIME_FORMAT', issue: 'INVALID_TIME' }
  }

  const time = toAsciiDigits(value).trim()

  if (time === '') {
    return { ok: true, value: null }
  }

  return isValidLocalTime(time)
    ? { ok: true, value: time }
    : { ok: false, code: 'INVALID_TIME_FORMAT', issue: 'INVALID_TIME' }
}

/**
 * PUT event-profile: `{ "venueName", "venueArea", "startTime",
 * "specialRequests" }`, every key required, each a string or null. Every
 * text passes the shared validator (TM-12, SB-16); the first field at
 * fault, in the order above, decides the answer.
 */
export function parseEventProfileInput(body: unknown): EventProfileInputResult {
  if (!isRecord(body) || !hasExactKeys(body, EVENT_PROFILE_FIELDS)) {
    return invalidProfile('INVALID_REQUEST_BODY', null, null)
  }

  const venueName = readOptionalText(
    body.venueName,
    EVENT_PROFILE_TEXT_RULES.venueName,
  )

  if (!venueName.ok) {
    return fieldFailure('venueName', venueName)
  }

  const venueArea = readOptionalText(
    body.venueArea,
    EVENT_PROFILE_TEXT_RULES.venueArea,
  )

  if (!venueArea.ok) {
    return fieldFailure('venueArea', venueArea)
  }

  const startTime = readStartTime(body.startTime)

  if (!startTime.ok) {
    return fieldFailure('startTime', startTime)
  }

  const specialRequests = readOptionalText(
    body.specialRequests,
    EVENT_PROFILE_TEXT_RULES.specialRequests,
  )

  if (!specialRequests.ok) {
    return fieldFailure('specialRequests', specialRequests)
  }

  return {
    ok: true,
    value: {
      venueName: venueName.value,
      venueArea: venueArea.value,
      startTime: startTime.value,
      specialRequests: specialRequests.value,
    },
  }
}

/** A validated PUT consent body. */
export interface ConsentUpdateInput {
  readonly purpose: typeof PUBLISH_PHOTOS_PURPOSE
  readonly granted: boolean
  /** Well formed; whether it is the current version is the Worker's call. */
  readonly textVersion: string
}

export type ConsentUpdateResult =
  | { readonly ok: true; readonly value: ConsentUpdateInput }
  | { readonly ok: false; readonly code: 'INVALID_REQUEST_BODY' }

/**
 * PUT consent: `{ "purpose": "publish_photos", "granted": boolean,
 * "textVersion": string }`, exactly these keys.
 */
export function parseConsentUpdateInput(body: unknown): ConsentUpdateResult {
  if (!isRecord(body) || !hasExactKeys(body, CONSENT_UPDATE_FIELDS)) {
    return { ok: false, code: 'INVALID_REQUEST_BODY' }
  }

  const { purpose, granted, textVersion } = body

  if (
    purpose !== PUBLISH_PHOTOS_PURPOSE ||
    typeof granted !== 'boolean' ||
    typeof textVersion !== 'string' ||
    !CONSENT_TEXT_VERSION_PATTERN.test(textVersion)
  ) {
    return { ok: false, code: 'INVALID_REQUEST_BODY' }
  }

  return {
    ok: true,
    value: { purpose: PUBLISH_PHOTOS_PURPOSE, granted, textVersion },
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * #7: the profile is editable while the booking is confirmed and its event
 * day (Riyadh) has not passed. `todayKey` is riyadhTodayKey(now) (M2,
 * N-59), never the UTC date. The Worker re-checks both inside its write.
 */
export function isEventProfileEditable(
  status: string,
  eventDate: string,
  todayKey: string,
): boolean {
  return status === 'confirmed' && todayKey <= eventDate
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** #6 `eventProfile`: null until the first save. */
export interface EventProfile {
  readonly venueName: string | null
  readonly venueArea: string | null
  readonly startTime: string | null
  readonly specialRequests: string | null
  /** ISO-8601 UTC instant of the last change. */
  readonly updatedAt: string
}

/** #6 `consent.publishPhotos`: granted false and updatedAt null = no row. */
export interface PublishPhotosConsent {
  readonly granted: boolean
  readonly textVersion: string
  readonly updatedAt: string | null
}

/** #6 GET event-profile. */
export interface EventProfileView {
  readonly eventProfile: EventProfile | null
  readonly consent: {
    readonly publishPhotos: PublishPhotosConsent
  }
  /** isEventProfileEditable for the booking, now. */
  readonly editable: boolean
  /** `YYYY-MM-DD`, the event day. */
  readonly eventDate: string
}

/** #8 PUT consent. */
export interface ConsentUpdateView {
  readonly consent: {
    readonly publishPhotos: PublishPhotosConsent
  }
}

/** The booking_events kinds the admin history lists. */
export const EVENT_PROFILE_HISTORY_EVENTS = [
  'event_profile_saved',
  'consent_granted',
  'consent_withdrawn',
] as const

export type EventProfileHistoryEvent =
  (typeof EVENT_PROFILE_HISTORY_EVENTS)[number]

export function isEventProfileHistoryEvent(
  value: unknown,
): value is EventProfileHistoryEvent {
  return EVENT_PROFILE_HISTORY_EVENTS.some((event) => event === value)
}

/** One change, newest first; kinds and instants only (SB-13). */
export interface EventProfileHistoryEntry {
  readonly event: EventProfileHistoryEvent
  readonly createdAt: string
}

/** The longest history #22 returns. */
export const EVENT_PROFILE_HISTORY_LIMIT = 50

/**
 * #22 `consent.publishPhotos`. `grantedAt` is the instant of the grant in
 * force, or null: with it the admin view shows «موافقة على النشر من
 * العروس، لم يؤكدها الاستوديو بعد» (TM-08); the studio still confirms with
 * the bride before publishing any photo.
 */
export interface AdminPublishPhotosConsent extends PublishPhotosConsent {
  readonly grantedAt: string | null
}

/** #22 GET /api/admin/bookings/{id}/event-profile. */
export interface AdminEventProfileView {
  readonly eventProfile: EventProfile | null
  /** True once the free text was purged (retention); the row stays. */
  readonly textPurged: boolean
  readonly consent: {
    readonly publishPhotos: AdminPublishPhotosConsent
  }
  readonly history: readonly EventProfileHistoryEntry[]
  readonly eventDate: string
}

// ---------------------------------------------------------------------------
// Error messages (fixed Arabic strings, feminine address)
// ---------------------------------------------------------------------------

export const EVENT_PROFILE_ERROR_MESSAGES = {
  FIELD_TOO_LONG: 'أحد الحقول يتجاوز الحد الأقصى المسموح به لعدد الأحرف.',
  INVALID_TIME_FORMAT: 'صيغة الوقت غير صحيحة. الرجاء استخدام الصيغة HH:MM.',
  INVALID_TEXT: 'يحتوي النص على رموز غير مسموح بها.',
  BOOKING_NOT_CONFIRMED: 'هذا الإجراء متاح فقط للحجوزات المؤكدة.',
  EVENT_DATE_PASSED: 'انتهى موعد تعديل تفاصيل المناسبة.',
  CONSENT_TEXT_OUTDATED:
    'تم تحديث نص الموافقة على النشر. حدّثي الصفحة وراجعي النص الحالي ثم أعيدي المحاولة.',
} as const
