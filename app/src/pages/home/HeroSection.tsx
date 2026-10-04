import ResponsiveImage from '../../components/ResponsiveImage'
import { heroImageId, siteImages } from '../../data/site-images'
import AppLink from '../../layout/AppLink'
import {
  BOOKING_REQUEST_HREF,
  type NavigationHandler,
} from '../../layout/navigation'
import DisplayHeading from '../../components/DisplayHeading'

interface HeroSectionProps {
  onNavigate: NavigationHandler
}

const heroImage = siteImages[heroImageId]

/**
 * Widths the hero photo is shown at: the full container on phones and
 * tablets, the wider (1.15fr) column of the two-column hero from 64rem, which
 * stops growing once the container reaches its 75rem maximum.
 * index.html preloads this photo on "/" with the same srcset and sizes:
 * change the hero image or these sizes there too (and the script's CSP hash
 * in public/_headers), or the browser downloads the photo twice.
 */
const HERO_IMAGE_SIZES =
  '(min-width: 80rem) 41rem, (min-width: 64rem) 50vw, calc(100vw - 2rem)'

/**
 * Hero (design-system §5.2, copy 08-copy-ar §1.1). Headline variant B: the
 * copy deck recommends testing it first, as the most distinctive promise
 * built on a verified fact («جميع الصور تُنشر بموافقة العروس»). The photo is
 * the page's largest paint, so it loads eagerly with high fetch priority.
 */
export default function HeroSection({ onNavigate }: HeroSectionProps) {
  return (
    <section className="home-hero" aria-labelledby="home-hero-title">
      <div className="home-hero__layout container">
        <div className="home-hero__content">
          <p className="eyebrow">تصوير عرائس في المدينة المنورة</p>
          <DisplayHeading as="h1" id="home-hero-title" className="home-hero__title" text="يومكِ لكِ وحدكِ، وصوركِ لا تُنشر إلا بإذنكِ" />
          <p className="home-hero__lead">
            نوثّق تفاصيل يومكِ بأسلوب هادئ وأنيق، لتبقى الصور ذكرى صادقة
            تعودين إليها في كل مرة.
          </p>

          <div className="home-hero__actions">
            <AppLink
              className="btn btn--primary btn--lg"
              href="/portfolio"
              preloadPath="/portfolio"
              onNavigate={onNavigate}
            >
              شاهدي الأعمال
            </AppLink>
            <AppLink
              className="btn btn--secondary btn--lg"
              href={BOOKING_REQUEST_HREF}
              preloadPath="/packages"
              onNavigate={onNavigate}
            >
              ابدئي طلب الحجز
            </AppLink>
          </div>
        </div>

        <div
          className="home-hero__media"
          style={{ backgroundColor: heroImage.placeholder }}
        >
          <ResponsiveImage
            image={heroImage}
            sizes={HERO_IMAGE_SIZES}
            className="home-hero__image"
            loading="eager"
            fetchPriority="high"
          />
        </div>
      </div>
    </section>
  )
}
