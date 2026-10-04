import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  maxQuantityFor,
  type BookingSelectionInput,
  type NormalizedBookingSelection,
} from '../../shared/booking'
import {
  createBookingRequest,
  type CreateBookingApiErrorCode,
  type CreatedBooking,
} from '../api/bookings'
import { useAuth } from '../auth/auth-context'
import {
  albumBoxOptions,
  coverageAddonOptions,
  albumSizes,
  calculateMagazineUnitPrice,
  coverageOptions,
  getAlbumBoxPrice,
  getAlbumPrice,
  getCoveragePrice,
  getValidAlbumPageCounts,
  magazinePricing,
  photoCountOptions,
  printSizeOptions,
  woodenEnlargementPricing,
  type AlbumBoxId,
  type AlbumPageCount,
  type AlbumSizeId,
  type CoverageAddonId,
  type CoverageId,
  type MagazinePageCount,
  type PhotoCount,
  type PrintSizeId,
} from '../data/packages'
import { NEW_TAB_HINT } from '../layout/social-links'
import {
  RIYADH_TIME_ZONE,
  parseDateKey,
  toDisplayDate,
} from '../lib/riyadh-calendar'
import {
  ACCOUNT_ERASED_MESSAGE,
  ACCOUNT_SUPPORT_URL,
  BOOKING_EMAIL_NOT_BOUND_MESSAGE,
  serverLimitMessages,
} from '../lib/server-error-messages'
import { buildWhatsAppUrl } from '../lib/whatsapp'
import BookingCalendar, {
  type SelectableDateStatus,
} from './BookingCalendar'
import AuthDialog from './AuthDialog'
import './PackageConfigurator.css'

const STORAGE_KEY = 'sundus-yar-booking-draft-v1'

// Design system §2.3: transactional numbers (prices, quantities, dates) use
// Western digits (`-u-nu-latn`) so they read and copy consistently.
const currencyFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn', {
  style: 'currency',
  currency: 'SAR',
  maximumFractionDigits: 0,
})

const numberFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn')

// Formats `toDisplayDate` values (noon UTC) in the Riyadh time zone, the same
// model the booking calendar uses, so every device shows the chosen day.
const dateFormatter = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn', {
  dateStyle: 'long',
  timeZone: RIYADH_TIME_ZONE,
})

const magazinePageOptions = [
  { value: 1, label: 'صفحة واحدة' },
  { value: 2, label: 'صفحتان' },
  { value: 3, label: '3 صفحات' },
  { value: 4, label: '4 صفحات' },
  { value: 5, label: '5 صفحات' },
] as const satisfies readonly {
  value: MagazinePageCount
  label: string
}[]

type PackageSelections = NormalizedBookingSelection

// Per-item ceilings (audit SEC-09): the one table in shared/booking.ts, the
// same numbers the Worker enforces. Larger orders go through WhatsApp.
const MAXIMUM_MAGAZINE_QUANTITY = maxQuantityFor('magazine')
const MAXIMUM_WOODEN_ENLARGEMENT_QUANTITY = maxQuantityFor(
  woodenEnlargementPricing.id,
)
const QUANTITY_LIMIT_MESSAGE =
  'تتجاوز إحدى الكميات الحد المسموح به في الطلب الواحد. للكميات الأكبر تواصلي معنا عبر واتساب.'

interface CalculatedAmounts {
  coveragePrice: number
  albumPrice: number
  albumBoxPrice: number
  individualPrintsSubtotal: number
  magazineUnitPrice: number
  magazineSubtotal: number
  woodenEnlargementSubtotal: number
  coverageAddonsSubtotal: number
  estimatedTotal: number
}

interface SavedDraft {
  selections: PackageSelections
  amounts: CalculatedAmounts
  bookingDate: {
    date: string
    status: SelectableDateStatus
  }
}

interface FormStatus {
  type: 'success' | 'error' | 'info'
  message: string
  /**
   * A WhatsApp chat offered with the message, for an account problem that
   * retrying cannot fix.
   */
  supportUrl?: string
}

interface SubmittedBookingState {
  booking: CreatedBooking
  packageName: string
  customerName: string
}

type BookingStage = 'editing' | 'continuing' | 'submitted'

/** Heading that receives focus after a stage change (inspection §12 #9). */
type FocusTarget = 'summary' | 'review' | 'success'

interface PendingFocus {
  target: FocusTarget
  stage: BookingStage
}

type IconName = 'check' | 'alert' | 'info' | 'clock'

type NoticeTone = 'success' | 'danger' | 'info' | 'warning'

function createDefaultSelections(): PackageSelections {
  return {
    coverageId: coverageOptions[0].id,
    albumEnabled: false,
    albumSizeId: albumSizes[0].id,
    photoCount: photoCountOptions[0].value,
    albumPageCount: photoCountOptions[0].validPageCounts[0],
    albumBoxId: 'normal',
    printQuantities: {
      a6: 0,
      a5: 0,
      a4: 0,
    },
    magazineQuantity: 0,
    magazinePageCount: 1,
    woodenEnlargementQuantity: 0,
    mobileCoverage: false,
    secondCamera: false,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

/** A draft saved before the ceilings existed is brought within them. */
function clampQuantity(value: number, maximum: number): number {
  return Math.min(value, maximum)
}

function isAddonSelected(
  selections: PackageSelections,
  addonId: CoverageAddonId,
): boolean {
  return addonId === 'mobile-bts'
    ? selections.mobileCoverage
    : selections.secondCamera
}

function isWithinQuantityLimits(selections: PackageSelections): boolean {
  return (
    printSizeOptions.every(
      (option) =>
        selections.printQuantities[option.id] <= maxQuantityFor(option.id),
    ) &&
    selections.magazineQuantity <= MAXIMUM_MAGAZINE_QUANTITY &&
    selections.woodenEnlargementQuantity <= MAXIMUM_WOODEN_ENLARGEMENT_QUANTITY
  )
}

function isCoverageId(value: unknown): value is CoverageId {
  return (
    typeof value === 'string' &&
    coverageOptions.some((option) => option.id === value)
  )
}

function isAlbumSizeId(value: unknown): value is AlbumSizeId {
  return (
    typeof value === 'string' &&
    albumSizes.some((option) => option.id === value)
  )
}

function isPhotoCount(value: unknown): value is PhotoCount {
  return (
    typeof value === 'number' &&
    photoCountOptions.some((option) => option.value === value)
  )
}

function isAlbumPageCount(value: unknown): value is AlbumPageCount {
  return value === 10 || value === 15 || value === 20
}

function isAlbumBoxId(value: unknown): value is AlbumBoxId {
  return (
    typeof value === 'string' &&
    albumBoxOptions.some((option) => option.id === value)
  )
}

function isMagazinePageCount(value: unknown): value is MagazinePageCount {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5
}

/** Web Storage throws DOMException (SecurityError / QuotaExceededError). */
function isStorageFailure(error: unknown): boolean {
  return error instanceof DOMException
}

function loadSavedSelections(): PackageSelections {
  const defaults = createDefaultSelections()

  if (typeof window === 'undefined') {
    return defaults
  }

  try {
    const savedValue = window.localStorage.getItem(STORAGE_KEY)

    if (!savedValue) {
      return defaults
    }

    const parsedValue: unknown = JSON.parse(savedValue)

    if (!isRecord(parsedValue) || !isRecord(parsedValue.selections)) {
      return defaults
    }

    const selections = parsedValue.selections
    const printQuantities = selections.printQuantities

    if (
      !isCoverageId(selections.coverageId) ||
      typeof selections.albumEnabled !== 'boolean' ||
      !isAlbumSizeId(selections.albumSizeId) ||
      !isPhotoCount(selections.photoCount) ||
      !isAlbumPageCount(selections.albumPageCount) ||
      !isAlbumBoxId(selections.albumBoxId) ||
      !isRecord(printQuantities) ||
      !isNonNegativeInteger(printQuantities.a6) ||
      !isNonNegativeInteger(printQuantities.a5) ||
      !isNonNegativeInteger(printQuantities.a4) ||
      !isNonNegativeInteger(selections.magazineQuantity) ||
      !isMagazinePageCount(selections.magazinePageCount) ||
      !isNonNegativeInteger(selections.woodenEnlargementQuantity)
    ) {
      return defaults
    }

    const validPageCounts = getValidAlbumPageCounts(selections.photoCount)

    if (!validPageCounts.includes(selections.albumPageCount)) {
      return defaults
    }

    return {
      coverageId: selections.coverageId,
      albumEnabled: selections.albumEnabled,
      albumSizeId: selections.albumSizeId,
      photoCount: selections.photoCount,
      albumPageCount: selections.albumPageCount,
      albumBoxId: selections.albumEnabled
        ? selections.albumBoxId
        : 'normal',
      printQuantities: {
        a6: clampQuantity(printQuantities.a6, maxQuantityFor('a6')),
        a5: clampQuantity(printQuantities.a5, maxQuantityFor('a5')),
        a4: clampQuantity(printQuantities.a4, maxQuantityFor('a4')),
      },
      magazineQuantity: clampQuantity(
        selections.magazineQuantity,
        MAXIMUM_MAGAZINE_QUANTITY,
      ),
      magazinePageCount: selections.magazinePageCount,
      woodenEnlargementQuantity: clampQuantity(
        selections.woodenEnlargementQuantity,
        MAXIMUM_WOODEN_ENLARGEMENT_QUANTITY,
      ),
      mobileCoverage: selections.mobileCoverage === true,
      secondCamera: selections.secondCamera === true,
    }
  } catch (error: unknown) {
    // A corrupt draft (SyntaxError) or blocked storage (DOMException) just
    // means there is nothing usable to restore.
    if (error instanceof SyntaxError || isStorageFailure(error)) {
      return defaults
    }

    throw error
  }
}

/** Returns false when this device refuses to store the draft. */
function saveDraft(draft: SavedDraft): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
    return true
  } catch (error: unknown) {
    if (isStorageFailure(error)) {
      return false
    }

    throw error
  }
}

