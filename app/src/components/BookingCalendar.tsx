import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { BOOKING_HORIZON_DAYS } from '../../shared/timing'
import {
  RIYADH_TIME_ZONE,
  WEEKDAY_LABELS,
  addMonths,
  buildMonthWeeks,
  clampMonthNotAfter,
  clampMonthNotBefore,
  compareMonths,
  createCalendarDay,
  getMonthRange,
  getRiyadhToday,
  isDateKeyInRange,
  isRightToLeft,
  keepOrReplaceToday,
  listenForPageReturn,
  parseDateKey,
  resolveDateGridKey,
  toCalendarMonth,
  toDisplayDate,
  type CalendarDay,
  type CalendarMonth,
} from '../lib/riyadh-calendar'
import './BookingCalendar.css'

// Dates use Western digits (design-system §2.3 numerals policy), matching the
// booking date the configurator shows in its summary. The dates formatted
// here come from `toDisplayDate` (noon UTC), so the formatters pin the
// Riyadh time zone and every device shows the same day.
const monthFormatter = new Intl.DateTimeFormat(
  'ar-SA-u-ca-gregory-nu-latn',
  {
    month: 'long',
    year: 'numeric',
    timeZone: RIYADH_TIME_ZONE,
  },
)

const fullDateFormatter = new Intl.DateTimeFormat(
  'ar-SA-u-ca-gregory-nu-latn',
  {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: RIYADH_TIME_ZONE,
  },
)

const dayNumberFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn')

const PENDING_STATE_TEXT =
  'يوجد طلب سابق على هذا التاريخ، ويمكنكِ إرسال طلبكِ وسيُراجَع التوفر لاحقًا'

type ApiAvailabilityStatus = 'pending' | 'unavailable'
type CalendarDateStatus = 'available' | ApiAvailabilityStatus
/** `beyond`: after the booking horizon, not bookable yet. */
type DayState = CalendarDateStatus | 'past' | 'beyond'
type LoadingStatus = 'loading' | 'ready' | 'error'

export type SelectableDateStatus = 'available' | 'pending'

interface BookingCalendarProps {
  selectedDate: string | null
  selectedStatus: SelectableDateStatus | null
  onSelectDate: (
    date: string,
    status: SelectableDateStatus,
  ) => void
}

interface ApiAvailabilityDate {
  date: string
  status: string
}

interface ApiAvailabilityResponse {
  ok: true
  range: {
    from: string
    to: string
  }
  dates: ApiAvailabilityDate[]
}

interface AvailabilityState {
  requestKey: string
  status: LoadingStatus
  dates: ReadonlyMap<string, ApiAvailabilityStatus>
}

interface LegendItem {
  label: string
  state: DayState
  isSelected: boolean
  isToday: boolean
}

const legendItems: readonly LegendItem[] = [
  { label: 'متاح', state: 'available', isSelected: false, isToday: false },
  { label: 'محدَّد', state: 'available', isSelected: true, isToday: false },
  {
    label: 'يوجد طلب سابق',
    state: 'pending',
    isSelected: false,
    isToday: false,
  },
  {
    label: 'غير متاح',
    state: 'unavailable',
    isSelected: false,
    isToday: false,
  },
  { label: 'تاريخ سابق', state: 'past', isSelected: false, isToday: false },
  { label: 'اليوم', state: 'available', isSelected: false, isToday: true },
]

/** Shown in the legend only for the month where the horizon falls. */
const beyondHorizonLegendItem: LegendItem = {
  label: 'بعد المدة المتاحة للحجز',
  state: 'beyond',
  isSelected: false,
  isToday: false,
}

/**
 * The latest bookable day (audit SEC-03): today in Riyadh plus
 * BOOKING_HORIZON_DAYS, the limit the Worker enforces with
 * BOOKING_TOO_FAR_AHEAD.
 */
function getLatestBookableDay(today: CalendarDay): CalendarDay {
  return createCalendarDay(
    today.year,
    today.monthIndex,
    today.day + BOOKING_HORIZON_DAYS,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAvailabilityResponse(
  value: unknown,
): ApiAvailabilityResponse | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !isRecord(value.range) ||
    typeof value.range.from !== 'string' ||
    typeof value.range.to !== 'string' ||
    !Array.isArray(value.dates)
  ) {
    return null
  }

  const dates: ApiAvailabilityDate[] = []

  for (const item of value.dates) {
    if (
      !isRecord(item) ||
      typeof item.date !== 'string' ||
      typeof item.status !== 'string' ||
      !parseDateKey(item.date)
    ) {
      return null
    }

    dates.push({
      date: item.date,
      status: item.status,
    })
  }

  return {
    ok: true,
    range: {
      from: value.range.from,
      to: value.range.to,
    },
    dates,
  }
}

