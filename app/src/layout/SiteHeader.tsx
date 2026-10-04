import {
  Suspense,
  useCallback,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import { useAuth } from '../auth/auth-context'
import { brandLogo } from '../data/brand-images'
import MobileMenu from './MobileMenu'
import NavigationAuthControls from './NavigationAuthControls'
import RouteErrorBoundary from './RouteErrorBoundary'
import RouteFallback from './RouteFallback'
import { LazyAuthDialog, preloadRoute } from './lazy-components'
import {
  BOOKING_REQUEST_HREF,
  getPrimaryNavigation,
  type NavigationHandler,
  type PublicPath,
} from './navigation'
import './SiteHeader.css'

/** The 112 px-tall asset rendered in a 56 px box (2x density). */
const LOGO_DISPLAY_HEIGHT = 56
const LOGO_DISPLAY_WIDTH = Math.round(
  (brandLogo.height112.width / brandLogo.height112.height) * LOGO_DISPLAY_HEIGHT,
)

const SIGN_OUT_ERROR_MESSAGE = 'تعذر تسجيل الخروج. حاولي مرة أخرى.'

interface SiteHeaderProps {
  activePath: PublicPath
  /** Changes on every navigation (including Back/Forward); closes the mobile menu. */
  locationKey: number
  onNavigate: NavigationHandler
}

export default function SiteHeader({
  activePath,
  locationKey,
  onNavigate,
}: SiteHeaderProps) {
  const { isInitializing, isAuthenticated, signOutUser, clearAuthError } =
    useAuth()
  const [isNavigationAuthOpen, setIsNavigationAuthOpen] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [menuLocationKey, setMenuLocationKey] = useState(locationKey)
  const signOutInProgressRef = useRef(false)
  const mobileToggleRef = useRef<HTMLButtonElement>(null)
  const navigationAuthOpenerRef = useRef<HTMLButtonElement | null>(null)
  const headerFocusRef = useRef<HTMLElement | null>(null)
  const navigationItems = getPrimaryNavigation(activePath)

  // Any navigation — a link, Back/Forward or a programmatic redirect — closes
  // the mobile menu (state adjusted during render, not in an effect).
  if (menuLocationKey !== locationKey) {
    setMenuLocationKey(locationKey)
    setIsMobileMenuOpen(false)
  }

  const closeMobileMenu = useCallback((returnFocus: boolean) => {
    setIsMobileMenuOpen(false)

    if (returnFocus) {
      mobileToggleRef.current?.focus({ preventScroll: true })
    }
  }, [])

  function toggleMobileMenu() {
    setIsMobileMenuOpen((isOpen) => !isOpen)
  }

  function openNavigationAuth(opener: HTMLButtonElement | null) {
    if (isInitializing || isAuthenticated) {
      return
    }

    navigationAuthOpenerRef.current = opener
    setSignOutError(null)
    clearAuthError()
    setIsNavigationAuthOpen(true)
  }

  function handleOpenDesktopLogin(event: MouseEvent<HTMLButtonElement>) {
    openNavigationAuth(event.currentTarget)
  }

  function handleOpenMobileLogin() {
    // The login button disappears with the menu, so the dialog returns focus
    // to the (always visible) menu toggle instead.
    closeMobileMenu(false)
    openNavigationAuth(mobileToggleRef.current)
  }

  function handleCloseNavigationAuth() {
    clearAuthError()
    setIsNavigationAuthOpen(false)
  }

  async function handleNavigationSignOut() {
    if (signOutInProgressRef.current) {
      return
    }

    signOutInProgressRef.current = true
    setIsSigningOut(true)
    setSignOutError(null)
    setIsNavigationAuthOpen(false)

    try {
      const result = await signOutUser()

      if (!result.ok) {
        setSignOutError(SIGN_OUT_ERROR_MESSAGE)
      } else if (activePath === '/my-bookings') {
        window.history.pushState(null, '', '/')
        window.dispatchEvent(new PopStateEvent('popstate'))
      }
    } finally {
      signOutInProgressRef.current = false
      setIsSigningOut(false)
    }
  }

  function handleMobileSignOut(): Promise<void> {
    closeMobileMenu(true)
    return handleNavigationSignOut()
  }

  function handleMobileNavigation(
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
  ) {
    closeMobileMenu(true)
    onNavigate(event, href)
  }

  return (
    <>
      <header
        className={`site-header${
          isMobileMenuOpen ? ' site-header--menu-open' : ''
        }`}
        ref={headerFocusRef}
        tabIndex={-1}
      >
        <div className="site-header__inner container">
          <a
            className="site-header__brand"
            href="/"
            aria-label="المصورة سندس يار — الصفحة الرئيسية"
            onClick={(event) => onNavigate(event, '/')}
          >
            <picture className="site-header__logo-frame">
              <source srcSet={brandLogo.height112.webp} type="image/webp" />
              <img
                className="site-header__logo"
                src={brandLogo.height112.png}
                width={LOGO_DISPLAY_WIDTH}
                height={LOGO_DISPLAY_HEIGHT}
                alt=""
                decoding="async"
              />
            </picture>
            <span className="site-header__brand-name">المصورة سندس يار</span>
          </a>

          <nav className="site-header__nav" aria-label="التنقل الرئيسي">
            <ul className="site-header__nav-list" role="list">
              {navigationItems.map((item) => (
                <li key={item.label}>
                  <a
                    className="site-header__nav-link"
                    href={item.href}
                    aria-current={item.path === activePath ? 'page' : undefined}
                    onClick={(event) => onNavigate(event, item.href)}
                    onPointerEnter={() => preloadRoute(item.path)}
                    onFocus={() => preloadRoute(item.path)}
                  >
                    {item.label}
                  </a>
                </li>
              ))}
              <li className="site-header__auth">
                <NavigationAuthControls
                  variant="desktop"
                  isInitializing={isInitializing}
                  isAuthenticated={isAuthenticated}
                  isSigningOut={isSigningOut}
                  onOpenLogin={handleOpenDesktopLogin}
                  onLoginIntent={LazyAuthDialog.preload}
                  onSignOut={handleNavigationSignOut}
                />
              </li>
            </ul>
          </nav>

          <a
            className="btn btn--primary site-header__cta"
            href={BOOKING_REQUEST_HREF}
            onClick={(event) => onNavigate(event, BOOKING_REQUEST_HREF)}
            onPointerEnter={() => preloadRoute('/packages')}
            onFocus={() => preloadRoute('/packages')}
          >
            ابدئي طلب الحجز
          </a>

          <MobileMenu
            isOpen={isMobileMenuOpen}
            activePath={activePath}
            navigationItems={navigationItems}
            toggleRef={mobileToggleRef}
            onToggle={toggleMobileMenu}
            onRequestClose={closeMobileMenu}
            onNavigate={handleMobileNavigation}
            authControls={
              <NavigationAuthControls
                variant="mobile"
                isInitializing={isInitializing}
                isAuthenticated={isAuthenticated}
                isSigningOut={isSigningOut}
                onOpenLogin={handleOpenMobileLogin}
                onLoginIntent={LazyAuthDialog.preload}
                onSignOut={handleMobileSignOut}
              />
            }
          />
        </div>

        {signOutError && (
          <p className="site-header__alert container" role="alert">
            {signOutError}
          </p>
        )}

        {isNavigationAuthOpen && (
          // The dialog itself renders in a portal; only its loading and
          // download-error states show here, inside the sticky header.
          <div className="container">
            <RouteErrorBoundary
              variant="inline"
              title="تعذّر فتح نافذة تسجيل الدخول."
              onDismiss={handleCloseNavigationAuth}
            >
              <Suspense
                fallback={
                  <RouteFallback
                    variant="inline"
                    label="جارٍ فتح نافذة تسجيل الدخول…"
                  />
                }
              >
                <LazyAuthDialog
                  openerRef={navigationAuthOpenerRef}
                  completionFocusRef={headerFocusRef}
                  onRequestClose={handleCloseNavigationAuth}
                  onAuthenticationComplete={handleCloseNavigationAuth}
                  purpose="account"
                />
              </Suspense>
            </RouteErrorBoundary>
          </div>
        )}
      </header>
    </>
  )
}
