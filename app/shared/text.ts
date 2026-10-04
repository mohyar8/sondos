/**
 * The single home of text rules (TM-12, TM-04, UX-07; plan R-07), shared by
 * the Worker, which has the final word, and the SPA, which shows the same
 * verdict on the field. Pure functions: no I/O, no logging, no state.
 *
 * - toAsciiDigits: Arabic-Indic and Persian digits to ASCII, before any
 *   digit validation.
 * - normalizeFreeText: every free-text field (SB-16).
 * - findPaymentInstructionLike: every admin-authored text a customer sees
 *   (SB-17), after normalizeFreeText.
 * - normalizePersonName: first and last names (audit SEC-10).
 */

/**
 * An Arabic keyboard types Arabic-Indic (U+0660-0669) or Extended
 * Arabic-Indic, i.e. Persian (U+06F0-06F9), digits. Maps both to ASCII so a
 * phone number, an IBAN, a time or an authenticator code typed that way
 * passes validation and reaches the API in the form it expects. Nothing else
 * changes.
 */
export function toAsciiDigits(value: string): string {
  return value
    .replace(/[\u0660-\u0669]/g, (digit) =>
      String(digit.charCodeAt(0) - 0x0660),
    )
    .replace(/[\u06F0-\u06F9]/g, (digit) =>
      String(digit.charCodeAt(0) - 0x06f0),
    )
}

/** Length in code points, the unit of SQLite's length() on TEXT. */
export function countCodePoints(value: string): number {
  return Array.from(value).length
}

/**
 * A character free text must never carry (TM-12): control characters (Cc:
 * C0, DEL and C1; the line feed is allowed separately for multi-line
 * fields), format characters (Cf: the bidi marks, embeddings, overrides and
 * isolates U+061C, U+200E/F, U+202A-E, U+2066-9, the zero-width space
 * U+200B, the word joiner U+2060, the byte-order mark U+FEFF, the soft
 * hyphen, tag characters), lone surrogates (Cs), the line and paragraph
 * separators U+2028/9 (Zl, Zp) and every other default-ignorable code point
 * (the Hangul fillers that pass for letters, the combining grapheme joiner,
 * the variation selectors), and the symbols that draw a blank, which read
 * as a space while no space rule sees them (U+2800 BRAILLE PATTERN BLANK,
 * U+1D159 MUSICAL SYMBOL NULL NOTEHEAD). Kept: ZWNJ and ZWJ, which Arabic,
 * Persian and emoji need, and the text/emoji presentation selectors
 * U+FE0E/U+FE0F. The kept characters are an alternation, not a class: a
 * class holding a joiner or a selector reads as one joined character.
 */
const FORBIDDEN_TEXT_CHARACTER =
  /(?!\n|\u200C|\u200D|\uFE0E|\uFE0F)[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800\u{1D159}]/u
/**
 * More than four combining marks on one character: stacked ("Zalgo") marks
 * that paint over the text around them. Counted on the decomposed (NFD)
 * form, so a precomposed letter counts its own mark; a ZWNJ or ZWJ between
 * two marks starts no new character, so it does not end the count. Arabic
 * harakat with shadda stay well within it.
 */
const EXCESS_COMBINING_MARKS = /\p{M}(?:[\u200C\u200D]*\p{M}){4}/u
/**
 * What shows nothing on its own: spaces and line breaks, combining marks
 * (the presentation selectors among them) and the joiners. A value must
 * hold something else, and only the rest counts towards its minimum.
 */
const SHOWS_NOTHING = /[\s\p{M}\u200C\u200D]/gu
const LINE_BREAKS = /\r\n?/g
const SPACE_RUN = /\p{Zs}+/gu

/**
 * - `single-line`: one line; a line break is refused.
 * - `multi-line`: CRLF and CR become LF; LF is allowed.
 * - `name`: one line, runs of spaces become one space, and a link, a
 *   domain or an `@` anywhere is refused (N-41). For names that are not a
 *   person's first or last name (normalizePersonName), e.g. the bank
 *   account holder or a delivery-area name.
 */
