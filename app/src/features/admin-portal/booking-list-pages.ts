import type { AdminBookingSummary } from '../../../shared/admin'
import {
  fetchAdminBookings,
  type AdminApiResult,
  type AdminBookingListFilters,
  type AdminSession,
} from '../../api/admin'
import { formatBookingRequestCount } from './format'

/**
 * «عرض المزيد» for the bookings list (inspection #4). GET /api/admin/bookings
 * is keyset-paginated, newest first; these are the pages loaded so far for
 * ONE set of filters, appended in order.
 */
export interface AdminBookingListPages {
  bookings: AdminBookingSummary[]
  /** Opaque cursor for the next (older) page; null once the last is in. */
  nextCursor: string | null
  pageCount: number
}

/** A refresh reloads as many pages as were open, but never more than this. */
export const MAXIMUM_RELOAD_PAGES = 10

export type AdminBookingPageFilters = Omit<AdminBookingListFilters, 'cursor'>

/** Appends one page; a row already in the list is never shown twice. */
export function appendBookingPage(
  pages: AdminBookingListPages,
  bookings: readonly AdminBookingSummary[],
  nextCursor: string | null,
): AdminBookingListPages {
  const knownIds = new Set(pages.bookings.map((booking) => booking.id))
  const appendedBookings: AdminBookingSummary[] = []

  for (const booking of bookings) {
    if (!knownIds.has(booking.id)) {
      knownIds.add(booking.id)
      appendedBookings.push(booking)
    }
  }

  return {
    bookings: [...pages.bookings, ...appendedBookings],
    nextCursor,
    pageCount: pages.pageCount + 1,
  }
}

/** The first row of `bookings` that `pages` does not show yet, if any. */
export function findFirstNewBooking(
  pages: AdminBookingListPages,
  bookings: readonly AdminBookingSummary[],
): AdminBookingSummary | null {
  const knownIds = new Set(pages.bookings.map((booking) => booking.id))

  return bookings.find((booking) => !knownIds.has(booking.id)) ?? null
}

/**
 * Loads the first page, then follows the cursor until `pageDepth` pages are
 * in (a refresh keeps the depth the admin had opened). If a later page
 * fails, the pages that did load are kept and «عرض المزيد» retries from the
 * failed page; only a failed FIRST page is an error. With a `session`, a
 * REAUTH_REQUIRED on the first page asks for her password once, and the
 * later pages then use the fresh token.
 */
export async function loadAdminBookingPages(
  token: string,
  filters: AdminBookingPageFilters,
  pageDepth: number,
  signal: AbortSignal,
  session?: AdminSession,
): Promise<AdminApiResult<AdminBookingListPages>> {
  const firstPage = await fetchAdminBookings(token, filters, signal, session)

  if (!firstPage.ok) {
    return firstPage
  }

  const targetPageCount = Math.min(
    Math.max(Math.trunc(pageDepth), 1),
    MAXIMUM_RELOAD_PAGES,
  )
  let pages: AdminBookingListPages = {
    bookings: [...firstPage.data.bookings],
    nextCursor: firstPage.data.nextCursor ?? null,
    pageCount: 1,
  }

  while (pages.nextCursor !== null && pages.pageCount < targetPageCount) {
    const pageToken = (await session?.getIdToken()) ?? token
    const nextPage = await fetchAdminBookings(
      pageToken,
      { ...filters, cursor: pages.nextCursor },
      signal,
      session,
    )

    if (!nextPage.ok) {
      if (nextPage.error.kind === 'aborted') {
        return nextPage
      }

      break
    }

    pages = appendBookingPage(
      pages,
      nextPage.data.bookings,
      nextPage.data.nextCursor ?? null,
    )
  }

  return {
    ok: true,
    data: pages,
  }
}

/**
 * The count label claims a total only when it knows one: with more pages on
 * the server it says how many are SHOWN and that older ones exist.
 */
export function formatLoadedBookingCount(
  pages: AdminBookingListPages,
): string {
  if (pages.nextCursor === null) {
    return formatBookingRequestCount(pages.bookings.length)
  }

  if (pages.bookings.length === 0) {
    return 'توجد طلبات أقدم لم تُعرض بعد'
  }

  return `المعروض الآن ${formatBookingRequestCount(
    pages.bookings.length,
  )}، وتوجد طلبات أقدم`
}
