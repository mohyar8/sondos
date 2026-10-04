// W1-06 / SB-3, TM-03, TM-04, GAP-03, UX-07: the settings input guards of
// shared/settings.ts (exact key sets, IBAN normalisation and ISO 13616
// mod-97, WhatsApp digits, text and content rules, the business identity)
// and the integer-only deposit arithmetic of shared/deposit.ts. The guards'
// limits are checked against the real settings_revisions CHECKs: a value at
// each bound is accepted by the guard AND by the database, one past it is
// refused by both.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import {
  DEPOSIT_ROUND_TO_VALUES,
  MAXIMUM_DEPOSIT_BASE_TOTAL,
  computeDeposit,
  isDepositRule,
} from '../shared/deposit.ts'
import {
  isValidSaudiIban,
  isWhatsappDigits,
  normalizeIban,
  normalizeWhatsappNumber,
  parseBankSettingsInput,
  parseBusinessIdentityInput,
  parseContactSettingsInput,
  parseDepositSettingsInput,
  parsePickupSettingsInput,
  readStoredBusinessIdentity,
  toPublicBusinessIdentity,
} from '../shared/settings.ts'

/** Valid Saudi IBANs (check digits computed for these test values). */
const IBAN_A = 'SA0910000000000000000001'
const IBAN_B = 'SA0745000000ABCDEF123456'
/** The ISO 13616 registry's Saudi example. */
const IBAN_REGISTRY_EXAMPLE = 'SA0380000000608010167519'
const STUDIO_DIGITS = '966505647418'

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹'

function toScript(digits, script) {
  return digits.replace(/[0-9]/g, (digit) => script[Number(digit)])
}

// ---------------------------------------------------------------------------
// A migrated database, to hold the guards to the real CHECKs
// ---------------------------------------------------------------------------

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const ADMIN = 'AdminUid0001'
const NOW = '2026-10-01T09:00:00.000Z'
const REAUTH = '2026-10-01T08:58:00.000Z'

function migratedDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)).sort()) {
    db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
  }

  db.prepare(
    "INSERT INTO users (id, email, first_name, last_name, phone, role) VALUES (?, 'admin@example.test', 'اسم', 'تجريبي', '+966500000000', 'admin')",
  ).run(ADMIN)

  return db
}

const db = migratedDatabase()

/** Inserts one revision in a savepoint that is always rolled back. */
function databaseAccepts(section, columns) {
  const names = Object.keys(columns)
  const values = Object.values(columns).map((value) =>
    typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value,
  )
  const sql = `
    INSERT INTO settings_revisions (section, ${names.join(', ')}, created_by, reauth_at, created_at)
    VALUES (?, ${names.map(() => '?').join(', ')}, ?, ?, ?)`

  db.exec('SAVEPOINT probe')

  try {
    db.prepare(sql).run(section, ...values, ADMIN, section === 'pickup' ? null : REAUTH, NOW)
    return true
  } catch (error) {
    if (error instanceof Error && /CHECK constraint failed/.test(error.message)) {
      return false
    }

    throw error
  } finally {
    db.exec('ROLLBACK TO probe')
    db.exec('RELEASE probe')
  }
}

function bankColumns(value) {
  return { bank_name: value.bankName, bank_account_holder: value.accountHolder, bank_iban: value.iban }
}

// ---------------------------------------------------------------------------
// IBAN
// ---------------------------------------------------------------------------

