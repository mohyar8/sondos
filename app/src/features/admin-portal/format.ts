/**
 * Admin display formatters. Western digits everywhere (03-design-system §2.3:
 * anything an admin compares, copies or types elsewhere uses 0–9), Gregorian
 * calendar, instants shown in Asia/Riyadh.
 */

const currencyFormatter = new Intl.NumberFormat('ar-SA-u-nu-latn', {
  style: 'currency',
  currency: 'SAR',
  maximumFractionDigits: 0,
})

const calendarDateFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
})

const timestampFormatter = new Intl.DateTimeFormat('ar-SA-u-nu-latn', {
  calendar: 'gregory',
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Riyadh',
})

/**
 * Control (Cc), format (Cf: every bidi mark, embedding, override and
 * isolate, and the zero-width characters), line-separator (Zl) and
 * paragraph-separator (Zp) characters: each becomes a space.
 */
const UNSAFE_DISPLAY_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
/**
 * The other default-ignorable code points, which render as nothing (the
 * Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, the combining grapheme
 * joiner U+034F, the variation selectors): removed, so a name made of them
 * reads as blank rather than as an invisible name.
 */
const INVISIBLE_DISPLAY_CHARACTERS = /\p{Default_Ignorable_Code_Point}/gu
/** A fourth and later combining mark on one letter (stacked marks). */
const EXCESS_COMBINING_MARKS = /(\p{M}{3})\p{M}+/gu

/** Shown instead of a stored name that cleans up to nothing. */
const CUSTOMER_NAME_UNAVAILABLE_LABEL = '(الاسم غير متاح)'

/**
 * A customer-supplied string (name, phone, email) as the admin UI shows it
 * (SEC-10), cleaned up the same way as the Worker's admin emails
 * (worker/email-templates.ts, sanitizePersonName). Rows stored before the
 * sign-up rules tightened may still carry invisible direction controls or
 * fillers: they are removed here, and the caller renders the result inside
 * <bdi> (or `dir="auto"`), so no stored value can reorder the Arabic text
 * around it. Blank when nothing visible is left.
 */
export function formatCustomerText(value: string): string {
  return value
    .normalize('NFC')
    .replace(UNSAFE_DISPLAY_CHARACTERS, ' ')
    .replace(INVISIBLE_DISPLAY_CHARACTERS, '')
    .replace(EXCESS_COMBINING_MARKS, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Her full name with formatCustomerText's clean-up applied to each part;
 * blank when both parts clean up to nothing.
 */
export function formatPersonName(person: {
  firstName: string
  lastName: string
}): string {
  return [person.firstName, person.lastName]
    .map(formatCustomerText)
    .filter((part) => part.length > 0)
    .join(' ')
}

/**
 * Her full name for display, or CUSTOMER_NAME_UNAVAILABLE_LABEL when the
 * stored name has nothing visible left (a legacy row made of fillers), so a
 * row, heading or dialog never shows a blank name.
 */
export function formatCustomerName(customer: {
  firstName: string
  lastName: string
}): string {
  return formatPersonName(customer) || CUSTOMER_NAME_UNAVAILABLE_LABEL
}

export function formatAdminCurrency(value: number): string {
  return currencyFormatter.format(value)
}

/** A YYYY-MM-DD calendar date (event dates are Riyadh calendar dates). */
export function formatAdminCalendarDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)

  if (!match) {
    return value
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return value
  }

  return calendarDateFormatter.format(date)
}

/** An ISO instant, shown in Riyadh time. */
export function formatAdminTimestamp(value: string): string {
  const date = new Date(value)

  return Number.isNaN(date.getTime())
    ? 'غير متوفر'
    : timestampFormatter.format(date)
}

/**
 * «طلب» with Arabic number agreement (inspection #17): 1 طلب واحد, 2 طلبان,
 * 3–10 طلبات, 11–99 طلبًا, and the singular after whole hundreds.
 */
export function formatBookingRequestCount(count: number): string {
  if (count === 0) {
    return 'لا توجد طلبات'
  }

  if (count === 1) {
    return 'طلب واحد'
  }

  if (count === 2) {
    return 'طلبان'
  }

  const remainder = count % 100

  if (remainder >= 3 && remainder <= 10) {
    return `${count} طلبات`
  }

  if (remainder >= 11) {
    return `${count} طلبًا`
  }

  return `${count} طلب`
}
