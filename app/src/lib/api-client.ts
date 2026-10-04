import { useMemo } from 'react'
import { useAuth } from '../auth/auth-context'
import {
  ACCOUNT_ERASED_MESSAGE,
  SESSION_ENDED_MESSAGE,
  apiClientFailureMessages,
  isServerLimitCode,
  serverLimitCodeForStatus,
  serverLimitMessages,
  serverStatusFallbackMessage,
  toCurrentServerErrorCode,
} from './server-error-messages'

/**
 * The SPA's typed client for the Worker's API (ADR-001 W3-7 T1; v2: plan 11
 * W1-07).
 *
 * - Four ways in: `request` (JSON), `postJson`, `requestBlob` (a file such as
 *   the CSV export; its Content-Type is checked) and `upload` (multipart
 *   through XMLHttpRequest, with progress and abort). JSON requests may ask
 *   for `keepalive` (a notice sent from the click that opens WhatsApp).
 * - Only a same-origin `/api/` path is ever requested (isSameOriginApiPath,
 *   `mode: 'same-origin'`; a redirect is never followed by fetch, and an
 *   upload's redirected answer is never read). The Firebase ID token goes
 *   in the `Authorization` header only, never in a URL. It comes from
 *   `useAuth().getIdToken` (the single AuthProvider); this module never
 *   touches Firebase itself.
 * - A token that cannot be obtained right now (offline, a Firebase hiccup, a
 *   session still restoring) is reported as `TOKEN_UNAVAILABLE`, a retryable
 *   error. Nothing here ever signs her out: only an explicit action in the UI
 *   may do that (inspection defect #7).
 * - Reads the JSON envelope of worker/http.ts: `{ ok: true, …fields }` or
 *   `{ ok: false, error: { code, message } }` (07-api-contracts §1.2). Every
 *   success body goes through the caller's own parser, so no response is
 *   trusted by shape alone, and no `as` cast is needed anywhere.
 * - Error contract (plan 11 §3.1, R-05): 403 REAUTH_REQUIRED (401 from a
 *   Wave 0 Worker) opens the AuthProvider's password prompt and, once she has
 *   confirmed it, sends the same request ONE more time with a fresh token; if
 *   she closes the prompt, REAUTH_REQUIRED is returned. Any other 401 reads
 *   as UNAUTHORIZED: the session is gone and the screen offers sign-in.
 *   SECOND_FACTOR_REQUIRED, OPEN_REQUEST_LIMIT, DATE_BEYOND_HORIZON and the
 *   Worker's limits carry the wording of lib/server-error-messages.ts; Wave 0
 *   names (ADMIN_MFA_REQUIRED, TOO_MANY_OPEN_REQUESTS, BOOKING_TOO_FAR_AHEAD)
 *   read as the plan's.
 * - Honours an AbortSignal: an aborted request resolves to `ABORTED`, which
 *   the UI should ignore (the component that started it has moved on).
 * - Logs nothing: tokens, bodies and URLs never reach the console.
 */

/** Only same-origin API paths can carry her token. */
export type ApiPath = `/api/${string}`

export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * A JSON-serialisable request body. Describe request bodies with `type`
 * aliases (not `interface`s) so they are assignable to this type.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** Failures decided in the browser, before or instead of a server answer. */
export const apiClientErrorCodes = [
  /** No ID token right now. Retryable; never a reason to sign her out. */
  'TOKEN_UNAVAILABLE',
  /** The request never reached the Worker, or its answer never arrived. */
  'NETWORK_ERROR',
  /** The caller aborted the request. Not an error to show. */
  'ABORTED',
  /** The Worker answered, but not with the expected JSON or file type. */
  'MALFORMED_RESPONSE',
  /** Refused before sending: the path is not a same-origin `/api/` path. */
  'INVALID_REQUEST',
] as const

export type ApiClientErrorCode = (typeof apiClientErrorCodes)[number]

/**
 * Server codes any authenticated endpoint may return, reused unchanged from
 * the existing API (07-api-contracts §1.5 and §6) plus plan 11 §3.1.
 */
