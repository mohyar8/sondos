import AppLink from '../../layout/AppLink'
import { WhatsAppIcon } from '../../layout/icons'
import {
  BOOKING_REQUEST_HREF,
  type NavigationHandler,
} from '../../layout/navigation'
import { NEW_TAB_HINT } from '../../layout/social-links'
import { DEFAULT_WHATSAPP_URL } from '../../lib/whatsapp'
import './ContactSection.css'

interface ContactSectionProps {
  onNavigate: NavigationHandler
}

/**
 * Closing call to action shared by Home and Portfolio (08-copy-ar §1.9,
 * headline A; design-system §4.1: the WhatsApp button is the rare gold accent
 * fill). Its id="contact" is the target of the header's «تواصلي معنا» link
 * (#contact / /#contact). The `.reveal` classes only animate on pages that
 * run useReveal; everywhere else they are the plain visible state.
 */
export default function ContactSection({ onNavigate }: ContactSectionProps) {
  return (
    <section
      className="contact-band section on-dark"
      id="contact"
      aria-labelledby="contact-title"
    >
      <div className="contact-band__inner container">
        <div className="contact-band__content reveal">
          <p className="eyebrow">تواصلي معنا</p>
          <h2 id="contact-title" className="contact-band__title">
            جاهزة لتوثيق يومكِ؟
          </h2>
          <p className="contact-band__text">
            أرسلي طلب حجزكِ الآن، أو تواصلي معنا مباشرة على واتساب لأي استفسار
            قبل الحجز.
          </p>
        </div>

        <div className="contact-band__actions reveal">
          <a
            className="btn btn--whatsapp btn--lg"
            href={DEFAULT_WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <WhatsAppIcon className="contact-band__icon" />
            تواصلي عبر واتساب
            <span className="visually-hidden"> {NEW_TAB_HINT}</span>
          </a>
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
    </section>
  )
}