export type FreeTextKind = 'single-line' | 'multi-line' | 'name'

export interface FreeTextRule {
  readonly kind: FreeTextKind
  /** The longest accepted value in code points: the column's DB CHECK. */
  readonly maxCodePoints: number
  /**
   * The shortest accepted value, counted in the code points that show
   * something (not spaces, combining marks or joiners), so a value that
   * meets it meets the DB CHECK's minimum too; default 1. With 0 a value
   * that shows nothing is accepted as ''.
   */
  readonly minCodePoints?: number
}

export type FreeTextProblem =
  | 'not-text'
  | 'empty'
  | 'too-short'
  | 'too-long'
  | 'forbidden-character'
  | 'link-or-handle'

export type FreeTextResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: FreeTextProblem }

function freeTextProblem(problem: FreeTextProblem): FreeTextResult {
  return { ok: false, problem }
}

/**
 * Validates and normalises one free-text value (SB-16): NFC, line breaks
 * per the rule's kind, no forbidden character (checked before trimming, so
 * a leading U+FEFF or trailing U+2028 is refused, not silently dropped),
 * trimmed, then the bounds: a value of joiners, selectors or marks alone
 * is empty like a blank one. The value to store is `value`; a handler
 * maps 'forbidden-character' and 'link-or-handle' to 400 INVALID_TEXT,
 * 'too-long' to its length error and 'not-text' to 400
 * INVALID_REQUEST_BODY.
 *
 * Throws a RangeError for a rule without positive integer bounds: a
 * programming error must not turn into "no limit".
 */
export function normalizeFreeText(
  value: unknown,
  rule: FreeTextRule,
): FreeTextResult {
  const minimum = rule.minCodePoints ?? 1

  if (
    !Number.isInteger(rule.maxCodePoints) ||
    rule.maxCodePoints < 1 ||
    !Number.isInteger(minimum) ||
    minimum < 0 ||
    minimum > rule.maxCodePoints
  ) {
    throw new RangeError('Invalid free-text rule')
  }

  if (typeof value !== 'string') {
    return freeTextProblem('not-text')
  }

  const multiline = rule.kind === 'multi-line'
  const composedValue = multiline
    ? value.normalize('NFC').replace(LINE_BREAKS, '\n')
    : value.normalize('NFC')

  if (
    FORBIDDEN_TEXT_CHARACTER.test(composedValue) ||
    (!multiline && composedValue.includes('\n')) ||
    EXCESS_COMBINING_MARKS.test(composedValue.normalize('NFD'))
  ) {
    return freeTextProblem('forbidden-character')
  }

  const trimmedValue =
    rule.kind === 'name'
      ? composedValue.trim().replace(SPACE_RUN, ' ')
      : composedValue.trim()
  const visibleLength = countCodePoints(trimmedValue.replace(SHOWS_NOTHING, ''))

  if (visibleLength === 0) {
    return minimum === 0
      ? { ok: true, value: '' }
      : freeTextProblem('empty')
  }

  if (visibleLength < minimum) {
    return freeTextProblem('too-short')
  }

  if (countCodePoints(trimmedValue) > rule.maxCodePoints) {
    return freeTextProblem('too-long')
  }

  if (rule.kind === 'name') {
    const detectionForm = toDetectionForm(trimmedValue)

    if (detectionForm.includes('@') || containsLinkLike(detectionForm)) {
      return freeTextProblem('link-or-handle')
    }
  }

  return { ok: true, value: trimmedValue }
}

/**
 * Removed before matching: format and default-ignorable characters
 * (including the ZWNJ/ZWJ free text keeps), combining marks and the
 * tatweel, so none of them can split a digit run, a domain or a top-level
 * domain ("wa\u200C.me", "055\u200D1234567", "055ـ1234567").
 */
const DETECTION_INVISIBLE =
  /[\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}\u0640]/gu
