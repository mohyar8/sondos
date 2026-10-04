import ResponsiveImage from '../../components/ResponsiveImage'
import {
  homeFeatured,
  siteImages,
  type SiteImageRatio,
} from '../../data/site-images'
import AppLink from '../../layout/AppLink'
import type { NavigationHandler } from '../../layout/navigation'

interface FeaturedWorkSectionProps {
  onNavigate: NavigationHandler
}

interface TileLayout {
  /** Keeps the photo's native ratio (no separate crops needed). */
  readonly modifier: string
  /** The width the tile is actually shown at, per breakpoint. */
  readonly sizes: string
}

/**
 * Phones: a swipe row of equal-height tiles (the landscape ones capped at 85%
 * of the screen). From 48rem the three tiles share one row, each growing in
 * proportion to its ratio (16:9 ≈ 44%, 3:2 ≈ 37%, 4:5 ≈ 20% of the row).
 */
const tileLayouts: Record<SiteImageRatio, TileLayout> = {
  '16:9': {
    modifier: 'home-featured__item--wide',
    sizes: '(min-width: 80rem) 32rem, (min-width: 48rem) 42vw, 85vw',
  },
  '3:2': {
    modifier: 'home-featured__item--landscape',
    sizes: '(min-width: 80rem) 27rem, (min-width: 48rem) 36vw, 85vw',
  },
  '4:5': {
    modifier: 'home-featured__item--portrait',
    sizes: '(min-width: 80rem) 15rem, (min-width: 48rem) 19vw, 50vw',
  },
}

/**
 * Featured work (design-system §5.2 item 3): three photos from the portfolio
 * in a strip. On phones it becomes a horizontal scroll-snap row; in RTL the
 * next photo sits to the left, in reading order.
 */
export default function FeaturedWorkSection({
  onNavigate,
}: FeaturedWorkSectionProps) {
  return (
    <section
      className="home-featured section"
      aria-labelledby="home-featured-title"
    >
      <div className="container">
        <header className="section-heading reveal">
          <p className="eyebrow">معرض الأعمال</p>
          <h2 id="home-featured-title">لقطات مختارة من أعمالنا</h2>
          <p>
            تفاصيل من أيام وثّقناها بعناية، وجميع الصور تُنشر بموافقة العروس.
          </p>
        </header>

        {/* Focusable so keyboard users can scroll the row on small screens. */}
        <ul
          className="home-featured__list reveal"
          role="list"
          aria-label="لقطات مختارة"
          tabIndex={0}
        >
          {homeFeatured.map((imageId) => {
            const image = siteImages[imageId]
            const layout = tileLayouts[image.ratio]

            return (
              <li
                className={`home-featured__item ${layout.modifier}`}
                key={image.id}
                style={{ backgroundColor: image.placeholder }}
              >
                <ResponsiveImage
                  image={image}
                  sizes={layout.sizes}
                  className="home-featured__image"
                />
              </li>
            )
          })}
        </ul>

        <AppLink
          className="text-link home-featured__more"
          href="/portfolio"
          preloadPath="/portfolio"
          onNavigate={onNavigate}
        >
          شاهدي جميع الأعمال
        </AppLink>
      </div>
    </section>
  )
}
