import { buildSearchHref, readSearchParam } from '../../lib/route-search'
import { adminWorkspaceTabs } from './sections'

/**
 * The admin dashboard's address-bar state (ADR-001 §2.6, defect #15):
 *
 *   /admin?booking=<id>             opens that booking's detail panel
 *   /admin?tab=blocked-dates        opens a tab (default: bookings);
 *   /admin?tab=security             «أمان الحساب» (authenticator app)
 *
 * WHY replaceState, and no router call: App.tsx owns the only router (pushState
 * in its navigate handler plus its single popstate listener) and renders
 * AdminDashboard without props, so the dashboard cannot reach that handler.
 * Calling pushState and dispatching a synthetic PopStateEvent would duplicate
 * routing: App would re-render the whole route tree for a change local to this
 * page, and Back would step through panels instead of leaving /admin. So the
 * dashboard keeps its tab and open booking in its own state and mirrors them
 * into the URL with history.replaceState, without dispatching anything. The
 * URL stays shareable and reloadable (an email's ?booking=<id> link reopens
 * the panel), and no history entry or listener is added.
 */

export const BUILT_IN_ADMIN_TABS = [
  'bookings',
  'blocked-dates',
  'security',
] as const

export type BuiltInAdminTabId = (typeof BUILT_IN_ADMIN_TABS)[number]

/** The tab shown when the URL names none (or an unknown one). */
export const DEFAULT_ADMIN_TAB: BuiltInAdminTabId = 'bookings'

/** Same bound as the Worker's MAXIMUM_BOOKING_ID_LENGTH (worker/admin.ts). */
const MAXIMUM_BOOKING_ID_LENGTH = 128

const BOOKING_PARAM = 'booking'
const TAB_PARAM = 'tab'

export interface AdminLocation {
  /** A built-in tab id or a registered workspace tab id. */
  tab: string
  bookingId: string | null
  /** The URL carried a ?booking= value that cannot be a booking id. */
  hasInvalidBookingParam: boolean
}

/** The shape the Worker accepts: 1–128 characters, no control characters. */
export function isPlausibleBookingId(value: string): boolean {
  if (value.length === 0 || value.length > MAXIMUM_BOOKING_ID_LENGTH) {
    return false
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0)

    if (
      codePoint === undefined ||
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return false
    }
  }

  return true
}

export function isKnownAdminTab(value: string): boolean {
  return (
    BUILT_IN_ADMIN_TABS.some((tabId) => tabId === value) ||
    adminWorkspaceTabs.some((tab) => tab.id === value)
  )
}

/** Reads ?tab= and ?booking= from the current URL (call during render). */
export function readAdminLocation(): AdminLocation {
  const tabParam = readSearchParam(TAB_PARAM)
  const bookingParam = readSearchParam(BOOKING_PARAM)
  const isBookingParamValid =
    bookingParam !== null && isPlausibleBookingId(bookingParam)

  return {
    tab:
      tabParam !== null && isKnownAdminTab(tabParam)
        ? tabParam
        : DEFAULT_ADMIN_TAB,
    bookingId: isBookingParamValid ? bookingParam : null,
    hasInvalidBookingParam: bookingParam !== null && !isBookingParamValid,
  }
}

/**
 * Mirrors the dashboard state into the address bar with replaceState (see the
 * note at the top of this file). The default tab is left out, so an email's
 * `/admin?booking=<id>` link is already the canonical URL. Returns the
 * resulting `location.search`, which the dashboard records so it can tell its
 * own writes apart from a Back/Forward that App.tsx re-renders it for.
 */
export function writeAdminLocation(
  tab: string,
  bookingId: string | null,
): string {
  const nextHref = `${buildSearchHref({
    [TAB_PARAM]: tab === DEFAULT_ADMIN_TAB ? null : tab,
    [BOOKING_PARAM]: bookingId,
  })}${window.location.hash}`
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`

  if (nextHref !== currentHref) {
    window.history.replaceState(window.history.state, '', nextHref)
  }

  return window.location.search
}

/** DOM id of a dashboard tab button. */
export function getAdminTabDomId(tabId: string): string {
  return `admin-tab-${tabId}`
}

/** DOM id of a dashboard tab panel (always rendered, so aria-controls resolves). */
export function getAdminPanelDomId(tabId: string): string {
  return `admin-panel-${tabId}`
}
