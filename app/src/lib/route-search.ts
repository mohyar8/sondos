/**
 * Query-string helpers for the custom History-API router (React Router is not
 * used). Views inside a page — e.g. /my-bookings?booking=<id>&view=gallery or
 * /admin?booking=<id>&tab=queue (ADR-001 §2.6) — read their parameters here.
 *
 * No listener is added: App.tsx already re-renders the whole route tree on
 * every navigation (pushState through its navigate handler, or its single
 * popstate listener), so reading window.location during render is always
 * current. Never add a second popstate listener for this.
 */

/** The value of one query parameter, or null when absent or empty. */
export function readSearchParam(name: string): string | null {
  const value = new URLSearchParams(window.location.search).get(name)
  return value === null || value.length === 0 ? null : value
}

/**
 * Builds `<pathname>?<params>` from the current pathname and the given
 * parameters; null or empty values are dropped. Pass the result to the router's
 * navigate handler (never to window.location directly).
 */
export function buildSearchHref(
  params: Readonly<Record<string, string | null | undefined>>,
  pathname: string = window.location.pathname,
): string {
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.length > 0) {
      search.set(key, value)
    }
  }

  const query = search.toString()
  return query.length > 0 ? `${pathname}?${query}` : pathname
}
