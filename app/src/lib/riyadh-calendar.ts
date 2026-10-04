/**
 * Calendar dates for the site's two date grids: the bride's booking calendar
 * (components/BookingCalendar) and the admin's blocked-dates manager
 * (components/BlockedDatesManager). They share this one model so they never
 * drift apart, and a fix made here applies to both.
 *
 * - "Today" is the calendar date in Asia/Riyadh — the date the Worker's
 *   PAST_DATE rules compare against (worker/bookings.ts, worker/admin.ts) —
 *   never the device's own time zone.
 * - Dates travel as `YYYY-MM-DD` keys (the API's format; they sort
 *   chronologically as strings). Day and month arithmetic runs on UTC noon,
 *   so no local time zone or daylight-saving shift can move a day.
 * - Weeks start on Saturday.
 * - The keyboard model is the WAI-ARIA APG date grid, with arrow keys that
 *   follow the physical layout of a right-to-left grid.
 */

export const RIYADH_TIME_ZONE = 'Asia/Riyadh'

// Asia/Riyadh is UTC+03:00 all year (no daylight saving time). Used only if
// the Intl parts below are ever unusable.
const RIYADH_UTC_OFFSET_MS = 3 * 60 * 60 * 1000

export const DAYS_PER_WEEK = 7

/** Saturday-first weekday names, in grid column order. */
export const WEEKDAY_LABELS = [
  'السبت',
  'الأحد',
  'الاثنين',
  'الثلاثاء',
  'الأربعاء',
  'الخميس',
  'الجمعة',
] as const

export interface CalendarMonth {
  year: number
  /** Zero-based, as in `Date`. */
  monthIndex: number
}

export interface CalendarDay extends CalendarMonth {
  /** Day of the month, 1–31. */
  day: number
  /** `YYYY-MM-DD`. */
  key: string
}

export interface DateKeyRange {
  from: string
  to: string
}

// Same options as `riyadhDateFormatter` in worker/bookings.ts and
// worker/admin.ts. en-US yields ASCII digits.
const riyadhDatePartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: RIYADH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Noon UTC on that day. Out-of-range days and months roll over as in `Date`. */
function createUtcNoon(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0)

  // setUTCFullYear, unlike Date.UTC, never maps years 0–99 onto 1900–1999.
  date.setUTCFullYear(year, monthIndex, day)
  date.setUTCHours(12, 0, 0, 0)

  return date
}

function padDatePart(value: number, length: number): string {
  return String(value).padStart(length, '0')
}

/** Reads the UTC fields of `date` as a calendar day. */
function readUtcCalendarDay(date: Date): CalendarDay {
  const year = date.getUTCFullYear()
  const monthIndex = date.getUTCMonth()
  const day = date.getUTCDate()

  return {
    year,
    monthIndex,
    day,
    key: `${padDatePart(year, 4)}-${padDatePart(monthIndex + 1, 2)}-${padDatePart(day, 2)}`,
  }
}

/**
 * The calendar day at (year, monthIndex, day), normalised as `Date` does:
 * day 0 is the last day of the previous month, day 32 rolls into the next.
 */
export function createCalendarDay(
  year: number,
  monthIndex: number,
  day: number,
): CalendarDay {
  return readUtcCalendarDay(createUtcNoon(year, monthIndex, day))
}

/** Parses a strict `YYYY-MM-DD` key; null for any other text or an impossible date. */
export function parseDateKey(value: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return null
  }

  const calendarDay = createCalendarDay(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  )

  // A rolled-over date (2026-02-30 → 2026-03-02) no longer matches its key.
  return calendarDay.key === value ? calendarDay : null
}

/**
 * A `Date` for display only: noon UTC on that day. Format it with
 * `timeZone: RIYADH_TIME_ZONE` and it shows the same day on every device.
 */
export function toDisplayDate(
  calendarDay: Pick<CalendarDay, 'year' | 'monthIndex' | 'day'>,
): Date {
  return createUtcNoon(
    calendarDay.year,
    calendarDay.monthIndex,
    calendarDay.day,
  )
}

/**
 * Today's calendar date in Asia/Riyadh, whatever the device's time zone.
 * Read from Intl parts (never `toISOString`, which reads UTC fields); if
 * those parts are ever unusable, the fixed +03:00 offset is applied to the
 * UTC fields instead. Every path yields a valid day and nothing here throws.
 */
export function getRiyadhToday(now: Date = new Date()): CalendarDay {
  const parts = riyadhDatePartsFormatter.formatToParts(now)
  const readPart = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  const intlToday = parseDateKey(
    `${readPart('year')}-${readPart('month')}-${readPart('day')}`,
  )

  return (
    intlToday ??
    readUtcCalendarDay(new Date(now.getTime() + RIYADH_UTC_OFFSET_MS))
  )
}

