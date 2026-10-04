import {
  albumBoxOptions,
  albumSizes,
  calculateMagazineUnitPrice,
  coverageOptions,
  getValidAlbumPageCounts,
  magazinePricing,
  photoCountOptions,
  printSizeOptions,
  woodenEnlargementPricing,
  type AlbumBoxId,
  type AlbumPageCount,
  type AlbumSizeId,
  type CoverageId,
  type MagazinePageCount,
  type PhotoCount,
  type PrintSizeId,
} from '../src/data/packages.js'

export type BookingPrintQuantities = Record<PrintSizeId, number>

export interface BookingSelectionInput {
  coverageId: CoverageId
  albumEnabled: boolean
  albumSizeId: AlbumSizeId
  photoCount: PhotoCount
  albumPageCount: AlbumPageCount
  albumBoxId: AlbumBoxId
  printQuantities: BookingPrintQuantities
  magazineQuantity: number
  magazinePageCount: MagazinePageCount
  woodenEnlargementQuantity: number
}

export type NormalizedBookingSelection = BookingSelectionInput

export interface SnapshotPackage {
  id: CoverageId
  name: string
  basePrice: number
}

export interface SnapshotCoverage {
  id: CoverageId
  label: string
  durationHours: number
  price: number
}

export interface SnapshotNoCostOptions {
  photoCount: {
    value: PhotoCount
    label: string
  } | null
  miniAlbumIncluded: boolean
  includedAlbumBox: {
    id: 'normal'
    label: string
  } | null
}

export interface SnapshotAlbum {
  id: AlbumSizeId
  name: string
  dimensions: string
  photoCount: PhotoCount
  pageCount: AlbumPageCount
  price: number
  includesMiniAlbum: true
  box: {
    id: AlbumBoxId
    name: string
    price: number
  }
}

export interface SnapshotIndividualPrintExtra {
  kind: 'individual_print'
  id: PrintSizeId
  name: string
  quantity: number
  unitPrice: number
  subtotal: number
}

export interface SnapshotMagazineExtra {
  kind: 'magazine'
  id: 'magazine'
  name: string
  quantity: number
  pageCount: MagazinePageCount
  basePrice: number
  additionalPagePrice: number
  unitPrice: number
  subtotal: number
}

export interface SnapshotWoodenEnlargementExtra {
  kind: 'wooden_enlargement'
  id: typeof woodenEnlargementPricing.id
  name: string
  dimensions: string
  quantity: number
  unitPrice: number
  subtotal: number
}

export type BookingSnapshotExtra =
  | SnapshotIndividualPrintExtra
  | SnapshotMagazineExtra
  | SnapshotWoodenEnlargementExtra

export interface BookingCalculationBreakdown {
  coverage: number
  album: number
  albumBoxUpgrade: number
  individualPrints: number
  magazines: number
  woodenEnlargements: number
}

export interface BookingPackageSnapshot {
  schemaVersion: 1
  package: SnapshotPackage
  coverage: SnapshotCoverage
  noCostOptions: SnapshotNoCostOptions
  album: SnapshotAlbum | null
  extras: BookingSnapshotExtra[]
  calculation: BookingCalculationBreakdown
  estimatedTotal: number
}

export type BookingSelectionValidationErrorCode =
  | 'INVALID_SHAPE'
  | 'UNKNOWN_PROPERTY'
  | 'UNSUPPORTED_OPTION'
  | 'INVALID_QUANTITY'
  | 'INVALID_ALBUM_CONFIGURATION'
  | 'TOTAL_OUT_OF_RANGE'

export interface BookingSelectionValidationError {
  code: BookingSelectionValidationErrorCode
  message: string
}

export type BookingSelectionValidationResult =
  | {
      ok: true
      selection: NormalizedBookingSelection
      snapshot: BookingPackageSnapshot
      estimatedTotal: number
    }
  | {
      ok: false
      error: BookingSelectionValidationError
    }

const selectionKeys = new Set([
  'coverageId',
  'albumEnabled',
  'albumSizeId',
  'photoCount',
  'albumPageCount',
  'albumBoxId',
  'printQuantities',
  'magazineQuantity',
  'magazinePageCount',
  'woodenEnlargementQuantity',
])

