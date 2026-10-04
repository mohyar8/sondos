import {
  isDepositRoundTo,
  MAXIMUM_DEPOSIT_FIXED_AMOUNT,
  MAXIMUM_DEPOSIT_PERCENT,
  MINIMUM_DEPOSIT_FIXED_AMOUNT,
  MINIMUM_DEPOSIT_PERCENT,
  type DepositRule,
} from './deposit.js'
import {
  findPaymentInstructionLike,
  normalizeFreeText,
  toAsciiDigits,
  type FreeTextResult,
  type FreeTextRule,
} from './text.js'

/**
 * Admin settings contracts (plan 11 §2.2 settings_revisions, §3.3 #29–#34,
 * TM-03, TM-04, GAP-03). Shared by the Worker, which has the final word, and
 * the admin settings forms, which show the same verdict before saving. Pure
 * functions: no I/O, no logging; an IBAN, a phone number or a text value is
 * never echoed in an error, only the error code and the field name.
 *
 * Every limit of the four sections equals the settings_revisions CHECK on
 * its column (0008_golive_admin_settings.sql), so a value these guards
 * accept is a value the database accepts. The business identity (GAP-03)
 * has no column yet; its section below states the CHECKs its table needs.
 */

export const SETTINGS_SECTIONS = ['deposit', 'bank', 'contact', 'pickup'] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/**
 * TM-03: the sections whose change to an existing revision reaches
 * customers only at effective_at (created_at + 24 h) unless the saving
 * token carried a second factor. The only ones that can be pending.
 */
export const DELAYED_SETTINGS_SECTIONS = ['bank', 'contact'] as const

export type DelayedSettingsSection = (typeof DELAYED_SETTINGS_SECTIONS)[number]

/**
 * TM-03: for this long after a bank, contact, deposit, terms or switch
 * change, the admin sees it in the fraud-visibility banner, and customers
 * see the "studio number changed" notice after a contact change.
 */
export const SENSITIVE_CHANGE_NOTICE_HOURS = 72

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section === value)
}

// ---------------------------------------------------------------------------
// Limits (= the settings_revisions CHECKs)
// ---------------------------------------------------------------------------

/** settings_revisions.bank_iban: 'SA', two check digits, 20 more. */
export const SAUDI_IBAN_LENGTH = 24

/** settings_revisions.whatsapp_number: 8 to 15 digits, the first not 0. */
export const MINIMUM_WHATSAPP_DIGITS = 8
export const MAXIMUM_WHATSAPP_DIGITS = 15

/**
 * The longest raw IBAN or phone input read at all (typed with spaces,
 * pasted with direction marks): anything longer is refused unread.
 */
export const MAXIMUM_IBAN_INPUT_LENGTH = 64
export const MAXIMUM_PHONE_INPUT_LENGTH = 32

/**
 * Free-text rules per field (SB-16), in code points like SQLite's length().
 * The bank names and the legal name are one line with links and handles
 * refused; the pickup fields may hold line breaks (their CHECKs allow
 * char(10) only). The optional fields (pickup instructions, legal name)
 * read an empty value as "not filled" (null) before these bounds apply.
 */
export const SETTINGS_TEXT_RULES = {
  bankName: { kind: 'name', minCodePoints: 2, maxCodePoints: 80 },
  accountHolder: { kind: 'name', minCodePoints: 2, maxCodePoints: 120 },
  pickupAddress: { kind: 'multi-line', minCodePoints: 5, maxCodePoints: 300 },
  pickupInstructions: { kind: 'multi-line', minCodePoints: 1, maxCodePoints: 500 },
  legalName: { kind: 'name', minCodePoints: 2, maxCodePoints: 120 },
} as const satisfies Record<string, FreeTextRule>

/**
 * GAP-03: the licence number's length once spaces are removed, and the
 * longest raw input read at all.
 */
export const MINIMUM_LICENCE_NUMBER_LENGTH = 4
export const MAXIMUM_LICENCE_NUMBER_LENGTH = 32
const MAXIMUM_LICENCE_NUMBER_INPUT_LENGTH = 64

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * The 400 codes of plan 11 §3.1: INVALID_REQUEST_BODY for a wrong shape,
 * type or length, and the domain codes for the rest.
 */
export type SettingsInputErrorCode =
  | 'INVALID_REQUEST_BODY'
  | 'INVALID_IBAN'
  | 'INVALID_PHONE'
  | 'INVALID_TEXT'
  | 'CONTENT_NOT_ALLOWED'

