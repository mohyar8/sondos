import type { MouseEvent } from 'react'

/** Every route the History-API router in App.tsx knows. */
export type AppPath =
  | '/'
  | '/portfolio'
  | '/packages'
  | '/my-bookings'
  | '/admin'

/** Routes rendered inside the public site shell (header + footer). */
export type PublicPath = Exclude<AppPath, '/admin'>

export type NavigationHandler = (
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
) => void

export interface NavigationLink {
  readonly label: string
  readonly href: string
  /** The route this link marks as current, or null for in-page links. */
  readonly path: PublicPath | null
}

/** The one booking entry point: the configurator section on /packages. */
export const BOOKING_REQUEST_HREF = '/packages#packages'

/**
 * Pages that render their own contact section scroll to it in place; every
 * other page sends the visitor to the contact section on Home.
 */
export function getContactHref(activePath: PublicPath): string {
  return activePath === '/' || activePath === '/portfolio'
    ? '#contact'
    : '/#contact'
}

export function getPrimaryNavigation(
  activePath: PublicPath,
): readonly NavigationLink[] {
  return [
    { label: 'الرئيسية', href: '/', path: '/' },
    { label: 'الأعمال', href: '/portfolio', path: '/portfolio' },
    { label: 'الخدمات والباقات', href: '/packages', path: '/packages' },
    { label: 'حجوزاتي', href: '/my-bookings', path: '/my-bookings' },
    { label: 'تواصلي معنا', href: getContactHref(activePath), path: null },
  ]
}

export const footerQuickLinks: readonly NavigationLink[] = [
  { label: 'الرئيسية', href: '/', path: '/' },
  { label: 'الأعمال', href: '/portfolio', path: '/portfolio' },
  { label: 'الخدمات والباقات', href: '/packages', path: '/packages' },
  { label: 'حجوزاتي', href: '/my-bookings', path: '/my-bookings' },
]

export function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/'
}

export function isAppPath(pathname: string): pathname is AppPath {
  return (
    pathname === '/' ||
    pathname === '/portfolio' ||
    pathname === '/packages' ||
    pathname === '/my-bookings' ||
    pathname === '/admin'
  )
}

/** Unknown routes fall back to Home so the page is never blank. */
export function getActiveAppPath(pathname: string): AppPath {
  return isAppPath(pathname) ? pathname : '/'
}

export function getHashTargetId(hash: string): string | null {
  if (!hash.startsWith('#') || hash.length === 1) {
    return null
  }

  const encodedId = hash.slice(1)

  try {
    return decodeURIComponent(encodedId)
  } catch (error: unknown) {
    if (error instanceof URIError) {
      return encodedId
    }

    throw error
  }
}
