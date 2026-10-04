import { useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import ResponsiveImage from '../components/ResponsiveImage'
import {
  portfolioCategories,
  portfolioOrder,
  siteImages,
  type SiteImage,
  type SiteImageCategory,
  type SiteImageRatio,
} from '../data/site-images'
import { WhatsAppIcon } from '../layout/icons'
import type { NavigationHandler } from '../layout/navigation'
import { NEW_TAB_HINT } from '../layout/social-links'
import { useReveal } from '../layout/useReveal'
import {
  PORTFOLIO_INQUIRY_MESSAGE,
  buildWhatsAppUrl,
} from '../lib/whatsapp'
import Lightbox from './portfolio/Lightbox'
import ContactSection from './sections/ContactSection'
import './PortfolioPage.css'
import DisplayHeading from '../components/DisplayHeading'
import {
  canUseViewTransition,
  ignoreSkippedTransition,
  isCinematicDesign,
} from '../design/runtime'

const PORTFOLIO_INQUIRY_URL = buildWhatsAppUrl(PORTFOLIO_INQUIRY_MESSAGE)

/** Every portfolio photo, in the curated order (design-system §5.1). */
const portfolioImages: readonly SiteImage[] = portfolioOrder.map(
  (imageId) => siteImages[imageId],
)

type PortfolioFilter = SiteImageCategory | 'all'

interface FilterOption {
  readonly id: PortfolioFilter
  readonly label: string
}

/** Decision D12: a category filter, with «الكل» first. */
const filterOptions: readonly FilterOption[] = [
  { id: 'all', label: 'الكل' },
  ...portfolioCategories,
]

interface TileLayout {
  /** Keeps the tile at the photo's native ratio. */
  readonly modifier: string
  /**
   * About the widest the tile gets at each breakpoint (row height × ratio,
   * plus the room a row grows by to fill its line — PortfolioPage.css).
   */
  readonly sizes: string
}

const tileLayouts: Record<SiteImageRatio, TileLayout> = {
  '16:9': {
    modifier: 'portfolio-grid__item--wide',
    sizes:
      '(min-width: 80rem) 36rem, (min-width: 64rem) 32rem, (min-width: 48rem) 30rem, (min-width: 36rem) 25rem, 92vw',
  },
  '3:2': {
    modifier: 'portfolio-grid__item--landscape',
    sizes:
      '(min-width: 80rem) 31rem, (min-width: 64rem) 27rem, (min-width: 48rem) 25rem, (min-width: 36rem) 21rem, 92vw',
  },
  '4:5': {
    modifier: 'portfolio-grid__item--portrait',
    sizes:
      '(min-width: 80rem) 17rem, (min-width: 64rem) 15rem, (min-width: 48rem) 14rem, (min-width: 36rem) 12rem, 92vw',
  },
}

function CheckIcon() {
  return (
    <svg
      className="portfolio-filter__check"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12.5 10 17l9-10" />
    </svg>
  )
}

interface PortfolioPageProps {
  onNavigate: NavigationHandler
}

/**
 * `/portfolio` (design-system §5.3 and §4.10, copy 08-copy-ar §2, D12): the
 * heading, a category filter, all 32 photos at their native ratios, and a
 * full-screen lightbox. Its own chunk (see layout/lazy-components.ts).
 *
 * Every tile is a <button> that opens the lightbox. The grid is laid out in
 * justified rows (see PortfolioPage.css), so the visual order is always the
 * DOM order, which is also the keyboard and screen-reader order.
 */
export default function PortfolioPage({ onNavigate }: PortfolioPageProps) {
  const mainRef = useRef<HTMLElement>(null)
  const gridRef = useRef<HTMLUListElement>(null)
  // The photo whose tile gets focus back once the lightbox has closed.
  const focusReturnIdRef = useRef<string | null>(null)
  const [activeFilter, setActiveFilter] = useState<PortfolioFilter>('all')
  const [openImageId, setOpenImageId] = useState<string | null>(null)
  const morphTiles = isCinematicDesign()

  // Cinematic: the photos glide to their new places when the filter changes
  // (View Transitions; each tile is named after its photo). Elsewhere the
  // grid simply updates.
  function changeFilter(nextFilter: PortfolioFilter) {
    if (nextFilter === activeFilter) {
      return
    }

    if (!canUseViewTransition()) {
      setActiveFilter(nextFilter)
      return
    }

    const root = document.documentElement
    root.setAttribute('data-cine-vt', 'filter')
    const transition = document.startViewTransition(() => {
      flushSync(() => setActiveFilter(nextFilter))
    })
    transition.ready.catch(ignoreSkippedTransition)
    transition.finished
      .catch(ignoreSkippedTransition)
      .finally(() => root.removeAttribute('data-cine-vt'))
  }
  const tileHintId = useId()

  useReveal(mainRef)

  const visibleImages =
    activeFilter === 'all'
      ? portfolioImages
      : portfolioImages.filter((image) => image.category === activeFilter)
  const openIndex =
    openImageId === null
      ? -1
      : visibleImages.findIndex((image) => image.id === openImageId)

  // Runs after the lightbox's own cleanup has closed the dialog, so the
  // tile is focusable again. Focus goes to the photo that was on screen.
  useEffect(() => {
    if (openImageId !== null) {
      return
    }

    const imageId = focusReturnIdRef.current

    if (imageId === null) {
      return
    }

    focusReturnIdRef.current = null
    gridRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-image-id="${CSS.escape(imageId)}"]`,
      )
      ?.focus()
  }, [openImageId])

  function handleLightboxIndexChange(nextIndex: number) {
    const nextImage = visibleImages[nextIndex]

    if (nextImage !== undefined) {
      setOpenImageId(nextImage.id)
    }
  }

  function handleLightboxClose() {
    focusReturnIdRef.current = openImageId
    setOpenImageId(null)
  }

  return (
    <main id="main-content" className="portfolio-page" ref={mainRef}>
      <section
        className="portfolio-gallery section"
        aria-labelledby="portfolio-title"
      >
        <div className="container--wide">
          <header className="section-heading">
            <p className="eyebrow">معرض الأعمال</p>
            <DisplayHeading as="h1" id="portfolio-title" text="من أعمالنا" ornament />
            <p>
              مختارات من لحظات حقيقية صُوّرت بعناية واهتمام بالتفاصيل، ولا
              تُكشف فيها هوية أي عروس إلا بإذنها.
            </p>
          </header>

          <div
            className="portfolio-filter"
            role="group"
            aria-label="تصفية الأعمال حسب النوع"
          >
            {filterOptions.map((option) => {
              const isActive = option.id === activeFilter

              return (
                <button
                  key={option.id}
                  type="button"
                  className="portfolio-filter__option"
                  aria-pressed={isActive}
                  onClick={() => changeFilter(option.id)}
                >
                  <CheckIcon />
                  {option.label}
                </button>
              )
            })}
          </div>

          <p className="visually-hidden" aria-live="polite" aria-atomic="true">
            عدد اللقطات المعروضة: {visibleImages.length}
          </p>
          <p id={tileHintId} hidden>
            يفتح الصورة بحجم أكبر
          </p>

          <ul
            className="portfolio-grid"
            role="list"
            ref={gridRef}
            aria-label="لقطات من أعمالنا"
          >
            {visibleImages.map((image) => {
              const layout = tileLayouts[image.ratio]

              return (
                <li
                  key={image.id}
                  className={`portfolio-grid__item ${layout.modifier} reveal`}
                  style={
                    morphTiles
                      ? { viewTransitionName: `pt-${image.id}` }
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="portfolio-tile"
                    data-image-id={image.id}
                    aria-haspopup="dialog"
                    aria-describedby={tileHintId}
                    style={{ backgroundColor: image.placeholder }}
                    onClick={() => setOpenImageId(image.id)}
                  >
                    <ResponsiveImage
                      image={image}
                      sizes={layout.sizes}
                      className="portfolio-tile__image"
                    />
                  </button>
                </li>
              )
            })}
          </ul>

          <div className="portfolio-gallery__inquiry">
            <a
              className="text-link portfolio-gallery__inquiry-link"
              href={PORTFOLIO_INQUIRY_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <WhatsAppIcon className="portfolio-gallery__inquiry-icon" />
              استفسري عن موعدكِ
              <span className="visually-hidden">
                {' '}
                عبر واتساب {NEW_TAB_HINT}
              </span>
            </a>
          </div>
        </div>
      </section>

      {openIndex >= 0 && (
        <Lightbox
          images={visibleImages}
          index={openIndex}
          onIndexChange={handleLightboxIndexChange}
          onClose={handleLightboxClose}
        />
      )}

      <ContactSection onNavigate={onNavigate} />
    </main>
  )
}
