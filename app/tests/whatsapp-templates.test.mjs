// W2-14 (UX-15, TM-19, SB-6, SB-13): the admin-to-customer WhatsApp
// templates. Every case below fails if its control (closed id list, Riyadh
// deadline, required-field check, origin-only link, pickup-text tripwire,
// name check, bidi isolation, length cap, the one link builder) is taken
// out of src/features/admin-contact/whatsapp-templates.ts.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

const {
  adminContactTemplateIds,
  adminContactTemplateLabels,
  buildAdminContactLink,
  isAdminContactTemplateId,
  renderAdminContactTemplate,
} = await import('../src/features/admin-contact/whatsapp-templates.ts')
const { WHATSAPP_MESSAGE_MAX_LENGTH } = await import('../src/lib/whatsapp.ts')
const { adminContactTemplateIds: workerTemplateIds } = await import(
  '../worker/portal/admin-booking-log.ts'
)

const char = (codePoint) => String.fromCodePoint(codePoint)
const LRI = char(0x2066)
const FSI = char(0x2068)
const PDI = char(0x2069)
const RLO = char(0x202e)

const REFERENCE = '3f2b1c9e-8a7d-4e6f-9b0a-1c2d3e4f5a6b'
const ORIGIN = 'https://sundus.example'

/** Everything any template reads, all valid. */
const full = Object.freeze({
  reference: REFERENCE,
  firstName: 'سارة',
  eventDate: '2026-11-12',
  holdExpiresAt: '2026-10-01T13:00:00.000Z',
  depositAmount: 1300,
  eventStartTime: '19:30',
  productionStage: 'printing',
  slotStartsAt: '2026-12-03T13:00:00.000Z',
  handoverMethod: 'pickup',
  pickupAddress: 'المدينة المنورة، حي العزيزية، شارع الأمير نايف',
  pickupInstructions: 'نرجو إبلاغنا قبل الوصول بنصف ساعة.',
  siteOrigin: ORIGIN,
  now: new Date('2026-12-03T08:00:00.000Z'),
})

function render(id, overrides = {}) {
  return renderAdminContactTemplate(id, { ...full, ...overrides })
}

function textOf(id, overrides = {}) {
  const result = render(id, overrides)

  assert.equal(result.ok, true, `${id} should render`)
  return result.text
}

/** Visible text: the isolates removed, as a reader sees it. */
const visible = (text) => text.replace(/[⁦-⁩]/g, '')

/** Required fields per template, with a malformed value for each. */
const required = {
  request_received: { eventDate: '2026-02-30' },
  approved_online: { holdExpiresAt: '2026-10-01' },
  approved_legacy: { eventDate: null },
  hold_reminder: { holdExpiresAt: 'tomorrow' },
  deposit_recorded: { depositAmount: 0 },
  event_details_request: { eventDate: '12/11/2026' },
  event_reminder: { eventDate: undefined },
  production_update: { productionStage: 'ready' },
  handover_confirmation: { handoverMethod: 'both' },
  handover_day: { slotStartsAt: '2026-12-03T13:00:00+03:00' },
}

describe('closed template list', () => {
  test('the ids are the plan list and equal the Worker contact-log list', () => {
    assert.deepEqual([...adminContactTemplateIds], [
      'request_received',
      'approved_online',
      'approved_legacy',
      'hold_reminder',
      'terms_reminder',
      'deposit_recorded',
      'event_details_request',
      'event_reminder',
      'production_update',
      'album_ready',
      'handover_confirmation',
      'handover_day',
      'feedback_request',
      'offline_selection',
    ])
    assert.deepEqual([...adminContactTemplateIds], [...workerTemplateIds])
  })

  test('the guard accepts only listed ids', () => {
    for (const id of adminContactTemplateIds) {
      assert.equal(isAdminContactTemplateId(id), true)
      assert.equal(typeof adminContactTemplateLabels[id], 'string')
    }

    for (const value of ['', 'REQUEST_RECEIVED', 'toString', '__proto__', null, 1, {}]) {
      assert.equal(isAdminContactTemplateId(value), false)
    }

    const result = renderAdminContactTemplate('__proto__', full)
    assert.equal(result.ok, false)
    assert.equal(result.issue, 'invalid_input')
  })
})