const printQuantityKeys: ReadonlySet<string> = new Set(['a6', 'a5', 'a4'])
const MAXIMUM_SNAPSHOT_TEXT_LENGTH = 160
const MAXIMUM_EXTRAS = 5

/**
 * Most units of one item a single booking request may order (audit SEC-09).
 * The one table for the Worker's validator and the SPA configurator's input
 * limits; larger orders are arranged with the studio directly. Keys are the
 * catalog ids of src/data/packages.ts: each print size id, 'magazine', the
 * wooden enlargement id, and 'album' (a booking has at most one album, chosen
 * with `albumEnabled`).
 */
const quantityCeilings: ReadonlyMap<string, number> = new Map([
  ...printSizeOptions.map((option): [string, number] => [option.id, 200]),
  ['magazine', 20],
  [woodenEnlargementPricing.id, 10],
  ['album', 1],
])

/**
 * The per-item quantity ceiling for a catalog id. 0 for an id the table does
 * not know, so an unknown item can never be ordered.
 */
export function maxQuantityFor(itemId: string): number {
  return quantityCeilings.get(itemId) ?? 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function hasEveryKey(
  value: Record<string, unknown>,
  requiredKeys: ReadonlySet<string>,
): boolean {
  return Array.from(requiredKeys).every((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  )
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: ReadonlySet<string>,
): boolean {
  return hasOnlyKeys(value, expectedKeys) && hasEveryKey(value, expectedKeys)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0
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

function isPrintQuantities(
  value: unknown,
): value is BookingPrintQuantities {
  if (!isRecord(value) || !hasExactKeys(value, printQuantityKeys)) {
    return false
  }

  return printSizeOptions.every((option) =>
    isNonNegativeSafeInteger(value[option.id]),
  )
}

function validationFailure(
  code: BookingSelectionValidationErrorCode,
  message: string,
): BookingSelectionValidationResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  }
}

function areSafeAmounts(values: readonly number[]): boolean {
  return values.every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  )
}

function isSnapshotText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAXIMUM_SNAPSHOT_TEXT_LENGTH
  )
}

function isSnapshotAmount(value: unknown): value is number {
  return isNonNegativeSafeInteger(value)
}

function isSnapshotPackage(value: unknown): value is SnapshotPackage {
  return (
    isRecord(value) &&
    isCoverageId(value.id) &&
    isSnapshotText(value.name) &&
    isSnapshotAmount(value.basePrice)
  )
}

function isSnapshotCoverage(value: unknown): value is SnapshotCoverage {
  return (
    isRecord(value) &&
    isCoverageId(value.id) &&
    isSnapshotText(value.label) &&
    isPositiveSafeInteger(value.durationHours) &&
    isSnapshotAmount(value.price)
  )
}

function isSnapshotNoCostOptions(
  value: unknown,
): value is SnapshotNoCostOptions {
  if (!isRecord(value)) {
    return false
  }

  const hasValidPhotoCount =
    value.photoCount === null ||
    (isRecord(value.photoCount) &&
      isPhotoCount(value.photoCount.value) &&
      isSnapshotText(value.photoCount.label))

  const hasValidIncludedBox =
    value.includedAlbumBox === null ||
    (isRecord(value.includedAlbumBox) &&
      value.includedAlbumBox.id === 'normal' &&
      isSnapshotText(value.includedAlbumBox.label))

  return (
    hasValidPhotoCount &&
    typeof value.miniAlbumIncluded === 'boolean' &&
    hasValidIncludedBox
  )
}

function isSnapshotAlbum(value: unknown): value is SnapshotAlbum {
  if (!isRecord(value) || !isRecord(value.box)) {
    return false
  }

  return (
    isAlbumSizeId(value.id) &&
    isSnapshotText(value.name) &&
    isSnapshotText(value.dimensions) &&
    isPhotoCount(value.photoCount) &&
    isAlbumPageCount(value.pageCount) &&
    isSnapshotAmount(value.price) &&
    value.includesMiniAlbum === true &&
    isAlbumBoxId(value.box.id) &&
    isSnapshotText(value.box.name) &&
    isSnapshotAmount(value.box.price)
  )
}

