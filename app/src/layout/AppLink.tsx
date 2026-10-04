import type { ReactNode } from 'react'
import { preloadRoute } from './lazy-components'
import type { AppPath, NavigationHandler } from './navigation'

interface AppLinkProps {
  href: string
  onNavigate: NavigationHandler
  className?: string
  /** Route whose chunk starts downloading on hover or keyboard focus. */
  preloadPath?: AppPath
  children: ReactNode
}

/**
 * An in-app link: a real <a href> (so opening in a new tab, copying and
 * middle-click keep working) that the History-API router in App.tsx takes
 * over on a plain click.
 */
export default function AppLink({
  href,
  onNavigate,
  className,
  preloadPath,
  children,
}: AppLinkProps) {
  function handlePreload() {
    if (preloadPath !== undefined) {
      preloadRoute(preloadPath)
    }
  }

  return (
    <a
      className={className}
      href={href}
      onClick={(event) => onNavigate(event, href)}
      onPointerEnter={handlePreload}
      onFocus={handlePreload}
    >
      {children}
    </a>
  )
}