describe('every template', () => {
  test('renders Arabic with the reference isolated, a greeting and the sign-off', () => {
    for (const id of adminContactTemplateIds) {
      const text = textOf(id)

      assert.ok(text.startsWith(`مرحبًا ${FSI}سارة${PDI}،\n`), id)
      assert.ok(text.includes(`رقم الطلب: ${LRI}${REFERENCE}${PDI}`), id)
      assert.ok(text.endsWith('\nمع تحيات المصورة سندس يار.'), id)
      assert.ok(!/undefined|null|NaN|Invalid/.test(text), id)
    }
  })

  test('addresses her in the feminine: no bare second-person kaf ends a word', () => {
    for (const id of adminContactTemplateIds) {
      // «طلبك» without its kasra, «معك», «لك»… at the end of a word.
      assert.doesNotMatch(visible(textOf(id)), /ك(?=[\s،.!:)؟]|$)/u, id)
    }
  })

  test('stays under the message cap with the longest inputs', () => {
    const longest = {
      firstName: 'ا'.repeat(80),
      pickupAddress: 'ب'.repeat(300),
      pickupInstructions: 'ت'.repeat(500),
      reference: 'a'.repeat(64),
    }

    for (const id of adminContactTemplateIds) {
      const text = textOf(id, longest)

      assert.ok(Array.from(text).length <= WHATSAPP_MESSAGE_MAX_LENGTH, id)
    }
  })

  test('is a pure function of its input', () => {
    for (const id of adminContactTemplateIds) {
      assert.deepEqual(render(id), render(id))
    }
  })

  test('never carries a link other than the site bookings page, nor bank details', () => {
    const hostile = {
      pickupAddress: 'حي العزيزية https://evil.example/pay',
      pickupInstructions: 'حوّلي على SA03 8000 0000 6080 1016 7519',
      firstName: 'سارة wa.me/15550000000',
    }

    for (const id of adminContactTemplateIds) {
      const text = textOf(id, hostile)
      const links = text.match(/[a-z][a-z0-9+.-]*:\/\/\S+/giu) ?? []

      for (const link of links) {
        assert.equal(new URL(link).origin, ORIGIN, id)
        assert.equal(new URL(link).pathname, '/my-bookings', id)
      }

      assert.doesNotMatch(text, /evil|SA03|wa\.me|IBAN|آيبان|رقم الحساب/iu, id)
    }
  })
})

describe('required inputs', () => {
  test('a missing or malformed field gives no message', () => {
    for (const [id, overrides] of Object.entries(required)) {
      const result = render(id, overrides)

      assert.equal(result.ok, false, id)
      assert.equal(result.issue, 'invalid_input', id)
      assert.equal(typeof result.reason, 'string')
    }
  })

  test('a reference outside the safe alphabet gives no message', () => {
    for (const reference of ['', 'a b', 'x?text=1', `ab${RLO}cd`, 'a'.repeat(65), 'مرجع', null]) {
      for (const id of adminContactTemplateIds) {
        assert.equal(render(id, { reference }).ok, false, `${id} ${reference}`)
      }
    }
  })

  test('each template reads only its own fields (SB-13)', () => {
    const address = full.pickupAddress

    for (const id of adminContactTemplateIds) {
      const text = textOf(id)
      const pickupTemplate =
        id === 'handover_confirmation' || id === 'handover_day'

      assert.equal(text.includes(address), pickupTemplate, id)
    }

    assert.ok(!textOf('handover_confirmation', { handoverMethod: 'delivery' }).includes(address))
    assert.ok(!textOf('handover_day', { handoverMethod: 'delivery' }).includes(address))
    assert.ok(!textOf('request_received').includes('1,300'))
  })
})

describe('deadlines and dates in Riyadh time', () => {
  test('approved_online states the deadline in Riyadh time', () => {
    const text = visible(textOf('approved_online'))

    assert.ok(
      text.includes('حتى الخميس، 1 أكتوبر 2026، الساعة 4:00 م بتوقيت السعودية.'),
      text,
    )
    assert.ok(text.includes('مبلغ العربون: 1,300 ر.س.'))
    assert.ok(text.includes('«أرسلي صورة الإيصال عبر واتساب»'))
  })

  test('a deadline late in the UTC day falls on the next Riyadh date', () => {
    const text = visible(textOf('approved_online', { holdExpiresAt: '2026-09-30T21:30:00.000Z' }))

    assert.ok(text.includes('الخميس، 1 أكتوبر 2026، الساعة 12:30 ص'), text)
  })

  test('approved_online without a known amount leaves the amount out', () => {
    const text = textOf('approved_online', { depositAmount: null })

    assert.ok(!text.includes('مبلغ العربون'))
  })

  test('a rolled-over instant is refused, not shifted', () => {
    assert.equal(render('hold_reminder', { holdExpiresAt: '2026-02-30T10:00:00.000Z' }).ok, false)
  })

  test('handover_day says «اليوم» only when the caller clock is on that Riyadh date', () => {
    assert.ok(textOf('handover_day').includes('اليوم الساعة'))

    const withoutClock = visible(textOf('handover_day', { now: null }))
    assert.ok(!withoutClock.includes('اليوم'))
    assert.ok(withoutClock.includes('يوم الخميس، 3 ديسمبر 2026'))

    const dayBefore = visible(textOf('handover_day', { now: new Date('2026-12-02T08:00:00.000Z') }))
    assert.ok(!dayBefore.includes('اليوم'))
  })

  test('event_reminder adds the start time only when it is a valid HH:MM', () => {
    assert.ok(visible(textOf('event_reminder')).includes('الساعة 7:30 م'))
    assert.ok(!textOf('event_reminder', { eventStartTime: '25:00' }).includes('الساعة'))
  })
})

