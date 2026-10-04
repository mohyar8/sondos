// W1-08 / UX-16, TM-07, TM-08, SB-14: useReauthRetry, the retry-once hook of
// the app's one re-auth dialog (src/features/reauth/use-reauth-retry.ts),
// and how that dialog answers when it closes. Each case fails if its
// control is taken out: after she confirms and chooses «متابعة», the
// original request is sent again exactly once; never when she cancels
// (Escape, the backdrop, «إغلاق» or «إلغاء الإجراء», before or after
// confirming), never once the caller aborted, never for a result that does
// not ask for a recent sign-in, and never a second time when the retry
// still asks.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { describe, test } from 'node:test'

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

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { AuthContext, answerReauthentication } = await import(
  '../src/auth/auth-context.ts'
)
const { useReauthRetry } = await import(
  '../src/features/reauth/use-reauth-retry.ts'
)

const REAUTH_REQUIRED = { ok: false, code: 'REAUTH_REQUIRED' }
const SAVED = { ok: true }
const needsReauthentication = (result) => result.code === 'REAUTH_REQUIRED'

/**
 * The hook as a component under the AuthProvider gets it: bound to a
 * stand-in requestReauthentication that answers `answer` and counts calls.
 */
function renderRetry(answer) {
  const prompt = { calls: 0 }
  let retry = null

  function Probe() {
    retry = useReauthRetry()
    return null
  }

  renderToStaticMarkup(
    createElement(
      AuthContext.Provider,
      {
        value: {
          requestReauthentication: async () => {
            prompt.calls += 1
            return typeof answer === 'function' ? answer() : answer
          },
        },
      },
      createElement(Probe),
    ),
  )

  assert.equal(typeof retry, 'function')

  return { retry, prompt }
}

/** A request that answers `results` in order and counts its sends. */
function scriptedSend(...results) {
  const send = async () => {
    send.calls += 1
    return results[Math.min(send.calls, results.length) - 1]
  }

  send.calls = 0

  return send
}

describe('useReauthRetry', () => {
  test('sends the original request once more after she confirms', async () => {
    const { retry, prompt } = renderRetry(true)
    const send = scriptedSend(REAUTH_REQUIRED, SAVED)

    assert.equal(await retry(send, needsReauthentication), SAVED)
    assert.equal(send.calls, 2)
    assert.equal(prompt.calls, 1)
  })

  test('retries only once, even when the retry still asks for a sign-in', async () => {
    const { retry, prompt } = renderRetry(true)
    const send = scriptedSend(REAUTH_REQUIRED, REAUTH_REQUIRED, SAVED)

    assert.equal(await retry(send, needsReauthentication), REAUTH_REQUIRED)
    assert.equal(send.calls, 2)
    assert.equal(prompt.calls, 1)
  })

  test('returns the first result unchanged when she cancels', async () => {
    const { retry, prompt } = renderRetry(false)
    const send = scriptedSend(REAUTH_REQUIRED, SAVED)

    assert.equal(await retry(send, needsReauthentication), REAUTH_REQUIRED)
    assert.equal(send.calls, 1)
    assert.equal(prompt.calls, 1)
  })

  test('never opens the dialog for a result that does not ask for it', async () => {
    const { retry, prompt } = renderRetry(true)
    const send = scriptedSend(SAVED)

    assert.equal(await retry(send, needsReauthentication), SAVED)
    assert.equal(send.calls, 1)
    assert.equal(prompt.calls, 0)
  })

  test('does not ask once the caller has aborted', async () => {
    const { retry, prompt } = renderRetry(true)
    const controller = new AbortController()
    const send = async () => {
      controller.abort()
      return REAUTH_REQUIRED
    }

    assert.equal(
      await retry(send, needsReauthentication, controller.signal),
      REAUTH_REQUIRED,
    )
    assert.equal(prompt.calls, 0)
  })

  test('does not resend when the caller aborted while the dialog was open', async () => {
    const controller = new AbortController()
    const { retry, prompt } = renderRetry(() => {
      controller.abort()
      return true
    })
    const send = scriptedSend(REAUTH_REQUIRED, SAVED)

    assert.equal(
      await retry(send, needsReauthentication, controller.signal),
      REAUTH_REQUIRED,
    )
    assert.equal(send.calls, 1)
    assert.equal(prompt.calls, 1)
  })
})