export const commonApiErrorCodes = [
  /** 401: the session is gone (any 401 other than REAUTH_REQUIRED). */
  'UNAUTHORIZED',
  'EMAIL_NOT_VERIFIED',
  'FORBIDDEN',
  'PROFILE_REQUIRED',
  'BOOKING_NOT_FOUND',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'UNSUPPORTED_MEDIA_TYPE',
  'INVALID_JSON',
  'INVALID_REQUEST_BODY',
  'INVALID_STATUS_TRANSITION',
  'INTERNAL_ERROR',
  /** 403: a recent sign-in is required and she did not confirm it. */
  'REAUTH_REQUIRED',
  /** 403: an admin action that needs the authenticator-app sign-in. */
  'SECOND_FACTOR_REQUIRED',
  /** 429: a Worker rate limit. */
  'RATE_LIMITED',
  /** 413: the body (a form or an uploaded file) is over the Worker's byte cap. */
  'PAYLOAD_TOO_LARGE',
  /** 403: the browse-only preview accepts no writes. */
  'PREVIEW_READ_ONLY',
  /** 410: the account's data was erased at her request (final). */
  'ACCOUNT_ERASED',
  /** 409: she already has three open booking requests. */
  'OPEN_REQUEST_LIMIT',
  /** 400: the event date is past the booking horizon. */
  'DATE_BEYOND_HORIZON',
  /** 503: a gated feature is closed (plan 11 §4). */
  'SERVICE_UNAVAILABLE',
] as const

export type CommonApiErrorCode = (typeof commonApiErrorCodes)[number]

/** A server error whose code neither list above nor the caller names. */
export type UnrecognizedApiErrorCode = 'UNRECOGNIZED_ERROR'

export type ApiServerErrorCode<Code extends string = never> =
  | CommonApiErrorCode
  | Code
  | UnrecognizedApiErrorCode

export type ApiError<Code extends string = never> =
  | {
      readonly source: 'client'
      readonly code: ApiClientErrorCode
      readonly status: null
      /** Arabic, safe to show as text. */
      readonly message: string
      /** True when the same request may succeed if she simply tries again. */
      readonly retryable: boolean
    }
  | {
      readonly source: 'server'
      readonly code: ApiServerErrorCode<Code>
      readonly status: number
      /** The Worker's Arabic message, or an Arabic fallback. Show as text. */
      readonly message: string
      readonly retryable: boolean
    }

export type ApiResult<T, Code extends string = never> =
  | {
      readonly ok: true
      readonly data: T
      readonly status: number
      /** Device clock (ms) when the response arrived, for server-time offsets. */
      readonly receivedAtMs: number
    }
  | { readonly ok: false; readonly error: ApiError<Code> }

export interface ApiResponseMeta {
  readonly status: number
  readonly receivedAtMs: number
}

/**
 * Turns a success body (whose `ok: true` is already checked) into `T`, or
 * returns null when it does not match; null becomes MALFORMED_RESPONSE.
 */
export type ApiResponseParser<T> = (
  body: Readonly<Record<string, unknown>>,
  meta: ApiResponseMeta,
) => T | null

export interface ApiRequestOptions<T, Code extends string = never> {
  /** Defaults to GET. */
  readonly method?: ApiMethod
  /**
   * `/api/...` only. Encode every dynamic segment with encodeURIComponent,
   * e.g. `/api/bookings/${encodeURIComponent(bookingId)}/handover`. Never
   * put search text, a token or personal data in it (SB-12).
   */
  readonly path: ApiPath
  /** Sent as `application/json`. Omit for GET and DELETE. */
  readonly body?: JsonValue
  readonly signal?: AbortSignal
  /**
   * Lets the request outlive the page (fetch `keepalive`), for a small
   * notice sent from the same click that opens WhatsApp. Browsers cap
   * keepalive bodies at 64 KiB in total.
   */
  readonly keepalive?: boolean
  readonly parse: ApiResponseParser<T>
  /** Endpoint-specific server codes this caller handles by name. */
  readonly errorCodes?: readonly Code[]
}

export type ApiPostJsonOptions<T, Code extends string = never> = Omit<
  ApiRequestOptions<T, Code>,
  'method' | 'path' | 'body'
>

/** A file from the Worker whose type was checked (requestBlob). */
export interface ApiBlob {
  readonly blob: Blob
  /** The response's media type, lower-case and without parameters. */
  readonly contentType: string
  /**
   * The Content-Disposition file name when it is plain ASCII (letters,
   * digits, `.`, `_`, `-`), else null: pick your own then.
   */
  readonly fileName: string | null
}

