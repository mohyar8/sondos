import {
  DEFAULT_WHATSAPP_URL,
  WHATSAPP_DISPLAY_NUMBER,
} from '../lib/whatsapp'
import { InstagramIcon, TikTokIcon, WhatsAppIcon } from './icons'
import {
  footerQuickLinks,
  type NavigationHandler,
  type PublicPath,
} from './navigation'
import { NEW_TAB_HINT, socialLinks } from './social-links'
import './SiteFooter.css'

const COPYRIGHT_YEAR = new Date().getFullYear()

interface SiteFooterProps {
  activePath: PublicPath
  onNavigate: NavigationHandler
}

export default function SiteFooter({ activePath, onNavigate }: SiteFooterProps) {
  return (
    <footer className="site-footer on-dark">
      <div className="site-footer__inner container">
        <section className="site-footer__brand" aria-labelledby="footer-brand">
          <h2 className="site-footer__brand-name" id="footer-brand">
            المصورة سندس يار
          </h2>
          <p className="site-footer__tagline">
            تصوير العرائس في المدينة المنورة، المملكة العربية السعودية
          </p>
          <ul className="site-footer__trust" role="list">
            <li>مصرّحة من وزارة العمل</li>
            <li>جميع الصور تُنشر بموافقة العروس</li>
          </ul>
        </section>

        <section
          className="site-footer__column"
          aria-labelledby="footer-contact"
        >
          <h2 className="site-footer__heading" id="footer-contact">
            تواصلي معنا
          </h2>
          <ul className="site-footer__list" role="list">
            <li>
              <a
                className="site-footer__link"
                href={DEFAULT_WHATSAPP_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <WhatsAppIcon className="site-footer__icon" />
                <span>
                  واتساب: <bdi dir="ltr">{WHATSAPP_DISPLAY_NUMBER}</bdi>
                </span>
                <span className="visually-hidden"> {NEW_TAB_HINT}</span>
              </a>
            </li>
          </ul>
        </section>

        <section className="site-footer__column" aria-labelledby="footer-social">
          <h2 className="site-footer__heading" id="footer-social">
            تابعينا
          </h2>
          <ul className="site-footer__list" role="list">
            {socialLinks.map((link) => (
              <li key={link.network}>
                <a
                  className="site-footer__link"
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {link.network === 'instagram' ? (
                    <InstagramIcon className="site-footer__icon" />
                  ) : (
                    <TikTokIcon className="site-footer__icon" />
                  )}
                  <span>
                    {link.label}: <bdi dir="ltr">{link.handle}</bdi>
                  </span>
                  <span className="visually-hidden"> {NEW_TAB_HINT}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        <nav className="site-footer__column" aria-labelledby="footer-links">
          <h2 className="site-footer__heading" id="footer-links">
            روابط سريعة
          </h2>
          <ul className="site-footer__list" role="list">
            {footerQuickLinks.map((link) => (
              <li key={link.href}>
                <a
                  className="site-footer__link"
                  href={link.href}
                  aria-current={link.path === activePath ? 'page' : undefined}
                  onClick={(event) => onNavigate(event, link.href)}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="site-footer__bottom">
        <p className="container">
          © <bdi dir="ltr">{COPYRIGHT_YEAR}</bdi> المصورة سندس يار. جميع الحقوق
          محفوظة.
        </p>
      </div>
    </footer>
  )
}
