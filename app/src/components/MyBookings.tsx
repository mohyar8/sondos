import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import type {
  BookingCalculationBreakdown,
  BookingPackageSnapshot,
} from '../../shared/booking'
import {
  parseMyBookingsBody,
  type CustomerBooking,
  type MyBookingsData,
  type MyBookingsPartialError,
} from '../api/bookings'
import { useAuth } from '../auth/auth-context'
import Countdown from '../features/journey/Countdown'
import JourneyIcon, {
  type JourneyIconName,
} from '../features/journey/JourneyIcon'
import JourneyTracker from '../features/journey/JourneyTracker'
import StageViewHost from '../features/journey/StageViewHost'
import { formatArabicCount } from '../features/journey/arabic-count'
import {
  describeExtra,
  describePackage,
  formatBookingTimestamp,
  formatEventDate,
  formatSar,
  formatShownRequestCount,
  getBookingNextStep,
  getBookingPresentation,
  getBookingWhatsAppUrl,
  moveBookingToFront,
  sortBookingsByUrgency,
  type BookingNextStep,
  type BookingPresentation,
  type BookingTone,
} from '../features/journey/hub-model'
import { resolveStageView } from '../features/journey/stage-views'
import { useApiClient, type ApiError } from '../lib/api-client'
import { buildSearchHref, readSearchParam } from '../lib/route-search'
import { ACCOUNT_SUPPORT_URL } from '../lib/server-error-messages'
import AuthDialog from './AuthDialog'
import './MyBookings.css'

type NavigateHandler = (
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
) => void

interface MyBookingsProps {
  embedded?: boolean
  onNavigate?: NavigateHandler
}

/**
 * What the hub knows about her bookings. `data` is the latest successful
 * load for this account; it stays on screen while a refresh runs or after a
 * refresh fails, so the list (and the focus inside it) never disappears.
 */
interface BookingsState {
  uid: string
  /** The request (`uid|reloadVersion`) this state answers. */
  key: string
  data: MyBookingsData | null
  /** The failure of request `key`, if it failed. */
  error: ApiError | null
}

type PageAction = 'sign-out' | 'verify'

interface LoadErrorContent {
  title: string
  message: string
  /** `contact`: a final answer (erased account), so WhatsApp, not a retry. */
  action: 'retry' | 'sign-in' | 'verify' | 'contact'
}

const BOOKING_PARAM = 'booking'
const VIEW_PARAM = 'view'
const PACKAGES_HREF = '/packages#packages'
const ACCOUNT_ERASED_TITLE = 'حُذفت بيانات هذا الحساب'

const PROFILE_ERROR_FALLBACK =
  'تعذر الاتصال بالخدمة حاليًا. تحققي من الاتصال ثم أعيدي المحاولة.'

const toneIcons: Readonly<Record<BookingTone, JourneyIconName>> = {
  info: 'info',
  warning: 'hourglass',
  success: 'check',
  danger: 'alert',
  neutral: 'close',
}

/**
 * Only a server 401 means the session itself is gone. A missing token, a
 * network failure or a server error is retryable and never signs her out
 * (inspection defect #7).
 */
function describeLoadError(error: ApiError): LoadErrorContent {
  if (error.source === 'server' && error.code === 'UNAUTHORIZED') {
    return {
      title: 'انتهت جلسة تسجيل الدخول',
      message: 'يرجى تسجيل الدخول مرة أخرى لمتابعة حجوزاتكِ.',
      action: 'sign-in',
    }
  }

  if (error.source === 'server' && error.code === 'EMAIL_NOT_VERIFIED') {
    return {
      title: 'يلزم تأكيد بريدكِ الإلكتروني',
      message: error.message,
      action: 'verify',
    }
  }

  if (error.source === 'server' && error.code === 'ACCOUNT_ERASED') {
    return {
      title: ACCOUNT_ERASED_TITLE,
      message: error.message,
      action: 'contact',
    }
  }

  return {
    title: 'تعذر تحميل حجوزاتكِ',
    message: error.message,
    action: 'retry',
  }
}

function getPartialErrorMessage(partialError: MyBookingsPartialError): string {
  return partialError.skippedCount === 1
    ? 'تعذر عرض أحد طلباتكِ لأن بياناته وصلت غير مكتملة. أعيدي تحميل الحجوزات، وإن تكرر ذلك تواصلي معنا عبر واتساب.'
    : 'تعذر عرض بعض طلباتكِ لأن بياناتها وصلت غير مكتملة. أعيدي تحميل الحجوزات، وإن تكرر ذلك تواصلي معنا عبر واتساب.'
}

