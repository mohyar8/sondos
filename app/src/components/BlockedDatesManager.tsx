import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  AdminBlockedDate,
  AdminBlockedDateResponse,
  AdminBlockedDatesResponse,
  AdminDeleteBlockedDateResponse,
} from '../../shared/admin'
import {
  ADMIN_MFA_REQUIRED_CODE,
  ADMIN_MFA_REQUIRED_MESSAGE,
  deleteAdminBlockedDate,
  getAdminBlockedDates,
  getAdminLimitMessage,
  saveAdminBlockedDate,
  type AdminApiError,
  type AdminApiResult,
  type AdminSession,
} from '../api/admin'
import { useAuth } from '../auth/auth-context'
import { NEW_TAB_HINT } from '../layout/social-links'
import { isTopmostModal } from '../lib/modal-stack'
import {
  RIYADH_TIME_ZONE,
  WEEKDAY_LABELS,
  addMonths,
  buildMonthWeeks,
  clampMonthNotBefore,
  compareMonths,
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
import './BlockedDatesManager.css'

interface BlockedDatesManagerProps {
  getIdToken: () => Promise<string | null>
}

interface BlockedDatesRequestState {
  key: string
  result: AdminApiResult<AdminBlockedDatesResponse>
}

type DateDialogState =
  | {
      mode: 'create'
      date: string
    }
  | {
      mode: 'view' | 'edit' | 'delete'
      blockedDate: AdminBlockedDate
    }

interface IconProps {
  className?: string
}

const MAXIMUM_REASON_LENGTH = 500
const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const monthHeadingFormatter = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: 'long',
  timeZone: RIYADH_TIME_ZONE,
})

const fullDateFormatter = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  calendar: 'gregory',
  numberingSystem: 'latn',
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: RIYADH_TIME_ZONE,
})

const timestampFormatter = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  calendar: 'gregory',
  numberingSystem: 'latn',
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: RIYADH_TIME_ZONE,
})

function formatFullDate(value: string): string {
  const calendarDay = parseDateKey(value)

  return calendarDay
    ? fullDateFormatter.format(toDisplayDate(calendarDay))
    : value
}

function formatTimestamp(value: string): string {
  const date = new Date(value)

  return Number.isNaN(date.getTime())
    ? 'غير متوفر'
    : timestampFormatter.format(date)
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index)

    if (
      characterCode <= 0x1f ||
      (characterCode >= 0x7f && characterCode <= 0x9f)
    ) {
      return true
    }
  }

  return false
}

function createUnauthenticatedResult<T>(): AdminApiResult<T> {
  return {
    ok: false,
    error: {
      kind: 'unauthenticated',
      code: 'UNAUTHENTICATED',
    },
  }
}

function getApiErrorMessage(error: AdminApiError): string {
  // Rate limit, body cap, preview, a declined password prompt.
  const limitMessage = getAdminLimitMessage(error)

  if (limitMessage !== null) {
    return limitMessage
  }

  if (error.code === ADMIN_MFA_REQUIRED_CODE) {
    return ADMIN_MFA_REQUIRED_MESSAGE
  }

  if (error.code === 'DATE_HAS_ACTIVE_BOOKING') {
    return 'يحتوي هذا التاريخ على حجز نشط، لذلك لا يمكن حجبه يدويًا.'
  }

  if (
    error.code === 'INVALID_DATE' ||
    error.code === 'INVALID_BLOCKED_DATE' ||
    error.code === 'INVALID_DATE_RANGE'
  ) {
    return 'التاريخ أو بيانات اليوم المحجوب غير صحيحة.'
  }

  if (error.code === 'PAST_DATE') {
    return 'لا يمكن حجب تاريخ سابق لليوم.'
  }

  switch (error.kind) {
    case 'unauthenticated':
      return 'انتهت جلسة تسجيل الدخول. سجّلي الدخول مرة أخرى للمتابعة.'
    case 'forbidden':
      return 'ليس لديكِ صلاحية إدارة الأيام المحجوبة.'
    case 'not-found':
      return 'تعذر العثور على اليوم المحجوب المطلوب.'
    case 'conflict':
      return 'تعذر تنفيذ العملية بسبب تعارض مع حالة التاريخ الحالية.'
    case 'invalid-request':
      return 'تعذر التحقق من التاريخ أو السبب. راجعي البيانات ثم حاولي مرة أخرى.'
    case 'network':
      return 'تعذر الاتصال بالخدمة حاليًا. تحققي من الاتصال ثم أعيدي المحاولة.'
    case 'server':
      return 'تعذر تنفيذ العملية حاليًا. أعيدي المحاولة بعد قليل.'
    case 'malformed-response':
      return 'وصلت استجابة غير مكتملة من الخدمة. أعيدي المحاولة.'
    case 'aborted':
      return 'تم إيقاف الطلب.'
  }
}

