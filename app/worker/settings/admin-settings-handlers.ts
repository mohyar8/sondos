import {
  deliveryAreaCreatedAudit,
  deliveryAreaUpdatedAudit,
  onlineConfirmationSwitchedAudit,
} from '../../shared/audit.js'
import {
  parseBankSettingsInput,
  parseBusinessIdentityInput,
  parseContactSettingsInput,
  parseDepositSettingsInput,
  parsePickupSettingsInput,
  type EffectiveSettings,
  type PendingSettings,
  type SettingsInputErrorCode,
  type SettingsInputResult,
  type SettingsRevisionMeta,
} from '../../shared/settings.js'
import {
  findPaymentInstructionLike,
  normalizeFreeText,
  type FreeTextResult,
  type FreeTextRule,
} from '../../shared/text.js'
import type { AuthenticatedAdmin } from '../admin-auth.js'
import type { AdminAuditActor } from '../audit/admin-audit.js'
import {
  notifySettingsChange,
  type SettingsAlertSection,
} from '../emails/admin-alert.js'
import { errorResponse, jsonResponse } from '../http.js'
import type { AdminPortalContext } from '../portal/admin-portal-routes.js'
import { readJsonBody, type JsonBodySpec } from '../portal/request.js'
import { limitBurst, rateLimitedResponse } from '../rate-limit.js'
import {
  hasAdminSecondFactor,
  reauthAtFromToken,
  requireRecentSignIn,
  requireSettingsSecondFactor,
} from '../recent-auth.js'
import { resolveFeatures } from './features.js'
import {
  readEffectiveSettings,
  readSettingsSnapshot,
} from './settings-read.js'
import {
  MAXIMUM_DELIVERY_FEE,
  MAXIMUM_DELIVERY_SORT_ORDER,
  MAXIMUM_HISTORY_PAGE,
  MAXIMUM_TERMS_SEQ,
  createDeliveryArea,
  isDeliveryAreaId,
  isHistorySection,
  isTermsVersion,
  listDeliveryAreas,
  listTermsVersions,
  publishTermsVersion,
  readCurrentBusinessIdentity,
  readDeliveryAreaById,
  readSettingsHistory,
  readTermsVersion,
  updateDeliveryArea,
  writeBankSettings,
  writeBusinessIdentity,
  writeContactSettings,
  writeDepositSettings,
  writeKillSwitch,
  writePickupSettings,
  type DeliveryArea,
  type RevisionWriteResult,
  type SettingsWriter,
} from './settings-write.js'

/**
 * The admin settings API (plan 11 §3.2/§3.3 #29–#34, #43; TM-03, TM-04,
 * TM-12, TM-18, M1, H2, H3, GAP-03, GAP-05; SB-2…SB-4, SB-9, SB-10, SB-14,
 * SB-16, SB-17). Every route runs behind the admin guard of the dispatcher
 * (admin-portal-routes.ts: AD). On top of it, checked first, before the body
 * is read:
 * - AD+S (deposit, bank, contact, terms publish): a sign-in at most 9.5 min
 *   old (403 REAUTH_REQUIRED), then the TOTP claim once ADMIN_SETTINGS_2F is
 *   exactly "required" (403 SECOND_FACTOR_REQUIRED, N-45);
 * - AD+R (pickup, business identity, switch to "on"): the recent sign-in;
 * - AD (reads, delivery areas, switch to "off": a safety action must never
 *   wait for a password).
 * Reads also pass the RL_ADMIN_READ burst (429). Bodies: exact key sets
 * and byte caps (request.ts readJsonBody), then the shared guards
 * (shared/settings.ts); every admin text a customer sees (pickup, delivery
 * area names, terms body and summary) passes normalizeFreeText and the
 * content rules, which allow only the effective studio number (400
 * CONTENT_NOT_ALLOWED, N-33). The terms are plain text: markup is refused.
 *
 * Writes go through settings-write.ts (one batch: the row and its audit
 * row, created_at by SQL). After a committed bank, contact, deposit, terms
 * or switch change, the admin alert email is handed to ctx.waitUntil
 * (emails/admin-alert.ts: section and time only). Nothing here logs; an
 * error answer carries a fixed code and message, never a value.
 */

