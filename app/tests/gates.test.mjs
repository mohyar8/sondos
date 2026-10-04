// W1-03 / TM-10, TM-21, SB-11: the private-media gate. Every case below fails
// if its control (a condition of the gate, the exact-string flags, the key
// length, the R2 shape check, a deny-list word, the capture-value rule or
// the load-time assertion) is taken out of worker/portal/gates.ts.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  PRIVATE_MEDIA_BLOCKERS,
  PRIVATE_MEDIA_SEGMENTS,
  assertPrivateMediaRoutesGated,
  effectiveRouteGate,
  getMediaBucket,
  getPrivateMediaBlockers,
  isPrivateMediaAllowed,
  isRouteGateOpen,
  pathTouchesPrivateMedia,
} from '../worker/portal/gates.ts'

/** A stand-in for the workerd R2Bucket binding: methods on the prototype. */
class FakeR2Bucket {
  head() {}
  get() {}
  put() {}
  delete() {}
  list() {}
  createMultipartUpload() {}
  resumeMultipartUpload() {}
}

const KEY_32_ASCII = 'k'.repeat(32)

/** Every condition met, as in a local env.mediatest with its .dev.vars. */
function openEnv(overrides = {}) {
  return {
    ONLINE_CONFIRMATION: 'on',
    PDPL_SIGNOFF_REF: 'LOCAL-TEST-ONLY',
    MEDIA: new FakeR2Bucket(),
    MEDIA_SIGNING_KEY: KEY_32_ASCII,
    ADMIN_MEDIA_MFA: 'required',
    ...overrides,
  }
}

/** Production at go-live (11 §4.2): OC on, nothing else configured. */
function productionEnv() {
  return {
    ONLINE_CONFIRMATION: 'on',
    FIREBASE_PROJECT_ID: 'PLACEHOLDER_PRODUCTION_FIREBASE_PROJECT_ID',
    ADMIN_MEDIA_MFA: 'required',
    ADMIN_SETTINGS_2F: 'off',
  }
}

