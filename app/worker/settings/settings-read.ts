import { isDepositRule, isDepositRoundTo, type DepositRule } from '../../shared/deposit.js'
import {
  isSettingsSection,
  SETTINGS_TEXT_RULES,
  isValidSaudiIban,
  isWhatsappDigits,
  SENSITIVE_CHANGE_NOTICE_HOURS,
  type BankSettings,
  type ContactSettings,
  type CurrentTermsVersion,
  type DepositSettings,
  type EffectiveSettings,
  type KillSwitchReading,
  type PendingSettings,
  type PickupSettings,
  type RecentSensitiveChange,
  type SettingsBySection,
  type SettingsRevisionMeta,
  type SettingsSection,
  type StudioContact,
} from '../../shared/settings.js'
import { normalizeFreeText, type FreeTextRule } from '../../shared/text.js'

/**
 * The read side of the admin settings (plan 11 §2.1, §2.5, §3.3 #29, TM-03,
 * H3). Read-only: this module prepares SELECTs and nothing else, and logs
 * nothing (an IBAN, a phone number or an address never reaches a log line).
 *
 * Settings are immutable revisions (0008 settings_revisions, append-only).
 * A revision is in force from its `activeFrom` = COALESCE(effective_at,
 * created_at): effective_at is set only on a bank or contact change that
 * waits 24 h (TM-03, 0009). For each section, at the instant `now` (the
 * Worker clock, bound as a parameter), exactly as plan 11 §2.1 defines them:
 * - the EFFECTIVE revision is the one with the highest id whose activeFrom
 *   is not in the future;
 * - the PENDING revision is the newest one while it is not in force yet
 *   (any row newer than the effective one is, by that definition, not in
 *   force).
 * Re-saving the effective values is immediate, so its row takes over at
 * once and the pending change never takes effect (verified §2.5). The
 * approve, accept-terms and bank-mismatch statements may embed
 * effectiveRevisionIdSql() or write the same "MAX(id) … WHERE
 * COALESCE(effective_at, created_at) <= now": both give this module's
 * answer, so the Worker has one definition. A later save never changes the
 * revision in force at a past instant (its activeFrom is later), so GAP-05
 * can read the number in force at approval.
 *
 * Under this rule a second delayed change saved while a first is pending
 * does not cancel the first: the first takes effect at its own effective_at
 * and stays in force until the second's. Closing that belongs to the write
 * side (plan 11 §3.3 #30–#34), which can write the cancel (the effective
 * values, immediate) before the new delayed row in the same batch.
 *
 * D1 rows are a trust boundary: each column passes a runtime guard, and a
 * row that fails reads as "no revision" (fail closed: flow 2 is not offered
 * and customers are not shown the details), never as an older revision.
 * A stored IBAN is re-checked with its checksum, a stored number with the
 * E.164 rule and a stored name or pickup text with its free-text rule,
 * since a row written around the API (wrangler d1 execute) passes the
 * CHECKs without them. (The pickup content rules are not re-run: they
 * depend on the studio number at the time of saving.)
 */

type Row = Record<string, unknown>

const SENSITIVE_CHANGE_NOTICE_MS = SENSITIVE_CHANGE_NOTICE_HOURS * 60 * 60 * 1000

/**
 * `shown` was in force at some instant: no later revision of its section
 * took effect at or before the time `shown` did. (Under the §2.1 rule, once
 * a later revision is in force the earlier one never is again, so a pending
 * change cancelled by a re-save never reached customers.) Used with the
 * alias `shown` only.
 */
const WAS_IN_FORCE_CONDITION = `
  NOT EXISTS (
    SELECT 1 FROM settings_revisions AS later
    WHERE later.section = shown.section
      AND later.id > shown.id
      AND COALESCE(later.effective_at, later.created_at)
        <= COALESCE(shown.effective_at, shown.created_at)
  )`

const REVISION_COLUMNS = `
  r.id AS id,
  r.section AS section,
  r.deposit_kind AS depositKind,
  r.deposit_fixed_amount AS depositFixedAmount,
  r.deposit_percent AS depositPercent,
  r.deposit_round_to AS depositRoundTo,
  r.bank_name AS bankName,
  r.bank_account_holder AS accountHolder,
  r.bank_iban AS iban,
  r.whatsapp_number AS whatsappNumber,
  r.pickup_address AS pickupAddress,
  r.pickup_instructions AS pickupInstructions,
  r.created_at AS savedAt,
  COALESCE(r.effective_at, r.created_at) AS activeFrom`