/**
 * Read as a plain space: every space separator and the symbols that draw a
 * blank. Free text refuses the symbols; the detectors do not rely on it.
 */
const DETECTION_BLANK = /[\p{Zs}\u2800\u{1D159}]/gu
/**
 * Digits NFKC leaves as symbols: the negative and double circled ones
 * (⓫-⓿, ❶-➓, 🄋, 🄌) and the numbers on black squares (㉈-㉏).
 */
const SYMBOL_DIGIT =
  /[\u24EB-\u24FF\u2776-\u2793\u3248-\u324F\u{1F10B}\u{1F10C}]/gu
/**
 * An Arabic-Indic or Persian zero between a letter and a Latin letter
 * ("sundus٠com"): it draws a dot there, and no number is written that way.
 */
const ZERO_AS_STOP = /(?<=[\p{L}-])[\u0660\u06F0](?=[a-z])/gu

/** The digits a SYMBOL_DIGIT character stands for. */
function toSymbolDigits(symbol: string): string {
  const codePoint = symbol.codePointAt(0) ?? 0

  if (codePoint >= 0x2776 && codePoint <= 0x2793) {
    // Three sets of one to ten: ❶-❿, ➀-➉, ➊-➓.
    return String(((codePoint - 0x2776) % 10) + 1)
  }

  if (codePoint >= 0x24eb && codePoint <= 0x24f4) {
    return String(codePoint - 0x24eb + 11)
  }

  if (codePoint >= 0x24f5 && codePoint <= 0x24fe) {
    return String(codePoint - 0x24f5 + 1)
  }

  if (codePoint >= 0x3248 && codePoint <= 0x324f) {
    return String((codePoint - 0x3247) * 10)
  }

  // ⓿, 🄋 and 🄌.
  return '0'
}

/**
 * The form the detectors read, never stored: NFKC (fullwidth, circled and
 * mathematical digits and letters become plain ones, Arabic presentation
 * forms become letters; U+FF0E and U+2024 become '.'), lower case,
 * invisible characters, marks and the tatweel removed, blanks as spaces,
 * the digit symbols NFKC keeps as digits, a zero drawn as a stop as '.',
 * Arabic-Indic and Persian digits in ASCII.
 */
function toDetectionForm(text: string): string {
  return toAsciiDigits(
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(DETECTION_INVISIBLE, '')
      .replace(DETECTION_BLANK, ' ')
      .replace(SYMBOL_DIGIT, toSymbolDigits)
      .replace(ZERO_AS_STOP, '.'),
  )
}

/**
 * A full stop, the ideographic one browsers also accept, and the dots that
 * pass for one (middle dots, bullets, the katakana, word-separator, runic,
 * Canadian-syllabics and Lisu dots, the Urdu full stop): a class body.
 */
const STOP_CHARACTERS = String.raw`.\u3002\u00B7\u2022\u2027\u2219\u22C5\u30FB\u2E31\u2E33\u16EB\u1427\uA4F8\u06D4`
const STOP = `[${STOP_CHARACTERS}]`
/** A slash, a backslash (browsers read ':\\' as '://') or a look-alike. */
const SLASH = String.raw`[/\\\u2044\u2215\u2216\u29F8\u29F9\u2571\u2572]`
/**
 * '://' with a colon or slash look-alike, spaces around the slashes and a
 * closing bracket after the colon ("https[:]//") allowed.
 */
const URL_SCHEME_SEPARATOR = new RegExp(
  String.raw`[:\u2236\uA789\u02D0\u05C3][\s\])}]*${SLASH}\s*${SLASH}`,
  'u',
)
/** "www" as a word of its own: "www.", "www . x", "www[.]x". */
const WWW_PREFIX = /(?<![a-z])www(?![a-z])/
/**
 * The start of a top-level domain: two Latin letters. Cyrillic and Greek
 * letters count as Latin here, since a look-alike reads, and is typed back,
 * as the Latin one.
 */
