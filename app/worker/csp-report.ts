import { CSP_REPORT_ROWS_PER_DAY_MAX } from '../shared/limits.js'
import { riyadhTodayKey } from '../shared/timing.js'
import {
  errorResponse,
  jsonResponse,
  methodNotAllowedResponse,
  payloadTooLargeResponse,
  readBoundedBytes,
} from './http.js'
import {
  connectingIpKey,
  limitBurst,
  rateLimitedResponse,
} from './rate-limit.js'

/**
 * POST /api/csp-report (plan 11 §3.2 #45; C-10, TM-14, TM-17): the
 * report-to / report-uri endpoint of the site's Content-Security-Policy.
 *
 * Public and unauthenticated (browsers send reports without credentials),
 * so it is bounded instead: a per-IP burst (RL_CSP_REPORT), a body of at
 * most 8 KiB read under the cap, at most MAXIMUM_REPORTS_PER_REQUEST reports
 * read from it, and at most CSP_REPORT_ROWS_PER_DAY_MAX rows a day, counted
 * inside the writing statement.
 *
 * Nothing of a report is kept but a count per (Riyadh day, directive,
 * blocked origin). The directive is one of the CSP directive names below or
 * "other"; the blocked URI is reduced to its scheme://host[:port] origin or
 * to a keyword (inline, eval, data, …). Document URLs, paths, query strings,
 * source files, samples, referrers and user agents are never read into a
 * statement or a log line, so a violation on a page whose URL carries
 * personal data leaves none of it here. Nothing is logged at all.
 */

/** UTF-8 bytes of one POST; a browser's batch of CSP reports is far smaller. */
const MAXIMUM_REPORT_BODY_BYTES = 8_192
/** Reports read from one body; the rest of a longer batch is ignored. */
const MAXIMUM_REPORTS_PER_REQUEST = 20
/** Longer blocked URIs are not parsed (a URL has no reason to be longer). */
const MAXIMUM_BLOCKED_URI_LENGTH = 2_048
/** csp_report_counts.count CHECK (migration 0009). */
const MAXIMUM_COUNT = 1_000_000
const DECLARED_LENGTH_PATTERN = /^\d{1,15}$/

/** The Reporting API (report-to) and the legacy report-uri media types. */
const REPORTS_MEDIA_TYPE = 'application/reports+json'
const CSP_REPORT_MEDIA_TYPE = 'application/csp-report'

/**
 * Directive names that may be stored. Anything else a report names is
 * counted as OTHER_DIRECTIVE, so a forged report cannot write a free string
 * into the table.
 */
const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set([
  'base-uri',
  'child-src',
  'connect-src',
  'default-src',
  'fenced-frame-src',
  'font-src',
  'form-action',
  'frame-ancestors',
  'frame-src',
  'img-src',
  'manifest-src',
  'media-src',
  'object-src',
  'prefetch-src',
  'require-trusted-types-for',
  'sandbox',
  'script-src',
  'script-src-attr',
  'script-src-elem',
  'style-src',
  'style-src-attr',
  'style-src-elem',
  'trusted-types',
  'upgrade-insecure-requests',
  'worker-src',
])
const OTHER_DIRECTIVE = 'other'

/**
 * Non-URL values browsers put in blocked-uri / blockedURL, stored as they
 * are (letters and '-' only, as the table's CHECK requires).
 */
const BLOCKED_KEYWORDS: ReadonlySet<string> = new Set([
  'blob',
  'data',
  'eval',
  'inline',
  'self',
  'trusted-types-policy',
  'trusted-types-sink',
  'wasm-eval',
])
/** URL schemes whose origin (scheme://host[:port]) is stored. */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'ws',
  'wss',
])
/** Other URL schemes stored as the bare scheme name. */
const SCHEME_KEYWORDS: ReadonlySet<string> = new Set([
  'about',
  'blob',
  'data',
  'filesystem',
])
const EXTENSION_SCHEME_SUFFIX = '-extension'
const EXTENSION_ORIGIN = 'extension'
const UNKNOWN_ORIGIN = 'unknown'
const OTHER_ORIGIN = 'other'
/**
 * The origin shape csp_report_counts accepts (migration 0009): a lower-case
 * scheme, '://', a host of lower-case letters, digits, '.' and '-', and an
 * optional port; nothing after the authority. IP-literal (IPv6) hosts and
 * anything longer than 120 characters are counted as OTHER_ORIGIN.
 */