describe('IBAN: normalise, then SA + 22 and ISO 13616 mod-97 (N-22, N-55)', () => {
  test('valid IBANs in their stored form pass', () => {
    for (const iban of [IBAN_A, IBAN_B, IBAN_REGISTRY_EXAMPLE]) {
      assert.equal(isValidSaudiIban(iban), true, iban)
      assert.equal(normalizeIban(iban), iban, iban)
    }
  })

  test('spaces, lower case, Arabic-Indic and Persian digits and copied direction marks are normalised', () => {
    const cases = [
      ['SA03 8000 0000 6080 1016 7519', IBAN_REGISTRY_EXAMPLE],
      ['  sa0745000000abcdef123456  ', IBAN_B],
      [`SA${toScript('0380000000608010167519', ARABIC_INDIC)}`, IBAN_REGISTRY_EXAMPLE],
      [`SA${toScript('0910000000000000000001', PERSIAN)}`, IBAN_A],
      [`\u2066SA09 1000 0000 0000 0000 0001\u2069`, IBAN_A],
      [`\u200FSA0910000000000000000001\u200E`, IBAN_A],
      [`SA09\u00A01000\u00A00000\u00A00000\u00A00000\u00A00001`, IBAN_A],
    ]

    for (const [input, expected] of cases) {
      assert.equal(normalizeIban(input), expected, JSON.stringify(input))
    }
  })

  test('a wrong check sum, length, country or character is refused', () => {
    const refused = [
      'SA0910000000000000000002', // check sum
      'SA0380000000608010167518', // check sum
      'SA091000000000000000001', // 23 characters
      'SA09100000000000000000010', // 25 characters
      'GB82WEST12345698765432', // valid IBAN, not Saudi
      'SA09-1000-0000-0000-0000-0001', // dashes are not removed
      'SA\uFF10\uFF1910000000000000000001', // fullwidth digits
      '\u0405A0910000000000000000001', // Cyrillic look-alike letter
      'SA09100000000000000000\u200B01', // zero-width space is not formatting
      '',
      'SA',
      `SA09${'0'.repeat(60)}`, // over the input cap
      `${' '.repeat(41)}SA0910000000000000000001`, // valid once compacted, but over the input cap
    ]

    for (const input of refused) {
      assert.equal(normalizeIban(input), null, JSON.stringify(input))
    }

    for (const value of [12345, null, undefined, ['SA0910000000000000000001'], {}]) {
      assert.equal(normalizeIban(value), null)
    }
  })

  test('a line break is whitespace: removed like a space, the result still validated', () => {
    assert.equal(normalizeIban('SA09 1000\n0000 0000 0000 0001'), IBAN_A)
  })

  test('isValidSaudiIban reads only the stored form', () => {
    for (const value of ['sa0910000000000000000001', 'SA09 1000 0000 0000 0000 0001', 'SA0910000000000000000002']) {
      assert.equal(isValidSaudiIban(value), false, value)
    }
  })

  test('every IBAN the guard accepts passes the bank_iban CHECK', () => {
    for (const iban of [IBAN_A, IBAN_B, IBAN_REGISTRY_EXAMPLE]) {
      assert.equal(databaseAccepts('bank', { bank_name: 'مصرف', bank_account_holder: 'سندس', bank_iban: iban }), true)
    }
  })
})

// ---------------------------------------------------------------------------
// WhatsApp number
// ---------------------------------------------------------------------------

describe('WhatsApp number: E.164 digits (N-21, N-55)', () => {
  test('every accepted form becomes the same digits', () => {
    const accepted = [
      '0505647418',
      '505647418',
      '966505647418',
      '+966505647418',
      '00966505647418',
      '+966 0505647418',
      '9660505647418',
      '+966 50 564 7418',
      '(050) 564-7418',
      '050.564.7418',
      toScript('0505647418', ARABIC_INDIC),
      toScript('+966505647418', PERSIAN),
      '\u202A+966 50 564 7418\u202C',
    ]

    for (const input of accepted) {
      assert.equal(normalizeWhatsappNumber(input), STUDIO_DIGITS, JSON.stringify(input))
    }
  })

  test('a foreign E.164 number keeps its country code', () => {
    assert.equal(normalizeWhatsappNumber('+44 7700 900123'), '447700900123')
    assert.equal(normalizeWhatsappNumber('0097150123456'), '97150123456')
  })

  test('letters, query strings, a misplaced + and wrong lengths are refused, never stripped', () => {
    const refused = [
      '966500000000?text=x',
      '+966abc505647418',
      'wa.me/966505647418',
      '96650564741', // a Saudi number one digit short
      '9665056474180', // one digit long
      '+0966505647418',
      '0000000000',
      '1234567', // seven digits
      '1234567890123456', // sixteen digits
      '966+505647418',
      '\uFF0B966505647418', // fullwidth plus
      '',
      '0'.repeat(33),
    ]

    for (const input of refused) {
      assert.equal(normalizeWhatsappNumber(input), null, JSON.stringify(input))
    }

    for (const value of [966505647418, null, undefined, {}]) {
      assert.equal(normalizeWhatsappNumber(value), null)
    }
  })

  test('isWhatsappDigits: the stored form only, and whole Saudi numbers', () => {
    assert.equal(isWhatsappDigits(STUDIO_DIGITS), true)
    assert.equal(isWhatsappDigits('447700900123'), true)
    assert.equal(isWhatsappDigits('+966505647418'), false)
    assert.equal(isWhatsappDigits('96612345678'), false)
    assert.equal(isWhatsappDigits('0505647418'), false)
  })

  test('the stored digits pass the whatsapp_number CHECK', () => {
    for (const digits of [STUDIO_DIGITS, '447700900123', '12345678', '123456789012345']) {
      assert.equal(isWhatsappDigits(digits), true, digits)
      assert.equal(databaseAccepts('contact', { whatsapp_number: digits }), true, digits)
    }
  })
})