/**
 * The cell's full accessible name (rendered as visually-hidden text — the
 * visible number and markers are aria-hidden): date, state and, when it
 * applies, "today" / "selected".
 */
function getDayDescription(
  calendarDay: CalendarDay,
  dayState: DayState,
  isToday: boolean,
  isSelected: boolean,
  isLoading: boolean,
  hasError: boolean,
): string {
  const parts: string[] = []

  if (isToday) {
    parts.push('اليوم')
  }

  parts.push(fullDateFormatter.format(toDisplayDate(calendarDay)))

  if (dayState === 'past') {
    parts.push('تاريخ سابق وغير متاح للحجز')
  } else if (dayState === 'beyond') {
    parts.push('بعد المدة المتاحة للحجز حاليًا')
  } else if (isLoading) {
    parts.push('جارٍ التحقق من التوفر')
  } else if (hasError) {
    parts.push('تعذر التحقق من التوفر')
  } else if (dayState === 'unavailable') {
    parts.push('غير متاح')
  } else if (dayState === 'pending') {
    parts.push(PENDING_STATE_TEXT)
  } else {
    parts.push('متاح')
  }

  if (isSelected) {
    parts.push('تم اختيار هذا التاريخ')
  }

  return parts.join('، ')
}

function getDayClassName(
  dayState: DayState,
  isToday: boolean,
  isSelected: boolean,
  isUnverified: boolean,
  extraClassName?: string,
): string {
  return [
    'booking-calendar__day',
    `booking-calendar__day--${dayState}`,
    isToday ? 'booking-calendar__day--today' : '',
    isSelected ? 'booking-calendar__day--selected' : '',
    isUnverified ? 'booking-calendar__day--unverified' : '',
    extraClassName ?? '',
  ]
    .filter(Boolean)
    .join(' ')
}

function AlertTriangleIcon() {
  return (
    <svg
      className="notice__icon"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 3.5 2.5 20h19L12 3.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M12 9.5v5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="17.25" r="0.9" fill="currentColor" />
    </svg>
  )
}

