import type { ReactNode } from 'react'
import { coverageAddonOptions, coverageOptions } from '../../data/packages'
import AppLink from '../../layout/AppLink'
import {
  BOOKING_REQUEST_HREF,
  type NavigationHandler,
} from '../../layout/navigation'
import { NEW_TAB_HINT, socialLinks } from '../../layout/social-links'
import {
  DEFAULT_WHATSAPP_URL,
  WHATSAPP_DISPLAY_NUMBER,
} from '../../lib/whatsapp'
import { DisclosureIcon } from './icons'
import DisplayHeading from '../../components/DisplayHeading'

interface FaqSectionProps {
  onNavigate: NavigationHandler
}

interface FaqItem {
  readonly question: string
  readonly answer: ReactNode
}

/** Prices in Western digits (design-system §2.3). */
const priceFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn', {
  style: 'currency',
  currency: 'SAR',
  maximumFractionDigits: 0,
})

/**
 * 08-copy-ar §1.8, verified answers only. Left out: the deposit amount and
 * bank details and the album pickup place (both marked for the owner), and
 * photo selection from a private gallery (a later, gated feature). Coverage
 * prices are read from data/packages.ts, never retyped.
 */
function getFaqItems(onNavigate: NavigationHandler): readonly FaqItem[] {
  return [
    {
      question: 'كم تبلغ مدة تغطية التصوير المتاحة؟',
      answer: (
        <>
          <p>
            تتوفر مدد التغطية التالية، وتختارين المناسبة لكِ من{' '}
            <AppLink
              className="home-faq__link"
              href={BOOKING_REQUEST_HREF}
              preloadPath="/packages"
              onNavigate={onNavigate}
            >
              صفحة الباقات
            </AppLink>
            :
          </p>
          <ul className="home-faq__prices" role="list">
            {coverageOptions.map((option) => (
              <li key={option.id}>
                <span>{option.label}</span>
                <span className="home-faq__price">
                  {priceFormatter.format(option.price)}
                </span>
              </li>
            ))}
          </ul>
          <p>
            ويمكنكِ إضافة{' '}
            {coverageAddonOptions.map((option, index) => (
              <span key={option.id}>
                {index > 0 && ' أو '}
                {option.label} ({priceFormatter.format(option.price)})
              </span>
            ))}{' '}
            إلى أي مدة تغطية.
          </p>
        </>
      ),
    },
    {
      question: 'هل تصوّرون مناسبات غير عقد القران والزواج؟',
      answer: (
        <p>
          نعم. إلى جانب عقد القران والزواج نصوّر الصور العائلية والمناسبات
          الصغيرة مثل أعياد الميلاد والتخرج وغيرها. تواصلي معنا عبر واتساب
          لنرتّب معكِ تفاصيل مناسبتكِ.
        </p>
      ),
    },
    {
      question: 'متى أستلم صوري؟',
      answer: (
        <p>
          في اليوم التالي مباشرة لتاريخ التصوير، تصلكِ جميع اللقطات عبر رابط
          Drive آمن.
        </p>
      ),
    },
    {
      question: 'هل الألبوم والمطبوعات جزء من سعر التغطية أم منفصلة؟',
      answer: (
        <p>
          التغطية والألبوم والمطبوعات عناصر منفصلة تختارينها حسب رغبتكِ، ويظهر
          الإجمالي التقديري مباشرة أثناء اختيار التفاصيل في صفحة الباقات.
        </p>
      ),
    },
    {
      question: 'كم تستغرق مدة تجهيز الألبوم؟',
      answer: (
        <p>
          تبدأ مدة تجهيز الألبوم من تاريخ اختياركِ لصور الألبوم وتأكيدها
          نهائيًا، وتتراوح بين شهرين و6 أشهر كحد أقصى، وقد يتم التسليم قبل ذلك
          حسب جدول العمل، لضمان منح كل ألبوم الوقت الكافي للعناية بتفاصيله
          وإخراجه بأفضل صورة.
        </p>
      ),
    },
    {
      question: 'كيف تُرتَّب الصور داخل صفحات الألبوم؟',
      answer: (
        <p>
          نرتّب الصور داخل صفحات الألبوم وفق اختياركِ، ونعرض عليكِ نموذجًا
          مبدئيًا قبل التنفيذ، ويمكنكِ تعديل ترتيب الصور مرة واحدة قبل اعتماد
          التصميم النهائي والطباعة.
        </p>
      ),
    },
    {
      question: 'هل إرسال طلب الحجز يعني أن تاريخي محجوز فعليًا؟',
      answer: (
        <p>
          لا. عند إرسال الطلب يكون «قيد المراجعة»، ولا يُعد التاريخ مؤكدًا حتى
          نوافق عليه. بعد موافقتنا يُحجز التاريخ لكِ مبدئيًا ضمن مهلة محددة
          لإكمال باقي خطوات الحجز، ويتأكد الحجز نهائيًا بعد استلام العربون.
        </p>
      ),
    },
    {
      question: 'هل تُنشر صوري في أي مكان؟',
      answer: (
        <p>
          لا، إلا بموافقتكِ الصريحة. جميع الصور تُنشر بموافقة العروس فقط، في
          الموقع وفي حسابات التواصل.
        </p>
      ),
    },
    {
      question: 'ماذا لو احتجتُ إلى تعديل حجزي أو إلغائه؟',
      answer: (
        <p>
          تواصلي معنا عبر واتساب مباشرة وسنساعدكِ. لا يمكن حاليًا تعديل الحجز أو
          إلغاؤه من الموقع مباشرة، إذ نراجع كل حالة معكِ شخصيًا.
        </p>
      ),
    },
    {
      question: 'كيف أتواصل لأي استفسار قبل الحجز؟',
      answer: (
        <p>
          عبر واتساب على{' '}
          <a
            className="home-faq__link"
            href={DEFAULT_WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <bdi dir="ltr">{WHATSAPP_DISPLAY_NUMBER}</bdi>
            <span className="visually-hidden"> {NEW_TAB_HINT}</span>
          </a>
          ، أو عبر{' '}
          {socialLinks.map((social, index) => (
            <span key={social.network}>
              {index > 0 && ' و'}
              <a
                className="home-faq__link"
                href={social.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {social.label}
                <span className="visually-hidden"> {NEW_TAB_HINT}</span>
              </a>
            </span>
          ))}{' '}
          على الحساب <bdi dir="ltr">@sndsyar</bdi>.
        </p>
      ),
    },
  ]
}

export default function FaqSection({ onNavigate }: FaqSectionProps) {
  const faqItems = getFaqItems(onNavigate)

  return (
    <section className="home-faq section" aria-labelledby="home-faq-title">
      <div className="container">
        <header className="section-heading reveal">
          <p className="eyebrow">قبل الحجز</p>
          <DisplayHeading id="home-faq-title" text="الأسئلة الشائعة" ornament />
        </header>

        <ul className="home-faq__list reveal" role="list">
          {faqItems.map((item) => (
            <li key={item.question}>
              <details className="home-faq__item">
                <summary className="home-faq__question">
                  {/* Flex on an inner span: some WebKit versions ignore a
                      display change on <summary> itself. */}
                  <span className="home-faq__question-row">
                    <span>{item.question}</span>
                    <DisclosureIcon className="home-faq__icon" />
                  </span>
                </summary>
                <div className="home-faq__answer">{item.answer}</div>
              </details>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