// ?1 now: the effective revision of every section (at most one row each).
const EFFECTIVE_REVISIONS_SQL = `
  SELECT ${REVISION_COLUMNS}
  FROM settings_revisions AS r
  WHERE r.id IN (
    SELECT MAX(candidate.id)
    FROM settings_revisions AS candidate
    WHERE COALESCE(candidate.effective_at, candidate.created_at) <= ?1
    GROUP BY candidate.section
  )`

// ?1 now: the pending bank and contact change (at most one row each): the
// newest revision of the section while it is not in force yet. Only the
// delayed sections can carry effective_at (0009 CHECK), so only they can be
// pending.
const PENDING_REVISIONS_SQL = `
  SELECT ${REVISION_COLUMNS}
  FROM settings_revisions AS r
  WHERE r.id IN (
    SELECT MAX(newest.id)
    FROM settings_revisions AS newest
    WHERE newest.section IN ('bank', 'contact')
    GROUP BY newest.section
  )
    AND COALESCE(r.effective_at, r.created_at) > ?1`

const CURRENT_TERMS_VERSION_SQL = `
  SELECT
    version,
    seq,
    created_at AS publishedAt,
    body_sha256 AS bodySha256
  FROM terms_versions
  ORDER BY seq DESC
  LIMIT 1`

const KILL_SWITCH_SQL = `
  SELECT id, state, created_at AS changedAt
  FROM ops_switch_revisions
  WHERE switch_name = 'online_confirmation'
  ORDER BY id DESC
  LIMIT 1`

/**
 * Rows of the fraud-visibility banner per section. The cap is per section
 * so that saves in one section never push another section's change out:
 * a burst of deposit or switch saves made with a stolen password cannot
 * hide the IBAN or number it just swapped (TM-03). A section with more
 * changes in 72 h than this still shows its newest ones.
 */
const MAXIMUM_RECENT_CHANGES_PER_SECTION = 20

// ?1 cutoff (now − 72 h): bank, contact, deposit, terms and switch changes
// saved since, the newest MAXIMUM_RECENT_CHANGES_PER_SECTION of each
// section, newest first (§3.3 #29 recentSensitiveChanges). Pickup is not a
// sensitive section.
const RECENT_SENSITIVE_CHANGES_SQL = `
  SELECT section, revisionId, at
  FROM (
    SELECT
      section,
      revisionId,
      at,
      ROW_NUMBER() OVER (
        PARTITION BY section
        ORDER BY at DESC, revisionId DESC
      ) AS sectionPosition
    FROM (
      SELECT section, id AS revisionId, created_at AS at
      FROM settings_revisions
      WHERE section IN ('deposit', 'bank', 'contact') AND created_at >= ?1
      UNION ALL
      SELECT 'terms', seq, created_at
      FROM terms_versions
      WHERE created_at >= ?1
      UNION ALL
      SELECT 'switch', id, created_at
      FROM ops_switch_revisions
      WHERE switch_name = 'online_confirmation' AND created_at >= ?1
    )
  )
  WHERE sectionPosition <= ${MAXIMUM_RECENT_CHANGES_PER_SECTION}
  ORDER BY at DESC, revisionId DESC`

/**
 * Contact revisions compared to find when the number last changed. Each
 * one is a re-authenticated, audited save, so 50 reach far past 72 h. One
 * more row is read only to tell a complete history from a longer one.
 */
const MAXIMUM_CONTACT_HISTORY = 50

// ?1 now: the contact revisions customers were sent to, newest first: each
// took effect by now and was in force at some instant (the first row is the
// effective one). In id order their times in force follow one another.
// A row past MAXIMUM_CONTACT_HISTORY means the history goes further back.
const CONTACT_HISTORY_SQL = `
  SELECT
    shown.id AS id,
    shown.whatsapp_number AS whatsappNumber,
    shown.created_at AS savedAt,
    COALESCE(shown.effective_at, shown.created_at) AS activeFrom
  FROM settings_revisions AS shown
  WHERE shown.section = 'contact'
    AND COALESCE(shown.effective_at, shown.created_at) <= ?1
    AND ${WAS_IN_FORCE_CONDITION}
  ORDER BY shown.id DESC
  LIMIT ${MAXIMUM_CONTACT_HISTORY + 1}`

/** Every statement this module prepares (tests prepare each one). */
export const SETTINGS_READ_SQL = {
  effectiveRevisions: EFFECTIVE_REVISIONS_SQL,
  pendingRevisions: PENDING_REVISIONS_SQL,
  currentTermsVersion: CURRENT_TERMS_VERSION_SQL,
  killSwitch: KILL_SWITCH_SQL,
  recentSensitiveChanges: RECENT_SENSITIVE_CHANGES_SQL,
  contactHistory: CONTACT_HISTORY_SQL,
} as const

