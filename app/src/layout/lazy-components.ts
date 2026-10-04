import type { AppPath } from './navigation'
import { createRetryableLazy } from './retryable-lazy'

/*
 * Every code-split chunk of the app. Home stays in the entry chunk (it is the
 * landing page and the LCP route); everything else downloads on demand.
 * Nothing in the entry chunk may import these modules statically, or the
 * split is silently undone.
 */

export const LazyPortfolioPage = createRetryableLazy(
  () => import('../pages/PortfolioPage'),
  'PortfolioPage',
)

/** Pulls in PackageConfigurator, BookingCalendar and the package data. */
export const LazyPackagesPage = createRetryableLazy(
  () => import('../pages/PackagesPage'),
  'PackagesPage',
)

export const LazyMyBookings = createRetryableLazy(
  () => import('../components/MyBookings'),
  'MyBookings',
)

export const LazyAdminDashboard = createRetryableLazy(
  () => import('../components/AdminDashboard'),
  'AdminDashboard',
)

export const LazyEmailVerificationGate = createRetryableLazy(
  () => import('../components/EmailVerificationGate'),
  'EmailVerificationGate',
)

/** The header's sign-in dialog; preloaded on pointerenter/focus of the button. */
export const LazyAuthDialog = createRetryableLazy(
  () => import('../components/AuthDialog'),
  'AuthDialog',
)

/**
 * Starts downloading a route's chunk ahead of a likely navigation (link
 * hover/focus). Home is already in the entry chunk; /admin is never
 * prefetched from public pages.
 */
export function preloadRoute(path: AppPath | null): void {
  switch (path) {
    case '/portfolio':
      LazyPortfolioPage.preload()
      break
    case '/packages':
      LazyPackagesPage.preload()
      break
    case '/my-bookings':
      LazyMyBookings.preload()
      break
    case '/':
    case '/admin':
    case null:
      break
  }
}

/**
 * Resolves once a route's chunk has arrived or failed, never rejects; after
 * a successful download the page's `loadedModule()` is set. Lets a page
 * transition wait for the page itself instead of its loading fallback. Home
 * is in the entry chunk and /admin is never downloaded from public pages, so
 * both resolve at once.
 */
export function routeReady(path: AppPath): Promise<void> {
  switch (path) {
    case '/portfolio':
      return LazyPortfolioPage.whenReady()
    case '/packages':
      return LazyPackagesPage.whenReady()
    case '/my-bookings':
      return LazyMyBookings.whenReady()
    case '/':
    case '/admin':
      return Promise.resolve()
  }
}
