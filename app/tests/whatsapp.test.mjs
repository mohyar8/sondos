// W1-11 / TM-19: the one wa.me builder. Every case below fails if its
// control (number pattern, stored-digit path, encodeURIComponent, message
// cap, compiled fallback, direction-control removal) is taken out of
// src/lib/whatsapp.ts.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { describe, test } from 'node:test'

// The SPA imports its own modules without an extension (bundler
// resolution); Node needs the `.ts` file named. Only relative specifiers
// that are missing as written are retried, and only as their `.ts` sibling.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ERR_MODULE_NOT_FOUND' ||
        !/^\.{1,2}\//.test(specifier)
      ) {
        throw error
      }

      const sibling = specifier.endsWith('.js')
        ? `${specifier.slice(0, -3)}.ts`
        : `${specifier}.ts`

      return nextResolve(sibling, context)
    }
  },
})

const {
  DEFAULT_INQUIRY_MESSAGE,
  DEFAULT_WHATSAPP_URL,
  NUMBER_CHANGE_CHECK_MESSAGE,
  NUMBER_CHANGE_CHECK_URL,
  PORTFOLIO_INQUIRY_MESSAGE,
  WHATSAPP_DISPLAY_NUMBER,
  WHATSAPP_INTERNATIONAL_NUMBER,
  WHATSAPP_MESSAGE_MAX_LENGTH,
  buildWhatsAppUrl,
  buildWhatsAppUrlFor,
  fromE164Digits,
  isolateLtr,
  resolveStudioWhatsAppNumber,
  toWaMeDigits,
} = await import('../src/lib/whatsapp.ts')

// Invisible characters are built from code points so none sits in the source.
const char = (codePoint) => String.fromCodePoint(codePoint)
const NEWLINE = char(0x0a)
const CARRIAGE_RETURN = char(0x0d)
const NUL = char(0x00)
const PARAGRAPH_SEPARATOR = char(0x2029)
const LRM = char(0x200e)
const LRE = char(0x202a)
const RLE = char(0x202b)
const PDF = char(0x202c)
const LRO = char(0x202d)
const RLO = char(0x202e)
const LRI = char(0x2066)
const PDI = char(0x2069)
const LONE_HIGH_SURROGATE = char(0xd800)
const REPLACEMENT_CHARACTER = char(0xfffd)

const STUDIO = '966505647418'
const STUDIO_CHAT = `https://wa.me/${STUDIO}`
const E164_DIGITS = /^[1-9]\d{7,14}$/

function assertChatLink(href, digits, message) {
  const url = new URL(href)

  assert.equal(url.origin, 'https://wa.me')
  assert.equal(url.pathname, `/${digits}`)
  assert.equal(url.hash, '')
  assert.equal(url.username + url.password, '')

  if (message === '') {
    assert.equal(url.search, '')
    return
  }

  assert.deepEqual([...url.searchParams.keys()], ['text'])
  assert.equal(url.searchParams.get('text'), message)
}

