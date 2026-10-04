export interface ApiErrorBody {
  ok: false
  error: {
    code: string
    message: string
  }
}

/**
 * HSTS on every API response (audit SEC-12, C-9). Two years, subdomains
 * included. No `preload` yet: that is added, together with the same header
 * on the static site in public/_headers, when the custom domain is final.
 * jsonResponse sets it after the caller's headers, like nosniff and
 * no-store, so no caller can weaken them.
 */
const STRICT_TRANSPORT_SECURITY = 'max-age=63072000; includeSubDomains'
const DECLARED_LENGTH_PATTERN = /^\d{1,15}$/
const JSON_MEDIA_TYPE = 'application/json'

export function jsonResponse(
  payload: unknown,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders)

  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', 'no-store')
  headers.set('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY)

  return new Response(JSON.stringify(payload), {
    status,
    headers,
  })
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  additionalHeaders?: HeadersInit,
): Response {
  const body: ApiErrorBody = {
    ok: false,
    error: {
      code,
      message,
    },
  }

  return jsonResponse(body, status, additionalHeaders)
}

export function methodNotAllowedResponse(
  allowedMethods: readonly string[],
): Response {
  return errorResponse(
    405,
    'METHOD_NOT_ALLOWED',
    'طريقة الطلب غير مسموحة.',
    {
      Allow: allowedMethods.join(', '),
    },
  )
}

/** 413 for a JSON body over its handler's byte cap (audit SEC-05). */
export function payloadTooLargeResponse(): Response {
  return errorResponse(
    413,
    'PAYLOAD_TOO_LARGE',
    'حجم البيانات المرسلة أكبر من المسموح.',
  )
}

/** True when the request's media type (parameters ignored) is application/json. */
export function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get('Content-Type')

  return (
    contentType?.split(';', 1)[0]?.trim().toLowerCase() === JSON_MEDIA_TYPE
  )
}

export type BoundedBytesResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly failure: 'too-large' | 'invalid' }

/**
 * Reads the body while counting bytes and stops (cancelling the stream) as
 * soon as it exceeds `maximumBytes`, so an absent or understated
 * Content-Length (a chunked request) cannot get more than the cap through.
 * An empty body is invalid.
 */
export async function readBoundedBytes(
  request: Request,
  maximumBytes: number,
): Promise<BoundedBytesResult> {
  if (!request.body) {
    return { ok: false, failure: 'invalid' }
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0

  for (;;) {
    const chunk = await reader.read()

    if (chunk.done) {
      break
    }

    const value: unknown = chunk.value

    if (!(value instanceof Uint8Array)) {
      await reader.cancel()

      return { ok: false, failure: 'invalid' }
    }

    receivedBytes += value.byteLength

    if (receivedBytes > maximumBytes) {
      await reader.cancel()

      return { ok: false, failure: 'too-large' }
    }

    chunks.push(value)
  }

  if (receivedBytes === 0) {
    return { ok: false, failure: 'invalid' }
  }

  const bytes = new Uint8Array(receivedBytes)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return { ok: true, bytes }
}

export type JsonBodyReadResult =
  | {
      readonly kind: 'parsed'
      /** Untrusted: validate every value with a runtime guard before use. */
      readonly value: unknown
    }
  | {
      readonly kind: 'unsupported-media-type' | 'too-large' | 'invalid'
    }

/**
 * The one JSON body reader for every handler (audit SEC-05, C-5). Order of
 * checks: `application/json` → declared Content-Length, when present
 * (malformed → invalid, over the cap → too-large, before a byte is read) →
 * bytes read under the cap → strict UTF-8 → JSON. Each handler maps the
 * failure kinds to its own responses (415, 413 or its documented 400) and
 * never puts the body, or any part of it, into the answer.
 */
export async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<JsonBodyReadResult> {
  if (!isJsonContentType(request)) {
    return { kind: 'unsupported-media-type' }
  }

  const declaredLength = request.headers.get('Content-Length')

  if (declaredLength !== null) {
    const trimmedLength = declaredLength.trim()

    if (!DECLARED_LENGTH_PATTERN.test(trimmedLength)) {
      return { kind: 'invalid' }
    }

    if (Number(trimmedLength) > maximumBytes) {
      return { kind: 'too-large' }
    }
  }

  const read = await readBoundedBytes(request, maximumBytes)

  if (!read.ok) {
    return { kind: read.failure }
  }

  let text: string

  try {
    text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(read.bytes)
  } catch (error) {
    if (error instanceof TypeError) {
      return { kind: 'invalid' }
    }

    throw error
  }

  try {
    const value: unknown = JSON.parse(text)

    return { kind: 'parsed', value }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: 'invalid' }
    }

    throw error
  }
}

/**
 * Wave 0's name for readBoundedJson, still imported by
 * worker/admin-workflow.ts and worker/portal/request.ts (whose own
 * readJsonBody adds the exact key sets). The same function, not a copy.
 */
export const readJsonBody = readBoundedJson
