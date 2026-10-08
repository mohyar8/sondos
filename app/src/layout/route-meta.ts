import type { AppPath } from './navigation'

interface RouteMeta {
  readonly title: string
  readonly description: string
  /** Private views: a managed robots tag with PRIVATE_ROBOTS while active. */
  readonly noindex: boolean
}

/**
 * Per-route <head> values. The router renders client-side only, so Google
 * (which runs JavaScript) reads these; social-share bots only ever see the
 * static index.html head (04-seo.md §4, §6.1). Descriptions use only facts
 * already on the site. Titles follow the owner's handoff except /packages:
 * «الخدمات والباقات», the owner's decision D13 (2026-09-24), which replaces the
 * handoff's «الخدمات والبكجات» in both the nav and the title; Home also names
 * the service and city, as the static index.html og:title already did.
 */
const routeMeta: Record<AppPath, RouteMeta> = {
  '/': {
    title: 'المصورة سندس يار | مصورة عرائس في المدينة المنورة',
    description:
      'المصورة سندس يار، مصورة عرائس محترفة في المدينة المنورة، توثّق تفاصيل يومكِ بأسلوب هادئ وأنيق.',
    noindex: false,
  },
  '/portfolio': {
    title: 'أعمالنا | المصورة سندس يار',
    description:
      'مختارات من أعمال المصورة سندس يار في تصوير العرائس بالمدينة المنورة: تفاصيل الفستان والخواتم والباقات، وجميع الصور تُنشر بموافقة العروس.',
    noindex: false,
  },
  '/packages': {
    title: 'الخدمات والباقات | المصورة سندس يار',
    description:
      'باقات تصوير العرائس مع المصورة سندس يار في المدينة المنورة: اختاري التغطية والألبوم والمطبوعات، وشاهدي السعر التقديري، ثم أرسلي طلب الحجز.',
    noindex: false,
  },
  '/my-bookings': {
    title: 'حجوزاتي | المصورة سندس يار',
    description: 'صفحة خاصة لمتابعة طلبات الحجز لدى المصورة سندس يار.',
    noindex: true,
  },
  '/admin': {
    title: 'لوحة الإدارة | المصورة سندس يار',
    description: 'لوحة الإدارة الخاصة بالمصورة سندس يار.',
    noindex: true,
  },
}

/**
 * The production origin (the custom domain on the Worker). Canonical and
 * og:url values are built from it, never from window.location, so a preview
 * host or a workers.dev address never claims to be the canonical page.
 */
export const SITE_ORIGIN = 'https://sndsyar.com'

/**
 * Robots rule for private views (04-seo.md §2, §6.1). Only ever written to
 * this module's own tag, marked with MANAGED_ATTRIBUTE; a robots tag that
 * something else put in <head> (index.html, a later static rule) is never
 * read, changed or removed. Search engines apply the most restrictive of
 * several robots tags, so a separate tag is enough to keep a view out.
 */
const PRIVATE_ROBOTS = 'noindex, nofollow'
const MANAGED_ATTRIBUTE = 'data-route-meta'
const MANAGED_ROBOTS_SELECTOR = `meta[name="robots"][${MANAGED_ATTRIBUTE}]`
const MANAGED_CANONICAL_SELECTOR = `link[rel="canonical"][${MANAGED_ATTRIBUTE}]`

/**
 * Sets `content` on the first `<meta {attribute}="{key}">` in <head>, creating
 * it when missing. index.html holds the static defaults; this keeps the same
 * tags in step with the active route.
 */
function updateMeta(
  attribute: 'name' | 'property',
  key: string,
  content: string,
): void {
  let tag = document.head.querySelector<HTMLMetaElement>(
    `meta[${attribute}="${key}"]`,
  )

  if (tag === null) {
    tag = document.createElement('meta')
    tag.setAttribute(attribute, key)
    document.head.append(tag)
  }

  tag.content = content
}

/**
 * Public routes get a canonical link to their production URL; private ones
 * get none (they are noindex). Only this module's own tag, marked with
 * MANAGED_ATTRIBUTE, is ever changed or removed.
 */
function updateManagedCanonical(href: string | null): void {
  const managedTag = document.head.querySelector<HTMLLinkElement>(
    MANAGED_CANONICAL_SELECTOR,
  )

  if (href === null) {
    managedTag?.remove()
    return
  }

  if (managedTag !== null) {
    managedTag.href = href
    return
  }

  const tag = document.createElement('link')
  tag.rel = 'canonical'
  tag.href = href
  tag.setAttribute(MANAGED_ATTRIBUTE, '')
  document.head.append(tag)
}

function updateManagedRobots(noindex: boolean): void {
  const managedTag = document.head.querySelector<HTMLMetaElement>(
    MANAGED_ROBOTS_SELECTOR,
  )

  if (!noindex) {
    managedTag?.remove()
    return
  }

  if (managedTag !== null) {
    managedTag.content = PRIVATE_ROBOTS
    return
  }

  const tag = document.createElement('meta')
  tag.name = 'robots'
  tag.content = PRIVATE_ROBOTS
  tag.setAttribute(MANAGED_ATTRIBUTE, '')
  document.head.append(tag)
}

/** The production URL of a public route, e.g. https://sndsyar.com/portfolio. */
export function canonicalUrlFor(path: AppPath): string {
  return path === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path}`
}

/**
 * Applies the active route's title, description, canonical link, Open Graph
 * and Twitter text, and robots rule.
 */
export function applyRouteMeta(path: AppPath): void {
  const meta = routeMeta[path]
  const url = meta.noindex ? null : canonicalUrlFor(path)

  document.title = meta.title
  updateMeta('name', 'description', meta.description)
  updateMeta('property', 'og:title', meta.title)
  updateMeta('property', 'og:description', meta.description)
  updateMeta('property', 'og:url', url ?? canonicalUrlFor('/'))
  updateMeta('name', 'twitter:title', meta.title)
  updateMeta('name', 'twitter:description', meta.description)
  updateManagedCanonical(url)
  updateManagedRobots(meta.noindex)
}