/**
 * The AuthProvider's prompt as the dialog leaves it: she typed her password
 * (or not), then closed it with `close`. The answer is the provider's own
 * (cancelReauthentication and continueReauthentication both settle with
 * answerReauthentication).
 */
function promptClosedWith(close, { confirmed }) {
  return () =>
    answerReauthentication(
      {
        id: 1,
        email: 'bride@example.com',
        returnFocus: null,
        confirmedAt: confirmed ? Date.UTC(2026, 8, 29, 9, 5) : null,
      },
      close,
    )
}

const dialogSource = await readFile(
  new URL('../src/features/reauth/ReauthDialog.tsx', import.meta.url),
  'utf8',
)
const hostSource = await readFile(
  new URL('../src/auth/ReauthenticationHost.tsx', import.meta.url),
  'utf8',
)

describe('closing the re-auth dialog', () => {
  test('Escape after she confirmed cancels: the first result comes back, sent once', async () => {
    const { retry, prompt } = renderRetry(
      promptClosedWith('cancel', { confirmed: true }),
    )
    const send = scriptedSend(REAUTH_REQUIRED, SAVED)

    assert.equal(await retry(send, needsReauthentication), REAUTH_REQUIRED)
    assert.equal(send.calls, 1)
    assert.equal(prompt.calls, 1)
  })

  test('«متابعة» after she confirmed sends the action once more', async () => {
    const { retry } = renderRetry(
      promptClosedWith('continue', { confirmed: true }),
    )
    const send = scriptedSend(REAUTH_REQUIRED, SAVED)

    assert.equal(await retry(send, needsReauthentication), SAVED)
    assert.equal(send.calls, 2)
  })

  test('nothing continues a prompt she never confirmed', async () => {
    for (const close of ['continue', 'cancel']) {
      const { retry } = renderRetry(promptClosedWith(close, { confirmed: false }))
      const send = scriptedSend(REAUTH_REQUIRED, SAVED)

      assert.equal(await retry(send, needsReauthentication), REAUTH_REQUIRED)
      assert.equal(send.calls, 1)
    }
  })

  test('only the «متابعة» button continues; Escape, the backdrop and every other button cancel', () => {
    // onContinue: the prop, its destructuring, and one onClick.
    assert.equal(dialogSource.match(/\bonContinue\b/g)?.length, 3)
    assert.match(
      dialogSource,
      /onClick=\{onContinue\}\s+data-initial-focus=""\s*>\s*متابعة\s*</,
    )
    assert.match(
      dialogSource,
      /event\.key === 'Escape'\) \{\s*if \(!isBusy\) \{\s*event\.preventDefault\(\)\s*onCancel\(\)/,
    )
    assert.match(
      dialogSource,
      /function handleBackdropMouseDown\([^)]*\) \{\s*if \([^)]*\) \{\s*onCancel\(\)/,
    )
    // «إغلاق» (every view) and «إلغاء الإجراء» (password and success views).
    assert.equal(dialogSource.match(/onClick=\{onCancel\}/g)?.length, 3)
    assert.doesNotMatch(dialogSource, /\bonClose\b/)
  })

  test('the host cancels on every path but «متابعة», a failed download included', () => {
    assert.match(hostSource, /onDismiss=\{cancelReauthentication\}/)
    assert.match(hostSource, /onCancel=\{cancelReauthentication\}/)
    assert.match(hostSource, /onContinue=\{continueReauthentication\}/)
    assert.equal(hostSource.match(/continueReauthentication\b/g)?.length, 2)
  })
})