/** Text for assistive technology only (e.g. which card a button belongs to). */
function VisuallyHidden({ children }: { children: string }) {
  return <span className="my-bookings__visually-hidden">{children}</span>
}

function StatusBadges({ presentation }: { presentation: BookingPresentation }) {
  return (
    <div className="my-bookings__badges">
      <span className={`badge badge--${presentation.tone}`}>
        <JourneyIcon className="badge__icon" name={toneIcons[presentation.tone]} />
        {presentation.label}
      </span>
      {presentation.isLegacyFlow && (
        <span className="my-bookings__legacy-tag">مسار سابق</span>
      )}
    </div>
  )
}

function BreakdownRow({ label, value }: { label: string; value: number }) {
  if (value <= 0) {
    return null
  }

  return (
    <div className="my-bookings__row">
      <dt>{label}</dt>
      <dd>{formatSar(value)}</dd>
    </div>
  )
}

function PriceBreakdown({
  calculation,
  total,
}: {
  calculation: BookingCalculationBreakdown
  total: number
}) {
  return (
    <div className="my-bookings__detail-group">
      <h4>تفاصيل السعر</h4>
      <dl className="my-bookings__rows">
        <BreakdownRow label="تغطية التصوير" value={calculation.coverage} />
        <BreakdownRow label="الألبوم" value={calculation.album} />
        <BreakdownRow
          label="ترقية صندوق الألبوم"
          value={calculation.albumBoxUpgrade}
        />
        <BreakdownRow
          label="المطبوعات الفردية"
          value={calculation.individualPrints}
        />
        <BreakdownRow label="المجلات" value={calculation.magazines} />
        <BreakdownRow
          label="التكبيرات الخشبية"
          value={calculation.woodenEnlargements}
        />
        <div className="my-bookings__row my-bookings__row--total">
          <dt>الإجمالي التقديري</dt>
          <dd>{formatSar(total)}</dd>
        </div>
      </dl>
    </div>
  )
}