const LATIN_TLD_START = String.raw`[a-z\p{Script=Cyrillic}\p{Script=Greek}]{2}`
/**
 * A domain: a letter, digit or hyphen, a stop, then the start of a
 * top-level domain. The label before the stop may be in any script (an
 * Arabic label under .com). Anchored on the stop, so it stays linear on a
 * long run of letters. Covers wa.me, t.me, bit.ly, e-mail addresses and IDN
 * (xn--) domains.
 */
const DOMAIN_LIKE = new RegExp(
  String.raw`(?<=[\p{L}\p{N}-])${STOP}${LATIN_TLD_START}`,
  'u',
)
/**
 * Arabic-script country-code top-level domains of the region, and the
 * Arabic generic .كوم and .عرب, as registered. A domain under one of them
 * ("سندس.السعودية") is as easy to type back on an Arabic keyboard as a Latin
 * one. Only a whole TLD straight after a stop counts, so a stop typed
 * without a space before an ordinary word passes; .موقع and .شبكة are left
 * out because both words often start a sentence ("…بكم.موقع الاستوديو").
 */
const ARABIC_SCRIPT_TLDS = [
  'السعودية',
  'امارات',
  'البحرين',
  'قطر',
  'عمان',
  'اليمن',
  'عراق',
  'الاردن',
  'فلسطين',
  'سورية',
  'سوريا',
  'مصر',
  'سودان',
  'الجزائر',
  'المغرب',
  'تونس',
  'موريتانيا',
  'ایران',
  'ايران',
  'پاکستان',
  'بھارت',
  'مليسيا',
  'كوم',
  'عرب',
]
const ARABIC_SCRIPT_TLD = String.raw`(?:${ARABIC_SCRIPT_TLDS.join('|')})(?![\p{L}\p{N}])`
const ARABIC_SCRIPT_DOMAIN = new RegExp(
  String.raw`(?<=[\p{L}\p{N}])${STOP}${ARABIC_SCRIPT_TLD}`,
  'u',
)
/**
 * Top-level domains read after a stop that has a space after it only
 * ("sundus-pay. com", "bit. ly"), where any other word reads as the start
 * of a sentence.
 */
const COMMON_TLDS = [
  'com',
  'net',
  'org',
  'sa',
  'me',
  'ly',
  'io',
  'co',
  'app',
  'link',
  'store',
  'shop',
  'site',
  'online',
  'info',
  'biz',
  'xyz',
  'top',
  'pro',
  'vip',
  'cc',
  'tv',
  'ws',
  'gg',
  'ai',
  'ae',
  'qa',
  'kw',
  'bh',
  'om',
  'eg',
  'jo',
  'page',
  'live',
  'club',
  'click',
  'pay',
  'bio',
  'one',
  'tech',
  'cloud',
  'icu',
  'cfd',
  'sbs',
  'lol',
  'cam',
]
const COMMON_TLD = String.raw`(?:${COMMON_TLDS.join('|')})(?![\p{L}\p{N}])`
const ANY_TLD = `(?:${LATIN_TLD_START}|${ARABIC_SCRIPT_TLD})`
/**
 * The stop spelled as a word: "dot", «دوت» (with a damma, which the
 * detection form drops, «دت») and «نقطة».
 */
const SPELLED_STOP = '(?:dot|دوت|دت|نقطة|نقطه)'
/**
 * Latin top-level domains as Arabic writes them after a spelled stop
 * («دوت نت», «نقطة أورج»); «كوم» is among the registered ones above.
 */
