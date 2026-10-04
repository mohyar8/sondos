import { flushSync } from 'react-dom'
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import { useAuth } from './auth/auth-context'
import PublicSiteShell from './layout/PublicSiteShell'
import RouteErrorBoundary from './layout/RouteErrorBoundary'
import RouteFallback from './layout/RouteFallback'
import RouteRendered from './layout/RouteRendered'
import {
  LazyAdminDashboard,
  LazyEmailVerificationGate,
  LazyMyBookings,
  LazyPackagesPage,
  LazyPortfolioPage,
} from './layout/lazy-components'
import {
  getActiveAppPath,
  normalizePathname,
  type AppPath,
  type NavigationHandler,
} from './layout/navigation'
import { resetFailedLazyComponents } from './layout/retryable-lazy'
import { applyRouteMeta } from './layout/route-meta'
import {
  scrollToLocationHash,
  scrollToPageTop,
} from './layout/scroll-to-location'
import HomePage from './pages/HomePage'

interface BrowserLocation {
  pathname: string
  hash: string
  revision: number
}

function readBrowserLocation(revision: number): BrowserLocation {
  return {
    pathname: normalizePathname(window.location.pathname),
    hash: window.location.hash,
    revision,
  }
}

/** View transitions only in the cinematic design and without reduced motion. */
function canAnimatePageChange(): boolean {
  return (
    document.documentElement.getAttribute('data-design') === 'cinematic' &&
    typeof document.startViewTransition === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** A transition skipped by a quick second click rejects with AbortError. */
function ignoreSkippedTransition(error: unknown): void {
  if (!(error instanceof DOMException)) {
    throw error
  }
}

export default function App() {
  const { firebaseUser, isEmailVerified } = useAuth()
  const [browserLocation, setBrowserLocation] = useState<BrowserLocation>(
    () => readBrowserLocation(0),
  )
  // The route whose page has committed to the DOM (lazy pages arrive later
  // than the navigation that asked for them).
  const [renderedPath, setRenderedPath] = useState<AppPath | null>(null)
  const activePath = getActiveAppPath(browserLocation.pathname)
  const isActivePageRendered = renderedPath === activePath
  const verificationRequired =
    firebaseUser !== null && !isEmailVerified

  // The router's one and only popstate listener (Back/Forward, and the
  // synthetic event SiteHeader dispatches after signing out of /my-bookings).
  useEffect(() => {
    function handlePopState() {
      resetFailedLazyComponents()
      setBrowserLocation((currentLocation) =>
        readBrowserLocation(currentLocation.revision + 1),
      )
    }

    window.addEventListener('popstate', handlePopState)

    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    applyRouteMeta(activePath)
  }, [activePath])

  // A new route starts at the top right away (so its loading state is in
  // view); the #hash target is only looked up once the page has rendered,
  // which is what makes /packages#packages and /#contact work on a direct
  // load and after a lazy chunk arrives.
  useEffect(() => {
    if (!isActivePageRendered) {
      scrollToPageTop()
      return undefined
    }

    return scrollToLocationHash(browserLocation.hash)
  }, [isActivePageRendered, browserLocation.hash, browserLocation.revision])

  const handleNavigate = useCallback<NavigationHandler>((event, href) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.currentTarget.target === '_blank'
    ) {
      return
    }

    // Resolve against the current URL so an in-page href such as "#contact"
    // stays on the current route (e.g. /portfolio#contact).
    const destination = new URL(href, window.location.href)

    if (destination.origin !== window.location.origin) {
      return
    }

    event.preventDefault()

    const destinationUrl = `${destination.pathname}${destination.search}${destination.hash}`
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`

    const pathChanges = destination.pathname !== window.location.pathname

    if (destinationUrl !== currentUrl) {
      window.history.pushState(null, '', destinationUrl)
    }

    // A chunk that failed earlier gets a fresh download on the next visit.
    resetFailedLazyComponents()

    const showNextPage = () =>
      setBrowserLocation((currentLocation) =>
        readBrowserLocation(currentLocation.revision + 1),
      )

    if (pathChanges && canAnimatePageChange()) {
      // Cinematic design only: the page change runs inside a view
      // transition, and the hero skips its own entrance (data-cine-entry).
      document.documentElement.setAttribute('data-cine-entry', 'vt')
      const transition = document.startViewTransition(() => {
        flushSync(showNextPage)
      })
      transition.ready.catch(ignoreSkippedTransition)
      transition.finished.catch(ignoreSkippedTransition)
      return
    }

    showNextPage()
  }, [])

  if (activePath === '/admin') {
    return (
      <RouteErrorBoundary key="admin">
        <Suspense fallback={<RouteFallback />}>
          {verificationRequired ? (
            <LazyEmailVerificationGate />
          ) : (
            <>
              <LazyAdminDashboard />
              <RouteRendered path={activePath} onRendered={setRenderedPath} />
            </>
          )}
        </Suspense>
      </RouteErrorBoundary>
    )
  }

  if (activePath === '/my-bookings' && verificationRequired) {
    return (
      <RouteErrorBoundary key="email-verification" variant="screen">
        <Suspense fallback={<RouteFallback variant="screen" />}>
          <LazyEmailVerificationGate />
        </Suspense>
      </RouteErrorBoundary>
    )
  }

  let page: ReactNode

  switch (activePath) {
    case '/my-bookings':
      page = <LazyMyBookings embedded onNavigate={handleNavigate} />
      break
    case '/portfolio':
      page = <LazyPortfolioPage onNavigate={handleNavigate} />
      break
    case '/packages':
      page = <LazyPackagesPage />
      break
    case '/':
      page = <HomePage onNavigate={handleNavigate} />
      break
  }

  return (
    <>
      <div
        aria-hidden={verificationRequired || undefined}
        inert={verificationRequired}
      >
        <PublicSiteShell
          activePath={activePath}
          locationKey={browserLocation.revision}
          onNavigate={handleNavigate}
        >
          {/* Keyed by route: a failed page never keeps its error state after
              navigating away, and only the active page is ever mounted. */}
          <RouteErrorBoundary key={activePath}>
            <Suspense fallback={<RouteFallback />}>
              {page}
              <RouteRendered path={activePath} onRendered={setRenderedPath} />
            </Suspense>
          </RouteErrorBoundary>
        </PublicSiteShell>
      </div>
      {verificationRequired && (
        <RouteErrorBoundary variant="screen">
          <Suspense fallback={<RouteFallback variant="screen" />}>
            <LazyEmailVerificationGate />
          </Suspense>
        </RouteErrorBoundary>
      )}
    </>
  )
}