const STORABLE_ORIGIN = /^[a-z]+:\/\/[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/
const MAXIMUM_ORIGIN_LENGTH = 120

/**
 * One count row per (day, directive, blocked origin), raised by ?4. A new
 * row is written only while the day has fewer than ?5 rows; an existing row
 * always counts up, never past the CHECK's ceiling ?6. The cap is evaluated
 * inside the statement, so concurrent reports cannot pass it together, and
 * every number is a bound parameter (SB-4).
 */
const UPSERT_COUNT_SQL = `
  INSERT INTO csp_report_counts (day, directive, blocked_origin, count)
  SELECT ?1, ?2, ?3, CAST(?4 AS INTEGER)
  WHERE EXISTS (
    SELECT 1
    FROM csp_report_counts
    WHERE day = ?1 AND directive = ?2 AND blocked_origin = ?3
  ) OR (SELECT COUNT(*) FROM csp_report_counts WHERE day = ?1) < ?5
  ON CONFLICT (day, directive, blocked_origin)
  DO UPDATE SET count = min(csp_report_counts.count + excluded.count, ?6)
`

interface ViolationCount {
  readonly directive: string
  readonly blockedOrigin: string
  count: number
}

type ParsedReports =
  | { readonly ok: true; readonly violations: readonly ViolationCount[] }
  | { readonly ok: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The request's media type, lower case, parameters dropped. */
function mediaTypeOf(request: Request): string {
  return (
    request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ??
    ''
  )
}

/**
 * The stored directive: a known directive name, OTHER_DIRECTIVE for any
 * other name, or null when the report names none. A legacy
 * violated-directive may carry its source list ("script-src 'self'"); only
 * the name is read.
 */
function directiveOf(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const name = value.trim().split(/\s/, 1)[0]?.toLowerCase() ?? ''

  if (name === '') {
    return null
  }

  return KNOWN_DIRECTIVES.has(name) ? name : OTHER_DIRECTIVE
}

/** The origin of a network URL when the table can store it, else OTHER_ORIGIN. */
function storableOrigin(url: URL): string {
  const origin = url.origin.toLowerCase()

  return origin.length <= MAXIMUM_ORIGIN_LENGTH && STORABLE_ORIGIN.test(origin)
    ? origin
    : OTHER_ORIGIN
}

/**
 * The stored form of a blocked URI: a keyword, the scheme name of a
 * non-network URL, or the origin of a network URL. Its path, query,
 * fragment and credentials are dropped here and never reach the database.
 */
function blockedOriginOf(value: unknown): string {
  if (typeof value !== 'string') {
    return UNKNOWN_ORIGIN
  }

  const text = value.trim()

  if (text === '') {
    return UNKNOWN_ORIGIN
  }

  const keyword = text.toLowerCase()

  if (BLOCKED_KEYWORDS.has(keyword)) {
    return keyword
  }

  if (text.length > MAXIMUM_BLOCKED_URI_LENGTH) {
    return OTHER_ORIGIN
  }

  let url: URL

  try {
    url = new URL(text)
  } catch (error) {
    if (error instanceof TypeError) {
      return OTHER_ORIGIN
    }

    throw error
  }

  const scheme = url.protocol.slice(0, -1)

  if (NETWORK_SCHEMES.has(scheme)) {
    return storableOrigin(url)
  }

  if (SCHEME_KEYWORDS.has(scheme)) {
    return scheme
  }

  if (scheme.endsWith(EXTENSION_SCHEME_SUFFIX)) {
    return EXTENSION_ORIGIN
  }

  return OTHER_ORIGIN
}

/**
 * The (directive, blocked origin) pair of one report body, or null when it
 * names no directive. Reporting API bodies use effectiveDirective /
 * blockedURL; legacy csp-report objects use effective-directive (or, in
 * older browsers, violated-directive) / blocked-uri.
 */
function violationOf(
  directiveValue: unknown,
  fallbackDirectiveValue: unknown,
  blockedValue: unknown,
): Omit<ViolationCount, 'count'> | null {
  const directive =
    directiveOf(directiveValue) ?? directiveOf(fallbackDirectiveValue)

  if (directive === null) {
    return null
  }

  return {
    directive,
    blockedOrigin: blockedOriginOf(blockedValue),
  }
}

/** The report objects of a body, per its media type, or null for a wrong shape. */
function violationsOf(
  mediaType: string,
  value: unknown,
): Array<Omit<ViolationCount, 'count'> | null> | null {
  if (mediaType === CSP_REPORT_MEDIA_TYPE) {
    if (!isRecord(value) || !isRecord(value['csp-report'])) {
      return null
    }

    const report = value['csp-report']

    return [
      violationOf(
        report['effective-directive'],
        report['violated-directive'],
        report['blocked-uri'],
      ),
    ]
  }

  if (!Array.isArray(value)) {
    return null
  }

  const violations: Array<Omit<ViolationCount, 'count'> | null> = []

  // Other report types in the same batch (deprecation, intervention, …)
  // are skipped; they are not CSP violations.
  for (const entry of value.slice(0, MAXIMUM_REPORTS_PER_REQUEST)) {
    if (
      !isRecord(entry) ||
      entry.type !== 'csp-violation' ||
      !isRecord(entry.body)
    ) {
      continue
    }

    violations.push(
      violationOf(
        entry.body.effectiveDirective,
        entry.body.violatedDirective,
        entry.body.blockedURL,
      ),
    )
  }

  return violations
}

/**
 * Parses the bounded body (strict UTF-8, then JSON) and folds its reports
 * into one count per (directive, blocked origin).
 */
function parseReports(mediaType: string, bytes: Uint8Array): ParsedReports {
  let value: unknown

  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
    )
  } catch (error) {
    // TextDecoder throws a TypeError for invalid UTF-8, JSON.parse a
    // SyntaxError for invalid JSON.
    if (error instanceof TypeError || error instanceof SyntaxError) {
      return { ok: false }
    }

    throw error
  }

  const violations = violationsOf(mediaType, value)

  if (violations === null) {
    return { ok: false }
  }

  const counts = new Map<string, ViolationCount>()

  for (const violation of violations) {
    if (violation === null) {
      continue
    }

    // A space can occur in neither part, so the key is unambiguous.
    const key = `${violation.directive} ${violation.blockedOrigin}`
    const existing = counts.get(key)

    if (existing) {
      existing.count += 1
    } else {
      counts.set(key, { ...violation, count: 1 })
    }
  }

  return { ok: true, violations: [...counts.values()] }
}

