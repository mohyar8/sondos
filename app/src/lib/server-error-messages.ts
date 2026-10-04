import { buildWhatsAppUrl } from './whatsapp'

/**
 * The one table of Arabic wording for API errors (plan 11 §3.1, R-05). The
 * API client (lib/api-client.ts), the admin requests (api/admin.ts) and the
 * screens that name a code read their messages from here, so one code reads
 * the same everywhere. Addressed to her in the feminine singular.
 */

/**
 * 410 ACCOUNT_ERASED (GET/PUT /api/profile, POST /api/bookings, GET
 * /api/bookings/me): her data was erased at her request. Final — nothing
 * she retries changes it — so screens offer WhatsApp, never «إعادة
 * المحاولة».
 */
export const ACCOUNT_ERASED_CODE = 'ACCOUNT_ERASED'

export const ACCOUNT_ERASED_MESSAGE =
  'حُذفت بيانات هذا الحساب بناءً على طلبكِ، لذلك لا يمكن استخدامه بعد الآن. إن احتجتِ إلى المساعدة، تواصلي معنا عبر واتساب.'

/**
 * WhatsApp help for an account problem she cannot fix herself (an erased
 * account, an address another account holds). The pre-filled text names no
 * account detail; she adds what she wants.
 */
export const ACCOUNT_SUPPORT_URL = buildWhatsAppUrl(
  'السلام عليكم، أحتاج مساعدة بخصوص حسابي في موقع المصورة سندس يار.',
)

/**
 * 409 EMAIL_ALREADY_IN_USE from POST /api/bookings (SEC-04): her verified
 * address could not be bound to this account because another account holds
 * it, so no booking can be sent from it. Retrying gets the same answer, so
 * the booking form offers WhatsApp alongside it.
 */
export const BOOKING_EMAIL_NOT_BOUND_MESSAGE =
  'تعذر ربط بريدكِ الإلكتروني المؤكَّد بحسابكِ، لذلك لم يُرسَل طلب الحجز. إعادة المحاولة لن تغيّر ذلك؛ تواصلي معنا عبر واتساب لمساعدتكِ.'

/**
 * Any 401 other than a Wave 0 REAUTH_REQUIRED: the token is missing,
 * invalid, expired or revoked, so the session itself is gone. The screen
 * offers sign-in; nothing in the API layer signs her out.
 */
export const SESSION_ENDED_MESSAGE =
  'انتهت جلسة تسجيل الدخول. يرجى تسجيل الدخول مرة أخرى.'

const OPEN_REQUEST_LIMIT_MESSAGE =
  'لديكِ ثلاثة طلبات مفتوحة. انتظري الرد عليها قبل إرسال طلب جديد.'

const DATE_BEYOND_HORIZON_MESSAGE = 'يمكن الحجز لمدة أقصاها سنتان من اليوم.'

/**
 * The Worker's abuse and security limits (plan 11 §3.1). For these codes the
 * Worker's own `message` is never shown: a platform 413/429 page carries no
 * envelope, and a Wave 0 Worker words some of them differently.
 */