describe('toWaMeDigits', () => {
  test('accepts every form the site meets, in any digit script', () => {
    const accepted = [
      '+966505647418',
      '966505647418',
      '00966505647418',
      '0505647418',
      '505647418',
      ' 0505647418 ',
      '+966 50 564 7418',
      '050-564-7418',
      '(050) 564 7418',
      '050.564.7418',
      '+966 0505647418',
      `${LRE}+966 50 564 7418${PDF}`,
      `${LRM}0505647418`,
      '٠٥٠٥٦٤٧٤١٨',
      '۰۵۰۵۶۴۷۴۱۸',
      '+٩٦٦٥٠٥٦٤٧٤١٨',
      '٠٠٩٦٦ ٥٠ ٥٦٤ ٧٤١٨',
    ]

    for (const input of accepted) {
      assert.equal(toWaMeDigits(input), STUDIO, JSON.stringify(input))
    }

    // A Saudi landline, and numbers outside Saudi Arabia.
    assert.equal(toWaMeDigits('+966 11 234 5678'), '966112345678')
    assert.equal(toWaMeDigits('+44 7700 900123'), '447700900123')
    assert.equal(toWaMeDigits('+1 (202) 555-0143'), '12025550143')
  })

  test('refuses anything that could change the link or is not a number (N-21)', () => {
    const refused = [
      '966500000000?text=x',
      '966500000000&text=x',
      '966500000000#x',
      '966500000000/x',
      '966500000000/../x',
      '966500000000@evil.test',
      '+966abc505647418',
      '+96650564741a',
      'x966505647418',
      '966+505647418',
      '++966505647418',
      '%2B966505647418',
      'javascript:alert(1)',
      '<img src=x onerror=alert(1)>',
      '',
      '   ',
      '+',
      '0',
      '1234567',
      '1234567890123456',
      '+0966505647418',
      '0966505647418',
      '0112345678',
      '9665056474',
      '96650564741899',
      // Digits of a script toAsciiDigits does not map.
      '０５０５６４７４１８',
      `0505647418${' '.repeat(30)}`,
    ]

    for (const input of refused) {
      assert.equal(toWaMeDigits(input), null, JSON.stringify(input))
    }
  })

  test('never returns anything but E.164 digits', () => {
    const samples = ['+966505647418', '0505647418', '٠٥٠٥٦٤٧٤١٨', '12345678']

    for (const input of samples) {
      assert.match(toWaMeDigits(input) ?? '', E164_DIGITS)
    }
  })

  test('reads a typed 5XXXXXXXX as Saudi, and +5XXXXXXXX as it is', () => {
    assert.equal(toWaMeDigits('508411234'), '966508411234')
    assert.equal(toWaMeDigits('+508411234'), '508411234')
    assert.equal(toWaMeDigits('00597412345'), '597412345')
  })
})

describe('fromE164Digits', () => {
  // Saint-Pierre-et-Miquelon (+508) and Suriname (+597): whole E.164
  // numbers of nine digits that start with 5, like a typed Saudi mobile.
  const nineDigitsFromFive = ['508411234', '597412345']

  test('returns stored digits unchanged, never as a Saudi mobile', () => {
    for (const stored of [
      STUDIO,
      '966112345678',
      '447700900123',
      '12025550143',
      '12345678',
      ...nineDigitsFromFive,
    ]) {
      assert.equal(fromE164Digits(stored), stored, stored)
    }
  })

  test('round-trips every number toWaMeDigits returns', () => {
    for (const typed of [
      '+508411234',
      '+597 412 345',
      '0505647418',
      '505647418',
      '٠٥٠٥٦٤٧٤١٨',
      '+966 0505647418',
      '+44 7700 900123',
    ]) {
      const stored = toWaMeDigits(typed)

      assert.notEqual(stored, null, typed)
      assert.equal(fromE164Digits(stored), stored, typed)
    }
  })

  test('refuses anything but stored digits', () => {
    const refused = [
      '0505647418',
      '+966505647418',
      '00966505647418',
      ' 966505647418',
      '966 505 647 418',
      '966-505-647418',
      `${LRM}966505647418`,
      '٩٦٦٥٠٥٦٤٧٤١٨',
      '9660505647418',
      '96650564741',
      '9665056474189',
      '966500000000?text=x',
      '966500000000#x',
      '1234567',
      '1234567890123456',
      '',
    ]

    for (const input of refused) {
      assert.equal(fromE164Digits(input), null, JSON.stringify(input))
    }
  })
})

