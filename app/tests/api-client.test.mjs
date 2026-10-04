// W1-07 / R-05, L1 (N-60), SB-12: the API client v2 and the admin parser.
// Every case below fails if its control (the same-origin /api/ path check,
// the token kept out of URLs, no redirects, the one re-auth retry on 403 or
// a Wave 0 401 REAUTH_REQUIRED, 401 read as signed out, the plan's codes and
// their one Arabic table, a 413 worded for a file as well as a form, the
// CSV Content-Type check, XHR progress and abort, keepalive, unknown admin
// actions skipped) is taken out of src/lib/api-client.ts,
// src/lib/server-error-messages.ts or src/api/admin.ts.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { afterEach, beforeEach, describe, test } from 'node:test'

// The SPA imports its own modules without an extension (bundler
// resolution); Node needs the `.ts` file named. Only relative specifiers
// that are missing as written are retried, and only as their `.ts` sibling.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ERR_MODULE_NOT_FOUND' ||
        !/^\.{1,2}\//.test(specifier)
      ) {
        throw error
      }

      const sibling = specifier.endsWith('.js')
        ? `${specifier.slice(0, -3)}.ts`
        : `${specifier}.ts`

      return nextResolve(sibling, context)
    }
  },
})

const client = await import('../src/lib/api-client.ts')
const messages = await import('../src/lib/server-error-messages.ts')
const admin = await import('../src/api/admin.ts')

const ORIGIN = 'https://sy.test'
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'
const FRESH_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1MSIsImZyZXNoIjp0cnVlfQ.c2ln'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const originalXhr = globalThis.XMLHttpRequest
const consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace']
const originalConsole = new Map(
  consoleMethods.map((name) => [name, console[name]]),
)

/** Every fetch the client made: [input, init]. */
let fetchCalls = []
/** Answers handed out in order, one per fetch. */
let fetchAnswers = []
let consoleOutput = []

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function errorEnvelope(status, code, message = 'رسالة الخادم') {
  return jsonResponse(status, { ok: false, error: { code, message } })
}

function answerWith(...answers) {
  fetchAnswers = answers
}

function tokenSequence(...tokens) {
  let index = 0
  const provider = async () => tokens[Math.min(index++, tokens.length - 1)]
  return provider
}

function countingReauthentication(answer) {
  const calls = { count: 0 }
  const provider = async () => {
    calls.count += 1
    return answer
  }
  return { calls, provider }
}

const parseEcho = (body) =>
  typeof body.value === 'string' ? { value: body.value } : null