/**
 * H3 / E7, for a writing statement's WHERE clause (approve, the hold
 * sweeps): true while the online-confirmation kill switch is on. No row
 * means it was never pulled; any state other than 'on' reads as off.
 */
export const ONLINE_CONFIRMATION_SWITCH_ON_SQL = `
  COALESCE((
    SELECT osr.state FROM ops_switch_revisions AS osr
    WHERE osr.switch_name = 'online_confirmation'
    ORDER BY osr.id DESC
    LIMIT 1
  ), 'on') = 'on'`

/** A bound positional parameter such as `?1`. */
const SQL_PARAMETER = /^\?[1-9][0-9]?$/

/**
 * A scalar SQL expression: the id of `section`'s effective revision at the
 * instant bound as `nowParameter` (e.g. '?4'), or NULL when there is none:
 * the §2.1 rule, the same answer as readEffectiveSettings. Built only from
 * constant fragments (SB-4): the section must be one of the four lower-case
 * names and the parameter a positional placeholder, so no value ever
 * reaches the SQL text. Throws a RangeError otherwise.
 */
export function effectiveRevisionIdSql(
  section: SettingsSection,
  nowParameter: string,
): string {
  if (!isSettingsSection(section) || !SQL_PARAMETER.test(nowParameter)) {
    throw new RangeError('Invalid effective revision fragment')
  }

  return `(
    SELECT MAX(candidate.id)
    FROM settings_revisions AS candidate
    WHERE candidate.section = '${section}'
      AND COALESCE(candidate.effective_at, candidate.created_at) <= ${nowParameter}
  )`
}

// ---------------------------------------------------------------------------
// Row guards
// ---------------------------------------------------------------------------

/** The toISOString() form every instant column holds. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SHA256_HEX = /^[0-9a-f]{64}$/

function isInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_INSTANT.test(value) &&
    !Number.isNaN(Date.parse(value))
  )
}

function isRowId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * A stored text exactly as the write guard leaves it: the free-text rule
 * of its field accepts it and changes nothing. The CHECKs refuse control
 * characters only, so this is what keeps a bidi override or a zero-width
 * character written around the API out of the bank names customers copy
 * from (TM-12).
 */
function isStoredText(value: unknown, rule: FreeTextRule): value is string {
  const text = normalizeFreeText(value, rule)

  return text.ok && text.value === value
}

function readMeta(row: Row): SettingsRevisionMeta | null {
  const { id, savedAt, activeFrom } = row

  if (!isRowId(id) || !isInstant(savedAt) || !isInstant(activeFrom)) {
    return null
  }

  return { revisionId: id, savedAt, activeFrom }
}

function readDepositRule(row: Row): DepositRule | null {
  const { depositKind, depositFixedAmount, depositPercent, depositRoundTo } =
    row

  if (!isDepositRoundTo(depositRoundTo)) {
    return null
  }

  let rule: DepositRule

  if (
    depositKind === 'fixed' &&
    typeof depositFixedAmount === 'number' &&
    depositPercent === null
  ) {
    rule = { kind: 'fixed', fixedAmount: depositFixedAmount, roundTo: depositRoundTo }
  } else if (
    depositKind === 'percent' &&
    typeof depositPercent === 'number' &&
    depositFixedAmount === null
  ) {
    rule = { kind: 'percent', percent: depositPercent, roundTo: depositRoundTo }
  } else {
    return null
  }

  return isDepositRule(rule) ? rule : null
}

function readDeposit(row: Row): DepositSettings | null {
  const meta = readMeta(row)
  const rule = readDepositRule(row)

  return meta === null || rule === null ? null : { ...meta, rule }
}

function readBank(row: Row): BankSettings | null {
  const meta = readMeta(row)
  const { bankName, accountHolder, iban } = row

  if (
    meta === null ||
    !isStoredText(bankName, SETTINGS_TEXT_RULES.bankName) ||
    !isStoredText(accountHolder, SETTINGS_TEXT_RULES.accountHolder) ||
    typeof iban !== 'string' ||
    !isValidSaudiIban(iban)
  ) {
    return null
  }

  return { ...meta, bankName, accountHolder, iban }
}

function readContact(row: Row): ContactSettings | null {
  const meta = readMeta(row)
  const { whatsappNumber } = row

  if (
    meta === null ||
    typeof whatsappNumber !== 'string' ||
    !isWhatsappDigits(whatsappNumber)
  ) {
    return null
  }

  return { ...meta, whatsappNumber }
}

