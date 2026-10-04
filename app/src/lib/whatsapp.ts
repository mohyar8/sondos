import { toAsciiDigits } from './ascii-digits'

/**
 * WhatsApp contact — the studio's number, the pre-filled messages and the one
 * builder of wa.me links on the site (TM-19). Display rule (03-design-system
 * §2.3): a number inside Arabic text is shown in Western digits and wrapped
 * in `<bdi dir="ltr">` so the digit run never gets bidi-reordered.
 */

/** E.164 digits without the leading "+", as wa.me expects. */
export const WHATSAPP_INTERNATIONAL_NUMBER = '966505647418'

/** Local format shown to visitors. */
export const WHATSAPP_DISPLAY_NUMBER = '0505647418'

/*
 * Both numbers above are compiled into the bundle on purpose: no admin
 * session and no API response can change them, only a deploy. So they are
 * the fallback when the API reports no valid studio number, and the number
 * quoted to customers as the check for 72 h after the studio number changes
 * (TM-03/TM-19).
 */

/** General pre-booking inquiry (08-copy-ar §7, first row). */
export const DEFAULT_INQUIRY_MESSAGE =
  'مرحبًا، أرغب في الاستفسار عن توفر موعد لتصوير عرس مع المصورة سندس يار.'

/** Inquiry sent from the portfolio page (08-copy-ar §7, second row). */
export const PORTFOLIO_INQUIRY_MESSAGE =
  'مرحبًا، أعجبتني أعمال المصورة سندس يار وأحببتُ معرفة تفاصيل الحجز.'

/**
 * Sent to the compiled number from the "studio number changed" notice: she
 * asks the number she can already trust about the new one (TM-03/TM-19).
 */
export const NUMBER_CHANGE_CHECK_MESSAGE =
  'السلام عليكم، رأيتُ أن رقم التواصل مع المصورة سندس يار تغيّر، وأحببتُ التأكد من الرقم الجديد.'

/**
 * Longest pre-filled message, in code points (TM-19). Well above any planned
 * message, even one quoting the pickup address (at most 300) and the pickup
 * instructions (at most 500), while keeping the link a bounded size.
 */
export const WHATSAPP_MESSAGE_MAX_LENGTH = 1500

const WA_ME_BASE_URL = 'https://wa.me/'

/** Mirrors the Worker's bound on a phone input (worker/profile.ts). */
const PHONE_INPUT_MAX_LENGTH = 32

const E164_DIGITS = /^[1-9]\d{7,14}$/

/** A Saudi number is 966 and a 9-digit national number. */
const SAUDI_E164_DIGITS = /^966[1-9]\d{8}$/

/**
 * What people type or paste around a number: spaces, dashes, brackets, dots
 * and the invisible direction marks a copied number comes wrapped in (one
 * copied from WhatsApp often arrives between U+202A and U+202C). Only these
 * are removed; any other character makes the number invalid.
 */