/**
 * 204 with the API's standard headers (nosniff, no-store and HSTS, taken
 * from jsonResponse in worker/http.ts so they cannot drift) and no body.
 */
function noContentResponse(): Response {
  const headers = new Headers(jsonResponse(null).headers)

  headers.delete('Content-Type')

  return new Response(null, { status: 204, headers })
}

function invalidReportResponse(): Response {
  return errorResponse(
    400,
    'INVALID_REQUEST_BODY',
    'تعذر قراءة التقرير المرسل.',
  )
}

export async function handleCspReport(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowedResponse(['POST'])
  }

  // Before the body is read, so a flood costs one limiter call per request.
  if (
    (await limitBurst(env.RL_CSP_REPORT, connectingIpKey(request))) ===
    'limited'
  ) {
    return rateLimitedResponse()
  }

  const mediaType = mediaTypeOf(request)

  if (
    mediaType !== REPORTS_MEDIA_TYPE &&
    mediaType !== CSP_REPORT_MEDIA_TYPE
  ) {
    return errorResponse(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'نوع بيانات التقرير غير مدعوم.',
    )
  }

  const declaredLength = request.headers.get('Content-Length')

  if (declaredLength !== null) {
    const trimmedLength = declaredLength.trim()

    if (!DECLARED_LENGTH_PATTERN.test(trimmedLength)) {
      return invalidReportResponse()
    }

    if (Number(trimmedLength) > MAXIMUM_REPORT_BODY_BYTES) {
      return payloadTooLargeResponse()
    }
  }

  // The hard bound: an absent or understated Content-Length stops here.
  const body = await readBoundedBytes(request, MAXIMUM_REPORT_BODY_BYTES)

  if (!body.ok) {
    return body.failure === 'too-large'
      ? payloadTooLargeResponse()
      : invalidReportResponse()
  }

  const parsed = parseReports(mediaType, body.bytes)

  if (!parsed.ok) {
    return invalidReportResponse()
  }

  if (parsed.violations.length === 0) {
    return noContentResponse()
  }

  const day = riyadhTodayKey()
  const upsert = env.DB.prepare(UPSERT_COUNT_SQL)

  // One batch: its statements run in order in one transaction, so each
  // new-row check sees the rows the statements before it wrote.
  await env.DB.batch(
    parsed.violations.map((violation) =>
      upsert.bind(
        day,
        violation.directive,
        violation.blockedOrigin,
        violation.count,
        CSP_REPORT_ROWS_PER_DAY_MAX,
        MAXIMUM_COUNT,
      ),
    ),
  )

  return noContentResponse()
}