function SelectedMarkIcon() {
  return (
    <svg
      className="booking-calendar__mark booking-calendar__mark--selected"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PendingMarkIcon() {
  return (
    <svg
      className="booking-calendar__mark booking-calendar__mark--pending"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 2.5v11M3.24 5.25l9.52 5.5M3.24 10.75l9.52-5.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

interface DayFaceProps {
  label: string
  isPending: boolean
  isSelected: boolean
  isToday: boolean
}

/** The visible (aria-hidden) face of a day: number plus its state markers. */
function DayFace({ label, isPending, isSelected, isToday }: DayFaceProps) {
  return (
    <>
      <span className="booking-calendar__day-number" aria-hidden="true">
        {label}
      </span>
      <span className="booking-calendar__day-marks" aria-hidden="true">
        {isSelected && <SelectedMarkIcon />}
        {isPending && <PendingMarkIcon />}
        {isToday && (
          <span className="booking-calendar__day-caption">اليوم</span>
        )}
      </span>
    </>
  )
}

export default function BookingCalendar({
  selectedDate,
  selectedStatus,
  onSelectDate,
}: BookingCalendarProps) {
  const titleId = useId()
  // Held in state (not frozen at mount): re-read in Asia/Riyadh whenever the
  // displayed month changes and whenever the page regains focus / visibility.
  const [today, setToday] = useState<CalendarDay>(() => getRiyadhToday())
  const [displayedMonth, setDisplayedMonth] = useState<CalendarMonth>(() =>
    toCalendarMonth(today),
  )
  const [focusedDateKey, setFocusedDateKey] = useState<string | null>(
    null,
  )
  const [retryVersion, setRetryVersion] = useState(0)
  const [availabilityState, setAvailabilityState] =
    useState<AvailabilityState>({
      requestKey: '',
      status: 'loading',
      dates: new Map(),
    })
  const gridRef = useRef<HTMLDivElement>(null)
  // Set only by a keyboard month change, so real focus follows the grid into
  // the new month (a mouse click on the month buttons keeps focus there).
  const pendingGridFocusRef = useRef(false)

  const monthRange = useMemo(
    () => getMonthRange(displayedMonth),
    [displayedMonth],
  )
  const weeks = useMemo(
    () => buildMonthWeeks(displayedMonth),
    [displayedMonth],
  )
  const rangeFrom = monthRange.from
  const rangeTo = monthRange.to
  const rangeKey = `${rangeFrom}:${rangeTo}`
  const activeRequestKey = `${rangeKey}:${retryVersion}`
  const monthLabel = monthFormatter.format(
    toDisplayDate({ ...displayedMonth, day: 1 }),
  )
  const latestBookableDay = getLatestBookableDay(today)
  const previousMonthDisabled = compareMonths(displayedMonth, today) <= 0
  const nextMonthDisabled =
    compareMonths(displayedMonth, latestBookableDay) >= 0
  const showsBeyondHorizon =
    compareMonths(displayedMonth, latestBookableDay) === 0 &&
    latestBookableDay.key < rangeTo

  const stateMatchesActiveRequest =
    availabilityState.requestKey === activeRequestKey
  const isLoading =
    !stateMatchesActiveRequest ||
    availabilityState.status === 'loading'
  const hasError =
    stateMatchesActiveRequest &&
    availabilityState.status === 'error'
  const isReady =
    stateMatchesActiveRequest &&
    availabilityState.status === 'ready'
  const activeAvailabilityDates = isReady
    ? availabilityState.dates
    : null

  const selectedDay = selectedDate ? parseDateKey(selectedDate) : null

  function isInDisplayedMonth(dateKey: string | null): dateKey is string {
    return dateKey !== null && isDateKeyInRange(dateKey, monthRange)
  }

  // Roving tabindex: exactly one day is in the tab order — the last focused
  // day of this month, else the selected day, else today, else the 1st.
  const rovingDateKey = isInDisplayedMonth(focusedDateKey)
    ? focusedDateKey
    : isInDisplayedMonth(selectedDate)
      ? selectedDate
      : isInDisplayedMonth(today.key)
        ? today.key
        : rangeFrom

  useEffect(() => {
    const controller = new AbortController()

    async function loadAvailability() {
      const searchParams = new URLSearchParams({
        from: rangeFrom,
        to: rangeTo,
      })

      try {
        const response = await fetch(
          `/api/availability?${searchParams.toString()}`,
          {
            method: 'GET',
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
            },
          },
        )

        if (!response.ok) {
          throw new Error('Availability request failed')
        }

        const responseBody: unknown = await response.json()
        const parsedResponse =
          parseAvailabilityResponse(responseBody)

        if (
          !parsedResponse ||
          parsedResponse.range.from !== rangeFrom ||
          parsedResponse.range.to !== rangeTo
        ) {
          throw new Error('Invalid availability response')
        }

        const nextDates = new Map<
          string,
          ApiAvailabilityStatus
        >()

        for (const item of parsedResponse.dates) {
          if (item.date < rangeFrom || item.date > rangeTo) {
            throw new Error('Availability date outside requested range')
          }

          const normalizedStatus: ApiAvailabilityStatus =
            item.status === 'pending'
              ? 'pending'
              : 'unavailable'

          const existingStatus = nextDates.get(item.date)

          if (
            normalizedStatus === 'unavailable' ||
            existingStatus !== 'unavailable'
          ) {
            nextDates.set(item.date, normalizedStatus)
          }
        }

        if (!controller.signal.aborted) {
          setAvailabilityState({
            requestKey: activeRequestKey,
            status: 'ready',
            dates: nextDates,
          })
        }
      } catch {
        if (!controller.signal.aborted) {
          setAvailabilityState({
            requestKey: activeRequestKey,
            status: 'error',
            dates: new Map(),
          })
        }
      }
    }

    void loadAvailability()

    return () => {
      controller.abort()
    }
  }, [activeRequestKey, rangeFrom, rangeTo])

  // A tab left open past midnight (Riyadh) must not keep yesterday as
  // "today", nor keep showing a month that has wholly passed: re-read it
  // whenever the page regains focus or becomes visible again.
  useEffect(
    () =>
      listenForPageReturn(() => {
        const freshToday = getRiyadhToday()

        setToday(keepOrReplaceToday(freshToday))
        setDisplayedMonth((current) =>
          clampMonthNotBefore(current, freshToday),
        )
      }),
    [],
  )

  // After a keyboard month change the previously focused day unmounts; move
  // real focus onto the new roving day before paint so it never lands on
  // <body>.
  useLayoutEffect(() => {
    if (!pendingGridFocusRef.current) {
      return
    }

    pendingGridFocusRef.current = false
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${rovingDateKey}"]`)
      ?.focus()
  }, [rovingDateKey])

  function handleDayKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    calendarDay: CalendarDay,
  ) {
    const freshToday = getRiyadhToday()
    // The grid's direction is read synchronously, here in the handler.
    const move = resolveDateGridKey(event, {
      focusedDay: calendarDay,
      visibleMonth: displayedMonth,
      earliestMonth: freshToday,
      latestMonth: getLatestBookableDay(freshToday),
      isRightToLeft: isRightToLeft(event.currentTarget),
    })

    if (move.kind === 'unhandled') {
      return
    }

    event.preventDefault()

    if (move.kind === 'blocked') {
      return
    }

    if (move.changesMonth) {
      pendingGridFocusRef.current = true
      setToday(keepOrReplaceToday(freshToday))
      setFocusedDateKey(move.target.key)
      setDisplayedMonth(toCalendarMonth(move.target))
      return
    }

    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${move.target.key}"]`)
      ?.focus()
  }

  function showPreviousMonth() {
    if (previousMonthDisabled) {
      return
    }

    const freshToday = getRiyadhToday()

    setToday(keepOrReplaceToday(freshToday))
    setDisplayedMonth((current) =>
      clampMonthNotBefore(addMonths(current, -1), freshToday),
    )
  }

  function showNextMonth() {
    if (nextMonthDisabled) {
      return
    }

    const freshToday = getRiyadhToday()

    setToday(keepOrReplaceToday(freshToday))
    setDisplayedMonth((current) =>
      clampMonthNotAfter(
        addMonths(current, 1),
        getLatestBookableDay(freshToday),
      ),
    )
  }

  return (
    <section className="booking-calendar" aria-labelledby={titleId}>
      <header className="booking-calendar__introduction">
        <p className="eyebrow booking-calendar__eyebrow">اختيار الموعد</p>
        <h3 id={titleId}>حددي تاريخ مناسبتكِ</h3>
        <p>
          المواعيد المتاحة قابلة للاختيار مباشرة، أما الطلبات غير
          المؤكدة فتخضع للمراجعة قبل اعتماد الموعد.
        </p>
        <p className="booking-calendar__horizon">
          {`يمكنكِ الحجز حتى ${fullDateFormatter.format(toDisplayDate(latestBookableDay))}.`}
        </p>
      </header>

      <div className="booking-calendar__navigation">
        {/* aria-disabled (not disabled) keeps focus on the button when it
            reaches the current month, instead of dropping it to <body>. */}
        <button
          type="button"
          className="btn btn--secondary booking-calendar__nav-button"
          onClick={showPreviousMonth}
          aria-disabled={previousMonthDisabled}
          aria-label="عرض الشهر السابق"
        >
          الشهر السابق
        </button>

        <p
          className="booking-calendar__month"
          aria-live="polite"
          aria-atomic="true"
        >
          {monthLabel}
        </p>

        <button
          type="button"
          className="btn btn--secondary booking-calendar__nav-button"
          onClick={showNextMonth}
          aria-disabled={nextMonthDisabled}
          aria-label="عرض الشهر التالي"
        >
          الشهر التالي
        </button>
      </div>

      <div
        className="booking-calendar__load-state"
        aria-live="polite"
        aria-atomic="true"
      >
        {isLoading && (
          <p className="booking-calendar__loading">
            جارٍ تحميل توفر المواعيد…
          </p>
        )}

        {hasError && (
          <div
            className="notice notice--danger booking-calendar__error"
            role="alert"
          >
            <AlertTriangleIcon />
            <div className="booking-calendar__error-body">
              <p>
                تعذر تحميل المواعيد لهذا الشهر. تحققي من الاتصال ثم
                حاولي مرة أخرى.
              </p>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() =>
                  setRetryVersion((current) => current + 1)
                }
              >
                إعادة المحاولة
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        className="booking-calendar__grid"
        role="grid"
        aria-label={`تقويم ${monthLabel}`}
        aria-busy={isLoading}
        ref={gridRef}
      >
        <div className="booking-calendar__row" role="row">
          {WEEKDAY_LABELS.map((weekday) => (
            <span
              className="booking-calendar__weekday"
              role="columnheader"
              key={weekday}
            >
              {weekday}
            </span>
          ))}
        </div>

        {weeks.map((week, weekIndex) => (
          <div
            className="booking-calendar__row"
            role="row"
            key={`${rangeFrom}-week-${weekIndex}`}
          >
            {week.map((calendarDay, dayIndex) => {
              if (!calendarDay) {
                return (
                  <span
                    className="booking-calendar__empty-day"
                    role="gridcell"
                    key={`empty-${dayIndex}`}
                  />
                )
              }

              const dateKey = calendarDay.key
              const availability: CalendarDateStatus =
                activeAvailabilityDates?.get(dateKey) ?? 'available'
              const dayState: DayState =
                dateKey < today.key
                  ? 'past'
                  : dateKey > latestBookableDay.key
                    ? 'beyond'
                    : availability
              const isToday = dateKey === today.key
              const isSelected = selectedDate === dateKey
              const isOutsideWindow =
                dayState === 'past' || dayState === 'beyond'
              const isDisabled =
                isOutsideWindow || dayState === 'unavailable' || !isReady

              return (
                <button
                  className={getDayClassName(
                    dayState,
                    isToday,
                    isSelected,
                    !isReady && !isOutsideWindow,
                  )}
                  type="button"
                  role="gridcell"
                  key={dateKey}
                  data-date={dateKey}
                  tabIndex={dateKey === rovingDateKey ? 0 : -1}
                  aria-selected={isSelected ? true : undefined}
                  aria-disabled={isDisabled ? true : undefined}
                  aria-current={isToday ? 'date' : undefined}
                  onFocus={() => {
                    setFocusedDateKey(dateKey)
                  }}
                  onKeyDown={(event) => {
                    handleDayKeyDown(event, calendarDay)
                  }}
                  onClick={() => {
                    if (isDisabled) {
                      return
                    }

                    onSelectDate(
                      dateKey,
                      dayState === 'pending' ? 'pending' : 'available',
                    )
                  }}
                >
                  <DayFace
                    label={dayNumberFormatter.format(calendarDay.day)}
                    isPending={dayState === 'pending'}
                    isSelected={isSelected}
                    isToday={isToday}
                  />
                  <span className="booking-calendar__visually-hidden">
                    {getDayDescription(
                      calendarDay,
                      dayState,
                      isToday,
                      isSelected,
                      isLoading,
                      hasError,
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      <ul
        className="booking-calendar__legend"
        aria-label="دليل حالات المواعيد"
      >
        {(showsBeyondHorizon
          ? [...legendItems, beyondHorizonLegendItem]
          : legendItems
        ).map((item) => (
          <li className="booking-calendar__legend-item" key={item.label}>
            <span
              className={getDayClassName(
                item.state,
                item.isToday,
                item.isSelected,
                false,
                'booking-calendar__day--swatch',
              )}
              aria-hidden="true"
            >
              <DayFace
                label={dayNumberFormatter.format(12)}
                isPending={item.state === 'pending'}
                isSelected={item.isSelected}
                isToday={item.isToday}
              />
            </span>
            {item.label}
          </li>
        ))}
      </ul>

      <div
        className="booking-calendar__selection"
        aria-live="polite"
        aria-atomic="true"
      >
        {selectedDay ? (
          <>
            <p className="booking-calendar__selection-summary">
              <span>التاريخ المختار</span>
              <strong>
                {fullDateFormatter.format(toDisplayDate(selectedDay))}
              </strong>
            </p>

            {selectedStatus === 'pending' && (
              <div className="notice notice--warning booking-calendar__pending-warning">
                <AlertTriangleIcon />
                <p>{PENDING_STATE_TEXT}.</p>
              </div>
            )}
          </>
        ) : (
          <p className="booking-calendar__no-selection">
            لم يتم اختيار تاريخ المناسبة بعد.
          </p>
        )}
      </div>
    </section>
  )
}