function SnapshotDetails({
  snapshot,
  total,
}: {
  snapshot: BookingPackageSnapshot
  total: number
}) {
  return (
    <>
      <div className="my-bookings__detail-group">
        <h4>تفاصيل التغطية</h4>
        <dl className="my-bookings__rows">
          <div className="my-bookings__row">
            <dt>مدة التصوير</dt>
            <dd>{formatArabicCount(snapshot.coverage.durationHours, 'hour')}</dd>
          </div>
          {snapshot.noCostOptions.photoCount && (
            <div className="my-bookings__row">
              <dt>عدد الصور المختارة</dt>
              <dd>{snapshot.noCostOptions.photoCount.label}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="my-bookings__detail-group">
        <h4>الألبوم</h4>
        {snapshot.album ? (
          <dl className="my-bookings__rows">
            <div className="my-bookings__row">
              <dt>الخيار</dt>
              <dd>{snapshot.album.name}</dd>
            </div>
            <div className="my-bookings__row">
              <dt>المقاس</dt>
              <dd>
                <bdi>{snapshot.album.dimensions}</bdi>
              </dd>
            </div>
            <div className="my-bookings__row">
              <dt>عدد الصفحات</dt>
              <dd>{formatArabicCount(snapshot.album.pageCount, 'page')}</dd>
            </div>
            <div className="my-bookings__row">
              <dt>عدد الصور</dt>
              <dd>{formatArabicCount(snapshot.album.photoCount, 'photo')}</dd>
            </div>
            <div className="my-bookings__row">
              <dt>الصندوق</dt>
              <dd>{snapshot.album.box.name}</dd>
            </div>
            <div className="my-bookings__row">
              <dt>الألبوم المصغر</dt>
              <dd>مشمول</dd>
            </div>
          </dl>
        ) : (
          <p className="my-bookings__muted">لم تتم إضافة ألبوم إلى الطلب.</p>
        )}
      </div>

      {snapshot.extras.length > 0 && (
        <div className="my-bookings__detail-group">
          <h4>الإضافات</h4>
          <ul className="my-bookings__extras">
            {snapshot.extras.map((extra) => (
              <li key={`${extra.kind}-${extra.id}`}>
                <span>{describeExtra(extra)}</span>
                <strong>{formatSar(extra.subtotal)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      <PriceBreakdown calculation={snapshot.calculation} total={total} />
    </>
  )
}

function BookingDetails({
  booking,
  presentation,
  id,
}: {
  booking: CustomerBooking
  presentation: BookingPresentation
  id: string
}) {
  return (
    <div className="my-bookings__details" id={id}>
      {booking.packageSnapshot ? (
        <SnapshotDetails
          snapshot={booking.packageSnapshot}
          total={booking.estimatedTotal}
        />
      ) : (
        <div className="my-bookings__detail-group">
          <h4>تفاصيل الباقة</h4>
          <p className="my-bookings__muted">
            تعذر عرض تفاصيل الباقة المحفوظة لهذا الطلب.
          </p>
        </div>
      )}

      <div className="my-bookings__detail-group">
        <h4>معلومات الطلب</h4>
        <dl className="my-bookings__rows">
          <div className="my-bookings__row">
            <dt>الحالة الحالية</dt>
            <dd>{presentation.label}</dd>
          </div>
          <div className="my-bookings__row">
            <dt>تم إنشاء الطلب</dt>
            <dd>{formatBookingTimestamp(booking.createdAt)}</dd>
          </div>
          <div className="my-bookings__row">
            <dt>آخر تحديث</dt>
            <dd>{formatBookingTimestamp(booking.updatedAt)}</dd>
          </div>
          {booking.confirmedAt && (
            <div className="my-bookings__row">
              <dt>تاريخ التأكيد</dt>
              <dd>{formatBookingTimestamp(booking.confirmedAt)}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  )
}

/** For an erased account, the only way forward: a chat with the studio. */
function AccountErasedSupportLink({ className }: { className: string }) {
  return (
    <a
      className={className}
      href={ACCOUNT_SUPPORT_URL}
      target="_blank"
      rel="noopener noreferrer"
    >
      تواصلي معنا عبر واتساب
      <VisuallyHidden> (يفتح في نافذة جديدة)</VisuallyHidden>
    </a>
  )
}

function WhatsAppLink({
  booking,
  eventDateText,
  isPrimary,
}: {
  booking: CustomerBooking
  eventDateText: string
  isPrimary: boolean
}) {
  return (
    <a
      className={`btn ${isPrimary ? 'btn--whatsapp btn--lg' : 'btn--secondary'}`}
      href={getBookingWhatsAppUrl(booking)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {isPrimary ? 'تواصلي عبر واتساب' : 'الاستفسار عبر واتساب'}
      <VisuallyHidden>
        {` بخصوص حجز ${eventDateText} (يفتح في نافذة جديدة)`}
      </VisuallyHidden>
    </a>
  )
}

function NextStep({
  booking,
  nextStep,
  eventDateText,
  onNavigate,
}: {
  booking: CustomerBooking
  nextStep: BookingNextStep
  eventDateText: string
  onNavigate: NavigateHandler
}) {
  let content: ReactNode

  switch (nextStep.kind) {
    case 'view': {
      const href = buildSearchHref({
        [BOOKING_PARAM]: booking.id,
        [VIEW_PARAM]: nextStep.view,
      })

      content = (
        <a
          className="btn btn--primary btn--lg"
          href={href}
          onClick={(event) => onNavigate(event, href)}
        >
          {nextStep.label}
          <VisuallyHidden>{` — حجز ${eventDateText}`}</VisuallyHidden>
        </a>
      )
      break
    }
    case 'whatsapp':
      content = (
        <WhatsAppLink
          booking={booking}
          eventDateText={eventDateText}
          isPrimary
        />
      )
      break
    case 'offline':
    case 'none':
      content = <p className="my-bookings__next-text">{nextStep.text}</p>
      break
  }

  return (
    <div className="my-bookings__next">
      <p className="my-bookings__next-title">الخطوة التالية</p>
      {content}
    </div>
  )
}

interface BookingCardProps {
  booking: CustomerBooking
  isExpanded: boolean
  isSelected: boolean
  headingRef: RefObject<HTMLHeadingElement | null> | undefined
  clockOffsetMs: number | null
  onToggle: () => void
  onNavigate: NavigateHandler
}

function BookingCard({
  booking,
  isExpanded,
  isSelected,
  headingRef,
  clockOffsetMs,
  onToggle,
  onNavigate,
}: BookingCardProps) {
  const headingId = useId()
  const detailsId = useId()
  const presentation = getBookingPresentation(booking)
  const nextStep = getBookingNextStep(booking)
  const eventDateText = formatEventDate(booking.eventDate)
  const journeyStage = presentation.stage

  return (
    <article
      className={`my-bookings__card my-bookings__card--${presentation.tone}${isSelected ? ' my-bookings__card--selected' : ''}`}
      aria-labelledby={headingId}
      aria-current={isSelected ? 'true' : undefined}
    >
      <header className="my-bookings__card-header">
        <div className="my-bookings__card-heading">
          <p className="my-bookings__card-eyebrow">تاريخ المناسبة</p>
          <h3
            className="my-bookings__card-title"
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
          >
            {eventDateText}
          </h3>
          <p className="my-bookings__reference">
            <span>رقم الطلب</span>{' '}
            <bdi className="my-bookings__reference-value" dir="ltr">
              {booking.id}
            </bdi>
          </p>
        </div>
        <StatusBadges presentation={presentation} />
      </header>

      <dl className="my-bookings__summary">
        <div>
          <dt>الباقة</dt>
          <dd>{describePackage(booking.packageSnapshot)}</dd>
        </div>
        <div>
          <dt>الإجمالي التقديري</dt>
          <dd>{formatSar(booking.estimatedTotal)}</dd>
        </div>
        {booking.depositAmount !== null && (
          <div>
            <dt>العربون</dt>
            <dd>{formatSar(booking.depositAmount)}</dd>
          </div>
        )}
        <div>
          <dt>تاريخ الطلب</dt>
          <dd>{formatBookingTimestamp(booking.createdAt)}</dd>
        </div>
      </dl>

      <p className="my-bookings__guidance">{presentation.guidance}</p>

      {journeyStage !== null && (
        <div className="my-bookings__journey">
          <JourneyTracker stage={journeyStage} subState={booking.stageSubState} />
          {booking.stageDeadline !== null && (
            <Countdown
              stage={journeyStage}
              deadline={booking.stageDeadline}
              clockOffsetMs={clockOffsetMs}
            />
          )}
        </div>
      )}

      {nextStep !== null && (
        <NextStep
          booking={booking}
          nextStep={nextStep}
          eventDateText={eventDateText}
          onNavigate={onNavigate}
        />
      )}

      <div className="my-bookings__card-actions">
        <button
          className="btn btn--ghost"
          type="button"
          aria-expanded={isExpanded}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          {isExpanded ? 'إخفاء التفاصيل' : 'عرض التفاصيل'}
          <VisuallyHidden>{` — حجز ${eventDateText}`}</VisuallyHidden>
        </button>
        {nextStep?.kind !== 'whatsapp' && (
          <WhatsAppLink
            booking={booking}
            eventDateText={eventDateText}
            isPrimary={false}
          />
        )}
      </div>

      {isExpanded && (
        <BookingDetails
          booking={booking}
          presentation={presentation}
          id={detailsId}
        />
      )}
    </article>
  )
}

export default function MyBookings({
  embedded = false,
  onNavigate,
}: MyBookingsProps) {
  const {
    firebaseUser,
    profile,
    isInitializing,
    isAuthenticated,
    isAuthAvailable,
    profileRequired,
    authError,
    checkEmailVerification,
    signOutUser,
    clearAuthError,
  } = useAuth()
  const apiClient = useApiClient()
  const [reloadVersion, setReloadVersion] = useState(0)
  const [bookingsState, setBookingsState] = useState<BookingsState | null>(null)
  const [expandedBookingId, setExpandedBookingId] = useState<string | null>(null)
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false)
  const [pendingAction, setPendingAction] = useState<PageAction | null>(null)
  const [pageActionError, setPageActionError] = useState<string | null>(null)
  const loginButtonRef = useRef<HTMLButtonElement | null>(null)
  const pageFocusRef = useRef<HTMLElement | null>(null)
  const selectedHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const focusedSelectionRef = useRef<string | null>(null)
  const actionInFlightRef = useRef(false)
  const isMountedRef = useRef(true)
  const listTitleId = useId()

  const accountKey = firebaseUser?.uid ?? 'signed-out'
  const requestKey = `${accountKey}|${reloadVersion}`
  // The bookings endpoint does not need the profile, so a profile that
  // failed to load does not hide her bookings; a missing profile does, and
  // so does an erased account (the bookings request would only answer 410
  // again, a second copy of the same notice).
  const isAccountErased = authError?.code === 'ACCOUNT_ERASED'
  const isSignedInWithProfileState =
    isAuthAvailable && isAuthenticated && !isInitializing && !profileRequired
  const canLoadBookings = isSignedInWithProfileState && !isAccountErased
  const hasProfileLoadError = isSignedInWithProfileState && profile === null
  const showAuthDialog =
    isAuthDialogOpen &&
    (!isAuthenticated || profileRequired || profile === null)

  const accountState =
    canLoadBookings && bookingsState?.uid === accountKey ? bookingsState : null
  const isCurrentRequest = accountState?.key === requestKey
  const bookingsData = accountState?.data ?? null
  const loadError = isCurrentRequest ? (accountState?.error ?? null) : null
  const isRefreshing = canLoadBookings && !isCurrentRequest && bookingsData !== null
  const isFirstLoad = canLoadBookings && !isCurrentRequest && bookingsData === null
  const bookings = bookingsData?.response.bookings ?? null
  const partialError = bookingsData?.partialError ?? null
  const clockOffsetMs = bookingsData?.response.serverClockOffsetMs ?? null

  // Views inside the hub: /my-bookings?booking=<id>&view=<id> (ADR-001 §2.6).
  // App re-renders this page on every navigation, so reading the address
  // during render is always current.
  const requestedBookingId = readSearchParam(BOOKING_PARAM)
  const requestedView = readSearchParam(VIEW_PARAM)
  const selectedBooking =
    bookings === null || requestedBookingId === null
      ? null
      : (bookings.find((booking) => booking.id === requestedBookingId) ?? null)
  const isUnknownBookingRequested =
    bookings !== null && requestedBookingId !== null && selectedBooking === null
  const isStageViewOpen =
    selectedBooking !== null &&
    resolveStageView(requestedView, selectedBooking) !== null
  const orderedBookings =
    bookings === null
      ? []
      : moveBookingToFront(
          sortBookingsByUrgency(bookings),
          selectedBooking?.id ?? null,
        )
  // Focus lands on the card a link named, once per link (not on refreshes).
  const selectionFocusKey =
    selectedBooking === null || isStageViewOpen
      ? null
      : `${selectedBooking.id}|${requestedView ?? ''}`

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!canLoadBookings) {
      return undefined
    }

    const abortController = new AbortController()
    const uid = accountKey
    const key = requestKey

    // apiClient.request always resolves (never rejects).
    void apiClient
      .request({
        path: '/api/bookings/me',
        signal: abortController.signal,
        parse: (body, meta) => parseMyBookingsBody(body, meta.receivedAtMs),
      })
      .then((result) => {
        if (
          abortController.signal.aborted ||
          (!result.ok && result.error.code === 'ABORTED')
        ) {
          return
        }

        setBookingsState((previous) => {
          if (result.ok) {
            return { uid, key, data: result.data, error: null }
          }

          return {
            uid,
            key,
            data: previous?.uid === uid ? previous.data : null,
            error: result.error,
          }
        })
      })

    return () => abortController.abort()
  }, [accountKey, apiClient, canLoadBookings, requestKey])

  useEffect(() => {
    if (selectionFocusKey === null) {
      // Following the same link again later focuses its card again.
      focusedSelectionRef.current = null
      return
    }

    if (focusedSelectionRef.current === selectionFocusKey) {
      return
    }

    focusedSelectionRef.current = selectionFocusKey
    selectedHeadingRef.current?.focus()
  }, [selectionFocusKey])

  function handleNavigation(event: MouseEvent<HTMLAnchorElement>, href: string) {
    // Without a router handler the link simply loads the page.
    onNavigate?.(event, href)
  }

  /**
   * For a stage view that closes itself (e.g. after saving): the same
   * programmatic navigation SiteHeader uses — one history entry, then the
   * router's own popstate listener re-renders. No listener is added here.
   */
  function closeStageView() {
    const href = buildSearchHref({ [BOOKING_PARAM]: requestedBookingId })

    window.history.pushState(null, '', href)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  function openAuthenticationDialog() {
    setPageActionError(null)
    clearAuthError()
    setIsAuthDialogOpen(true)
  }

  function closeAuthenticationDialog() {
    if (!profileRequired) {
      setIsAuthDialogOpen(false)
    }
  }

  function refreshBookings() {
    if (isRefreshing) {
      return
    }

    setPageActionError(null)
    setReloadVersion((currentVersion) => currentVersion + 1)
  }

  function reloadPage() {
    window.location.reload()
  }

  async function runPageAction(
    action: PageAction,
    task: () => Promise<string | null>,
  ) {
    if (actionInFlightRef.current) {
      return
    }

    actionInFlightRef.current = true
    setPendingAction(action)
    setPageActionError(null)

    const errorMessage = await task()

    actionInFlightRef.current = false

    if (!isMountedRef.current) {
      return
    }

    setPendingAction(null)

    if (errorMessage !== null) {
      setPageActionError(errorMessage)
    }
  }

  function handleSignOut(openLoginAfterwards: boolean) {
    void runPageAction('sign-out', async () => {
      const result = await signOutUser()

      if (!result.ok) {
        return result.error.message
      }

      if (isMountedRef.current) {
        setExpandedBookingId(null)
        setIsAuthDialogOpen(openLoginAfterwards)
      }

      return null
    })
  }

  /**
   * Re-reads her verification state (and refreshes a stale token). If the
   * address is still unverified, App shows the verification gate instead.
   */
  function handleVerificationRetry() {
    void runPageAction('verify', async () => {
      const result = await checkEmailVerification()

      if (!result.ok) {
        return result.error.message
      }

      if (isMountedRef.current) {
        setReloadVersion((currentVersion) => currentVersion + 1)
      }

      return null
    })
  }

  const profileFullName = profile
    ? `${profile.firstName} ${profile.lastName}`.trim()
    : ''
  const customerDisplayName = profile
    ? profileFullName || profile.email
    : (firebaseUser?.email ?? '')
  const loadErrorContent = loadError === null ? null : describeLoadError(loadError)
  const isSigningOut = pendingAction === 'sign-out'

  const bookingList = (
    <div className="my-bookings__list">
      {orderedBookings.map((booking) => {
        const isSelected = booking.id === selectedBooking?.id

        return (
          <BookingCard
            booking={booking}
            clockOffsetMs={clockOffsetMs}
            headingRef={isSelected ? selectedHeadingRef : undefined}
            isExpanded={expandedBookingId === booking.id}
            isSelected={isSelected}
            key={booking.id}
            onNavigate={handleNavigation}
            onToggle={() =>
              setExpandedBookingId((currentId) =>
                currentId === booking.id ? null : booking.id,
              )
            }
          />
        )
      })}
    </div>
  )

  return (
    <div className={`my-bookings${embedded ? ' my-bookings--embedded' : ''}`} dir="rtl">
      {!embedded && (
        <a className="skip-link" href="#my-bookings-main">
          تخطي إلى المحتوى
        </a>
      )}

      {!embedded && (
        <header className="my-bookings__header">
          <div className="my-bookings__header-inner">
            <div>
              <a
                className="my-bookings__brand"
                href="/"
                onClick={(event) => handleNavigation(event, '/')}
              >
                المصورة سندس يار
              </a>
              <p className="my-bookings__brand-note">حساب العميلة</p>
            </div>

            <nav className="my-bookings__header-actions" aria-label="روابط الحساب">
              <a
                className="btn btn--ghost"
                href="/"
                onClick={(event) => handleNavigation(event, '/')}
              >
                العودة للموقع
              </a>
              {isAuthenticated && (
                <button
                  className="btn btn--secondary"
                  type="button"
                  onClick={() => handleSignOut(false)}
                  aria-disabled={pendingAction !== null || undefined}
                >
                  {isSigningOut ? 'جارٍ تسجيل الخروج…' : 'تسجيل الخروج'}
                </button>
              )}
            </nav>
          </div>
        </header>
      )}

      <main
        className="my-bookings__main"
        id={embedded ? 'main-content' : 'my-bookings-main'}
        ref={pageFocusRef}
        tabIndex={-1}
      >
        <header className="my-bookings__intro">
          <div>
            <p className="eyebrow">متابعة طلباتكِ</p>
            <h1 className="my-bookings__title">حجوزاتي</h1>
            <p className="my-bookings__lead">
              راجعي حالة طلبات التصوير وتفاصيل كل طلب في مكان واحد.
            </p>
          </div>

          {isAuthenticated && customerDisplayName && (
            <div className="my-bookings__identity">
              <span>مسجلة باسم</span>
              <strong>{customerDisplayName}</strong>
              {profile?.email && <bdi>{profile.email}</bdi>}
            </div>
          )}
        </header>

        <div className="my-bookings__live" aria-live="polite">
          {pageActionError && (
            <p className="notice notice--danger" role="alert">
              <JourneyIcon className="notice__icon" name="alert" />
              <span>{pageActionError}</span>
            </p>
          )}
        </div>

        {isInitializing && (
          <section className="my-bookings__state" role="status">
            <span className="my-bookings__spinner" aria-hidden="true" />
            <h2>جارٍ استعادة جلسة الدخول</h2>
            <p>لحظات قليلة ونجهّز حجوزاتكِ.</p>
          </section>
        )}

        {!isInitializing && !isAuthAvailable && (
          <section className="my-bookings__state" role="alert">
            <h2>خدمة تسجيل الدخول غير متاحة</h2>
            <p>
              {authError?.message ??
                'تعذر تهيئة خدمة تسجيل الدخول حاليًا. أعيدي المحاولة لاحقًا.'}
            </p>
            <div className="my-bookings__state-actions">
              <a
                className="btn btn--primary"
                href="/"
                onClick={(event) => handleNavigation(event, '/')}
              >
                العودة للموقع
              </a>
            </div>
          </section>
        )}

        {!isInitializing && isAuthAvailable && !isAuthenticated && (
          <section className="my-bookings__state">
            <h2>سجّلي الدخول لعرض حجوزاتكِ</h2>
            <p>
              تحتاجين إلى تسجيل الدخول بالحساب المستخدم عند إرسال طلب الحجز.
            </p>
            <div className="my-bookings__state-actions">
              <button
                className="btn btn--primary"
                ref={loginButtonRef}
                type="button"
                onClick={openAuthenticationDialog}
              >
                تسجيل الدخول
              </button>
              <a
                className="btn btn--secondary"
                href="/"
                onClick={(event) => handleNavigation(event, '/')}
              >
                العودة للموقع
              </a>
            </div>
          </section>
        )}

        {!isInitializing && isAuthAvailable && isAuthenticated && profileRequired && (
          <section className="my-bookings__state">
            <h2>أكملي بيانات حسابكِ</h2>
            <p>يلزم استكمال بيانات التواصل قبل عرض طلبات الحجز.</p>
            <div className="my-bookings__state-actions">
              <button
                className="btn btn--primary"
                ref={loginButtonRef}
                type="button"
                onClick={openAuthenticationDialog}
              >
                استكمال البيانات
              </button>
            </div>
          </section>
        )}

        {hasProfileLoadError && (
          <div className="notice notice--warning my-bookings__notice" role="status">
            <JourneyIcon className="notice__icon" name="alert" />
            <div className="my-bookings__notice-body">
              <p className="my-bookings__notice-title">
                {isAccountErased ? ACCOUNT_ERASED_TITLE : 'تعذر تحميل بيانات حسابكِ'}
              </p>
              <p>{authError?.message ?? PROFILE_ERROR_FALLBACK}</p>
              {isAccountErased ? (
                <AccountErasedSupportLink className="btn btn--secondary" />
              ) : (
                <button className="btn btn--secondary" type="button" onClick={reloadPage}>
                  إعادة تحميل الصفحة
                </button>
              )}
            </div>
          </div>
        )}

        {isFirstLoad && (
          <section className="my-bookings__state" role="status">
            <span className="my-bookings__spinner" aria-hidden="true" />
            <h2>جارٍ تحميل حجوزاتكِ</h2>
            <p>نسترجع أحدث حالة لكل طلب.</p>
          </section>
        )}

        {loadErrorContent !== null && bookings === null && (
          <section className="my-bookings__state" role="alert">
            <h2>{loadErrorContent.title}</h2>
            <p>{loadErrorContent.message}</p>
            <div className="my-bookings__state-actions">
              {loadErrorContent.action === 'sign-in' && (
                <button
                  className="btn btn--primary"
                  ref={loginButtonRef}
                  type="button"
                  onClick={() => handleSignOut(true)}
                  aria-disabled={pendingAction !== null || undefined}
                >
                  {isSigningOut
                    ? 'جارٍ تجهيز تسجيل الدخول…'
                    : 'تسجيل الدخول مرة أخرى'}
                </button>
              )}
              {loadErrorContent.action === 'verify' ? (
                <button
                  className="btn btn--primary"
                  type="button"
                  onClick={handleVerificationRetry}
                  aria-disabled={pendingAction !== null || undefined}
                >
                  {pendingAction === 'verify' ? 'جارٍ التحقق…' : 'إعادة المحاولة'}
                </button>
              ) : loadErrorContent.action === 'contact' ? (
                <AccountErasedSupportLink className="btn btn--primary" />
              ) : (
                <button
                  className={`btn ${loadErrorContent.action === 'sign-in' ? 'btn--secondary' : 'btn--primary'}`}
                  type="button"
                  onClick={refreshBookings}
                >
                  إعادة المحاولة
                </button>
              )}
              <a
                className="btn btn--ghost"
                href="/"
                onClick={(event) => handleNavigation(event, '/')}
              >
                العودة للموقع
              </a>
            </div>
          </section>
        )}

        {bookings !== null && bookings.length === 0 && partialError !== null && (
          <section className="my-bookings__state" role="alert">
            <h2>تعذر عرض حجوزاتكِ</h2>
            <p>{getPartialErrorMessage(partialError)}</p>
            <div className="my-bookings__state-actions">
              <button
                className="btn btn--primary"
                type="button"
                onClick={refreshBookings}
                aria-disabled={isRefreshing || undefined}
              >
                {isRefreshing ? 'جارٍ التحديث…' : 'إعادة المحاولة'}
              </button>
            </div>
          </section>
        )}

        {bookings !== null && bookings.length === 0 && partialError === null && (
          <section className="my-bookings__state">
            <h2>لا توجد لديكِ طلبات حجز حتى الآن</h2>
            <p>يمكنكِ اختيار التغطية المناسبة والتاريخ من صفحة الباقات.</p>
            <div className="my-bookings__state-actions">
              <a
                className="btn btn--primary"
                href={PACKAGES_HREF}
                onClick={(event) => handleNavigation(event, PACKAGES_HREF)}
              >
                ابدئي طلب حجز
              </a>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={refreshBookings}
                aria-disabled={isRefreshing || undefined}
              >
                {isRefreshing ? 'جارٍ التحديث…' : 'تحديث الحجوزات'}
              </button>
            </div>
          </section>
        )}

        {bookings !== null && bookings.length > 0 && (
          <section
            className="my-bookings__content"
            aria-labelledby={listTitleId}
            aria-busy={isRefreshing || undefined}
          >
            <div className="my-bookings__section-heading">
              <div>
                <h2 id={listTitleId}>طلبات الحجز</h2>
                <p>
                  {formatShownRequestCount(bookings.length)}. يظهر أولًا ما يحتاج
                  متابعتكِ.
                </p>
              </div>
              <button
                className="btn btn--secondary"
                type="button"
                onClick={refreshBookings}
                aria-disabled={isRefreshing || undefined}
              >
                {isRefreshing ? 'جارٍ التحديث…' : 'تحديث الحجوزات'}
              </button>
            </div>

            {loadErrorContent !== null && (
              <div className="notice notice--danger my-bookings__notice" role="alert">
                <JourneyIcon className="notice__icon" name="alert" />
                <div className="my-bookings__notice-body">
                  <p className="my-bookings__notice-title">
                    تعذر تحديث حجوزاتكِ، وهذه آخر بيانات وصلتنا.
                  </p>
                  <p>{loadErrorContent.message}</p>
                  {loadErrorContent.action === 'sign-in' ? (
                    <button
                      className="btn btn--secondary"
                      type="button"
                      onClick={() => handleSignOut(true)}
                      aria-disabled={pendingAction !== null || undefined}
                    >
                      {isSigningOut
                        ? 'جارٍ تجهيز تسجيل الدخول…'
                        : 'تسجيل الدخول مرة أخرى'}
                    </button>
                  ) : loadErrorContent.action === 'contact' ? (
                    <AccountErasedSupportLink className="btn btn--secondary" />
                  ) : (
                    <button
                      className="btn btn--secondary"
                      type="button"
                      onClick={
                        loadErrorContent.action === 'verify'
                          ? handleVerificationRetry
                          : refreshBookings
                      }
                      aria-disabled={pendingAction !== null || isRefreshing || undefined}
                    >
                      إعادة المحاولة
                    </button>
                  )}
                </div>
              </div>
            )}

            {partialError !== null && (
              <p className="notice notice--warning my-bookings__notice" role="status">
                <JourneyIcon className="notice__icon" name="alert" />
                <span>{getPartialErrorMessage(partialError)}</span>
              </p>
            )}

            {isUnknownBookingRequested && (
              <p className="notice notice--info my-bookings__notice">
                <JourneyIcon className="notice__icon" name="info" />
                <span>تعذر العثور على هذا الطلب في حسابكِ، وهذه جميع طلباتكِ.</span>
              </p>
            )}

            {selectedBooking === null ? (
              bookingList
            ) : (
              <StageViewHost
                booking={selectedBooking}
                requestedView={requestedView}
                fallback={bookingList}
                clockOffsetMs={clockOffsetMs}
                onClose={closeStageView}
                onBookingChanged={refreshBookings}
              />
            )}
          </section>
        )}
      </main>

      {!embedded && (
        <footer className="my-bookings__footer">
          <p>المصورة سندس يار — المدينة المنورة</p>
          <a
            className="text-link"
            href="/"
            onClick={(event) => handleNavigation(event, '/')}
          >
            العودة إلى الموقع العام
          </a>
        </footer>
      )}

      {showAuthDialog && (
        <AuthDialog
          openerRef={loginButtonRef}
          completionFocusRef={pageFocusRef}
          onRequestClose={closeAuthenticationDialog}
          onAuthenticationComplete={closeAuthenticationDialog}
          purpose="account"
        />
      )}
    </div>
  )
}