type Handler = (context: AdminPortalContext) => Promise<Response>

const HOUR_MS = 60 * 60 * 1000
const DEFAULT_HISTORY_PAGE = 20

/** Byte caps per body (code-point limits × 4 bytes with room for JSON escapes). */
const BODY_BYTES = {
  deposit: 1_024,
  bank: 4_096,
  contact: 512,
  pickup: 16_384,
  identity: 2_048,
  terms: 131_072,
  switch: 4_096,
  deliveryArea: 1_024,
} as const

/** terms_versions.body and change_summary (0008 CHECKs); multi-line body. */
const TERMS_BODY_RULE: FreeTextRule = {
  kind: 'multi-line',
  minCodePoints: 50,
  maxCodePoints: 20_000,
}
const TERMS_SUMMARY_RULE: FreeTextRule = {
  kind: 'single-line',
  maxCodePoints: 300,
}
/** delivery_areas.name (0008 CHECK): a name, so links and handles are refused. */
const DELIVERY_AREA_NAME_RULE: FreeTextRule = {
  kind: 'name',
  minCodePoints: 2,
  maxCodePoints: 60,
}
/** ops_switch_revisions.note (0009 CHECK); admin-only. */
const SWITCH_NOTE_RULE: FreeTextRule = {
  kind: 'single-line',
  maxCodePoints: 300,
}

/**
 * Markup in the terms: '<' followed by a letter, '/', '!' or '?' opens a
 * tag, comment or processing instruction. The terms are rendered as plain
 * text everywhere (TM-18), so a tag would only ever be shown as characters;
 * refusing it keeps the stored text what customers read.
 */
const MARKUP_TAG = /<\s*[A-Za-z/!?]/
const HISTORY_LIMIT = /^[1-9][0-9]?$/
const HISTORY_CURSOR = /^[1-9][0-9]{0,15}$/

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const inputErrorMessages: Readonly<Record<SettingsInputErrorCode, string>> = {
  INVALID_REQUEST_BODY: 'بيانات الطلب غير صحيحة.',
  INVALID_IBAN: 'رقم الآيبان غير صحيح. يجب أن يبدأ بـ SA ويتكون من 24 خانة.',
  INVALID_PHONE: 'رقم الواتساب غير صحيح.',
  INVALID_TEXT: 'يحتوي النص على رموز غير مسموح بها.',
  CONTENT_NOT_ALLOWED:
    'لا يمكن أن يتضمن هذا النص أرقام حسابات أو روابط أو أرقام هواتف.',
}

function inputErrorResponse(code: SettingsInputErrorCode): Response {
  return errorResponse(400, code, inputErrorMessages[code])
}

function invalidQueryResponse(): Response {
  return errorResponse(400, 'INVALID_QUERY', 'معاملات الطلب غير صحيحة.')
}

function termsConflictResponse(): Response {
  return errorResponse(
    409,
    'TERMS_VERSION_CONFLICT',
    'نُشرت نسخة أحدث من الشروط. حدّثي الصفحة ثم أعيدي المحاولة.',
  )
}

function termsNotFoundResponse(): Response {
  return errorResponse(
    404,
    'TERMS_VERSION_NOT_FOUND',
    'لم يتم العثور على هذه النسخة من شروط الحجز.',
  )
}

function deliveryAreaNotFoundResponse(): Response {
  return errorResponse(
    404,
    'DELIVERY_AREA_NOT_FOUND',
    'لم يتم العثور على منطقة التوصيل.',
  )
}

function deliveryAreaNameTakenResponse(): Response {
  return errorResponse(
    409,
    'DELIVERY_AREA_NAME_TAKEN',
    'توجد منطقة توصيل بهذا الاسم. اختاري اسمًا آخر.',
  )
}

function deliveryAreaLimitResponse(): Response {
  return errorResponse(
    409,
    'DELIVERY_AREA_LIMIT',
    'وصلتِ إلى الحد الأقصى لعدد مناطق التوصيل. أوقفي منطقة غير مستخدمة وعدّليها بدل إضافة منطقة جديدة.',
  )
}