/** Pure state updater: keeps the same object (no re-render) while the day is unchanged. */
export function keepOrReplaceToday(next: CalendarDay) {
  return (current: CalendarDay): CalendarDay =>
    current.key === next.key ? current : next
}

/**
 * Calls `onReturn` whenever the page regains focus or becomes visible again,
 * so a tab left open past midnight (Riyadh) can re-read today. Returns the
 * cleanup that removes both listeners.
 */
export function listenForPageReturn(onReturn: () => void): () => void {
  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      onReturn()
    }
  }

  window.addEventListener('focus', onReturn)
  document.addEventListener('visibilitychange', handleVisibilityChange)

  return () => {
    window.removeEventListener('focus', onReturn)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  }
}

export function toCalendarMonth(month: CalendarMonth): CalendarMonth {
  return {
    year: month.year,
    monthIndex: month.monthIndex,
  }
}

/** Months since year 0, so months compare and add as plain numbers. */
export function toMonthNumber(month: CalendarMonth): number {
  return month.year * 12 + month.monthIndex
}

/** Negative when `first` is the earlier month, 0 for the same month. */
export function compareMonths(
  first: CalendarMonth,
  second: CalendarMonth,
): number {
  return toMonthNumber(first) - toMonthNumber(second)
}

/**
 * `month` itself when it is not before `earliestMonth` (so a state updater
 * that returns it causes no re-render), else `earliestMonth` as a month.
 * Both grids use it so they never show a month that is wholly in the past.
 */
export function clampMonthNotBefore(
  month: CalendarMonth,
  earliestMonth: CalendarMonth,
): CalendarMonth {
  return compareMonths(month, earliestMonth) < 0
    ? toCalendarMonth(earliestMonth)
    : month
}

/**
 * The mirror of clampMonthNotBefore: `month` itself unless it is after
 * `latestMonth` (the booking calendar's horizon), else `latestMonth`.
 */
export function clampMonthNotAfter(
  month: CalendarMonth,
  latestMonth: CalendarMonth,
): CalendarMonth {
  return compareMonths(month, latestMonth) > 0
    ? toCalendarMonth(latestMonth)
    : month
}

export function addMonths(
  month: CalendarMonth,
  monthOffset: number,
): CalendarMonth {
  const monthNumber = toMonthNumber(month) + monthOffset

  return {
    year: Math.floor(monthNumber / 12),
    monthIndex: ((monthNumber % 12) + 12) % 12,
  }
}

export function getDaysInMonth(month: CalendarMonth): number {
  return createUtcNoon(month.year, month.monthIndex + 1, 0).getUTCDate()
}

/** First and last day of the month, as keys. */
export function getMonthRange(month: CalendarMonth): DateKeyRange {
  return {
    from: createCalendarDay(month.year, month.monthIndex, 1).key,
    to: createCalendarDay(
      month.year,
      month.monthIndex,
      getDaysInMonth(month),
    ).key,
  }
}

export function isDateKeyInRange(
  key: string,
  range: DateKeyRange,
): boolean {
  return key >= range.from && key <= range.to
}

/** Grid column of a day in a Saturday-first week: 0 = Saturday … 6 = Friday. */
export function getWeekdayColumn(calendarDay: CalendarDay): number {
  return (toDisplayDate(calendarDay).getUTCDay() + 1) % DAYS_PER_WEEK
}

/**
 * The month as Saturday-first weeks of seven cells — only the rows the month
 * needs. `null` fills the cells before the 1st and after the last day.
 */
export function buildMonthWeeks(
  month: CalendarMonth,
): (CalendarDay | null)[][] {
  const leadingCellCount = getWeekdayColumn(
    createCalendarDay(month.year, month.monthIndex, 1),
  )
  const daysInMonth = getDaysInMonth(month)
  const weekCount = Math.ceil(
    (leadingCellCount + daysInMonth) / DAYS_PER_WEEK,
  )

  return Array.from({ length: weekCount }, (_, weekIndex) =>
    Array.from(
      { length: DAYS_PER_WEEK },
      (_, column): CalendarDay | null => {
        const day =
          weekIndex * DAYS_PER_WEEK + column - leadingCellCount + 1

        return day < 1 || day > daysInMonth
          ? null
          : createCalendarDay(month.year, month.monthIndex, day)
      },
    ),
  )
}

function addDays(calendarDay: CalendarDay, dayOffset: number): CalendarDay {
  return createCalendarDay(
    calendarDay.year,
    calendarDay.monthIndex,
    calendarDay.day + dayOffset,
  )
}

