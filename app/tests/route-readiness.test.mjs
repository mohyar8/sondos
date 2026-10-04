// W1-18 / MOT-05 (+M5): the route-chunk readiness API of createRetryableLazy
// (src/layout/retryable-lazy.ts) and routeReady (src/layout/lazy-components.ts).
// Each case fails if its control is taken out: whenReady() resolves only
// once the chunk has arrived and never rejects when it fails; loadedModule()
// holds the module synchronously from then on, and only a successful
// whenReady() sets it (never a render or preload()); there is one shared
// download, and a failed one is tried again; / and /admin download nothing;
// no rejection is ever left unhandled.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { after, afterEach, describe, test } from 'node:test'

const LAZY_COMPONENTS = '/src/layout/lazy-components.ts'
const OFFLINE_ERROR = 'Failed to fetch dynamically imported module'

/**
 * Stand-ins for the page chunks lazy-components.ts imports (their .tsx
 * sources cannot run in Node). The packages chunk plays a download that
 * fails, as with the network offline.
 */
const CHUNK_STUBS = new Map([
  ['../pages/PortfolioPage', 'export default function PortfolioPage() { return null }'],
  ['../pages/PackagesPage', `throw new TypeError(${JSON.stringify(OFFLINE_ERROR)})`],
  ['../components/MyBookings', 'export default function MyBookings() { return null }'],
  ['../components/AdminDashboard', 'export default function AdminDashboard() { return null }'],
  [
    '../components/EmailVerificationGate',
    'export default function EmailVerificationGate() { return null }',
  ],
  ['../components/AuthDialog', 'export default function AuthDialog() { return null }'],
])

/** Every chunk lazy-components.ts asked for, in order. */
const requestedChunks = []

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = CHUNK_STUBS.get(specifier)

    if (stub !== undefined && context.parentURL?.endsWith(LAZY_COMPONENTS)) {
      requestedChunks.push(specifier.slice(specifier.lastIndexOf('/') + 1))
      return {
        url: `data:text/javascript,${encodeURIComponent(stub)}`,
        shortCircuit: true,
      }
    }

    // The SPA imports its own modules without an extension (bundler
    // resolution); Node needs the `.ts` file named. Only relative specifiers
    // that are missing as written are retried, and only as their `.ts`
    // sibling.
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

      return nextResolve(`${specifier}.ts`, context)
    }
  },
})

const { createElement } = await import('react')
const { prerenderToNodeStream } = await import('react-dom/static')
const { createRetryableLazy } = await import('../src/layout/retryable-lazy.ts')
const {
  LazyAdminDashboard,
  LazyMyBookings,
  LazyPackagesPage,
  LazyPortfolioPage,
  routeReady,
} = await import('../src/layout/lazy-components.ts')

const unhandledRejections = []
function recordUnhandledRejection(reason) {
  unhandledRejections.push(reason)
}
process.on('unhandledRejection', recordUnhandledRejection)

after(() => {
  process.off('unhandledRejection', recordUnhandledRejection)
})

// Runs after every case: Node reports an unhandled rejection once the
// microtasks have drained, so one macrotask later is enough to see it.
afterEach(async () => {
  await nextTurn()
  assert.deepEqual(unhandledRejections, [])
})

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A download the test settles by hand; `calls` counts loader calls. */
function manualLoader() {
  const downloads = []
  const loader = () => {
    let settle
    const promise = new Promise((resolve, reject) => {
      settle = { resolve, reject }
    })
    downloads.push(settle)
    return promise
  }

  return {
    loader,
    downloads,
    get calls() {
      return downloads.length
    },
  }
}

function makeChunk() {
  return { default: function Probe() { return null } }
}

function offlineError() {
  return new TypeError(OFFLINE_ERROR)
}

/**
 * Renders on the server, waiting for lazy components; rejects on their
 * errors, which are also collected in `renderErrors` (instead of React's
 * default console report).
 */
async function renderToText(element, renderErrors = []) {
  const { prelude } = await prerenderToNodeStream(element, {
    onError(error) {
      renderErrors.push(error)
    },
  })
  let html = ''

  for await (const chunk of prelude) {
    html += chunk
  }

  return html
}