export type SettingsInputResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly code: SettingsInputErrorCode
      /** The body key at fault, or null for the body as a whole. */
      readonly field: string | null
    }

function invalid<T>(
  code: SettingsInputErrorCode,
  field: string | null,
): SettingsInputResult<T> {
  return { ok: false, code, field }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Exactly these own keys, no other (SB-3; `__proto__` counts as a key). */
function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value)

  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

function isIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
}

/**
 * The verdict on one normalizeFreeText result (SB-16) and, since every
 * settings text reaches customers, findPaymentInstructionLike (SB-17,
 * TM-04), which allows the studio's own number (`studioDigits`) and
 * nothing else.
 */
function toTextResult(
  text: FreeTextResult,
  field: string,
  studioDigits: string | null,
): SettingsInputResult<string> {
  if (!text.ok) {
    return invalid(
      text.problem === 'forbidden-character' ||
        text.problem === 'link-or-handle'
        ? 'INVALID_TEXT'
        : 'INVALID_REQUEST_BODY',
      field,
    )
  }

  if (findPaymentInstructionLike(text.value, studioDigits) !== null) {
    return invalid('CONTENT_NOT_ALLOWED', field)
  }

  return { ok: true, value: text.value }
}

/** A required free-text field. */
function readText(
  value: unknown,
  field: string,
  rule: FreeTextRule,
  studioDigits: string | null,
): SettingsInputResult<string> {
  return toTextResult(normalizeFreeText(value, rule), field, studioDigits)
}

/**
 * An optional free-text field: null, or a value that is empty once
 * trimmed, is "not filled" (null, stored as NULL); anything else is read
 * as a required field.
 */
function readOptionalText(
  value: unknown,
  field: string,
  rule: FreeTextRule,
  studioDigits: string | null,
): SettingsInputResult<string | null> {
  if (value === null) {
    return { ok: true, value: null }
  }

  const text = normalizeFreeText(value, rule)

  if (!text.ok && text.problem === 'empty') {
    return { ok: true, value: null }
  }

  return toTextResult(text, field, studioDigits)
}

// ---------------------------------------------------------------------------
// IBAN (ISO 13616) and WhatsApp number
// ---------------------------------------------------------------------------

/**
 * Removed from an IBAN or phone input before it is checked: the spaces it
 * is written in groups with, and the direction marks, embeddings and
 * isolates a value copied from an Arabic screen arrives wrapped in. The
 * result is then checked character by character, so nothing removed here
 * can survive into the stored value.
 */