export const serverLimitMessages = {
  /**
   * 403 (401 from a Wave 0 Worker): the action needs a recent sign-in. The
   * client opens the password prompt and retries once; the code reaches a
   * screen only when she closed the prompt or none was available.
   */
  REAUTH_REQUIRED:
    'لحماية الحساب، أعيدي إدخال كلمة المرور لإتمام هذا الإجراء.',
  /** 403: an admin action that needs the authenticator-app sign-in. */
  SECOND_FACTOR_REQUIRED:
    'هذا الإجراء يتطلب التحقق بخطوتين لحساب الإدارة. من تبويب «أمان الحساب» فعّلي تطبيق المصادقة إن لم يكن مفعّلًا، ثم اضغطي «تأكيد الهوية بتطبيق المصادقة» وأعيدي المحاولة.',
  /** 429: a Worker rate limit. */
  RATE_LIMITED: 'طلبات كثيرة خلال وقت قصير. حاولي مرة أخرى بعد قليل.',
  /**
   * 413: a form body or an upload (receipt, gallery photo) over the
   * Worker's byte cap, so the wording fits both.
   */
  PAYLOAD_TOO_LARGE:
    'حجم ما أرسلتِه أكبر من المسموح. اختصري النص أو اختاري ملفًا أصغر حجمًا، ثم أعيدي المحاولة.',
  /** 403: the browse-only preview accepts no writes. */
  PREVIEW_READ_ONLY: 'هذه نسخة للعرض فقط ولا تقبل التعديلات.',
  /** 409: the per-account cap of three open booking requests. */
  OPEN_REQUEST_LIMIT: OPEN_REQUEST_LIMIT_MESSAGE,
  /** 400: an event date past the 730-day horizon (shared/timing.ts). */
  DATE_BEYOND_HORIZON: DATE_BEYOND_HORIZON_MESSAGE,
  /** Wave 0 name of OPEN_REQUEST_LIMIT (same message, not a second one). */
  TOO_MANY_OPEN_REQUESTS: OPEN_REQUEST_LIMIT_MESSAGE,
  /** Wave 0 name of DATE_BEYOND_HORIZON (same message, not a second one). */
  BOOKING_TOO_FAR_AHEAD: DATE_BEYOND_HORIZON_MESSAGE,
} as const

export type ServerLimitCode = keyof typeof serverLimitMessages

export function isServerLimitCode(value: unknown): value is ServerLimitCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(serverLimitMessages, value)
  )
}

/**
 * The plan's name (11 §3.1) for a code a Wave 0 Worker still sends under its
 * old name; any other code unchanged.
 */
export function toCurrentServerErrorCode(code: string): string {
  switch (code) {
    case 'ADMIN_MFA_REQUIRED':
      return 'SECOND_FACTOR_REQUIRED'
    case 'TOO_MANY_OPEN_REQUESTS':
      return 'OPEN_REQUEST_LIMIT'
    case 'BOOKING_TOO_FAR_AHEAD':
      return 'DATE_BEYOND_HORIZON'
    default:
      return code
  }
}

/**
 * The limit a status stands for when the body carries no usable code (e.g.
 * the platform's own 413 or 429 page), or null.
 */
export function serverLimitCodeForStatus(
  status: number,
): Extract<ServerLimitCode, 'PAYLOAD_TOO_LARGE' | 'RATE_LIMITED'> | null {
  switch (status) {
    case 413:
      return 'PAYLOAD_TOO_LARGE'
    case 429:
      return 'RATE_LIMITED'
    default:
      return null
  }
}

/** Her wording for an error status whose body names no usable message. */
export function serverStatusFallbackMessage(status: number): string {
  const limitCode = serverLimitCodeForStatus(status)

  if (limitCode !== null) {
    return serverLimitMessages[limitCode]
  }

  switch (status) {
    case 401:
      return SESSION_ENDED_MESSAGE
    case 403:
      return 'لا يمكن إتمام هذا الطلب بحسابكِ الحالي.'
    case 404:
      return 'تعذر العثور على المطلوب.'
    case 410:
      return ACCOUNT_ERASED_MESSAGE
    default:
      return status >= 500
        ? 'حدث خطأ غير متوقع في الخدمة. أعيدي المحاولة بعد قليل.'
        : 'تعذر إتمام الطلب. أعيدي المحاولة.'
  }
}

/** Failures decided in the browser, before or instead of a server answer. */
export const apiClientFailureMessages = {
  TOKEN_UNAVAILABLE:
    'تعذر التحقق من جلسة الدخول مؤقتًا. أعيدي المحاولة بعد لحظات.',
  NETWORK_ERROR:
    'تعذر الاتصال بالخدمة حاليًا. تحققي من الاتصال ثم أعيدي المحاولة.',
  ABORTED: 'أُلغي الطلب قبل اكتماله.',
  MALFORMED_RESPONSE:
    'وصل رد غير متوقع من الخدمة. أعيدي المحاولة بعد قليل.',
  INVALID_REQUEST: 'تعذر إرسال هذا الطلب. حدّثي الصفحة ثم أعيدي المحاولة.',
} as const