/** Returns false when the stored draft could not be removed. */
function clearSavedDraft(): boolean {
  try {
    window.localStorage.removeItem(STORAGE_KEY)
    return true
  } catch (error: unknown) {
    if (isStorageFailure(error)) {
      return false
    }

    throw error
  }
}

/** What she typed, as a whole number from 0 up to the item's ceiling. */
function normalizeQuantity(rawValue: string, maximum: number): number {
  const parsedValue = Number(rawValue)

  if (!Number.isFinite(parsedValue)) {
    return 0
  }

  const normalizedValue = Math.min(
    Math.max(0, Math.floor(parsedValue)),
    maximum,
  )

  return Number.isSafeInteger(normalizedValue) ? normalizedValue : 0
}

function validateSelections(selections: PackageSelections): string | null {
  if (!isCoverageId(selections.coverageId)) {
    return 'يرجى اختيار مدة تغطية صحيحة.'
  }

  if (
    !Object.values(selections.printQuantities).every(isNonNegativeInteger) ||
    !isNonNegativeInteger(selections.magazineQuantity) ||
    !isNonNegativeInteger(selections.woodenEnlargementQuantity)
  ) {
    return 'يجب أن تكون جميع الكميات أعدادًا صحيحة وغير سالبة.'
  }

  if (!isWithinQuantityLimits(selections)) {
    return QUANTITY_LIMIT_MESSAGE
  }

  if (!isMagazinePageCount(selections.magazinePageCount)) {
    return 'يرجى اختيار عدد صفحات صحيح للمجلة.'
  }

  if (!selections.albumEnabled) {
    return selections.albumBoxId === 'normal'
      ? null
      : 'يرجى إعادة اختيار صندوق الألبوم.'
  }

  const validPageCounts = getValidAlbumPageCounts(selections.photoCount)

  if (
    !isAlbumSizeId(selections.albumSizeId) ||
    !isPhotoCount(selections.photoCount) ||
    !isAlbumPageCount(selections.albumPageCount) ||
    !validPageCounts.includes(selections.albumPageCount) ||
    !isAlbumBoxId(selections.albumBoxId)
  ) {
    return 'يرجى مراجعة اختيارات الألبوم.'
  }

  return null
}

function formatCurrency(value: number): string {
  return currencyFormatter.format(value)
}

/**
 * Arabic number agreement for «صفحة»: 1 → صفحة واحدة, 2 → صفحتان,
 * 3–10 → {n} صفحات, 11+ → {n} صفحة (copy deck §11.2).
 */
function formatPageCount(count: number): string {
  if (count === 1) {
    return 'صفحة واحدة'
  }

  if (count === 2) {
    return 'صفحتان'
  }

  const formattedCount = numberFormatter.format(count)

  return count >= 3 && count <= 10
    ? `${formattedCount} صفحات`
    : `${formattedCount} صفحة`
}

function formatBookingDate(value: string): string {
  const calendarDay = parseDateKey(value)

  return calendarDay
    ? dateFormatter.format(toDisplayDate(calendarDay))
    : value
}

function createNormalizedBookingSelection(
  selections: PackageSelections,
): BookingSelectionInput {
  return {
    coverageId: selections.coverageId,
    albumEnabled: selections.albumEnabled,
    albumSizeId: selections.albumSizeId,
    photoCount: selections.photoCount,
    albumPageCount: selections.albumPageCount,
    albumBoxId: selections.albumBoxId,
    printQuantities: {
      a6: selections.printQuantities.a6,
      a5: selections.printQuantities.a5,
      a4: selections.printQuantities.a4,
    },
    magazineQuantity: selections.magazineQuantity,
    magazinePageCount: selections.magazinePageCount,
    woodenEnlargementQuantity: selections.woodenEnlargementQuantity,
    mobileCoverage: selections.mobileCoverage,
    secondCamera: selections.secondCamera,
  }
}