function isSnapshotIndividualPrintExtra(
  value: Record<string, unknown>,
): value is Record<string, unknown> & SnapshotIndividualPrintExtra {
  return (
    value.kind === 'individual_print' &&
    typeof value.id === 'string' &&
    printQuantityKeys.has(value.id) &&
    isSnapshotText(value.name) &&
    isPositiveSafeInteger(value.quantity) &&
    isSnapshotAmount(value.unitPrice) &&
    isSnapshotAmount(value.subtotal) &&
    value.quantity * value.unitPrice === value.subtotal
  )
}

function isSnapshotMagazineExtra(
  value: Record<string, unknown>,
): value is Record<string, unknown> & SnapshotMagazineExtra {
  return (
    value.kind === 'magazine' &&
    value.id === 'magazine' &&
    isSnapshotText(value.name) &&
    isPositiveSafeInteger(value.quantity) &&
    isMagazinePageCount(value.pageCount) &&
    isSnapshotAmount(value.basePrice) &&
    isSnapshotAmount(value.additionalPagePrice) &&
    isSnapshotAmount(value.unitPrice) &&
    isSnapshotAmount(value.subtotal) &&
    value.quantity * value.unitPrice === value.subtotal
  )
}

function isSnapshotWoodenEnlargementExtra(
  value: Record<string, unknown>,
): value is Record<string, unknown> & SnapshotWoodenEnlargementExtra {
  return (
    value.kind === 'wooden_enlargement' &&
    value.id === woodenEnlargementPricing.id &&
    isSnapshotText(value.name) &&
    isSnapshotText(value.dimensions) &&
    isPositiveSafeInteger(value.quantity) &&
    isSnapshotAmount(value.unitPrice) &&
    isSnapshotAmount(value.subtotal) &&
    value.quantity * value.unitPrice === value.subtotal
  )
}

function isSnapshotExtra(value: unknown): value is BookingSnapshotExtra {
  if (!isRecord(value)) {
    return false
  }

  return (
    isSnapshotIndividualPrintExtra(value) ||
    isSnapshotMagazineExtra(value) ||
    isSnapshotWoodenEnlargementExtra(value)
  )
}

function isCalculationBreakdown(
  value: unknown,
): value is BookingCalculationBreakdown {
  return (
    isRecord(value) &&
    isSnapshotAmount(value.coverage) &&
    isSnapshotAmount(value.album) &&
    isSnapshotAmount(value.albumBoxUpgrade) &&
    isSnapshotAmount(value.individualPrints) &&
    isSnapshotAmount(value.magazines) &&
    isSnapshotAmount(value.woodenEnlargements)
  )
}

export function isBookingPackageSnapshot(
  value: unknown,
): value is BookingPackageSnapshot {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isSnapshotPackage(value.package) ||
    !isSnapshotCoverage(value.coverage) ||
    !isSnapshotNoCostOptions(value.noCostOptions) ||
    (value.album !== null && !isSnapshotAlbum(value.album)) ||
    !Array.isArray(value.extras) ||
    value.extras.length > MAXIMUM_EXTRAS ||
    !value.extras.every(isSnapshotExtra) ||
    !isCalculationBreakdown(value.calculation) ||
    !isSnapshotAmount(value.estimatedTotal)
  ) {
    return false
  }

  const calculatedTotal =
    value.calculation.coverage +
    value.calculation.album +
    value.calculation.albumBoxUpgrade +
    value.calculation.individualPrints +
    value.calculation.magazines +
    value.calculation.woodenEnlargements

  return (
    Number.isSafeInteger(calculatedTotal) &&
    calculatedTotal === value.estimatedTotal
  )
}