// ---------------------------------------------------------------------------
// Section inputs
// ---------------------------------------------------------------------------

function refusedWith(result, code, field) {
  assert.equal(result.ok, false)
  assert.equal(result.code, code)
  assert.equal(result.field, field)
}

describe('PUT deposit: exact key set per kind, JSON integers within the CHECKs', () => {
  test('both kinds parse', () => {
    assert.deepEqual(parseDepositSettingsInput({ kind: 'fixed', fixedAmount: 1000, roundTo: 1 }), {
      ok: true,
      value: { kind: 'fixed', fixedAmount: 1000, roundTo: 1 },
    })
    assert.deepEqual(parseDepositSettingsInput({ kind: 'percent', percent: 20, roundTo: 50 }), {
      ok: true,
      value: { kind: 'percent', percent: 20, roundTo: 50 },
    })
  })

  test('a key of the other kind, an extra, a missing or a __proto__ key is refused', () => {
    const bodies = [
      { kind: 'fixed', fixedAmount: 1000, roundTo: 1, percent: null },
      { kind: 'percent', percent: 20, roundTo: 50, fixedAmount: null },
      { kind: 'fixed', fixedAmount: 1000 },
      { kind: 'percent', roundTo: 50 },
      JSON.parse('{"kind":"fixed","fixedAmount":1000,"roundTo":1,"__proto__":{}}'),
    ]

    for (const body of bodies) {
      refusedWith(parseDepositSettingsInput(body), 'INVALID_REQUEST_BODY', null)
    }
  })

  test('values outside the CHECKs, strings, fractions and unknown kinds are refused', () => {
    const cases = [
      [{ kind: 'fixed', fixedAmount: 0, roundTo: 1 }, 'fixedAmount'],
      [{ kind: 'fixed', fixedAmount: 1_000_001, roundTo: 1 }, 'fixedAmount'],
      [{ kind: 'fixed', fixedAmount: '1000', roundTo: 1 }, 'fixedAmount'],
      [{ kind: 'fixed', fixedAmount: 1000.5, roundTo: 1 }, 'fixedAmount'],
      [{ kind: 'fixed', fixedAmount: 1000, roundTo: 3 }, 'roundTo'],
      [{ kind: 'percent', percent: 0, roundTo: 50 }, 'percent'],
      [{ kind: 'percent', percent: 101, roundTo: 50 }, 'percent'],
      [{ kind: 'percent', percent: 20, roundTo: '50' }, 'roundTo'],
      [{ kind: 'Fixed', fixedAmount: 1000, roundTo: 1 }, 'kind'],
    ]

    for (const [body, field] of cases) {
      refusedWith(parseDepositSettingsInput(body), 'INVALID_REQUEST_BODY', field)
    }

    for (const body of [null, [], 'fixed', 1000]) {
      refusedWith(parseDepositSettingsInput(body), 'INVALID_REQUEST_BODY', null)
    }
  })

  test('the bounds equal the deposit CHECKs', () => {
    for (const [body, columns] of [
      [{ kind: 'fixed', fixedAmount: 1, roundTo: 1 }, { deposit_kind: 'fixed', deposit_fixed_amount: 1, deposit_round_to: 1 }],
      [{ kind: 'fixed', fixedAmount: 1_000_000, roundTo: 100 }, { deposit_kind: 'fixed', deposit_fixed_amount: 1_000_000, deposit_round_to: 100 }],
      [{ kind: 'percent', percent: 1, roundTo: 5 }, { deposit_kind: 'percent', deposit_percent: 1, deposit_round_to: 5 }],
      [{ kind: 'percent', percent: 100, roundTo: 10 }, { deposit_kind: 'percent', deposit_percent: 100, deposit_round_to: 10 }],
    ]) {
      assert.equal(parseDepositSettingsInput(body).ok, true)
      assert.equal(databaseAccepts('deposit', columns), true)
    }

    assert.equal(databaseAccepts('deposit', { deposit_kind: 'fixed', deposit_fixed_amount: 1_000_001, deposit_round_to: 1 }), false)
    assert.equal(databaseAccepts('deposit', { deposit_kind: 'percent', deposit_percent: 101, deposit_round_to: 1 }), false)
    assert.equal(databaseAccepts('deposit', { deposit_kind: 'percent', deposit_percent: 20, deposit_round_to: 3 }), false)
  })
})