describe('private-media predicate (OC ∧ PDPL ∧ R2 ∧ KEY ∧ admin 2F)', () => {
  test('every condition met: open, and getMediaBucket returns the binding', () => {
    const env = openEnv()

    assert.deepEqual(getPrivateMediaBlockers(env), [])
    assert.equal(isPrivateMediaAllowed(env), true)
    assert.equal(isRouteGateOpen(env, 'private-media'), true)
    assert.equal(getMediaBucket(env), env.MEDIA)
  })

  test('production at go-live: closed, with the blockers of 11 §3.3 #29', () => {
    const env = productionEnv()

    assert.deepEqual(getPrivateMediaBlockers(env), [
      'PDPL_SIGNOFF_REF',
      'MEDIA_BINDING',
      'MEDIA_SIGNING_KEY',
    ])
    assert.equal(isPrivateMediaAllowed(env), false)
    assert.equal(isRouteGateOpen(env, 'private-media'), false)
    assert.equal(isRouteGateOpen(env, 'open'), true)
    assert.equal(getMediaBucket(env), null)
  })

  test('an empty env names every blocker, in the declared order', () => {
    assert.deepEqual(getPrivateMediaBlockers({ ADMIN_MEDIA_MFA: 'off' }), [
      ...PRIVATE_MEDIA_BLOCKERS,
    ])
    assert.deepEqual(getPrivateMediaBlockers({}), [
      'ONLINE_CONFIRMATION',
      'PDPL_SIGNOFF_REF',
      'MEDIA_BINDING',
      'MEDIA_SIGNING_KEY',
    ])
  })

  test('N-48: R2 binding and key but no PDPL sign-off → no bucket', () => {
    for (const reference of [undefined, '', '   ', '\t\n', 42]) {
      const env = openEnv({ PDPL_SIGNOFF_REF: reference })

      assert.deepEqual(getPrivateMediaBlockers(env), ['PDPL_SIGNOFF_REF'])
      assert.equal(getMediaBucket(env), null)
    }
  })

  test('ONLINE_CONFIRMATION opens only for the exact string "on"', () => {
    for (const value of [undefined, '', 'off', 'On', 'ON', ' on', 'on ', 'true', '1', true]) {
      const env = openEnv({ ONLINE_CONFIRMATION: value })

      assert.deepEqual(getPrivateMediaBlockers(env), ['ONLINE_CONFIRMATION'])
      assert.equal(getMediaBucket(env), null)
    }
  })

  test('ADMIN_MEDIA_MFA closes the gate only for the exact string "off" (TM-21)', () => {
    const disabled = openEnv({ ADMIN_MEDIA_MFA: 'off' })

    assert.deepEqual(getPrivateMediaBlockers(disabled), ['ADMIN_MFA_DISABLED'])
    assert.equal(getMediaBucket(disabled), null)

    // Anything else keeps the second factor required, so it is no blocker.
    for (const value of [undefined, '', 'required', 'OFF', 'Off', ' off', 'off ', 'false', '0']) {
      assert.deepEqual(getPrivateMediaBlockers(openEnv({ ADMIN_MEDIA_MFA: value })), [])
    }
  })

  test('MEDIA_SIGNING_KEY needs at least 32 characters, whitespace not counted', () => {
    const tooShort = [
      undefined,
      '',
      'k'.repeat(31),
      ' '.repeat(40),
      ` ${'k'.repeat(31)}\n`,
      // 32 UTF-8 bytes but 16 characters: request.ts would refuse to sign
      // with it, so the gate must not open on it either.
      'س'.repeat(16),
      32,
    ]

    for (const key of tooShort) {
      const env = openEnv({ MEDIA_SIGNING_KEY: key })

      assert.deepEqual(getPrivateMediaBlockers(env), ['MEDIA_SIGNING_KEY'])
      assert.equal(getMediaBucket(env), null)
    }

    for (const key of [KEY_32_ASCII, 'س'.repeat(32), `${'k'.repeat(43)}\n`]) {
      assert.deepEqual(getPrivateMediaBlockers(openEnv({ MEDIA_SIGNING_KEY: key })), [])
    }
  })

  test('the MEDIA binding must pass the runtime R2 shape check', () => {
    const kvLike = {
      get() {},
      put() {},
      delete() {},
      list() {},
      getWithMetadata() {},
    }
    // Each R2Bucket method in turn replaced by a non-function.
    const missingOneMethod = Object.getOwnPropertyNames(FakeR2Bucket.prototype)
      .filter((method) => method !== 'constructor')
      .map((method) =>
        Object.defineProperty(new FakeR2Bucket(), method, { value: 'not a function' }),
      )
    // A service binding, Durable Object stub or RPC stub answers every
    // property name with a callable (checked against workerd 2026-08-19).
    const rpcStubLike = new Proxy({}, { get: () => () => undefined })
    const withFetch = Object.assign(new FakeR2Bucket(), { fetch() {} })

    assert.equal(missingOneMethod.length, 7)

    for (const binding of [
      undefined,
      null,
      'MEDIA',
      1,
      kvLike,
      ...missingOneMethod,
      () => {},
      rpcStubLike,
      withFetch,
    ]) {
      const env = openEnv({ MEDIA: binding })

      assert.deepEqual(getPrivateMediaBlockers(env), ['MEDIA_BINDING'])
      assert.equal(getMediaBucket(env), null)
    }
  })

  test('blockers are codes only: no configured value is ever echoed', () => {
    const secret = `secret-${'x'.repeat(40)}`
    const serialized = JSON.stringify(
      getPrivateMediaBlockers({
        ONLINE_CONFIRMATION: secret,
        PDPL_SIGNOFF_REF: '',
        MEDIA: secret,
        MEDIA_SIGNING_KEY: 'short',
        ADMIN_MEDIA_MFA: 'off',
      }),
    )

    assert.equal(serialized.includes('secret'), false)
    assert.equal(serialized.includes('short'), false)
  })
})

