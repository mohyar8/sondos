import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
  type RefObject,
} from 'react'
import type {
  AdminBookingDetail,
  AdminBookingStatusHistoryEntry,
  AdminBookingSummary,
  BookingStatus,
} from '../../shared/admin'
import type {
  BookingCalculationBreakdown,
  BookingPackageSnapshot,
  BookingSnapshotExtra,
} from '../../shared/booking'
import {
  ADMIN_MFA_REQUIRED_CODE,
  fetchAdminBookingDetail,
  fetchAdminBookings,
  getAdminLimitMessage,
  type AdminApiError,
  type AdminApiErrorKind,
  type AdminApiResult,
  type AdminBookingListFilters,
  type AdminSession,
} from '../api/admin'
import { useAuth } from '../auth/auth-context'
import { brandLogo } from '../data/brand-images'
import AdminBookingPortal from '../features/admin-portal/AdminBookingPortal'
import AdminIcon from '../features/admin-portal/AdminIcon'
import AdminSecurityPanel from '../features/admin-portal/AdminSecurityPanel'
import AdminStatusBadge from '../features/admin-portal/AdminStatusBadge'
import AdminTabList, {
  type AdminTabItem,
} from '../features/admin-portal/AdminTabList'
import {
  DEFAULT_ADMIN_TAB,
  getAdminPanelDomId,
  getAdminTabDomId,
  isPlausibleBookingId,
  readAdminLocation,
  writeAdminLocation,
} from '../features/admin-portal/admin-location'
import {
  appendBookingPage,
  findFirstNewBooking,
  formatLoadedBookingCount,
  loadAdminBookingPages,
  type AdminBookingListPages,
} from '../features/admin-portal/booking-list-pages'
import {
  adminStatusPresentation,
  getAdminStatusLabel,
} from '../features/admin-portal/booking-status'
import CustomerWhatsApp from '../features/admin-portal/CustomerWhatsApp'
import {
  formatAdminCalendarDate,
  formatAdminCurrency,
  formatAdminTimestamp,
  formatCustomerName,
  formatCustomerText,
  formatPersonName,
} from '../features/admin-portal/format'
import { adminWorkspaceTabs } from '../features/admin-portal/sections'
import {
  ADMIN_WIDE_LAYOUT_QUERY,
  useMediaQuery,
} from '../features/admin-portal/use-media-query'
import RouteErrorBoundary from '../layout/RouteErrorBoundary'
import RouteFallback from '../layout/RouteFallback'
import AuthDialog from './AuthDialog'
import BlockedDatesManager from './BlockedDatesManager'
import BookingActions from './BookingActions'
import './AdminDashboard.css'

type DashboardFilterStatus = Exclude<BookingStatus, 'expired'>

interface DraftFilters {
  status: '' | DashboardFilterStatus
  from: string
  to: string
}

interface ListRequestState {
  /** User + filters + reload version: the request this result answers. */
  key: string
  /** User + filters only: a refresh keeps showing this list meanwhile. */
  filterKey: string
  result: AdminApiResult<AdminBookingListPages>
}

/** «عرض المزيد» for the list identified by `key`. */
type LoadMoreState =
  | {
      key: string
      status: 'loading'
    }
  | {
      key: string
      status: 'error'
      error: AdminApiError
    }

/** Move focus to a list row's button once that row is rendered. */
interface RowFocusRequest {
  bookingId: string
  sequence: number
}

interface DetailRequestState {
  /** User + booking + reload version: the request this result answers. */
  key: string
  /**
   * The signed-in user it was loaded for. A refresh keeps showing a cached
   * booking only to that same user (see previousDetailBooking).
   */
  userKey: string
  result: AdminApiResult<{ ok: true; booking: AdminBookingDetail }>
}

/** Move focus to the detail heading once this booking is displayed. */
interface DetailFocusRequest {
  bookingId: string
  sequence: number
}

const LIST_LIMIT = 50

const DEFAULT_FILTERS: DraftFilters = {
  status: '',
  from: '',
  to: '',
}

const filterStatuses: readonly DashboardFilterStatus[] = [
  'pending_review',
  'approved_hold',
  'contract_pending',
  'contract_signed',
  'payment_pending',
  'confirmed',
  'rejected',
  'cancelled',
]

/**
 * Built-in tabs first, then the workspace tabs registered in sections.ts;
 * «أمان الحساب» (the authenticator app) stays last.
 */
const dashboardTabs: readonly AdminTabItem[] = [
  { id: 'bookings', label: 'طلبات الحجز' },
  { id: 'blocked-dates', label: 'الأيام المحجوبة' },
  ...adminWorkspaceTabs
    .filter(
      (tab) =>
        tab.id !== 'bookings' &&
        tab.id !== 'blocked-dates' &&
        tab.id !== 'security',
    )
    .sort((first, second) => first.order - second.order)
    .map((tab) => ({ id: tab.id, label: tab.label })),
  { id: 'security', label: 'أمان الحساب' },
]

const BOOKING_ACTIONS_BUSY_SOURCE = 'booking-actions'

function isDashboardFilterStatus(
  value: string,
): value is DashboardFilterStatus {
  return filterStatuses.some((status) => status === value)
}

function isValidFilterDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(0)

  if (year < 1) {
    return false
  }

  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function getListErrorMessage(kind: AdminApiErrorKind): string {
  switch (kind) {
    case 'network':
      return 'تعذر الاتصال بالخدمة حاليًا. تحققي من الاتصال ثم أعيدي المحاولة.'
    case 'server':
      return 'تعذر تحميل الحجوزات حاليًا. أعيدي المحاولة بعد قليل.'
    case 'malformed-response':
      return 'وصلت بيانات غير مكتملة من الخدمة. أعيدي المحاولة.'
    case 'invalid-request':
      return 'تعذر تطبيق مرشحات البحث. راجعي التواريخ ثم أعيدي المحاولة.'
    case 'not-found':
      return 'تعذر العثور على بيانات الحجوزات المطلوبة.'
    case 'conflict':
      return 'تعذر تحميل الحجوزات بسبب تعارض مؤقت. أعيدي المحاولة.'
    case 'unauthenticated':
      return 'تعذر التحقق من جلسة تسجيل الدخول.'
    case 'forbidden':
      return 'ليس لديكِ صلاحية الدخول إلى لوحة الإدارة.'
    case 'aborted':
      return 'تم إيقاف الطلب.'
  }
}

/** A Worker limit in its own words, else the message for the error's kind. */
function getListErrorText(error: AdminApiError): string {
  return getAdminLimitMessage(error) ?? getListErrorMessage(error.kind)
}

function getLoadMoreErrorMessage(error: AdminApiError): string {
  const limitMessage = getAdminLimitMessage(error)

  if (limitMessage !== null) {
    return limitMessage
  }

  switch (error.kind) {
    case 'invalid-request':
      return 'تعذر تحميل الطلبات الأقدم لأن القائمة تغيّرت. حدّثي القائمة ثم أعيدي المحاولة.'
    case 'server':
    case 'malformed-response':
      return 'تعذر تحميل الطلبات الأقدم حاليًا. أعيدي المحاولة بعد قليل.'
    default:
      return getListErrorMessage(error.kind)
  }
}

/** A DOM id for a row's «عرض التفاصيل» button (booking ids are opaque). */
function getBookingOpenButtonDomId(bookingId: string): string {
  return `admin-booking-open-${encodeURIComponent(bookingId)}`
}

function getDetailErrorMessage(error: AdminApiError): string {
  const limitMessage = getAdminLimitMessage(error)

  if (limitMessage !== null) {
    return limitMessage
  }

  switch (error.kind) {
    case 'not-found':
      return 'لم يعد طلب الحجز المحدد متاحًا، أو أن رابطه غير صحيح.'
    case 'invalid-request':
      return 'رقم الطلب في الرابط غير صالح.'
    default:
      return getListErrorMessage(error.kind)
  }
}

function getSnapshotExtraDescription(extra: BookingSnapshotExtra): string {
  switch (extra.kind) {
    case 'individual_print':
      return `${extra.name} — الكمية ${extra.quantity}`
    case 'magazine':
      return `${extra.name} — ${extra.quantity} نسخة، ${extra.pageCount} صفحة لكل نسخة`
    case 'wooden_enlargement':
      return `${extra.name} (${extra.dimensions}) — الكمية ${extra.quantity}`
    case 'coverage_addon':
      return `${extra.name} — إضافة على التغطية`
  }
}