describe('PUT bank: text validator and content rules on the names, IBAN check', () => {
  const valid = { bankName: 'مصرف الراجحي', accountHolder: 'سندس يار', iban: 'sa09 1000 0000 0000 0000 0001' }

  test('a valid body is normalised', () => {
    assert.deepEqual(parseBankSettingsInput(valid), {
      ok: true,
      value: { bankName: 'مصرف الراجحي', accountHolder: 'سندس يار', iban: IBAN_A },
    })
    assert.deepEqual(parseBankSettingsInput({ ...valid, bankName: '  مصرف   الراجحي ' }).value.bankName, 'مصرف الراجحي')
  })

  test('exact keys (SB-3)', () => {
    refusedWith(parseBankSettingsInput({ ...valid, extra: 1 }), 'INVALID_REQUEST_BODY', null)
    refusedWith(parseBankSettingsInput({ bankName: valid.bankName, iban: valid.iban }), 'INVALID_REQUEST_BODY', null)
  })

  test('bidi and format characters, links and handles → INVALID_TEXT (TM-12, N-41)', () => {
    refusedWith(parseBankSettingsInput({ ...valid, bankName: 'مصرف\u202Eالراجحي' }), 'INVALID_TEXT', 'bankName')
    refusedWith(parseBankSettingsInput({ ...valid, accountHolder: 'سندس\u200Bيار' }), 'INVALID_TEXT', 'accountHolder')
    refusedWith(parseBankSettingsInput({ ...valid, accountHolder: 'سندس يار wa.me/447700900123' }), 'INVALID_TEXT', 'accountHolder')
    refusedWith(parseBankSettingsInput({ ...valid, bankName: 'مصرف @sndsyar' }), 'INVALID_TEXT', 'bankName')
    refusedWith(parseBankSettingsInput({ ...valid, bankName: 'مصرف\nالراجحي' }), 'INVALID_TEXT', 'bankName')
  })

  test('a second IBAN or a phone number hidden in a name → CONTENT_NOT_ALLOWED (TM-04)', () => {
    refusedWith(parseBankSettingsInput({ ...valid, accountHolder: `سندس يار ${IBAN_B}` }), 'CONTENT_NOT_ALLOWED', 'accountHolder')
    refusedWith(parseBankSettingsInput({ ...valid, bankName: 'مصرف 0551234567' }), 'CONTENT_NOT_ALLOWED', 'bankName')
    refusedWith(parseBankSettingsInput({ ...valid, bankName: 'مصرف ٠٥٥١٢٣٤٥٦٧' }), 'CONTENT_NOT_ALLOWED', 'bankName')
  })

  test('an invalid IBAN → INVALID_IBAN; a non-string one → INVALID_REQUEST_BODY', () => {
    refusedWith(parseBankSettingsInput({ ...valid, iban: 'SA0910000000000000000002' }), 'INVALID_IBAN', 'iban')
    refusedWith(parseBankSettingsInput({ ...valid, iban: 910000000000000000001 }), 'INVALID_REQUEST_BODY', 'iban')
  })

  test('name lengths equal the bank_name and bank_account_holder CHECKs', () => {
    for (const [field, column, minimum, maximum] of [
      ['bankName', 'bank_name', 2, 80],
      ['accountHolder', 'bank_account_holder', 2, 120],
    ]) {
      for (const length of [minimum, maximum]) {
        const result = parseBankSettingsInput({ ...valid, [field]: 'س'.repeat(length) })
        assert.equal(result.ok, true, `${field} ${length}`)
        assert.equal(databaseAccepts('bank', bankColumns(result.value)), true, `${column} ${length}`)
      }

      for (const length of [minimum - 1, maximum + 1]) {
        refusedWith(parseBankSettingsInput({ ...valid, [field]: 'س'.repeat(length) }), 'INVALID_REQUEST_BODY', field)
        const columns = { bank_name: 'مصرف', bank_account_holder: 'سندس', bank_iban: IBAN_A, [column]: 'س'.repeat(length) }
        assert.equal(databaseAccepts('bank', columns), false, `${column} ${length}`)
      }
    }
  })
})

describe('PUT contact', () => {
  test('stored as E.164 digits', () => {
    assert.deepEqual(parseContactSettingsInput({ whatsappNumber: toScript('0505647418', ARABIC_INDIC) }), {
      ok: true,
      value: { whatsappNumber: STUDIO_DIGITS },
    })
  })

  test('invalid → INVALID_PHONE; wrong type or keys → INVALID_REQUEST_BODY', () => {
    refusedWith(parseContactSettingsInput({ whatsappNumber: '966500000000?text=x' }), 'INVALID_PHONE', 'whatsappNumber')
    refusedWith(parseContactSettingsInput({ whatsappNumber: 966505647418 }), 'INVALID_REQUEST_BODY', 'whatsappNumber')
    refusedWith(parseContactSettingsInput({ whatsappNumber: STUDIO_DIGITS, note: '' }), 'INVALID_REQUEST_BODY', null)
    refusedWith(parseContactSettingsInput({}), 'INVALID_REQUEST_BODY', null)
  })
})