function getBookingFailureMessage(
  errorCode: CreateBookingApiErrorCode,
): string {
  switch (errorCode) {
    case 'DATE_UNAVAILABLE':
      return 'أصبح هذا التاريخ غير متاح. اختاري تاريخًا آخر ثم أعيدي المحاولة.'
    case 'DUPLICATE_BOOKING_REQUEST':
      return 'لديكِ طلب حجز قائم لهذا التاريخ بالفعل.'
    case 'INVALID_JSON':
    case 'INVALID_BOOKING_SELECTION':
    case 'UNSUPPORTED_MEDIA_TYPE':
      return 'تعذر التحقق من تفاصيل الباقة. راجعي اختياراتكِ ثم أعيدي المحاولة.'
    case 'INVALID_EVENT_DATE':
      return 'تعذر التحقق من تاريخ المناسبة. اختاري التاريخ مرة أخرى.'
    case 'NETWORK_ERROR':
      return 'تعذر الاتصال بالخدمة حاليًا. تحققي من الاتصال ثم أعيدي المحاولة.'
    case 'UNAUTHORIZED':
      return 'انتهت جلسة تسجيل الدخول. سجّلي الدخول مرة أخرى للمتابعة.'
    case 'PROFILE_REQUIRED':
      return 'يلزم استكمال بياناتكِ قبل إرسال طلب الحجز.'
    case 'INTERNAL_ERROR':
    case 'MALFORMED_RESPONSE':
      return 'تعذر إرسال طلب الحجز حاليًا. حاولي مرة أخرى لاحقًا.'
    case 'TOO_MANY_OPEN_REQUESTS':
    case 'BOOKING_TOO_FAR_AHEAD':
    case 'RATE_LIMITED':
    case 'PAYLOAD_TOO_LARGE':
    case 'PREVIEW_READ_ONLY':
    case 'REAUTH_REQUIRED':
      return serverLimitMessages[errorCode]
    case 'ACCOUNT_ERASED':
      return ACCOUNT_ERASED_MESSAGE
    case 'EMAIL_ALREADY_IN_USE':
      return BOOKING_EMAIL_NOT_BOUND_MESSAGE
  }
}

/**
 * The WhatsApp chat shown with a failure retrying cannot fix (her account's
 * data erased, her address held by another account), or undefined.
 */
function getBookingFailureSupportUrl(
  errorCode: CreateBookingApiErrorCode,
): string | undefined {
  return errorCode === 'ACCOUNT_ERASED' ||
    errorCode === 'EMAIL_ALREADY_IN_USE'
    ? ACCOUNT_SUPPORT_URL
    : undefined
}

const TOKEN_UNAVAILABLE_MESSAGE =
  'تعذر التحقق من جلسة تسجيل الدخول حاليًا، ولم يُرسَل طلبكِ بعد. تحققي من الاتصال ثم أعيدي المحاولة.'

function createWhatsAppRequestUrl(
  customerName: string,
  bookingId: string,
  eventDate: string,
): string {
  const message = [
    'السلام عليكم،',
    `أنا ${customerName}.`,
    `رقم طلب الحجز: ${bookingId}`,
    `تاريخ المناسبة: ${eventDate}`,
    'تم إرسال طلب حجز جديد عبر الموقع.',
  ].join('\n')

  return buildWhatsAppUrl(message)
}

function Icon({ name, className }: { name: IconName; className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {name === 'check' && <path d="m5 12.5 4.5 4.5L19 7.5" />}
      {name === 'alert' && (
        <>
          <path d="M12 3.5 2.5 20h19Z" />
          <path d="M12 10v4.5" />
          <path d="M12 17.5h.01" />
        </>
      )}
      {name === 'info' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5.5" />
          <path d="M12 7.5h.01" />
        </>
      )}
      {name === 'clock' && (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      )}
    </svg>
  )
}

const noticeIcons: Record<NoticeTone, IconName> = {
  success: 'check',
  danger: 'alert',
  info: 'info',
  warning: 'clock',
}

