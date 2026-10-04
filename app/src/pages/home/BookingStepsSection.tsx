import AppLink from '../../layout/AppLink'
import {
  BOOKING_REQUEST_HREF,
  type NavigationHandler,
} from '../../layout/navigation'
import DisplayHeading from '../../components/DisplayHeading'

interface BookingStepsSectionProps {
  onNavigate: NavigationHandler
}

interface BookingStep {
  /** Decorative Eastern Arabic numeral (design-system §2.3 allows it here). */
  readonly marker: string
  readonly title: string
  readonly text: string
}

/**
 * 08-copy-ar §1.5, condensed to four steps that match today's booking flow
 * (pending_review → approved_hold with a hold deadline → deposit →
 * confirmed). The deck's online-terms, receipt-upload, photo-selection and
 * handover-slot steps belong to later runs and are not promised here.
 */
const bookingSteps: readonly BookingStep[] = [
  {
    marker: '١',
    title: 'اختاري باقتكِ وتاريخ مناسبتكِ',
    text: 'كوّني التغطية والألبوم والمطبوعات من صفحة الباقات، وشاهدي السعر التقديري قبل الإرسال.',
  },
  {
    marker: '٢',
    title: 'نراجع الطلب ونؤكد قبوله',
    text: 'يبقى طلبكِ «قيد المراجعة» حتى نرد عليكِ، وبعد القبول يُحجز تاريخكِ مبدئيًا.',
  },
  {
    marker: '٣',
    title: 'أكملي حجزكِ بالعربون',
    text: 'نرسل لكِ خطوات إكمال الحجز وموعد تحويل العربون، ويتأكد حجزكِ بعد استلامه.',
  },
  {
    marker: '٤',
    title: 'من يومكِ إلى ألبومكِ',
    text: 'نوثّق مناسبتكِ بهدوء، ثم نتابع معكِ حتى تستلمي ألبومكِ.',
  },
]

export default function BookingStepsSection({
  onNavigate,
}: BookingStepsSectionProps) {
  return (
    <section
      className="home-steps section"
      aria-labelledby="home-steps-title"
    >
      <div className="container">
        <header className="section-heading reveal">
          <p className="eyebrow">من الاختيار إلى الألبوم</p>
          <DisplayHeading id="home-steps-title" text="رحلة حجز واضحة، خطوة بخطوة" ornament />
        </header>

        <ol className="home-steps__list" role="list">
          {bookingSteps.map((step) => (
            <li className="home-steps__item reveal" key={step.marker}>
              <span className="home-steps__marker" aria-hidden="true">
                {step.marker}
              </span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>

        <div className="home-steps__action">
          <AppLink
            className="btn btn--primary btn--lg"
            href={BOOKING_REQUEST_HREF}
            preloadPath="/packages"
            onNavigate={onNavigate}
          >
            ابدئي طلب الحجز
          </AppLink>
        </div>
      </div>
    </section>
  )
}