function readPickup(row: Row): PickupSettings | null {
  const meta = readMeta(row)
  const { pickupAddress, pickupInstructions } = row

  if (
    meta === null ||
    !isStoredText(pickupAddress, SETTINGS_TEXT_RULES.pickupAddress) ||
    !(
      pickupInstructions === null ||
      isStoredText(pickupInstructions, SETTINGS_TEXT_RULES.pickupInstructions)
    )
  ) {
    return null
  }

  return { ...meta, address: pickupAddress, instructions: pickupInstructions }
}

type MutableSettings = {
  -readonly [Section in SettingsSection]: SettingsBySection[Section] | null
}

/** One revision per section; a section with no row, or a bad one, is null. */
function collectRevisions(rows: readonly Row[]): MutableSettings {
  const settings: MutableSettings = {
    deposit: null,
    bank: null,
    contact: null,
    pickup: null,
  }

  for (const row of rows) {
    switch (row.section) {
      case 'deposit':
        settings.deposit = readDeposit(row)
        break
      case 'bank':
        settings.bank = readBank(row)
        break
      case 'contact':
        settings.contact = readContact(row)
        break
      case 'pickup':
        settings.pickup = readPickup(row)
        break
    }
  }

  return settings
}

function toPending(rows: readonly Row[]): PendingSettings {
  const { bank, contact } = collectRevisions(rows)

  return { bank, contact }
}

function readCurrentTerms(row: Row | null): CurrentTermsVersion | null {
  if (row === null) {
    return null
  }

  const { version, seq, publishedAt, bodySha256 } = row

  if (
    !isRowId(seq) ||
    typeof version !== 'string' ||
    version !== `v${seq}` ||
    !isInstant(publishedAt) ||
    typeof bodySha256 !== 'string' ||
    !SHA256_HEX.test(bodySha256)
  ) {
    return null
  }

  return { version, seq, publishedAt, bodySha256 }
}

/** No row: never pulled (on). A row that fails its guard: off (fail closed). */
function readKillSwitchRow(row: Row | null): KillSwitchReading {
  if (row === null) {
    return { state: 'on', revisionId: null, changedAt: null }
  }

  const { id, state, changedAt } = row

  if (!isRowId(id) || !isInstant(changedAt)) {
    return { state: 'off', revisionId: null, changedAt: null }
  }

  return { state: state === 'on' ? 'on' : 'off', revisionId: id, changedAt }
}

function isRecentSensitiveSection(
  value: unknown,
): value is RecentSensitiveChange['section'] {
  return (
    value === 'deposit' ||
    value === 'bank' ||
    value === 'contact' ||
    value === 'terms' ||
    value === 'switch'
  )
}

function readRecentChanges(rows: readonly Row[]): RecentSensitiveChange[] {
  const changes: RecentSensitiveChange[] = []

  for (const { section, revisionId, at } of rows) {
    if (isRecentSensitiveSection(section) && isRowId(revisionId) && isInstant(at)) {
      changes.push({ section, revisionId, at })
    }
  }

  return changes
}

/**
 * The effective contact number and, when it replaced the different number
 * of an earlier contact revision at most SENSITIVE_CHANGE_NOTICE_HOURS
 * before `now`, the time it did (§3.3 #1, TM-03, TM-19). The first contact
 * revision is not a change (no earlier revision: null, as the contract
 * says; the runbook has the owner save her number at go-live, §7.7 step 4),
 * nor is re-saving the same number or a change cancelled before it took
 * effect (it was never in force). Where the rows cannot tell, the notice,
 * which quotes the compiled number as the check, is the safe side to err
 * on: an earlier row that fails its guard counts as a different number,
 * and when the history goes further back than the MAXIMUM_CONTACT_HISTORY
 * rows compared and all of them carry the same number, the change is taken
 * to be the oldest of them, so a burst of re-saves cannot push a change out
 * of sight. A complete history of one number is never a change. A current
 * row that fails gives no number at all, so the SPA falls back to its
 * compiled one.
 */
function readStudioContactRows(rows: readonly Row[], now: Date): StudioContact {
  const history = rows.slice(0, MAXIMUM_CONTACT_HISTORY)
  const current = history.length > 0 ? readContact(history[0]) : null

  if (current === null) {
    return { whatsappNumber: null, whatsappNumberChangedAt: null }
  }

  let changedAt: string | null = null
  let sameNumberSince = current.activeFrom

  for (const row of history.slice(1)) {
    const earlier = readContact(row)

    if (earlier === null || earlier.whatsappNumber !== current.whatsappNumber) {
      changedAt = sameNumberSince
      break
    }

    sameNumberSince = earlier.activeFrom
  }

  if (changedAt === null && rows.length > MAXIMUM_CONTACT_HISTORY) {
    changedAt = sameNumberSince
  }

  return {
    whatsappNumber: current.whatsappNumber,
    whatsappNumberChangedAt:
      changedAt !== null &&
      Date.parse(changedAt) >= now.getTime() - SENSITIVE_CHANGE_NOTICE_MS
        ? changedAt
        : null,
  }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** The Worker clock as the ISO instant every statement binds. */
function toBoundInstant(now: Date): string {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('Invalid settings read instant')
  }

  return now.toISOString()
}