describe('createRetryableLazy: whenReady and loadedModule (MOT-05, M5)', () => {
  test('whenReady resolves only after the chunk arrives, with loadedModule() already set', async () => {
    const chunks = manualLoader()
    const Probe = createRetryableLazy(chunks.loader, 'Probe')
    let moduleWhenReady = 'pending'

    assert.equal(Probe.loadedModule(), null)

    const ready = Probe.whenReady().then(() => {
      moduleWhenReady = Probe.loadedModule()
    })
    await nextTurn()

    assert.equal(chunks.calls, 1, 'whenReady starts the download')
    assert.equal(moduleWhenReady, 'pending', 'nothing resolves before the chunk')
    assert.equal(Probe.loadedModule(), null)

    const chunk = makeChunk()
    chunks.downloads[0].resolve(chunk)
    await ready

    assert.equal(moduleWhenReady, chunk)
    assert.equal(Probe.loadedModule(), chunk, 'returned synchronously from now on')
  })

  test('whenReady resolves, never rejects, when the download fails; the next call downloads again', async () => {
    const chunks = manualLoader()
    const Probe = createRetryableLazy(chunks.loader, 'Probe')

    const first = Probe.whenReady()
    chunks.downloads[0].reject(offlineError())

    assert.equal(await first, undefined)
    assert.equal(Probe.loadedModule(), null, 'a failed chunk is never cached')

    const second = Probe.whenReady()
    assert.equal(chunks.calls, 2, 'the failed download is forgotten')

    const chunk = makeChunk()
    chunks.downloads[1].resolve(chunk)
    await second

    assert.equal(Probe.loadedModule(), chunk)
  })

  test('preload and whenReady share one download; a loaded chunk is never downloaded again', async () => {
    const chunks = manualLoader()
    const Probe = createRetryableLazy(chunks.loader, 'Probe')

    Probe.preload()
    const first = Probe.whenReady()
    const second = Probe.whenReady()

    assert.equal(chunks.calls, 1)

    const chunk = makeChunk()
    chunks.downloads[0].resolve(chunk)
    await Promise.all([first, second])

    Probe.preload()
    await Probe.whenReady()

    assert.equal(chunks.calls, 1)
    assert.equal(Probe.loadedModule(), chunk)
  })

  test('a chunk loaded by preload() alone leaves loadedModule() null until whenReady() resolves', async () => {
    const chunks = manualLoader()
    const Probe = createRetryableLazy(chunks.loader, 'Probe')
    const chunk = makeChunk()

    Probe.preload()
    chunks.downloads[0].resolve(chunk)
    await nextTurn()

    assert.equal(Probe.loadedModule(), null, 'preloading never fills the cache')

    await Probe.whenReady()

    assert.equal(chunks.calls, 1, 'whenReady joins the finished download')
    assert.equal(Probe.loadedModule(), chunk)
  })

  test('a chunk loaded by rendering alone never changes loadedModule() under the mounted page', async () => {
    let calls = 0
    const chunk = { default: () => createElement('h1', null, 'ready') }
    const Probe = createRetryableLazy(async () => {
      calls += 1
      return chunk
    }, 'Probe')

    // A cold render (classic mode, a direct load): React.lazy downloads it.
    assert.equal(await renderToText(createElement(Probe)), '<h1>ready</h1>')
    await nextTurn()

    assert.equal(calls, 1)
    assert.equal(Probe.loadedModule(), null, 'the render path never fills the cache')

    await Probe.whenReady()

    assert.equal(calls, 1, 'whenReady joins the finished download')
    assert.equal(Probe.loadedModule(), chunk)
  })

  test('after a render whose download failed, whenReady() re-arms the component like preload() does', async () => {
    let calls = 0
    const Probe = createRetryableLazy(async () => {
      calls += 1
      if (calls === 1) {
        throw offlineError()
      }
      return { default: () => createElement('h1', null, 'ready') }
    }, 'Probe')

    // The failure reaches the renderer (the route's error boundary in the app).
    const renderErrors = []
    await assert.rejects(renderToText(createElement(Probe), renderErrors), {
      message: OFFLINE_ERROR,
    })
    assert.equal(renderErrors.length, 1)

    await Probe.whenReady()

    assert.equal(calls, 2)
    assert.equal(await renderToText(createElement(Probe)), '<h1>ready</h1>')
  })

  test('a failed preload leaves no unhandled rejection and no cached module', async () => {
    const chunks = manualLoader()
    const Probe = createRetryableLazy(chunks.loader, 'Probe')

    Probe.preload()
    chunks.downloads[0].reject(offlineError())
    await nextTurn()

    assert.equal(Probe.loadedModule(), null)
  })
})

describe('routeReady (MOT-05)', () => {
  // First on purpose: nothing has asked for a chunk yet.
  test('/ and /admin resolve at once without downloading any chunk', async () => {
    assert.equal(await routeReady('/'), undefined)
    assert.equal(await routeReady('/admin'), undefined)
    await nextTurn()

    assert.deepEqual(requestedChunks, [])
    assert.equal(LazyAdminDashboard.loadedModule(), null)
  })

  test("routeReady('/portfolio') resolves after the chunk arrives and loadedModule() is then set", async () => {
    assert.equal(LazyPortfolioPage.loadedModule(), null)

    await routeReady('/portfolio')

    const loaded = LazyPortfolioPage.loadedModule()
    assert.notEqual(loaded, null)
    assert.equal(loaded.default.name, 'PortfolioPage')
  })

  test('/my-bookings waits for its own chunk only', async () => {
    await routeReady('/my-bookings')

    assert.equal(LazyMyBookings.loadedModule()?.default.name, 'MyBookings')
  })

  test('a route whose chunk cannot be downloaded (offline) resolves, not rejects', async () => {
    assert.equal(await routeReady('/packages'), undefined)
    assert.equal(LazyPackagesPage.loadedModule(), null)

    // A second wait asks for the chunk again and still resolves.
    assert.equal(await routeReady('/packages'), undefined)
    assert.equal(LazyPackagesPage.loadedModule(), null)
  })

  test('public routes never ask for the admin, verification or sign-in chunks', () => {
    assert.ok(requestedChunks.length > 0)
    for (const chunk of requestedChunks) {
      assert.ok(
        ['PortfolioPage', 'PackagesPage', 'MyBookings'].includes(chunk),
        `unexpected chunk ${chunk}`,
      )
    }
  })
})