/** A GET for a file, e.g. `/api/admin/exports/bookings.csv?from=&to=`. */
export interface ApiBlobRequestOptions<Code extends string = never> {
  readonly path: ApiPath
  /**
   * The media types the caller accepts, e.g. `['text/csv']`. Any other
   * Content-Type on a success is MALFORMED_RESPONSE; nothing is guessed.
   */
  readonly accept: readonly [string, ...string[]]
  readonly signal?: AbortSignal
  readonly errorCodes?: readonly Code[]
}

export interface ApiUploadProgress {
  /** Request bytes sent so far. */
  readonly loadedBytes: number
  /** The whole request's size, or null when the browser cannot tell. */
  readonly totalBytes: number | null
}

export interface ApiUploadOptions<T, Code extends string = never> {
  /** Defaults to POST. */
  readonly method?: 'POST' | 'PUT'
  readonly path: ApiPath
  /** Sent as `multipart/form-data`; the browser sets the boundary. */
  readonly body: FormData
  readonly signal?: AbortSignal
  /**
   * Called as request bytes go out. A retry after re-authentication starts
   * again from zero.
   */
  readonly onProgress?: (progress: ApiUploadProgress) => void
  readonly parse: ApiResponseParser<T>
  readonly errorCodes?: readonly Code[]
}

/** Resolves to her current ID token, or null when none is available. */
export type IdTokenProvider = () => Promise<string | null>

/**
 * Asks her to confirm her password (useAuth().requestReauthentication).
 * Resolves true once she has re-authenticated, false otherwise; it must
 * never reject.
 */
export type ReauthenticationProvider = () => Promise<boolean>

/**
 * What a request needs to recover from REAUTH_REQUIRED on its own: the
 * password prompt, and a fresh token for the one retry. Both come from
 * useAuth(), for the request modules that take a token directly (api/*.ts).
 */
export interface ApiSession {
  readonly getIdToken: IdTokenProvider
  readonly requestReauthentication: ReauthenticationProvider
}

export interface ApiClient {
  request<T, Code extends string = never>(
    options: ApiRequestOptions<T, Code>,
  ): Promise<ApiResult<T, Code>>
  postJson<T, Code extends string = never>(
    path: ApiPath,
    body: JsonValue,
    options: ApiPostJsonOptions<T, Code>,
  ): Promise<ApiResult<T, Code>>
  requestBlob<Code extends string = never>(
    options: ApiBlobRequestOptions<Code>,
  ): Promise<ApiResult<ApiBlob, Code>>
  upload<T, Code extends string = never>(
    options: ApiUploadOptions<T, Code>,
  ): Promise<ApiResult<T, Code>>
}

const MAXIMUM_SERVER_MESSAGE_LENGTH = 500
/** Longer than any Firebase ID token. */
const MAXIMUM_ID_TOKEN_LENGTH = 16_384
/** The characters of a JWT (base64url parts joined by dots). */
const ID_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/
const MAXIMUM_API_PATH_LENGTH = 2_048
/** Any fixed origin: isSameOriginApiPath only compares the path it keeps. */
const PATH_CHECK_BASE = 'https://api.invalid'
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONTENT_DISPOSITION_FILE_NAME_PATTERN =
  /(?:^|;)\s*filename\s*=\s*"([^"]*)"\s*(?:;|$)/i

const clientErrorMessages: Readonly<Record<ApiClientErrorCode, string>> =
  apiClientFailureMessages

const clientErrorRetryable: Readonly<Record<ApiClientErrorCode, boolean>> = {
  TOKEN_UNAVAILABLE: true,
  NETWORK_ERROR: true,
  ABORTED: false,
  MALFORMED_RESPONSE: true,
  INVALID_REQUEST: false,
}

/**
 * True for a path this client may send her token to: it starts with `/api/`
 * and the URL parser keeps it exactly as written, so it carries no scheme or
 * host, no `.`/`..` segment (encoded or not), no backslash, fragment,
 * whitespace, control or non-ASCII character. It then resolves on this
 * page's own origin and inside the Worker's API.
 */
export function isSameOriginApiPath(path: string): path is ApiPath {
  if (
    !path.startsWith('/api/') ||
    path.length > MAXIMUM_API_PATH_LENGTH
  ) {
    return false
  }

  const url = new URL(path, PATH_CHECK_BASE)

  return (
    url.origin === PATH_CHECK_BASE &&
    url.hash === '' &&
    url.pathname.startsWith('/api/') &&
    `${url.pathname}${url.search}` === path
  )
}