/** The start of the 72 h fraud-visibility window ending at `now`. */
function noticeCutoff(now: Date): string {
  return toBoundInstant(new Date(now.getTime() - SENSITIVE_CHANGE_NOTICE_MS))
}

async function allRows(statement: D1PreparedStatement): Promise<Row[]> {
  const { results } = await statement.all<Row>()

  return results
}

/**
 * The revision of each section in force at `now`. It never contains a
 * pending change, so a customer-facing handler may use it.
 */
export async function readEffectiveSettings(
  db: D1Database,
  now: Date,
): Promise<EffectiveSettings> {
  return collectRevisions(
    await allRows(db.prepare(EFFECTIVE_REVISIONS_SQL).bind(toBoundInstant(now))),
  )
}

/**
 * The saved bank and contact changes not yet in force at `now` (TM-03).
 * Admin-only: a pending bank or contact revision is never shown to a
 * customer.
 */
export async function readPendingSettings(
  db: D1Database,
  now: Date,
): Promise<PendingSettings> {
  return toPending(
    await allRows(db.prepare(PENDING_REVISIONS_SQL).bind(toBoundInstant(now))),
  )
}

/** The current (highest-seq) terms version, or null when none is published. */
export async function readCurrentTermsVersion(
  db: D1Database,
): Promise<CurrentTermsVersion | null> {
  return readCurrentTerms(await db.prepare(CURRENT_TERMS_VERSION_SQL).first<Row>())
}

/** H3: the online-confirmation kill switch as the D1 switch has it now. */
export async function readKillSwitch(db: D1Database): Promise<KillSwitchReading> {
  return readKillSwitchRow(await db.prepare(KILL_SWITCH_SQL).first<Row>())
}

/**
 * Bank, contact, deposit, terms and switch changes of the last 72 h, at
 * most MAXIMUM_RECENT_CHANGES_PER_SECTION of each section.
 */
export async function readRecentSensitiveChanges(
  db: D1Database,
  now: Date,
): Promise<readonly RecentSensitiveChange[]> {
  return readRecentChanges(
    await allRows(db.prepare(RECENT_SENSITIVE_CHANGES_SQL).bind(noticeCutoff(now))),
  )
}

/** The studio number customers are sent to, and its recent change (§3.3 #1). */
export async function readStudioContact(
  db: D1Database,
  now: Date,
): Promise<StudioContact> {
  return readStudioContactRows(
    await allRows(db.prepare(CONTACT_HISTORY_SQL).bind(toBoundInstant(now))),
    now,
  )
}

export interface SettingsSnapshot {
  readonly effective: EffectiveSettings
  /** Admin-only (TM-03): never return it to a customer. */
  readonly pending: PendingSettings
  readonly terms: CurrentTermsVersion | null
  readonly killSwitch: KillSwitchReading
  readonly recentSensitiveChanges: readonly RecentSensitiveChange[]
}

/**
 * Everything the admin settings view and the feature flags read, as one D1
 * batch: one round trip, and every part from the same database state.
 */
export async function readSettingsSnapshot(
  db: D1Database,
  now: Date,
): Promise<SettingsSnapshot> {
  const instant = toBoundInstant(now)
  const [effective, pending, terms, killSwitch, recent] = await db.batch<Row>([
    db.prepare(EFFECTIVE_REVISIONS_SQL).bind(instant),
    db.prepare(PENDING_REVISIONS_SQL).bind(instant),
    db.prepare(CURRENT_TERMS_VERSION_SQL),
    db.prepare(KILL_SWITCH_SQL),
    db.prepare(RECENT_SENSITIVE_CHANGES_SQL).bind(noticeCutoff(now)),
  ])

  return {
    effective: collectRevisions(effective.results),
    pending: toPending(pending.results),
    terms: readCurrentTerms(terms.results.at(0) ?? null),
    killSwitch: readKillSwitchRow(killSwitch.results.at(0) ?? null),
    recentSensitiveChanges: readRecentChanges(recent.results),
  }
}