function AdminNotice({
  tone,
  role,
  children,
}: {
  tone: 'info' | 'success' | 'warning' | 'danger'
  role?: 'alert' | 'status'
  children: string
}) {
  return (
    <p className={`notice notice--${tone} admin-notice`} role={role}>
      <AdminIcon
        className="notice__icon"
        name={tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert'}
      />
      <span>{children}</span>
    </p>
  )
}

function BookingListItem({
  booking,
  isSelected,
  isDisabled,
  onSelect,
}: {
  booking: AdminBookingSummary
  isSelected: boolean
  isDisabled: boolean
  onSelect: (
    event: MouseEvent<HTMLButtonElement>,
    bookingId: string,
  ) => void
}) {
  const customerName = formatCustomerName(booking.customer)

  return (
    <li
      className={`admin-booking-row${
        isSelected ? ' admin-booking-row--selected' : ''
      }`}
      aria-current={isSelected || undefined}
    >
      <div className="admin-booking-row__cell admin-booking-row__cell--reference">
        <span className="admin-booking-row__label">مرجع الطلب</span>
        <bdi className="admin-reference" dir="ltr">
          {booking.id}
        </bdi>
      </div>

      <div className="admin-booking-row__cell admin-booking-row__cell--customer">
        <span className="admin-booking-row__label">العميلة</span>
        {/* Customer-supplied text: isolated so it cannot reorder the row. */}
        <bdi>{customerName}</bdi>
      </div>

      <div className="admin-booking-row__cell">
        <span className="admin-booking-row__label">تاريخ المناسبة</span>
        <span>{formatAdminCalendarDate(booking.eventDate)}</span>
      </div>

      <div className="admin-booking-row__cell">
        <span className="admin-booking-row__label">الباقة</span>
        <span>{booking.packageName ?? 'غير متوفرة'}</span>
      </div>

      <div className="admin-booking-row__cell admin-booking-row__cell--number">
        <span className="admin-booking-row__label">الإجمالي</span>
        <span className="admin-number">
          {formatAdminCurrency(booking.estimatedTotal)}
        </span>
      </div>

      <div className="admin-booking-row__cell">
        <span className="admin-booking-row__label">الحالة</span>
        <AdminStatusBadge status={booking.status} />
      </div>

      <div className="admin-booking-row__cell">
        <span className="admin-booking-row__label">تاريخ الطلب</span>
        <span className="admin-number">
          {formatAdminTimestamp(booking.createdAt)}
        </span>
      </div>

      <div className="admin-booking-row__cell admin-booking-row__cell--action">
        {isSelected && (
          <span className="admin-booking-row__current">معروض أدناه</span>
        )}
        <button
          className={`btn ${isSelected ? 'btn--secondary' : 'btn--ghost'}`}
          id={getBookingOpenButtonDomId(booking.id)}
          type="button"
          onClick={(event) => onSelect(event, booking.id)}
          disabled={isDisabled}
          aria-label={`عرض تفاصيل طلب ${customerName} لمناسبة ${formatAdminCalendarDate(booking.eventDate)}`}
        >
          عرض التفاصيل
        </button>
      </div>
    </li>
  )
}

function PriceBreakdown({
  breakdown,
  total,
}: {
  breakdown: BookingCalculationBreakdown
  total: number
}) {
  const lines = [
    { label: 'تغطية التصوير', value: breakdown.coverage },
    { label: 'الألبوم', value: breakdown.album },
    { label: 'ترقية بوكس الألبوم', value: breakdown.albumBoxUpgrade },
    { label: 'الصور الفردية', value: breakdown.individualPrints },
    { label: 'المجلات', value: breakdown.magazines },
    { label: 'التكبيرات الخشبية', value: breakdown.woodenEnlargements },
  ]

  return (
    <dl className="admin-price-breakdown">
      {lines.map((line) => (
        <div key={line.label}>
          <dt>{line.label}</dt>
          <dd className="admin-number">{formatAdminCurrency(line.value)}</dd>
        </div>
      ))}
      <div className="admin-price-breakdown__total">
        <dt>الإجمالي التقديري</dt>
        <dd className="admin-number">{formatAdminCurrency(total)}</dd>
      </div>
    </dl>
  )
}

function PackageSnapshotDetails({
  snapshot,
}: {
  snapshot: BookingPackageSnapshot
}) {
  return (
    <div className="admin-snapshot">
      <dl className="admin-definition-grid">
        <div>
          <dt>الباقة</dt>
          <dd>{snapshot.package.name}</dd>
        </div>
        <div>
          <dt>التغطية</dt>
          <dd>{snapshot.coverage.label}</dd>
        </div>
        <div>
          <dt>ساعات التصوير</dt>
          <dd>{snapshot.coverage.durationHours} ساعات</dd>
        </div>
        <div>
          <dt>السعر الأساسي</dt>
          <dd className="admin-number">
            {formatAdminCurrency(snapshot.package.basePrice)}
          </dd>
        </div>
      </dl>

      <section
        className="admin-detail-subsection"
        aria-labelledby="admin-album-title"
      >
        <h4 id="admin-album-title">الألبوم</h4>
        {snapshot.album ? (
          <dl className="admin-definition-grid">
            <div>
              <dt>النوع والمقاس</dt>
              <dd>
                {snapshot.album.name} — {snapshot.album.dimensions}
              </dd>
            </div>
            <div>
              <dt>عدد الصور</dt>
              <dd>{snapshot.album.photoCount} صورة</dd>
            </div>
            <div>
              <dt>عدد الصفحات</dt>
              <dd>{snapshot.album.pageCount} صفحة</dd>
            </div>
            <div>
              <dt>البوكس</dt>
              <dd>{snapshot.album.box.name}</dd>
            </div>
            <div>
              <dt>ألبوم Mini</dt>
              <dd>مشمول</dd>
            </div>
          </dl>
        ) : (
          <p className="admin-muted">لم تتم إضافة ألبوم.</p>
        )}
      </section>

      <section
        className="admin-detail-subsection"
        aria-labelledby="admin-extras-title"
      >
        <h4 id="admin-extras-title">الإضافات</h4>
        {snapshot.extras.length > 0 ? (
          <ul className="admin-extras-list">
            {snapshot.extras.map((extra) => (
              <li key={`${extra.kind}-${extra.id}`}>
                <span>{getSnapshotExtraDescription(extra)}</span>
                <span className="admin-number">
                  {formatAdminCurrency(extra.subtotal)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="admin-muted">لا توجد إضافات.</p>
        )}
      </section>
    </div>
  )
}

function StatusHistory({
  history,
}: {
  history: AdminBookingStatusHistoryEntry[]
}) {
  if (history.length === 0) {
    return <p className="admin-muted">لا يوجد سجل حالات متاح.</p>
  }

  return (
    <ol className="admin-history">
      {history.map((entry) => (
        <li key={entry.id}>
          <span className="admin-history__marker" aria-hidden="true" />
          <div className="admin-history__content">
            <p>
              <span>
                {entry.fromStatus === null
                  ? 'بداية الطلب'
                  : getAdminStatusLabel(entry.fromStatus)}
              </span>
              <span className="admin-history__arrow" aria-hidden="true">
                {' ← '}
              </span>
              <span className="admin-visually-hidden"> ثم </span>
              <strong>{getAdminStatusLabel(entry.toStatus)}</strong>
            </p>
            <time className="admin-number" dateTime={entry.createdAt}>
              {formatAdminTimestamp(entry.createdAt)}
            </time>
            {entry.note && (
              <p className="admin-history__note" dir="auto">
                {entry.note}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

function BookingDetails({
  booking,
  headingRef,
  isBusy,
  isRefreshing,
  getIdToken,
  onBookingUpdated,
  onBusyChange,
  onBookingActionsBusyChange,
  onClose,
  onRefresh,
  onRefreshList,
}: {
  booking: AdminBookingDetail
  headingRef: RefObject<HTMLHeadingElement | null>
  isBusy: boolean
  isRefreshing: boolean
  getIdToken: () => Promise<string | null>
  onBookingUpdated: (booking: AdminBookingDetail) => void
  onBusyChange: (sourceId: string, busy: boolean) => void
  onBookingActionsBusyChange: (busy: boolean) => void
  onClose: () => void
  onRefresh: () => void
  onRefreshList: () => void
}) {
  // §5.8: from 80rem the summary column is sticky and scrolls on its own, so
  // it becomes a labelled, focusable region a keyboard user can scroll.
  const isWideLayout = useMediaQuery(ADMIN_WIDE_LAYOUT_QUERY)
  // §5.8: on stacked layouts BookingActions renders the status-change buttons
  // into this sticky bottom bar (it stays empty, and hidden, otherwise).
  const [actionBarElement, setActionBarElement] =
    useState<HTMLDivElement | null>(null)
  const customerName = formatCustomerName(booking.customer)

  function jumpToActions() {
    document.getElementById('booking-actions-title')?.focus()
  }

  return (
    <article className="admin-detail" aria-labelledby="admin-detail-title">
      <header className="admin-detail__header">
        <div className="admin-detail__heading">
          <p className="eyebrow">تفاصيل طلب الحجز</p>
          <h2 id="admin-detail-title" ref={headingRef} tabIndex={-1}>
            طلب <bdi>{customerName}</bdi>
          </h2>
          <p className="admin-detail__reference">
            <span>مرجع الطلب:</span>{' '}
            <bdi className="admin-reference" dir="ltr">
              {booking.id}
            </bdi>
          </p>
          <div className="admin-detail__status">
            <span>الحالة الحالية:</span>
            <AdminStatusBadge status={booking.status} />
          </div>
        </div>

        <div className="admin-detail__header-actions">
          <button
            className="btn btn--secondary admin-detail__jump"
            type="button"
            onClick={jumpToActions}
          >
            الانتقال إلى الإجراءات
          </button>
          <button
            className="btn btn--ghost"
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <AdminIcon className="admin-button-icon" name="refresh" />
            <span>{isRefreshing ? 'جارٍ التحديث…' : 'تحديث التفاصيل'}</span>
          </button>
          <button
            className="btn btn--secondary"
            type="button"
            onClick={onClose}
            disabled={isBusy}
            aria-describedby={isBusy ? 'admin-detail-busy-hint' : undefined}
          >
            <AdminIcon className="admin-button-icon" name="close" />
            <span>إغلاق التفاصيل</span>
          </button>
        </div>

        {isBusy && (
          <p
            className="admin-detail__busy-hint"
            id="admin-detail-busy-hint"
            role="status"
          >
            يُحفظ تغيير الآن؛ يمكنكِ إغلاق التفاصيل بعد اكتماله.
          </p>
        )}
      </header>

      <div className="admin-detail__layout">
        <div
          className="admin-detail__summary"
          role={isWideLayout ? 'region' : undefined}
          aria-label={isWideLayout ? 'ملخص العميلة والباقة' : undefined}
          tabIndex={isWideLayout ? 0 : undefined}
        >
          <section
            className="admin-detail__section"
            aria-labelledby="admin-customer-title"
          >
            <h3 id="admin-customer-title">بيانات العميلة</h3>
            <dl className="admin-definition-grid">
              <div>
                <dt>الاسم</dt>
                <dd>
                  <bdi>{customerName}</bdi>
                </dd>
              </div>
              <div>
                <dt>رقم الجوال</dt>
                <dd>
                  <bdi className="admin-number" dir="ltr">
                    {formatCustomerText(booking.customer.phone)}
                  </bdi>
                </dd>
              </div>
              <div className="admin-definition-grid__wide">
                <dt>البريد الإلكتروني</dt>
                <dd>
                  <bdi dir="ltr">
                    {formatCustomerText(booking.customer.email)}
                  </bdi>
                </dd>
              </div>
            </dl>
          </section>

          <CustomerWhatsApp
            booking={booking}
            eventDateLabel={formatAdminCalendarDate(booking.eventDate)}
          />

          <section
            className="admin-detail__section"
            aria-labelledby="admin-booking-info-title"
          >
            <h3 id="admin-booking-info-title">بيانات الحجز</h3>
            <dl className="admin-definition-grid">
              <div>
                <dt>تاريخ المناسبة</dt>
                <dd>{formatAdminCalendarDate(booking.eventDate)}</dd>
              </div>
              <div>
                <dt>تاريخ إنشاء الطلب</dt>
                <dd className="admin-number">
                  {formatAdminTimestamp(booking.createdAt)}
                </dd>
              </div>
              <div>
                <dt>آخر تحديث</dt>
                <dd className="admin-number">
                  {formatAdminTimestamp(booking.updatedAt)}
                </dd>
              </div>
              {booking.confirmedAt && (
                <div>
                  <dt>وقت التأكيد</dt>
                  <dd className="admin-number">
                    {formatAdminTimestamp(booking.confirmedAt)}
                  </dd>
                </div>
              )}
              {booking.holdExpiresAt && (
                <div>
                  <dt>انتهاء الحجز المؤقت للتاريخ</dt>
                  <dd className="admin-number">
                    {formatAdminTimestamp(booking.holdExpiresAt)}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <section
            className="admin-detail__section"
            aria-labelledby="admin-package-title"
          >
            <h3 id="admin-package-title">تفاصيل الباقة</h3>
            {booking.packageSnapshot ? (
              <PackageSnapshotDetails snapshot={booking.packageSnapshot} />
            ) : (
              <AdminNotice tone="warning">
                تعذرت قراءة النسخة المحفوظة من تفاصيل الباقة لهذا الطلب.
              </AdminNotice>
            )}
          </section>

          {booking.priceBreakdown && (
            <section
              className="admin-detail__section"
              aria-labelledby="admin-price-title"
            >
              <h3 id="admin-price-title">تفصيل السعر</h3>
              <PriceBreakdown
                breakdown={booking.priceBreakdown}
                total={booking.estimatedTotal}
              />
            </section>
          )}
        </div>

        <div className="admin-detail__timeline">
          <section
            className="admin-detail__section"
            aria-labelledby="admin-history-title"
          >
            <h3 id="admin-history-title">سجل الحالة</h3>
            <StatusHistory history={booking.statusHistory} />
          </section>

          <AdminBookingPortal
            booking={booking}
            getIdToken={getIdToken}
            onBusyChange={onBusyChange}
            onRefreshBooking={onRefresh}
            onRefreshList={onRefreshList}
          />
        </div>

        <div className="admin-detail__actions">
          <BookingActions
            booking={booking}
            getIdToken={getIdToken}
            onBookingUpdated={onBookingUpdated}
            onBusyChange={onBookingActionsBusyChange}
            onRefreshDetails={onRefresh}
            onRefreshList={onRefreshList}
            stickyActionBar={actionBarElement}
          />
        </div>
      </div>

      {/* Last in the article, so it sticks to the bottom of the viewport for
          as long as any part of this booking is on screen. */}
      <div className="admin-detail__action-bar" ref={setActionBarElement} />
    </article>
  )
}

/** Is this key event already owned by a dialog (the topmost layer)? */
function isEventOwnedByDialog(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) {
    return true
  }

  const target = event.target

  if (
    target instanceof Element &&
    target.closest('[role="dialog"], [role="alertdialog"], dialog[open]')
  ) {
    return true
  }

  // Focus can sit on <body> while a modal is open (e.g. after a click on its
  // backdrop); the modal still owns Escape.
  return document.querySelector('[aria-modal="true"]') !== null
}

/** Escape inside a text field belongs to that field, not to the panel. */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select') !== null)
  )
}

export default function AdminDashboard() {
  const {
    firebaseUser,
    profile,
    isInitializing,
    isAuthenticated,
    isAuthAvailable,
    profileRequired,
    authError,
    getIdToken,
    signOutUser,
    clearAuthError,
    requestReauthentication,
  } = useAuth()
  // Every admin request can ask for her password again after the Worker's
  // 12-hour sign-in limit (401 REAUTH_REQUIRED) and retry once.
  const adminSession = useMemo<AdminSession>(
    () => ({ getIdToken, requestReauthentication }),
    [getIdToken, requestReauthentication],
  )
  // The tab and the open booking are local state, seeded from the URL once
  // and mirrored back into it with replaceState (see
  // features/admin-portal/admin-location.ts for why).
  const [initialLocation] = useState(readAdminLocation)
  const [activeTab, setActiveTab] = useState(initialLocation.tab)
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(
    initialLocation.bookingId,
  )
  const [hasInvalidBookingLink, setHasInvalidBookingLink] = useState(
    initialLocation.hasInvalidBookingParam,
  )
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<string>>(
    () => new Set([DEFAULT_ADMIN_TAB, initialLocation.tab]),
  )
  const locationSearch = window.location.search
  const [adoptedSearch, setAdoptedSearch] = useState(locationSearch)
  // A deep link lands on the booking it names, once it has loaded.
  const [detailFocusRequest, setDetailFocusRequest] =
    useState<DetailFocusRequest | null>(
      initialLocation.bookingId && initialLocation.tab === 'bookings'
        ? { bookingId: initialLocation.bookingId, sequence: 1 }
        : null,
    )
  const [draftFilters, setDraftFilters] =
    useState<DraftFilters>(DEFAULT_FILTERS)
  const [appliedFilters, setAppliedFilters] =
    useState<AdminBookingListFilters>({ limit: LIST_LIMIT })
  const [filterError, setFilterError] = useState<string | null>(null)
  const [listReloadVersion, setListReloadVersion] = useState(0)
  const [listRequestState, setListRequestState] =
    useState<ListRequestState | null>(null)
  const [loadMoreState, setLoadMoreState] = useState<LoadMoreState | null>(
    null,
  )
  const [rowFocusRequest, setRowFocusRequest] =
    useState<RowFocusRequest | null>(null)
  const [detailReloadVersion, setDetailReloadVersion] = useState(0)
  const [detailRequestState, setDetailRequestState] =
    useState<DetailRequestState | null>(null)
  const [busySources, setBusySources] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const loginButtonRef = useRef<HTMLButtonElement | null>(null)
  const dashboardFocusRef = useRef<HTMLElement | null>(null)
  const selectedBookingOpenerRef = useRef<HTMLButtonElement | null>(null)
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const bookingsHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const handledFocusSequenceRef = useRef(0)
  const focusFrameRef = useRef<number | null>(null)
  // Where focus goes after «تأكيد الهوية» on an access card; see the effect
  // next to showDashboard.
  const identityFocusPhaseRef = useRef<'reloading' | 'dashboard' | null>(
    null,
  )
  const isMountedRef = useRef(true)
  // How many pages the next (re)load fetches: 1 after a filter change, the
  // pages already open after «تحديث القائمة» or an action's refresh.
  const listPageDepthRef = useRef(1)
  const loadMoreAbortRef = useRef<AbortController | null>(null)

  // Back/Forward inside /admin: App.tsx re-renders this page for its one
  // popstate listener, and the address bar is then the source of truth.
  // (Our own replaceState writes record their result in adoptedSearch, so
  // they never land here.)
  if (locationSearch !== adoptedSearch) {
    const nextLocation = readAdminLocation()

    setAdoptedSearch(locationSearch)
    setActiveTab(nextLocation.tab)
    setSelectedBookingId(nextLocation.bookingId)
    setHasInvalidBookingLink(nextLocation.hasInvalidBookingParam)
    setVisitedTabs((currentTabs) =>
      currentTabs.has(nextLocation.tab)
        ? currentTabs
        : new Set([...currentTabs, nextLocation.tab]),
    )
  }

  const isDetailBusy = busySources.size > 0
  const canRequestAdminData =
    isAuthAvailable &&
    isAuthenticated &&
    profile !== null &&
    !isInitializing
  const userRequestKey = firebaseUser?.uid ?? 'signed-out'
  const [cachedDataUserKey, setCachedDataUserKey] = useState(userRequestKey)

  // PDPL: loaded bookings belong to the user who loaded them. When the
  // session changes by any route (a sign-out in another tab, a revoked
  // session, another account signing in here), the cached list and detail
  // are dropped at once, before the next user's first render can show them.
  // The open booking id stays, so a deep link still reopens after sign-in.
  if (cachedDataUserKey !== userRequestKey) {
    setCachedDataUserKey(userRequestKey)
    setListRequestState(null)
    setLoadMoreState(null)
    setDetailRequestState(null)
  }

  const listFilterKey = useMemo(
    () =>
      [
        userRequestKey,
        appliedFilters.status ?? '',
        appliedFilters.from ?? '',
        appliedFilters.to ?? '',
        appliedFilters.limit ?? LIST_LIMIT,
      ].join('|'),
    [appliedFilters, userRequestKey],
  )
  const listRequestKey = `${listFilterKey}|${listReloadVersion}`
  const detailRequestKey = selectedBookingId
    ? `${userRequestKey}|${selectedBookingId}|${detailReloadVersion}`
    : null

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false

      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current)
        focusFrameRef.current = null
      }
    }
  }, [])

  // Another user starts again from the newest page. Declared before the list
  // request below, so on a user change it runs first (effects run in order).
  useEffect(() => {
    listPageDepthRef.current = 1
  }, [userRequestKey])

  useEffect(() => {
    if (!canRequestAdminData) {
      return
    }

    const abortController = new AbortController()
    const pageDepth = listPageDepthRef.current

    void (async () => {
      const token = await getIdToken()

      if (abortController.signal.aborted) {
        return
      }

      const result: AdminApiResult<AdminBookingListPages> = token
        ? await loadAdminBookingPages(
            token,
            appliedFilters,
            pageDepth,
            abortController.signal,
            adminSession,
          )
        : {
            ok: false,
            error: {
              kind: 'unauthenticated',
              code: 'UNAUTHENTICATED',
            },
          }

      if (
        abortController.signal.aborted ||
        (!result.ok && result.error.kind === 'aborted')
      ) {
        return
      }

      if (result.ok) {
        listPageDepthRef.current = result.data.pageCount
      }

      setListRequestState({
        key: listRequestKey,
        filterKey: listFilterKey,
        result,
      })
    })()

    return () => abortController.abort()
  }, [
    adminSession,
    appliedFilters,
    canRequestAdminData,
    getIdToken,
    listFilterKey,
    listRequestKey,
  ])

  // A «عرض المزيد» request belongs to one list: a filter change, a refresh
  // or leaving the page cancels it.
  useEffect(() => {
    return () => {
      loadMoreAbortRef.current?.abort()
      loadMoreAbortRef.current = null
    }
  }, [listRequestKey])

  // After «عرض المزيد», focus lands on the first new row's button, so Tab
  // carries on through the new rows instead of starting over at the top.
  useEffect(() => {
    if (rowFocusRequest === null) {
      return
    }

    const animationFrame = window.requestAnimationFrame(() => {
      document
        .getElementById(getBookingOpenButtonDomId(rowFocusRequest.bookingId))
        ?.focus()
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [rowFocusRequest])

  useEffect(() => {
    if (
      !canRequestAdminData ||
      !selectedBookingId ||
      !detailRequestKey
    ) {
      return
    }

    const abortController = new AbortController()

    void (async () => {
      const token = await getIdToken()

      if (abortController.signal.aborted) {
        return
      }

      const result: DetailRequestState['result'] = token
        ? await fetchAdminBookingDetail(
            token,
            selectedBookingId,
            abortController.signal,
            adminSession,
          )
        : {
            ok: false,
            error: {
              kind: 'unauthenticated',
              code: 'UNAUTHENTICATED',
            },
          }

      if (
        abortController.signal.aborted ||
        (!result.ok && result.error.kind === 'aborted')
      ) {
        return
      }

      setDetailRequestState({
        key: detailRequestKey,
        userKey: userRequestKey,
        result,
      })
    })()

    return () => abortController.abort()
  }, [
    adminSession,
    canRequestAdminData,
    detailRequestKey,
    getIdToken,
    selectedBookingId,
    userRequestKey,
  ])

  const activeListResult =
    listRequestState?.key === listRequestKey
      ? listRequestState.result
      : null
  // While the same list reloads («تحديث القائمة», or after an action), the
  // rows already shown stay on screen instead of collapsing to a spinner.
  const staleListPages =
    activeListResult === null &&
    listRequestState?.filterKey === listFilterKey &&
    listRequestState.result.ok
      ? listRequestState.result.data
      : null
  const listPages = activeListResult?.ok
    ? activeListResult.data
    : staleListPages
  const activeLoadMoreState =
    loadMoreState?.key === listRequestKey ? loadMoreState : null
  const isLoadingMore = activeLoadMoreState?.status === 'loading'
  const activeDetailResult =
    detailRequestKey && detailRequestState?.key === detailRequestKey
      ? detailRequestState.result
      : null
  // While the open booking reloads, its last copy stays on screen — but only
  // for the user it was loaded for (PDPL: never another account's data).
  const previousDetailBooking =
    detailRequestState?.userKey === userRequestKey &&
    detailRequestState.result.ok &&
    detailRequestState.result.data.booking.id === selectedBookingId
      ? detailRequestState.result.data.booking
      : null
  const displayedDetailBooking = activeDetailResult?.ok
    ? activeDetailResult.data.booking
    : activeDetailResult === null
      ? previousDetailBooking
      : null
  const displayedDetailBookingId = displayedDetailBooking?.id ?? null
  const isListLoading =
    canRequestAdminData && activeListResult === null
  const isListRefreshing = isListLoading && listPages !== null
  const isDetailLoading =
    canRequestAdminData &&
    selectedBookingId !== null &&
    activeDetailResult === null
  const listError =
    activeListResult?.ok === false ? activeListResult.error : null
  // 403 ADMIN_MFA_REQUIRED: ADMIN_REQUIRE_MFA is on and this sign-in used no
  // authenticator app. 401 REAUTH_REQUIRED: she closed the password prompt.
  const isMfaRequired =
    listError?.kind === 'forbidden' &&
    listError.code === ADMIN_MFA_REQUIRED_CODE
  const isReauthenticationRequired =
    listError?.kind === 'unauthenticated' &&
    listError.code === 'REAUTH_REQUIRED'
  // The browse-only preview's 403 is not about her role: the list shows it
  // in its own words instead (getListErrorText).
  const isForbidden =
    listError?.kind === 'forbidden' &&
    !isMfaRequired &&
    listError.code !== 'PREVIEW_READ_ONLY'
  const hasAuthenticationRequestFailure =
    listError?.kind === 'unauthenticated' && !isReauthenticationRequired
  const selectedBookingOutsideActiveList =
    selectedBookingId !== null &&
    activeListResult?.ok === true &&
    !activeListResult.data.bookings.some(
      (booking) => booking.id === selectedBookingId,
    )
  const showAuthDialog =
    isAuthDialogOpen &&
    (!isAuthenticated || profile === null || profileRequired)

  const scheduleFocus = useCallback(
    (getTarget: () => HTMLElement | null) => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current)
      }

      focusFrameRef.current = window.requestAnimationFrame(() => {
        focusFrameRef.current = null
        const target = getTarget()

        if (target?.isConnected) {
          target.focus()
        }
      })
    },
    [],
  )

  const reportBusy = useCallback((sourceId: string, busy: boolean) => {
    setBusySources((currentSources) => {
      if (currentSources.has(sourceId) === busy) {
        return currentSources
      }

      const nextSources = new Set(currentSources)

      if (busy) {
        nextSources.add(sourceId)
      } else {
        nextSources.delete(sourceId)
      }

      return nextSources
    })
  }, [])

  const reportBookingActionsBusy = useCallback(
    (busy: boolean) => reportBusy(BOOKING_ACTIONS_BUSY_SOURCE, busy),
    [reportBusy],
  )

  const commitLocation = useCallback(
    (tab: string, bookingId: string | null) => {
      setAdoptedSearch(writeAdminLocation(tab, bookingId))
    },
    [],
  )

  const closeBookingDetails = useCallback(() => {
    // Mid-request the panel stays: unmounting it would abort a request the
    // server may already be committing (defect #5).
    if (isDetailBusy) {
      return
    }

    const opener = selectedBookingOpenerRef.current

    selectedBookingOpenerRef.current = null
    commitLocation(activeTab, null)
    setSelectedBookingId(null)
    scheduleFocus(() =>
      opener?.isConnected ? opener : bookingsHeadingRef.current,
    )
  }, [activeTab, commitLocation, isDetailBusy, scheduleFocus])

  // Escape closes the booking panel — but only when nothing above it owns
  // the key: an open dialog (BookingActions' confirmation, a blocked-date
  // dialog) consumes Escape first and marks it defaultPrevented; a text field
  // keeps Escape for itself; and while a request is in flight Escape never
  // unmounts the panel.
  useEffect(() => {
    if (!selectedBookingId || activeTab !== 'bookings') {
      return
    }

    function handleEscape(event: KeyboardEvent) {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        isEventOwnedByDialog(event) ||
        isEditableTarget(event.target) ||
        isDetailBusy
      ) {
        return
      }

      event.preventDefault()
      closeBookingDetails()
    }

    document.addEventListener('keydown', handleEscape)

    return () => document.removeEventListener('keydown', handleEscape)
  }, [activeTab, closeBookingDetails, isDetailBusy, selectedBookingId])

  // Focus moves to the detail heading only when the admin opened a booking
  // (a click, a deep link, a workspace tab) — never after a notes save, an
  // action or «تحديث التفاصيل», which all keep focus where it was.
  useEffect(() => {
    if (
      detailFocusRequest === null ||
      detailFocusRequest.sequence === handledFocusSequenceRef.current ||
      detailFocusRequest.bookingId !== displayedDetailBookingId ||
      activeTab !== 'bookings'
    ) {
      return
    }

    const sequence = detailFocusRequest.sequence
    const animationFrame = window.requestAnimationFrame(() => {
      handledFocusSequenceRef.current = sequence
      detailHeadingRef.current?.focus()
    })

    return () => window.cancelAnimationFrame(animationFrame)
  }, [activeTab, detailFocusRequest, displayedDetailBookingId])

  function requestDetailFocus(bookingId: string) {
    setDetailFocusRequest((currentRequest) => ({
      bookingId,
      sequence: (currentRequest?.sequence ?? 0) + 1,
    }))
  }

  function selectTab(tabId: string) {
    if (tabId === activeTab) {
      return
    }

    // Switching tabs keeps focus on the tab list: drop any focus request
    // still waiting for a detail panel to load.
    handledFocusSequenceRef.current = detailFocusRequest?.sequence ?? 0
    commitLocation(tabId, selectedBookingId)
    setActiveTab(tabId)
    setVisitedTabs((currentTabs) =>
      currentTabs.has(tabId) ? currentTabs : new Set([...currentTabs, tabId]),
    )
  }

  function openBooking(bookingId: string, opener: HTMLButtonElement | null) {
    // Mid-request the open booking stays open (another booking cannot replace
    // it, defect #5) and stays as it is: re-opening it neither reloads it nor
    // pulls focus away from the panel where the request runs. From another
    // tab it is only brought forward, with focus on its heading as usual.
    if (isDetailBusy) {
      if (bookingId === selectedBookingId && activeTab !== 'bookings') {
        commitLocation('bookings', bookingId)
        setActiveTab('bookings')
        requestDetailFocus(bookingId)
      }

      return
    }

    selectedBookingOpenerRef.current = opener
    commitLocation('bookings', bookingId)
    setActiveTab('bookings')
    setSelectedBookingId(bookingId)
    setHasInvalidBookingLink(false)
    setDetailReloadVersion((currentVersion) => currentVersion + 1)
    requestDetailFocus(bookingId)
  }

  function selectBooking(
    event: MouseEvent<HTMLButtonElement>,
    bookingId: string,
  ) {
    openBooking(bookingId, event.currentTarget)
  }

  function openBookingFromWorkspace(bookingId: string) {
    if (isPlausibleBookingId(bookingId)) {
      openBooking(bookingId, null)
    }
  }

  function openAuthenticationDialog() {
    clearAuthError()
    setSignOutError(null)
    setIsAuthDialogOpen(true)
  }

  function closeAuthenticationDialog() {
    setIsAuthDialogOpen(false)
  }

  async function handleSignOut() {
    if (isSigningOut) {
      return
    }

    setIsSigningOut(true)
    setSignOutError(null)
    setIsAuthDialogOpen(false)

    const result = await signOutUser()

    if (!isMountedRef.current) {
      return
    }

    if (result.ok) {
      listPageDepthRef.current = 1
      identityFocusPhaseRef.current = null
      commitLocation(activeTab, null)
      setSelectedBookingId(null)
      setDetailRequestState(null)
    } else {
      setSignOutError('تعذر تسجيل الخروج حاليًا. أعيدي المحاولة.')
    }

    setIsSigningOut(false)
  }

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (
      (draftFilters.from && !isValidFilterDate(draftFilters.from)) ||
      (draftFilters.to && !isValidFilterDate(draftFilters.to))
    ) {
      setFilterError('اختاري تاريخًا صحيحًا في مرشحات البحث.')
      return
    }

    if (
      draftFilters.from &&
      draftFilters.to &&
      draftFilters.from > draftFilters.to
    ) {
      setFilterError('يجب ألا يكون تاريخ البداية بعد تاريخ النهاية.')
      return
    }

    setFilterError(null)
    // New filters start again from the newest page.
    listPageDepthRef.current = 1
    setLoadMoreState(null)
    setAppliedFilters({
      ...(draftFilters.status ? { status: draftFilters.status } : {}),
      ...(draftFilters.from ? { from: draftFilters.from } : {}),
      ...(draftFilters.to ? { to: draftFilters.to } : {}),
      limit: LIST_LIMIT,
    })
    setListReloadVersion((currentVersion) => currentVersion + 1)
  }

  function resetFilters() {
    setDraftFilters(DEFAULT_FILTERS)
    setFilterError(null)
    listPageDepthRef.current = 1
    setLoadMoreState(null)
    setAppliedFilters({ limit: LIST_LIMIT })
    setListReloadVersion((currentVersion) => currentVersion + 1)
  }

  // Keeps the filters and reloads as many pages as are open (see
  // listPageDepthRef), so an action on an older booking keeps it in view.
  function refreshBookings() {
    setListReloadVersion((currentVersion) => currentVersion + 1)
  }

  async function loadMoreBookings() {
    if (
      !activeListResult?.ok ||
      activeListResult.data.nextCursor === null ||
      isLoadingMore
    ) {
      return
    }

    const key = listRequestKey
    const loadedPages = activeListResult.data
    const cursor = activeListResult.data.nextCursor
    const abortController = new AbortController()

    loadMoreAbortRef.current?.abort()
    loadMoreAbortRef.current = abortController
    setLoadMoreState({ key, status: 'loading' })

    const token = await getIdToken()

    if (!isMountedRef.current || abortController.signal.aborted) {
      return
    }

    const result = token
      ? await fetchAdminBookings(
          token,
          { ...appliedFilters, cursor },
          abortController.signal,
          adminSession,
        )
      : null

    if (
      !isMountedRef.current ||
      abortController.signal.aborted ||
      (result !== null && !result.ok && result.error.kind === 'aborted')
    ) {
      return
    }

    loadMoreAbortRef.current = null

    if (result === null || !result.ok) {
      setLoadMoreState({
        key,
        status: 'error',
        error:
          result === null
            ? { kind: 'unauthenticated', code: 'UNAUTHENTICATED' }
            : result.error,
      })
      return
    }

    const nextCursor = result.data.nextCursor ?? null
    const firstNewBooking = findFirstNewBooking(
      loadedPages,
      result.data.bookings,
    )

    setListRequestState((currentState) => {
      if (
        !currentState ||
        currentState.key !== key ||
        !currentState.result.ok ||
        currentState.result.data.nextCursor !== cursor
      ) {
        return currentState
      }

      return {
        ...currentState,
        result: {
          ok: true,
          data: appendBookingPage(
            currentState.result.data,
            result.data.bookings,
            nextCursor,
          ),
        },
      }
    })
    listPageDepthRef.current = loadedPages.pageCount + 1
    setLoadMoreState(null)

    if (firstNewBooking) {
      setRowFocusRequest((currentRequest) => ({
        bookingId: firstNewBooking.id,
        sequence: (currentRequest?.sequence ?? 0) + 1,
      }))
    }
  }

  function refreshBookingDetails() {
    setDetailReloadVersion((currentVersion) => currentVersion + 1)
  }

  /**
   * After «تأكيد الهوية» on an access card: the list and the open booking
   * load again. The card, and the button she pressed, unmount as the
   * dashboard takes their place, so focus is moved on explicitly.
   */
  function reloadAfterIdentityConfirmed() {
    identityFocusPhaseRef.current = 'reloading'
    refreshBookings()
    refreshBookingDetails()
  }

  /**
   * «تأكيد الهوية والمتابعة» (401 REAUTH_REQUIRED card): a fresh sign-in
   * (password, then the authenticator code when one is enrolled), then the
   * dashboard again. The MFA card does the same through AdminSecurityPanel.
   */
  async function confirmIdentityAndReload() {
    const confirmed = await requestReauthentication()

    if (confirmed && isMountedRef.current) {
      reloadAfterIdentityConfirmed()
    }
  }

  function updateSelectedBooking(updatedBooking: AdminBookingDetail) {
    setDetailRequestState((currentState) => {
      if (
        !currentState?.result.ok ||
        currentState.result.data.booking.id !== updatedBooking.id
      ) {
        return currentState
      }

      return {
        ...currentState,
        result: {
          ok: true,
          data: {
            ok: true,
            booking: updatedBooking,
          },
        },
      }
    })
  }

  // Her own name, or her sign-in email when the name is blank or missing.
  const adminIdentity =
    (profile ? formatPersonName(profile) : '') ||
    firebaseUser?.email ||
    null
  const showDashboard =
    canRequestAdminData &&
    !isForbidden &&
    !hasAuthenticationRequestFailure &&
    !isReauthenticationRequired &&
    !isMfaRequired

  // After «تأكيد الهوية» (reloadAfterIdentityConfirmed): once the dashboard
  // renders, focus goes to the bookings heading (<main> when another tab is
  // open); if the reload ends on an access card again, to <main>, so it is
  // never left on <body>. These effects run after the password prompt's
  // own focus return, which by then finds nothing left to focus.
  useEffect(() => {
    const phase = identityFocusPhaseRef.current

    if (phase === 'reloading' && showDashboard) {
      identityFocusPhaseRef.current = 'dashboard'
      scheduleFocus(() => {
        const bookingsHeading = bookingsHeadingRef.current

        return bookingsHeading && bookingsHeading.getClientRects().length > 0
          ? bookingsHeading
          : dashboardFocusRef.current
      })
      return
    }

    if (phase === 'dashboard' && !isListLoading) {
      identityFocusPhaseRef.current = null

      if (!showDashboard) {
        scheduleFocus(() => dashboardFocusRef.current)
      }
    }
  }, [isListLoading, scheduleFocus, showDashboard])

  return (
    <div className="admin-dashboard" dir="rtl">
      <a className="skip-link" href="#admin-main">
        تخطي إلى محتوى لوحة الإدارة
      </a>

      <header className="admin-topbar">
        <div className="admin-topbar__inner">
          <div className="admin-topbar__brand">
            <a className="admin-topbar__logo" href="/">
              <picture>
                <source srcSet={brandLogo.height112.webp} type="image/webp" />
                <img
                  alt="المصورة سندس يار — العودة إلى الموقع"
                  height={36}
                  src={brandLogo.height112.png}
                  width={Math.round(
                    (brandLogo.height112.width / brandLogo.height112.height) *
                      36,
                  )}
                />
              </picture>
            </a>
            <div className="admin-topbar__titles">
              <p className="admin-topbar__eyebrow">لوحة الإدارة</p>
              <h1>إدارة الحجوزات</h1>
            </div>
          </div>

          <div className="admin-topbar__actions">
            {isAuthenticated && adminIdentity && (
              <p className="admin-topbar__identity">
                <span>الحساب الحالي</span>
                <bdi dir="auto">{adminIdentity}</bdi>
              </p>
            )}

            <a className="btn btn--ghost" href="/">
              العودة للموقع العام
            </a>

            {isAuthenticated && (
              <button
                className="btn btn--secondary"
                type="button"
                onClick={handleSignOut}
                disabled={isSigningOut}
              >
                {isSigningOut ? 'جارٍ تسجيل الخروج…' : 'تسجيل الخروج'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main
        className="admin-main"
        id="admin-main"
        ref={dashboardFocusRef}
        tabIndex={-1}
      >
        {signOutError && (
          <AdminNotice tone="danger" role="alert">
            {signOutError}
          </AdminNotice>
        )}

        {isInitializing && (
          <section className="admin-access-card" aria-live="polite">
            <p className="eyebrow">التحقق من الحساب</p>
            <h2>جارٍ استعادة جلسة تسجيل الدخول</h2>
            <p>لحظات من فضلكِ.</p>
          </section>
        )}

        {!isInitializing && !isAuthAvailable && (
          <section className="admin-access-card" role="alert">
            <p className="eyebrow">تعذر تشغيل تسجيل الدخول</p>
            <h2>خدمة المصادقة غير متاحة حاليًا</h2>
            <p>
              يمكنكِ إعادة تحميل الصفحة بعد التأكد من إعدادات الخدمة، أو العودة
              إلى الموقع العام.
            </p>
            <div className="admin-access-card__actions">
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => window.location.reload()}
              >
                إعادة تحميل الصفحة
              </button>
              <a className="btn btn--ghost" href="/">
                العودة للموقع العام
              </a>
            </div>
          </section>
        )}

        {!isInitializing && isAuthAvailable && !isAuthenticated && (
          <section className="admin-access-card">
            <p className="eyebrow">دخول محمي</p>
            <h2>يلزم تسجيل الدخول إلى حساب الإدارة</h2>
            <p>
              سجّلي الدخول بحسابكِ، ثم سيتحقق الخادم من صلاحية الإدارة قبل عرض
              أي بيانات.
            </p>
            {selectedBookingId && (
              <p>سيُفتح الطلب المطلوب في الرابط بعد تسجيل الدخول.</p>
            )}
            <div className="admin-access-card__actions">
              <button
                className="btn btn--primary"
                ref={loginButtonRef}
                type="button"
                onClick={openAuthenticationDialog}
              >
                تسجيل الدخول
              </button>
              <a className="btn btn--ghost" href="/">
                العودة للموقع العام
              </a>
            </div>
          </section>
        )}

        {!isInitializing &&
          isAuthAvailable &&
          isAuthenticated &&
          profileRequired && (
            <section className="admin-access-card">
              <p className="eyebrow">الملف الشخصي</p>
              <h2>يلزم استكمال بيانات الحساب</h2>
              <p>استكملي بيانات الحساب قبل التحقق من صلاحية الإدارة.</p>
              <div className="admin-access-card__actions">
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

        {!isInitializing &&
          isAuthAvailable &&
          isAuthenticated &&
          !profileRequired &&
          profile === null && (
            <section className="admin-access-card" role="alert">
              <p className="eyebrow">تعذر تحميل الحساب</p>
              <h2>لم نتمكن من تجهيز جلسة الإدارة</h2>
              <p>
                {authError
                  ? 'تعذر التحقق من بيانات الحساب. سجّلي الخروج ثم حاولي مرة أخرى.'
                  : 'أعيدي المحاولة أو سجّلي الخروج واستخدمي حسابًا آخر.'}
              </p>
              <div className="admin-access-card__actions">
                <button
                  className="btn btn--secondary"
                  type="button"
                  onClick={handleSignOut}
                  disabled={isSigningOut}
                >
                  تسجيل الخروج
                </button>
              </div>
            </section>
          )}

        {isForbidden && (
          <section className="admin-access-card" role="alert">
            <p className="eyebrow">الوصول مرفوض</p>
            <h2>ليس لديكِ صلاحية الدخول</h2>
            <p>
              هذا الحساب مسجل، لكنه لا يملك صلاحية الإدارة في قاعدة البيانات.
            </p>
            <div className="admin-access-card__actions">
              <a className="btn btn--primary" href="/">
                العودة للموقع العام
              </a>
              <button
                className="btn btn--secondary"
                type="button"
                onClick={handleSignOut}
                disabled={isSigningOut}
              >
                تسجيل الخروج
              </button>
            </div>
          </section>
        )}

        {isReauthenticationRequired && (
          <section className="admin-access-card" role="alert">
            <p className="eyebrow">حماية الحساب</p>
            <h2>يلزم تأكيد هويتكِ</h2>
            <p>
              مرّ وقت طويل على آخر تسجيل دخول، لذلك تطلب لوحة الإدارة إدخال
              كلمة المرور مرة أخرى قبل عرض بيانات العميلات.
            </p>
            <div className="admin-access-card__actions">
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => void confirmIdentityAndReload()}
              >
                تأكيد الهوية والمتابعة
              </button>
              <button
                className="btn btn--secondary"
                type="button"
                onClick={handleSignOut}
                disabled={isSigningOut}
              >
                تسجيل الخروج
              </button>
            </div>
          </section>
        )}

        {isMfaRequired && (
          // The text does not depend on the enrolled factors: an alert
          // whose text changed after enrollment would be announced again.
          <section className="admin-access-card" role="alert">
            <p className="eyebrow">حماية الحساب</p>
            <h2>تتطلب لوحة الإدارة التحقق بخطوتين</h2>
            <p>
              لا تُعرض بيانات العميلات إلا لجلسة دخول استخدمت رمزًا من تطبيق
              المصادقة. اتبعي الخطوات في قسم «التحقق بخطوتين» أدناه: فعّلي
              تطبيق المصادقة إن لم يكن مفعّلًا، ثم أكّدي هويتكِ به.
            </p>
            <div className="admin-access-card__actions">
              <button
                className="btn btn--secondary"
                type="button"
                onClick={handleSignOut}
                disabled={isSigningOut}
              >
                تسجيل الخروج
              </button>
            </div>
          </section>
        )}

        {isMfaRequired && (
          // Outside the alert card, so it is not re-announced as one alert.
          // Mounted for both steps (enroll, then confirm her identity), so
          // enrolling never unmounts it.
          <div className="admin-access-security">
            <AdminSecurityPanel
              onIdentityConfirmed={reloadAfterIdentityConfirmed}
            />
          </div>
        )}

        {hasAuthenticationRequestFailure && (
          <section className="admin-access-card" role="alert">
            <p className="eyebrow">انتهت الجلسة</p>
            <h2>تعذر التحقق من تسجيل الدخول</h2>
            <p>سجّلي الخروج ثم أعيدي تسجيل الدخول للمتابعة.</p>
            <div className="admin-access-card__actions">
              <button
                className="btn btn--secondary"
                type="button"
                onClick={handleSignOut}
                disabled={isSigningOut}
              >
                تسجيل الخروج والمحاولة مرة أخرى
              </button>
            </div>
          </section>
        )}

        {showDashboard && (
          <div className="admin-dashboard__content">
            <AdminTabList
              activeTabId={activeTab}
              label="أقسام لوحة الإدارة"
              tabs={dashboardTabs}
              onSelect={selectTab}
            />

            <div
              className="admin-tab-panel"
              id={getAdminPanelDomId('bookings')}
              role="tabpanel"
              aria-labelledby={getAdminTabDomId('bookings')}
              hidden={activeTab !== 'bookings'}
            >
              <section
                className="admin-panel"
                aria-labelledby="admin-filters-title"
              >
                <div className="admin-section-heading">
                  <div>
                    <p className="eyebrow">البحث والفرز</p>
                    <h2 id="admin-filters-title">مرشحات الطلبات</h2>
                  </div>
                </div>

                <form
                  className="admin-filter-form"
                  onSubmit={handleFilterSubmit}
                  noValidate
                >
                  <div className="field admin-filter-form__field">
                    <label className="field__label" htmlFor="admin-filter-status">
                      الحالة
                    </label>
                    <select
                      id="admin-filter-status"
                      value={draftFilters.status}
                      onChange={(event) => {
                        const value = event.currentTarget.value

                        setDraftFilters((currentFilters) => ({
                          ...currentFilters,
                          status: isDashboardFilterStatus(value)
                            ? value
                            : '',
                        }))
                      }}
                    >
                      <option value="">جميع الحالات</option>
                      {filterStatuses.map((status) => (
                        <option key={status} value={status}>
                          {adminStatusPresentation[status].label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field admin-filter-form__field">
                    <label className="field__label" htmlFor="admin-filter-from">
                      من تاريخ المناسبة
                    </label>
                    <input
                      id="admin-filter-from"
                      type="date"
                      value={draftFilters.from}
                      aria-invalid={filterError ? true : undefined}
                      aria-describedby={
                        filterError ? 'admin-filter-error' : undefined
                      }
                      onChange={(event) => {
                        const value = event.currentTarget.value

                        setDraftFilters((currentFilters) => ({
                          ...currentFilters,
                          from: value,
                        }))
                      }}
                    />
                  </div>

                  <div className="field admin-filter-form__field">
                    <label className="field__label" htmlFor="admin-filter-to">
                      إلى تاريخ المناسبة
                    </label>
                    <input
                      id="admin-filter-to"
                      type="date"
                      value={draftFilters.to}
                      aria-invalid={filterError ? true : undefined}
                      aria-describedby={
                        filterError ? 'admin-filter-error' : undefined
                      }
                      onChange={(event) => {
                        const value = event.currentTarget.value

                        setDraftFilters((currentFilters) => ({
                          ...currentFilters,
                          to: value,
                        }))
                      }}
                    />
                  </div>

                  <div className="admin-filter-form__actions">
                    <button className="btn btn--primary" type="submit">
                      تطبيق المرشحات
                    </button>
                    <button
                      className="btn btn--secondary"
                      type="button"
                      onClick={resetFilters}
                    >
                      إعادة التعيين
                    </button>
                  </div>
                </form>

                {filterError && (
                  <p
                    className="field__error admin-filter-form__error"
                    id="admin-filter-error"
                    role="alert"
                  >
                    <AdminIcon className="admin-button-icon" name="alert" />
                    <span>{filterError}</span>
                  </p>
                )}
              </section>

              <section
                className="admin-panel"
                aria-labelledby="admin-bookings-title"
              >
                <div className="admin-section-heading">
                  <div>
                    <p className="eyebrow">الأحدث أولًا</p>
                    <h2
                      id="admin-bookings-title"
                      ref={bookingsHeadingRef}
                      tabIndex={-1}
                    >
                      قائمة الطلبات
                    </h2>
                  </div>
                  <div className="admin-section-heading__meta">
                    {listPages && (
                      <p className="admin-results-count" role="status">
                        {isListRefreshing
                          ? 'جارٍ تحديث القائمة…'
                          : formatLoadedBookingCount(listPages)}
                      </p>
                    )}
                    {/* aria-disabled, not disabled: a keyboard user who
                        pressed it keeps focus on it while the list reloads. */}
                    <button
                      className="btn btn--ghost"
                      type="button"
                      onClick={() => {
                        if (!isListLoading) {
                          refreshBookings()
                        }
                      }}
                      aria-disabled={isListLoading || undefined}
                    >
                      <AdminIcon className="admin-button-icon" name="refresh" />
                      <span>تحديث القائمة</span>
                    </button>
                  </div>
                </div>

                {hasInvalidBookingLink && (
                  <AdminNotice tone="warning" role="status">
                    رابط الطلب في شريط العنوان غير صالح، لذلك لم يُفتح أي طلب.
                    اختاري الطلب من القائمة.
                  </AdminNotice>
                )}

                {isListLoading && !listPages && (
                  <div className="admin-state" role="status">
                    <span className="admin-state__spinner" aria-hidden="true" />
                    <span>جارٍ تحميل طلبات الحجز…</span>
                  </div>
                )}

                {activeListResult?.ok === false && (
                  <div className="admin-state admin-state--error" role="alert">
                    <p>{getListErrorText(activeListResult.error)}</p>
                    <button
                      className="btn btn--primary"
                      type="button"
                      onClick={refreshBookings}
                    >
                      إعادة المحاولة
                    </button>
                  </div>
                )}

                {listPages &&
                  listPages.bookings.length === 0 &&
                  listPages.nextCursor === null && (
                    <div className="admin-state">
                      <h3>لا توجد طلبات مطابقة</h3>
                      <p>غيّري المرشحات أو أعيدي تعيينها لعرض طلبات أخرى.</p>
                    </div>
                  )}

                {listPages && listPages.bookings.length > 0 && (
                  <div
                    className="admin-booking-list-wrap"
                    aria-busy={isListRefreshing || isLoadingMore || undefined}
                  >
                    <div
                      className="admin-booking-list__header"
                      aria-hidden="true"
                    >
                      <span>المرجع</span>
                      <span>العميلة</span>
                      <span>المناسبة</span>
                      <span>الباقة</span>
                      <span className="admin-booking-list__header-number">
                        الإجمالي
                      </span>
                      <span>الحالة</span>
                      <span>تاريخ الطلب</span>
                      <span>التفاصيل</span>
                    </div>

                    <ul className="admin-booking-list">
                      {listPages.bookings.map((booking) => (
                        <BookingListItem
                          booking={booking}
                          // Every row, the open one included: its panel is
                          // already on screen, mid-request (see openBooking).
                          isDisabled={isDetailBusy}
                          isSelected={booking.id === selectedBookingId}
                          key={booking.id}
                          onSelect={selectBooking}
                        />
                      ))}
                    </ul>
                  </div>
                )}

                {listPages &&
                  (listPages.nextCursor !== null || listPages.pageCount > 1) && (
                    <div className="admin-load-more">
                      {activeLoadMoreState?.status === 'error' && (
                        <AdminNotice tone="danger" role="alert">
                          {getLoadMoreErrorMessage(activeLoadMoreState.error)}
                        </AdminNotice>
                      )}

                      {listPages.nextCursor !== null ? (
                        <button
                          className="btn btn--secondary admin-load-more__button"
                          type="button"
                          aria-disabled={
                            isLoadingMore || isListRefreshing || undefined
                          }
                          onClick={() => {
                            if (!isListRefreshing) {
                              void loadMoreBookings()
                            }
                          }}
                        >
                          {isLoadingMore && (
                            <span
                              className="admin-state__spinner admin-load-more__spinner"
                              aria-hidden="true"
                            />
                          )}
                          <span>
                            {isLoadingMore
                              ? 'جارٍ تحميل المزيد…'
                              : 'عرض المزيد'}
                          </span>
                        </button>
                      ) : (
                        <p className="admin-muted admin-load-more__end">
                          عُرضت جميع الطلبات المطابقة.
                        </p>
                      )}
                    </div>
                  )}
              </section>

              {selectedBookingId && (
                <div className="admin-detail-region">
                  {selectedBookingOutsideActiveList && (
                    <AdminNotice tone="info" role="status">
                      {activeListResult?.ok &&
                      activeListResult.data.nextCursor !== null
                        ? 'هذا الطلب غير ظاهر ضمن الطلبات المعروضة في القائمة (قد يكون من الطلبات الأقدم التي تظهر عبر «عرض المزيد»، أو لا يطابق المرشحات)، وتفاصيله معروضة أدناه.'
                        : 'هذا الطلب غير ظاهر ضمن نتائج القائمة الحالية (لا يطابق المرشحات، أو أُنشئ بعد آخر تحديث للقائمة)، وتفاصيله معروضة أدناه.'}
                    </AdminNotice>
                  )}

                  {isDetailLoading && !displayedDetailBooking && (
                    <div className="admin-state" role="status">
                      <span
                        className="admin-state__spinner"
                        aria-hidden="true"
                      />
                      <span>جارٍ تحميل تفاصيل الطلب…</span>
                    </div>
                  )}

                  {activeDetailResult?.ok === false && (
                    <div
                      className="admin-state admin-state--error"
                      role="alert"
                    >
                      <p>
                        {getDetailErrorMessage(activeDetailResult.error)}
                      </p>
                      <div className="admin-state__actions">
                        <button
                          className="btn btn--primary"
                          type="button"
                          onClick={refreshBookingDetails}
                        >
                          إعادة المحاولة
                        </button>
                        <button
                          className="btn btn--secondary"
                          type="button"
                          onClick={closeBookingDetails}
                        >
                          إغلاق التفاصيل
                        </button>
                      </div>
                    </div>
                  )}

                  {displayedDetailBooking && (
                    <BookingDetails
                      booking={displayedDetailBooking}
                      getIdToken={getIdToken}
                      headingRef={detailHeadingRef}
                      isBusy={isDetailBusy}
                      isRefreshing={isDetailLoading}
                      key={displayedDetailBooking.id}
                      onBookingActionsBusyChange={reportBookingActionsBusy}
                      onBookingUpdated={updateSelectedBooking}
                      onBusyChange={reportBusy}
                      onClose={closeBookingDetails}
                      onRefresh={refreshBookingDetails}
                      onRefreshList={refreshBookings}
                    />
                  )}
                </div>
              )}
            </div>

            <div
              className="admin-tab-panel"
              id={getAdminPanelDomId('blocked-dates')}
              role="tabpanel"
              aria-labelledby={getAdminTabDomId('blocked-dates')}
              hidden={activeTab !== 'blocked-dates'}
            >
              {visitedTabs.has('blocked-dates') && (
                <BlockedDatesManager getIdToken={getIdToken} />
              )}
            </div>

            <div
              className="admin-tab-panel"
              id={getAdminPanelDomId('security')}
              role="tabpanel"
              aria-labelledby={getAdminTabDomId('security')}
              hidden={activeTab !== 'security'}
            >
              {visitedTabs.has('security') && <AdminSecurityPanel />}
            </div>

            {adminWorkspaceTabs.map((workspaceTab) => {
              const WorkspaceComponent = workspaceTab.Component

              return (
                <div
                  className="admin-tab-panel"
                  id={getAdminPanelDomId(workspaceTab.id)}
                  key={workspaceTab.id}
                  role="tabpanel"
                  aria-labelledby={getAdminTabDomId(workspaceTab.id)}
                  hidden={activeTab !== workspaceTab.id}
                >
                  {visitedTabs.has(workspaceTab.id) && (
                    <RouteErrorBoundary
                      variant="inline"
                      title={`تعذّر عرض «${workspaceTab.label}».`}
                    >
                      <Suspense
                        fallback={
                          <RouteFallback
                            variant="inline"
                            label="جارٍ تحميل القسم…"
                          />
                        }
                      >
                        <WorkspaceComponent
                          getIdToken={getIdToken}
                          onOpenBooking={openBookingFromWorkspace}
                        />
                      </Suspense>
                    </RouteErrorBoundary>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </main>

      {showAuthDialog && (
        <AuthDialog
          openerRef={loginButtonRef}
          completionFocusRef={dashboardFocusRef}
          onRequestClose={closeAuthenticationDialog}
        />
      )}
    </div>
  )
}