beforeEach(() => {
  fetchCalls = []
  fetchAnswers = []
  consoleOutput = []
  globalThis.fetch = async (input, init) => {
    fetchCalls.push([input, init])

    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const answer = fetchAnswers.shift()

    if (answer === undefined) {
      throw new TypeError('Failed to fetch')
    }

    return typeof answer === 'function' ? answer(input, init) : answer
  }
  globalThis.window = { location: { origin: ORIGIN } }

  for (const name of consoleMethods) {
    console[name] = (...args) => {
      consoleOutput.push([name, args])
    }
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.window = originalWindow
  globalThis.XMLHttpRequest = originalXhr

  for (const [name, method] of originalConsole) {
    console[name] = method
  }

  // SB-7/SB-12: nothing the client does writes to the console.
  assert.deepEqual(consoleOutput, [])
})

describe('isSameOriginApiPath (only same-origin /api/ paths carry the token)', () => {
  test('accepts API paths with encoded segments and a query', () => {
    for (const path of [
      '/api/bookings/me',
      `/api/bookings/${encodeURIComponent('bk_1 2/3')}/handover`,
      `/api/admin/bookings?${new URLSearchParams({ status: 'pending_review', limit: '50' })}`,
      '/api/admin/exports/bookings.csv?from=2026-01-01&to=2026-02-01',
    ]) {
      assert.equal(client.isSameOriginApiPath(path), true, path)
    }
  })

  test('refuses anything that could leave the origin or the API', () => {
    for (const path of [
      'https://evil.test/api/bookings/me',
      '//evil.test/api/bookings/me',
      '/apix/bookings',
      '/api',
      '/api/../admin',
      '/api/./bookings/me',
      '/api/%2e%2e/admin',
      '/api/%2E%2E/%2e%2e/evil',
      '/api\\..\\admin',
      '/api/bookings\\me',
      '/api/bookings/me#fragment',
      '/api/bookings/me?q=a b',
      '/api/bookings/\tme',
      '/api/bookings/\nme',
      '/api/حجوزات',
      `/api/${'a'.repeat(2_100)}`,
    ]) {
      assert.equal(client.isSameOriginApiPath(path), false, JSON.stringify(path))
    }
  })

  test('a refused path never reads the token and never sends', async () => {
    let tokenReads = 0
    const result = await client.apiRequest(
      async () => {
        tokenReads += 1
        return TOKEN
      },
      { path: '/api/../admin', parse: parseEcho },
    )

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INVALID_REQUEST')
    assert.equal(result.error.source, 'client')
    assert.equal(tokenReads, 0)
    assert.equal(fetchCalls.length, 0)
  })
})

describe('apiRequest transport', () => {
  test('the token goes in the Authorization header only, same-origin, no redirects, no-store', async () => {
    answerWith(jsonResponse(200, { ok: true, value: 'x' }))
    const result = await client.apiRequest(async () => TOKEN, {
      path: '/api/bookings/me',
      parse: parseEcho,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.data, { value: 'x' })
    const [input, init] = fetchCalls[0]
    assert.equal(input, '/api/bookings/me')
    assert.equal(String(input).includes(TOKEN), false)
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${TOKEN}`)
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.keepalive, false)
  })

  test('keepalive is passed through; postJson sends a JSON POST', async () => {
    answerWith(jsonResponse(200, { ok: true, value: 'sent' }))
    const apiClient = client.createApiClient(async () => TOKEN)
    const result = await apiClient.postJson(
      '/api/bookings/b1/confirmation/whatsapp-notice',
      { channel: 'whatsapp' },
      { keepalive: true, parse: parseEcho },
    )

    assert.equal(result.ok, true)
    const [, init] = fetchCalls[0]
    assert.equal(init.method, 'POST')
    assert.equal(init.keepalive, true)
    assert.equal(init.body, '{"channel":"whatsapp"}')
    assert.equal(new Headers(init.headers).get('Content-Type'), 'application/json')
  })

  test('a token that cannot go in a header is TOKEN_UNAVAILABLE, nothing sent', async () => {
    for (const token of [null, '', 'abc def', 'abc\r\nX-Evil: 1', 'x'.repeat(20_000)]) {
      const result = await client.apiRequest(async () => token, {
        path: '/api/bookings/me',
        parse: parseEcho,
      })

      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'TOKEN_UNAVAILABLE')
    }

    assert.equal(fetchCalls.length, 0)
  })

  test('a token provider failing with an Error is TOKEN_UNAVAILABLE; a non-Error is rethrown', async () => {
    const failed = await client.apiRequest(
      async () => {
        throw new Error('auth/network-request-failed')
      },
      { path: '/api/bookings/me', parse: parseEcho },
    )
    assert.equal(failed.error.code, 'TOKEN_UNAVAILABLE')

    await assert.rejects(
      client.apiRequest(
        async () => {
          throw 'not an error'
        },
        { path: '/api/bookings/me', parse: parseEcho },
      ),
      (error) => error === 'not an error',
    )
  })

  test('a network failure and an abort resolve, never reject', async () => {
    answerWith()
    const failed = await client.apiRequest(async () => TOKEN, {
      path: '/api/bookings/me',
      parse: parseEcho,
    })
    assert.equal(failed.error.code, 'NETWORK_ERROR')
    assert.equal(failed.error.retryable, true)

    const controller = new AbortController()
    controller.abort()
    const aborted = await client.apiRequest(async () => TOKEN, {
      path: '/api/bookings/me',
      signal: controller.signal,
      parse: parseEcho,
    })
    assert.equal(aborted.error.code, 'ABORTED')
  })

  test('a success body the parser refuses is MALFORMED_RESPONSE', async () => {
    answerWith(jsonResponse(200, { ok: true, value: 42 }))
    const result = await client.apiRequest(async () => TOKEN, {
      path: '/api/bookings/me',
      parse: parseEcho,
    })
    assert.equal(result.error.code, 'MALFORMED_RESPONSE')
  })
})

describe('error contract (plan 11 §3.1, R-05)', () => {
  for (const status of [403, 401]) {
    test(`${status} REAUTH_REQUIRED opens the prompt once and retries once with a fresh token`, async () => {
      answerWith(
        errorEnvelope(status, 'REAUTH_REQUIRED'),
        jsonResponse(200, { ok: true, value: 'after' }),
      )
      const reauth = countingReauthentication(true)
      const result = await client.apiRequest(
        tokenSequence(TOKEN, FRESH_TOKEN),
        { method: 'PUT', path: '/api/bookings/b1/consent', body: { publishPhotos: true }, parse: parseEcho },
        reauth.provider,
      )

      assert.equal(result.ok, true)
      assert.equal(reauth.calls.count, 1)
      assert.equal(fetchCalls.length, 2)
      assert.equal(
        new Headers(fetchCalls[1][1].headers).get('Authorization'),
        `Bearer ${FRESH_TOKEN}`,
      )
    })
  }

  test('a second REAUTH_REQUIRED is returned, never a third attempt', async () => {
    answerWith(
      errorEnvelope(403, 'REAUTH_REQUIRED'),
      errorEnvelope(403, 'REAUTH_REQUIRED'),
      jsonResponse(200, { ok: true, value: 'never' }),
    )
    const reauth = countingReauthentication(true)
    const result = await client.apiRequest(
      async () => TOKEN,
      { path: '/api/admin/settings', parse: parseEcho },
      reauth.provider,
    )

    assert.equal(reauth.calls.count, 1)
    assert.equal(fetchCalls.length, 2)
    assert.equal(result.error.code, 'REAUTH_REQUIRED')
    assert.equal(result.error.message, messages.serverLimitMessages.REAUTH_REQUIRED)
  })

  test('a declined prompt returns REAUTH_REQUIRED with its Arabic message and no retry', async () => {
    answerWith(errorEnvelope(403, 'REAUTH_REQUIRED', 'Server words'))
    const reauth = countingReauthentication(false)
    const result = await client.apiRequest(
      async () => TOKEN,
      { path: '/api/admin/settings', parse: parseEcho },
      reauth.provider,
    )

    assert.equal(fetchCalls.length, 1)
    assert.equal(result.error.code, 'REAUTH_REQUIRED')
    assert.equal(result.error.status, 403)
    assert.equal(
      result.error.message,
      'لحماية الحساب، أعيدي إدخال كلمة المرور لإتمام هذا الإجراء.',
    )
  })

  test('any other 401 reads as signed out and never opens the prompt', async () => {
    for (const code of ['UNAUTHENTICATED', 'UNAUTHORIZED', 'TOKEN_REVOKED', null]) {
      answerWith(
        code === null
          ? new Response('', { status: 401 })
          : errorEnvelope(401, code),
      )
      const reauth = countingReauthentication(true)
      const result = await client.apiRequest(
        async () => TOKEN,
        { path: '/api/bookings/me', parse: parseEcho },
        reauth.provider,
      )

      assert.equal(reauth.calls.count, 0, String(code))
      assert.equal(result.error.code, 'UNAUTHORIZED')
      assert.equal(result.error.message, messages.SESSION_ENDED_MESSAGE)
    }
  })

  test('SECOND_FACTOR_REQUIRED (and Wave 0 ADMIN_MFA_REQUIRED) are recognised with the one message', async () => {
    for (const code of ['SECOND_FACTOR_REQUIRED', 'ADMIN_MFA_REQUIRED']) {
      answerWith(errorEnvelope(403, code, 'Server words'))
      const result = await client.apiRequest(async () => TOKEN, {
        path: '/api/admin/settings/bank',
        parse: parseEcho,
      })

      assert.equal(result.error.code, 'SECOND_FACTOR_REQUIRED')
      assert.equal(
        result.error.message,
        messages.serverLimitMessages.SECOND_FACTOR_REQUIRED,
      )
      assert.match(result.error.message, /^هذا الإجراء يتطلب التحقق بخطوتين لحساب الإدارة\./)
    }
  })

  test('OPEN_REQUEST_LIMIT (and Wave 0 TOO_MANY_OPEN_REQUESTS) map to the plan code and message', async () => {
    for (const code of ['OPEN_REQUEST_LIMIT', 'TOO_MANY_OPEN_REQUESTS']) {
      answerWith(errorEnvelope(409, code, 'Server words'))
      const result = await client.apiRequest(async () => TOKEN, {
        method: 'POST',
        path: '/api/bookings',
        body: {},
        parse: parseEcho,
      })

      assert.equal(result.error.code, 'OPEN_REQUEST_LIMIT')
      assert.equal(
        result.error.message,
        'لديكِ ثلاثة طلبات مفتوحة. انتظري الرد عليها قبل إرسال طلب جديد.',
      )
    }
  })

  test('RATE_LIMITED has its Arabic message with or without an envelope', async () => {
    answerWith(errorEnvelope(429, 'RATE_LIMITED', 'Too many'), new Response('<html>', { status: 429 }))

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await client.apiRequest(async () => TOKEN, {
        path: '/api/availability',
        parse: parseEcho,
      })

      assert.equal(result.error.code, 'RATE_LIMITED')
      assert.equal(
        result.error.message,
        'طلبات كثيرة خلال وقت قصير. حاولي مرة أخرى بعد قليل.',
      )
    }
  })

  test('a caller-listed code keeps the Worker message; an unlisted one is UNRECOGNIZED_ERROR', async () => {
    answerWith(
      errorEnvelope(409, 'HOLD_EXPIRED', 'انتهت مهلة الحجز المؤقت لهذا التاريخ.'),
      errorEnvelope(409, 'HOLD_EXPIRED', 'انتهت مهلة الحجز المؤقت لهذا التاريخ.'),
    )
    const listed = await client.apiRequest(async () => TOKEN, {
      path: '/api/bookings/b1/confirmation',
      parse: parseEcho,
      errorCodes: ['HOLD_EXPIRED'],
    })
    assert.equal(listed.error.code, 'HOLD_EXPIRED')
    assert.equal(listed.error.message, 'انتهت مهلة الحجز المؤقت لهذا التاريخ.')

    const unlisted = await client.apiRequest(async () => TOKEN, {
      path: '/api/bookings/b1/confirmation',
      parse: parseEcho,
    })
    assert.equal(unlisted.error.code, 'UNRECOGNIZED_ERROR')
  })
})

describe('requestBlob (CSV export)', () => {
  test('a text/csv answer is returned as a Blob with a safe file name', async () => {
    answerWith(
      new Response('﻿"ref"\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bookings-20260101-20260201.csv"',
        },
      }),
    )
    const apiClient = client.createApiClient(async () => TOKEN)
    const result = await apiClient.requestBlob({
      path: '/api/admin/exports/bookings.csv?from=2026-01-01&to=2026-02-01',
      accept: ['text/csv'],
    })

    assert.equal(result.ok, true)
    assert.equal(result.data.contentType, 'text/csv')
    assert.equal(result.data.fileName, 'bookings-20260101-20260201.csv')
    // The bytes as sent, byte-order mark included (Blob.text() would drop it).
    assert.deepEqual(
      new Uint8Array(await result.data.blob.arrayBuffer()),
      new TextEncoder().encode('﻿"ref"\r\n'),
    )
    const [, init] = fetchCalls[0]
    assert.equal(init.method, 'GET')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.match(new Headers(init.headers).get('Accept'), /^text\/csv, application\/json$/)
  })

  test('any other Content-Type on a success is MALFORMED_RESPONSE', async () => {
    for (const contentType of ['text/html', 'application/json', 'text/csvx', null]) {
      answerWith(
        new Response('<script>', {
          status: 200,
          headers: contentType === null ? {} : { 'Content-Type': contentType },
        }),
      )
      const result = await client.apiRequestBlob(async () => TOKEN, {
        path: '/api/admin/exports/bookings.csv?from=2026-01-01&to=2026-02-01',
        accept: ['text/csv'],
      })

      assert.equal(result.ok, false, String(contentType))
      assert.equal(result.error.code, 'MALFORMED_RESPONSE')
    }
  })

  test('an unsafe Content-Disposition file name is dropped', async () => {
    for (const disposition of [
      'attachment; filename="../../etc/passwd"',
      'attachment; filename="a b.csv"',
      // Header values are bytes; a non-ASCII name arrives as Latin-1.
      'attachment; filename="exporté.csv"',
      'attachment; filename=bookings.csv',
    ]) {
      answerWith(
        new Response('x', {
          status: 200,
          headers: { 'Content-Type': 'text/csv', 'Content-Disposition': disposition },
        }),
      )
      const result = await client.apiRequestBlob(async () => TOKEN, {
        path: '/api/admin/exports/bookings.csv?from=2026-01-01&to=2026-02-01',
        accept: ['text/csv'],
      })

      assert.equal(result.data.fileName, null, disposition)
    }
  })

  test('an error envelope is a server error; REAUTH_REQUIRED retries once', async () => {
    answerWith(
      errorEnvelope(400, 'EXPORT_TOO_LARGE', 'نطاق التصدير كبير جدًا. اختاري فترة أقصر.'),
      errorEnvelope(403, 'REAUTH_REQUIRED'),
      new Response('x', { status: 200, headers: { 'Content-Type': 'text/csv' } }),
    )
    const tooLarge = await client.apiRequestBlob(async () => TOKEN, {
      path: '/api/admin/exports/bookings.csv?from=2025-01-01&to=2026-06-01',
      accept: ['text/csv'],
      errorCodes: ['EXPORT_TOO_LARGE'],
    })
    assert.equal(tooLarge.error.code, 'EXPORT_TOO_LARGE')
    assert.equal(tooLarge.error.message, 'نطاق التصدير كبير جدًا. اختاري فترة أقصر.')

    const reauth = countingReauthentication(true)
    const retried = await client.apiRequestBlob(
      async () => TOKEN,
      {
        path: '/api/admin/exports/bookings.csv?from=2026-01-01&to=2026-02-01',
        accept: ['text/csv'],
      },
      reauth.provider,
    )
    assert.equal(retried.ok, true)
    assert.equal(reauth.calls.count, 1)
  })
})

describe('upload (XMLHttpRequest with progress and abort)', () => {
  class FakeXhr {
    static sent = []
    static onSend = null

    constructor() {
      this.upload = { onprogress: null }
      this.onload = null
      this.onerror = null
      this.ontimeout = null
      this.onabort = null
      this.status = 0
      this.responseText = ''
      this.responseType = ''
      this.responseURL = ''
      this.headers = new Map()
    }

    open(method, url) {
      this.method = method
      this.url = url
    }

    setRequestHeader(name, value) {
      this.headers.set(name, value)
    }

    send(body) {
      this.body = body
      FakeXhr.sent.push(this)
      FakeXhr.onSend?.(this)
    }

    abort() {
      this.onabort?.()
    }

    respond(status, body, responseURL = this.url) {
      this.status = status
      this.responseText = JSON.stringify(body)
      this.responseURL = responseURL
      this.onload?.()
    }
  }

  beforeEach(() => {
    FakeXhr.sent = []
    FakeXhr.onSend = null
    globalThis.XMLHttpRequest = FakeXhr
  })

  function receiptForm() {
    const form = new FormData()
    form.set('file', new Blob(['%PDF-1.7'], { type: 'application/pdf' }), 'r.pdf')
    return form
  }

  test('reports progress, sends the token in the header to this origin only', async () => {
    const progress = []
    FakeXhr.onSend = (xhr) => {
      queueMicrotask(() => {
        xhr.upload.onprogress?.({ loaded: 512, total: 2048, lengthComputable: true })
        xhr.upload.onprogress?.({ loaded: 2048, total: 0, lengthComputable: false })
        xhr.respond(200, { ok: true, value: 'stored' })
      })
    }
    const apiClient = client.createApiClient(async () => TOKEN)
    const result = await apiClient.upload({
      path: '/api/bookings/b1/receipt',
      body: receiptForm(),
      onProgress: (update) => progress.push(update),
      parse: parseEcho,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(progress, [
      { loadedBytes: 512, totalBytes: 2048 },
      { loadedBytes: 2048, totalBytes: null },
    ])
    const [xhr] = FakeXhr.sent
    assert.equal(xhr.method, 'POST')
    assert.equal(xhr.url, `${ORIGIN}/api/bookings/b1/receipt`)
    assert.equal(xhr.url.includes(TOKEN), false)
    assert.equal(xhr.headers.get('Authorization'), `Bearer ${TOKEN}`)
    // Handlers are detached once it settles.
    assert.equal(xhr.upload.onprogress, null)
    assert.equal(xhr.onload, null)
  })

  test('the AbortSignal aborts the upload and its listener is removed', async () => {
    const controller = new AbortController()
    const added = []
    const removed = []
    const addEventListener = controller.signal.addEventListener.bind(controller.signal)
    const removeEventListener = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = (type, listener, options) => {
      added.push(listener)
      addEventListener(type, listener, options)
    }
    controller.signal.removeEventListener = (type, listener, options) => {
      removed.push(listener)
      removeEventListener(type, listener, options)
    }
    FakeXhr.onSend = () => queueMicrotask(() => controller.abort())

    const result = await client.apiUpload(async () => TOKEN, {
      path: '/api/bookings/b1/receipt',
      body: receiptForm(),
      signal: controller.signal,
      parse: parseEcho,
    })

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'ABORTED')
    assert.equal(added.length, 1)
    assert.deepEqual(removed, added)
  })

  test('a network error is NETWORK_ERROR; 403 REAUTH_REQUIRED re-sends once', async () => {
    FakeXhr.onSend = (xhr) => queueMicrotask(() => xhr.onerror?.())
    const failed = await client.apiUpload(async () => TOKEN, {
      path: '/api/bookings/b1/receipt',
      body: receiptForm(),
      parse: parseEcho,
    })
    assert.equal(failed.error.code, 'NETWORK_ERROR')

    const answers = [
      [403, { ok: false, error: { code: 'REAUTH_REQUIRED', message: 'x' } }],
      [200, { ok: true, value: 'stored' }],
    ]
    FakeXhr.onSend = (xhr) => {
      const [status, body] = answers.shift()
      queueMicrotask(() => xhr.respond(status, body))
    }
    const reauth = countingReauthentication(true)
    const retried = await client.apiUpload(
      tokenSequence(TOKEN, FRESH_TOKEN),
      { path: '/api/bookings/b1/receipt', body: receiptForm(), parse: parseEcho },
      reauth.provider,
    )

    assert.equal(retried.ok, true)
    assert.equal(reauth.calls.count, 1)
    assert.equal(FakeXhr.sent.at(-1).headers.get('Authorization'), `Bearer ${FRESH_TOKEN}`)
  })

  test('an answer from a redirected URL is NETWORK_ERROR, never parsed', async () => {
    for (const finalUrl of [`${ORIGIN}/api/elsewhere`, 'https://evil.test/api/bookings/b1/receipt', '']) {
      FakeXhr.onSend = (xhr) =>
        queueMicrotask(() => xhr.respond(200, { ok: true, value: 'stored' }, finalUrl))
      const result = await client.apiUpload(async () => TOKEN, {
        path: '/api/bookings/b1/receipt',
        body: receiptForm(),
        parse: parseEcho,
      })

      assert.equal(result.ok, false, finalUrl)
      assert.equal(result.error.code, 'NETWORK_ERROR')
    }
  })

  test('a 413 on a file is PAYLOAD_TOO_LARGE worded for a file too, with or without an envelope', async () => {
    const answers = [
      (xhr) =>
        xhr.respond(413, {
          ok: false,
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'Server words' },
        }),
      // The platform's own 413 page: no envelope, not JSON.
      (xhr) => {
        xhr.status = 413
        xhr.responseText = '<html>413</html>'
        xhr.responseURL = xhr.url
        xhr.onload?.()
      },
    ]
    FakeXhr.onSend = (xhr) => {
      const answer = answers.shift()
      queueMicrotask(() => answer(xhr))
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await client.apiUpload(async () => TOKEN, {
        path: '/api/bookings/b1/receipt',
        body: receiptForm(),
        parse: parseEcho,
      })

      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'PAYLOAD_TOO_LARGE')
      assert.equal(
        result.error.message,
        messages.serverLimitMessages.PAYLOAD_TOO_LARGE,
      )
      assert.match(result.error.message, /ملفًا أصغر/)
    }
  })

  test('a refused path never opens an XMLHttpRequest', async () => {
    const result = await client.apiUpload(async () => TOKEN, {
      path: '/api/%2e%2e/upload',
      body: receiptForm(),
      parse: parseEcho,
    })

    assert.equal(result.error.code, 'INVALID_REQUEST')
    assert.equal(FakeXhr.sent.length, 0)
  })
})

describe('admin detail parser (L1, N-60)', () => {
  function bookingDetail(allowedActions) {
    return {
      id: 'bk_1',
      eventDate: '2026-12-01',
      status: 'approved_hold',
      allowedActions,
      packageName: null,
      estimatedTotal: 3500,
      packageSnapshot: null,
      priceBreakdown: null,
      adminNotes: null,
      holdExpiresAt: '2026-10-01T12:00:00.000Z',
      confirmedAt: null,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-21T10:00:00.000Z',
      customer: {
        id: 'u1',
        firstName: 'سارة',
        lastName: 'أحمد',
        email: 'sara@example.test',
        phone: '0500000000',
      },
      statusHistory: [
        {
          id: 1,
          fromStatus: 'pending_review',
          toStatus: 'approved_hold',
          changedBy: 'admin',
          note: null,
          createdAt: '2026-09-21T10:00:00.000Z',
        },
      ],
      // Fields a newer Worker adds (plan 11 #17).
      flowVersion: 2,
      stage: 'awaiting_deposit',
      features: { onlineConfirmationOffered: true },
    }
  }

  test('an unknown action (reinstate_hold) is skipped and the detail still loads', async () => {
    answerWith(
      jsonResponse(200, {
        ok: true,
        booking: bookingDetail(['reinstate_hold', 'mark_contract_sent', 'extend_hold', 7, null, 'cancel', 'cancel']),
      }),
    )
    const result = await admin.fetchAdminBookingDetail(TOKEN, 'bk_1')

    assert.equal(result.ok, true)
    assert.deepEqual(result.data.booking.allowedActions, ['mark_contract_sent', 'cancel'])
    assert.equal(result.data.booking.id, 'bk_1')
    assert.equal(result.data.booking.statusHistory.length, 1)
    assert.equal('flowVersion' in result.data.booking, false)
  })

  test('the action answer skips unknown actions too', async () => {
    answerWith(
      jsonResponse(200, {
        ok: true,
        booking: bookingDetail(['confirm_offline', 'cancel']),
        allowedActions: ['cancel', 'expire_hold'],
      }),
    )
    const result = await admin.performAdminBookingAction(TOKEN, 'bk_1', {
      action: 'mark_contract_sent',
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.data.allowedActions, ['cancel'])
    assert.deepEqual(result.data.booking.allowedActions, ['cancel'])
    assert.equal(result.data.customerEmailQueued, null)
  })

  test('a missing allowedActions list or a bad known field is still malformed', async () => {
    const withoutList = bookingDetail([])
    delete withoutList.allowedActions
    answerWith(
      jsonResponse(200, { ok: true, booking: withoutList }),
      jsonResponse(200, { ok: true, booking: { ...bookingDetail([]), estimatedTotal: -1 } }),
    )

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await admin.fetchAdminBookingDetail(TOKEN, 'bk_1')
      assert.equal(result.ok, false)
      assert.equal(result.error.kind, 'malformed-response')
    }
  })
})

describe('admin requests: the plan codes through the shared transport', () => {
  test('403 REAUTH_REQUIRED asks once and retries with a fresh token', async () => {
    answerWith(
      errorEnvelope(403, 'REAUTH_REQUIRED'),
      jsonResponse(200, {
        ok: true,
        filters: { limit: 50 },
        bookings: [],
        nextCursor: null,
      }),
    )
    const reauth = countingReauthentication(true)
    const result = await admin.fetchAdminBookings(TOKEN, {}, undefined, {
      getIdToken: async () => FRESH_TOKEN,
      requestReauthentication: reauth.provider,
    })

    assert.equal(result.ok, true)
    assert.equal(reauth.calls.count, 1)
    assert.equal(
      new Headers(fetchCalls[1][1].headers).get('Authorization'),
      `Bearer ${FRESH_TOKEN}`,
    )
    assert.equal(fetchCalls[1][1].redirect, 'error')
  })

  test('a declined 403 REAUTH_REQUIRED keeps the shape existing callers read', async () => {
    answerWith(errorEnvelope(403, 'REAUTH_REQUIRED'))
    const result = await admin.fetchAdminBookings(TOKEN, {}, undefined, {
      getIdToken: async () => FRESH_TOKEN,
      requestReauthentication: async () => false,
    })

    assert.deepEqual(result.error, { kind: 'unauthenticated', code: 'REAUTH_REQUIRED' })
    assert.equal(
      admin.getAdminLimitMessage(result.error),
      messages.serverLimitMessages.REAUTH_REQUIRED,
    )
  })

  test('a 401 is unauthenticated without a prompt', async () => {
    answerWith(errorEnvelope(401, 'UNAUTHENTICATED'))
    const reauth = countingReauthentication(true)
    const result = await admin.fetchAdminBookings(TOKEN, {}, undefined, {
      getIdToken: async () => FRESH_TOKEN,
      requestReauthentication: reauth.provider,
    })

    assert.deepEqual(result.error, { kind: 'unauthenticated', code: 'UNAUTHENTICATED' })
    assert.equal(reauth.calls.count, 0)
  })

  test('SECOND_FACTOR_REQUIRED and Wave 0 ADMIN_MFA_REQUIRED both match ADMIN_MFA_REQUIRED_CODE', async () => {
    for (const code of ['SECOND_FACTOR_REQUIRED', 'ADMIN_MFA_REQUIRED']) {
      answerWith(errorEnvelope(403, code))
      const result = await admin.saveAdminBlockedDate(TOKEN, {
        date: '2026-12-01',
        reason: 'سفر',
      })

      assert.equal(result.error.kind, 'forbidden')
      assert.equal(result.error.code, admin.ADMIN_MFA_REQUIRED_CODE)
      assert.equal(result.error.code, admin.SECOND_FACTOR_REQUIRED_CODE)
      assert.equal(admin.getAdminLimitMessage(result.error), admin.ADMIN_MFA_REQUIRED_MESSAGE)
    }
  })

  test('a network failure and an abort keep their kinds', async () => {
    answerWith()
    const failed = await admin.fetchAdminBookingDetail(TOKEN, 'bk_1')
    assert.deepEqual(failed.error, { kind: 'network', code: null })

    const controller = new AbortController()
    controller.abort()
    const aborted = await admin.fetchAdminBookingDetail(TOKEN, 'bk_1', controller.signal)
    assert.deepEqual(aborted.error, { kind: 'aborted', code: null })
  })
})

describe('one message table (R-05)', () => {
  test('Wave 0 names share the plan code message, never a second wording', () => {
    const table = messages.serverLimitMessages
    assert.equal(table.TOO_MANY_OPEN_REQUESTS, table.OPEN_REQUEST_LIMIT)
    assert.equal(table.BOOKING_TOO_FAR_AHEAD, table.DATE_BEYOND_HORIZON)
    assert.equal(admin.ADMIN_MFA_REQUIRED_MESSAGE, table.SECOND_FACTOR_REQUIRED)
    assert.equal(messages.toCurrentServerErrorCode('ADMIN_MFA_REQUIRED'), 'SECOND_FACTOR_REQUIRED')
    assert.equal(messages.toCurrentServerErrorCode('TOO_MANY_OPEN_REQUESTS'), 'OPEN_REQUEST_LIMIT')
    assert.equal(messages.toCurrentServerErrorCode('BOOKING_TOO_FAR_AHEAD'), 'DATE_BEYOND_HORIZON')
    assert.equal(messages.toCurrentServerErrorCode('HOLD_EXPIRED'), 'HOLD_EXPIRED')
  })

  test('every client failure code has an Arabic message', () => {
    for (const code of client.apiClientErrorCodes) {
      assert.match(messages.apiClientFailureMessages[code], /[؀-ۿ]/, code)
    }
  })
})