const SPOKEN_TLDS = ['نت', 'اورج', 'أورج']
/** What a spelled stop reads as the end of a domain: any of the lists above. */
const SPELLED_TLD = String.raw`(?:${[...COMMON_TLDS, ...ARABIC_SCRIPT_TLDS, ...SPOKEN_TLDS].join('|')})(?![\p{L}\p{N}])`
/**
 * A domain whose stop is written apart from its label (a letter, digit or
 * hyphen before it): a bracketed stop or spelled stop ("sundus-pay[.]com",
 * "x (.) sa", "x <dot> com", «x (نقطة) com», «x[دوت]كوم») or a space
 * before the stop ("x . com", "wa .me"), then any top-level domain or an
 * Arabic-written one; a space after the stop only ("wa. me", "bit. ly"),
 * then a common one; a spelled stop between spaces ("x dot com",
 * «x دوت كوم», «x نقطة نت»), then a common, an Arabic-script or an
 * Arabic-written one. A spelled stop followed by any other word
 * («نقطة تجمع») passes.
 */
const SPACED_DOMAIN = new RegExp(
  String.raw`(?<=[\p{L}\p{N}-])(?:\s*[\[({<]\s*(?:${STOP}|${SPELLED_STOP})\s*[\])}>]\s*(?:${ANY_TLD}|${SPELLED_TLD})|\s+${STOP}\s*${ANY_TLD}|${STOP}\s+${COMMON_TLD}|\s+${SPELLED_STOP}\s+${SPELLED_TLD})`,
  'u',
)
/** A bare IPv4 address ("45.33.2.10/pay"), which a browser opens as typed. */
const IPV4_LIKE = new RegExp(
  String.raw`(?<![\p{N}${STOP_CHARACTERS}])[0-9]{1,3}(?:[^\S\n]*${STOP}[^\S\n]*[0-9]{1,3}){3}(?!\p{N})`,
  'u',
)
/**
 * A social-media or messenger handle: '@', then a letter, digit or '_',
 * with anything but those (or another '@') allowed in between ("@ x",
 * "@-x").
 */
const HANDLE_LIKE = /@[^\p{L}\p{N}_@]*[\p{L}\p{N}_]/u

function containsLinkLike(detectionForm: string): boolean {
  return (
    URL_SCHEME_SEPARATOR.test(detectionForm) ||
    WWW_PREFIX.test(detectionForm) ||
    DOMAIN_LIKE.test(detectionForm) ||
    SPACED_DOMAIN.test(detectionForm) ||
    ARABIC_SCRIPT_DOMAIN.test(detectionForm) ||
    IPV4_LIKE.test(detectionForm)
  )
}

/** Between two characters of an IBAN-like token: no letter or digit. */
const IBAN_GAP = String.raw`[^\p{L}\p{N}]*`
/**
 * TM-04 (a): "SA", two check digits and ten or more letters or digits,
 * with anything but a letter or digit (spaces, dashes, slashes, stops,
 * commas, symbols…) anywhere in between. The gap and the characters do
 * not overlap, so matching stays linear.
 */
const IBAN_LIKE = new RegExp(
  String.raw`s${IBAN_GAP}a${IBAN_GAP}[0-9]${IBAN_GAP}[0-9](?:${IBAN_GAP}[0-9a-z]){10,}`,
  'u',
)
/**
 * A letter that ends a digit run: an Arabic- or Latin-script letter (Lu,
 * Ll, Lt or Lo), except those that pass for a stroke between two digit
 * groups: alef and alef wasla, l, i (and I), ı, ɩ, ɪ and the click
 * letters ǀ ǁ ǂ ǃ.
 */
const RUN_ENDING_LETTER = String.raw`(?=[\p{Lu}\p{Ll}\p{Lt}\p{Lo}])(?![اٱliıɩɪǀ-ǃ])[\p{Script=Arabic}\p{Script=Latin}]`
/** Between two digit groups of one run: anything but a digit or such a letter. */
const RUN_SEPARATOR = String.raw`(?:(?!${RUN_ENDING_LETTER})\P{Nd})`
/**
 * Digits grouped the way phone and account numbers are written, or
 * disguised: anything but a digit or a word's letter joins two groups
 * (spaces, line breaks, dashes, stops, slashes, commas, colons, brackets,
 * symbols, emoji, modifier letters, other scripts' letters and the
 * stroke-like letters above), so "055/123/4567", "055·123·4567" and
 * "055ا123ا4567" are one run and a word between two numbers ends it. Any
 * script's decimal digits count. A '+' before the first digit belongs to
 * the run, with separators but no other '+' between. The classes do not
 * overlap, so matching stays linear.
 */
