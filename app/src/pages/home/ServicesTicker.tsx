import { isCinematicDesign } from '../../design/runtime'

/** What the studio photographs and delivers (owner, 2026-10-01). */
const SERVICES = [
  'عقد القران',
  'حفلات الزواج',
  'جلسات العائلة',
  'أعياد الميلاد',
  'حفلات التخرج',
  'ألبومات فاخرة',
  'مطبوعات ومكبّرات خشبية',
  'كواليس بالجوال',
  'تصوير بكاميرتين',
] as const

/**
 * A slow band of services under the hero (cinematic design only). It moves
 * from left to right as Arabic reads, pauses on hover and keyboard focus, and
 * stands still as a wrapped list under prefers-reduced-motion. The second
 * copy only closes the loop, so it is hidden from assistive technology.
 */
export default function ServicesTicker() {
  if (!isCinematicDesign()) {
    return null
  }

  return (
    <section className="cine-ticker" aria-label="ما نصوّره">
      <div className="cine-ticker__track">
        <ul className="cine-ticker__list" role="list">
          {SERVICES.map((service) => (
            <li className="cine-ticker__item" key={service}>
              {service}
            </li>
          ))}
        </ul>
        <ul className="cine-ticker__list" role="list" aria-hidden="true">
          {SERVICES.map((service) => (
            <li className="cine-ticker__item" key={service}>
              {service}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