/**
 * A token that can go in the header as it is: bounded, and only the
 * characters of a JWT. A charset check, not a verification (the Worker
 * verifies it).
 */
function isUsableIdToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAXIMUM_ID_TOKEN_LENGTH &&
    ID_TOKEN_PATTERN.test(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clientError<Code extends string>(
  code: ApiClientErrorCode,
): { readonly ok: false; readonly error: ApiError<Code> } {
  return {
    ok: false,
    error: {
      source: 'client',
      code,
      status: null,
      message: clientErrorMessages[code],
      retryable: clientErrorRetryable[code],
    },
  }
}

/** The listed code equal to `value`, found without widening casts. */
function findCode<Code extends string>(
  codes: readonly Code[],
  value: string,
): Code | null {
  for (const code of codes) {
    if (code === value) {
      return code
    }
  }

  return null
}

/** What a status means when the body carries no usable error envelope. */
function codeForStatus(status: number): CommonApiErrorCode | UnrecognizedApiErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'NOT_FOUND'
    case 405:
      return 'METHOD_NOT_ALLOWED'
    case 410:
      return 'ACCOUNT_ERASED'
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE'
    default:
      return (
        serverLimitCodeForStatus(status) ??
        (status >= 500 ? 'INTERNAL_ERROR' : 'UNRECOGNIZED_ERROR')
      )
  }
}

function readServerMessage(value: unknown, status: number): string {
  if (typeof value === 'string') {
    const message = value.trim()

    if (message.length > 0 && message.length <= MAXIMUM_SERVER_MESSAGE_LENGTH) {
      return message
    }
  }

  return serverStatusFallbackMessage(status)
}

function serverError<Code extends string>(
  status: number,
  body: unknown,
  errorCodes: readonly Code[],
): { readonly ok: false; readonly error: ApiError<Code> } {
  const envelope =
    isRecord(body) && body.ok === false && isRecord(body.error)
      ? body.error
      : null
  const rawCode =
    envelope !== null && typeof envelope.code === 'string'
      ? envelope.code
      : null
  const currentCode = rawCode === null ? null : toCurrentServerErrorCode(rawCode)
  let code: ApiServerErrorCode<Code> = codeForStatus(status)
  let message = serverStatusFallbackMessage(status)

  if (status === 401 && currentCode !== 'REAUTH_REQUIRED') {
    // Signed out: the token is missing, invalid, expired or revoked (plan 11
    // §3.1). One code and one message, whatever the route calls it
    // (UNAUTHORIZED for customers, UNAUTHENTICATED for the admin).
    code = 'UNAUTHORIZED'
    message = SESSION_ENDED_MESSAGE
  } else if (rawCode !== null && currentCode !== null) {
    code =
      findCode(commonApiErrorCodes, currentCode) ??
      findCode(errorCodes, currentCode) ??
      findCode(errorCodes, rawCode) ??
      'UNRECOGNIZED_ERROR'

    // A Worker limit, or an erased account, is shown in this app's own
    // words, whatever the caller lists.
    message = isServerLimitCode(currentCode)
      ? serverLimitMessages[currentCode]
      : code === 'ACCOUNT_ERASED'
        ? ACCOUNT_ERASED_MESSAGE
        : readServerMessage(envelope?.message, status)
  }

  return {
    ok: false,
    error: {
      source: 'server',
      code,
      status,
      message,
      retryable: status >= 500,
    },
  }
}

/** Read through a function so an earlier check never narrows a later one. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** How a request failed before the Worker answered (sendJsonWithToken). */
export type ApiTransportFailureCode = Extract<
  ApiClientErrorCode,
  'TOKEN_UNAVAILABLE' | 'INVALID_REQUEST' | 'NETWORK_ERROR' | 'ABORTED'
>

type Transport<V> =
  | { readonly ok: true; readonly value: V }
  | { readonly ok: false; readonly code: ApiTransportFailureCode }

/**
 * `fetch()` and body reads reject only with the signal's abort reason (an
 * AbortError DOMException unless the caller chose another) or a TypeError
 * (the network failed, or a redirect was refused), per the Fetch standard.
 * Anything else is not a transport failure: null, and the caller rethrows.
 */
function transportFailureCode(
  error: unknown,
  signal: AbortSignal | undefined,
): 'ABORTED' | 'NETWORK_ERROR' | null {
  if (
    isAborted(signal) ||
    (error instanceof DOMException && error.name === 'AbortError')
  ) {
    return 'ABORTED'
  }

  return error instanceof TypeError ? 'NETWORK_ERROR' : null
}

