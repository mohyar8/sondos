import {
  createElement,
  lazy,
  type ComponentType,
  type FunctionComponent,
} from 'react'

/** What a code-split module exports: the component, as its default export. */
export interface ComponentModule<Props extends object> {
  default: ComponentType<Props>
}

/**
 * A code-split component (React.lazy under the hood) with a stable identity,
 * so it is used like any other component, plus a `preload()` that starts
 * downloading its chunk ahead of time (e.g. on pointerenter/focus).
 */
export type RetryableLazyComponent<Props extends object> =
  FunctionComponent<Props> & {
    /** Starts downloading the chunk; idempotent and never rejects. */
    preload: () => void
    /**
     * Starts the download like `preload()` and resolves once the chunk has
     * arrived or failed; never rejects. On success `loadedModule()` is set
     * before it resolves. A failed chunk is downloaded again when the
     * component renders, and its error boundary shows the failure.
     */
    whenReady: () => Promise<void>
    /**
     * The module a successful `whenReady()` delivered, synchronously; null
     * until then (a download started only by a render or `preload()` leaves
     * it null). Rendering its `default` directly skips the Suspense fallback
     * that a React.lazy instance shows on its first render, even with a warm
     * chunk. React sees `default` and this component as different element
     * types, so switching between them remounts the page, and the value can
     * still turn non-null while the lazy instance is mounted (a `whenReady()`
     * that settles after the page rendered through its fallback). Decide
     * once per navigation, e.g. read it inside the view-transition callback
     * and keep it in route state; never re-read it on every render.
     */
    loadedModule: () => ComponentModule<Props> | null
  }

/**
 * Components whose React.lazy instance has consumed a failed download.
 * React.lazy keeps a rejection forever, so each entry swaps in a fresh
 * instance before the next attempt.
 */
const failedComponents = new Set<() => void>()

/**
 * Lets every component whose chunk failed to download try again on its next
 * render. Called by RouteErrorBoundary's retry button and on navigation.
 */
export function resetFailedLazyComponents(): void {
  for (const rearm of Array.from(failedComponents)) {
    rearm()
  }
}

export function createRetryableLazy<Props extends object>(
  loader: () => Promise<ComponentModule<Props>>,
  displayName: string,
): RetryableLazyComponent<Props> {
  let pendingLoad: Promise<ComponentModule<Props>> | null = null
  let resolvedModule: ComponentModule<Props> | null = null
  let currentComponent = createLazyInstance()

  /** One shared download at a time; a failed one is forgotten. */
  function load(): Promise<ComponentModule<Props>> {
    if (pendingLoad !== null) {
      return pendingLoad
    }

    const attempt = loader()
    pendingLoad = attempt

    // Only clears the cache so the next call downloads the chunk again; the
    // rejection itself is handled by whoever rendered or preloaded it.
    attempt.then(undefined, () => {
      if (pendingLoad === attempt) {
        pendingLoad = null
      }
    })

    return attempt
  }

  function createLazyInstance() {
    return lazy(() => {
      const attempt = load()

      // React.lazy hands this rejection to the nearest error boundary and
      // then stays rejected, so remember to replace the instance.
      attempt.then(undefined, () => {
        failedComponents.add(rearm)
      })

      return attempt
    })
  }

  function rearm(): void {
    failedComponents.delete(rearm)
    currentComponent = createLazyInstance()
  }

  function preload(): void {
    // Only an instance that already failed is replaced; one that loaded
    // (and may be mounted) is never swapped out.
    if (failedComponents.has(rearm)) {
      rearm()
    }

    void load()
  }

  const renderCurrent = (props: Props) =>
    createElement(currentComponent, props)

  return Object.assign(renderCurrent, {
    displayName,
    preload,
    async whenReady(): Promise<void> {
      preload()

      // Waits for the outcome without taking it over: a failed download is
      // already forgotten by load() and surfaces at render time instead.
      const [outcome] = await Promise.allSettled([load()])

      // The only place loadedModule() is filled: a render or preload() alone
      // never changes it under a lazy instance that is already mounted.
      if (outcome.status === 'fulfilled') {
        resolvedModule = outcome.value
      }
    },
    loadedModule(): ComponentModule<Props> | null {
      return resolvedModule
    },
  })
}
