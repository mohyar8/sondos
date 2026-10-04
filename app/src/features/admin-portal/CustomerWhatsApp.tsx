import type { AdminBookingDetail } from '../../../shared/admin'
import { NEW_TAB_HINT } from '../../layout/social-links'
import { buildWhatsAppUrlFor, isolateLtr } from '../../lib/whatsapp'
import { formatCustomerText } from './format'

/**
 * One-tap WhatsApp messages from the owner to the customer, one per step of
 * the booking (owner request, 2026-10-01). The message is only pre-filled:
 * WhatsApp opens on the owner's phone and she edits or sends it herself, so
 * nothing is sent automatically. Bank details and Drive links are never
 * stored on the site — she pastes them into the chat (no IBAN to tamper with).
 */

interface Template {
  readonly id: string
  readonly label: string
  readonly message: string
}

const totalFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn', {
  maximumFractionDigits: 0,
})

function buildTemplates(
  booking: AdminBookingDetail,
  eventDateLabel: string,
): readonly Template[] {
  const firstName = formatCustomerText(booking.customer.firstName)
  const greeting = firstName ? `مرحبًا ${firstName}،` : 'مرحبًا،'
  const reference = isolateLtr(booking.id)
  const total = `${totalFormatter.format(booking.estimatedTotal)} ريال`
  const photoCount = booking.packageSnapshot?.album?.photoCount ?? null

  const general: Template = {
    id: 'general',
    label: 'رسالة عامة',
    message: `${greeting} معكِ سندس يار بخصوص حجزكِ رقم ${reference}.`,
  }

  switch (booking.status) {
    case 'pending_review':
      return [
        {
          id: 'received',
          label: 'تأكيد استلام الطلب',
          message: `${greeting} وصلنا طلب حجزكِ رقم ${reference} ليوم ${eventDateLabel}، وسنراجعه ونرد عليكِ قريبًا بإذن الله.`,
        },
        general,
      ]
    case 'approved_hold':
    case 'contract_pending':
    case 'contract_signed':
      return [
        {
          id: 'deposit',
          label: 'الموافقة وطلب العربون',
          message: `${greeting} تمت الموافقة المبدئية على حجزكِ رقم ${reference} ليوم ${eventDateLabel}.\nالإجمالي التقديري: ${total}.\nلتأكيد الحجز نرجو تحويل العربون على الحساب التالي، ثم إرسال صورة الإيصال هنا:\n`,
        },
        general,
      ]
    case 'payment_pending':
      return [
        {
          id: 'deposit-reminder',
          label: 'تذكير بالعربون',
          message: `${greeting} تذكير لطيف: بانتظار إيصال تحويل العربون لحجزكِ رقم ${reference} ليوم ${eventDateLabel} حتى نؤكد الموعد.`,
        },
        general,
      ]
    case 'confirmed':
      return [
        {
          id: 'confirmed',
          label: 'تأكيد الحجز',
          message: `${greeting} تم تأكيد حجزكِ رقم ${reference} ليوم ${eventDateLabel}، شكرًا لثقتكِ. سنتواصل معكِ قبل الموعد لترتيب التفاصيل.`,
        },
        {
          id: 'pre-event',
          label: 'قبل المناسبة',
          message: `${greeting} نقترب من يومكِ (${eventDateLabel}). نرجو تأكيد مكان المناسبة ووقت بداية التصوير وأي تفاصيل تحبين أن نهتم بها.`,
        },
        {
          id: 'photos-ready',
          label: 'تسليم الصور (Drive)',
          message: `${greeting} صوركِ جاهزة. هذا رابط Drive الآمن لجميع اللقطات:\n`,
        },
        {
          id: 'album-selection',
          label: 'اختيار صور الألبوم',
          message: `${greeting} نرجو اختيار صور الألبوم${photoCount ? ` (${photoCount} صورة)` : ''} وإرسال أرقامها هنا. تبدأ مدة تجهيز الألبوم من تاريخ تأكيد اختياركِ، ونعرض عليكِ نموذجًا مبدئيًا قبل الطباعة.`,
        },
        {
          id: 'album-ready',
          label: 'الألبوم جاهز: استلام أو توصيل',
          message: `${greeting} ألبومكِ جاهز. هل تفضلين استلامه من الاستوديو أم توصيله إليكِ؟ وما اليوم والوقت المناسبان لكِ؟`,
        },
        {
          id: 'feedback',
          label: 'طلب رأيها',
          message: `${greeting} سعدنا جدًا بتوثيق يومكِ. يسعدنا سماع رأيكِ في تجربتكِ معنا.`,
        },
      ]
    case 'rejected':
    case 'cancelled':
    case 'expired':
      return [general]
  }
}

export default function CustomerWhatsApp({
  booking,
  eventDateLabel,
}: {
  booking: AdminBookingDetail
  eventDateLabel: string
}) {
  const templates = buildTemplates(booking, eventDateLabel)
  const links = templates.map((template) => ({
    template,
    link: buildWhatsAppUrlFor(booking.customer.phone, template.message),
  }))
  const firstFailure = links.find(({ link }) => !link.ok)

  if (firstFailure && !firstFailure.link.ok) {
    return (
      <p className="admin-detail__busy-hint" role="status">
        {`تعذر فتح واتساب لهذا الرقم: ${firstFailure.link.reason}`}
      </p>
    )
  }

  return (
    <section
      className="admin-detail__section"
      aria-labelledby="admin-whatsapp-title"
    >
      <h3 id="admin-whatsapp-title">مراسلة العميلة عبر واتساب</h3>
      <p className="admin-detail__busy-hint">
        تُفتح الرسالة جاهزة في واتساب، ويمكنكِ تعديلها قبل الإرسال.
      </p>
      <div className="admin-access-card__actions">
        {links.map(({ template, link }) =>
          link.ok ? (
            <a
              key={template.id}
              className="btn btn--secondary"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {template.label}
              <span className="visually-hidden"> {NEW_TAB_HINT}</span>
            </a>
          ) : null,
        )}
      </div>
    </section>
  )
}
