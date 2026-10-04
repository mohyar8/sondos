/**
 * Verified social profiles (handle @sndsyar on both platforms — see
 * runs/redo-v2/04-seo.md §8 and 08-copy-ar.md §0).
 */

export type SocialNetwork = 'instagram' | 'tiktok'

export interface SocialLink {
  readonly network: SocialNetwork
  /** Platform name as shown in Arabic. */
  readonly label: string
  /** Latin handle — render inside <bdi dir="ltr"> within Arabic text. */
  readonly handle: string
  readonly href: string
}

export const socialLinks: readonly SocialLink[] = [
  {
    network: 'instagram',
    label: 'إنستغرام',
    handle: '@sndsyar',
    href: 'https://www.instagram.com/sndsyar/',
  },
  {
    network: 'tiktok',
    label: 'تيك توك',
    handle: '@sndsyar',
    href: 'https://www.tiktok.com/@sndsyar',
  },
]

/**
 * Appended (visually hidden) to every link that opens a new tab. Import this
 * constant instead of retyping the hint.
 */
export const NEW_TAB_HINT = '(يُفتح في نافذة جديدة)'
