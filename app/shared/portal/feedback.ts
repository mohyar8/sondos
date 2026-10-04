import {
  countCodePoints,
  normalizeFreeText,
  type FreeTextRule,
} from '../text.js'

/**
 * Private feedback contract (plan 11 §3.2 #12 and #25, §3.3 #12; API
 * contract 07 §3.H; decision D7, HND-09: never published). Shared by the
 * Worker, which has the final word, and the customer's feedback form, which
 * shows the same verdict before sending. Pure functions: no I/O, no
 * logging; a comment is never echoed in an error, only a problem code.
 *
 * One row per booking (feedback.booking_id is the primary key). The limits
 * below equal the feedback CHECKs of 0005_portal_schema.sql, so a value
 * these guards accept is a value the database accepts. The comment is plain
 * text from the customer: every surface renders it as text (React text in
 * `<bdi>`, never HTML, markdown or a link; SB-6, TM-12), and no endpoint,
 * email or page publishes it.
 */

export const FEEDBACK_RATING_MIN = 1
export const FEEDBACK_RATING_MAX = 5

/** feedback.comment: `length(comment) BETWEEN 1 AND 1000`, or NULL. */
export const FEEDBACK_COMMENT_MAX_CODE_POINTS = 1000

/**
 * The comment through the shared text validator (SB-16, TM-12): multi-line,
 * bidi and format characters refused, NFC, trimmed. A comment that shows
 * nothing is accepted and stored as no comment.
 */
export const FEEDBACK_COMMENT_RULE: FreeTextRule = {
  kind: 'multi-line',
  maxCodePoints: FEEDBACK_COMMENT_MAX_CODE_POINTS,
  minCodePoints: 0,
}

/**
 * POST body cap in UTF-8 bytes. The longest valid comment written with
 * JSON escapes only (`🌸` is 12 bytes for one code point) is
 * 12,000 bytes; the rest is the keys, the rating and the braces.
 */
export const FEEDBACK_BODY_MAX_BYTES = 12_288

/** Exact key set of the POST body (07 §3.H.1): `rating` required. */
export const FEEDBACK_BODY_REQUIRED_KEYS = ['rating'] as const
/** `comment` may be left out, null, or text. */
export const FEEDBACK_BODY_OPTIONAL_KEYS = ['comment'] as const

export type FeedbackRating = 1 | 2 | 3 | 4 | 5

/** The error codes of #12 beyond the common ones (plan 11 §3.1; 07 §6). */
export const feedbackErrorCodes = [
  'FIELD_TOO_LONG',
  'INVALID_TEXT',
  'NOT_YET_HANDED_OVER',
  'FEEDBACK_ALREADY_SUBMITTED',
] as const

export type FeedbackErrorCode = (typeof feedbackErrorCodes)[number]

/** One booking's feedback as every endpoint returns it (07 §3.H). */
export interface FeedbackView {
  readonly rating: FeedbackRating
  /** Plain text, 1 to 1000 code points, or null. Render as text only. */
  readonly comment: string | null
  /** When it was first submitted: an ISO instant (UTC, milliseconds). */
  readonly submittedAt: string
}

/** A validated submission, ready to store and to compare on a retry. */
export interface FeedbackSubmission {
  readonly rating: FeedbackRating
  readonly comment: string | null
}

/**
 * Why a submission was refused:
 * - 'invalid-body': the rating is not an integer from 1 to 5, or the
 *   comment is neither text nor null (400 INVALID_REQUEST_BODY);
 * - 'invalid-text': a forbidden character (400 INVALID_TEXT);
 * - 'too-long': over 1000 code points (400 FIELD_TOO_LONG).
 */
export type FeedbackSubmissionProblem =
  | 'invalid-body'
  | 'invalid-text'
  | 'too-long'

export type FeedbackSubmissionResult =
  | { readonly ok: true; readonly submission: FeedbackSubmission }
  | { readonly ok: false; readonly problem: FeedbackSubmissionProblem }

/** `YYYY-MM-DDTHH:MM:SS.sssZ`, the only instant form the table stores. */
const STORED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** A JSON number that is a whole rating from 1 to 5 (no string, no 4.5). */
export function isFeedbackRating(value: unknown): value is FeedbackRating {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= FEEDBACK_RATING_MIN &&
    value <= FEEDBACK_RATING_MAX
  )
}

/**
 * Validates the fields of a POST body whose key set the Worker has already
 * checked (exact keys, byte cap). The comment is normalised by the shared
 * text validator; the returned value is the one to store and compare.
 */
export function validateFeedbackSubmission(
  body: Readonly<Record<string, unknown>>,
): FeedbackSubmissionResult {
  const { rating } = body
  const comment = 'comment' in body ? body.comment : null

  if (!isFeedbackRating(rating)) {
    return { ok: false, problem: 'invalid-body' }
  }

  if (comment === null) {
    return { ok: true, submission: { rating, comment: null } }
  }

  const normalized = normalizeFreeText(comment, FEEDBACK_COMMENT_RULE)

  if (!normalized.ok) {
    switch (normalized.problem) {
      case 'too-long':
        return { ok: false, problem: 'too-long' }
      case 'forbidden-character':
      case 'link-or-handle':
        return { ok: false, problem: 'invalid-text' }
      case 'not-text':
      case 'empty':
      case 'too-short':
        return { ok: false, problem: 'invalid-body' }
    }
  }

  return {
    ok: true,
    submission: {
      rating,
      comment: normalized.value === '' ? null : normalized.value,
    },
  }
}

/**
 * Compare-on-retry (07 §3.H.1): a retry is the same submission only when
 * the rating and the normalised comment are both identical.
 */
export function isSameFeedback(
  stored: FeedbackSubmission,
  submission: FeedbackSubmission,
): boolean {
  return (
    stored.rating === submission.rating &&
    stored.comment === submission.comment
  )
}

function isStoredComment(value: unknown): value is string | null {
  if (value === null) {
    return true
  }

  if (typeof value !== 'string') {
    return false
  }

  const length = countCodePoints(value)

  return length >= 1 && length <= FEEDBACK_COMMENT_MAX_CODE_POINTS
}

function isStoredInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    STORED_INSTANT.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

/**
 * The `feedback` value of a response (or of a D1 row mapped to the same
 * keys): a FeedbackView, null for none, or undefined when it has another
 * shape. Only the three known keys are read and copied.
 */
export function parseFeedbackView(
  value: unknown,
): FeedbackView | null | undefined {
  if (value === null) {
    return null
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const rating = 'rating' in value ? value.rating : undefined
  const comment = 'comment' in value ? value.comment : undefined
  const submittedAt = 'submittedAt' in value ? value.submittedAt : undefined

  if (
    !isFeedbackRating(rating) ||
    !isStoredComment(comment) ||
    !isStoredInstant(submittedAt)
  ) {
    return undefined
  }

  return { rating, comment, submittedAt }
}

export interface FeedbackResponse {
  readonly feedback: FeedbackView | null
}

/**
 * Parser for the success body of GET/POST #12 and GET #25
 * (`{ "ok": true, "feedback": null | {…} }`), in the shape of the SPA's
 * ApiResponseParser: null when the body does not match.
 */
export function parseFeedbackResponse(
  body: Readonly<Record<string, unknown>>,
): FeedbackResponse | null {
  const feedback = parseFeedbackView(body.feedback)

  return feedback === undefined ? null : { feedback }
}