const IBAN_FORMATTING = /[\s\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
const ASCII_LETTERS_AND_DIGITS = /^[0-9A-Za-z]+$/
/** The settings_revisions.bank_iban CHECK. */
const SAUDI_IBAN_PATTERN = /^SA[0-9]{4}[0-9A-Z]{18}$/
const IBAN_CHECK_MODULUS = 97

/** ISO 13616 / ISO 7064 MOD 97-10 over an upper-case ASCII IBAN. */
function ibanRemainder(iban: string): number {
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`
  let remainder = 0

  for (const character of rearranged) {
    const code = character.charCodeAt(0)

    // '0'–'9' are one digit; 'A'–'Z' are the two digits 10–35.
    remainder =
      code <= 0x39
        ? (remainder * 10 + (code - 0x30)) % IBAN_CHECK_MODULUS
        : (remainder * 100 + (code - 0x41 + 10)) % IBAN_CHECK_MODULUS
  }

  return remainder
}

/**
 * True for a stored-form Saudi IBAN: exactly 24 upper-case ASCII
 * characters, 'SA', four digits, 18 letters or digits, and a valid
 * check sum. The read side re-checks every stored IBAN with it.
 */
export function isValidSaudiIban(value: string): boolean {
  return SAUDI_IBAN_PATTERN.test(value) && ibanRemainder(value) === 1
}

/**
 * The IBAN to store, or null (400 INVALID_IBAN). Arabic-Indic and Persian
 * digits become ASCII, spaces and direction marks are removed, letters are
 * upper-cased (ASCII only: a look-alike letter makes it invalid), then it
 * must be a valid Saudi IBAN (N-22, N-55, UX-07).
 */
export function normalizeIban(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAXIMUM_IBAN_INPUT_LENGTH) {
    return null
  }

  const compactValue = toAsciiDigits(value).replace(IBAN_FORMATTING, '')

  if (!ASCII_LETTERS_AND_DIGITS.test(compactValue)) {
    return null
  }

  const iban = compactValue.toUpperCase()

  return isValidSaudiIban(iban) ? iban : null
}

/**
 * Removed from a phone input: the IBAN_FORMATTING characters plus the
 * dashes, brackets and dots numbers are written with. Any other character
 * (a letter, '?', '=', '/', a '+' after the first position) makes the
 * number invalid, never stripped (N-21).
 */
const PHONE_FORMATTING =
  /[-\s().\u2010-\u2015\u2212\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g
/** settings_revisions.whatsapp_number: E.164 digits without the '+'. */
const WHATSAPP_DIGITS_PATTERN = /^[1-9][0-9]{7,14}$/
/** A Saudi number is 966 and a nine-digit national number. */
const SAUDI_WHATSAPP_DIGITS_PATTERN = /^966[1-9][0-9]{8}$/
const INTERNATIONAL_PREFIX = /^(?:\+|00)([0-9]+)$/
const SAUDI_MOBILE_WITH_ZERO = /^05[0-9]{8}$/
const SAUDI_MOBILE_WITHOUT_ZERO = /^5[0-9]{8}$/
/** «+966 05…»: the national 0 written after the country code. */
const SAUDI_WITH_NATIONAL_ZERO = /^9660[0-9]{9}$/

/**
 * True for a stored-form WhatsApp number: E.164 digits (the CHECK), and a
 * whole Saudi number when it starts with 966. The read side re-checks every
 * stored number with it.
 */
export function isWhatsappDigits(value: string): boolean {
  return (
    WHATSAPP_DIGITS_PATTERN.test(value) &&
    (!value.startsWith('966') || SAUDI_WHATSAPP_DIGITS_PATTERN.test(value))
  )
}

/**
 * The studio WhatsApp number to store as E.164 digits, or null (400
 * INVALID_PHONE). Accepts, in Western, Arabic-Indic or Persian digits and
 * written with spaces, dashes or brackets: `05XXXXXXXX`, `5XXXXXXXX`,
 * `+9665…`, `009665…`, `9665…` (also with the 0 after 966), and any other
 * E.164 number with its country code. The same rules as the SPA's
 * wa.me builder (src/lib/whatsapp.ts toWaMeDigits).
 */
export function normalizeWhatsappNumber(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAXIMUM_PHONE_INPUT_LENGTH) {
    return null
  }

  const compactValue = toAsciiDigits(value).replace(PHONE_FORMATTING, '')
  const international = INTERNATIONAL_PREFIX.exec(compactValue)
  let digits = compactValue

  if (international !== null) {
    digits = international[1]
  } else if (SAUDI_MOBILE_WITH_ZERO.test(compactValue)) {
    digits = `966${compactValue.slice(1)}`
  } else if (SAUDI_MOBILE_WITHOUT_ZERO.test(compactValue)) {
    digits = `966${compactValue}`
  }

  if (SAUDI_WITH_NATIONAL_ZERO.test(digits)) {
    digits = `966${digits.slice(4)}`
  }

  return isWhatsappDigits(digits) ? digits : null
}

// ---------------------------------------------------------------------------
// Section inputs (PUT /api/admin/settings/{section})
// ---------------------------------------------------------------------------

export interface BankSettingsInput {
  readonly bankName: string
  readonly accountHolder: string
  /** Normalised: 24 characters, no spaces (UX-08 copies exactly this). */
  readonly iban: string
}

export interface ContactSettingsInput {
  /** E.164 digits without the '+'. */
  readonly whatsappNumber: string
}

export interface PickupSettingsInput {
  readonly address: string
  readonly instructions: string | null
}

const FIXED_DEPOSIT_KEYS = ['kind', 'fixedAmount', 'roundTo'] as const
const PERCENT_DEPOSIT_KEYS = ['kind', 'percent', 'roundTo'] as const
const BANK_KEYS = ['bankName', 'accountHolder', 'iban'] as const
const CONTACT_KEYS = ['whatsappNumber'] as const
const PICKUP_KEYS = ['address', 'instructions'] as const

/**
 * PUT deposit: `{ "kind": "fixed", "fixedAmount", "roundTo" }` or
 * `{ "kind": "percent", "percent", "roundTo" }`, the exact key set of its
 * kind, JSON integers within the CHECK bounds.
 */
export function parseDepositSettingsInput(
  body: unknown,
): SettingsInputResult<DepositRule> {
  if (!isRecord(body)) {
    return invalid('INVALID_REQUEST_BODY', null)
  }

  const { kind, roundTo } = body

  if (kind === 'fixed') {
    if (!hasExactKeys(body, FIXED_DEPOSIT_KEYS)) {
      return invalid('INVALID_REQUEST_BODY', null)
    }

    const { fixedAmount } = body

    if (
      !isIntegerBetween(
        fixedAmount,
        MINIMUM_DEPOSIT_FIXED_AMOUNT,
        MAXIMUM_DEPOSIT_FIXED_AMOUNT,
      )
    ) {
      return invalid('INVALID_REQUEST_BODY', 'fixedAmount')
    }

    if (!isDepositRoundTo(roundTo)) {
      return invalid('INVALID_REQUEST_BODY', 'roundTo')
    }

    return { ok: true, value: { kind, fixedAmount, roundTo } }
  }

  if (kind === 'percent') {
    if (!hasExactKeys(body, PERCENT_DEPOSIT_KEYS)) {
      return invalid('INVALID_REQUEST_BODY', null)
    }

    const { percent } = body

    if (
      !isIntegerBetween(percent, MINIMUM_DEPOSIT_PERCENT, MAXIMUM_DEPOSIT_PERCENT)
    ) {
      return invalid('INVALID_REQUEST_BODY', 'percent')
    }

    if (!isDepositRoundTo(roundTo)) {
      return invalid('INVALID_REQUEST_BODY', 'roundTo')
    }

    return { ok: true, value: { kind, percent, roundTo } }
  }

  return invalid('INVALID_REQUEST_BODY', 'kind')
}

/**
 * PUT bank: `{ "bankName", "accountHolder", "iban" }`. The names pass the
 * text validator and the content rules too (an IBAN, a phone number or a
 * link hidden in a name would reach customers next to the real details);
 * the IBAN must be a valid Saudi IBAN.
 */
export function parseBankSettingsInput(
  body: unknown,
): SettingsInputResult<BankSettingsInput> {
  if (!isRecord(body) || !hasExactKeys(body, BANK_KEYS)) {
    return invalid('INVALID_REQUEST_BODY', null)
  }

  const bankName = readText(
    body.bankName,
    'bankName',
    SETTINGS_TEXT_RULES.bankName,
    null,
  )

  if (!bankName.ok) {
    return bankName
  }

  const accountHolder = readText(
    body.accountHolder,
    'accountHolder',
    SETTINGS_TEXT_RULES.accountHolder,
    null,
  )

  if (!accountHolder.ok) {
    return accountHolder
  }

  if (typeof body.iban !== 'string') {
    return invalid('INVALID_REQUEST_BODY', 'iban')
  }

  const iban = normalizeIban(body.iban)

  if (iban === null) {
    return invalid('INVALID_IBAN', 'iban')
  }

  return {
    ok: true,
    value: {
      bankName: bankName.value,
      accountHolder: accountHolder.value,
      iban,
    },
  }
}

/** PUT contact: `{ "whatsappNumber" }`, stored as E.164 digits. */
export function parseContactSettingsInput(
  body: unknown,
): SettingsInputResult<ContactSettingsInput> {
  if (!isRecord(body) || !hasExactKeys(body, CONTACT_KEYS)) {
    return invalid('INVALID_REQUEST_BODY', null)
  }

  if (typeof body.whatsappNumber !== 'string') {
    return invalid('INVALID_REQUEST_BODY', 'whatsappNumber')
  }

  const whatsappNumber = normalizeWhatsappNumber(body.whatsappNumber)

  if (whatsappNumber === null) {
    return invalid('INVALID_PHONE', 'whatsappNumber')
  }

  return { ok: true, value: { whatsappNumber } }
}

/**
 * PUT pickup: `{ "address", "instructions" }`; instructions may be null or
 * empty (stored as NULL). Both are customer-visible admin text, so both
 * pass the content rules (TM-04), which allow only the studio's own number:
 * `studioDigits`, the effective contact number, or null for none.
 */
export function parsePickupSettingsInput(
  body: unknown,
  studioDigits: string | null,
): SettingsInputResult<PickupSettingsInput> {
  if (!isRecord(body) || !hasExactKeys(body, PICKUP_KEYS)) {
    return invalid('INVALID_REQUEST_BODY', null)
  }

  const address = readText(
    body.address,
    'address',
    SETTINGS_TEXT_RULES.pickupAddress,
    studioDigits,
  )

  if (!address.ok) {
    return address
  }

  const instructions = readOptionalText(
    body.instructions,
    'instructions',
    SETTINGS_TEXT_RULES.pickupInstructions,
    studioDigits,
  )

  if (!instructions.ok) {
    return instructions
  }

  return {
    ok: true,
    value: { address: address.value, instructions: instructions.value },
  }
}

// ---------------------------------------------------------------------------
// Stored revisions as the read side returns them
// ---------------------------------------------------------------------------

export interface SettingsRevisionMeta {
  readonly revisionId: number
  /** When the admin saved it (created_at, stamped by SQL). */
  readonly savedAt: string
  /**
   * When it reaches customers: effective_at for a delayed change (TM-03),
   * else savedAt. Customers' «آخر تحديث لبيانات الحساب» is this time.
   */
  readonly activeFrom: string
}

export interface DepositSettings extends SettingsRevisionMeta {
  readonly rule: DepositRule
}

export interface BankSettings extends SettingsRevisionMeta, BankSettingsInput {}

export interface ContactSettings
  extends SettingsRevisionMeta,
    ContactSettingsInput {}

export interface PickupSettings extends SettingsRevisionMeta, PickupSettingsInput {}

export interface SettingsBySection {
  readonly deposit: DepositSettings
  readonly bank: BankSettings
  readonly contact: ContactSettings
  readonly pickup: PickupSettings
}

/** The revision of each section in force now; null when there is none. */
export type EffectiveSettings = {
  readonly [Section in SettingsSection]: SettingsBySection[Section] | null
}

/** The saved change of each delayed section not yet in force (TM-03). */
export type PendingSettings = {
  readonly [Section in DelayedSettingsSection]: SettingsBySection[Section] | null
}

/** The current (highest-seq) booking terms version. */
export interface CurrentTermsVersion {
  readonly version: string
  readonly seq: number
  readonly publishedAt: string
  readonly bodySha256: string
}

/**
 * H3: the D1 kill switch for online confirmation. No row means it was never
 * pulled ('on'); a row that fails its guard reads as 'off'.
 */
export const KILL_SWITCH_STATES = ['on', 'off'] as const

export type KillSwitchState = (typeof KILL_SWITCH_STATES)[number]

export interface KillSwitchReading {
  readonly state: KillSwitchState
  /** The ops_switch_revisions row behind `state`; null when there is none. */
  readonly revisionId: number | null
  readonly changedAt: string | null
}

/** What online confirmation needs before flow 2 is offered (SET). */
export type OnlineConfirmationRequirement = 'deposit' | 'bank' | 'terms'

/** One row of the fraud-visibility banner (§3.3 #29 recentSensitiveChanges). */
export interface RecentSensitiveChange {
  readonly section: 'deposit' | 'bank' | 'contact' | 'terms' | 'switch'
  /** The settings revision id, the terms seq or the switch revision id. */
  readonly revisionId: number
  readonly at: string
}

/**
 * The studio number customers are sent to (§3.3 #1 `studio`): the effective
 * contact revision, or null (the SPA then uses its compiled number), and
 * when it replaced the number of an earlier contact revision, if that is at
 * most SENSITIVE_CHANGE_NOTICE_HOURS ago; null otherwise, and always null
 * for the first contact revision.
 */
export interface StudioContact {
  readonly whatsappNumber: string | null
  readonly whatsappNumberChangedAt: string | null
}

// ---------------------------------------------------------------------------
// Business identity (GAP-03, decision D19(d))
// ---------------------------------------------------------------------------

/**
 * The seller identity the e-commerce disclosure names, entered by the
 * owner in the admin settings (the fields legal_name, licence_number and
 * vat_status). Public once saved: the disclosure page shows each field,
 * and only when it is filled (toPublicBusinessIdentity).
 *
 * This is the contract and its guards only: no migration stores these
 * fields yet (0008 limits settings_revisions to the four sections above,
 * and widening its section CHECK would rebuild the table). The migration
 * that adds them creates its own append-only revision table (no-update,
 * no-delete and no-replace triggers, reauth_at required, as 0008/0009)
 * whose CHECKs are these rules: legal_name NULL or 2 to 120 code points
 * without control characters; licence_number NULL or 4 to 32 of
 * [0-9A-Z-], at least one digit, no leading, trailing or doubled hyphen;
 * vat_status NOT NULL, one of VAT_STATUSES. Its reader passes every
 * stored row through readStoredBusinessIdentity, which re-runs the content
 * rules no CHECK can express and reads a row that fails as not filled, so
 * a row written around the API never reaches the public page (fail
 * closed).
 */

/** The owner's VAT registration status; 'unknown' is shown as nothing. */
export const VAT_STATUSES = ['registered', 'not_registered', 'unknown'] as const

export type VatStatus = (typeof VAT_STATUSES)[number]

export interface BusinessIdentity {
  /** Her legal or trade name as registered; null until filled. */
  readonly legalName: string | null
  /**
   * Her freelance document or commercial registration number, upper-case
   * ASCII; null until filled.
   */
  readonly licenceNumber: string | null
  readonly vatStatus: VatStatus
}

/** What the disclosure page may render: null means "leave the line out". */
export interface PublicBusinessIdentity {
  readonly legalName: string | null
  readonly licenceNumber: string | null
  readonly vatStatus: Exclude<VatStatus, 'unknown'> | null
}

const BUSINESS_IDENTITY_KEYS = ['legalName', 'licenceNumber', 'vatStatus'] as const
/** Groups of ASCII letters and digits, one hyphen between two groups. */
const LICENCE_NUMBER_PATTERN = /^[0-9A-Z]+(?:-[0-9A-Z]+)*$/
const ASCII_LETTERS_DIGITS_AND_HYPHENS = /^[0-9A-Za-z-]+$/
const ASCII_DIGIT = /[0-9]/
const HYPHENS = /-/g
/**
 * TM-04's IBAN-like token (shared/text.ts) once the spaces and hyphens are
 * gone: 'SA', two check digits and ten or more letters or digits, anywhere
 * in the value.
 */
const SAUDI_IBAN_LIKE = /SA[0-9]{2}[0-9A-Z]{10,}/
const DIGIT_RUNS = /[0-9]+/g
/**
 * A commercial registration or unified national number: ten digits whose
 * first is 1 to 7 (a registration office code, or the unified number's 7),
 * never the 0 of a national phone number or the 8 of an 800 number.
 */
const REGISTRATION_NUMBER = /^[1-7][0-9]{9}$/
/** TM-04: nine digits starting like a mobile (5…) or unified (9200…) number. */
const NINE_DIGIT_PHONE = /^[59][0-9]{8}$/
/** Seven or more digits after a 0: a trunk (05…, 011…) or 00 prefix. */
const PREFIXED_NUMBER = /^0[0-9]{6,}$/

/**
 * TM-04's number rules on one run of digits, with the single exception a
 * licence number needs: a run of ten or more digits is an account or phone
 * number (05…, 9665…, 009665…, a landline, a foreign number, a bare account
 * number) unless it is exactly a registration number; below ten, a mobile
 * or unified number without its prefix, or any number of seven or more
 * digits starting with 0, is a phone number.
 */
function isAccountOrPhoneLike(digits: string): boolean {
  if (digits.length >= 10) {
    return !REGISTRATION_NUMBER.test(digits)
  }

  return NINE_DIGIT_PHONE.test(digits) || PREFIXED_NUMBER.test(digits)
}

export function isVatStatus(value: unknown): value is VatStatus {
  return VAT_STATUSES.some((status) => status === value)
}

/**
 * The licence number to store, or its error. Arabic-Indic and Persian
 * digits become ASCII, spaces and direction marks are removed and letters
 * are upper-cased (ASCII only); what is left must be 4 to 32 letters and
 * digits in groups joined by single hyphens, with at least one digit
 * (INVALID_TEXT). An empty value is "not filled" (null).
 *
 * The disclosure page shows it next to the seller's name at once, with no
 * delay or "changed" notice, so it passes TM-04's content rules wherever
 * its digits sit: a leading or trailing group ('IBAN-', 'TEL-', '-1') hides
 * nothing, and hyphens join the digits around them as a reader would. No
 * IBAN-like token, and no run of digits isAccountOrPhoneLike refuses
 * (CONTENT_NOT_ALLOWED). findPaymentInstructionLike itself is not used:
 * it refuses every run of ten digits, and a registration number is one.
 */
function readLicenceNumber(value: unknown): SettingsInputResult<string | null> {
  if (value === null) {
    return { ok: true, value: null }
  }

  if (
    typeof value !== 'string' ||
    value.length > MAXIMUM_LICENCE_NUMBER_INPUT_LENGTH
  ) {
    return invalid('INVALID_REQUEST_BODY', 'licenceNumber')
  }

  const compactValue = toAsciiDigits(value).replace(IBAN_FORMATTING, '')

  if (compactValue === '') {
    return { ok: true, value: null }
  }

  if (
    compactValue.length < MINIMUM_LICENCE_NUMBER_LENGTH ||
    compactValue.length > MAXIMUM_LICENCE_NUMBER_LENGTH ||
    !ASCII_LETTERS_DIGITS_AND_HYPHENS.test(compactValue)
  ) {
    return invalid('INVALID_TEXT', 'licenceNumber')
  }

  const licenceNumber = compactValue.toUpperCase()

  if (
    !LICENCE_NUMBER_PATTERN.test(licenceNumber) ||
    !ASCII_DIGIT.test(licenceNumber)
  ) {
    return invalid('INVALID_TEXT', 'licenceNumber')
  }

  const unbrokenValue = licenceNumber.replace(HYPHENS, '')

  if (SAUDI_IBAN_LIKE.test(unbrokenValue)) {
    return invalid('CONTENT_NOT_ALLOWED', 'licenceNumber')
  }

  for (const [digits] of unbrokenValue.matchAll(DIGIT_RUNS)) {
    if (isAccountOrPhoneLike(digits)) {
      return invalid('CONTENT_NOT_ALLOWED', 'licenceNumber')
    }
  }

  return { ok: true, value: licenceNumber }
}

/**
 * The business-identity form: `{ "legalName", "licenceNumber",
 * "vatStatus" }`, every key required. A name or number may be null or
 * empty (not filled yet). The legal name is public text, so it passes the
 * text validator and the content rules (no account or phone numbers,
 * links or handles).
 */
export function parseBusinessIdentityInput(
  body: unknown,
): SettingsInputResult<BusinessIdentity> {
  if (!isRecord(body) || !hasExactKeys(body, BUSINESS_IDENTITY_KEYS)) {
    return invalid('INVALID_REQUEST_BODY', null)
  }

  const legalName = readOptionalText(
    body.legalName,
    'legalName',
    SETTINGS_TEXT_RULES.legalName,
    null,
  )

  if (!legalName.ok) {
    return legalName
  }

  const licenceNumber = readLicenceNumber(body.licenceNumber)

  if (!licenceNumber.ok) {
    return licenceNumber
  }

  if (!isVatStatus(body.vatStatus)) {
    return invalid('INVALID_REQUEST_BODY', 'vatStatus')
  }

  return {
    ok: true,
    value: {
      legalName: legalName.value,
      licenceNumber: licenceNumber.value,
      vatStatus: body.vatStatus,
    },
  }
}

/**
 * The read-side guard for a stored business identity, its columns read as
 * legalName, licenceNumber and vatStatus (other keys of the row are not
 * looked at): the identity when parseBusinessIdentityInput accepts the
 * stored values and changes none of them, else null ("not filled"). A
 * stored value the write guard would have normalised (untrimmed, a
 * lower-case licence letter) was not written by it, so it fails too.
 */
export function readStoredBusinessIdentity(stored: {
  readonly legalName?: unknown
  readonly licenceNumber?: unknown
  readonly vatStatus?: unknown
}): BusinessIdentity | null {
  const { legalName, licenceNumber, vatStatus } = stored
  const identity = parseBusinessIdentityInput({
    legalName,
    licenceNumber,
    vatStatus,
  })

  if (
    !identity.ok ||
    identity.value.legalName !== legalName ||
    identity.value.licenceNumber !== licenceNumber
  ) {
    return null
  }

  return identity.value
}

/**
 * The fields the disclosure page renders; each is null until the owner
 * fills it (D19(d): hidden until filled, never a placeholder), and null
 * for no identity saved at all.
 */
export function toPublicBusinessIdentity(
  identity: BusinessIdentity | null,
): PublicBusinessIdentity {
  if (identity === null) {
    return { legalName: null, licenceNumber: null, vatStatus: null }
  }

  return {
    legalName: identity.legalName,
    licenceNumber: identity.licenceNumber,
    vatStatus: identity.vatStatus === 'unknown' ? null : identity.vatStatus,
  }
}
