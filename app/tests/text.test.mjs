// W1-10 / TM-12, TM-04, UX-07 (N-33, N-41, N-55): the shared text rules.
// Every case below fails if its control (NFC, a refused character class,
// the ZWNJ/ZWJ allowance, the code-point cap, the name link rule, a content
// rule of the payment-instruction detector, the studio-number exemption or
// the digit normaliser) is taken out of shared/text.ts.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  MAXIMUM_PERSON_NAME_LENGTH,
  countCodePoints,
  findPaymentInstructionLike,
  normalizeFreeText,
  normalizePersonName,
  toAsciiDigits,
} from '../shared/text.ts'

// Invisible characters are built from code points so none sits in the source.
const char = (codePoint) => String.fromCodePoint(codePoint)
const ZWNJ = char(0x200c)
const ZWJ = char(0x200d)
const VS15 = char(0xfe0e)
const VS16 = char(0xfe0f)
const BRAILLE_BLANK = char(0x2800)

/** Every character TM-12 names, plus the rest of the refused classes. */
const REFUSED_CHARACTERS = [
  ['NUL', 0x0000],
  ['BEL', 0x0007],
  ['TAB', 0x0009],
  ['CR alone in a single line', 0x000d],
  ['US', 0x001f],
  ['DEL', 0x007f],
  ['C1 PAD', 0x0080],
  ['C1 NEL', 0x0085],
  ['C1 APC', 0x009f],
  ['ARABIC LETTER MARK', 0x061c],
  ['LRM', 0x200e],
  ['RLM', 0x200f],
  ['LRE', 0x202a],
  ['RLE', 0x202b],
  ['PDF', 0x202c],
  ['LRO', 0x202d],
  ['RLO', 0x202e],
  ['LRI', 0x2066],
  ['RLI', 0x2067],
  ['FSI', 0x2068],
  ['PDI', 0x2069],
  ['ZERO WIDTH SPACE', 0x200b],
  ['WORD JOINER', 0x2060],
  ['INVISIBLE TIMES', 0x2062],
  ['BOM', 0xfeff],
  ['LINE SEPARATOR', 0x2028],
  ['PARAGRAPH SEPARATOR', 0x2029],
  ['SOFT HYPHEN', 0x00ad],
  ['HANGUL FILLER', 0x3164],
  ['HANGUL CHOSEONG FILLER', 0x115f],
  ['COMBINING GRAPHEME JOINER', 0x034f],
  ['VARIATION SELECTOR-1', 0xfe00],
  ['TAG LATIN CAPITAL A', 0xe0041],
  ['LONE HIGH SURROGATE', 0xd800],
  ['LONE LOW SURROGATE', 0xdc00],
  // Format characters that are not default-ignorable: only \p{Cf} refuses them.
  ['ARABIC NUMBER SIGN', 0x0600],
  ['INTERLINEAR ANNOTATION ANCHOR', 0xfff9],
  // Symbols that draw a blank: they read as a space no space rule sees.
  ['BRAILLE PATTERN BLANK', 0x2800],
  ['MUSICAL SYMBOL NULL NOTEHEAD', 0x1d159],
]

const LINE = { kind: 'single-line', maxCodePoints: 300 }
const LINES = { kind: 'multi-line', maxCodePoints: 1000 }
const NAME = { kind: 'name', maxCodePoints: 120 }

function accepted(value, rule) {
  const result = normalizeFreeText(value, rule)
  assert.equal(result.ok, true, `expected ${JSON.stringify(value)} to pass`)
  return result.value
}