/** Runs one fetch and its body read; a transport failure becomes a code. */
async function settleTransport<V>(
  work: () => Promise<V>,
  signal: AbortSignal | undefined,
): Promise<Transport<V>> {
  try {
    return { ok: true, value: await work() }
  } catch (error: unknown) {
    const code = transportFailureCode(error, signal)

    if (code === null) {
      throw error
    }

    return { ok: false, code }
  }
}

type ParsedJson =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }

function parseJsonText(text: string): ParsedJson {
  if (text.length === 0) {
    return { ok: true, value: null }
  }

  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error: unknown) {
    // JSON.parse on a string can only throw a SyntaxError.
    if (error instanceof SyntaxError) {
      return { ok: false }
    }

    throw error
  }
}

/**
 * Her current ID token from `getIdToken`, or null when there is none or it
 * cannot be put in a header. A provider that fails with an Error has, by
 * definition, no token right now; the error is not logged (it may carry
 * account details). Anything else it throws is a defect and is rethrown.
 */
export async function readIdToken(
  getIdToken: IdTokenProvider,
): Promise<string | null> {
  let token: string | null

  try {
    token = await getIdToken()
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null
    }

    throw error
  }

  return isUsableIdToken(token) ? token : null
}

function authorizationHeaders(token: string, accept: string): Headers {
  return new Headers({
    Accept: accept,
    Authorization: `Bearer ${token}`,
  })
}

/** The fetch options every token-carrying request shares. */
function tokenRequestInit(
  method: string,
  headers: Headers,
  body: string | undefined,
  signal: AbortSignal | undefined,
  keepalive: boolean,
): RequestInit {
  return {
    method,
    headers,
    body,
    cache: 'no-store',
    credentials: 'same-origin',
    // The token never leaves this origin: no cross-origin request, and a
    // redirect (which the Worker never sends) fails instead of being followed.
    mode: 'same-origin',
    redirect: 'error',
    keepalive,
    signal,
  }
}

export interface TokenJsonRequest {
  readonly method: ApiMethod
  readonly path: ApiPath
  /** JSON text, sent as `application/json`. */
  readonly body?: string
  readonly signal?: AbortSignal
  readonly keepalive?: boolean
}

/** The Worker's answer before any envelope check. */
export type TokenJsonResponse =
  | {
      readonly ok: true
      readonly status: number
      /** The parsed JSON body; null when empty or not JSON. */
      readonly body: unknown
      readonly receivedAtMs: number
    }
  | { readonly ok: false; readonly code: ApiTransportFailureCode }

interface TextResponse {
  readonly status: number
  readonly text: string
  readonly receivedAtMs: number
}

async function sendTextRequest(
  token: string,
  request: TokenJsonRequest,
): Promise<Transport<TextResponse>> {
  const { method, path, body, signal, keepalive = false } = request

  if (!isSameOriginApiPath(path)) {
    return { ok: false, code: 'INVALID_REQUEST' }
  }

  if (!isUsableIdToken(token)) {
    return { ok: false, code: 'TOKEN_UNAVAILABLE' }
  }

  const headers = authorizationHeaders(token, 'application/json')

  if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }

  return settleTransport(async () => {
    const response = await fetch(
      path,
      tokenRequestInit(method, headers, body, signal, keepalive),
    )
    const text = await response.text()

    return { status: response.status, text, receivedAtMs: Date.now() }
  }, signal)
}

/**
 * One JSON request with a token the caller already holds (the api/*.ts
 * modules take it as an argument), under the same rules as apiRequest: a
 * same-origin `/api/` path, the token in the header only, no redirects, no
 * logging. No envelope check and no retry: the caller maps the answer.
 */
export async function sendJsonWithToken(
  token: string,
  request: TokenJsonRequest,
): Promise<TokenJsonResponse> {
  const sent = await sendTextRequest(token, request)

  if (!sent.ok) {
    return sent
  }

  const parsed = parseJsonText(sent.value.text)

  return {
    ok: true,
    status: sent.value.status,
    body: parsed.ok ? parsed.value : null,
    receivedAtMs: sent.value.receivedAtMs,
  }
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status <= 299
}