describe('PUT pickup: content rules allow only the studio number (TM-04, N-33)', () => {
  const address = 'حي النرجس، شارع الأمير\nالرياض'

  test('multi-line address; instructions null or empty are stored as null', () => {
    assert.deepEqual(parsePickupSettingsInput({ address, instructions: null }, STUDIO_DIGITS), {
      ok: true,
      value: { address, instructions: null },
    })
    assert.deepEqual(parsePickupSettingsInput({ address, instructions: '   ' }, STUDIO_DIGITS).value, {
      address,
      instructions: null,
    })
    assert.deepEqual(
      parsePickupSettingsInput({ address: 'حي النرجس\r\nالرياض', instructions: 'اتصلي بنا عند الوصول' }, STUDIO_DIGITS).value,
      { address: 'حي النرجس\nالرياض', instructions: 'اتصلي بنا عند الوصول' },
    )
  })

  test('the studio number is allowed only when it is the one passed in', () => {
    const body = { address, instructions: 'عند الوصول راسلينا على 0505647418' }
    assert.equal(parsePickupSettingsInput(body, STUDIO_DIGITS).ok, true)
    refusedWith(parsePickupSettingsInput(body, null), 'CONTENT_NOT_ALLOWED', 'instructions')
    refusedWith(parsePickupSettingsInput({ address, instructions: 'راسلينا على 0551234567' }, STUDIO_DIGITS), 'CONTENT_NOT_ALLOWED', 'instructions')
  })

  test('IBANs, links, handles and long digit runs → CONTENT_NOT_ALLOWED', () => {
    for (const text of [
      `حوّلي على ${IBAN_A}`,
      'الموقع https://maps.example.test/x',
      'تابعينا @sndsyar',
      'رقم الحساب 1234567890123',
      'واتساب wa . me/447700900123',
    ]) {
      refusedWith(parsePickupSettingsInput({ address: `${address}\n${text}`, instructions: null }, STUDIO_DIGITS), 'CONTENT_NOT_ALLOWED', 'address')
    }
  })

  test('control and bidi characters → INVALID_TEXT; lengths → INVALID_REQUEST_BODY', () => {
    refusedWith(parsePickupSettingsInput({ address: `${address}\u0007`, instructions: null }, null), 'INVALID_TEXT', 'address')
    refusedWith(parsePickupSettingsInput({ address, instructions: 'يمين\u2067يسار' }, null), 'INVALID_TEXT', 'instructions')
    refusedWith(parsePickupSettingsInput({ address: 'حي ن', instructions: null }, null), 'INVALID_REQUEST_BODY', 'address')
    refusedWith(parsePickupSettingsInput({ address: 5, instructions: null }, null), 'INVALID_REQUEST_BODY', 'address')
    refusedWith(parsePickupSettingsInput({ address }, null), 'INVALID_REQUEST_BODY', null)
  })

  test('lengths equal the pickup CHECKs', () => {
    for (const [length, ok] of [[5, true], [300, true], [4, false], [301, false]]) {
      const result = parsePickupSettingsInput({ address: 'ح'.repeat(length), instructions: null }, null)
      assert.equal(result.ok, ok, `address ${length}`)
      assert.equal(databaseAccepts('pickup', { pickup_address: 'ح'.repeat(length) }), ok, `pickup_address ${length}`)
    }

    for (const [length, ok] of [[500, true], [501, false]]) {
      const result = parsePickupSettingsInput({ address, instructions: 'ح'.repeat(length) }, null)
      assert.equal(result.ok, ok, `instructions ${length}`)
      assert.equal(databaseAccepts('pickup', { pickup_address: address, pickup_instructions: 'ح'.repeat(length) }), ok)
    }
  })
})

// ---------------------------------------------------------------------------
// Business identity (GAP-03)
// ---------------------------------------------------------------------------

