import { useRef } from 'react'
import PackageConfigurator from '../components/PackageConfigurator'
import ResponsiveImage from '../components/ResponsiveImage'
import { packagesBannerId, siteImages } from '../data/site-images'
import { useReveal } from '../layout/useReveal'
import './PackagesPage.css'
import DisplayHeading from '../components/DisplayHeading'

/**
 * Page banner (design-system §5.4 item 1, copy 08-copy-ar §3.1): a short
 * full-bleed photo band with the page's only H1 on an ink scrim. It is the
 * largest paint on this route, so the photo loads eagerly at high priority.
 */
function PackagesBanner() {
  const image = siteImages[packagesBannerId]

  return (
    <header
      className="packages-banner"
      style={{ backgroundColor: image.placeholder }}
    >
      <ResponsiveImage
        image={image}
        sizes="100vw"
        className="packages-banner__image"
        loading="eager"
        fetchPriority="high"
      />
      <div className="packages-banner__content container">
        <DisplayHeading as="h1" className="packages-banner__title" text="اختاري باقتكِ وتفاصيل يومكِ" />
        <p className="packages-banner__text">
          كوّني خيارات التصوير والألبوم والمطبوعات، وشاهدي السعر التقديري
          مباشرة أمامكِ.
        </p>
      </div>
    </header>
  )
}

interface BookingStep {
  /** Decorative Eastern Arabic numeral (design-system §2.3 allows it here). */
  readonly marker: string
  readonly title: string
}

/** 08-copy-ar §3.2: the steps of the request form itself. */
const bookingSteps: readonly BookingStep[] = [
  { marker: '١', title: 'اختاري التفاصيل' },
  { marker: '٢', title: 'حددي التاريخ' },
  { marker: '٣', title: 'أرسلي طلبكِ' },
  { marker: '٤', title: 'استلمي التأكيد' },
]

function BookingStepsSection() {
  return (
    <section
      className="packages-steps section"
      aria-labelledby="packages-steps-title"
    >
      <div className="container">
        <header className="section-heading reveal">
          <p className="eyebrow">من الاختيار إلى التأكيد</p>
          <DisplayHeading id="packages-steps-title" text="خطوات حجز بسيطة" ornament />
        </header>

        <ol className="packages-steps__list" role="list">
          {bookingSteps.map((step) => (
            <li className="packages-steps__item reveal" key={step.marker}>
              <span className="packages-steps__marker" aria-hidden="true">
                {step.marker}
              </span>
              <h3>{step.title}</h3>
            </li>
          ))}
        </ol>

        <p className="packages-steps__note reveal">
          يُراجَع طلبكِ أولًا، وبعد قبوله نرسل لكِ التأكيد وخطوات إكمال الحجز.
        </p>
      </div>
    </section>
  )
}

/**
 * id="packages" is the booking entry point (/packages#packages). The
 * configurator itself is unchanged; its option groups use h3 headings under
 * this section's h2.
 */
function PackagesSection() {
  return (
    <section
      className="packages-section section"
      id="packages"
      aria-labelledby="packages-title"
    >
      <div className="container">
        <header className="section-heading">
          <p className="eyebrow">صممي تغطيتكِ</p>
          <DisplayHeading id="packages-title" text="باقات وأسعار تصوير العروس" ornament />
        </header>
        <PackageConfigurator />
      </div>
    </section>
  )
}

/**
 * `/packages` (design-system §5.4): banner, booking steps, then the
 * configurator. Its own chunk, together with PackageConfigurator,
 * BookingCalendar and the package data (see layout/lazy-components.ts).
 */
export default function PackagesPage() {
  const mainRef = useRef<HTMLElement>(null)

  useReveal(mainRef)

  return (
    <main id="main-content" className="packages-page" ref={mainRef}>
      <PackagesBanner />
      <BookingStepsSection />
      <PackagesSection />
    </main>
  )
}