/** A text answer as an ApiResult: envelope, status and caller's parser. */
function readJsonResult<T, Code extends string>(
  sent: Transport<TextResponse>,
  parse: ApiResponseParser<T>,
  errorCodes: readonly Code[],
): ApiResult<T, Code> {
  if (!sent.ok) {
    return clientError(sent.code)
  }

  const { status, text, receivedAtMs } = sent.value
  const parsed = parseJsonText(text)

  if (!isSuccessStatus(status)) {
    return serverError(status, parsed.ok ? parsed.value : null, errorCodes)
  }

  if (!parsed.ok || !isRecord(parsed.value) || parsed.value.ok !== true) {
    return clientError('MALFORMED_RESPONSE')
  }

  const data = parse(parsed.value, { status, receivedAtMs })

  if (data === null) {
    return clientError('MALFORMED_RESPONSE')
  }

  return { ok: true, data, status, receivedAtMs }
}

function isReauthenticationError<T, Code extends string>(
  result: ApiResult<T, Code>,
): boolean {
  return (
    !result.ok &&
    result.error.source === 'server' &&
    (result.error.status === 403 || result.error.status === 401) &&
    result.error.code === 'REAUTH_REQUIRED'
  )
}

/**
 * Sends `send()` and, when its result says the Worker wants a recent sign-in
 * (REAUTH_REQUIRED), asks her to confirm her password and sends it ONE more
 * time; `send` must fetch a fresh token on each call. Declined, aborted or
 * without a provider: the first result is returned unchanged. The retry is
 * safe for writes too, because the Worker refuses REAUTH_REQUIRED before it
 * touches anything.
 */
export async function retryAfterReauthentication<R>(
  send: () => Promise<R>,
  isReauthenticationRequired: (result: R) => boolean,
  reauthenticate: ReauthenticationProvider | undefined,
  signal?: AbortSignal,
): Promise<R> {
  const firstResult = await send()

  if (
    reauthenticate === undefined ||
    !isReauthenticationRequired(firstResult) ||
    isAborted(signal)
  ) {
    return firstResult
  }

  const confirmed = await reauthenticate()

  return confirmed && !isAborted(signal) ? send() : firstResult
}

/**
 * The shared frame of every request below: abort and path checks, a fresh
 * token per attempt, the one retry after a confirmed re-authentication, and
 * ABORTED once the caller has moved on.
 */
async function withTokenAndRetry<T, Code extends string>(
  getIdToken: IdTokenProvider,
  reauthenticate: ReauthenticationProvider | undefined,
  path: string,
  signal: AbortSignal | undefined,
  send: (token: string) => Promise<ApiResult<T, Code>>,
): Promise<ApiResult<T, Code>> {
  const result = await retryAfterReauthentication(
    async (): Promise<ApiResult<T, Code>> => {
      if (isAborted(signal)) {
        return clientError('ABORTED')
      }

      // Checked before the token is read: a bad path never gets one.
      if (!isSameOriginApiPath(path)) {
        return clientError('INVALID_REQUEST')
      }

      const token = await readIdToken(getIdToken)

      // Checked again: she may have left while the token was being fetched.
      if (isAborted(signal)) {
        return clientError('ABORTED')
      }

      return token === null ? clientError('TOKEN_UNAVAILABLE') : send(token)
    },
    isReauthenticationError,
    reauthenticate,
    signal,
  )

  // Aborted while she was confirming her password: the caller moved on.
  return isAborted(signal) && !result.ok ? clientError('ABORTED') : result
}

/**
 * One JSON request to the Worker (sent a second time only after a confirmed
 * re-authentication, see retryAfterReauthentication). Resolves for every
 * failure the token provider, fetch or the Worker can report, so callers can
 * `void` it from an effect; only a defect (a non-Error thrown by the token
 * provider) rejects.
 */
export async function apiRequest<T, Code extends string = never>(
  getIdToken: IdTokenProvider,
  options: ApiRequestOptions<T, Code>,
  reauthenticate?: ReauthenticationProvider,
): Promise<ApiResult<T, Code>> {
  const {
    method = 'GET',
    path,
    body,
    signal,
    keepalive = false,
    parse,
    errorCodes = [],
  } = options
  const jsonBody = body === undefined ? undefined : JSON.stringify(body)

  return withTokenAndRetry(
    getIdToken,
    reauthenticate,
    path,
    signal,
    async (token) =>
      readJsonResult(
        await sendTextRequest(token, {
          method,
          path,
          body: jsonBody,
          signal,
          keepalive,
        }),
        parse,
        errorCodes,
      ),
  )
}