function StatusMessage({
  status,
  detail,
}: {
  status: FormStatus
  detail: string | null
}) {
  const tone: NoticeTone = status.type === 'error' ? 'danger' : status.type

  return (
    <div
      className={`notice notice--${tone} configurator__message`}
      role={status.type === 'error' ? 'alert' : 'status'}
    >
      <Icon name={noticeIcons[tone]} className="notice__icon" />
      <div className="configurator__message-body">
        <p>{status.message}</p>
        {detail && (
          <p className="configurator__message-detail">{detail}</p>
        )}
        {status.supportUrl && (
          <a
            className="btn btn--whatsapp configurator__message-action"
            href={status.supportUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            تواصلي معنا عبر واتساب
            <span className="visually-hidden"> {NEW_TAB_HINT}</span>
          </a>
        )}
      </div>
    </div>
  )
}

export default function PackageConfigurator() {
  const {
    profile,
    isAuthenticated,
    profileRequired,
    authError,
    signOutUser,
    getIdToken,
    clearAuthError,
    requestReauthentication,
  } = useAuth()
  const [selections, setSelections] =
    useState<PackageSelections>(loadSavedSelections)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [selectedDateStatus, setSelectedDateStatus] =
    useState<SelectableDateStatus | null>(null)
  const [formStatus, setFormStatus] = useState<FormStatus | null>(null)
  const [bookingStage, setBookingStage] =
    useState<BookingStage>('editing')
  const [isDraftSaved, setIsDraftSaved] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [isSubmittingBooking, setIsSubmittingBooking] = useState(false)
  const [submittedBooking, setSubmittedBooking] =
    useState<SubmittedBookingState | null>(null)
  const [calendarRefreshKey, setCalendarRefreshKey] = useState(0)
  const continueButtonRef = useRef<HTMLButtonElement>(null)
  const summaryHeadingRef = useRef<HTMLHeadingElement>(null)
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null)
  const successHeadingRef = useRef<HTMLHeadingElement>(null)
  const pendingFocusRef = useRef<PendingFocus | null>(null)
  const bookingSubmissionInProgressRef = useRef(false)

  // Moves focus to the heading of the section that a stage change revealed.
  // Runs after every commit; a request is dropped if the stage it was made
  // for is no longer current, and waits while its heading is not mounted.
  useEffect(() => {
    const pendingFocus = pendingFocusRef.current

    if (!pendingFocus) {
      return
    }

    if (pendingFocus.stage !== bookingStage) {
      pendingFocusRef.current = null
      return
    }

    const focusElement =
      pendingFocus.target === 'summary'
        ? summaryHeadingRef.current
        : pendingFocus.target === 'review'
          ? reviewHeadingRef.current
          : successHeadingRef.current

    if (!focusElement) {
      return
    }

    pendingFocusRef.current = null
    focusElement.focus()
  })

  const amounts = useMemo<CalculatedAmounts>(() => {
    const coveragePrice = getCoveragePrice(selections.coverageId)
    const albumPrice = selections.albumEnabled
      ? getAlbumPrice(selections.albumSizeId, selections.albumPageCount)
      : 0
    const albumBoxPrice = selections.albumEnabled
      ? getAlbumBoxPrice(selections.albumBoxId)
      : 0

    const individualPrintsSubtotal = printSizeOptions.reduce(
      (subtotal, option) =>
        subtotal +
        selections.printQuantities[option.id] * option.unitPrice,
      0,
    )

    const magazineUnitPrice = calculateMagazineUnitPrice(
      selections.magazinePageCount,
    )
    const magazineSubtotal =
      selections.magazineQuantity * magazineUnitPrice
    const woodenEnlargementSubtotal =
      selections.woodenEnlargementQuantity *
      woodenEnlargementPricing.unitPrice
    const coverageAddonsSubtotal = coverageAddonOptions.reduce(
      (subtotal, option) =>
        isAddonSelected(selections, option.id)
          ? subtotal + option.price
          : subtotal,
      0,
    )

    return {
      coveragePrice,
      albumPrice,
      albumBoxPrice,
      individualPrintsSubtotal,
      magazineUnitPrice,
      magazineSubtotal,
      woodenEnlargementSubtotal,
      coverageAddonsSubtotal,
      estimatedTotal:
        coveragePrice +
        coverageAddonsSubtotal +
        albumPrice +
        albumBoxPrice +
        individualPrintsSubtotal +
        magazineSubtotal +
        woodenEnlargementSubtotal,
    }
  }, [selections])

  const selectedCoverage = coverageOptions.find(
    (option) => option.id === selections.coverageId,
  )
  const selectedAlbum = albumSizes.find(
    (option) => option.id === selections.albumSizeId,
  )
  const selectedAlbumBox = albumBoxOptions.find(
    (option) => option.id === selections.albumBoxId,
  )
  const validAlbumPageCounts = getValidAlbumPageCounts(
    selections.photoCount,
  )
  const reviewExtras = [
    ...coverageAddonOptions.flatMap((option) =>
      isAddonSelected(selections, option.id)
        ? [`${option.label} (${formatCurrency(option.price)})`]
        : [],
    ),
    ...printSizeOptions.flatMap((option) => {
      const quantity = selections.printQuantities[option.id]

      return quantity > 0
        ? [
            `${numberFormatter.format(quantity)} × صورة فردية مقاس ${option.label}`,
          ]
        : []
    }),
    ...(selections.magazineQuantity > 0
      ? [
          `${numberFormatter.format(selections.magazineQuantity)} × مجلة، ${formatPageCount(selections.magazinePageCount)} لكل نسخة`,
        ]
      : []),
    ...(selections.woodenEnlargementQuantity > 0
      ? [
          `${numberFormatter.format(selections.woodenEnlargementQuantity)} × ${woodenEnlargementPricing.label} مقاس ${woodenEnlargementPricing.dimensions}`,
        ]
      : []),
  ]
  const canReview =
    isAuthenticated && profile !== null && !profileRequired
  const showReview = bookingStage === 'continuing' && canReview
  const showAuthDialog =
    bookingStage === 'continuing' && !showReview
  const showEditor = bookingStage === 'editing' || showAuthDialog
  const showSuccess =
    bookingStage === 'submitted' && submittedBooking !== null
  const formattedTotal = formatCurrency(amounts.estimatedTotal)
  const magazinePriceNote = `يبدأ سعر المجلة من ${formatCurrency(magazinePricing.basePrice)} للصفحة الأولى، وتُضاف ${formatCurrency(magazinePricing.additionalPagePrice)} لكل صفحة إضافية.`
  const woodenEnlargementPriceNote = `${formatCurrency(woodenEnlargementPricing.unitPrice)} للوحدة الواحدة`
  const statusDetail =
    formStatus?.type === 'error' && authError ? authError.message : null

  function requestFocus(target: FocusTarget, stage: BookingStage) {
    pendingFocusRef.current = { target, stage }
  }

  function updateSelections(
    updater: (current: PackageSelections) => PackageSelections,
  ) {
    setSelections(updater)
    setFormStatus(null)
  }

  function updatePhotoCount(nextPhotoCount: PhotoCount) {
    const nextValidPageCounts = getValidAlbumPageCounts(nextPhotoCount)

    updateSelections((current) => ({
      ...current,
      photoCount: nextPhotoCount,
      albumPageCount: nextValidPageCounts.includes(current.albumPageCount)
        ? current.albumPageCount
        : (nextValidPageCounts[0] ?? current.albumPageCount),
    }))
  }

  function updatePrintQuantity(
    printSizeId: PrintSizeId,
    rawValue: string,
  ) {
    const quantity = normalizeQuantity(rawValue, maxQuantityFor(printSizeId))

    updateSelections((current) => ({
      ...current,
      printQuantities: {
        ...current.printQuantities,
        [printSizeId]: quantity,
      },
    }))
  }

  function updateMagazineQuantity(rawValue: string) {
    const quantity = normalizeQuantity(rawValue, MAXIMUM_MAGAZINE_QUANTITY)

    updateSelections((current) => ({
      ...current,
      magazineQuantity: quantity,
      magazinePageCount:
        quantity === 0 || current.magazineQuantity === 0
          ? 1
          : current.magazinePageCount,
    }))
  }

  function updateMagazinePageCount(rawValue: string) {
    const selectedOption = magazinePageOptions.find(
      (option) => String(option.value) === rawValue,
    )

    if (selectedOption) {
      updateSelections((current) => ({
        ...current,
        magazinePageCount: selectedOption.value,
      }))
    }
  }

  function updateWoodenEnlargementQuantity(rawValue: string) {
    const quantity = normalizeQuantity(
      rawValue,
      MAXIMUM_WOODEN_ENLARGEMENT_QUANTITY,
    )

    updateSelections((current) => ({
      ...current,
      woodenEnlargementQuantity: quantity,
    }))
  }

  function handleDateSelection(
    date: string,
    status: SelectableDateStatus,
  ) {
    setSelectedDate(date)
    setSelectedDateStatus(status)
    setFormStatus(null)
  }

  function handleShowSummary() {
    summaryHeadingRef.current?.focus()
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const validationMessage = validateSelections(selections)

    if (validationMessage) {
      setFormStatus({
        type: 'error',
        message: validationMessage,
      })
      return
    }

    if (!selectedDate || !selectedDateStatus) {
      setFormStatus({
        type: 'error',
        message: 'اختاري تاريخ المناسبة قبل حفظ الاختيارات والمتابعة.',
      })
      return
    }

    // Saving the draft is a convenience: a device that refuses storage
    // (private mode, full quota) must not block the booking itself.
    const draftSaved = saveDraft({
      selections,
      amounts,
      bookingDate: {
        date: selectedDate,
        status: selectedDateStatus,
      },
    })

    setIsDraftSaved(draftSaved)
    setFormStatus(
      draftSaved
        ? {
            type: 'success',
            message:
              'تم حفظ اختياراتكِ والتاريخ المحدد. لم يتم إرسال طلب الحجز بعد.',
          }
        : {
            type: 'info',
            message:
              'تعذر حفظ اختياراتكِ على هذا الجهاز، ويمكنكِ مع ذلك متابعة طلبكِ الآن. لم يتم إرسال طلب الحجز بعد.',
          },
    )
    clearAuthError()

    // Without a session the AuthDialog opens and manages focus itself; it
    // focuses the review heading (completionFocusRef) once she is signed in.
    if (canReview) {
      requestFocus('review', 'continuing')
    }

    setBookingStage('continuing')
  }

  function handleCloseAuthDialog() {
    clearAuthError()
    setBookingStage('editing')
  }

  function handleEditBooking() {
    if (isSubmittingBooking) {
      return
    }

    setFormStatus(null)
    requestFocus('summary', 'editing')
    setBookingStage('editing')
  }

  // Only a genuine server verdict (UNAUTHORIZED / PROFILE_REQUIRED) comes
  // here. The auth error from the context is left untouched so the dialog
  // can show the real cause.
  async function returnToAuthenticationFlow(message: string) {
    requestFocus('summary', 'editing')
    setBookingStage('editing')
    const signOutResult = await signOutUser()

    if (!signOutResult.ok) {
      setFormStatus({
        type: 'error',
        message: 'تعذر تجديد جلسة تسجيل الدخول. حاولي تسجيل الخروج ثم أعيدي المحاولة.',
      })
      requestFocus('summary', 'editing')
      return
    }

    setFormStatus({
      type: 'error',
      message,
    })
    setBookingStage('continuing')
  }

  async function handleBookingSubmission() {
    if (bookingSubmissionInProgressRef.current) {
      return
    }

    const validationMessage = validateSelections(selections)

    if (validationMessage) {
      setFormStatus({
        type: 'error',
        message: validationMessage,
      })
      requestFocus('summary', 'editing')
      setBookingStage('editing')
      return
    }

    if (!selectedDate || !selectedDateStatus) {
      setFormStatus({
        type: 'error',
        message: 'اختاري تاريخ المناسبة قبل إرسال طلب الحجز.',
      })
      requestFocus('summary', 'editing')
      setBookingStage('editing')
      return
    }

    if (!isAuthenticated || !profile || profileRequired) {
      setFormStatus({
        type: 'error',
        message: 'سجّلي الدخول واستكملي بياناتكِ قبل إرسال الطلب.',
      })
      setBookingStage('continuing')
      return
    }

    if (!selectedCoverage) {
      setFormStatus({
        type: 'error',
        message:
          'تعذر التحقق من تفاصيل الباقة. راجعي اختياراتكِ ثم أعيدي المحاولة.',
      })
      requestFocus('summary', 'editing')
      setBookingStage('editing')
      return
    }

    bookingSubmissionInProgressRef.current = true
    setIsSubmittingBooking(true)
    setFormStatus(null)

    try {
      const token = await getIdToken()

      if (!token) {
        // A missing token can be temporary (network, token refresh). Keep
        // her signed in on the review step so she can simply retry.
        setFormStatus({
          type: 'error',
          message: TOKEN_UNAVAILABLE_MESSAGE,
        })
        return
      }

      const bookingSelection = createNormalizedBookingSelection(selections)
      const result = await createBookingRequest(
        token,
        selectedDate,
        bookingSelection,
        { getIdToken, requestReauthentication },
      )

      if (result.ok) {
        const customerName = `${profile.firstName} ${profile.lastName}`
        const draftCleared = clearSavedDraft()

        setIsDraftSaved(!draftCleared)
        setSubmittedBooking({
          booking: result.booking,
          packageName: selectedCoverage.label,
          customerName,
        })
        setFormStatus(null)
        requestFocus('success', 'submitted')
        setBookingStage('submitted')
        setCalendarRefreshKey((current) => current + 1)
        return
      }

      const errorMessage = getBookingFailureMessage(result.error.code)

      if (result.error.code === 'DATE_UNAVAILABLE') {
        setSelectedDate(null)
        setSelectedDateStatus(null)
        setCalendarRefreshKey((current) => current + 1)
        setFormStatus({
          type: 'error',
          message: errorMessage,
        })
        requestFocus('summary', 'editing')
        setBookingStage('editing')
        return
      }

      if (
        result.error.code === 'INVALID_EVENT_DATE' ||
        result.error.code === 'BOOKING_TOO_FAR_AHEAD' ||
        result.error.code === 'INVALID_BOOKING_SELECTION' ||
        result.error.code === 'INVALID_JSON' ||
        result.error.code === 'UNSUPPORTED_MEDIA_TYPE'
      ) {
        if (
          result.error.code === 'INVALID_EVENT_DATE' ||
          result.error.code === 'BOOKING_TOO_FAR_AHEAD'
        ) {
          setSelectedDate(null)
          setSelectedDateStatus(null)
          setCalendarRefreshKey((current) => current + 1)
        }

        setFormStatus({
          type: 'error',
          message: errorMessage,
        })
        requestFocus('summary', 'editing')
        setBookingStage('editing')
        return
      }

      if (
        result.error.code === 'UNAUTHORIZED' ||
        result.error.code === 'PROFILE_REQUIRED'
      ) {
        await returnToAuthenticationFlow(errorMessage)
        return
      }

      // Transient failures and the Worker's limits (open-request cap, rate
      // limit, preview, a declined password prompt) keep her on the review
      // step; focus stays on the submit button (aria-disabled, never
      // disabled) so she can retry. An account problem retrying cannot fix
      // (erased data, an address another account holds) also offers
      // WhatsApp.
      setFormStatus({
        type: 'error',
        message: errorMessage,
        supportUrl: getBookingFailureSupportUrl(result.error.code),
      })
    } finally {
      bookingSubmissionInProgressRef.current = false
      setIsSubmittingBooking(false)
    }
  }

  function handleStartAnotherBooking() {
    setSubmittedBooking(null)
    setSelectedDate(null)
    setSelectedDateStatus(null)
    setFormStatus(null)
    setCalendarRefreshKey((current) => current + 1)
    requestFocus('summary', 'editing')
    setBookingStage('editing')
  }

  async function handleSignOut() {
    if (isSigningOut || isSubmittingBooking) {
      return
    }

    setIsSigningOut(true)
    requestFocus('summary', 'editing')
    setBookingStage('editing')

    const result = await signOutUser()

    setFormStatus(
      result.ok
        ? {
            type: 'success',
            message: isDraftSaved
              ? 'تم تسجيل الخروج، وبقيت اختيارات الحجز محفوظة على هذا الجهاز.'
              : 'تم تسجيل الخروج.',
          }
        : {
            type: 'error',
            message: 'تعذر تسجيل الخروج. حاولي مرة أخرى.',
          },
    )
    setIsSigningOut(false)
  }

  return (
    <div className="package-configurator">
      <form className="configurator__form" onSubmit={handleSubmit}>
        {showEditor && (
          <div className="configurator__layout">
            <div className="configurator__controls">
              <fieldset className="configurator__section">
                <legend className="configurator__legend">مدة التغطية</legend>
                <p className="configurator__help">
                  اختاري مدة التصوير المناسبة ليومكِ.
                </p>

                <div className="configurator__choice-grid">
                  {coverageOptions.map((option) => {
                    const isSelected = selections.coverageId === option.id

                    return (
                      <label
                        className={`configurator__choice${
                          isSelected ? ' configurator__choice--selected' : ''
                        }`}
                        key={option.id}
                      >
                        <input
                          className="configurator__choice-input"
                          type="radio"
                          name="coverage"
                          value={option.id}
                          checked={isSelected}
                          onChange={() =>
                            updateSelections((current) => ({
                              ...current,
                              coverageId: option.id,
                            }))
                          }
                          required
                        />
                        <span className="configurator__choice-content">
                          <strong className="configurator__choice-title">
                            {option.label}
                          </strong>
                          <span className="configurator__choice-price">
                            {formatCurrency(option.price)}
                          </span>
                        </span>
                        <span
                          className="configurator__choice-state"
                          aria-hidden="true"
                        >
                          <Icon
                            name="check"
                            className="configurator__choice-state-icon"
                          />
                          اختياركِ
                        </span>
                      </label>
                    )
                  })}
                </div>

                <p className="configurator__help">
                  إضافات اختيارية على التغطية:
                </p>
                <div className="configurator__choice-grid">
                  {coverageAddonOptions.map((option) => {
                    const isSelected = isAddonSelected(selections, option.id)

                    return (
                      <label
                        className={`configurator__choice${
                          isSelected ? ' configurator__choice--selected' : ''
                        }`}
                        key={option.id}
                      >
                        <input
                          className="configurator__choice-input"
                          type="checkbox"
                          name={`addon-${option.id}`}
                          checked={isSelected}
                          onChange={(event) => {
                            const checked = event.target.checked

                            updateSelections((current) =>
                              option.id === 'mobile-bts'
                                ? { ...current, mobileCoverage: checked }
                                : { ...current, secondCamera: checked },
                            )
                          }}
                        />
                        <span className="configurator__choice-content">
                          <strong className="configurator__choice-title">
                            {option.label}
                          </strong>
                          <span className="configurator__help">
                            {option.description}
                          </span>
                          <span className="configurator__choice-price">
                            {`+ ${formatCurrency(option.price)}`}
                          </span>
                        </span>
                        <span
                          className="configurator__choice-state"
                          aria-hidden="true"
                        >
                          <Icon
                            name="check"
                            className="configurator__choice-state-icon"
                          />
                          مضافة
                        </span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>

              <fieldset className="configurator__section">
                <legend className="configurator__legend">الألبوم</legend>
                <p className="configurator__help">
                  ألبوم مطبوع بثلاثة مقاسات، ويشمل كل مقاس ألبوم Mini
                  إضافيًا دون تكلفة.
                </p>

                <label
                  className={`configurator__toggle${
                    selections.albumEnabled
                      ? ' configurator__toggle--on'
                      : ''
                  }`}
                >
                  <input
                    className="configurator__toggle-input"
                    type="checkbox"
                    checked={selections.albumEnabled}
                    onChange={(event) => {
                      const albumEnabled = event.currentTarget.checked

                      updateSelections((current) => ({
                        ...current,
                        albumEnabled,
                        albumBoxId: albumEnabled
                          ? current.albumBoxId
                          : 'normal',
                      }))
                    }}
                  />
                  <span>أرغب في إضافة ألبوم</span>
                </label>

                {selections.albumEnabled && (
                  <div className="configurator__album-options">
                    <fieldset className="configurator__subsection">
                      <legend className="configurator__sublegend">
                        مقاس الألبوم
                      </legend>

                      <div className="configurator__choice-grid">
                        {albumSizes.map((option) => {
                          const isSelected =
                            selections.albumSizeId === option.id

                          return (
                            <label
                              className={`configurator__choice${
                                isSelected
                                  ? ' configurator__choice--selected'
                                  : ''
                              }`}
                              key={option.id}
                            >
                              <input
                                className="configurator__choice-input"
                                type="radio"
                                name="album-size"
                                value={option.id}
                                checked={isSelected}
                                onChange={() =>
                                  updateSelections((current) => ({
                                    ...current,
                                    albumSizeId: option.id,
                                  }))
                                }
                              />
                              <span className="configurator__choice-content">
                                <strong className="configurator__choice-title">
                                  {option.label}
                                </strong>
                                <span className="configurator__choice-meta">
                                  {option.dimensions}
                                </span>
                                <span className="configurator__choice-price">
                                  {formatCurrency(
                                    option.pagePrices[
                                      selections.albumPageCount
                                    ],
                                  )}
                                </span>
                              </span>
                              <span
                                className="configurator__choice-state"
                                aria-hidden="true"
                              >
                                <Icon
                                  name="check"
                                  className="configurator__choice-state-icon"
                                />
                                اختياركِ
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </fieldset>

                    <fieldset className="configurator__subsection">
                      <legend className="configurator__sublegend">
                        عدد الصور المشمولة
                      </legend>
                      <p className="configurator__help">
                        يحدّد عدد الصور صفحات الألبوم المتاحة لكِ.
                      </p>

                      <div className="configurator__choice-grid configurator__choice-grid--compact">
                        {photoCountOptions.map((option) => {
                          const isSelected =
                            selections.photoCount === option.value

                          return (
                            <label
                              className={`configurator__choice configurator__choice--compact${
                                isSelected
                                  ? ' configurator__choice--selected'
                                  : ''
                              }`}
                              key={option.value}
                            >
                              <input
                                className="configurator__choice-input"
                                type="radio"
                                name="photo-count"
                                value={option.value}
                                checked={isSelected}
                                onChange={() => updatePhotoCount(option.value)}
                              />
                              <span className="configurator__choice-title">
                                {option.label}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </fieldset>

                    <fieldset className="configurator__subsection">
                      <legend className="configurator__sublegend">
                        عدد صفحات الألبوم
                      </legend>
                      <p className="configurator__help">
                        يتغيّر السعر حسب المقاس وعدد الصفحات معًا.
                      </p>

                      <div className="configurator__choice-grid configurator__choice-grid--compact">
                        {validAlbumPageCounts.map((pageCount) => {
                          const isSelected =
                            selections.albumPageCount === pageCount

                          return (
                            <label
                              className={`configurator__choice configurator__choice--compact${
                                isSelected
                                  ? ' configurator__choice--selected'
                                  : ''
                              }`}
                              key={pageCount}
                            >
                              <input
                                className="configurator__choice-input"
                                type="radio"
                                name="album-pages"
                                value={pageCount}
                                checked={isSelected}
                                onChange={() =>
                                  updateSelections((current) => ({
                                    ...current,
                                    albumPageCount: pageCount,
                                  }))
                                }
                              />
                              <span className="configurator__choice-title">
                                {formatPageCount(pageCount)}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </fieldset>

                    <fieldset className="configurator__subsection">
                      <legend className="configurator__sublegend">
                        صندوق الألبوم
                      </legend>
                      <p className="configurator__help">
                        الصندوق العادي مشمول ضمن سعر الألبوم دون إضافة.
                      </p>

                      <div className="configurator__choice-grid">
                        {albumBoxOptions.map((option) => {
                          const isSelected =
                            selections.albumBoxId === option.id

                          return (
                            <label
                              className={`configurator__choice${
                                isSelected
                                  ? ' configurator__choice--selected'
                                  : ''
                              }`}
                              key={option.id}
                            >
                              <input
                                className="configurator__choice-input"
                                type="radio"
                                name="album-box"
                                value={option.id}
                                checked={isSelected}
                                onChange={() =>
                                  updateSelections((current) => ({
                                    ...current,
                                    albumBoxId: option.id,
                                  }))
                                }
                              />
                              <span className="configurator__choice-content">
                                <strong className="configurator__choice-title">
                                  {option.label}
                                </strong>
                                <span className="configurator__choice-meta">
                                  {option.description}
                                </span>
                                <span className="configurator__choice-price">
                                  {option.price > 0
                                    ? `+ ${formatCurrency(option.price)}`
                                    : 'مشمول'}
                                </span>
                              </span>
                              <span
                                className="configurator__choice-state"
                                aria-hidden="true"
                              >
                                <Icon
                                  name="check"
                                  className="configurator__choice-state-icon"
                                />
                                اختياركِ
                              </span>
                            </label>
                          )
                        })}
                      </div>
                    </fieldset>
                  </div>
                )}
              </fieldset>

              <fieldset className="configurator__section">
                <legend className="configurator__legend">
                  المطبوعات الفردية
                </legend>
                <p className="configurator__help">
                  اختاري الكمية لكل مقاس.
                </p>

                <div className="configurator__product-list">
                  {printSizeOptions.map((option) => (
                    <div
                      className="configurator__product-row"
                      key={option.id}
                    >
                      <div className="configurator__product-text">
                        <label
                          className="configurator__product-label"
                          htmlFor={`print-${option.id}`}
                        >
                          مقاس {option.label}
                        </label>
                        <span className="configurator__product-price">
                          {`${formatCurrency(option.unitPrice)} للصورة الواحدة`}
                        </span>
                        <span
                          className="configurator__product-limit"
                          id={`print-${option.id}-limit`}
                        >
                          {`الحد الأقصى: ${numberFormatter.format(maxQuantityFor(option.id))}`}
                        </span>
                      </div>

                      <input
                        className="input configurator__quantity"
                        id={`print-${option.id}`}
                        type="number"
                        inputMode="numeric"
                        min="0"
                        max={maxQuantityFor(option.id)}
                        step="1"
                        aria-describedby={`print-${option.id}-limit`}
                        value={selections.printQuantities[option.id]}
                        onChange={(event) =>
                          updatePrintQuantity(
                            option.id,
                            event.currentTarget.value,
                          )
                        }
                        aria-label={`عدد الصور الفردية مقاس ${option.label}`}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>

              <fieldset className="configurator__section">
                <legend className="configurator__legend">مجلة التصوير</legend>
                <p className="configurator__help">{magazinePriceNote}</p>

                <div className="configurator__field-grid">
                  <div className="configurator__field">
                    <label
                      className="field__label"
                      htmlFor="magazine-quantity"
                    >
                      عدد المجلات
                    </label>
                    <input
                      className="input configurator__quantity"
                      id="magazine-quantity"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max={MAXIMUM_MAGAZINE_QUANTITY}
                      step="1"
                      aria-describedby="magazine-quantity-limit"
                      value={selections.magazineQuantity}
                      onChange={(event) =>
                        updateMagazineQuantity(event.currentTarget.value)
                      }
                    />
                    <span
                      className="field__hint"
                      id="magazine-quantity-limit"
                    >
                      {`الحد الأقصى: ${numberFormatter.format(MAXIMUM_MAGAZINE_QUANTITY)}`}
                    </span>
                  </div>

                  <div className="configurator__field">
                    <label className="field__label" htmlFor="magazine-pages">
                      صفحات كل مجلة
                    </label>
                    <select
                      className="select"
                      id="magazine-pages"
                      value={selections.magazinePageCount}
                      disabled={selections.magazineQuantity === 0}
                      aria-describedby={
                        selections.magazineQuantity === 0
                          ? 'magazine-pages-hint'
                          : undefined
                      }
                      onChange={(event) =>
                        updateMagazinePageCount(event.currentTarget.value)
                      }
                    >
                      {magazinePageOptions.map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {selections.magazineQuantity === 0 && (
                      <span
                        className="field__hint"
                        id="magazine-pages-hint"
                      >
                        حددي عدد المجلات أولًا لاختيار الصفحات.
                      </span>
                    )}
                  </div>
                </div>

                <dl className="configurator__price-details">
                  <div>
                    <dt>سعر المجلة الواحدة</dt>
                    <dd>{formatCurrency(amounts.magazineUnitPrice)}</dd>
                  </div>
                  <div>
                    <dt>المجموع الفرعي للمجلات</dt>
                    <dd>{formatCurrency(amounts.magazineSubtotal)}</dd>
                  </div>
                </dl>
              </fieldset>

              <fieldset className="configurator__section">
                <legend className="configurator__legend">
                  المكبّرة الخشبية
                </legend>

                <div className="configurator__product-row">
                  <div className="configurator__product-text">
                    <label
                      className="configurator__product-label"
                      htmlFor="wooden-enlargement-quantity"
                    >
                      {`${woodenEnlargementPricing.label} مقاس ${woodenEnlargementPricing.dimensions}`}
                    </label>
                    <span className="configurator__product-price">
                      {woodenEnlargementPriceNote}
                    </span>
                    <span
                      className="configurator__product-limit"
                      id="wooden-enlargement-quantity-limit"
                    >
                      {`الحد الأقصى: ${numberFormatter.format(MAXIMUM_WOODEN_ENLARGEMENT_QUANTITY)}`}
                    </span>
                  </div>

                  <input
                    className="input configurator__quantity"
                    id="wooden-enlargement-quantity"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    max={MAXIMUM_WOODEN_ENLARGEMENT_QUANTITY}
                    step="1"
                    aria-describedby="wooden-enlargement-quantity-limit"
                    value={selections.woodenEnlargementQuantity}
                    onChange={(event) =>
                      updateWoodenEnlargementQuantity(
                        event.currentTarget.value,
                      )
                    }
                    aria-label="عدد المكبّرات الخشبية"
                  />
                </div>
              </fieldset>

              <BookingCalendar
                key={calendarRefreshKey}
                selectedDate={selectedDate}
                selectedStatus={selectedDateStatus}
                onSelectDate={handleDateSelection}
              />

              <div className="configurator__mobile-bar">
                <p className="configurator__mobile-total">
                  <span>الإجمالي:</span> <strong>{formattedTotal}</strong>
                </p>
                <button
                  className="btn btn--secondary configurator__mobile-details"
                  type="button"
                  onClick={handleShowSummary}
                >
                  عرض التفاصيل
                </button>
              </div>
            </div>

            <aside
              className="configurator__summary"
              aria-labelledby="order-summary-title"
            >
              <p className="eyebrow configurator__eyebrow">ملخص اختياراتكِ</p>
              <h3
                className="configurator__heading"
                id="order-summary-title"
                ref={summaryHeadingRef}
                tabIndex={-1}
              >
                الإجمالي التقديري
              </h3>

              <dl className="configurator__summary-lines">
                <div>
                  <dt>
                    التغطية
                    {selectedCoverage ? ` — ${selectedCoverage.label}` : ''}
                  </dt>
                  <dd>{formatCurrency(amounts.coveragePrice)}</dd>
                </div>

                {coverageAddonOptions.map((option) =>
                  isAddonSelected(selections, option.id) ? (
                    <div key={option.id}>
                      <dt>{option.label}</dt>
                      <dd>{formatCurrency(option.price)}</dd>
                    </div>
                  ) : null,
                )}

                {selections.albumEnabled && amounts.albumPrice > 0 && (
                  <div>
                    <dt>
                      {`${selectedAlbum?.label ?? 'الألبوم'} — ${formatPageCount(selections.albumPageCount)}`}
                    </dt>
                    <dd>{formatCurrency(amounts.albumPrice)}</dd>
                  </div>
                )}

                {selections.albumEnabled && amounts.albumBoxPrice > 0 && (
                  <div>
                    <dt>ترقية صندوق الألبوم إلى VIP</dt>
                    <dd>{formatCurrency(amounts.albumBoxPrice)}</dd>
                  </div>
                )}

                {amounts.individualPrintsSubtotal > 0 && (
                  <div>
                    <dt>المطبوعات الفردية</dt>
                    <dd>{formatCurrency(amounts.individualPrintsSubtotal)}</dd>
                  </div>
                )}

                {amounts.magazineSubtotal > 0 && (
                  <div>
                    <dt>المجلات</dt>
                    <dd>{formatCurrency(amounts.magazineSubtotal)}</dd>
                  </div>
                )}

                {amounts.woodenEnlargementSubtotal > 0 && (
                  <div>
                    <dt>المكبّرات الخشبية</dt>
                    <dd>
                      {formatCurrency(amounts.woodenEnlargementSubtotal)}
                    </dd>
                  </div>
                )}
              </dl>

              <div
                className="configurator__total"
                aria-live="polite"
                aria-atomic="true"
              >
                <span>الإجمالي</span>
                <output>{formattedTotal}</output>
              </div>

              <p className="configurator__disclaimer">
                السعر الظاهر تقديري، وتُعتمد التفاصيل النهائية بعد مراجعة طلب
                الحجز.
              </p>

              <button
                className="btn btn--primary btn--lg configurator__cta"
                ref={continueButtonRef}
                type="submit"
              >
                التالي
              </button>

              <div
                className="configurator__message-region"
                aria-live="polite"
                aria-atomic="true"
              >
                {formStatus && (
                  <StatusMessage status={formStatus} detail={statusDetail} />
                )}
              </div>
            </aside>
          </div>
        )}

        {showReview && profile && selectedDate && (
          <section
            className="configurator__review"
            aria-labelledby="booking-review-title"
          >
            <header className="configurator__review-header">
              <p className="eyebrow configurator__eyebrow">مراجعة طلب الحجز</p>
              <h3
                className="configurator__heading"
                id="booking-review-title"
                ref={reviewHeadingRef}
                tabIndex={-1}
              >
                قبل إرسال طلبكِ
              </h3>
              <p className="notice notice--info configurator__review-notice">
                <Icon name="info" className="notice__icon" />
                <span>
                  لم يتم إرسال طلب الحجز بعد. راجعي التفاصيل، فإرسال الطلب لا
                  يعني تأكيد التاريخ.
                </span>
              </p>
            </header>

            <div className="configurator__review-grid">
              <section
                className="configurator__review-card"
                aria-labelledby="customer-details-title"
              >
                <h4
                  className="configurator__subheading"
                  id="customer-details-title"
                >
                  بياناتكِ
                </h4>
                <dl className="configurator__review-list">
                  <div>
                    <dt>الاسم</dt>
                    <dd>{`${profile.firstName} ${profile.lastName}`}</dd>
                  </div>
                  <div>
                    <dt>البريد الإلكتروني</dt>
                    <dd dir="ltr">{profile.email}</dd>
                  </div>
                  <div>
                    <dt>رقم الجوال</dt>
                    <dd dir="ltr">{profile.phone}</dd>
                  </div>
                </dl>
              </section>

              <section
                className="configurator__review-card"
                aria-labelledby="booking-details-title"
              >
                <h4
                  className="configurator__subheading"
                  id="booking-details-title"
                >
                  تفاصيل التغطية
                </h4>
                <dl className="configurator__review-list">
                  <div>
                    <dt>تاريخ المناسبة</dt>
                    <dd>{formatBookingDate(selectedDate)}</dd>
                  </div>
                  <div>
                    <dt>الباقة المختارة</dt>
                    <dd>{selectedCoverage?.label ?? 'التغطية المختارة'}</dd>
                  </div>
                  {selections.albumEnabled && (
                    <div>
                      <dt>الألبوم</dt>
                      <dd className="configurator__review-details">
                        <span>{selectedAlbum?.label ?? 'الألبوم الرئيسي'}</span>
                        <span>
                          {`${numberFormatter.format(selections.photoCount)} صورة، ${formatPageCount(selections.albumPageCount)}`}
                        </span>
                        <span>
                          {`${selectedAlbumBox?.label ?? 'الصندوق العادي'}، ويشمل ألبوم Mini`}
                        </span>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>الإضافات</dt>
                    <dd>
                      {reviewExtras.length > 0 ? (
                        <ul className="configurator__review-extras">
                          {reviewExtras.map((extra) => (
                            <li key={extra}>{extra}</li>
                          ))}
                        </ul>
                      ) : (
                        'لا توجد إضافات'
                      )}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>

            {selectedDateStatus === 'pending' && (
              <p className="notice notice--warning configurator__review-warning">
                <Icon name="clock" className="notice__icon" />
                <span>
                  يوجد طلب حجز سابق لهذا التاريخ ولم يتم تأكيده بعد. يمكنكِ
                  متابعة طلبكِ، وسيتم تأكيد التوفر بعد المراجعة.
                </span>
              </p>
            )}

            <div className="configurator__review-total">
              <span>الإجمالي التقديري الحالي</span>
              <strong>{formattedTotal}</strong>
            </div>

            <div
              className="configurator__message-region"
              aria-live="polite"
              aria-atomic="true"
            >
              {formStatus && (
                <StatusMessage status={formStatus} detail={statusDetail} />
              )}
            </div>

            <div className="configurator__review-actions">
              <button
                className="btn btn--primary btn--lg configurator__review-submit"
                type="button"
                onClick={() => {
                  void handleBookingSubmission()
                }}
                aria-disabled={isSubmittingBooking}
              >
                {isSubmittingBooking ? 'جارٍ إرسال الطلب…' : 'إرسال الطلب'}
              </button>
              <button
                className="btn btn--secondary"
                type="button"
                onClick={handleEditBooking}
                disabled={isSubmittingBooking}
              >
                العودة وتعديل الاختيارات
              </button>
              <button
                className="btn btn--ghost configurator__review-sign-out"
                type="button"
                onClick={() => {
                  void handleSignOut()
                }}
                disabled={isSigningOut || isSubmittingBooking}
              >
                {isSigningOut ? 'جارٍ تسجيل الخروج…' : 'تسجيل الخروج'}
              </button>
            </div>
          </section>
        )}

        {showSuccess && submittedBooking && (
          <section
            className="configurator__success"
            aria-labelledby="booking-success-title"
          >
            <header className="configurator__success-header">
              <p className="eyebrow configurator__eyebrow">طلب حجز جديد</p>
              <h3
                className="configurator__heading"
                id="booking-success-title"
                ref={successHeadingRef}
                tabIndex={-1}
              >
                <Icon name="check" className="configurator__heading-icon" />
                تم استلام طلبكِ
              </h3>
              <p className="configurator__success-notice">
                تم استلام طلبكِ بنجاح، وهذا لا يعني تأكيد الحجز بعد. سنراجع
                الطلب ونتواصل معكِ عبر واتساب.
              </p>
            </header>

            <dl className="configurator__success-details">
              <div>
                <dt>رقم الطلب</dt>
                <dd dir="ltr" className="configurator__reference">
                  {submittedBooking.booking.id}
                </dd>
              </div>
              <div>
                <dt>تاريخ المناسبة</dt>
                <dd>
                  {formatBookingDate(submittedBooking.booking.eventDate)}
                </dd>
              </div>
              <div>
                <dt>الباقة</dt>
                <dd>{submittedBooking.packageName}</dd>
              </div>
              <div>
                <dt>السعر التقديري</dt>
                <dd>
                  {formatCurrency(
                    submittedBooking.booking.estimatedTotal,
                  )}
                </dd>
              </div>
              <div>
                <dt>حالة الطلب</dt>
                <dd>
                  <span className="badge badge--info">
                    <Icon name="clock" className="badge__icon" />
                    بانتظار المراجعة
                  </span>
                </dd>
              </div>
            </dl>

            <ul className="configurator__success-explanation">
              <li>
                سيظهر هذا التاريخ في التقويم بحالة «يوجد طلب سابق» حتى نراجع
                طلبكِ.
              </li>
              <li>يتم تأكيد الموعد بعد مراجعة الطلب.</li>
              <li>
                لا تُرسل خطوات إكمال الحجز وتعليمات العربون إلا بعد قبول الطلب.
              </li>
            </ul>

            <div className="configurator__success-actions">
              <a
                className="btn btn--whatsapp btn--lg"
                href={createWhatsAppRequestUrl(
                  submittedBooking.customerName,
                  submittedBooking.booking.id,
                  submittedBooking.booking.eventDate,
                )}
                target="_blank"
                rel="noopener noreferrer"
              >
                إرسال رقم الطلب عبر واتساب
                <span className="visually-hidden"> {NEW_TAB_HINT}</span>
              </a>
              <button
                className="btn btn--secondary"
                type="button"
                onClick={handleStartAnotherBooking}
              >
                بدء طلب حجز جديد
              </button>
            </div>
          </section>
        )}
      </form>

      {showAuthDialog && (
        <AuthDialog
          openerRef={continueButtonRef}
          completionFocusRef={reviewHeadingRef}
          onRequestClose={handleCloseAuthDialog}
        />
      )}
    </div>
  )
}