describe('buildWhatsAppUrlFor', () => {
  const message = 'مرحبًا، بخصوص طلب الحجز رقم 42'

  test('builds the same link for +9665…, 05… and Arabic-Indic digits', () => {
    for (const number of ['+966505647418', '0505647418', '٠٥٠٥٦٤٧٤١٨']) {
      const link = buildWhatsAppUrlFor(number, message)

      assert.equal(link.ok, true)
      assert.equal(
        link.href,
        `${STUDIO_CHAT}?text=${encodeURIComponent(message)}`,
      )
      assertChatLink(link.href, STUDIO, message)
    }
  })

  test('opens the stored number itself for API digits (UX-03 waDigits)', () => {
    for (const stored of ['508411234', '597412345', STUDIO]) {
      const link = buildWhatsAppUrlFor({ e164Digits: stored }, message)

      assert.equal(link.ok, true)
      assertChatLink(link.href, stored, message)
    }
  })

  test('gives a reason instead of a link for stored digits in another form', () => {
    for (const e164Digits of [
      '0505647418',
      '+966505647418',
      '966500000000?text=x',
    ]) {
      const link = buildWhatsAppUrlFor({ e164Digits }, message)

      assert.equal(link.ok, false)
      assert.equal(link.issue, 'invalid_number')
      assert.equal('href' in link, false)
    }
  })

  test('gives a reason instead of a link for an invalid number', () => {
    for (const number of ['966500000000?text=x', 'abc', '']) {
      const link = buildWhatsAppUrlFor(number, message)

      assert.equal(link.ok, false)
      assert.equal(link.issue, 'invalid_number')
      assert.match(link.reason, /واتساب/)
      assert.equal('href' in link, false)
    }
  })

  test('keeps the message inside the text parameter (N-20)', () => {
    const payloads = [
      'x&phone=1&text=y#frag?z=1',
      `سطر أول${NEWLINE}سطر ثانٍ`,
      '<img src=x onerror=alert(1)>',
      'javascript:alert(1)',
      '\'"()!*~%20%+',
      'https://example.com/?a=1',
    ]

    for (const payload of payloads) {
      const link = buildWhatsAppUrlFor('0505647418', payload)

      assert.equal(link.ok, true)
      assertChatLink(link.href, STUDIO, payload)
    }
  })

  test('drops embeddings and overrides, keeps isolates (SB-6)', () => {
    const link = buildWhatsAppUrlFor(
      '0505647418',
      `المبلغ ${RLO}500${PDF} ${LRE}${RLE}${LRO}ريال ${isolateLtr('SY-42')}`,
    )

    assert.equal(link.ok, true)
    assertChatLink(link.href, STUDIO, `المبلغ 500 ريال ${LRI}SY-42${PDI}`)
  })

  test('opens the chat without text for an empty message', () => {
    const link = buildWhatsAppUrlFor('0505647418', '   ')

    assert.equal(link.ok, true)
    assert.equal(link.href, STUDIO_CHAT)
  })

  test('caps the message in code points', () => {
    const atCap = '😀'.repeat(WHATSAPP_MESSAGE_MAX_LENGTH)
    const linkAtCap = buildWhatsAppUrlFor('0505647418', atCap)

    assert.equal(linkAtCap.ok, true)
    assertChatLink(linkAtCap.href, STUDIO, atCap)

    for (const tooLong of [
      '😀'.repeat(WHATSAPP_MESSAGE_MAX_LENGTH + 1),
      'ب'.repeat(WHATSAPP_MESSAGE_MAX_LENGTH + 1),
      'a'.repeat(1_000_000),
    ]) {
      const link = buildWhatsAppUrlFor('0505647418', tooLong)

      assert.equal(link.ok, false)
      assert.equal(link.issue, 'message_too_long')
      assert.match(link.reason, /واتساب/)
    }
  })

  test('does not throw on a lone surrogate', () => {
    const link = buildWhatsAppUrlFor('0505647418', `a${LONE_HIGH_SURROGATE}b`)

    assert.equal(link.ok, true)
    assertChatLink(link.href, STUDIO, `a${REPLACEMENT_CHARACTER}b`)
  })
})