const PHONE_FORMATTING =
  /[-\s().\u2010-\u2015\u2212\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

/** Bidi marks, embeddings, overrides and isolates. */
const DIRECTION_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

/**
 * Embeddings and overrides (LRE, RLE, PDF, LRO, RLO). The site never writes
 * them (isolateLtr uses isolates), and an override can show an amount or a
 * number with its digits reversed, so a message never carries one (SB-6).
 */
const EMBEDDINGS_AND_OVERRIDES = /[\u202A-\u202E]/g

/**
 * Control characters and the line and paragraph separators. A paragraph
 * separator ends every isolate, so none may sit inside an isolated run.
 */
const CONTROLS_AND_SEPARATORS = /[\p{Cc}\u2028\u2029]/gu

/** Half of a surrogate pair on its own; encodeURIComponent throws on it. */
const LONE_SURROGATE = /\p{Cs}/gu

const LEFT_TO_RIGHT_ISOLATE = '\u2066'
const POP_DIRECTIONAL_ISOLATE = '\u2069'

/**
 * A number the API has already normalised (the studio's contact revision, a
 * queue item's `waDigits`): E.164 digits without the "+". It is checked as
 * it is and never read as a number a person typed, because `5XXXXXXXX` is
 * both a typed Saudi mobile and a whole E.164 number of another country.
 */
export interface StoredWhatsAppNumber {
  readonly e164Digits: string
}

/** Why no link was built. */
export type WhatsAppLinkIssue = 'invalid_number' | 'message_too_long'

/**
 * A link, or the reason there is none: the screen then shows a disabled
 * button with `reason` next to it, never a link that opens the wrong chat.
 */
export type WhatsAppLinkResult =
  | { readonly ok: true; readonly href: string }
  | {
      readonly ok: false
      readonly issue: WhatsAppLinkIssue
      readonly reason: string
    }

const linkIssueReasons: Record<WhatsAppLinkIssue, string> = {
  invalid_number: 'تعذّر فتح محادثة واتساب لأن رقم الجوال غير صالح.',
  message_too_long:
    'تعذّر فتح محادثة واتساب لأن الرسالة الجاهزة أطول من الحد المسموح.',
}

/** Adds the country code to the forms that are written without it. */
function withCountryCode(compactNumber: string): string {
  const international = /^(?:\+|00)(\d+)$/.exec(compactNumber)

  if (international) {
    return international[1]
  }

  if (/^05\d{8}$/.test(compactNumber)) {
    return `966${compactNumber.slice(1)}`
  }

  if (/^5\d{8}$/.test(compactNumber)) {
    return `966${compactNumber}`
  }

  return compactNumber
}

/** E.164 digits, and a whole Saudi number when they start with 966. */
function isE164Digits(digits: string): boolean {
  return (
    E164_DIGITS.test(digits) &&
    (!digits.startsWith('966') || SAUDI_E164_DIGITS.test(digits))
  )
}

/**
 * The E.164 digits wa.me expects for a number a person typed, or null.
 * Accepts an E.164 number with or without `+`/`00` (`+9665…`, `009665…`,
 * `9665…`) and the Saudi mobile forms `05…` and `5…`, in Western,
 * Arabic-Indic or Persian digits (the scripts toAsciiDigits maps; any other
 * digit gives null). Letters, `?`, `=`, `/`, `#` or a `+` anywhere but first
 * are refused, never stripped, so `966500000000?text=x` gives null (N-21).
 * Digits the API sends go through fromE164Digits instead: read here, a
 * stored `508411234` would become the Saudi `966508411234`.
 */
export function toWaMeDigits(value: string): string | null {
  if (value.length > PHONE_INPUT_MAX_LENGTH) {
    return null
  }

  let digits = withCountryCode(
    toAsciiDigits(value).replace(PHONE_FORMATTING, ''),
  )

  // «+966 05…»: the national 0 never follows the country code.
  if (/^9660\d{9}$/.test(digits)) {
    digits = `966${digits.slice(4)}`
  }

  return isE164Digits(digits) ? digits : null
}

/**
 * The digits of a number the API has already normalised, unchanged, or null.
 * No formatting is removed, no digit script mapped and no country code
 * added, so the result is always the number the server stored.
 */
export function fromE164Digits(value: string): string | null {
  return isE164Digits(value) ? value : null
}

function exceedsMessageCap(text: string): boolean {
  if (text.length <= WHATSAPP_MESSAGE_MAX_LENGTH) {
    return false
  }

  // A code point is at most two UTF-16 units.
  if (text.length > WHATSAPP_MESSAGE_MAX_LENGTH * 2) {
    return true
  }

  return Array.from(text).length > WHATSAPP_MESSAGE_MAX_LENGTH
}

/** `?text=…` for a message, '' when it is empty, null when it is too long. */
function textQuery(message: string): string | null {
  const text = message
    .replace(LONE_SURROGATE, '\uFFFD')
    .replace(EMBEDDINGS_AND_OVERRIDES, '')
    .trim()

  if (text.length === 0) {
    return ''
  }

  if (exceedsMessageCap(text)) {
    return null
  }

  return `?text=${encodeURIComponent(text)}`
}

/**
 * Builds a wa.me link that opens a chat with the studio. The message is only
 * pre-filled — WhatsApp never sends it without the customer's action. A
 * message over the cap is left out rather than cut, so the chat still opens.
 */
export function buildWhatsAppUrl(message: string): string {
  return `${WA_ME_BASE_URL}${WHATSAPP_INTERNATIONAL_NUMBER}${textQuery(message) ?? ''}`
}

/**
 * Builds a wa.me link to any number: the admin writing to a customer, or a
 * customer writing to the studio's current number. A string is a number a
 * person typed (or a stored `+…` phone) and goes through toWaMeDigits; a
 * StoredWhatsAppNumber goes through fromE164Digits. The message goes
 * through encodeURIComponent, so neither can change the host, the path or
 * add a parameter.
 */
export function buildWhatsAppUrlFor(
  number: string | StoredWhatsAppNumber,
  message: string,
): WhatsAppLinkResult {
  const digits =
    typeof number === 'string'
      ? toWaMeDigits(number)
      : fromE164Digits(number.e164Digits)

  if (digits === null) {
    return {
      ok: false,
      issue: 'invalid_number',
      reason: linkIssueReasons.invalid_number,
    }
  }

  const query = textQuery(message)

  if (query === null) {
    return {
      ok: false,
      issue: 'message_too_long',
      reason: linkIssueReasons.message_too_long,
    }
  }

  return { ok: true, href: `${WA_ME_BASE_URL}${digits}${query}` }
}

/**
 * The studio number a customer's link opens: the one the API reports (the
 * effective contact revision, stored E.164 digits), else the compiled
 * number. Pass the result to buildWhatsAppUrlFor as it is.
 */
export function resolveStudioWhatsAppNumber(
  reportedNumber: string | null | undefined,
): StoredWhatsAppNumber {
  return {
    e164Digits:
      (reportedNumber ? fromE164Digits(reportedNumber) : null) ??
      WHATSAPP_INTERNATIONAL_NUMBER,
  }
}

/**
 * Keeps a left-to-right run (a reference, an amount, a number) in order
 * inside plain Arabic text such as a WhatsApp message, where `<bdi>` does not
 * exist. Direction controls inside the value are removed and line breaks
 * become spaces first, so it can neither close the isolate early nor reorder
 * the text around it (SB-6).
 */
export function isolateLtr(value: string): string {
  const run = value
    .replace(DIRECTION_CONTROLS, '')
    .replace(CONTROLS_AND_SEPARATORS, ' ')

  return `${LEFT_TO_RIGHT_ISOLATE}${run}${POP_DIRECTIONAL_ISOLATE}`
}

/** Ready-made link for the general inquiry message. */
export const DEFAULT_WHATSAPP_URL = buildWhatsAppUrl(DEFAULT_INQUIRY_MESSAGE)

/** The check quoted beside the "studio number changed" notice. */
export const NUMBER_CHANGE_CHECK_URL = buildWhatsAppUrl(
  NUMBER_CHANGE_CHECK_MESSAGE,
)