/** Same day of another month, clamped to that month's length (31 Jan → 28/29 Feb). */
function addMonthsKeepingDay(
  calendarDay: CalendarDay,
  monthOffset: number,
): CalendarDay {
  const targetMonth = addMonths(calendarDay, monthOffset)

  return createCalendarDay(
    targetMonth.year,
    targetMonth.monthIndex,
    Math.min(calendarDay.day, getDaysInMonth(targetMonth)),
  )
}

function clampToMonth(
  calendarDay: CalendarDay,
  month: CalendarMonth,
): CalendarDay {
  const range = getMonthRange(month)

  if (calendarDay.key < range.from) {
    return createCalendarDay(month.year, month.monthIndex, 1)
  }

  return calendarDay.key > range.to
    ? createCalendarDay(month.year, month.monthIndex, getDaysInMonth(month))
    : calendarDay
}

/**
 * Whether `element` is laid out right to left. Call it synchronously inside
 * the event handler (with `event.currentTarget`), never in a deferred updater.
 */
export function isRightToLeft(element: Element): boolean {
  return window.getComputedStyle(element).direction === 'rtl'
}

/** The parts of a keydown event the grid reads; a React or DOM event fits. */
export interface DateGridKeyInput {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export interface DateGridKeyContext {
  /** The day that has focus; it is in `visibleMonth`. */
  focusedDay: CalendarDay
  /** The month the grid shows. */
  visibleMonth: CalendarMonth
  /** The earliest month the grid may show (today's month in Riyadh). */
  earliestMonth: CalendarMonth
  /** The latest month the grid may show, when it has one (booking horizon). */
  latestMonth?: CalendarMonth
  /** Read with `isRightToLeft(event.currentTarget)`. */
  isRightToLeft: boolean
}

/**
 * - `unhandled`: not a grid key (or a modified one) — leave it to the browser.
 * - `blocked`: a grid key with nowhere to go (the move would show a month
 *   before `earliestMonth` or after `latestMonth`) — swallow it and keep
 *   focus where it is.
 * - `move`: focus `target`; when `changesMonth` is true the grid must show
 *   the target's month first.
 */
export type DateGridKeyResult =
  | { kind: 'unhandled' }
  | { kind: 'blocked' }
  | { kind: 'move'; target: CalendarDay; changesMonth: boolean }

/**
 * Keyboard model of the WAI-ARIA APG date grid.
 * - ArrowRight / ArrowLeft follow the physical layout: in a right-to-left
 *   grid the day on the right is the previous day, so ArrowRight goes back
 *   and ArrowLeft goes forward (the reverse in a left-to-right grid).
 * - ArrowUp / ArrowDown: the same weekday one week earlier / later.
 * - Home / End: the first / last day of the focused week row. The row only
 *   holds this month's days, so the move stays inside the visible month.
 * - PageUp / PageDown: the same day one month earlier / later (clamped to
 *   that month's length); with Shift, one year earlier / later.
 * Moves inside the visible month are always allowed; moves into another
 * month are refused when that month is before `earliestMonth` or after
 * `latestMonth`.
 */
export function resolveDateGridKey(
  input: DateGridKeyInput,
  context: DateGridKeyContext,
): DateGridKeyResult {
  if (input.altKey || input.ctrlKey || input.metaKey) {
    return { kind: 'unhandled' }
  }

  const { focusedDay, visibleMonth, earliestMonth } = context
  const rightStep = context.isRightToLeft ? -1 : 1
  const weekdayColumn = getWeekdayColumn(focusedDay)
  let target: CalendarDay

  switch (input.key) {
    case 'ArrowRight':
      target = addDays(focusedDay, rightStep)
      break
    case 'ArrowLeft':
      target = addDays(focusedDay, -rightStep)
      break
    case 'ArrowUp':
      target = addDays(focusedDay, -DAYS_PER_WEEK)
      break
    case 'ArrowDown':
      target = addDays(focusedDay, DAYS_PER_WEEK)
      break
    case 'Home':
      target = clampToMonth(addDays(focusedDay, -weekdayColumn), visibleMonth)
      break
    case 'End':
      target = clampToMonth(
        addDays(focusedDay, DAYS_PER_WEEK - 1 - weekdayColumn),
        visibleMonth,
      )
      break
    case 'PageUp':
      target = addMonthsKeepingDay(focusedDay, input.shiftKey ? -12 : -1)
      break
    case 'PageDown':
      target = addMonthsKeepingDay(focusedDay, input.shiftKey ? 12 : 1)
      break
    default:
      return { kind: 'unhandled' }
  }

  const changesMonth = compareMonths(target, visibleMonth) !== 0

  if (
    changesMonth &&
    (compareMonths(target, earliestMonth) < 0 ||
      (context.latestMonth !== undefined &&
        compareMonths(target, context.latestMonth) > 0))
  ) {
    return { kind: 'blocked' }
  }

  return { kind: 'move', target, changesMonth }
}