function deliveryAreaChangedResponse(): Response {
  return errorResponse(
    409,
    'DELIVERY_AREA_CHANGED',
    'تغيّرت بيانات المنطقة أثناء الحفظ. حدّثي الصفحة ثم أعيدي المحاولة.',
  )
}

function unchangedResponse(): Response {
  return jsonResponse({ ok: true, unchanged: true })
}

// ---------------------------------------------------------------------------
// Guards and inputs
// ---------------------------------------------------------------------------

/** AD+S: the recent sign-in, then the settings second factor (N-45). */
function requireSensitiveSettingsAuth(
  env: Env,
  admin: AuthenticatedAdmin,
): Response | null {
  return requireRecentSignIn(admin) ?? requireSettingsSecondFactor(env, admin)
}

/** The saving admin, reauth_at from the token's auth_time (M1, SB-14). */
function toWriter(admin: AuthenticatedAdmin): SettingsWriter {
  return { uid: admin.uid, reauthAt: reauthAtFromToken(admin) }
}

async function limitAdminRead(
  env: Env,
  admin: AuthenticatedAdmin,
): Promise<Response | null> {
  return (await limitBurst(env.RL_ADMIN_READ, admin.uid)) === 'limited'
    ? rateLimitedResponse()
    : null
}

/**
 * The query parameters when every key is allowed and none is repeated;
 * null otherwise (400 INVALID_QUERY).
 */
function readQuery(
  url: URL,
  allowedKeys: readonly string[],
): ReadonlyMap<string, string> | null {
  const query = new Map<string, string>()

  for (const [key, value] of url.searchParams) {
    if (!allowedKeys.includes(key) || query.has(key)) {
      return null
    }

    query.set(key, value)
  }

  return query
}

async function readBody(
  request: Request,
  spec: JsonBodySpec,
): Promise<
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly response: Response }
> {
  const read = await readJsonBody(request, spec)

  return read.ok
    ? { ok: true, body: read.body }
    : { ok: false, response: read.response }
}

/**
 * A normalizeFreeText verdict as the settings codes (the shared mapping):
 * forbidden or link-like characters are INVALID_TEXT, anything else that
 * fails INVALID_REQUEST_BODY; then, for customer-visible text, the content
 * rules (CONTENT_NOT_ALLOWED).
 */
function toCheckedText(
  text: FreeTextResult,
  customerVisible: boolean,
  studioDigits: string | null,
): SettingsInputResult<string> {
  if (!text.ok) {
    return {
      ok: false,
      code:
        text.problem === 'forbidden-character' ||
        text.problem === 'link-or-handle'
          ? 'INVALID_TEXT'
          : 'INVALID_REQUEST_BODY',
      field: null,
    }
  }

  if (
    customerVisible &&
    findPaymentInstructionLike(text.value, studioDigits) !== null
  ) {
    return { ok: false, code: 'CONTENT_NOT_ALLOWED', field: null }
  }

  return { ok: true, value: text.value }
}

/** An optional text: null or blank is "not filled" (NULL). */
function readOptionalText(
  value: unknown,
  rule: FreeTextRule,
  customerVisible: boolean,
  studioDigits: string | null,
): SettingsInputResult<string | null> {
  if (value === null) {
    return { ok: true, value: null }
  }

  const text = normalizeFreeText(value, rule)

  if (!text.ok && text.problem === 'empty') {
    return { ok: true, value: null }
  }

  return toCheckedText(text, customerVisible, studioDigits)
}

/** The studio number the content rules allow: the effective contact revision. */
async function readStudioDigits(db: D1Database): Promise<string | null> {
  return (await readEffectiveSettings(db, new Date())).contact?.whatsappNumber ?? null
}