function problemOf(value, rule) {
  const result = normalizeFreeText(value, rule)
  assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to fail`)
  return result.problem
}

describe('toAsciiDigits (UX-07)', () => {
  test('maps Arabic-Indic and Persian digits to ASCII', () => {
    assert.equal(toAsciiDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789')
    assert.equal(toAsciiDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789')
    assert.equal(toAsciiDigits('٠٥٥١٢٣٤٥٦٧'), '0551234567')
  })

  test('leaves every other character alone', () => {
    assert.equal(toAsciiDigits('SA٠٣ ٨٠٠٠-x'), 'SA03 8000-x')
    assert.equal(toAsciiDigits('الساعة ١٦:٣٠'), 'الساعة 16:30')
    assert.equal(toAsciiDigits('０１'), '０１')
  })
})

describe('countCodePoints', () => {
  test('counts code points, as SQLite length() does', () => {
    assert.equal(countCodePoints('سندس'), 4)
    assert.equal(countCodePoints('😀😀'), 2)
    assert.equal(countCodePoints(''), 0)
  })
})

describe('normalizeFreeText (TM-12, N-41)', () => {
  test('stores the NFC form', () => {
    assert.equal(accepted('Cafe\u0301', LINE), 'Café')
    assert.equal(accepted('\u0627\u0653', LINE), '\u0622')
  })

  for (const [label, codePoint] of REFUSED_CHARACTERS) {
    test(`refuses ${label} (U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}) at the start, middle and end`, () => {
      const character = char(codePoint)

      for (const value of [
        `${character}حي العزيزية`,
        `حي${character} العزيزية`,
        `حي العزيزية${character}`,
      ]) {
        assert.equal(problemOf(value, LINE), 'forbidden-character')
        assert.equal(problemOf(value, NAME), 'forbidden-character')

        if (codePoint !== 0x000d) {
          assert.equal(problemOf(value, LINES), 'forbidden-character')
        }
      }
    })
  }

  test('keeps ZWNJ, ZWJ and the emoji presentation selector (N-41)', () => {
    assert.equal(accepted(`نرگس${ZWNJ}خانم`, NAME), `نرگس${ZWNJ}خانم`)
    assert.equal(accepted(`می${ZWNJ}خواهم`, LINE), `می${ZWNJ}خواهم`)
    const family = `👩${ZWJ}👩${ZWJ}👧`
    assert.equal(accepted(`شكرًا ${family}`, LINES), `شكرًا ${family}`)
    assert.equal(accepted(`شكرًا ❤${VS16}`, LINES), `شكرًا ❤${VS16}`)
  })

  test('refuses a line break on one line and normalises it on several', () => {
    assert.equal(problemOf('السطر الأول\nالسطر الثاني', LINE), 'forbidden-character')
    assert.equal(problemOf('السطر الأول\nالسطر الثاني', NAME), 'forbidden-character')
    assert.equal(problemOf('السطر الأول\r\nالسطر الثاني', LINE), 'forbidden-character')
    assert.equal(
      accepted('السطر الأول\r\nالسطر الثاني\rالسطر الثالث\n', LINES),
      'السطر الأول\nالسطر الثاني\nالسطر الثالث',
    )
  })

  test('refuses more than four combining marks on one character', () => {
    assert.equal(accepted('بَّ', LINE), 'بَّ')
    assert.equal(accepted(`x${'\u0301'.repeat(4)}`, LINE).length, 5)
    assert.equal(problemOf(`x${'\u0301'.repeat(5)}`, LINE), 'forbidden-character')
    assert.equal(problemOf(`ب${'\u064b'.repeat(5)}`, LINES), 'forbidden-character')
  })

  test('trims, and an empty or blank value is empty unless the rule allows it', () => {
    assert.equal(accepted('  حي العزيزية \u00a0', LINE), 'حي العزيزية')
    assert.equal(problemOf('', LINE), 'empty')
    assert.equal(problemOf(' \u00a0\u3000 ', LINE), 'empty')
    assert.equal(problemOf('\n\n', LINES), 'empty')
    assert.deepEqual(
      normalizeFreeText('   ', { kind: 'multi-line', maxCodePoints: 10, minCodePoints: 0 }),
      { ok: true, value: '' },
    )
  })

  test('a ZWNJ or ZWJ between marks does not reset the count (fix round 1)', () => {
    const rule = { kind: 'single-line', maxCodePoints: 500 }
    const [acute, circumflex, tilde, macron, breve] = [0x0301, 0x0302, 0x0303, 0x0304, 0x0306].map(char)
    const [fatha, shadda, tanween, sukun, kasra] = [0x064e, 0x0651, 0x064b, 0x0652, 0x0650].map(char)

    for (const joiner of [ZWJ, ZWNJ, `${ZWJ}${ZWNJ}`]) {
      assert.equal(
        problemOf(`a${`${acute}${circumflex}${tilde}${macron}${joiner}`.repeat(60)}`, rule),
        'forbidden-character',
      )
      assert.equal(problemOf(`a${acute}${circumflex}${joiner}${tilde}${macron}${breve}`, rule), 'forbidden-character')
      assert.equal(
        problemOf(`ب${fatha}${joiner}${shadda}${joiner}${tanween}${sukun}${joiner}${kasra}`, LINES),
        'forbidden-character',
      )
    }

    // A precomposed letter counts its own mark.
    assert.equal(problemOf(`${char(0x00e1)}${circumflex}${tilde}${macron}${breve}`, rule), 'forbidden-character')

    // Four marks with a joiner among them, and emoji sequences, stay in.
    const fourMarks = `x${acute}${circumflex}${ZWJ}${tilde}${macron}`
    assert.equal(accepted(fourMarks, rule), fourMarks)
    const flag = `🏳${VS16}${ZWJ}⚧${VS16}`
    assert.equal(accepted(flag, rule), flag)
    const keycap = `1${VS16}${char(0x20e3)}`
    assert.equal(accepted(keycap, rule), keycap)
  })

  test('a value that shows nothing is empty under every kind (fix round 1)', () => {
    for (const value of [
      ZWNJ,
      ZWJ,
      VS15,
      VS16,
      `${ZWJ}${ZWJ}${ZWJ}`,
      ` ${ZWNJ} ${ZWJ} `,
      `${ZWNJ}${VS16}${ZWJ}`,
      `${char(0x0301)}${char(0x0301)}`,
    ]) {
      for (const rule of [LINE, LINES, NAME]) {
        assert.equal(problemOf(value, rule), 'empty', JSON.stringify(value))
        assert.deepEqual(normalizeFreeText(value, { ...rule, minCodePoints: 0 }), { ok: true, value: '' })
      }
    }

    // U+2800 draws a blank: refused outright, alone or repeated.
    for (const value of [BRAILLE_BLANK, BRAILLE_BLANK.repeat(500), `حي${BRAILLE_BLANK}النرجس`]) {
      for (const rule of [LINE, LINES, NAME]) {
        assert.equal(problemOf(value, rule), 'forbidden-character')
      }
    }
  })

  test('only characters that show something count towards the minimum', () => {
    const address = { kind: 'multi-line', minCodePoints: 5, maxCodePoints: 300 }
    const holder = { kind: 'name', minCodePoints: 2, maxCodePoints: 120 }
    const harakat = [0x064e, 0x064f, 0x0650, 0x0651].map(char).join('')

    assert.equal(problemOf(`حي${ZWNJ}${ZWJ}${ZWNJ}`, address), 'too-short')
    assert.equal(problemOf(`ا    ${ZWJ}`, address), 'too-short')
    assert.equal(problemOf(`ب${harakat}`, address), 'too-short')
    assert.equal(problemOf(`ا ${ZWJ}`, holder), 'too-short')
    assert.equal(problemOf(`${ZWNJ}${ZWJ}`, holder), 'empty')
    assert.equal(accepted('حي النرجس', address), 'حي النرجس')
    assert.equal(accepted(`بنك${ZWNJ}ي`, holder), `بنك${ZWNJ}ي`)
    assert.equal(accepted('بك', holder), 'بك')
  })

  test('caps the length in code points, as the DB CHECK does', () => {
    const rule = { kind: 'single-line', maxCodePoints: 5, minCodePoints: 2 }
    assert.equal(accepted('😀😀😀😀😀', rule), '😀😀😀😀😀')
    assert.equal(problemOf('😀😀😀😀😀😀', rule), 'too-long')
    assert.equal(accepted('سندس', rule), 'سندس')
    assert.equal(problemOf('سندسيار', rule), 'too-long')
    assert.equal(problemOf('س', rule), 'too-short')
    assert.equal(accepted('  سندس  ', rule), 'سندس')
    assert.equal(accepted('a'.repeat(300), LINE).length, 300)
    assert.equal(problemOf('a'.repeat(301), LINE), 'too-long')
  })

  test('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 5, true, ['نص'], { text: 'نص' }]) {
      assert.equal(problemOf(value, LINE), 'not-text')
    }
  })

  test('throws on a rule without positive integer bounds', () => {
    for (const rule of [
      { kind: 'single-line', maxCodePoints: 0 },
      { kind: 'single-line', maxCodePoints: -1 },
      { kind: 'single-line', maxCodePoints: Number.NaN },
      { kind: 'single-line', maxCodePoints: 1.5 },
      { kind: 'single-line', maxCodePoints: Number.POSITIVE_INFINITY },
      { kind: 'single-line', maxCodePoints: 10, minCodePoints: 11 },
      { kind: 'single-line', maxCodePoints: 10, minCodePoints: -1 },
    ]) {
      assert.throws(() => normalizeFreeText('نص', rule), RangeError)
    }
  })

  test('a name refuses links, domains and @-handles, and collapses spaces', () => {
    for (const value of [
      'https://x.test',
      'سندس www.example',
      'wa.me/966512345678',
      'سندس x.com',
      'studio@example',
      'سندس @sundus',
      'سندس ＠sundus',
      'ｗａ．ｍｅ',
      'sundus-pay . com',
      'sundus-pay[.]com',
      'منطقة (.) sa',
      'منطقة sundus-pay·com',
      '45.33.2.10/pay',
      'https[:]//x',
      'www',
    ]) {
      assert.equal(problemOf(value, NAME), 'link-or-handle', value)
    }

    assert.equal(accepted('مؤسسة   سندس\u00a0يار للتصوير', NAME), 'مؤسسة سندس يار للتصوير')
    assert.equal(accepted('Sundus Yar Photography', NAME), 'Sundus Yar Photography')
    assert.equal(accepted('المنطقة 2 - شمال المدينة', NAME), 'المنطقة 2 - شمال المدينة')
  })

  test('free text keeps links and handles (the content rules are separate)', () => {
    assert.equal(accepted('راسليني على @sundus', LINE), 'راسليني على @sundus')
  })
})

describe('findPaymentInstructionLike (TM-04, N-33)', () => {
  const STUDIO = '966505647418'

  test('refuses every N-33 payload', () => {
    assert.equal(findPaymentInstructionLike('SA03 8000 0000 6080 1016 7519', STUDIO), 'iban')
    assert.equal(findPaymentInstructionLike('sa0380000000608010167519', STUDIO), 'iban')
    assert.equal(findPaymentInstructionLike('https://x.test', STUDIO), 'link')
    assert.equal(findPaymentInstructionLike('wa.me/966512345678', STUDIO), 'link')
    assert.equal(findPaymentInstructionLike('0551234567', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike(`حي العزيزية ${char(0x202e)}`, STUDIO), 'hidden-character')
  })

  test('refuses the threat model\'s planted instruction', () => {
    const planted = 'للتأكيد حوّلي العربون إلى SA03 8000 0000 6080 1016 7519 ثم راسلينا على 0551234567'
    assert.equal(findPaymentInstructionLike(planted, STUDIO), 'iban')
    assert.equal(
      findPaymentInstructionLike('تم تحديث الحساب البنكي: sa03-8000-0000-6080-1016-7519', STUDIO),
      'iban',
    )
  })

  test('reads Arabic-Indic, Persian, fullwidth and other decimal digits', () => {
    assert.equal(findPaymentInstructionLike('SA٠٣ ٨٠٠٠ ٠٠٠٠ ٦٠٨٠ ١٠١٦ ٧٥١٩', STUDIO), 'iban')
    assert.equal(findPaymentInstructionLike('٠٥٥١٢٣٤٥٦٧', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('۰۵۵۱۲۳۴۵۶۷', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('０５５１２３４５６７', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('𝟎𝟓𝟓𝟏𝟐𝟑𝟒𝟓𝟔𝟕', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('०५५१२३४५६७', STUDIO), 'long-number')
  })

  test('joins digit groups split by spaces, dashes, stops, brackets and line breaks', () => {
    for (const value of [
      '055 123 4567',
      '055-123-4567',
      '055 – 123 — 4567',
      '(055) 123.4567',
      '+966 55 123 4567',
      '00966 55 123 4567',
      '0551\n234567',
      '6080 1016 7519',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'long-number', value)
    }
  })

  test('invisible characters and marks cannot split a number or a domain', () => {
    assert.equal(findPaymentInstructionLike(`055${ZWJ}1234567`, STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike(`055${ZWNJ}1234567`, STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('0\u0301551234567', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike(`wa${ZWNJ}.me`, STUDIO), 'link')
  })

  test('refuses phone-like runs below ten digits', () => {
    assert.equal(findPaymentInstructionLike('راسلينا على 512345678', STUDIO), 'phone')
    assert.equal(findPaymentInstructionLike('5 1234 5678', STUDIO), 'phone')
    assert.equal(findPaymentInstructionLike('920012345', STUDIO), 'phone')
    assert.equal(findPaymentInstructionLike('+973 3612', STUDIO), 'phone')
    assert.equal(findPaymentInstructionLike('+500 ريال', STUDIO), null)
    assert.equal(findPaymentInstructionLike('+97336123', STUDIO), 'phone')
  })

  test('refuses links in every disguise it can read', () => {
    for (const value of [
      'http://1.2.3.4',
      'www.example',
      'x.com',
      'bit.ly/abc',
      't.me/studio',
      'WA.ME/966505647418',
      'ｗａ．ｍｅ/x',
      'wa\u3002me',
      'w\u0430.m\u0435',
      'name@example.com',
      'سندس.com',
      'example.xn--mgberp4a5d4ar',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'link', value)
    }

    assert.equal(findPaymentInstructionLike('تابعينا @sundus_yar', STUDIO), 'handle')
    assert.equal(findPaymentInstructionLike('تابعينا ＠sundus', STUDIO), 'handle')
    assert.equal(findPaymentInstructionLike('تابعينا @ sundus', STUDIO), 'handle')
  })

  test('reads the named domains, www. and :// with spaces around them', () => {
    for (const value of [
      'wa . me/message/ABC',
      'راسلينا على t .me/sundus',
      'bit. ly/abc',
      'WA . ME/966512345678',
      'www . example',
      'https : //x',
      'https:\\\\x',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'link', value)
    }

    for (const value of [
      'bitly',
      'Thank you. See you soon',
      'e.g. p.m.',
      'awww',
      'الساعة 4:00 / 9:00',
      'حي العزيزية . الرياض',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), null, value)
    }
  })

  test('reads any domain with its stop spaced, bracketed, spelled or disguised (fix round 1)', () => {
    const blanks = [' ', char(0x00a0), char(0x2003), char(0x3000)]

    for (const blank of blanks) {
      for (const value of [
        `sundus-pay${blank}.${blank}com`,
        `sundus-pay${blank}.com`,
        `sundus-pay.${blank}com`,
        `wa${blank}.${blank}me`,
        `سندس${blank}.${blank}xyz`,
        `سندس${blank}.${blank}السعودية`,
      ]) {
        assert.equal(findPaymentInstructionLike(value, STUDIO), 'link', JSON.stringify(value))
      }
    }

    for (const value of [
      'sundus-pay[.]com',
      'sundus-pay(.)com',
      'sundus-pay {.} store',
      'sundus-pay <.> link',
      'sundus-pay [dot] com',
      'sundus-pay dot com',
      'sundus-pay نقطة com',
      'sundus-pay . anything',
      'sundus-pay·com',
      'sundus-pay•com',
      'sundus-pay‧com',
      'sundus-pay∙com',
      'sundus-pay・com',
      'sundus-payꓸcom',
      'sundus-pay٠com',
      'sundus-pay۰com',
      'www[.]example',
      'https[:]//x',
      'https∶//x',
      'https:∕∕x',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'link', value)
    }

    // A blank that no space rule sees is refused before any of this.
    assert.equal(findPaymentInstructionLike(`wa${BRAILLE_BLANK}.${BRAILLE_BLANK}me`, STUDIO), 'hidden-character')
  })

  test('reads a domain whose stop or top-level domain is written in Arabic words (fix round 2)', () => {
    for (const value of [
      'ادخلي sundus-pay دوت كوم',
      'ادخلي sundus-pay نقطة كوم',
      'ادخلي sunduspay دوت com',
      'موقعنا sunduspay (نقطة) com',
      'sunduspay[نقطة]com',
      'sunduspay [دوت] كوم',
      'sunduspay <نقطه> نت',
      'sunduspay دُوت com',
      'sunduspay دت نت',
      'sunduspay نقطه أورج',
      'sunduspay dot اورج',
      'سندس دوت كوم',
      'سندس نقطة السعودية',
      'sunduspay dot كوم',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'link', value)
    }

    for (const value of [
      'نقطة تجمع عند البوابة',
      'نلتقي عند نقطة التجمع قرب البوابة',
      'كل نقطة مهمة في يومك',
      'التسليم عند نقطة الاستلام (نقطة) الشمالية',
      'polka dot dress',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), null, value)
      assert.equal(normalizeFreeText(value, LINES).ok, true, value)
    }
  })

  test('reads a bare IPv4 address (fix round 1)', () => {
    for (const value of ['ادفعي هنا 45.33.2.10/pay', '45.33.2.10', '45 . 33 . 2 . 10', '1.2.3.4:8080']) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'link', value)
    }

    for (const value of ['الإصدار 1.2.3', 'يسري من 1.10.2026']) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), null, value)
    }
  })

  test('any separator joins the groups of an IBAN or a phone number, and follows an @ (fix round 1)', () => {
    const iban = ['SA03', '8000', '0000', '6080', '1016', '7519']
    const phone = ['055', '123', '4567']
    const arabicIndicPhone = ['٠٥٥', '١٢٣', '٤٥٦٧']
    const separators = [
      '/', '_', ',', '،', '·', '•', '*', '|', ':', char(0x5c), '؛', '..', ' / ', '    ', ` ❤${VS16} `,
      // Letters that pass for a stroke, a dash or a dot, and other scripts' letters.
      'ا', 'l', 'I', 'ǀ', 'ㅡ', 'ー', 'ꓸ',
    ]

    for (const separator of separators) {
      const shown = JSON.stringify(separator)
      assert.ok(
        ['iban', 'long-number'].includes(findPaymentInstructionLike(iban.join(separator), STUDIO)),
        shown,
      )
      assert.equal(findPaymentInstructionLike(phone.join(separator), STUDIO), 'long-number', shown)
      assert.equal(findPaymentInstructionLike(arabicIndicPhone.join(separator), STUDIO), 'long-number', shown)
      assert.equal(findPaymentInstructionLike(`تابعينا @${separator}sundus_pay`, STUDIO), 'handle', shown)
    }

    for (const value of [iban.join(BRAILLE_BLANK), phone.join(BRAILLE_BLANK), `@${BRAILLE_BLANK}sundus_pay`]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'hidden-character')
    }
  })

  test('refuses the planted instruction whatever separates its groups (fix round 1)', () => {
    for (const separator of [BRAILLE_BLANK, '/', '·', '،', '_']) {
      const planted = `للتأكيد حوّلي العربون إلى ${['SA03', '8000', '0000', '6080', '1016', '7519'].join(separator)} ثم راسلينا على ${['055', '123', '4567'].join(separator)}`
      assert.notEqual(findPaymentInstructionLike(planted, STUDIO), null, JSON.stringify(separator))
      assert.equal(normalizeFreeText(planted, LINES).ok, separator !== BRAILLE_BLANK)
    }
  })

  test('reads the digit symbols NFKC keeps as symbols (fix round 1)', () => {
    for (const value of ['⓪❺❺❶❷❸❹❺❻❼', '⓿➄➄➀➁➂➃➄➅➆', '❶❷❸❹❺❻❼❽❾❿', '⓵⓶⓷⓸⓹⓺⓻⓼⓽⓾', '🄋⑤⑤①②③④⑤⑥⑦']) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'long-number', value)
    }
  })

  test('a word between two numbers keeps them apart; symbols alone do not', () => {
    for (const value of [
      'الباقة 1500 ريال أو 2500 ريال',
      'مقاس 30x40 و 50x70',
      'من السبت إلى الخميس، 4:00 - 9:00 مساءً، والجمعة 5:00 - 10:00 مساءً',
      'التسليم خلال 7، 14 أو 30 يومًا',
      'حي العزيزية، المدينة المنورة 42311',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), null, value)
    }

    // The documented price of reading every separator: a list with no word
    // in it is read as one number.
    assert.equal(findPaymentInstructionLike('1500 / 2500 / 3500', STUDIO), 'long-number')
  })

  test('reads domains under an Arabic-script top-level domain', () => {
    for (const value of [
      'ادفعي عبر سندس.السعودية',
      'سندس.مصر/دفع',
      'دفع.عرب',
      'سندس.السعـودية',
      'حوالة.امارات.',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), 'link', value)
    }

    for (const value of [
      'نرحب بكم.موقع الاستوديو في حي العزيزية',
      'الدفع عبر حساب.مصرف الراجحي',
      'التوصيل داخل المدينة. مصر ليست ضمن المناطق',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), null, value)
    }
  })

  test('allows the studio\'s own number in every form, and only that number', () => {
    for (const value of [
      '0505647418',
      '966505647418',
      '+966 50 564 7418',
      '00966505647418',
      '505647418',
      '٠٥٠٥٦٤٧٤١٨',
      '+966 0505647418',
      'للاستفسار راسلينا على واتساب 050 564 7418',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), null, value)
      assert.equal(findPaymentInstructionLike(value, '0505647418'), null, value)
      assert.equal(findPaymentInstructionLike(value, '+966 ٥٠ ٥٦٤ ٧٤١٨'), null, value)
      assert.notEqual(findPaymentInstructionLike(value, null), null, value)
      assert.notEqual(findPaymentInstructionLike(value, ''), null, value)
      assert.notEqual(findPaymentInstructionLike(value, '123'), null, value)
    }

    assert.equal(findPaymentInstructionLike('0505647418 أو 0551234567', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('0505647418 12', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('wa.me/966505647418', STUDIO), 'link')
  })

  test('allows the studio\'s number as a whole line, and judges the other lines', () => {
    const contact = 'للتواصل واتساب: 0505647418\n4:00 - 9:00 مساءً'
    assert.equal(findPaymentInstructionLike(contact, STUDIO), null)
    assert.equal(findPaymentInstructionLike(contact, null), 'long-number')
    assert.equal(findPaymentInstructionLike('0505647418\n0551234567', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('0551\n0505647418\n234567', STUDIO), null)
    assert.equal(findPaymentInstructionLike('055 1\n0505647418\n2345 67', STUDIO), null)
    assert.equal(findPaymentInstructionLike('0551 2\n34567\n0505647418', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('+44 0505647418', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('00 44 0505647418', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('0505647418\n+44 7911 234', STUDIO), 'phone')
    assert.equal(findPaymentInstructionLike('0505647418 +\n97336123', STUDIO), 'phone')
    assert.equal(findPaymentInstructionLike('+\n97336123', STUDIO), 'phone')
    assert.equal(findPaymentInstructionLike('0505647418\n512345678', STUDIO), 'phone')
    assert.equal(findPaymentInstructionLike('0505647418\n\n0505647418', STUDIO), null)
  })

  test('the tatweel cannot split a number either', () => {
    assert.equal(findPaymentInstructionLike('055ـ1234567', STUDIO), 'long-number')
    assert.equal(findPaymentInstructionLike('٠٥٥ـ١٢٣ـ٤٥٦٧', STUDIO), 'long-number')
  })

  test('leaves ordinary pickup and terms text alone', () => {
    for (const value of [
      'الاستلام من الاستوديو في المدينة المنورة، حي العزيزية، من الساعة 4:00 إلى 9:00 مساءً.',
      'المدينة المنورة 42311 - 7788',
      'يسري هذا البند من 01/10/2026 حتى 2026-12-31.',
      'العربون 500 ريال، والمبلغ المتبقي 1,500 ريال يُدفع يوم التسليم.',
      'الساعة 4.30م',
      'البنود:\n1- الحجز بعد دفع العربون.\n2- التسليم خلال 60 يومًا.',
      'e.g. p.m. ر.س',
      '',
    ]) {
      assert.equal(findPaymentInstructionLike(value, STUDIO), null, value)
    }
  })

  test('stays linear on long inputs (no ReDoS)', () => {
    const started = performance.now()

    for (const value of [
      'a'.repeat(100_000),
      'sa1'.repeat(30_000),
      '1 '.repeat(50_000),
      'س.'.repeat(50_000),
      `${'ab-'.repeat(30_000)}!`,
      `www${' '.repeat(100_000)}x`,
      `:${' '.repeat(100_000)}x`,
      `@${' '.repeat(100_000)}!`,
      'wa '.repeat(50_000),
      '+'.repeat(100_000),
      `sa11${' -'.repeat(50_000)}!`,
      '0505647418\n'.repeat(10_000),
      '1\n'.repeat(50_000),
      // The fix-round-1 patterns: open-ended gaps around digits, stops,
      // '@', 's'/'a' and marks.
      `1${'.'.repeat(100_000)}`,
      `sa11a${' '.repeat(100_000)}ب`,
      `${'sa11'}${' '.repeat(10)}ب`.repeat(5_000),
      'a .'.repeat(30_000),
      'x ( . '.repeat(20_000),
      'x dot '.repeat(20_000),
      '٠'.repeat(100_000),
      'x٠'.repeat(50_000),
      '1ا'.repeat(50_000),
      '1ㅡ'.repeat(50_000),
      '+ '.repeat(50_000),
      '@ '.repeat(50_000),
      's a '.repeat(30_000),
      '1 . '.repeat(30_000),
      ': ]'.repeat(30_000),
      'ب1 '.repeat(30_000),
      `a${char(0x0301)}${ZWJ.repeat(10)}`.repeat(8_000),
    ]) {
      findPaymentInstructionLike(value, STUDIO)
      normalizeFreeText(value, { kind: 'name', maxCodePoints: 200_000 })
      normalizeFreeText(value, { kind: 'multi-line', maxCodePoints: 200_000 })
    }

    assert.ok(performance.now() - started < 4_000)
  })
})

describe('normalizePersonName (SEC-10, single rule since R-07)', () => {
  test('accepts Arabic and Latin names and tidies spaces and apostrophes', () => {
    assert.equal(normalizePersonName('  سُندُس  '), 'سُندُس')
    assert.equal(normalizePersonName('آل\u00a0 سعود'), 'آل سعود')
    assert.equal(normalizePersonName('عبدالله-الأحمد'), 'عبدالله-الأحمد')
    assert.equal(normalizePersonName('O’Neil'), "O'Neil")
    assert.equal(normalizePersonName('Zoë'), 'Zoë')
    assert.equal(normalizePersonName('ا'.repeat(MAXIMUM_PERSON_NAME_LENGTH)), 'ا'.repeat(80))
  })

  test('refuses links, handles, digits, invisible and bidi characters', () => {
    for (const value of [
      '',
      '   ',
      'x.com',
      'سندس@example',
      '@sundus',
      'سندس2',
      `سندس${char(0x202e)}`,
      `سندس${char(0x2066)}يار`,
      `سندس${char(0x200b)}`,
      `${char(0xfeff)}سندس`,
      `سندس${char(0x2028)}يار`,
      `سندس${ZWJ}يار`,
      `سندس${char(0x3164)}`,
      'ا'.repeat(MAXIMUM_PERSON_NAME_LENGTH + 1),
      `a${'\u0301'.repeat(4)}`,
    ]) {
      assert.equal(normalizePersonName(value), null, JSON.stringify(value))
    }
  })

  test('accepts a ZWNJ between two Arabic-script letters only (N-41)', () => {
    const fatha = char(0x064e)

    for (const value of [`نرگس${ZWNJ}خانم`, `عبدالله${ZWNJ}زاده`, `س${fatha}${ZWNJ}خ`, `می${ZWNJ}نا يار`]) {
      assert.equal(normalizePersonName(value), value, JSON.stringify(value))
    }

    for (const value of [
      ZWNJ,
      `${ZWNJ}سندس`,
      `سندس${ZWNJ}`,
      `سندس ${ZWNJ}يار`,
      `سندس${ZWNJ} يار`,
      `سندس${ZWNJ}${ZWNJ}يار`,
      `سندس${ZWNJ}-يار`,
      `a${ZWNJ}ب`,
      `ب${ZWNJ}a`,
      `Sundus${ZWNJ}Yar`,
    ]) {
      assert.equal(normalizePersonName(value), null, JSON.stringify(value))
    }
  })

  test('refuses a control or separator at either end instead of trimming it', () => {
    for (const value of ['سندس\n', '\tسندس', `سندس${char(0x2029)}`, `${char(0x0085)}سندس`]) {
      assert.equal(normalizePersonName(value), null, JSON.stringify(value))
    }
  })

  test('refuses a domain under any top-level domain', () => {
    for (const value of ['سندس.السعودية', 'wa.me', 'sundus.com']) {
      assert.equal(normalizePersonName(value), null, value)
    }
  })

  test('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 5, ['سندس'], { firstName: 'سندس' }]) {
      assert.equal(normalizePersonName(value), null)
    }
  })
})
