import type { EmailTemplate } from '../../shared/notifications.js'
import {
  BRAND_NAME,
  WHATSAPP_NOTE,
  buildMyBookingDeepLinkUrl,
  formatEmailDate,
  isolateLtrText,
  isolatePersonName,
  ltrValue,
  renderEmailLayout,
  stripBidiControls,
} from '../email-templates.js'

/**
 * The "your album is ready" email (plan 11 §3.3 #23; 08-copy-ar §8.2 #6),
 * queued once per booking in the outbox (worker/notify/outbox.ts, key
 * `album_ready:<bookingId>:once`) when the admin moves the album to `ready`.
 * Rendered when it is queued, through the shared layout, which escapes every
 * value; addressed to her in the feminine singular.
 *
 * Her first name is sanitised and bidi-isolated (isolatePersonName), the
 * booking reference is isolated left-to-right, and the date is formatted
 * here, so nothing she typed can re-order the Arabic text around it (SB-6).
 * The button deep-links to `/my-bookings?booking=<id>` from APP_BASE_URL;
 * without a usable APP_BASE_URL the email is still complete, with no button.
 */

export interface AlbumReadyEmailInput {
  readonly customerFirstName: string
  /** booking_requests.id, which is also the booking reference she sees. */
  readonly bookingId: string
  /** Riyadh calendar date, `YYYY-MM-DD`. */
  readonly eventDate: string
  readonly appBaseUrl: string | undefined
}

const SUBJECT_PREFIX = 'ألبومكِ جاهز! احجزي موعد الاستلام'
const HEADING = 'ألبومكِ جاهز'
const ACTION_LABEL = 'احجزي موعد الاستلام'
const LINK_FALLBACK_LABEL = 'إذا لم يعمل الزر، افتحي الرابط:'
const BODY =
  'اختاري الطريقة المناسبة لكِ، الاستلام أو التوصيل، وحدّدي الموعد من صفحة حجوزاتي.'

function greeting(firstName: string): string {
  const name = isolatePersonName(firstName)

  return name.length > 0 ? `أهلًا ${name}،` : 'أهلًا،'
}

export function renderAlbumReadyEmail(
  input: AlbumReadyEmailInput,
): EmailTemplate {
  const intro = `${greeting(input.customerFirstName)} ألبومكِ أصبح جاهزًا — احجزي موعد الاستلام أو التوصيل.`
  const eventDate = formatEmailDate(input.eventDate)
  const deepLink = buildMyBookingDeepLinkUrl(input.appBaseUrl, input.bookingId)
  const text = [
    BRAND_NAME,
    '',
    intro,
    '',
    `رقم الطلب: ${isolateLtrText(input.bookingId)}`,
    `تاريخ المناسبة: ${eventDate}`,
    '',
    BODY,
    '',
    ...(deepLink === null
      ? ['يمكنكِ حجز الموعد من صفحة حجوزاتي في موقعنا.']
      : ['احجزي الموعد من صفحة حجوزاتي:', deepLink]),
    '',
    WHATSAPP_NOTE,
  ].join('\n')

  return {
    subject: `${SUBJECT_PREFIX} — ${stripBidiControls(input.bookingId).trim()}`,
    text,
    html: renderEmailLayout({
      heading: HEADING,
      intro,
      summaryRows: [
        ['رقم الطلب', ltrValue(input.bookingId)],
        ['تاريخ المناسبة', eventDate],
      ],
      body: BODY,
      actionUrl: deepLink,
      actionLabel: ACTION_LABEL,
      linkFallbackLabel: LINK_FALLBACK_LABEL,
    }),
  }
}