function isStoredDeliveryAreaName(value: unknown): value is string {
  const text = normalizeFreeText(value, DELIVERY_AREA_NAME_RULE)

  return text.ok && text.value === value
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

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Whole hours from saving to taking effect (0, 24 or 72). */
function delayHours(meta: SettingsRevisionMeta): number {
  return Math.round(
    (Date.parse(meta.activeFrom) - Date.parse(meta.savedAt)) / HOUR_MS,
  )
}

function revisionView(meta: SettingsRevisionMeta): {
  readonly revisionId: number
  readonly updatedAt: string
  readonly activeFrom: string
} {
  return {
    revisionId: meta.revisionId,
    updatedAt: meta.savedAt,
    activeFrom: meta.activeFrom,
  }
}

function effectiveView(effective: EffectiveSettings) {
  const { deposit, bank, contact, pickup } = effective

  return {
    deposit:
      deposit === null
        ? null
        : {
            ...revisionView(deposit),
            kind: deposit.rule.kind,
            fixedAmount:
              deposit.rule.kind === 'fixed' ? deposit.rule.fixedAmount : null,
            percent: deposit.rule.kind === 'percent' ? deposit.rule.percent : null,
            roundTo: deposit.rule.roundTo,
          },
    bank:
      bank === null
        ? null
        : {
            ...revisionView(bank),
            bankName: bank.bankName,
            accountHolder: bank.accountHolder,
            iban: bank.iban,
          },
    contact:
      contact === null
        ? null
        : { ...revisionView(contact), whatsappNumber: contact.whatsappNumber },
    pickup:
      pickup === null
        ? null
        : {
            ...revisionView(pickup),
            address: pickup.address,
            instructions: pickup.instructions,
          },
  }
}

/**
 * A pending change as #29 lists it (TM-03): when it was saved and when it
 * reaches customers. `pairedChange` (GAP-05) marks the 72 h delay of a bank
 * change after a number change, or the reverse: the admin alert banner.
 * The pending values are not repeated here (GET history has them).
 */
function pendingEntry(meta: SettingsRevisionMeta | null) {
  if (meta === null) {
    return null
  }

  const hours = delayHours(meta)

  return {
    revisionId: meta.revisionId,
    savedAt: meta.savedAt,
    effectiveAt: meta.activeFrom,
    delayHours: hours,
    pairedChange: hours > 24,
  }
}

function pendingView(pending: PendingSettings) {
  return { bank: pendingEntry(pending.bank), contact: pendingEntry(pending.contact) }
}

function savedRevisionResponse(
  result: Extract<RevisionWriteResult, { kind: 'saved' }>,
): Response {
  const hours = delayHours(result)

  return jsonResponse({
    ok: true,
    revisionId: result.revisionId,
    savedAt: result.savedAt,
    effectiveAt: result.activeFrom,
    delayed: result.effectiveAt !== null,
    delayHours: hours,
    pairedChange: hours > 24,
    cancelledPending: result.cancelledPending,
  })
}

function alertAfterCommit(
  context: AdminPortalContext,
  section: SettingsAlertSection,
  reference: string,
  changedAt: string,
  effectiveAt: string | null,
): void {
  context.ctx.waitUntil(
    notifySettingsChange(context.env, {
      section,
      reference,
      changedAt,
      effectiveAt,
    }),
  )
}

// ---------------------------------------------------------------------------
// #29 GET /api/admin/settings
// ---------------------------------------------------------------------------

export const handleGetSettings: Handler = async ({ env, url, admin }) => {
  const limited = await limitAdminRead(env, admin)

  if (limited) {
    return limited
  }

  if (readQuery(url, []) === null) {
    return invalidQueryResponse()
  }

  const now = new Date()
  const snapshot = await readSettingsSnapshot(env.DB, now)
  const [deliveryAreas, identity] = await Promise.all([
    listDeliveryAreas(env.DB, isStoredDeliveryAreaName),
    readCurrentBusinessIdentity(env.DB),
  ])

  return jsonResponse({
    ok: true,
    settings: {
      ...effectiveView(snapshot.effective),
      terms:
        snapshot.terms === null
          ? null
          : {
              version: snapshot.terms.version,
              seq: snapshot.terms.seq,
              publishedAt: snapshot.terms.publishedAt,
              bodySha256: snapshot.terms.bodySha256,
            },
      deliveryAreas,
      identity:
        identity === null
          ? null
          : {
              revisionId: identity.revisionId,
              legalName: identity.legalName,
              licenceNumber: identity.licenceNumber,
              vatStatus: identity.vatStatus,
              updatedAt: identity.savedAt,
            },
    },
    pending: pendingView(snapshot.pending),
    features: resolveFeatures(env, snapshot),
    killSwitch: {
      state: snapshot.killSwitch.state,
      revisionId: snapshot.killSwitch.revisionId,
      changedAt: snapshot.killSwitch.changedAt,
    },
    recentSensitiveChanges: snapshot.recentSensitiveChanges,
    serverTime: now.toISOString(),
  })
}

// ---------------------------------------------------------------------------
// #30 PUT deposit, bank, contact (AD+S); #31 PUT pickup (AD+R)
// ---------------------------------------------------------------------------

export const handlePutDeposit: Handler = async (context) => {
  const { request, env, admin } = context
  const refusal = requireSensitiveSettingsAuth(env, admin)

  if (refusal) {
    return refusal
  }

  const read = await readBody(request, {
    maxBytes: BODY_BYTES.deposit,
    requiredKeys: ['kind', 'roundTo'],
    optionalKeys: ['fixedAmount', 'percent'],
  })

  if (!read.ok) {
    return read.response
  }

  const rule = parseDepositSettingsInput(read.body)

  if (!rule.ok) {
    return inputErrorResponse(rule.code)
  }

  const result = await writeDepositSettings(env.DB, toWriter(admin), rule.value)

  if (result.kind === 'unchanged') {
    return unchangedResponse()
  }

  alertAfterCommit(context, 'deposit', String(result.revisionId), result.savedAt, null)

  return savedRevisionResponse(result)
}

export const handlePutBank: Handler = async (context) => {
  const { request, env, admin } = context
  const refusal = requireSensitiveSettingsAuth(env, admin)

  if (refusal) {
    return refusal
  }

  const read = await readBody(request, {
    maxBytes: BODY_BYTES.bank,
    requiredKeys: ['bankName', 'accountHolder', 'iban'],
  })

  if (!read.ok) {
    return read.response
  }

  const input = parseBankSettingsInput(read.body)

  if (!input.ok) {
    return inputErrorResponse(input.code)
  }

  const result = await writeBankSettings(
    env.DB,
    toWriter(admin),
    input.value,
    hasAdminSecondFactor(admin),
  )

  if (result.kind === 'unchanged') {
    return unchangedResponse()
  }

  alertAfterCommit(
    context,
    'bank',
    String(result.revisionId),
    result.savedAt,
    result.effectiveAt,
  )

  return savedRevisionResponse(result)
}

export const handlePutContact: Handler = async (context) => {
  const { request, env, admin } = context
  const refusal = requireSensitiveSettingsAuth(env, admin)

  if (refusal) {
    return refusal
  }

  const read = await readBody(request, {
    maxBytes: BODY_BYTES.contact,
    requiredKeys: ['whatsappNumber'],
  })

  if (!read.ok) {
    return read.response
  }

  const input = parseContactSettingsInput(read.body)

  if (!input.ok) {
    return inputErrorResponse(input.code)
  }

  const result = await writeContactSettings(
    env.DB,
    toWriter(admin),
    input.value,
    hasAdminSecondFactor(admin),
  )

  if (result.kind === 'unchanged') {
    return unchangedResponse()
  }

  alertAfterCommit(
    context,
    'contact',
    String(result.revisionId),
    result.savedAt,
    result.effectiveAt,
  )

  return savedRevisionResponse(result)
}

export const handlePutPickup: Handler = async ({ request, env, admin }) => {
  const refusal = requireRecentSignIn(admin)

  if (refusal) {
    return refusal
  }

  const read = await readBody(request, {
    maxBytes: BODY_BYTES.pickup,
    requiredKeys: ['address', 'instructions'],
  })

  if (!read.ok) {
    return read.response
  }

  const input = parsePickupSettingsInput(read.body, await readStudioDigits(env.DB))

  if (!input.ok) {
    return inputErrorResponse(input.code)
  }

  const result = await writePickupSettings(env.DB, toWriter(admin), input.value)

  return result.kind === 'unchanged'
    ? unchangedResponse()
    : savedRevisionResponse(result)
}

// ---------------------------------------------------------------------------
// PUT identity (AD+R; GAP-03)
// ---------------------------------------------------------------------------

export const handlePutIdentity: Handler = async ({ request, env, admin }) => {
  const refusal = requireRecentSignIn(admin)

  if (refusal) {
    return refusal
  }

  const read = await readBody(request, {
    maxBytes: BODY_BYTES.identity,
    requiredKeys: ['legalName', 'licenceNumber', 'vatStatus'],
  })

  if (!read.ok) {
    return read.response
  }

  const identity = parseBusinessIdentityInput(read.body)

  if (!identity.ok) {
    return inputErrorResponse(identity.code)
  }

  const result = await writeBusinessIdentity(env.DB, toWriter(admin), identity.value)

  return result.kind === 'unchanged'
    ? unchangedResponse()
    : jsonResponse({
        ok: true,
        identity: { revisionId: result.revisionId, updatedAt: result.savedAt },
      })
}

// ---------------------------------------------------------------------------
// #32 GET / POST terms
// ---------------------------------------------------------------------------

export const handleGetTerms: Handler = async ({ env, url, admin }) => {
  const limited = await limitAdminRead(env, admin)

  if (limited) {
    return limited
  }

  const query = readQuery(url, ['version'])

  if (query === null) {
    return invalidQueryResponse()
  }

  const version = query.get('version')

  if (version === undefined) {
    return jsonResponse({ ok: true, versions: await listTermsVersions(env.DB) })
  }

  if (!isTermsVersion(version)) {
    return invalidQueryResponse()
  }

  const terms = await readTermsVersion(env.DB, version)

  return terms === null
    ? termsNotFoundResponse()
    : jsonResponse({ ok: true, terms })
}

/** "v3" as 3; null (no version yet) as 0; anything else as null. */
function readExpectedSeq(value: unknown): number | null {
  if (value === null) {
    return 0
  }

  if (!isTermsVersion(value)) {
    return null
  }

  const seq = Number(value.slice(1))

  return seq < MAXIMUM_TERMS_SEQ ? seq : null
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export const handlePostTerms: Handler = async (context) => {
  const { request, env, admin } = context
  const refusal = requireSensitiveSettingsAuth(env, admin)

  if (refusal) {
    return refusal
  }

  const read = await readBody(request, {
    maxBytes: BODY_BYTES.terms,
    requiredKeys: ['body', 'changeSummary', 'expectedCurrentVersion'],
  })

  if (!read.ok) {
    return read.response
  }

  const expectedSeq = readExpectedSeq(read.body.expectedCurrentVersion)

  if (expectedSeq === null) {
    return inputErrorResponse('INVALID_REQUEST_BODY')
  }

  const studioDigits = await readStudioDigits(env.DB)
  const body = toCheckedText(
    normalizeFreeText(read.body.body, TERMS_BODY_RULE),
    true,
    studioDigits,
  )

  if (!body.ok) {
    return inputErrorResponse(body.code)
  }

  if (MARKUP_TAG.test(body.value)) {
    return inputErrorResponse('INVALID_TEXT')
  }

  const changeSummary = readOptionalText(
    read.body.changeSummary,
    TERMS_SUMMARY_RULE,
    true,
    studioDigits,
  )

  if (!changeSummary.ok) {
    return inputErrorResponse(changeSummary.code)
  }

  const bodySha256 = await sha256Hex(body.value)
  const result = await publishTermsVersion(env.DB, toWriter(admin), {
    body: body.value,
    bodySha256,
    changeSummary: changeSummary.value,
    expectedSeq,
  })

  switch (result.kind) {
    case 'unchanged':
      return unchangedResponse()
    case 'conflict':
      return termsConflictResponse()
    case 'published':
      alertAfterCommit(context, 'terms', result.version, result.publishedAt, null)

      return jsonResponse(
        {
          ok: true,
          terms: {
            version: result.version,
            seq: result.seq,
            publishedAt: result.publishedAt,
            bodySha256,
          },
        },
        201,
      )
  }
}

// ---------------------------------------------------------------------------
// #33 GET history
// ---------------------------------------------------------------------------

export const handleGetHistory: Handler = async ({ env, url, admin }) => {
  const limited = await limitAdminRead(env, admin)

  if (limited) {
    return limited
  }

  const query = readQuery(url, ['section', 'limit', 'cursor'])
  const section = query?.get('section')
  const limit = query?.get('limit')
  const cursor = query?.get('cursor')

  if (
    query === null ||
    !isHistorySection(section) ||
    (limit !== undefined && !HISTORY_LIMIT.test(limit)) ||
    (cursor !== undefined && !HISTORY_CURSOR.test(cursor))
  ) {
    return invalidQueryResponse()
  }

  const pageSize = limit === undefined ? DEFAULT_HISTORY_PAGE : Number(limit)
  const before = cursor === undefined ? null : Number(cursor)

  if (
    pageSize > MAXIMUM_HISTORY_PAGE ||
    (before !== null && !Number.isSafeInteger(before))
  ) {
    return invalidQueryResponse()
  }

  const page = await readSettingsHistory(env.DB, section, pageSize, before)

  return jsonResponse({ ok: true, section, ...page })
}

// ---------------------------------------------------------------------------
// #34 delivery areas (AD)
// ---------------------------------------------------------------------------

/** The actor of an AD route: no recent-sign-in time is stored. */
function adActor(admin: AuthenticatedAdmin): AdminAuditActor {
  return { uid: admin.uid, reauthAt: null }
}

function readAreaName(value: unknown): SettingsInputResult<string> {
  return toCheckedText(
    normalizeFreeText(value, DELIVERY_AREA_NAME_RULE),
    true,
    null,
  )
}

export const handleGetDeliveryAreas: Handler = async ({ env, url, admin }) => {
  const limited = await limitAdminRead(env, admin)

  if (limited) {
    return limited
  }

  if (readQuery(url, []) === null) {
    return invalidQueryResponse()
  }

  return jsonResponse({
    ok: true,
    deliveryAreas: await listDeliveryAreas(env.DB, isStoredDeliveryAreaName),
  })
}

export const handlePostDeliveryArea: Handler = async ({ request, env, admin }) => {
  const read = await readBody(request, {
    maxBytes: BODY_BYTES.deliveryArea,
    requiredKeys: ['name', 'fee', 'sortOrder'],
  })

  if (!read.ok) {
    return read.response
  }

  const name = readAreaName(read.body.name)
  const { fee, sortOrder } = read.body

  if (!name.ok) {
    return inputErrorResponse(name.code)
  }

  if (
    !isIntegerBetween(fee, 0, MAXIMUM_DELIVERY_FEE) ||
    !isIntegerBetween(sortOrder, 0, MAXIMUM_DELIVERY_SORT_ORDER)
  ) {
    return inputErrorResponse('INVALID_REQUEST_BODY')
  }

  const result = await createDeliveryArea(
    env.DB,
    adActor(admin),
    { name: name.value, fee, sortOrder },
    (areaId) => deliveryAreaCreatedAudit(areaId, { fee, isActive: true, sortOrder }),
  )

  switch (result.kind) {
    case 'created':
      return jsonResponse({ ok: true, area: result.area }, 201)
    case 'name-taken':
      return deliveryAreaNameTakenResponse()
    case 'limit-reached':
      return deliveryAreaLimitResponse()
  }
}

export const handlePatchDeliveryArea: Handler = async ({
  request,
  env,
  admin,
  params,
}) => {
  const areaId = params.areaId

  if (!isDeliveryAreaId(areaId)) {
    return deliveryAreaNotFoundResponse()
  }

  const read = await readBody(request, {
    maxBytes: BODY_BYTES.deliveryArea,
    requiredKeys: [],
    optionalKeys: ['name', 'fee', 'isActive', 'sortOrder'],
  })

  if (!read.ok) {
    return read.response
  }

  const changes = read.body

  if (Object.keys(changes).length === 0) {
    return inputErrorResponse('INVALID_REQUEST_BODY')
  }

  const name =
    changes.name === undefined ? null : readAreaName(changes.name)

  if (name !== null && !name.ok) {
    return inputErrorResponse(name.code)
  }

  const { fee, isActive, sortOrder } = changes

  if (
    (fee !== undefined && !isIntegerBetween(fee, 0, MAXIMUM_DELIVERY_FEE)) ||
    (isActive !== undefined && typeof isActive !== 'boolean') ||
    (sortOrder !== undefined &&
      !isIntegerBetween(sortOrder, 0, MAXIMUM_DELIVERY_SORT_ORDER))
  ) {
    return inputErrorResponse('INVALID_REQUEST_BODY')
  }

  const before = await readDeliveryAreaById(env.DB, areaId, isStoredDeliveryAreaName)

  // A row that fails its guard is not edited through the API (fail closed).
  if (before === 'missing' || before === 'invalid') {
    return deliveryAreaNotFoundResponse()
  }

  const after: DeliveryArea = {
    id: before.id,
    name: name === null ? before.name : name.value,
    fee: fee === undefined ? before.fee : fee,
    isActive: isActive === undefined ? before.isActive : isActive,
    sortOrder: sortOrder === undefined ? before.sortOrder : sortOrder,
  }
  const nameChanged = after.name !== before.name
  const feeChanged = after.fee !== before.fee
  const activeChanged = after.isActive !== before.isActive
  const orderChanged = after.sortOrder !== before.sortOrder

  if (!nameChanged && !feeChanged && !activeChanged && !orderChanged) {
    return unchangedResponse()
  }

  const result = await updateDeliveryArea(
    env.DB,
    adActor(admin),
    before,
    after,
    deliveryAreaUpdatedAudit(before.id, {
      nameChanged,
      fee: feeChanged ? after.fee : undefined,
      isActive: activeChanged ? after.isActive : undefined,
      sortOrder: orderChanged ? after.sortOrder : undefined,
    }),
  )

  switch (result.kind) {
    case 'updated':
      return jsonResponse({ ok: true, area: result.area })
    case 'missing':
      return deliveryAreaNotFoundResponse()
    case 'name-taken':
      return deliveryAreaNameTakenResponse()
    case 'changed':
      return deliveryAreaChangedResponse()
  }
}

// ---------------------------------------------------------------------------
// #43 PUT switch (off: AD; on: AD+R; H3)
// ---------------------------------------------------------------------------

export const handlePutSwitch: Handler = async (context) => {
  const { request, env, admin } = context
  const read = await readBody(request, {
    maxBytes: BODY_BYTES.switch,
    requiredKeys: ['onlineConfirmation', 'note'],
  })

  if (!read.ok) {
    return read.response
  }

  const state = read.body.onlineConfirmation

  if (state !== 'on' && state !== 'off') {
    return inputErrorResponse('INVALID_REQUEST_BODY')
  }

  // Turning online confirmation back on needs a recent sign-in; turning it
  // off, the safety action, never does. The body is read first only because
  // the requirement depends on it; nothing is written before this check.
  const signInRefusal = requireRecentSignIn(admin)

  if (state === 'on' && signInRefusal) {
    return signInRefusal
  }

  const note = readOptionalText(read.body.note, SWITCH_NOTE_RULE, false, null)

  if (!note.ok) {
    return inputErrorResponse(note.code)
  }

  const actor: AdminAuditActor = {
    uid: admin.uid,
    reauthAt: signInRefusal === null ? reauthAtFromToken(admin) : null,
  }
  const result = await writeKillSwitch(
    env.DB,
    actor,
    state,
    note.value,
    onlineConfirmationSwitchedAudit(state),
  )

  if (result.kind === 'unchanged') {
    return unchangedResponse()
  }

  alertAfterCommit(context, 'switch', String(result.revisionId), result.changedAt, null)

  return jsonResponse({
    ok: true,
    killSwitch: {
      state,
      revisionId: result.revisionId,
      changedAt: result.changedAt,
    },
  })
}