describe('private-media deny-list (TM-10)', () => {
  const tm10Words = [
    'upload', 'uploads', 'file', 'files', 'image', 'images',
    'picture', 'pictures', 'attachment', 'attachments', 'proof', 'proofs',
    'slip', 'slips', 'document', 'documents', 'download', 'downloads',
    'pdf', 'thumb', 'thumbs', 'preview', 'previews',
  ]
  const r2Words = [
    'receipt', 'receipts', 'gallery', 'galleries', 'album', 'albums',
    'photo', 'photos', 'media',
  ]

  test('holds the Wave 0 words and every TM-10 synonym', () => {
    for (const word of [...r2Words, ...tm10Words]) {
      assert.equal(PRIVATE_MEDIA_SEGMENTS.has(word), true, word)
    }
  })

  test('a synonym path is private media in every spelling (N-13)', () => {
    const spellings = [
      ['proof'],
      ['Proofs'],
      ['%70roof'],
      ['%50ROOF'],
      ['receipt-upload'],
      ['receiptUpload'],
      ['bookingFiles'],
      ['PDFFile'],
      ['getPDF'],
      // Capitals with a lower-case plural: whole letter runs still match.
      ['RECEIPTs'],
      ['ALBUMs'],
      ['PHOTOs'],
      ['PDFs'],
      ['IMAGEs'],
      ['FILEs'],
      ['UPLOADs'],
      ['PROOFs'],
      ['SLIPs'],
      ['THUMBs'],
      ['rEceipts'],
      [':PDFsId'],
      [':attachmentId'],
      ['*downloadPath'],
      ['ｐｄｆ'],
      ['thumbnails'],
      ['x', 'previews', ''],
    ]

    for (const segments of spellings) {
      assert.equal(pathTouchesPrivateMedia(segments), true, segments.join('/'))
      // Under a rest capture, the request segments are read word by word.
      assert.equal(
        effectiveRouteGate({ path: ['*rest'], gate: 'open' }, segments),
        'private-media',
        segments.join('/'),
      )
      assert.equal(
        effectiveRouteGate(
          { path: ['exports', '*rest'], gate: 'open' },
          ['exports', ...segments, 'x'],
        ),
        'private-media',
        `exports/${segments.join('/')}/x`,
      )
    }
  })

  test('a :name capture value counts as whole tokens: ids never, words always', () => {
    const route = { path: ['customers', ':customerId'], gate: 'open' }
    // Firebase uids whose humps and digits spell a word (about 1 in 10,000).
    const unluckyUids = [
      'Xv4FcTPdfE1TGxL7YWwo3pedSD7J',
      'uPDF5lF3Yqic3HSvQNPASWvxKUly',
      'u31K4pdf1mFfCgxRBjAsiLDF06sJ',
      'IaA4RRl5DyJhHBPdfJ06AuCO0AsZ',
      'aB3Slip9xFileQ2mediaZZ7kkkkk',
    ]

    for (const uid of unluckyUids) {
      assert.equal(pathTouchesPrivateMedia([uid]), true, `${uid} spells a word`)
      assert.equal(effectiveRouteGate(route, ['customers', uid]), 'open', uid)
    }

    assert.equal(
      effectiveRouteGate(route, ['customers', 'b2c4e6f8-0a1b-4c3d-9e5f-a7b9c1d3e5f7']),
      'open',
    )

    for (const value of ['receipts', 'Receipt-Files', '%70roof', 'ＰＤＦ', 'photo_1', 'x.pdf']) {
      assert.equal(effectiveRouteGate(route, ['customers', value]), 'private-media', value)
    }
  })

  test('no open path of plan 11 §3.2 collides with the deny-list', () => {
    const openPaths = [
      // Customer: /api/bookings/{id}/…
      ['confirmation'],
      ['confirmation', 'accept-terms'],
      ['confirmation', 'whatsapp-notice'],
      ['event-profile'],
      ['consent'],
      ['handover'],
      ['handover', 'slots'],
      ['feedback'],
      // Admin: /api/admin/…
      ['bookings', ':bookingId', 'actions'],
      ['bookings', ':bookingId', 'notes'],
      ['bookings', ':bookingId', 'timeline'],
      ['bookings', ':bookingId', 'contact-log'],
      ['bookings', ':bookingId', 'event-profile'],
      ['bookings', ':bookingId', 'production'],
      ['bookings', ':bookingId', 'handover'],
      ['bookings', ':bookingId', 'feedback'],
      ['handover-slots'],
      ['handover-slots', 'generate'],
      ['handover-slots', ':slotId'],
      ['settings'],
      ['settings', 'deposit'],
      ['settings', 'bank'],
      ['settings', 'contact'],
      ['settings', 'pickup'],
      ['settings', 'terms'],
      ['settings', 'history'],
      ['settings', 'delivery-areas'],
      ['settings', 'delivery-areas', ':areaId'],
      ['settings', 'switch'],
      ['queue'],
      ['calendar'],
      ['customers'],
      ['customers', ':customerId'],
      ['exports', 'bookings.csv'],
      ['audit-log'],
      ['session'],
      ['session', 'revoke-all'],
      ['search', 'bookings'],
      ['search', 'customers'],
      // Other API paths named in 11 §3.2.
      ['bookings', 'me'],
      ['csp-report'],
      ['availability'],
      ['profile'],
      ['blocked-dates'],
      ['health'],
    ]

    for (const segments of openPaths) {
      assert.equal(pathTouchesPrivateMedia(segments), false, segments.join('/'))
    }
  })

  test('booking ids (UUIDs) never spell a deny word', () => {
    // Every deny word has a letter outside a-f, so no hex id can match.
    for (const word of PRIVATE_MEDIA_SEGMENTS) {
      assert.match(word, /[g-z]/, word)
    }
  })

  test('E1: an open route naming private media stops the registry from loading', () => {
    for (const path of [
      ['uploads'],
      ['bookings', ':bookingId', 'proof'],
      [':slipId'],
      ['bookings', ':bookingId', 'PDFs'],
      ['IMAGEs'],
      [':PDFsId'],
    ]) {
      assert.throws(
        () => assertPrivateMediaRoutesGated('/api/test', [{ path, gate: 'open' }]),
        /PORTAL_ROUTE_GATE_MISMATCH/,
      )
      assert.doesNotThrow(() =>
        assertPrivateMediaRoutesGated('/api/test', [{ path, gate: 'private-media' }]),
      )
    }
  })

  test('a private-media route stays closed when the gate is closed, open otherwise', () => {
    const route = { path: ['proof'], gate: 'private-media' }
    const gate = effectiveRouteGate(route, ['proof'])

    assert.equal(isRouteGateOpen(productionEnv(), gate), false)
    assert.equal(isRouteGateOpen(openEnv(), gate), true)
  })
})