describe('the bookings-page link', () => {
  test('points at /my-bookings on the given origin for the booking', () => {
    const text = textOf('approved_online')

    assert.ok(text.includes(`\n${ORIGIN}/my-bookings?booking=${REFERENCE}\n`))
  })

  test('is left out for anything but a bare https (or loopback http) origin', () => {
    for (const siteOrigin of [
      null,
      '',
      'http://sundus.example',
      `${ORIGIN}/`,
      `${ORIGIN}/admin`,
      `${ORIGIN}?x=1`,
      'https://user:pw@sundus.example',
      'javascript:alert(1)',
      'null',
      'HTTPS://SUNDUS.EXAMPLE',
      'not a url',
      `https://${'a'.repeat(260)}.example`,
    ]) {
      const text = textOf('approved_online', { siteOrigin })

      assert.doesNotMatch(text, /:\/\/|javascript/iu, String(siteOrigin))
      assert.ok(!text.includes('صفحة حجوزاتي:\n'), String(siteOrigin))
    }

    assert.ok(textOf('album_ready', { siteOrigin: 'http://localhost:5413' }).includes('http://localhost:5413/my-bookings?booking='))
  })

  test('templates whose next step is not on the site carry no link', () => {
    for (const id of ['approved_legacy', 'production_update', 'handover_day', 'offline_selection']) {
      assert.doesNotMatch(textOf(id), /:\/\//u, id)
    }
  })
})

describe('customer and admin text', () => {
  test('a name that is not a valid name is left out of the greeting', () => {
    for (const firstName of [`سا${RLO}رة`, 'سارة https://x.example', '@sara', '', null, 'ا'.repeat(81)]) {
      const text = textOf('album_ready', { firstName })

      assert.ok(text.startsWith('مرحبًا،\n'), String(firstName))
    }
  })

  test('pickup text holding a link, handle, IBAN or long number falls back to the generic line', () => {
    for (const pickupAddress of [
      'المدينة المنورة maps.example/abc',
      'المدينة المنورة @sundus',
      'المدينة المنورة SA0380000000608010167519',
      'اتصلي على 0551234567 عند الوصول',
      `المدينة${RLO} المنورة`,
    ]) {
      const text = textOf('handover_confirmation', { pickupAddress })

      assert.ok(!text.includes('مكان الاستلام:'), pickupAddress)
      assert.ok(text.includes('سنرسل إليكِ مكان الاستلام هنا قبل الموعد.'), pickupAddress)
    }
  })

  test('no embedding or override reaches a message', () => {
    for (const id of adminContactTemplateIds) {
      assert.doesNotMatch(textOf(id), /[‪-‮‎‏؜]/u, id)
    }
  })
})

describe('buildAdminContactLink', () => {
  test('builds the chat link through the one builder, text encoded', () => {
    const result = buildAdminContactLink({ e164Digits: '966501234567' }, 'album_ready', full)

    assert.equal(result.ok, true)
    const url = new URL(result.href)
    assert.equal(url.protocol, 'https:')
    assert.equal(url.pathname, '/966501234567')
    assert.deepEqual([...url.searchParams.keys()], ['text'])
    assert.equal(url.searchParams.get('text'), textOf('album_ready'))
  })

  test('an invalid number or input gives no link', () => {
    const badNumber = buildAdminContactLink('966500000000?text=x', 'album_ready', full)
    assert.equal(badNumber.ok, false)
    assert.equal(badNumber.issue, 'invalid_number')

    const badInput = buildAdminContactLink('0501234567', 'deposit_recorded', { ...full, depositAmount: -5 })
    assert.equal(badInput.ok, false)
    assert.equal(badInput.issue, 'invalid_input')
  })
})
