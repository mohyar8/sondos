import type { ComponentType } from 'react'
import AppLink from '../../layout/AppLink'
import {
  BOOKING_REQUEST_HREF,
  type NavigationHandler,
} from '../../layout/navigation'
import { AlbumIcon, CameraIcon, ChecklistIcon } from './icons'
import DisplayHeading from '../../components/DisplayHeading'

interface ServicesSectionProps {
  onNavigate: NavigationHandler
}

interface Service {
  readonly title: string
  readonly text: string
  readonly Icon: ComponentType<{ className?: string }>
}

/**
 * 08-copy-ar §1.4 — only services that exist in data/packages.ts. The third
 * card stops at booking confirmation: later stages (receipt upload, photo
 * selection, album handover) are not on the site yet.
 */
const services: readonly Service[] = [
  {
    title: 'تغطية يوم العروس',
    text: 'تغطيات مرنة تبدأ من ساعتين وتصل إلى 8 ساعات، تناسب تفاصيل مناسبتكِ.',
    Icon: CameraIcon,
  },
  {
    title: 'ألبومات ومطبوعات',
    text: 'ألبومات بثلاثة مقاسات، ومطبوعات فردية، ومجلات تصوير — كلها قابلة للتخصيص من صفحة الباقات.',
    Icon: AlbumIcon,
  },
  {
    title: 'تنظيم واضح للحجز',
    text: 'اختاري تفاصيلكِ وأرسلي الطلب، وتابعي كل خطوة من المراجعة حتى تأكيد الحجز من صفحة «حجوزاتي».',
    Icon: ChecklistIcon,
  },
]

export default function ServicesSection({ onNavigate }: ServicesSectionProps) {
  return (
    <section
      className="home-services section"
      id="services"
      aria-labelledby="home-services-title"
    >
      <div className="container">
        <header className="section-heading reveal">
          <p className="eyebrow">خدمات التصوير</p>
          <DisplayHeading id="home-services-title" text="تجربة مصممة لتفاصيل يومكِ" ornament />
        </header>

        <ul className="home-services__grid" role="list">
          {services.map(({ title, text, Icon }) => (
            <li className="card home-services__card reveal" key={title}>
              <Icon className="home-services__icon" />
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ul>

        <AppLink
          className="text-link home-services__more"
          href={BOOKING_REQUEST_HREF}
          preloadPath="/packages"
          onNavigate={onNavigate}
        >
          استعرضي الباقات
        </AppLink>
      </div>
    </section>
  )
}