const DIGIT_RUN = new RegExp(
  String.raw`(?:\+(?:(?!\+)${RUN_SEPARATOR})*)?\p{Nd}+(?:${RUN_SEPARATOR}+\p{Nd}+)*`,
  'gu',
)
const NON_DIGIT = /\P{Nd}/gu
/** One group of a run's digits and the separators written before it. */
const DIGIT_GROUP = /(\P{Nd}*)(\p{Nd}+)/gu
/** Nine digits starting like a mobile (5…) or unified (9200…) number. */
const NINE_DIGIT_PHONE_START = /^[59]/
const NOT_ASCII_DIGIT = /[^0-9]/g
const STUDIO_NUMBER_PATTERN = /^[0-9]{8,15}$/

/**
 * A number as international digits, Saudi Arabia assumed for a national
 * one: 00… drops the 00, 9660… drops the 0 people add after +966, a
 * ten-digit 0… becomes 966…, a nine-digit 5… (a mobile number without its
 * 0) becomes 9665….
 */
function toInternationalDigits(digits: string): string {
  if (digits.startsWith('00')) {
    return digits.slice(2)
  }

  if (digits.startsWith('9660')) {
    return `966${digits.slice(4)}`
  }

  if (digits.length === 10 && digits.startsWith('0')) {
    return `966${digits.slice(1)}`
  }

  if (digits.length === 9 && digits.startsWith('5')) {
    return `966${digits}`
  }

  return digits
}

/** The studio's number as international digits, or null (none allowed). */
function toStudioNumber(studioDigits: string | null): string | null {
  if (studioDigits === null) {
    return null
  }

  const candidate = toInternationalDigits(
    toAsciiDigits(studioDigits).replace(NOT_ASCII_DIGIT, ''),
  )
  return STUDIO_NUMBER_PATTERN.test(candidate) ? candidate : null
}

function isStudioNumber(digits: string, studioNumber: string | null): boolean {
  return studioNumber !== null && toInternationalDigits(digits) === studioNumber
}

type NumberKind = 'long-number' | 'phone'

function classifyDigits(digits: string, afterPlus: boolean): NumberKind | null {
  const length = countCodePoints(digits)

  if (length >= 10) {
    return 'long-number'
  }

  if (
    (length === 9 && NINE_DIGIT_PHONE_START.test(digits)) ||
    (afterPlus && length >= 7)
  ) {
    return 'phone'
  }

  return null
}

interface DigitLine {
  digits: string
  /** A '+' is written before its first digit. */
  readonly afterPlus: boolean
}

/**
 * The digits of a run, one entry per line: a separator holding a line
 * break starts a new line, and the separators before a line's first
 * digit (on the line before, too) tell whether a '+' leads it.
 */
function toDigitLines(run: string): DigitLine[] {
  const digitLines: DigitLine[] = []

  for (const group of run.matchAll(DIGIT_GROUP)) {
    const separators = group[1]
    const digits = group[2]
    const current =
      digitLines.length > 0 && !separators.includes('\n')
        ? digitLines[digitLines.length - 1]
        : null

    if (current === null) {
      digitLines.push({ digits, afterPlus: separators.includes('+') })
    } else {
      current.digits += digits
    }
  }

  return digitLines
}

/**
 * The first account- or phone-like digit run. The studio's own number is
 * allowed as a whole run or as a whole line of one; the digits on the
 * other lines are judged together. So her number on one line and a time
 * on the next ("…7418\n4:00") passes, while anything written on the same
 * line as her number joins it ("0505647418 12", "+44 0505647418") and does
 * not.
 */
