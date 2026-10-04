export type CoverageId =
  | 'two-hours'
  | 'four-hours'
  | 'six-hours'
  | 'eight-hours'

export interface CoverageOption {
  readonly id: CoverageId
  readonly durationHours: number
  readonly label: string
  readonly price: number
}

export const coverageOptions = [
  {
    id: 'two-hours',
    durationHours: 2,
    label: 'ساعتان',
    price: 1600,
  },
  {
    id: 'four-hours',
    durationHours: 4,
    label: '4 ساعات',
    price: 3200,
  },
  {
    id: 'six-hours',
    durationHours: 6,
    label: '6 ساعات',
    price: 4800,
  },
  {
    id: 'eight-hours',
    durationHours: 8,
    label: '8 ساعات',
    price: 6400,
  },
] as const satisfies readonly CoverageOption[]

export type AlbumPageCount = 10 | 15 | 20
export type AlbumSizeId = 'small' | 'medium' | 'large'

export interface AlbumSizeOption {
  readonly id: AlbumSizeId
  readonly label: string
  readonly dimensions: string
  readonly pagePrices: Readonly<Record<AlbumPageCount, number>>
  readonly includesMiniAlbum: true
}

export const albumSizes = [
  {
    id: 'small',
    label: 'الألبوم الصغير',
    dimensions: '23 × 32 سم',
    pagePrices: {
      10: 450,
      15: 550,
      20: 650,
    },
    includesMiniAlbum: true,
  },
  {
    id: 'medium',
    label: 'الألبوم الوسط',
    dimensions: '30 × 45 سم',
    pagePrices: {
      10: 750,
      15: 800,
      20: 900,
    },
    includesMiniAlbum: true,
  },
  {
    id: 'large',
    label: 'الألبوم الكبير',
    dimensions: '30 × 60 سم',
    pagePrices: {
      10: 850,
      15: 950,
      20: 1050,
    },
    includesMiniAlbum: true,
  },
] as const satisfies readonly AlbumSizeOption[]

export type PhotoCount = 30 | 45 | 60 | 80

export interface PhotoCountOption {
  readonly value: PhotoCount
  readonly label: string
  readonly validPageCounts: readonly AlbumPageCount[]
}

export const photoCountOptions = [
  {
    value: 30,
    label: '30 صورة',
    validPageCounts: [10],
  },
  {
    value: 45,
    label: '45 صورة',
    validPageCounts: [15, 20],
  },
  {
    value: 60,
    label: '60 صورة',
    validPageCounts: [15, 20],
  },
  {
    value: 80,
    label: '80 صورة',
    validPageCounts: [15, 20],
  },
] as const satisfies readonly PhotoCountOption[]

export type PrintSizeId = 'a6' | 'a5' | 'a4'

export interface PrintSizeOption {
  readonly id: PrintSizeId
  readonly label: string
  readonly unitPrice: number
}

export const printSizeOptions = [
  {
    id: 'a6',
    label: 'A6',
    unitPrice: 13,
  },
  {
    id: 'a5',
    label: 'A5',
    unitPrice: 16,
  },
  {
    id: 'a4',
    label: 'A4',
    unitPrice: 20,
  },
] as const satisfies readonly PrintSizeOption[]

export type MagazinePageCount = 1 | 2 | 3 | 4 | 5

export const magazinePricing = {
  label: 'مجلة',
  basePrice: 40,
  additionalPagePrice: 15,
  minimumPageCount: 1,
  maximumPageCount: 5,
} as const

export const woodenEnlargementPricing = {
  id: 'wooden-30x40',
  label: 'مكبّرة خشبية',
  dimensions: '30 × 40 سم',
  unitPrice: 80,
} as const

export type AlbumBoxId = 'normal' | 'vip'

export interface AlbumBoxOption {
  readonly id: AlbumBoxId
  readonly label: string
  readonly description: string
  readonly price: number
}

export const albumBoxOptions = [
  {
    id: 'normal',
    label: 'بوكس الألبوم العادي',
    description: 'مشمول ضمن سعر الألبوم',
    price: 0,
  },
  {
    id: 'vip',
    label: 'ترقية البوكس إلى VIP',
    description: 'إضافة على سعر الألبوم',
    price: 200,
  },
] as const satisfies readonly AlbumBoxOption[]

export function getCoveragePrice(coverageId: CoverageId): number {
  return (
    coverageOptions.find((option) => option.id === coverageId)?.price ?? 0
  )
}

export function getAlbumPrice(
  albumSizeId: AlbumSizeId,
  pageCount: AlbumPageCount,
): number {
  const album = albumSizes.find((option) => option.id === albumSizeId)

  return album?.pagePrices[pageCount] ?? 0
}

export function getValidAlbumPageCounts(
  photoCount: PhotoCount,
): readonly AlbumPageCount[] {
  return (
    photoCountOptions.find((option) => option.value === photoCount)
      ?.validPageCounts ?? []
  )
}

export function getAlbumBoxPrice(albumBoxId: AlbumBoxId): number {
  return (
    albumBoxOptions.find((option) => option.id === albumBoxId)?.price ?? 0
  )
}

export function calculateMagazineUnitPrice(pageCount: number): number {
  if (
    !Number.isInteger(pageCount) ||
    pageCount < magazinePricing.minimumPageCount ||
    pageCount > magazinePricing.maximumPageCount
  ) {
    return 0
  }

  return (
    magazinePricing.basePrice +
    (pageCount - magazinePricing.minimumPageCount) *
      magazinePricing.additionalPagePrice
  )
}