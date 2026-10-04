import { useCallback, useMemo, useSyncExternalStore } from 'react'

/**
 * The booking-detail layout breakpoints of AdminDashboard.css (design-system
 * §3.1 and §5.8): below 64rem the detail is one stacked column with the
 * status-change buttons in a sticky bottom bar; from 80rem it is three
 * columns with a sticky summary column.
 */
export const ADMIN_STACKED_LAYOUT_QUERY = '(max-width: 63.99rem)'
export const ADMIN_WIDE_LAYOUT_QUERY = '(min-width: 80rem)'

/** Whether a CSS media query matches now; re-renders when that changes. */
export function useMediaQuery(query: string): boolean {
  const mediaQueryList = useMemo(() => window.matchMedia(query), [query])
  const subscribe = useCallback(
    (onChange: () => void) => {
      mediaQueryList.addEventListener('change', onChange)

      return () => mediaQueryList.removeEventListener('change', onChange)
    },
    [mediaQueryList],
  )
  const getSnapshot = useCallback(
    () => mediaQueryList.matches,
    [mediaQueryList],
  )

  return useSyncExternalStore(subscribe, getSnapshot)
}