function findNumberLike(
  detectionForm: string,
  studioNumber: string | null,
): NumberKind | null {
  for (const run of detectionForm.matchAll(DIGIT_RUN)) {
    if (isStudioNumber(run[0].replace(NON_DIGIT, ''), studioNumber)) {
      continue
    }

    let pending = ''
    let pendingAfterPlus = false

    for (const line of toDigitLines(run[0])) {
      if (isStudioNumber(line.digits, studioNumber)) {
        const found = classifyDigits(pending, pendingAfterPlus)

        if (found !== null) {
          return found
        }

        pending = ''
        continue
      }

      if (pending === '') {
        pendingAfterPlus = line.afterPlus
      }

      pending += line.digits

      // Pending only grows until it is judged, so ten digits decide it.
      if (countCodePoints(pending) >= 10) {
        return 'long-number'
      }
    }

    const found = classifyDigits(pending, pendingAfterPlus)

    if (found !== null) {
      return found
    }
  }

  return null
}

/** What findPaymentInstructionLike found. */
export type PaymentInstructionKind =
  | 'hidden-character'
  | 'link'
  | 'handle'
  | 'iban'
  | NumberKind

/**
 * TM-04 / SB-17: payment instructions belong only in the bank section, so
 * admin-authored text a customer sees (pickup address and instructions,
 * delivery-area names, terms body and summary, receipt rejection reasons,
 * any note shown to her) must not carry:
 * - a forbidden character (the free-text rule with line breaks allowed,
 *   U+2800 included), in case a caller skipped normalizeFreeText;
 * - a link: '://', 'www', a domain (wa.me, t.me, bit.ly, x.com…, with a
 *   dot look-alike too; with its stop bracketed, spelled "dot" or spaced:
 *   "x[.]com", "x . com", "wa. me"; an Arabic-script TLD such as
 *   .السعودية), a bare IPv4 address, or an @-handle;
 * - an IBAN-like token (TM-04's pattern, any non-alphanumeric separators);
 * - a run of ten or more digits (account numbers, and phone numbers in
 *   every Saudi form: 05…, 9665…, +9665…, 009665…), its groups joined by
 *   anything but a word's letter (DIGIT_RUN);
 * - a phone-like run below ten digits: nine digits starting with 5 (a
 *   mobile number without its 0) or 9 (a 9200… unified number), or seven or
 *   more after a '+'.
 * The studio's own number (`studioDigits`, e.g. the effective WhatsApp
 * number as E.164 digits) is allowed in any of the forms above, as a whole
 * run or a whole line of one (findNumberLike); null or an unusable value
 * allows none.
 *
 * Numbers with only symbols between them join, so a list or range with no
 * word in it ("1500 / 2500 / 3500", "01/10/2026 - 31/12/2026", two time
 * ranges on two lines) can reach ten digits and is refused; the admin
 * writes a word between them. That is the price of reading every
 * separator an attacker can pick.
 *
 * Returns the first kind found, or null. The text is never echoed or
 * logged; the handler answers 400 CONTENT_NOT_ALLOWED. Customer views still
 * render admin text as plain text with no autolinking: this is a tripwire
 * for a stolen admin session, not a guarantee (a number spelled out in
 * words, or with letters standing in for its digits, passes).
 */
export function findPaymentInstructionLike(
  text: string,
  studioDigits: string | null,
): PaymentInstructionKind | null {
  if (FORBIDDEN_TEXT_CHARACTER.test(text)) {
    return 'hidden-character'
  }

  const detectionForm = toDetectionForm(text)

  if (containsLinkLike(detectionForm)) {
    return 'link'
  }

  if (HANDLE_LIKE.test(detectionForm)) {
    return 'handle'
  }

  if (IBAN_LIKE.test(detectionForm)) {
    return 'iban'
  }

  return findNumberLike(detectionForm, toStudioNumber(studioDigits))
}