function getDialogDate(state: DateDialogState): string {
  return state.mode === 'create' ? state.date : state.blockedDate.date
}

function getDialogTitle(state: DateDialogState): string {
  switch (state.mode) {
    case 'create':
      return 'حجب يوم جديد'
    case 'view':
      return 'تفاصيل اليوم المحجوب'
    case 'edit':
      return 'تعديل سبب الحجب'
    case 'delete':
      return 'إزالة الحجب اليدوي'
  }
}

function getDayStateLabel(
  isPast: boolean,
  blockedDate: AdminBlockedDate | undefined,
  availabilityKnown: boolean,
): string {
  if (isPast) {
    return 'تاريخ سابق غير قابل للاختيار'
  }

  if (blockedDate) {
    return `محجوب يدويًا${
      blockedDate.reason
        ? `، السبب: ${blockedDate.reason}`
        : '، دون سبب مسجل'
    }`
  }

  return availabilityKnown
    ? 'متاح للحجب اليدوي'
    : 'غير قابل للاختيار حتى اكتمال تحميل البيانات'
}

function AlertTriangleIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

function CheckCircleIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m8 12.5 2.7 2.7L16 9.5" />
    </svg>
  )
}

function InfoIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  )
}

function LockIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

export default function BlockedDatesManager({
  getIdToken,
}: BlockedDatesManagerProps) {
  const { requestReauthentication } = useAuth()
  // Lets a request ask for her password again (401 REAUTH_REQUIRED) and
  // retry once.
  const adminSession = useMemo<AdminSession>(
    () => ({ getIdToken, requestReauthentication }),
    [getIdToken, requestReauthentication],
  )
  const [today, setToday] = useState<CalendarDay>(() => getRiyadhToday())
  const [visibleMonth, setVisibleMonth] = useState<CalendarMonth>(() =>
    toCalendarMonth(today),
  )
  const [focusedDate, setFocusedDate] = useState<string | null>(null)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [requestState, setRequestState] =
    useState<BlockedDatesRequestState | null>(null)
  const [dialogState, setDialogState] =
    useState<DateDialogState | null>(null)
  const [reason, setReason] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [mutationFeedback, setMutationFeedback] =
    useState<string | null>(null)
  const [isMutating, setIsMutating] = useState(false)
  const mutationInProgressRef = useRef(false)
  const mutationAbortRef = useRef<AbortController | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const dialogInitialFocusRef = useRef<HTMLElement | null>(null)
  const dialogOpenerRef = useRef<HTMLButtonElement | null>(null)
  const dayButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocusDateRef = useRef<string | null>(null)
  const sectionTitleId = useId()
  const dialogTitleId = useId()
  const dialogDescriptionId = useId()
  const dialogErrorId = useId()
  const reasonFieldId = useId()
  const reasonCounterId = useId()

  const monthRange = useMemo(
    () => getMonthRange(visibleMonth),
    [visibleMonth],
  )
  const requestKey = `${monthRange.from}|${monthRange.to}|${reloadVersion}`
  const calendarWeeks = useMemo(
    () => buildMonthWeeks(visibleMonth),
    [visibleMonth],
  )
  const activeResult =
    requestState?.key === requestKey ? requestState.result : null
  const blockedDatesByDate = useMemo(() => {
    const blockedDates = new Map<string, AdminBlockedDate>()

    if (activeResult?.ok) {
      for (const blockedDate of activeResult.data.blockedDates) {
        blockedDates.set(blockedDate.date, blockedDate)
      }
    }

    return blockedDates
  }, [activeResult])
  const isLoading = activeResult === null
  const availabilityKnown = activeResult?.ok === true
  const isAtEarliestMonth = compareMonths(visibleMonth, today) <= 0
  const isShowingTodayMonth = compareMonths(visibleMonth, today) === 0
  const monthHeading = monthHeadingFormatter.format(
    toDisplayDate({ ...visibleMonth, day: 1 }),
  )
  const selectedDialogDate = dialogState
    ? getDialogDate(dialogState)
    : null
  // Roving tabindex: exactly one day in the grid is in the tab order.
  const rovingDate =
    focusedDate !== null && isDateKeyInRange(focusedDate, monthRange)
      ? focusedDate
      : isDateKeyInRange(today.key, monthRange)
        ? today.key
        : monthRange.from

  const setDialogInitialFocus = useCallback(
    (element: HTMLElement | null) => {
      dialogInitialFocusRef.current = element
    },
    [],
  )

  /** Re-reads the Riyadh date; keeps the same state object if it has not changed. */
  const refreshToday = useCallback((): CalendarDay => {
    const freshToday = getRiyadhToday()

    setToday(keepOrReplaceToday(freshToday))

    return freshToday
  }, [])

  useEffect(() => {
    const abortController = new AbortController()

    void (async () => {
      const token = await getIdToken()

      if (abortController.signal.aborted) {
        return
      }

      const result = token
        ? await getAdminBlockedDates(
            token,
            monthRange.from,
            monthRange.to,
            abortController.signal,
            adminSession,
          )
        : createUnauthenticatedResult<AdminBlockedDatesResponse>()

      if (
        abortController.signal.aborted ||
        (!result.ok && result.error.kind === 'aborted')
      ) {
        return
      }

      setRequestState({
        key: requestKey,
        result,
      })
    })()

    return () => abortController.abort()
  }, [adminSession, getIdToken, monthRange.from, monthRange.to, requestKey])

  useEffect(
    () => () => {
      mutationAbortRef.current?.abort()
    },
    [],
  )

  // A tab left open past midnight (or past the end of a month) picks up the
  // new Riyadh date as soon as the admin returns to it (focus or visibility).
  useEffect(
    () =>
      listenForPageReturn(() => {
        const freshToday = refreshToday()

        setVisibleMonth((currentMonth) =>
          clampMonthNotBefore(currentMonth, freshToday),
        )
      }),
    [refreshToday],
  )

  // After a keyboard move into another month the previously focused day
  // unmounts; focus the target day before paint, once the new month's
  // buttons exist, so focus never lands on <body>.
  useLayoutEffect(() => {
    const pendingDate = pendingFocusDateRef.current

    if (pendingDate === null) {
      return
    }

    pendingFocusDateRef.current = null

    if (isDateKeyInRange(pendingDate, monthRange)) {
      dayButtonRefs.current.get(pendingDate)?.focus()
    }
  }, [monthRange])

  useEffect(() => {
    if (!dialogState) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const animationFrame = window.requestAnimationFrame(() => {
      const focusTarget =
        dialogInitialFocusRef.current ?? dialogRef.current

      focusTarget?.focus()
    })

    return () => {
      document.body.style.overflow = previousOverflow
      window.cancelAnimationFrame(animationFrame)
    }
  }, [dialogState])

  // The dialog's controls are disabled while a save or a removal runs, which
  // drops focus to <body>; the password prompt, when one opened, hands it
  // back to the dialog itself. When the request fails and the dialog stays
  // open, focus returns to the control it opened on (the reason field, or
  // «العودة» when removing).
  const wasMutatingRef = useRef(isMutating)

  useEffect(() => {
    const hasSettled = wasMutatingRef.current && !isMutating

    wasMutatingRef.current = isMutating

    if (!hasSettled) {
      return
    }

    // A frame later, so it runs after the password prompt's own focus return.
    const animationFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current

      if (!dialog || !isTopmostModal(dialog)) {
        return
      }

      const activeElement = document.activeElement

      if (activeElement !== dialog && dialog.contains(activeElement)) {
        return
      }

      dialogInitialFocusRef.current?.focus()
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [isMutating])

  const closeDialog = useCallback((force = false) => {
    if (mutationInProgressRef.current && !force) {
      return
    }

    const focusTarget = dialogOpenerRef.current

    setDialogState(null)
    setDialogError(null)
    setReason('')

    window.requestAnimationFrame(() => {
      if (focusTarget?.isConnected) {
        focusTarget.focus()
      }
    })
  }, [])

  useEffect(() => {
    if (!dialogState) {
      return
    }

    function handleKeyDown(event: KeyboardEvent) {
      // The password prompt can open over this dialog while a save runs;
      // until it closes, the keyboard is the prompt's.
      if (dialogRef.current && !isTopmostModal(dialogRef.current)) {
        return
      }

      if (event.key === 'Escape') {
        if (!mutationInProgressRef.current) {
          event.preventDefault()
          closeDialog()
        }

        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) {
        return
      }

      const focusableElements = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.getClientRects().length > 0)

      if (focusableElements.length === 0) {
        event.preventDefault()
        dialogRef.current.focus()
        return
      }

      const firstElement = focusableElements[0]
      const lastElement = focusableElements[focusableElements.length - 1]
      const activeElement = document.activeElement

      if (!dialogRef.current.contains(activeElement)) {
        event.preventDefault()
        const focusTarget = event.shiftKey ? lastElement : firstElement
        focusTarget?.focus()
      } else if (event.shiftKey && activeElement === firstElement) {
        event.preventDefault()
        lastElement?.focus()
      } else if (!event.shiftKey && activeElement === lastElement) {
        event.preventDefault()
        firstElement?.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeDialog, dialogState])

  function changeMonth(offset: number) {
    if (offset < 0 && isAtEarliestMonth) {
      return
    }

    const freshToday = refreshToday()

    setVisibleMonth((currentMonth) =>
      clampMonthNotBefore(addMonths(currentMonth, offset), freshToday),
    )
    setMutationFeedback(null)
  }

  function goToToday() {
    if (isShowingTodayMonth) {
      return
    }

    const freshToday = refreshToday()

    setVisibleMonth((currentMonth) =>
      compareMonths(currentMonth, freshToday) === 0
        ? currentMonth
        : toCalendarMonth(freshToday),
    )
    setMutationFeedback(null)
  }

  function retryLoading() {
    setReloadVersion((currentVersion) => currentVersion + 1)
  }

  function handleDayKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    calendarDay: CalendarDay,
  ) {
    const freshToday = getRiyadhToday()
    // The grid's direction is read synchronously, here in the handler.
    const move = resolveDateGridKey(event, {
      focusedDay: calendarDay,
      visibleMonth,
      earliestMonth: freshToday,
      isRightToLeft: isRightToLeft(event.currentTarget),
    })

    if (move.kind === 'unhandled') {
      return
    }

    event.preventDefault()

    if (move.kind === 'blocked') {
      return
    }

    const targetDate = move.target.key

    if (!move.changesMonth) {
      setFocusedDate(targetDate)
      dayButtonRefs.current.get(targetDate)?.focus()
      return
    }

    pendingFocusDateRef.current = targetDate
    setToday(keepOrReplaceToday(freshToday))
    setFocusedDate(targetDate)
    setVisibleMonth(toCalendarMonth(move.target))
    setMutationFeedback(null)
  }

  function openDateDialog(
    event: MouseEvent<HTMLButtonElement>,
    date: string,
    blockedDate: AdminBlockedDate | undefined,
  ) {
    dialogOpenerRef.current = event.currentTarget
    setDialogError(null)
    setMutationFeedback(null)

    if (blockedDate) {
      setReason(blockedDate.reason ?? '')
      setDialogState({ mode: 'view', blockedDate })
    } else {
      setReason('')
      setDialogState({ mode: 'create', date })
    }
  }

  function startEditing(blockedDate: AdminBlockedDate) {
    setReason(blockedDate.reason ?? '')
    setDialogError(null)
    setDialogState({ mode: 'edit', blockedDate })
  }

  function startDeleting(blockedDate: AdminBlockedDate) {
    setDialogError(null)
    setDialogState({ mode: 'delete', blockedDate })
  }

  function returnToBlockedDateDetails(blockedDate: AdminBlockedDate) {
    setReason(blockedDate.reason ?? '')
    setDialogError(null)
    setDialogState({ mode: 'view', blockedDate })
  }

  function updateBlockedDateInActiveMonth(blockedDate: AdminBlockedDate) {
    setRequestState((currentState) => {
      if (currentState?.key !== requestKey || !currentState.result.ok) {
        return currentState
      }

      const nextBlockedDates = currentState.result.data.blockedDates
        .filter((item) => item.date !== blockedDate.date)
        .concat(blockedDate)
        .sort((first, second) => first.date.localeCompare(second.date))

      return {
        key: currentState.key,
        result: {
          ok: true,
          data: {
            ...currentState.result.data,
            blockedDates: nextBlockedDates,
          },
        },
      }
    })
  }

  function removeBlockedDateFromActiveMonth(date: string) {
    setRequestState((currentState) => {
      if (currentState?.key !== requestKey || !currentState.result.ok) {
        return currentState
      }

      return {
        key: currentState.key,
        result: {
          ok: true,
          data: {
            ...currentState.result.data,
            blockedDates: currentState.result.data.blockedDates.filter(
              (item) => item.date !== date,
            ),
          },
        },
      }
    })
  }

  function beginMutation(): AbortController | null {
    if (mutationInProgressRef.current) {
      return null
    }

    const abortController = new AbortController()
    mutationInProgressRef.current = true
    mutationAbortRef.current = abortController
    setIsMutating(true)
    setDialogError(null)

    return abortController
  }

  function finishMutation(abortController: AbortController) {
    if (mutationAbortRef.current !== abortController) {
      return
    }

    mutationInProgressRef.current = false
    mutationAbortRef.current = null
    setIsMutating(false)
  }

  async function handleSaveBlockedDate(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()

    if (
      !dialogState ||
      dialogState.mode === 'view' ||
      dialogState.mode === 'delete'
    ) {
      return
    }

    const normalizedReason = reason.trim()

    if (
      normalizedReason.length > MAXIMUM_REASON_LENGTH ||
      containsControlCharacter(normalizedReason)
    ) {
      // 500 is a round hundred, so the counted noun is genitive singular
      // («حرف»). Revisit the noun form if MAXIMUM_REASON_LENGTH changes.
      setDialogError(
        `يجب ألا يتجاوز السبب ${MAXIMUM_REASON_LENGTH} حرف، وألا يحتوي على رموز غير صالحة.`,
      )
      return
    }

    const selectedDate = getDialogDate(dialogState)

    // Checked against a freshly read Riyadh date, the same rule the server
    // applies (PAST_DATE), not a value captured when the page was opened.
    if (selectedDate < refreshToday().key) {
      setDialogError('لا يمكن حجب تاريخ سابق لليوم.')
      return
    }

    const abortController = beginMutation()

    if (!abortController) {
      return
    }

    const token = await getIdToken()

    if (abortController.signal.aborted) {
      return
    }

    const result = token
      ? await saveAdminBlockedDate(
          token,
          {
            date: selectedDate,
            reason: normalizedReason,
          },
          abortController.signal,
          adminSession,
        )
      : createUnauthenticatedResult<AdminBlockedDateResponse>()

    if (abortController.signal.aborted) {
      return
    }

    finishMutation(abortController)

    if (!result.ok) {
      if (result.error.kind !== 'aborted') {
        setDialogError(getApiErrorMessage(result.error))
      }
      return
    }

    updateBlockedDateInActiveMonth(result.data.blockedDate)
    setMutationFeedback(
      dialogState.mode === 'create'
        ? 'تم حجب التاريخ يدويًا بنجاح.'
        : 'تم تحديث سبب الحجب بنجاح.',
    )
    closeDialog(true)
  }

  async function handleDeleteBlockedDate() {
    if (!dialogState || dialogState.mode !== 'delete') {
      return
    }

    const blockedDate = dialogState.blockedDate
    const abortController = beginMutation()

    if (!abortController) {
      return
    }

    const token = await getIdToken()

    if (abortController.signal.aborted) {
      return
    }

    const result = token
      ? await deleteAdminBlockedDate(
          token,
          blockedDate.date,
          abortController.signal,
          adminSession,
        )
      : createUnauthenticatedResult<AdminDeleteBlockedDateResponse>()

    if (abortController.signal.aborted) {
      return
    }

    finishMutation(abortController)

    if (!result.ok) {
      if (result.error.kind !== 'aborted') {
        setDialogError(getApiErrorMessage(result.error))
      }
      return
    }

    removeBlockedDateFromActiveMonth(blockedDate.date)
    setMutationFeedback(
      result.data.deleted
        ? 'تمت إزالة الحجب اليدوي عن التاريخ.'
        : 'لم يكن التاريخ محجوبًا يدويًا عند تنفيذ العملية.',
    )
    closeDialog(true)
  }

  function handleBackdropMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (
      event.target === event.currentTarget &&
      !mutationInProgressRef.current
    ) {
      closeDialog()
    }
  }

  function renderDialogError() {
    if (!dialogError) {
      return null
    }

    return (
      <div
        className="notice notice--danger blocked-dates-manager__notice"
        id={dialogErrorId}
        role="alert"
      >
        <AlertTriangleIcon className="notice__icon blocked-dates-manager__icon--danger" />
        <p>{dialogError}</p>
      </div>
    )
  }

  function renderDayCell(cell: CalendarDay) {
    const calendarDate = cell.key
    const blockedDate = blockedDatesByDate.get(calendarDate)
    const isPast = calendarDate < today.key
    const isToday = calendarDate === today.key
    const isSelected = selectedDialogDate === calendarDate
    const isUnavailable = isPast || !availabilityKnown
    const stateLabel = getDayStateLabel(
      isPast,
      blockedDate,
      availabilityKnown,
    )
    const accessibleText = [
      formatFullDate(calendarDate),
      isToday ? 'اليوم' : null,
      stateLabel,
    ]
      .filter((part): part is string => part !== null)
      .join('، ')

    return (
      <span
        className="blocked-dates-manager__cell"
        role="gridcell"
        key={calendarDate}
      >
        <button
          className={[
            'blocked-dates-manager__day',
            blockedDate ? 'blocked-dates-manager__day--blocked' : '',
            isToday ? 'blocked-dates-manager__day--today' : '',
            isPast ? 'blocked-dates-manager__day--past' : '',
            !isPast && !availabilityKnown
              ? 'blocked-dates-manager__day--waiting'
              : '',
            isSelected ? 'blocked-dates-manager__day--selected' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          ref={(element) => {
            if (element) {
              dayButtonRefs.current.set(calendarDate, element)
            } else {
              dayButtonRefs.current.delete(calendarDate)
            }
          }}
          type="button"
          tabIndex={calendarDate === rovingDate ? 0 : -1}
          aria-disabled={isUnavailable || undefined}
          aria-current={isToday ? 'date' : undefined}
          onFocus={() => setFocusedDate(calendarDate)}
          onKeyDown={(event) => handleDayKeyDown(event, cell)}
          onClick={(event) => {
            if (!isUnavailable) {
              openDateDialog(event, calendarDate, blockedDate)
            }
          }}
        >
          <span
            className="blocked-dates-manager__day-number"
            aria-hidden="true"
          >
            {cell.day}
          </span>

          {(blockedDate || isToday) && (
            <span
              className="blocked-dates-manager__day-marks"
              aria-hidden="true"
            >
              {blockedDate && (
                <span className="blocked-dates-manager__day-state">
                  <LockIcon className="blocked-dates-manager__day-state-icon" />
                  محجوب
                </span>
              )}
              {isToday && (
                <span className="blocked-dates-manager__today-label">
                  اليوم
                </span>
              )}
            </span>
          )}

          <span className="blocked-dates-manager__visually-hidden">
            {accessibleText}
          </span>
        </button>
      </span>
    )
  }

  return (
    <section
      className="blocked-dates-manager"
      aria-labelledby={sectionTitleId}
    >
      <header className="blocked-dates-manager__header">
        <div className="blocked-dates-manager__heading">
          <p className="eyebrow">التحكم في التوفر</p>
          <h2 className="blocked-dates-manager__title" id={sectionTitleId}>
            الأيام المحجوبة يدويًا
          </h2>
          <p className="blocked-dates-manager__intro">
            احجبي الأيام غير المتاحة أو عدّلي أسباب الحجب، دون تغيير أي طلب
            حجز قائم.
          </p>
        </div>

        <a
          className="btn btn--secondary blocked-dates-manager__preview-link"
          href="/packages#packages"
          target="_blank"
          rel="noopener noreferrer"
        >
          معاينة تقويم الحجز
          <span className="blocked-dates-manager__visually-hidden">
            {' '}
            {NEW_TAB_HINT}
          </span>
        </a>
      </header>

      <div className="blocked-dates-manager__toolbar">
        <button
          className="btn btn--secondary blocked-dates-manager__nav-button"
          type="button"
          onClick={() => changeMonth(-1)}
          aria-disabled={isAtEarliestMonth || undefined}
          aria-label="عرض الشهر السابق"
        >
          الشهر السابق
        </button>

        <h3 className="blocked-dates-manager__month" aria-live="polite">
          {monthHeading}
        </h3>

        <button
          className="btn btn--secondary blocked-dates-manager__nav-button"
          type="button"
          onClick={() => changeMonth(1)}
          aria-label="عرض الشهر التالي"
        >
          الشهر التالي
        </button>

        <button
          className="btn btn--secondary blocked-dates-manager__today-button"
          type="button"
          onClick={goToToday}
          aria-disabled={isShowingTodayMonth || undefined}
        >
          اليوم
        </button>
      </div>

      {mutationFeedback && (
        <div
          className="notice notice--success blocked-dates-manager__notice"
          role="status"
          aria-live="polite"
        >
          <CheckCircleIcon className="notice__icon blocked-dates-manager__icon--success" />
          <p>{mutationFeedback}</p>
        </div>
      )}

      {isLoading && (
        <div
          className="notice notice--info blocked-dates-manager__notice"
          role="status"
        >
          <InfoIcon className="notice__icon blocked-dates-manager__icon--info" />
          <p>جارٍ تحميل الأيام المحجوبة…</p>
        </div>
      )}

      {activeResult?.ok === false && (
        <div
          className="notice notice--danger blocked-dates-manager__notice"
          role="alert"
        >
          <AlertTriangleIcon className="notice__icon blocked-dates-manager__icon--danger" />
          <div className="blocked-dates-manager__notice-body">
            <p>{getApiErrorMessage(activeResult.error)}</p>
            <button
              className="btn btn--primary"
              type="button"
              onClick={retryLoading}
            >
              إعادة المحاولة
            </button>
          </div>
        </div>
      )}

      {activeResult?.ok && activeResult.data.blockedDates.length === 0 && (
        <div
          className="notice blocked-dates-manager__notice"
          role="status"
        >
          <InfoIcon className="notice__icon blocked-dates-manager__icon--neutral" />
          <p>لا توجد أيام محجوبة يدويًا في هذا الشهر.</p>
        </div>
      )}

      <div
        className="blocked-dates-manager__calendar"
        role="grid"
        aria-label={`تقويم ${monthHeading}`}
        aria-busy={isLoading}
      >
        <div
          className="blocked-dates-manager__row blocked-dates-manager__row--head"
          role="row"
        >
          {WEEKDAY_LABELS.map((weekday) => (
            <span
              className="blocked-dates-manager__weekday"
              role="columnheader"
              key={weekday}
            >
              {weekday}
            </span>
          ))}
        </div>

        {calendarWeeks.map((week, weekIndex) => (
          <div
            className="blocked-dates-manager__row blocked-dates-manager__row--week"
            role="row"
            key={`week-${weekIndex}`}
          >
            {week.map((cell, weekdayIndex) =>
              cell ? (
                renderDayCell(cell)
              ) : (
                <span
                  className="blocked-dates-manager__cell blocked-dates-manager__cell--empty"
                  role="gridcell"
                  key={`empty-${weekIndex}-${weekdayIndex}`}
                />
              ),
            )}
          </div>
        ))}
      </div>

      <ul className="blocked-dates-manager__legend" aria-label="دليل التقويم">
        <li>
          <span
            className="blocked-dates-manager__legend-sample"
            aria-hidden="true"
          >
            12
          </span>
          متاح للحجب
        </li>
        <li>
          <span
            className="blocked-dates-manager__legend-sample blocked-dates-manager__legend-sample--blocked"
            aria-hidden="true"
          >
            <LockIcon className="blocked-dates-manager__legend-icon" />
            <s>12</s>
          </span>
          محجوب يدويًا
        </li>
        <li>
          <span
            className="blocked-dates-manager__legend-sample blocked-dates-manager__legend-sample--past"
            aria-hidden="true"
          >
            12
          </span>
          تاريخ سابق
        </li>
        <li>
          <span
            className="blocked-dates-manager__legend-sample blocked-dates-manager__legend-sample--today"
            aria-hidden="true"
          >
            12
          </span>
          اليوم
        </li>
      </ul>

      {dialogState &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="dialog__backdrop blocked-dates-manager__backdrop"
            onMouseDown={handleBackdropMouseDown}
          >
            <div
              className="dialog blocked-dates-manager__dialog"
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={dialogTitleId}
              aria-describedby={dialogDescriptionId}
              tabIndex={-1}
            >
              <div
                className="blocked-dates-manager__dialog-handle"
                aria-hidden="true"
              />

              <header className="blocked-dates-manager__dialog-header">
                <div>
                  <p className="eyebrow">إدارة التوفر</p>
                  <h2
                    className="blocked-dates-manager__dialog-title"
                    id={dialogTitleId}
                  >
                    {getDialogTitle(dialogState)}
                  </h2>
                </div>
                {dialogState.mode !== 'delete' && (
                  <button
                    className="btn btn--ghost blocked-dates-manager__dialog-close"
                    ref={
                      dialogState.mode === 'view'
                        ? setDialogInitialFocus
                        : undefined
                    }
                    type="button"
                    onClick={() => closeDialog()}
                    disabled={isMutating}
                    aria-label="إغلاق نافذة إدارة التاريخ"
                  >
                    إغلاق
                  </button>
                )}
              </header>

              <p
                className="blocked-dates-manager__dialog-description"
                id={dialogDescriptionId}
              >
                {dialogState.mode === 'delete'
                  ? `سيُرفع الحجب اليدوي عن ${formatFullDate(
                      dialogState.blockedDate.date,
                    )}.`
                  : formatFullDate(getDialogDate(dialogState))}
              </p>

              {(dialogState.mode === 'create' ||
                dialogState.mode === 'edit') && (
                <form
                  className="blocked-dates-manager__form"
                  onSubmit={(event) => {
                    void handleSaveBlockedDate(event)
                  }}
                  noValidate
                >
                  <div className="field">
                    <label className="field__label" htmlFor={reasonFieldId}>
                      سبب الحجب{' '}
                      <span className="blocked-dates-manager__optional">
                        اختياري
                      </span>
                    </label>
                    <textarea
                      id={reasonFieldId}
                      ref={setDialogInitialFocus}
                      value={reason}
                      onChange={(event) =>
                        setReason(event.currentTarget.value)
                      }
                      maxLength={MAXIMUM_REASON_LENGTH}
                      rows={4}
                      placeholder="مثال: حجز خارجي، إجازة، غير متاحة، ارتباط شخصي"
                      disabled={isMutating}
                      aria-describedby={
                        dialogError
                          ? `${reasonCounterId} ${dialogErrorId}`
                          : reasonCounterId
                      }
                    />
                    <p
                      className="field__hint blocked-dates-manager__counter"
                      id={reasonCounterId}
                    >
                      {reason.length} / {MAXIMUM_REASON_LENGTH}
                    </p>
                  </div>

                  {renderDialogError()}

                  <div className="blocked-dates-manager__dialog-actions">
                    <button
                      className="btn btn--primary"
                      type="submit"
                      disabled={isMutating}
                    >
                      {isMutating && (
                        <span
                          className="blocked-dates-manager__spinner"
                          aria-hidden="true"
                        />
                      )}
                      {isMutating
                        ? 'جارٍ حفظ التاريخ…'
                        : dialogState.mode === 'create'
                          ? 'حفظ اليوم المحجوب'
                          : 'حفظ السبب الجديد'}
                    </button>
                    <button
                      className="btn btn--secondary"
                      type="button"
                      onClick={() => {
                        if (dialogState.mode === 'edit') {
                          returnToBlockedDateDetails(
                            dialogState.blockedDate,
                          )
                        } else {
                          closeDialog()
                        }
                      }}
                      disabled={isMutating}
                    >
                      إلغاء
                    </button>
                  </div>
                </form>
              )}

              {dialogState.mode === 'view' && (
                <div className="blocked-dates-manager__details">
                  <dl>
                    <div>
                      <dt>التاريخ</dt>
                      <dd>{formatFullDate(dialogState.blockedDate.date)}</dd>
                    </div>
                    <div>
                      <dt>السبب</dt>
                      <dd>
                        {dialogState.blockedDate.reason ??
                          'لا يوجد سبب مسجل.'}
                      </dd>
                    </div>
                    <div>
                      <dt>وقت الإنشاء</dt>
                      <dd>
                        {formatTimestamp(
                          dialogState.blockedDate.createdAt,
                        )}
                      </dd>
                    </div>
                  </dl>

                  {renderDialogError()}

                  <div className="blocked-dates-manager__dialog-actions">
                    <button
                      className="btn btn--primary"
                      type="button"
                      onClick={() =>
                        startEditing(dialogState.blockedDate)
                      }
                    >
                      تعديل السبب
                    </button>
                    <button
                      className="btn blocked-dates-manager__destructive-button blocked-dates-manager__destructive-button--outline"
                      type="button"
                      onClick={() =>
                        startDeleting(dialogState.blockedDate)
                      }
                    >
                      إزالة الحجب
                    </button>
                  </div>
                </div>
              )}

              {dialogState.mode === 'delete' && (
                <div className="blocked-dates-manager__delete-confirmation">
                  <div className="notice notice--warning blocked-dates-manager__notice">
                    <AlertTriangleIcon className="notice__icon blocked-dates-manager__icon--warning" />
                    <p>
                      إزالة الحجب اليدوي لا تلغي أي حجز ولا تعدّل طلبات
                      الحجز. وقد يبقى التاريخ غير متاح إذا كان يحتوي على حجز
                      نشط.
                    </p>
                  </div>

                  {renderDialogError()}

                  <div className="blocked-dates-manager__dialog-actions">
                    <button
                      className="btn blocked-dates-manager__destructive-button"
                      type="button"
                      onClick={() => {
                        void handleDeleteBlockedDate()
                      }}
                      disabled={isMutating}
                    >
                      {isMutating && (
                        <span
                          className="blocked-dates-manager__spinner"
                          aria-hidden="true"
                        />
                      )}
                      {isMutating
                        ? 'جارٍ إزالة الحجب…'
                        : 'تأكيد إزالة الحجب'}
                    </button>
                    <button
                      className="btn btn--secondary"
                      ref={setDialogInitialFocus}
                      type="button"
                      onClick={() =>
                        returnToBlockedDateDetails(
                          dialogState.blockedDate,
                        )
                      }
                      disabled={isMutating}
                    >
                      العودة
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </section>
  )
}
