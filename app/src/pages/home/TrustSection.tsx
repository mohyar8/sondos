import { LockIcon, ShieldCheckIcon } from './icons'

/**
 * Trust & consent (08-copy-ar §1.6). Only the licence statement and the
 * consent promise are published: the deck's private-gallery line describes a
 * feature that is gated on the PDPL review (decisions.md D10) and is left
 * out until it exists.
 */
export default function TrustSection() {
  return (
    <section className="home-trust section" aria-labelledby="home-trust-title">
      <div className="home-trust__layout container">
        <header className="section-heading home-trust__heading reveal">
          <p className="eyebrow">خصوصيتكِ أولًا</p>
          <h2 id="home-trust-title">
            صوركِ ملككِ، ونصونها على هذا الأساس
          </h2>
          <p>
            سندس يار مصورة مصرّحة من وزارة العمل، وتلتزم بألا تُنشر أي صورة —
            في الموقع أو في حسابات التواصل — إلا بموافقة العروس.
          </p>
        </header>

        <ul className="home-trust__badges reveal" role="list">
          <li className="badge home-trust__badge">
            <ShieldCheckIcon className="badge__icon" />
            مصرّحة من وزارة العمل
          </li>
          <li className="badge home-trust__badge">
            <LockIcon className="badge__icon" />
            لا نشر إلا بإذنكِ الصريح
          </li>
        </ul>
      </div>
    </section>
  )
}