/** POST with a JSON body; otherwise exactly apiRequest. */
export function apiPostJson<T, Code extends string = never>(
  getIdToken: IdTokenProvider,
  path: ApiPath,
  body: JsonValue,
  options: ApiPostJsonOptions<T, Code>,
  reauthenticate?: ReauthenticationProvider,
): Promise<ApiResult<T, Code>> {
  return apiRequest(
    getIdToken,
    { ...options, method: 'POST', path, body },
    reauthenticate,
  )
}

/** The media type of a Content-Type value: lower-case, no parameters. */
function mediaTypeEssence(value: string | null): string | null {
  if (value === null) {
    return null
  }

  const essence = value.split(';', 1)[0].trim().toLowerCase()

  return essence.length > 0 ? essence : null
}

function readAttachmentFileName(value: string | null): string | null {
  if (value === null) {
    return null
  }

  const match = CONTENT_DISPOSITION_FILE_NAME_PATTERN.exec(value)
  const fileName = match?.[1] ?? ''

  return SAFE_FILE_NAME_PATTERN.test(fileName) && !fileName.includes('..')
    ? fileName
    : null
}

type BlobResponse =
  | {
      readonly kind: 'file'
      readonly status: number
      readonly blob: Blob
      readonly contentType: string
      readonly fileName: string | null
      readonly receivedAtMs: number
    }
  | {
      readonly kind: 'unexpected-type'
    }
  | {
      readonly kind: 'error'
      readonly status: number
      readonly text: string
    }

/**
 * A file from the Worker (e.g. GET /api/admin/exports/bookings.csv). The
 * success body is read only when its Content-Type is one the caller
 * accepts; an error answer is the usual JSON envelope. Same token, path,
 * retry and abort rules as apiRequest.
 */
export async function apiRequestBlob<Code extends string = never>(
  getIdToken: IdTokenProvider,
  options: ApiBlobRequestOptions<Code>,
  reauthenticate?: ReauthenticationProvider,
): Promise<ApiResult<ApiBlob, Code>> {
  const { path, accept, signal, errorCodes = [] } = options
  const acceptedTypes = accept.map((type) => type.trim().toLowerCase())

  return withTokenAndRetry(
    getIdToken,
    reauthenticate,
    path,
    signal,
    async (token): Promise<ApiResult<ApiBlob, Code>> => {
      const headers = authorizationHeaders(
        token,
        [...acceptedTypes, 'application/json'].join(', '),
      )
      const sent = await settleTransport(async (): Promise<BlobResponse> => {
        const response = await fetch(
          path,
          tokenRequestInit('GET', headers, undefined, signal, false),
        )

        if (!isSuccessStatus(response.status)) {
          return {
            kind: 'error',
            status: response.status,
            text: await response.text(),
          }
        }

        const contentType = mediaTypeEssence(
          response.headers.get('Content-Type'),
        )

        if (contentType === null || !acceptedTypes.includes(contentType)) {
          // Not read: a type she did not ask for is never handed on.
          await response.body?.cancel()
          return { kind: 'unexpected-type' }
        }

        return {
          kind: 'file',
          status: response.status,
          blob: await response.blob(),
          contentType,
          fileName: readAttachmentFileName(
            response.headers.get('Content-Disposition'),
          ),
          receivedAtMs: Date.now(),
        }
      }, signal)

      if (!sent.ok) {
        return clientError(sent.code)
      }

      const answer = sent.value

      switch (answer.kind) {
        case 'error': {
          const parsed = parseJsonText(answer.text)
          return serverError(
            answer.status,
            parsed.ok ? parsed.value : null,
            errorCodes,
          )
        }
        case 'unexpected-type':
          return clientError('MALFORMED_RESPONSE')
        case 'file':
          return {
            ok: true,
            data: {
              blob: answer.blob,
              contentType: answer.contentType,
              fileName: answer.fileName,
            },
            status: answer.status,
            receivedAtMs: answer.receivedAtMs,
          }
      }
    },
  )
}

/**
 * One multipart request through XMLHttpRequest (fetch reports no upload
 * progress). The URL is built on this page's own origin, so no <base>
 * element can redirect it. XMLHttpRequest cannot refuse a redirect the way
 * fetch does (`redirect: 'error'`), so an answer from any other URL is read
 * as NETWORK_ERROR, never parsed. Every handler is detached, and the abort
 * listener removed, once it settles.
 */
