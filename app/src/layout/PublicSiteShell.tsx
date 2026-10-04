import type { ReactNode } from 'react'
import SiteFooter from './SiteFooter'
import SiteHeader from './SiteHeader'
import type { NavigationHandler, PublicPath } from './navigation'
import './PublicSiteShell.css'

interface PublicSiteShellProps {
  activePath: PublicPath
  /** Changes on every navigation; lets the header close its mobile menu. */
  locationKey: number
  onNavigate: NavigationHandler
  /** The active page — it renders its own <main id="main-content">. */
  children: ReactNode
}

export default function PublicSiteShell({
  activePath,
  locationKey,
  onNavigate,
  children,
}: PublicSiteShellProps) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        تخطي إلى المحتوى
      </a>
      <SiteHeader
        activePath={activePath}
        locationKey={locationKey}
        onNavigate={onNavigate}
      />
      {children}
      <SiteFooter activePath={activePath} onNavigate={onNavigate} />
    </>
  )
}