describe('existing exports and the compiled number', () => {
  test('keep their values', () => {
    assert.equal(WHATSAPP_INTERNATIONAL_NUMBER, STUDIO)
    assert.equal(WHATSAPP_DISPLAY_NUMBER, '0505647418')
    assert.equal(
      DEFAULT_INQUIRY_MESSAGE,
      'مرحبًا، أرغب في الاستفسار عن توفر موعد لتصوير عرس مع المصورة سندس يار.',
    )
    assert.equal(
      PORTFOLIO_INQUIRY_MESSAGE,
      'مرحبًا، أعجبتني أعمال المصورة سندس يار وأحببتُ معرفة تفاصيل الحجز.',
    )
    assert.equal(
      DEFAULT_WHATSAPP_URL,
      `${STUDIO_CHAT}?text=${encodeURIComponent(DEFAULT_INQUIRY_MESSAGE)}`,
    )
  })

  test('buildWhatsAppUrl keeps its contract', () => {
    assert.equal(buildWhatsAppUrl(''), STUDIO_CHAT)
    assert.equal(buildWhatsAppUrl('  hi  '), `${STUDIO_CHAT}?text=hi`)
    assert.equal(
      buildWhatsAppUrl(PORTFOLIO_INQUIRY_MESSAGE),
      `${STUDIO_CHAT}?text=${encodeURIComponent(PORTFOLIO_INQUIRY_MESSAGE)}`,
    )
    assertChatLink(buildWhatsAppUrl('a&text=b'), STUDIO, 'a&text=b')
    // Over the cap the chat still opens, without the text.
    assert.equal(
      buildWhatsAppUrl('a'.repeat(WHATSAPP_MESSAGE_MAX_LENGTH + 1)),
      STUDIO_CHAT,
    )
  })

  test('the display and international numbers are the same number', () => {
    assert.equal(toWaMeDigits(WHATSAPP_DISPLAY_NUMBER), STUDIO)
    assert.equal(toWaMeDigits(WHATSAPP_INTERNATIONAL_NUMBER), STUDIO)
  })

  test('the compiled number is the fallback for a missing or invalid one', () => {
    for (const reported of [
      null,
      undefined,
      '',
      'abc',
      '966500000000?text=x',
      // The API sends stored digits; any other form is not trusted.
      '0512345678',
      '+966512345678',
    ]) {
      assert.deepEqual(resolveStudioWhatsAppNumber(reported), {
        e164Digits: STUDIO,
      })
    }

    assert.deepEqual(resolveStudioWhatsAppNumber('966512345678'), {
      e164Digits: '966512345678',
    })
  })

  test('a stored 9-digit number from 5 stays itself on the way to the link', () => {
    const studio = resolveStudioWhatsAppNumber('508411234')

    assert.deepEqual(studio, { e164Digits: '508411234' })

    const link = buildWhatsAppUrlFor(studio, 'x')

    assert.equal(link.ok, true)
    assert.equal(link.href, 'https://wa.me/508411234?text=x')
  })

  test('the number-change check goes to the compiled number', () => {
    assertChatLink(NUMBER_CHANGE_CHECK_URL, STUDIO, NUMBER_CHANGE_CHECK_MESSAGE)
  })
})

describe('isolateLtr', () => {
  test('wraps the value in one LRI … PDI pair', () => {
    assert.equal(isolateLtr('SY-00042'), `${LRI}SY-00042${PDI}`)
  })

  test('drops direction controls inside the value', () => {
    assert.equal(isolateLtr(`A${PDI}${RLO}B${LRM}${LRE}C`), `${LRI}ABC${PDI}`)
  })

  test('turns line breaks and controls into spaces, so the isolate holds', () => {
    assert.equal(
      isolateLtr(
        `1${NEWLINE}2${CARRIAGE_RETURN}3${PARAGRAPH_SEPARATOR}4${NUL}5`,
      ),
      `${LRI}1 2 3 4 5${PDI}`,
    )
  })
})
