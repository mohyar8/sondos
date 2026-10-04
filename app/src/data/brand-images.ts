/**
 * Generated brand-mark assets — see scripts/make-brand-assets.mjs.
 * Paths are root-relative into the Vite `public/` dir (public/images/brand/**).
 */

export interface BrandImageVariant {
  readonly webp: string
  readonly png: string
  readonly width: number
  readonly height: number
}

export interface BrandLogo {
  readonly alt: string
  readonly height112: BrandImageVariant
  readonly height224: BrandImageVariant
}

export const brandLogo = {
  alt: 'شعار المصورة سندس يار',
  height112: {
    webp: '/images/brand/logo-ink-112.webp',
    png: '/images/brand/logo-ink-112.png',
    width: 148,
    height: 112,
  },
  height224: {
    webp: '/images/brand/logo-ink-224.webp',
    png: '/images/brand/logo-ink-224.png',
    width: 296,
    height: 224,
  },
} as const satisfies BrandLogo

/**
 * The logo for the cinematic intro. `width` x `height` is its box (the SVG
 * viewBox the intro draws it in); the two WebP rasters are exactly 2x and 3x
 * that box. No PNG: every browser that runs the intro decodes WebP.
 */
export interface BrandIntroLogo {
  readonly alt: string
  readonly width: number
  readonly height: number
  /** 592x448 */
  readonly webp448: string
  /** 888x672 */
  readonly webp672: string
}

export const brandIntroLogo = {
  alt: brandLogo.alt,
  width: 296,
  height: 224,
  webp448: '/images/brand/logo-ink-448.webp',
  webp672: '/images/brand/logo-ink-672.webp',
} as const satisfies BrandIntroLogo

export interface BrandIcon {
  readonly src: string
  readonly width: number
  readonly height: number
}

export interface BrandIcons {
  readonly favicon32: BrandIcon
  readonly appleTouch: BrandIcon
  readonly icon512: BrandIcon
}

export const brandIcons = {
  favicon32: {
    src: '/images/brand/favicon-32.png',
    width: 32,
    height: 32,
  },
  appleTouch: {
    src: '/images/brand/apple-touch-icon.png',
    width: 180,
    height: 180,
  },
  icon512: {
    src: '/images/brand/icon-512.png',
    width: 512,
    height: 512,
  },
} as const satisfies BrandIcons
