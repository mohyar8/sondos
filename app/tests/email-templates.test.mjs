// W2-04 (B1 #5, TM-12, SB-6): the flow-2 approval email states the Riyadh
// deadline and the deposit, points to the bookings page and never carries
// bank details; names and references are bidi-isolated after escaping in
// every legacy template; the flow-1 status copy is unchanged.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  renderAdminNewBookingTemplate,
  renderCustomerBookingReceivedTemplate,
  renderCustomerBookingStatusTemplate,
  renderCustomerFlowTwoApprovalTemplate,
} from '../worker/email-templates.ts'

const FSI = '⁨'
const LRI = '⁦'
const PDI = '⁩'
const REFERENCE = 'SY-2026-0042'
const MY_BOOKINGS = 'https://example.test/my-bookings'

const flowTwo = {
  customerFirstName: 'سارة',
  bookingReference: REFERENCE,
  eventDate: '2026-11-05',
  // 12:00 UTC = 15:00 in Riyadh (UTC+3, no DST).
  holdExpiresAt: '2026-10-02T12:00:00.000Z',
  depositAmount: 1500,
  myBookingsUrl: MY_BOOKINGS,
}

describe('renderCustomerFlowTwoApprovalTemplate', () => {
  test('states the Riyadh deadline, the deposit and the bookings page', () => {
    const email = renderCustomerFlowTwoApprovalTemplate(flowTwo)

    assert.ok(email)
    for (const part of [email.text, email.html]) {
      assert.match(part, /2 أكتوبر 2026/)
      assert.match(part, /الساعة 3:00/)
      assert.match(part, /بتوقيت السعودية/)
      assert.match(part, /1,500/)
      assert.match(part, /صفحة حجوزاتي/)
    }
    assert.ok(email.text.includes(MY_BOOKINGS))
    assert.ok(email.html.includes(`href="${MY_BOOKINGS}"`))
  })

  test('isolates the deadline, the amount, the name and the reference', () => {
    const email = renderCustomerFlowTwoApprovalTemplate(flowTwo)

    assert.ok(email)
    assert.match(email.text, new RegExp(`تنتهي المهلة في: ${FSI}[^${PDI}]+بتوقيت السعودية${PDI}`))
    assert.match(email.text, new RegExp(`مبلغ العربون: ${FSI}[^${PDI}]*1,500[^${PDI}]*${PDI}`))
    assert.ok(email.text.includes(`أهلًا ${FSI}سارة${PDI}،`))
    assert.ok(email.text.includes(`${LRI}${REFERENCE}${PDI}`))
    assert.ok(email.subject.includes(`${LRI}${REFERENCE}${PDI}`))
  })

  test('never carries bank details', () => {
    const email = renderCustomerFlowTwoApprovalTemplate(flowTwo)

    assert.ok(email)
    for (const part of [email.subject, email.text, email.html]) {
      assert.doesNotMatch(part, /SA\d{2}[0-9A-Z]{4,}/)
      assert.doesNotMatch(part, /آيبان|الآيبان|IBAN|رقم الحساب|اسم البنك/i)
    }
  })

  test('escapes a hostile name and keeps it isolated', () => {
    const email = renderCustomerFlowTwoApprovalTemplate({
      ...flowTwo,
      customerFirstName: '<img src=x onerror=alert(1)>‮سارة',
    })

    assert.ok(email)
    assert.ok(!email.html.includes('<img'))
    assert.ok(email.html.includes(`${FSI}&lt;img src=x onerror=alert(1)&gt; سارة${PDI}`))
    assert.ok(!email.text.includes('‮'))
  })

  test('refuses an unusable deadline or deposit instead of a wrong email', () => {
    assert.equal(renderCustomerFlowTwoApprovalTemplate({ ...flowTwo, holdExpiresAt: 'soon' }), null)
    for (const depositAmount of [0, -5, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(renderCustomerFlowTwoApprovalTemplate({ ...flowTwo, depositAmount }), null)
    }
  })

  test('uses Western digits for the deposit', () => {
    const email = renderCustomerFlowTwoApprovalTemplate(flowTwo)

    assert.ok(email)
    assert.doesNotMatch(email.text, /[٠-٩]/)
  })
})

describe('legacy templates', () => {
  const statusInput = {
    customerFirstName: 'نورة',
    bookingReference: REFERENCE,
    eventDate: '2026-11-05',
    previousStatus: 'pending_review',
    newStatus: 'approved_hold',
    myBookingsUrl: MY_BOOKINGS,
  }

  test('the flow-1 approval copy is unchanged', () => {
    const email = renderCustomerBookingStatusTemplate(statusInput)

    assert.ok(email.text.includes(
      'تم قبول طلبكِ وحجز التاريخ مبدئيًا. سيتم التواصل معكِ يدويًا لمتابعة الخطوات.',
    ))
    assert.equal(email.subject, `تحديث طلب الحجز — ${LRI}${REFERENCE}${PDI}`)
  })

  test('names and references are isolated in every legacy template', () => {
    const hostileReference = `${REFERENCE}‮`
    const status = renderCustomerBookingStatusTemplate({
      ...statusInput,
      bookingReference: hostileReference,
    })
    const received = renderCustomerBookingReceivedTemplate({
      customerFirstName: 'نورة',
      bookingReference: hostileReference,
      eventDate: '2026-11-05',
      packageName: 'باقة',
      finalTotal: 3000,
      myBookingsUrl: MY_BOOKINGS,
    })
    const admin = renderAdminNewBookingTemplate({
      customerFirstName: 'نورة',
      customerLastName: '<b>',
      bookingReference: hostileReference,
      customerPhone: '+966500000000',
      customerEmail: 'a@example.test',
      eventDate: '2026-11-05',
      packageName: 'باقة',
      finalTotal: 3000,
      adminBookingUrl: 'https://example.test/admin?booking=x',
    })

    for (const email of [status, received, admin]) {
      assert.ok(email.subject.includes(`${LRI}${REFERENCE}${PDI}`))
      assert.ok(email.text.includes(`${LRI}${REFERENCE}${PDI}`))
      assert.ok(!email.subject.includes('‮'))
      assert.ok(!email.text.includes('‮'))
      assert.ok(!email.html.includes('‮'))
    }
    assert.ok(status.text.includes(`أهلًا ${FSI}نورة${PDI}،`))
    assert.ok(received.html.includes(`أهلًا ${FSI}نورة${PDI}،`))
    assert.ok(admin.html.includes(`${FSI}نورة &lt;b&gt;${PDI}`))
    assert.ok(admin.text.includes(`${LRI}+966500000000${PDI}`))
  })
})
