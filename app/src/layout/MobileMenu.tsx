import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { MenuIcon, InstagramIcon, TikTokIcon } from './icons'
import {
  BOOKING_REQUEST_HREF,
  type NavigationHandler,
  type NavigationLink,
  type PublicPath,
} from './navigation'
import { NEW_TAB_HINT, socialLinks } from './social-links'
import './MobileMenu.css'

/** Must match the breakpoint where SiteHeader.css shows the desktop nav. */
const DESKTOP_NAV_QUERY = '(min-width: 64rem)'
const SCROLL_LOCK_CLASS = 'is-scroll-locked'

interface MobileMenuProps {
  isOpen: boolean
  activePath: PublicPath
  navigationItems: readonly NavigationLink[]
  authControls: ReactNode
  toggleRef: RefObject<HTMLButtonElement | null>
  onToggle: () => void
  /** Closes the menu; `returnFocus` sends focus back to the toggle. */
  onRequestClose: (returnFocus: boolean) => void
  /** Navigates and closes the menu (SiteHeader's mobile handler). */
  onNavigate: NavigationHandler
}

/**
 * Mobile navigation as a disclosure: one toggle button (aria-expanded +
 * aria-controls) and a sheet that slides in from the reading-start edge
 * (the right edge in RTL) below the sticky header. Closes on navigation,
 * Escape, outside click / scrim tap, focus leaving the menu and when the
 * viewport reaches the desktop layout. The page behind does not scroll
 * while it is open.
 */
export default function MobileMenu({
  isOpen,
  activePath,
  navigationItems,
  authControls,
  toggleRef,
  onToggle,
  onRequestClose,
  onNavigate,
}: MobileMenuProps) {
  const panelId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) {
      return undefined
    }

    const rootElement = document.documentElement
    const desktopQuery = window.matchMedia(DESKTOP_NAV_QUERY)

    function isInsideMenu(target: EventTarget | null): boolean {
      if (!(target instanceof Node)) {
        return false
      }

      return (
        panelRef.current?.contains(target) === true ||
        toggleRef.current?.contains(target) === true
      )
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onRequestClose(true)
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const { target } = event

      // The scrim handles its own click so focus can return to the toggle.
      if (
        isInsideMenu(target) ||
        (target instanceof Node && scrimRef.current?.contains(target) === true)
      ) {
        return
      }

      onRequestClose(false)
    }

    function handleFocusIn(event: FocusEvent) {
      if (!isInsideMenu(event.target)) {
        onRequestClose(false)
      }
    }

    function handleDesktopChange(event: MediaQueryListEvent) {
      if (event.matches) {
        onRequestClose(false)
      }
    }

    rootElement.classList.add(SCROLL_LOCK_CLASS)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('focusin', handleFocusIn)
    desktopQuery.addEventListener('change', handleDesktopChange)

    return () => {
      rootElement.classList.remove(SCROLL_LOCK_CLASS)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('focusin', handleFocusIn)
      desktopQuery.removeEventListener('change', handleDesktopChange)
    }
  }, [isOpen, onRequestClose, toggleRef])

  const openClassName = isOpen ? ' is-open' : ''

  return (
    <div className="mobile-menu">
      <button
        ref={toggleRef}
        className="mobile-menu__toggle"
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <MenuIcon className="mobile-menu__toggle-icon" isOpen={isOpen} />
        <span>القائمة</span>
      </button>

      <div
        ref={scrimRef}
        className={`mobile-menu__scrim${openClassName}`}
        aria-hidden="true"
        onClick={() => onRequestClose(true)}
      />

      <div
        ref={panelRef}
        id={panelId}
        className={`mobile-menu__panel${openClassName}`}
        inert={!isOpen}
      >
        <nav aria-label="قائمة التنقل">
          <ul className="mobile-menu__list" role="list">
            {navigationItems.map((item) => (
              <li key={item.label}>
                <a
                  className="mobile-menu__link"
                  href={item.href}
                  aria-current={item.path === activePath ? 'page' : undefined}
                  onClick={(event) => onNavigate(event, item.href)}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mobile-menu__auth">{authControls}</div>

        <ul
          className="mobile-menu__social"
          role="list"
          aria-label="حسابات التواصل الاجتماعي"
        >
          {socialLinks.map((link) => (
            <li key={link.network}>
              <a
                className="mobile-menu__social-link"
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {link.network === 'instagram' ? (
                  <InstagramIcon className="mobile-menu__social-icon" />
                ) : (
                  <TikTokIcon className="mobile-menu__social-icon" />
                )}
                <span>{link.label}</span>
                <span className="visually-hidden">
                  {' '}
                  <bdi dir="ltr">{link.handle}</bdi> {NEW_TAB_HINT}
                </span>
              </a>
            </li>
          ))}
        </ul>

        <a
          className="btn btn--primary btn--lg mobile-menu__cta"
          href={BOOKING_REQUEST_HREF}
          onClick={(event) => onNavigate(event, BOOKING_REQUEST_HREF)}
        >
          ابدئي طلب الحجز
        </a>
      </div>
    </div>
  )
}