describe('business identity: content rules, public only when filled (GAP-03)', () => {
  test('a filled form is normalised', () => {
    assert.deepEqual(
      parseBusinessIdentityInput({ legalName: '  مؤسسة  سندس يار للتصوير ', licenceNumber: 'fl-12 34 56', vatStatus: 'not_registered' }),
      { ok: true, value: { legalName: 'مؤسسة سندس يار للتصوير', licenceNumber: 'FL-123456', vatStatus: 'not_registered' } },
    )
    assert.equal(
      parseBusinessIdentityInput({ legalName: null, licenceNumber: toScript('1010123456', ARABIC_INDIC), vatStatus: 'registered' }).value.licenceNumber,
      '1010123456',
    )
  })

  test('nothing filled: null or empty names and numbers, VAT unknown', () => {
    for (const body of [
      { legalName: null, licenceNumber: null, vatStatus: 'unknown' },
      { legalName: '', licenceNumber: '   ', vatStatus: 'unknown' },
    ]) {
      assert.deepEqual(parseBusinessIdentityInput(body), {
        ok: true,
        value: { legalName: null, licenceNumber: null, vatStatus: 'unknown' },
      })
    }
  })

  test('the legal name is public text: validator and content rules', () => {
    const base = { licenceNumber: null, vatStatus: 'unknown' }
    refusedWith(parseBusinessIdentityInput({ ...base, legalName: 'س' }), 'INVALID_REQUEST_BODY', 'legalName')
    refusedWith(parseBusinessIdentityInput({ ...base, legalName: 'س'.repeat(121) }), 'INVALID_REQUEST_BODY', 'legalName')
    refusedWith(parseBusinessIdentityInput({ ...base, legalName: 'سندس www.example.test' }), 'INVALID_TEXT', 'legalName')
    refusedWith(parseBusinessIdentityInput({ ...base, legalName: 'سندس\u202Bيار' }), 'INVALID_TEXT', 'legalName')
    refusedWith(parseBusinessIdentityInput({ ...base, legalName: 'سندس يار 0551234567' }), 'CONTENT_NOT_ALLOWED', 'legalName')
  })

  test('the licence number: 4–32 letters and digits in hyphen-joined groups, at least one digit', () => {
    const base = { legalName: null, vatStatus: 'unknown' }

    for (const value of ['123', 'ABCD', 'FL--1234', '-1234', '1234-', 'FL_1234', 'wa.me/1234', 'رقم1234', '1'.repeat(33)]) {
      refusedWith(parseBusinessIdentityInput({ ...base, licenceNumber: value }), 'INVALID_TEXT', 'licenceNumber')
    }

    refusedWith(parseBusinessIdentityInput({ ...base, licenceNumber: 1010123456 }), 'INVALID_REQUEST_BODY', 'licenceNumber')
    refusedWith(parseBusinessIdentityInput({ ...base, licenceNumber: ` ${'1'.repeat(64)}` }), 'INVALID_REQUEST_BODY', 'licenceNumber')
    assert.equal(parseBusinessIdentityInput({ ...base, licenceNumber: 'FL-1234-5678-ABCD-EFGH-IJKL-MNOP' }).ok, true)
  })

  test('the licence number is never an IBAN or a Saudi phone number (TM-04 on the public page)', () => {
    const base = { legalName: null, vatStatus: 'unknown' }

    for (const value of [
      IBAN_A,
      'sa03 8000 0000 6080 1016 7519',
      'SA03-8000-0000-6080-1016-7519',
      'GB82WEST12345698765432',
      '0551234567',
      '055-123-4567',
      toScript('0551234567', ARABIC_INDIC),
      '551234567',
      '966551234567',
      '00966551234567',
      '9660551234567',
      '920012345',
    ]) {
      refusedWith(parseBusinessIdentityInput({ ...base, licenceNumber: value }), 'CONTENT_NOT_ALLOWED', 'licenceNumber')
    }

    // A '+' is not a licence character at all.
    refusedWith(parseBusinessIdentityInput({ ...base, licenceNumber: '+966551234567' }), 'INVALID_TEXT', 'licenceNumber')

    // Ten-digit commercial registration and unified numbers start with 1–7, never 0.
    for (const value of ['1010123456', '4030123456', '5850123456', '7001234567']) {
      assert.equal(parseBusinessIdentityInput({ ...base, licenceNumber: value }).value.licenceNumber, value)
    }
  })

  test('a leading or trailing group never hides an IBAN or a phone number (TM-04 wherever the digits sit)', () => {
    const base = { legalName: null, vatStatus: 'unknown' }

    for (const value of [
      // Prefixed and suffixed IBANs, also split by hyphens.
      `IBAN-${IBAN_A}`,
      `1-${IBAN_A}`,
      `X-${IBAN_A}`,
      `${IBAN_A}-1`,
      'X-SA03-8000-0000-6080-1016-7519',
      'ACC-SA03800000ABCD6080ABCD',
      // Prefixed and suffixed Saudi mobile and unified numbers.
      'TEL-0551234567',
      'WA-966551234567',
      '966551234567-1',
      '1-0551234567',
      'W-920012345',
      'FL-551234567',
      'X-055-123-4567',
      'A-5-5123-4567',
      '966-O-551234567',
      toScript('TEL-0551234567', ARABIC_INDIC),
      // Landlines, foreign and toll-free numbers, bare account numbers.
      '0112345678',
      'CR-0112345678',
      '966112345678',
      '00447700900123',
      '00201001234567',
      '447700900123',
      '8001234567',
      '608010167519',
      'ACC-608010167519',
      '1010123456-7',
      '1010-1234-5678',
      '0123456',
    ]) {
      assert.deepEqual(
        parseBusinessIdentityInput({ ...base, licenceNumber: value }),
        { ok: false, code: 'CONTENT_NOT_ALLOWED', field: 'licenceNumber' },
        value,
      )
    }

    // Registration numbers with a label or written in groups, and short
    // groups of digits, are still accepted.
    for (const [value, stored] of [
      ['CR-1010123456', 'CR-1010123456'],
      ['4030-123456', '4030-123456'],
      ['fl-123456789', 'FL-123456789'],
      ['FL-1234567', 'FL-1234567'],
      ['1010123456-A-7001234567', '1010123456-A-7001234567'],
      ['0-1234', '0-1234'],
    ]) {
      assert.equal(parseBusinessIdentityInput({ ...base, licenceNumber: value }).value.licenceNumber, stored, value)
    }
  })

  test('a stored identity parses to itself (the read side re-checks stored rows)', () => {
    for (const body of [
      { legalName: '  مؤسسة  سندس يار للتصوير ', licenceNumber: 'fl-12 34 56', vatStatus: 'not_registered' },
      { legalName: null, licenceNumber: toScript('1010123456', PERSIAN), vatStatus: 'registered' },
      { legalName: '', licenceNumber: null, vatStatus: 'unknown' },
    ]) {
      const stored = parseBusinessIdentityInput(body).value
      assert.deepEqual(parseBusinessIdentityInput(stored), { ok: true, value: stored })
      assert.deepEqual(readStoredBusinessIdentity(stored), stored)
      // A D1 row carries more columns; only the three fields are read.
      assert.deepEqual(readStoredBusinessIdentity({ id: 7, createdAt: NOW, ...stored }), stored)
    }
  })

  test('a stored row the write guard did not leave reads as not filled (fail closed)', () => {
    const filled = { legalName: 'سندس يار', licenceNumber: 'FL-123456', vatStatus: 'registered' }

    for (const row of [
      { ...filled, legalName: ' سندس يار' },
      { ...filled, legalName: 'سندس  يار' },
      { ...filled, legalName: 'سندس\u202Bيار' },
      { ...filled, legalName: 'سندس يار 0551234567' },
      { ...filled, legalName: '' },
      { ...filled, licenceNumber: 'fl-123456' },
      { ...filled, licenceNumber: 'FL 123456' },
      { ...filled, licenceNumber: '0551234567' },
      { ...filled, licenceNumber: '' },
      { ...filled, vatStatus: 'exempt' },
      { ...filled, vatStatus: null },
      { legalName: filled.legalName, licenceNumber: filled.licenceNumber },
      {},
    ]) {
      assert.equal(readStoredBusinessIdentity(row), null, JSON.stringify(row))
    }

    assert.deepEqual(toPublicBusinessIdentity(readStoredBusinessIdentity({ ...filled, licenceNumber: 'fl-1' })), {
      legalName: null,
      licenceNumber: null,
      vatStatus: null,
    })
  })

  test('VAT status from the closed list; exact keys', () => {
    refusedWith(parseBusinessIdentityInput({ legalName: null, licenceNumber: null, vatStatus: 'exempt' }), 'INVALID_REQUEST_BODY', 'vatStatus')
    refusedWith(parseBusinessIdentityInput({ legalName: null, licenceNumber: null }), 'INVALID_REQUEST_BODY', null)
    refusedWith(parseBusinessIdentityInput({ legalName: null, licenceNumber: null, vatStatus: 'unknown', vatNumber: null }), 'INVALID_REQUEST_BODY', null)
  })

  test('the public view leaves out every unfilled field', () => {
    assert.deepEqual(toPublicBusinessIdentity(null), { legalName: null, licenceNumber: null, vatStatus: null })
    assert.deepEqual(toPublicBusinessIdentity({ legalName: 'سندس يار', licenceNumber: null, vatStatus: 'unknown' }), {
      legalName: 'سندس يار',
      licenceNumber: null,
      vatStatus: null,
    })
    assert.deepEqual(toPublicBusinessIdentity({ legalName: null, licenceNumber: 'FL-123456', vatStatus: 'registered' }), {
      legalName: null,
      licenceNumber: 'FL-123456',
      vatStatus: 'registered',
    })
  })
})