function sendMultipart(
  token: string,
  method: 'POST' | 'PUT',
  path: ApiPath,
  body: FormData,
  signal: AbortSignal | undefined,
  onProgress: ((progress: ApiUploadProgress) => void) | undefined,
): Promise<Transport<TextResponse>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    const url = `${window.location.origin}${path}`
    let settled = false

    const abortUpload = () => {
      xhr.abort()
    }

    const finish = (result: Transport<TextResponse>) => {
      if (settled) {
        return
      }

      settled = true
      signal?.removeEventListener('abort', abortUpload)
      xhr.upload.onprogress = null
      xhr.onload = null
      xhr.onerror = null
      xhr.ontimeout = null
      xhr.onabort = null
      resolve(result)
    }

    xhr.open(method, url)
    xhr.responseType = 'text'
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    if (onProgress !== undefined) {
      xhr.upload.onprogress = (event) => {
        onProgress({
          loadedBytes: event.loaded,
          totalBytes: event.lengthComputable ? event.total : null,
        })
      }
    }

    xhr.onload = () => {
      // Status 0 is a request that never got an answer; another final URL
      // is a redirect the Worker never sends.
      finish(
        xhr.status === 0 || xhr.responseURL !== url
          ? { ok: false, code: 'NETWORK_ERROR' }
          : {
              ok: true,
              value: {
                status: xhr.status,
                text: xhr.responseText,
                receivedAtMs: Date.now(),
              },
            },
      )
    }
    xhr.onerror = () => {
      finish({
        ok: false,
        code: isAborted(signal) ? 'ABORTED' : 'NETWORK_ERROR',
      })
    }
    xhr.ontimeout = () => {
      finish({ ok: false, code: 'NETWORK_ERROR' })
    }
    xhr.onabort = () => {
      finish({ ok: false, code: 'ABORTED' })
    }

    signal?.addEventListener('abort', abortUpload, { once: true })
    xhr.send(body)
  })
}

/**
 * A multipart upload (receipt, gallery photo) with progress and abort. Same
 * token, path, retry and abort rules as apiRequest; the answer is the usual
 * JSON envelope, read by the caller's parser.
 */
export async function apiUpload<T, Code extends string = never>(
  getIdToken: IdTokenProvider,
  options: ApiUploadOptions<T, Code>,
  reauthenticate?: ReauthenticationProvider,
): Promise<ApiResult<T, Code>> {
  const {
    method = 'POST',
    path,
    body,
    signal,
    onProgress,
    parse,
    errorCodes = [],
  } = options

  return withTokenAndRetry(
    getIdToken,
    reauthenticate,
    path,
    signal,
    async (token) =>
      readJsonResult(
        await sendMultipart(token, method, path, body, signal, onProgress),
        parse,
        errorCodes,
      ),
  )
}

export function createApiClient(
  getIdToken: IdTokenProvider,
  reauthenticate?: ReauthenticationProvider,
): ApiClient {
  return {
    request<T, Code extends string = never>(
      options: ApiRequestOptions<T, Code>,
    ): Promise<ApiResult<T, Code>> {
      return apiRequest(getIdToken, options, reauthenticate)
    },
    postJson<T, Code extends string = never>(
      path: ApiPath,
      body: JsonValue,
      options: ApiPostJsonOptions<T, Code>,
    ): Promise<ApiResult<T, Code>> {
      return apiPostJson(getIdToken, path, body, options, reauthenticate)
    },
    requestBlob<Code extends string = never>(
      options: ApiBlobRequestOptions<Code>,
    ): Promise<ApiResult<ApiBlob, Code>> {
      return apiRequestBlob(getIdToken, options, reauthenticate)
    },
    upload<T, Code extends string = never>(
      options: ApiUploadOptions<T, Code>,
    ): Promise<ApiResult<T, Code>> {
      return apiUpload(getIdToken, options, reauthenticate)
    },
  }
}

/**
 * The API client bound to the signed-in account (stable across renders),
 * with the AuthProvider's password prompt for REAUTH_REQUIRED.
 */
export function useApiClient(): ApiClient {
  const { getIdToken, requestReauthentication } = useAuth()
  return useMemo(
    () => createApiClient(getIdToken, requestReauthentication),
    [getIdToken, requestReauthentication],
  )
}