export function validateBookingSelection(
  value: unknown,
): BookingSelectionValidationResult {
  if (!isRecord(value)) {
    return validationFailure(
      'INVALID_SHAPE',
      'بيانات اختيارات الحجز غير صحيحة.',
    )
  }

  if (!hasExactKeys(value, selectionKeys)) {
    return validationFailure(
      'UNKNOWN_PROPERTY',
      'تحتوي اختيارات الحجز على حقول غير مسموحة أو ناقصة.',
    )
  }

  if (
    !isCoverageId(value.coverageId) ||
    typeof value.albumEnabled !== 'boolean' ||
    !isAlbumSizeId(value.albumSizeId) ||
    !isPhotoCount(value.photoCount) ||
    !isAlbumPageCount(value.albumPageCount) ||
    !isAlbumBoxId(value.albumBoxId) ||
    !isMagazinePageCount(value.magazinePageCount)
  ) {
    return validationFailure(
      'UNSUPPORTED_OPTION',
      'تحتوي اختيارات الحجز على خيار غير متاح.',
    )
  }

  if (
    !isPrintQuantities(value.printQuantities) ||
    !isNonNegativeSafeInteger(value.magazineQuantity) ||
    !isNonNegativeSafeInteger(value.woodenEnlargementQuantity)
  ) {
    return validationFailure(
      'INVALID_QUANTITY',
      'يجب أن تكون جميع الكميات أعدادًا صحيحة وغير سالبة.',
    )
  }

  const printQuantities = value.printQuantities
  const exceedsCeiling =
    printSizeOptions.some(
      (option) => printQuantities[option.id] > maxQuantityFor(option.id),
    ) ||
    value.magazineQuantity > maxQuantityFor('magazine') ||
    value.woodenEnlargementQuantity >
      maxQuantityFor(woodenEnlargementPricing.id)

  if (exceedsCeiling) {
    return validationFailure(
      'INVALID_QUANTITY',
      'تتجاوز إحدى الكميات الحد المسموح به في الطلب الواحد.',
    )
  }

  const validAlbumPageCounts = getValidAlbumPageCounts(value.photoCount)

  if (!validAlbumPageCounts.includes(value.albumPageCount)) {
    return validationFailure(
      'INVALID_ALBUM_CONFIGURATION',
      'عدد صفحات الألبوم لا يناسب عدد الصور المختار.',
    )
  }

  if (!value.albumEnabled && value.albumBoxId !== 'normal') {
    return validationFailure(
      'INVALID_ALBUM_CONFIGURATION',
      'لا يمكن اختيار ترقية بوكس دون إضافة ألبوم.',
    )
  }

  const coverage = coverageOptions.find(
    (option) => option.id === value.coverageId,
  )
  const albumSize = albumSizes.find(
    (option) => option.id === value.albumSizeId,
  )
  const photoCountOption = photoCountOptions.find(
    (option) => option.value === value.photoCount,
  )
  const albumBox = albumBoxOptions.find(
    (option) => option.id === value.albumBoxId,
  )

  if (!coverage || !albumSize || !photoCountOption || !albumBox) {
    return validationFailure(
      'UNSUPPORTED_OPTION',
      'تعذر مطابقة أحد اختيارات الحجز مع الكتالوج الحالي.',
    )
  }

  const selection: NormalizedBookingSelection = {
    coverageId: coverage.id,
    albumEnabled: value.albumEnabled,
    albumSizeId: albumSize.id,
    photoCount: photoCountOption.value,
    albumPageCount: value.albumPageCount,
    albumBoxId: albumBox.id,
    printQuantities: {
      a6: value.printQuantities.a6,
      a5: value.printQuantities.a5,
      a4: value.printQuantities.a4,
    },
    magazineQuantity: value.magazineQuantity,
    magazinePageCount: value.magazinePageCount,
    woodenEnlargementQuantity: value.woodenEnlargementQuantity,
  }

  const coveragePrice = coverage.price
  const albumPrice = selection.albumEnabled
    ? albumSize.pagePrices[selection.albumPageCount]
    : 0
  const albumBoxPrice = selection.albumEnabled ? albumBox.price : 0

  const individualPrintsSubtotal = printSizeOptions.reduce(
    (subtotal, option) =>
      subtotal +
      selection.printQuantities[option.id] * option.unitPrice,
    0,
  )

  const magazineUnitPrice = calculateMagazineUnitPrice(
    selection.magazinePageCount,
  )
  const magazineSubtotal =
    selection.magazineQuantity * magazineUnitPrice
  const woodenEnlargementSubtotal =
    selection.woodenEnlargementQuantity *
    woodenEnlargementPricing.unitPrice

  const calculatedAmounts = [
    coveragePrice,
    albumPrice,
    albumBoxPrice,
    individualPrintsSubtotal,
    magazineUnitPrice,
    magazineSubtotal,
    woodenEnlargementSubtotal,
  ]

  if (!areSafeAmounts(calculatedAmounts)) {
    return validationFailure(
      'TOTAL_OUT_OF_RANGE',
      'تجاوزت الكميات النطاق المسموح لحساب السعر بأمان.',
    )
  }

  const estimatedTotal =
    coveragePrice +
    albumPrice +
    albumBoxPrice +
    individualPrintsSubtotal +
    magazineSubtotal +
    woodenEnlargementSubtotal

  if (!Number.isSafeInteger(estimatedTotal)) {
    return validationFailure(
      'TOTAL_OUT_OF_RANGE',
      'تعذر حساب السعر التقديري ضمن النطاق الآمن.',
    )
  }

  const extras: BookingSnapshotExtra[] = []

  for (const option of printSizeOptions) {
    const quantity = selection.printQuantities[option.id]

    if (quantity > 0) {
      extras.push({
        kind: 'individual_print',
        id: option.id,
        name: `صور فردية مقاس ${option.label}`,
        quantity,
        unitPrice: option.unitPrice,
        subtotal: quantity * option.unitPrice,
      })
    }
  }

  if (selection.magazineQuantity > 0) {
    extras.push({
      kind: 'magazine',
      id: 'magazine',
      name: magazinePricing.label,
      quantity: selection.magazineQuantity,
      pageCount: selection.magazinePageCount,
      basePrice: magazinePricing.basePrice,
      additionalPagePrice: magazinePricing.additionalPagePrice,
      unitPrice: magazineUnitPrice,
      subtotal: magazineSubtotal,
    })
  }

  if (selection.woodenEnlargementQuantity > 0) {
    extras.push({
      kind: 'wooden_enlargement',
      id: woodenEnlargementPricing.id,
      name: woodenEnlargementPricing.label,
      dimensions: woodenEnlargementPricing.dimensions,
      quantity: selection.woodenEnlargementQuantity,
      unitPrice: woodenEnlargementPricing.unitPrice,
      subtotal: woodenEnlargementSubtotal,
    })
  }

  const snapshot: BookingPackageSnapshot = {
    schemaVersion: 1,
    package: {
      id: coverage.id,
      name: coverage.label,
      basePrice: coverage.price,
    },
    coverage: {
      id: coverage.id,
      label: coverage.label,
      durationHours: coverage.durationHours,
      price: coverage.price,
    },
    noCostOptions: {
      photoCount: selection.albumEnabled
        ? {
            value: photoCountOption.value,
            label: photoCountOption.label,
          }
        : null,
      miniAlbumIncluded: selection.albumEnabled,
      includedAlbumBox:
        selection.albumEnabled && albumBox.id === 'normal'
          ? {
              id: albumBox.id,
              label: albumBox.label,
            }
          : null,
    },
    album: selection.albumEnabled
      ? {
          id: albumSize.id,
          name: albumSize.label,
          dimensions: albumSize.dimensions,
          photoCount: selection.photoCount,
          pageCount: selection.albumPageCount,
          price: albumPrice,
          includesMiniAlbum: true,
          box: {
            id: albumBox.id,
            name: albumBox.label,
            price: albumBoxPrice,
          },
        }
      : null,
    extras,
    calculation: {
      coverage: coveragePrice,
      album: albumPrice,
      albumBoxUpgrade: albumBoxPrice,
      individualPrints: individualPrintsSubtotal,
      magazines: magazineSubtotal,
      woodenEnlargements: woodenEnlargementSubtotal,
    },
    estimatedTotal,
  }

  return {
    ok: true,
    selection,
    snapshot,
    estimatedTotal,
  }
}