/**
 * Arabic counted nouns with Western digits — the number-agreement table of
 * 08-copy-ar §4.3, written once so no screen hard-codes one form for every
 * number (the «١ صفحات» / «{n} طلبات» bugs of inspection item 17).
 *
 * | count  | form            |
 * |--------|-----------------|
 * | 1      | يوم واحد        |
 * | 2      | يومان           |
 * | 3–10   | {n} أيام        |
 * | 11–99  | {n} يومًا       |
 * | 0, 100+| {n} يوم         |
 */

export type ArabicCountUnit =
  | 'day'
  | 'hour'
  | 'minute'
  | 'photo'
  | 'request'
  | 'page'
  | 'copy'

interface ArabicCountForms {
  readonly one: string
  readonly two: string
  /** 3–10: plural. */
  readonly few: string
  /** 11–99: singular accusative (tamyiz). */
  readonly many: string
  /** 0 and 100+: singular. */
  readonly other: string
}

const countForms: Readonly<Record<ArabicCountUnit, ArabicCountForms>> = {
  day: { one: 'يوم واحد', two: 'يومان', few: 'أيام', many: 'يومًا', other: 'يوم' },
  hour: {
    one: 'ساعة واحدة',
    two: 'ساعتان',
    few: 'ساعات',
    many: 'ساعة',
    other: 'ساعة',
  },
  minute: {
    one: 'دقيقة واحدة',
    two: 'دقيقتان',
    few: 'دقائق',
    many: 'دقيقة',
    other: 'دقيقة',
  },
  photo: { one: 'صورة واحدة', two: 'صورتان', few: 'صور', many: 'صورة', other: 'صورة' },
  request: {
    one: 'طلب واحد',
    two: 'طلبان',
    few: 'طلبات',
    many: 'طلبًا',
    other: 'طلب',
  },
  page: {
    one: 'صفحة واحدة',
    two: 'صفحتان',
    few: 'صفحات',
    many: 'صفحة',
    other: 'صفحة',
  },
  copy: { one: 'نسخة واحدة', two: 'نسختان', few: 'نسخ', many: 'نسخة', other: 'نسخة' },
}

/**
 * `count` with its noun in the right form, digits Western (0–9). A count
 * that is not a non-negative safe integer is clamped to 0, so the result
 * never reads NaN or Infinity.
 */
export function formatArabicCount(count: number, unit: ArabicCountUnit): string {
  const value = Number.isSafeInteger(count) && count >= 0 ? count : 0
  const forms = countForms[unit]

  if (value === 1) {
    return forms.one
  }

  if (value === 2) {
    return forms.two
  }

  if (value >= 3 && value <= 10) {
    return `${value} ${forms.few}`
  }

  if (value >= 11 && value <= 99) {
    return `${value} ${forms.many}`
  }

  return `${value} ${forms.other}`
}