// ---------------------------------------------------------------------------
// Deposit arithmetic
// ---------------------------------------------------------------------------

describe('computeDeposit: integers only, rounded up, capped at the total', () => {
  test('the worked examples of shared/deposit.ts', () => {
    const examples = [
      [{ kind: 'percent', percent: 20, roundTo: 50 }, 6500, 1300],
      [{ kind: 'percent', percent: 20, roundTo: 50 }, 4800, 1000],
      [{ kind: 'percent', percent: 15, roundTo: 1 }, 3333, 500],
      [{ kind: 'percent', percent: 30, roundTo: 100 }, 2850, 900],
      [{ kind: 'fixed', fixedAmount: 1000, roundTo: 1 }, 6500, 1000],
      [{ kind: 'fixed', fixedAmount: 1000, roundTo: 1 }, 800, 800],
      [{ kind: 'fixed', fixedAmount: 1025, roundTo: 50 }, 6500, 1050],
      [{ kind: 'percent', percent: 100, roundTo: 50 }, 1020, 1020],
      [{ kind: 'percent', percent: 20, roundTo: 50 }, 0, 0],
      [{ kind: 'fixed', fixedAmount: 1000, roundTo: 1 }, 0, 0],
    ]

    for (const [rule, total, expected] of examples) {
      assert.equal(computeDeposit(rule, total), expected, `${JSON.stringify(rule)} of ${total}`)
    }
  })

  test('matches an exact BigInt reference over many totals and rules', () => {
    const reference = (rule, total) => {
      const t = BigInt(total)
      const step = BigInt(rule.roundTo)
      const base = rule.kind === 'fixed' ? BigInt(rule.fixedAmount) : (t * BigInt(rule.percent) + 99n) / 100n
      const rounded = ((base + step - 1n) / step) * step

      return Number(rounded < t ? rounded : t)
    }
    const totals = [0, 1, 2, 49, 50, 51, 99, 100, 101, 999, 3333, 6500, 9999, 123_457, MAXIMUM_DEPOSIT_BASE_TOTAL]
    const rules = []

    for (const roundTo of DEPOSIT_ROUND_TO_VALUES) {
      for (const percent of [1, 7, 15, 20, 33, 50, 99, 100]) {
        rules.push({ kind: 'percent', percent, roundTo })
      }

      for (const fixedAmount of [1, 499, 1000, 1025, 1_000_000]) {
        rules.push({ kind: 'fixed', fixedAmount, roundTo })
      }
    }

    for (const rule of rules) {
      for (const total of totals) {
        const deposit = computeDeposit(rule, total)
        assert.equal(deposit, reference(rule, total), `${JSON.stringify(rule)} of ${total}`)
        assert.ok(Number.isSafeInteger(deposit) && deposit >= 0 && deposit <= total)
      }
    }
  })

  test('a total that is not an integer in range, or a rule outside the CHECKs, throws', () => {
    const rule = { kind: 'percent', percent: 20, roundTo: 50 }

    for (const total of [-1, 0.5, 6500.1, Number.NaN, Number.POSITIVE_INFINITY, MAXIMUM_DEPOSIT_BASE_TOTAL + 1, '6500']) {
      assert.throws(() => computeDeposit(rule, total), RangeError, String(total))
    }

    for (const bad of [
      { kind: 'percent', percent: 0, roundTo: 50 },
      { kind: 'percent', percent: 101, roundTo: 50 },
      { kind: 'percent', percent: 20.5, roundTo: 50 },
      { kind: 'percent', percent: 20, roundTo: 3 },
      { kind: 'fixed', fixedAmount: 0, roundTo: 1 },
      { kind: 'fixed', fixedAmount: 1_000_001, roundTo: 1 },
      { kind: 'fixed', fixedAmount: Number.NaN, roundTo: 1 },
      { kind: 'share', percent: 20, roundTo: 50 },
    ]) {
      assert.equal(isDepositRule(bad), false, JSON.stringify(bad))
      assert.throws(() => computeDeposit(bad, 6500), RangeError, JSON.stringify(bad))
    }
  })
})