/**
 * Her first and last name as the sign-up and profile forms and PUT
 * /api/profile accept them (audit SEC-10). A name is shown to the admin
 * (dashboard, notification emails) and in studio-authored WhatsApp text, so
 * it must not be able to reorder the text around it, render as nothing or
 * pass for a link:
 * - NFC-normalised and trimmed; any run of spaces (including no-break
 *   spaces) becomes one ordinary space; a typographic apostrophe (U+2019
 *   as iOS types it, or U+02BC) becomes '.
 * - No control, format (bidi embeddings, overrides and isolates, marks such
 *   as U+200F or U+061C, zero-width characters, ZWJ included: stricter than
 *   normalizeFreeText, as the landed SEC-10 rule is), line-separator or
 *   paragraph-separator characters (Unicode categories Cc, Cf, Zl and Zp),
 *   and no default-ignorable code point: the Hangul fillers (U+115F,
 *   U+1160, U+3164, U+FFA0) that pass as letters, the combining grapheme
 *   joiner and the variation selectors. Checked before trimming, so a
 *   leading U+FEFF or trailing line break is refused, not dropped. The one
 *   exception is ZWNJ straight between two Arabic-script letters, as
 *   Persian names write it (N-41: نرگس, U+200C, خانم); anywhere else
 *   it is refused.
 * - One or more words of Arabic or Latin letters (Lu/Ll/Lt/Lo; no modifier
 *   letters, so look-alikes of ':', '/' and '.' such as U+02D0, U+141F and
 *   U+A4F8 cannot spell a URL; no other scripts or digits), joined by a
 *   space, a hyphen, an apostrophe or the Arabic tatweel, starting and
 *   ending with a letter. That also rules out URLs, domains, @-handles and
 *   email addresses.
 * - At most three combining marks (harakat, accents) on one letter, counted
 *   on the decomposed (NFD) form, so a precomposed 'á' counts its own mark.
 * - 1 to 80 characters.
 */

export const MAXIMUM_PERSON_NAME_LENGTH = 80

/** ZWNJ is left to NAME_PATTERN, which places it. */
const FORBIDDEN_NAME_CHARACTERS =
  /(?!\u200C)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
const TYPOGRAPHIC_APOSTROPHES = /[’ʼ]/g
const LETTER_CATEGORY = String.raw`(?=[\p{Lu}\p{Ll}\p{Lt}\p{Lo}])`
const ARABIC_NAME_LETTER = String.raw`(?:${LETTER_CATEGORY}\p{Script_Extensions=Arabic})`
const LATIN_NAME_LETTER = String.raw`(?:${LETTER_CATEGORY}\p{Script=Latin})`
const NAME_MARKS = String.raw`(?:(?=\p{M})[\p{Script=Inherited}\p{Script_Extensions=Arabic}]){0,3}`
const NAME_JOINERS = String.raw`[ '’ـ-]`
/**
 * One letter and its marks. An Arabic-script letter may end with a ZWNJ
 * when another Arabic-script letter follows it straight away.
 */
const NAME_UNIT = String.raw`(?:${ARABIC_NAME_LETTER}${NAME_MARKS}(?:\u200C(?=${ARABIC_NAME_LETTER}))?|${LATIN_NAME_LETTER}${NAME_MARKS})`
const NAME_PATTERN = new RegExp(
  `^${NAME_UNIT}(?:${NAME_JOINERS}*${NAME_UNIT})*$`,
  'u',
)

/**
 * The name to store, or null when it cannot be accepted as a name (or is
 * not a string, so the Worker can pass a parsed body value as it is).
 */
export function normalizePersonName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const composedValue = value.normalize('NFC')

  if (FORBIDDEN_NAME_CHARACTERS.test(composedValue)) {
    return null
  }

  const tidiedValue = composedValue
    .trim()
    .replace(SPACE_RUN, ' ')
    .replace(TYPOGRAPHIC_APOSTROPHES, "'")

  return tidiedValue.length > 0 &&
    countCodePoints(tidiedValue) <= MAXIMUM_PERSON_NAME_LENGTH &&
    NAME_PATTERN.test(tidiedValue.normalize('NFD'))
    ? tidiedValue
    : null
}
