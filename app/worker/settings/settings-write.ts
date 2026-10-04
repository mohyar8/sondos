import {
  settingsUpdatedAudit,
  termsPublishedAudit,
  type AfterWriteAuditEntry,
} from '../../shared/audit.js'
import type { DepositRule } from '../../shared/deposit.js'
import {
  readStoredBusinessIdentity,
  type BankSettingsInput,
  type BusinessIdentity,
  type ContactSettingsInput,
  type PickupSettingsInput,
  type SettingsSection,
} from '../../shared/settings.js'
import {
  auditAfterWrite,
  type AdminAuditActor,
} from '../audit/admin-audit.js'

/**
 * The write side of the admin settings (plan 11 §3.3 #30–#32, #43; TM-03,
 * H3, M1, SB-4, SB-5, SB-10, GAP-03, GAP-05). The HTTP handlers
 * (admin-settings-handlers.ts) authenticate, parse and answer; this module
 * owns every writing statement and runs each save as ONE D1 batch: the
 * revision INSERT and its admin_audit_log row (auditAfterWrite) commit
 * together or not at all. Nothing here logs anything.
 *
 * - Clock (M1): created_at and effective_at are stamped by SQLite
 *   (strftime(…, 'now'), constant within one statement), never bound from
 *   the Worker, so the delay and the reauth_at CHECK run on the database's
 *   clock. Each INSERT decides in its own statement, over rows that exist
 *   when it runs, whether it writes and when its row takes effect, so two
 *   concurrent saves cannot both pass a check made earlier.
 * - Unchanged: a save whose values equal the revision in force, with nothing
 *   pending, inserts no row (and so no audit row); the caller answers
 *   `{ "unchanged": true }`. For bank and contact, saving the values of the
 *   pending change is unchanged too (its effective_at is kept, not
 *   restarted).
 * - Delayed activation (TM-03, §2.1 rule of settings-read.ts): a bank or
 *   contact save that replaces an existing revision takes effect at
 *   effective_at = now + 24 h, or + 72 h when the OTHER of the two sections
 *   changed in the last 30 days (GAP-05: a number swap followed by an IBAN
 *   swap, or the reverse); "changed" is any revision after that section's
 *   first one. Immediate: the first revision of the section, a save whose
 *   token carries the second factor, and re-saving the values in force,
 *   which supersedes the pending change (it never takes effect).
 * - A delayed save while another change is pending first writes a cancel
 *   (the values in force, immediate) in the same batch, so the older
 *   pending change never takes effect either: only the newest save can be
 *   pending (settings-read.ts leaves this to the write side).
 * - SQL is fixed text; the section, its columns and the other section come
 *   from the constant specs below and every value is a bound parameter
 *   (SB-4).
 */

type Row = Record<string, unknown>

/** The database clock as every stamped instant is written. */
const SQL_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

/** TM-03 and GAP-05 delays, as strftime modifiers. */
const STANDARD_DELAY_MODIFIER = `'+24 hours'`
const PAIRED_DELAY_MODIFIER = `'+72 hours'`
/** GAP-05: a change of the other section within this window pairs. */
const PAIRED_CHANGE_WINDOW_MODIFIER = `'-30 days'`

export const STANDARD_DELAY_HOURS = 24
export const PAIRED_DELAY_HOURS = 72

/** The most delivery areas that may exist (checked inside the INSERT). */
export const MAXIMUM_DELIVERY_AREAS = 100

/** Rows of a history page, and of the terms version list. */
export const MAXIMUM_HISTORY_PAGE = 50
export const MAXIMUM_TERMS_LIST = 100

/** Where a history page starts when no cursor is given. */
const FIRST_PAGE_CURSOR = Number.MAX_SAFE_INTEGER

// ---------------------------------------------------------------------------
// Section statements
// ---------------------------------------------------------------------------

/**
 * One section's columns as constant SQL fragments. `values` and `same` use
 * the section's own parameters, which start after the fixed ones of its
 * statement (see each statement).
 */
interface SectionSql {
  readonly section: SettingsSection
  readonly columns: string
  readonly values: string
  /** The columns of `alias`, a settings_revisions row, from the alias. */
  readonly copy: (alias: string) => string
  /** True when row `alias` holds exactly the bound values. */
  readonly same: (alias: string) => string
}

// Immediate sections: ?1 actor, ?2 reauth_at, then the values.
const DEPOSIT_SQL: SectionSql = {
  section: 'deposit',
  columns: 'deposit_kind, deposit_fixed_amount, deposit_percent, deposit_round_to',
  values: '?3, ?4, ?5, ?6',
  copy: (alias) =>
    `${alias}.deposit_kind, ${alias}.deposit_fixed_amount, ${alias}.deposit_percent, ${alias}.deposit_round_to`,
  same: (alias) =>
    `${alias}.deposit_kind = ?3 AND ${alias}.deposit_fixed_amount IS ?4 AND ${alias}.deposit_percent IS ?5 AND ${alias}.deposit_round_to = ?6`,
}

const PICKUP_SQL: SectionSql = {
  section: 'pickup',
  columns: 'pickup_address, pickup_instructions',
  values: '?3, ?4',
  copy: (alias) => `${alias}.pickup_address, ${alias}.pickup_instructions`,
  same: (alias) =>
    `${alias}.pickup_address = ?3 AND ${alias}.pickup_instructions IS ?4`,
}

// Delayed sections: ?1 actor, ?2 reauth_at, ?3 second factor (1 or 0),
// then the values.
const BANK_SQL: SectionSql = {
  section: 'bank',
  columns: 'bank_name, bank_account_holder, bank_iban',
  values: '?4, ?5, ?6',
  copy: (alias) =>
    `${alias}.bank_name, ${alias}.bank_account_holder, ${alias}.bank_iban`,
  same: (alias) =>
    `${alias}.bank_name = ?4 AND ${alias}.bank_account_holder = ?5 AND ${alias}.bank_iban = ?6`,
}

const CONTACT_SQL: SectionSql = {
  section: 'contact',
  columns: 'whatsapp_number',
  values: '?4',
  copy: (alias) => `${alias}.whatsapp_number`,
  same: (alias) => `${alias}.whatsapp_number = ?4`,
}

/**
 * The revision of `section` in force at the database's `now`: the §2.1 rule
 * (settings-read.ts), on the SQL clock. At most one row.
 */
function effectiveRowSql(section: SettingsSection): string {
  return `
    SELECT in_force.*
    FROM settings_revisions AS in_force
    WHERE in_force.id = (
      SELECT MAX(candidate.id)
      FROM settings_revisions AS candidate
      WHERE candidate.section = '${section}'
        AND COALESCE(candidate.effective_at, candidate.created_at) <= ${SQL_NOW}
    )`
}

/** The pending change of `section`: its newest row while not in force. */
function pendingRowSql(section: SettingsSection): string {
  return `
    SELECT newest.*
    FROM settings_revisions AS newest
    WHERE newest.id = (
      SELECT MAX(latest.id) FROM settings_revisions AS latest
      WHERE latest.section = '${section}'
    )
      AND COALESCE(newest.effective_at, newest.created_at) > ${SQL_NOW}`
}

const REVISION_RETURNING = `
  RETURNING
    id,
    created_at AS savedAt,
    COALESCE(effective_at, created_at) AS activeFrom,
    effective_at AS effectiveAt`

/**
 * Deposit and pickup: never delayed (the 0009 CHECK allows effective_at on
 * bank and contact only). Inserts unless the values equal the revision in
 * force.
 */
function immediateInsertSql(spec: SectionSql): string {
  return `
    WITH effective AS (${effectiveRowSql(spec.section)})
    INSERT INTO settings_revisions (
      section, ${spec.columns}, created_by, reauth_at, created_at
    )
    SELECT '${spec.section}', ${spec.values}, ?1, ?2, ${SQL_NOW}
    WHERE NOT EXISTS (SELECT 1 FROM effective AS e WHERE ${spec.same('e')})
    ${REVISION_RETURNING}`
}

/**
 * Bank and contact (TM-03, GAP-05). Skipped when the values equal the
 * pending change, or equal the revision in force with nothing pending.
 * effective_at is NULL (immediate) for a 2F save, the section's first row
 * or the values in force; otherwise now + 72 h when `other` has a revision
 * after its first one saved in the last 30 days, else now + 24 h.
 */
function delayedInsertSql(spec: SectionSql, other: SettingsSection): string {
  return `
    WITH
      effective AS (${effectiveRowSql(spec.section)}),
      pending AS (${pendingRowSql(spec.section)})
    INSERT INTO settings_revisions (
      section, ${spec.columns}, created_by, reauth_at, created_at, effective_at
    )
    SELECT
      '${spec.section}',
      ${spec.values},
      ?1,
      ?2,
      ${SQL_NOW},
      CASE
        WHEN ?3 = 1
          OR NOT EXISTS (
            SELECT 1 FROM settings_revisions AS existing
            WHERE existing.section = '${spec.section}'
          )
          OR EXISTS (SELECT 1 FROM effective AS e WHERE ${spec.same('e')})
        THEN NULL
        WHEN EXISTS (
          SELECT 1 FROM settings_revisions AS other_change
          WHERE other_change.section = '${other}'
            AND other_change.created_at
              >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${PAIRED_CHANGE_WINDOW_MODIFIER})
            AND other_change.id > (
              SELECT MIN(other_first.id) FROM settings_revisions AS other_first
              WHERE other_first.section = '${other}'
            )
        )
        THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${PAIRED_DELAY_MODIFIER})
        ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ${STANDARD_DELAY_MODIFIER})
      END
    WHERE NOT EXISTS (SELECT 1 FROM pending AS p WHERE ${spec.same('p')})
      AND NOT (
        EXISTS (SELECT 1 FROM effective AS e WHERE ${spec.same('e')})
        AND NOT EXISTS (SELECT 1 FROM pending)
      )
    ${REVISION_RETURNING}`
}

/**
 * The cancel written before a delayed save while another change is
 * pending: a copy of the revision in force, immediate, so the pending row
 * is superseded before the new one is added. Only when the new save will
 * be delayed (no second factor, values neither in force nor pending). The
 * same parameters as delayedInsertSql.
 */
function cancelPendingSql(spec: SectionSql): string {
  return `
    WITH
      effective AS (${effectiveRowSql(spec.section)}),
      pending AS (${pendingRowSql(spec.section)})
    INSERT INTO settings_revisions (
      section, ${spec.columns}, created_by, reauth_at, created_at
    )
    SELECT '${spec.section}', ${spec.copy('e')}, ?1, ?2, ${SQL_NOW}
    FROM effective AS e
    WHERE ?3 = 0
      AND EXISTS (SELECT 1 FROM pending)
      AND NOT EXISTS (SELECT 1 FROM pending AS p WHERE ${spec.same('p')})
      AND NOT (${spec.same('e')})`
}

/** Every statement this module prepares (tests prepare each one). */
export const SETTINGS_WRITE_SQL = {
  depositInsert: immediateInsertSql(DEPOSIT_SQL),
  pickupInsert: immediateInsertSql(PICKUP_SQL),
  bankInsert: delayedInsertSql(BANK_SQL, 'contact'),
  bankCancelPending: cancelPendingSql(BANK_SQL),
  contactInsert: delayedInsertSql(CONTACT_SQL, 'bank'),
  contactCancelPending: cancelPendingSql(CONTACT_SQL),
} as const

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A revision that was written. */
export interface SavedRevision {
  readonly kind: 'saved'
  readonly revisionId: number
  readonly savedAt: string
  /** When it reaches customers: effectiveAt, or savedAt when immediate. */
  readonly activeFrom: string
  /** Set only for a delayed bank or contact change. */
  readonly effectiveAt: string | null
  /** A pending change was cancelled in the same batch (bank, contact). */
  readonly cancelledPending: boolean
}

export type RevisionWriteResult = SavedRevision | { readonly kind: 'unchanged' }

/** The toISOString() form every instant column holds. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const TERMS_VERSION = /^v[1-9][0-9]{0,3}$/
const AREA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A write whose RETURNING row does not have its shape: a bug, never data. */
function unexpectedRow(): never {
  throw new Error('SETTINGS_WRITE_ROW_INVALID')
}

function readSavedRevision(
  rows: readonly Row[],
  cancelledPending: boolean,
): RevisionWriteResult {
  const row = rows.at(0)

  if (row === undefined) {
    return { kind: 'unchanged' }
  }

  const { id, savedAt, activeFrom, effectiveAt } = row

  if (
    !isRowId(id) ||
    !isInstant(savedAt) ||
    !isInstant(activeFrom) ||
    !(effectiveAt === null || isInstant(effectiveAt))
  ) {
    return unexpectedRow()
  }

  return {
    kind: 'saved',
    revisionId: id,
    savedAt,
    activeFrom,
    effectiveAt,
    cancelledPending,
  }
}

/** True when a batch result inserted exactly one row. */
function insertedOne(result: D1Result<Row> | undefined): boolean {
  return result !== undefined && result.meta.changes === 1
}

// ---------------------------------------------------------------------------
// Settings sections
// ---------------------------------------------------------------------------

/** The saving admin; reauthAt from reauthAtFromToken (required: AD+R, AD+S). */
export interface SettingsWriter extends AdminAuditActor {
  readonly reauthAt: string
}

async function writeImmediate(
  db: D1Database,
  writer: SettingsWriter,
  spec: SectionSql,
  sql: string,
  values: readonly (string | number | null)[],
): Promise<RevisionWriteResult> {
  const insert = db.prepare(sql).bind(writer.uid, writer.reauthAt, ...values)
  const [written] = await db.batch<Row>([
    ...auditAfterWrite(db, insert, writer, settingsUpdatedAudit(spec.section)),
  ])

  return readSavedRevision(written?.results ?? [], false)
}

async function writeDelayed(
  db: D1Database,
  writer: SettingsWriter,
  spec: SectionSql,
  insertSql: string,
  cancelSql: string,
  values: readonly (string | number | null)[],
  secondFactor: boolean,
): Promise<RevisionWriteResult> {
  const parameters = [
    writer.uid,
    writer.reauthAt,
    secondFactor ? 1 : 0,
    ...values,
  ]
  const cancel = db.prepare(cancelSql).bind(...parameters)
  const insert = db.prepare(insertSql).bind(...parameters)
  const [cancelled, , written] = await db.batch<Row>([
    ...auditAfterWrite(db, cancel, writer, settingsUpdatedAudit(spec.section)),
    ...auditAfterWrite(db, insert, writer, settingsUpdatedAudit(spec.section)),
  ])

  return readSavedRevision(written?.results ?? [], insertedOne(cancelled))
}

/** PUT deposit (#30): immediate; unchanged when equal to the rule in force. */
export function writeDepositSettings(
  db: D1Database,
  writer: SettingsWriter,
  rule: DepositRule,
): Promise<RevisionWriteResult> {
  return writeImmediate(db, writer, DEPOSIT_SQL, SETTINGS_WRITE_SQL.depositInsert, [
    rule.kind,
    rule.kind === 'fixed' ? rule.fixedAmount : null,
    rule.kind === 'percent' ? rule.percent : null,
    rule.roundTo,
  ])
}

/** PUT pickup (#31): immediate; unchanged when equal to the revision in force. */
export function writePickupSettings(
  db: D1Database,
  writer: SettingsWriter,
  input: PickupSettingsInput,
): Promise<RevisionWriteResult> {
  return writeImmediate(db, writer, PICKUP_SQL, SETTINGS_WRITE_SQL.pickupInsert, [
    input.address,
    input.instructions,
  ])
}

/**
 * PUT bank (#30): delayed unless first, 2F-backed or the values in force
 * (TM-03, GAP-05). `secondFactor` is hasAdminSecondFactor of the token.
 */
export function writeBankSettings(
  db: D1Database,
  writer: SettingsWriter,
  input: BankSettingsInput,
  secondFactor: boolean,
): Promise<RevisionWriteResult> {
  return writeDelayed(
    db,
    writer,
    BANK_SQL,
    SETTINGS_WRITE_SQL.bankInsert,
    SETTINGS_WRITE_SQL.bankCancelPending,
    [input.bankName, input.accountHolder, input.iban],
    secondFactor,
  )
}

/** PUT contact (#30): the same rule as the bank section. */
export function writeContactSettings(
  db: D1Database,
  writer: SettingsWriter,
  input: ContactSettingsInput,
  secondFactor: boolean,
): Promise<RevisionWriteResult> {
  return writeDelayed(
    db,
    writer,
    CONTACT_SQL,
    SETTINGS_WRITE_SQL.contactInsert,
    SETTINGS_WRITE_SQL.contactCancelPending,
    [input.whatsappNumber],
    secondFactor,
  )
}

// ---------------------------------------------------------------------------
// History (#33)
// ---------------------------------------------------------------------------

export const HISTORY_SECTIONS = [
  'deposit',
  'bank',
  'contact',
  'pickup',
  'identity',
] as const

export type HistorySection = (typeof HISTORY_SECTIONS)[number]

export function isHistorySection(value: unknown): value is HistorySection {
  return HISTORY_SECTIONS.some((section) => section === value)
}

// ?1 section, ?2 cursor (ids below it), ?3 rows to read.
const SETTINGS_HISTORY_SQL = `
  SELECT
    id,
    deposit_kind AS depositKind,
    deposit_fixed_amount AS depositFixedAmount,
    deposit_percent AS depositPercent,
    deposit_round_to AS depositRoundTo,
    bank_name AS bankName,
    bank_account_holder AS accountHolder,
    bank_iban AS iban,
    whatsapp_number AS whatsappNumber,
    pickup_address AS pickupAddress,
    pickup_instructions AS pickupInstructions,
    created_at AS createdAt,
    effective_at AS effectiveAt,
    reauth_at AS reauthAt
  FROM settings_revisions
  WHERE section = ?1 AND id < ?2
  ORDER BY id DESC
  LIMIT ?3`

// ?1 cursor, ?2 rows to read.
const IDENTITY_HISTORY_SQL = `
  SELECT
    id,
    legal_name AS legalName,
    licence_number AS licenceNumber,
    vat_status AS vatStatus,
    created_at AS createdAt,
    reauth_at AS reauthAt
  FROM business_identity_revisions
  WHERE id < ?1
  ORDER BY id DESC
  LIMIT ?2`

/** Every revision field of a history row; the ones of other sections are omitted. */
export interface HistoryEntry {
  readonly revisionId: number
  readonly createdAt: string | null
  readonly effectiveAt: string | null
  readonly reauthAt: string | null
  readonly values: Readonly<Record<string, string | number | null>>
}

export interface HistoryPage {
  readonly revisions: readonly HistoryEntry[]
  /** The cursor of the next (older) page, or null at the end. */
  readonly nextCursor: string | null
}

function historyValues(
  section: HistorySection,
  row: Row,
): Record<string, string | number | null> {
  switch (section) {
    case 'deposit':
      return {
        kind: textOrNull(row.depositKind),
        fixedAmount: numberOrNull(row.depositFixedAmount),
        percent: numberOrNull(row.depositPercent),
        roundTo: numberOrNull(row.depositRoundTo),
      }
    case 'bank':
      return {
        bankName: textOrNull(row.bankName),
        accountHolder: textOrNull(row.accountHolder),
        iban: textOrNull(row.iban),
      }
    case 'contact':
      return { whatsappNumber: textOrNull(row.whatsappNumber) }
    case 'pickup':
      return {
        address: textOrNull(row.pickupAddress),
        instructions: textOrNull(row.pickupInstructions),
      }
    case 'identity':
      return {
        legalName: textOrNull(row.legalName),
        licenceNumber: textOrNull(row.licenceNumber),
        vatStatus: textOrNull(row.vatStatus),
      }
  }
}

/**
 * GET history (#33): revisions of one section newest first, full values
 * (admin-only). Each value is passed on only with its column's type; a row
 * without a valid id ends the page (the cursor could not go past it).
 */
export async function readSettingsHistory(
  db: D1Database,
  section: HistorySection,
  limit: number,
  cursor: number | null,
): Promise<HistoryPage> {
  if (!isIntegerBetween(limit, 1, MAXIMUM_HISTORY_PAGE)) {
    throw new RangeError('History limit out of range')
  }

  const before = cursor ?? FIRST_PAGE_CURSOR
  const statement =
    section === 'identity'
      ? db.prepare(IDENTITY_HISTORY_SQL).bind(before, limit + 1)
      : db.prepare(SETTINGS_HISTORY_SQL).bind(section, before, limit + 1)
  const { results } = await statement.all<Row>()
  const revisions: HistoryEntry[] = []

  for (const row of results.slice(0, limit)) {
    if (!isRowId(row.id)) {
      break
    }

    revisions.push({
      revisionId: row.id,
      createdAt: isInstant(row.createdAt) ? row.createdAt : null,
      effectiveAt: isInstant(row.effectiveAt) ? row.effectiveAt : null,
      reauthAt: isInstant(row.reauthAt) ? row.reauthAt : null,
      values: historyValues(section, row),
    })
  }

  const last = revisions.at(-1)

  return {
    revisions,
    nextCursor:
      results.length > limit && revisions.length === limit && last !== undefined
        ? String(last.revisionId)
        : null,
  }
}

// ---------------------------------------------------------------------------
// Terms (#32; TM-04, TM-18)
// ---------------------------------------------------------------------------

/**
 * ?1 body, ?2 body_sha256, ?3 change_summary, ?4 actor, ?5 reauth_at, ?6 the
 * seq the admin saw as current (0 for none). Optimistic: inserts the next
 * version only while the current one is still ?6, and not when its body
 * has the same hash (unchanged).
 */
const TERMS_INSERT_SQL = `
  INSERT INTO terms_versions (
    version, seq, body, body_sha256, change_summary, created_by, reauth_at, created_at
  )
  SELECT
    'v' || next_version.seq,
    next_version.seq,
    ?1,
    ?2,
    ?3,
    ?4,
    ?5,
    ${SQL_NOW}
  FROM (
    SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM terms_versions
  ) AS next_version
  WHERE next_version.seq = ?6 + 1
    AND NOT EXISTS (
      SELECT 1 FROM terms_versions AS current_version
      WHERE current_version.seq = ?6 AND current_version.body_sha256 = ?2
    )
  RETURNING version, seq, created_at AS publishedAt`

const TERMS_CURRENT_SQL = `
  SELECT seq FROM terms_versions ORDER BY seq DESC LIMIT 1`

const TERMS_LIST_SQL = `
  SELECT
    version,
    seq,
    created_at AS publishedAt,
    change_summary AS changeSummary,
    body_sha256 AS bodySha256
  FROM terms_versions
  ORDER BY seq DESC
  LIMIT ${MAXIMUM_TERMS_LIST}`

const TERMS_VERSION_SQL = `
  SELECT
    version,
    seq,
    created_at AS publishedAt,
    change_summary AS changeSummary,
    body_sha256 AS bodySha256,
    body
  FROM terms_versions
  WHERE version = ?1
  LIMIT 1`

/** The highest seq terms_versions.seq may hold (its CHECK). */
export const MAXIMUM_TERMS_SEQ = 9999

export interface TermsPublishInput {
  /** Normalised plain text (checked by the handler). */
  readonly body: string
  readonly bodySha256: string
  readonly changeSummary: string | null
  /** The current seq the admin published against; 0 for none. */
  readonly expectedSeq: number
}

export type TermsPublishResult =
  | {
      readonly kind: 'published'
      readonly version: string
      readonly seq: number
      readonly publishedAt: string
    }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'conflict' }

/** POST terms (#32): the next version, its audit row and the current seq, one batch. */
export async function publishTermsVersion(
  db: D1Database,
  writer: SettingsWriter,
  input: TermsPublishInput,
): Promise<TermsPublishResult> {
  if (
    !isIntegerBetween(input.expectedSeq, 0, MAXIMUM_TERMS_SEQ - 1) ||
    !SHA256_HEX.test(input.bodySha256)
  ) {
    throw new RangeError('Invalid terms publish input')
  }

  const version = `v${input.expectedSeq + 1}`
  const insert = db
    .prepare(TERMS_INSERT_SQL)
    .bind(
      input.body,
      input.bodySha256,
      input.changeSummary,
      writer.uid,
      writer.reauthAt,
      input.expectedSeq,
    )
  const [written, , current] = await db.batch<Row>([
    ...auditAfterWrite(
      db,
      insert,
      writer,
      termsPublishedAudit({ version, bodySha256: input.bodySha256 }),
    ),
    db.prepare(TERMS_CURRENT_SQL),
  ])
  const row = written?.results.at(0)

  if (row !== undefined) {
    const { seq, publishedAt } = row

    if (
      row.version !== version ||
      !isRowId(seq) ||
      seq !== input.expectedSeq + 1 ||
      !isInstant(publishedAt)
    ) {
      return unexpectedRow()
    }

    return { kind: 'published', version, seq, publishedAt }
  }

  const currentSeq = current?.results.at(0)?.seq ?? 0

  return currentSeq === input.expectedSeq
    ? { kind: 'unchanged' }
    : { kind: 'conflict' }
}

export interface TermsVersionSummary {
  readonly version: string
  readonly seq: number
  readonly publishedAt: string
  readonly changeSummary: string | null
  readonly bodySha256: string
}

export interface TermsVersionDetail extends TermsVersionSummary {
  readonly body: string
}

function readTermsSummary(row: Row): TermsVersionSummary | null {
  const { version, seq, publishedAt, changeSummary, bodySha256 } = row

  if (
    typeof version !== 'string' ||
    !isRowId(seq) ||
    version !== `v${seq}` ||
    !isInstant(publishedAt) ||
    !(changeSummary === null || typeof changeSummary === 'string') ||
    typeof bodySha256 !== 'string' ||
    !SHA256_HEX.test(bodySha256)
  ) {
    return null
  }

  return { version, seq, publishedAt, changeSummary, bodySha256 }
}

/** GET terms (#32): the newest MAXIMUM_TERMS_LIST versions; bad rows left out. */
export async function listTermsVersions(
  db: D1Database,
): Promise<readonly TermsVersionSummary[]> {
  const { results } = await db.prepare(TERMS_LIST_SQL).all<Row>()

  return results.flatMap((row) => {
    const summary = readTermsSummary(row)

    return summary === null ? [] : [summary]
  })
}

export function isTermsVersion(value: unknown): value is string {
  return typeof value === 'string' && TERMS_VERSION.test(value)
}

/** GET terms?version= (#32, TM-18): one version with its body, or null. */
export async function readTermsVersion(
  db: D1Database,
  version: string,
): Promise<TermsVersionDetail | null> {
  if (!isTermsVersion(version)) {
    return null
  }

  const row = await db.prepare(TERMS_VERSION_SQL).bind(version).first<Row>()

  if (row === null) {
    return null
  }

  const summary = readTermsSummary(row)

  return summary === null || typeof row.body !== 'string'
    ? null
    : { ...summary, body: row.body }
}

// ---------------------------------------------------------------------------
// Delivery areas (#34; TM-04)
// ---------------------------------------------------------------------------

export interface DeliveryArea {
  readonly id: string
  readonly name: string
  readonly fee: number
  readonly isActive: boolean
  readonly sortOrder: number
}

export const MAXIMUM_DELIVERY_FEE = 5000
export const MAXIMUM_DELIVERY_SORT_ORDER = 999

const DELIVERY_AREA_COLUMNS = `
  id,
  name,
  fee,
  is_active AS isActive,
  sort_order AS sortOrder`

const DELIVERY_AREAS_SQL = `
  SELECT ${DELIVERY_AREA_COLUMNS}
  FROM delivery_areas
  ORDER BY sort_order, created_at, id
  LIMIT ${MAXIMUM_DELIVERY_AREAS}`

const DELIVERY_AREA_SQL = `
  SELECT ${DELIVERY_AREA_COLUMNS}
  FROM delivery_areas
  WHERE id = ?1
  LIMIT 1`

/**
 * ?1 id, ?2 name, ?3 fee, ?4 sort_order, ?5 the cap. Refused inside the
 * statement when the name is taken or the cap is reached.
 */
const DELIVERY_AREA_INSERT_SQL = `
  INSERT INTO delivery_areas (id, name, fee, is_active, sort_order, created_at, updated_at)
  SELECT ?1, ?2, ?3, 1, ?4, ${SQL_NOW}, ${SQL_NOW}
  WHERE NOT EXISTS (SELECT 1 FROM delivery_areas WHERE name = ?2)
    AND (SELECT COUNT(*) FROM delivery_areas) < ?5`

/**
 * ?1 id, ?2..?5 the new name, fee, is_active, sort_order, ?6..?9 the values
 * read before (compare-and-swap: a concurrent change makes it write
 * nothing). Refused when another area has the new name.
 */
const DELIVERY_AREA_UPDATE_SQL = `
  UPDATE delivery_areas
  SET name = ?2, fee = ?3, is_active = ?4, sort_order = ?5, updated_at = ${SQL_NOW}
  WHERE id = ?1
    AND name = ?6 AND fee = ?7 AND is_active = ?8 AND sort_order = ?9
    AND NOT EXISTS (
      SELECT 1 FROM delivery_areas AS other_area
      WHERE other_area.name = ?2 AND other_area.id <> ?1
    )`

// ?1 id (or NULL), ?2 name: why a write changed nothing.
const DELIVERY_AREA_STATE_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM delivery_areas WHERE id = ?1) AS present,
    EXISTS (
      SELECT 1 FROM delivery_areas WHERE name = ?2 AND id IS NOT ?1
    ) AS nameTaken`

export function isDeliveryAreaId(value: unknown): value is string {
  return typeof value === 'string' && AREA_ID.test(value)
}

/**
 * A stored area as the API returns it; null for a row that fails its
 * CHECK-equivalent guard, with the name re-checked by `isStoredName` (the
 * free-text rule the handler writes with).
 */
function readDeliveryArea(
  row: Row,
  isStoredName: (value: unknown) => value is string,
): DeliveryArea | null {
  const { id, name, fee, isActive, sortOrder } = row

  if (
    !isDeliveryAreaId(id) ||
    !isStoredName(name) ||
    !isIntegerBetween(fee, 0, MAXIMUM_DELIVERY_FEE) ||
    !(isActive === 0 || isActive === 1) ||
    !isIntegerBetween(sortOrder, 0, MAXIMUM_DELIVERY_SORT_ORDER)
  ) {
    return null
  }

  return { id, name, fee, isActive: isActive === 1, sortOrder }
}

/** Every area (at most MAXIMUM_DELIVERY_AREAS), rows that fail left out. */
export async function listDeliveryAreas(
  db: D1Database,
  isStoredName: (value: unknown) => value is string,
): Promise<readonly DeliveryArea[]> {
  const { results } = await db.prepare(DELIVERY_AREAS_SQL).all<Row>()

  return results.flatMap((row) => {
    const area = readDeliveryArea(row, isStoredName)

    return area === null ? [] : [area]
  })
}

/** One area for PATCH: the area, 'missing', or 'invalid' for a row that fails. */
export async function readDeliveryAreaById(
  db: D1Database,
  id: string,
  isStoredName: (value: unknown) => value is string,
): Promise<DeliveryArea | 'missing' | 'invalid'> {
  const row = await db.prepare(DELIVERY_AREA_SQL).bind(id).first<Row>()

  if (row === null) {
    return 'missing'
  }

  return readDeliveryArea(row, isStoredName) ?? 'invalid'
}

interface AreaState {
  readonly present: boolean
  readonly nameTaken: boolean
}

function readAreaState(result: D1Result<Row> | undefined): AreaState {
  const row = result?.results.at(0)

  return { present: row?.present === 1, nameTaken: row?.nameTaken === 1 }
}

export type DeliveryAreaCreateResult =
  | { readonly kind: 'created'; readonly area: DeliveryArea }
  | { readonly kind: 'name-taken' }
  | { readonly kind: 'limit-reached' }

/** POST delivery-areas (#34): insert, audit and the refusal reason, one batch. */
export async function createDeliveryArea(
  db: D1Database,
  actor: AdminAuditActor,
  input: { readonly name: string; readonly fee: number; readonly sortOrder: number },
  auditEntry: (areaId: string) => AfterWriteAuditEntry,
): Promise<DeliveryAreaCreateResult> {
  const id = crypto.randomUUID()
  const insert = db
    .prepare(DELIVERY_AREA_INSERT_SQL)
    .bind(id, input.name, input.fee, input.sortOrder, MAXIMUM_DELIVERY_AREAS)
  const [written, , state] = await db.batch<Row>([
    ...auditAfterWrite(db, insert, actor, auditEntry(id)),
    db.prepare(DELIVERY_AREA_STATE_SQL).bind(null, input.name),
  ])

  if (insertedOne(written)) {
    return {
      kind: 'created',
      area: {
        id,
        name: input.name,
        fee: input.fee,
        isActive: true,
        sortOrder: input.sortOrder,
      },
    }
  }

  return readAreaState(state).nameTaken
    ? { kind: 'name-taken' }
    : { kind: 'limit-reached' }
}

export type DeliveryAreaUpdateResult =
  | { readonly kind: 'updated'; readonly area: DeliveryArea }
  | { readonly kind: 'missing' }
  | { readonly kind: 'name-taken' }
  | { readonly kind: 'changed' }

/**
 * PATCH delivery-areas/{id} (#34): a compare-and-swap from `before` (what
 * the handler read) to `after`, its audit row and the refusal reason, one
 * batch.
 */
export async function updateDeliveryArea(
  db: D1Database,
  actor: AdminAuditActor,
  before: DeliveryArea,
  after: DeliveryArea,
  auditEntry: AfterWriteAuditEntry,
): Promise<DeliveryAreaUpdateResult> {
  const update = db
    .prepare(DELIVERY_AREA_UPDATE_SQL)
    .bind(
      before.id,
      after.name,
      after.fee,
      after.isActive ? 1 : 0,
      after.sortOrder,
      before.name,
      before.fee,
      before.isActive ? 1 : 0,
      before.sortOrder,
    )
  const [written, , stateResult] = await db.batch<Row>([
    ...auditAfterWrite(db, update, actor, auditEntry),
    db.prepare(DELIVERY_AREA_STATE_SQL).bind(before.id, after.name),
  ])

  if (insertedOne(written)) {
    return { kind: 'updated', area: after }
  }

  const state = readAreaState(stateResult)

  if (!state.present) {
    return { kind: 'missing' }
  }

  return state.nameTaken ? { kind: 'name-taken' } : { kind: 'changed' }
}

// ---------------------------------------------------------------------------
// Kill switch (#43; H3)
// ---------------------------------------------------------------------------

/**
 * ?1 state, ?2 note, ?3 actor, ?4 reauth_at (required for 'on' by the
 * CHECK). Unchanged when the switch already has that state (no row: 'on').
 */
const SWITCH_INSERT_SQL = `
  INSERT INTO ops_switch_revisions (switch_name, state, note, created_by, reauth_at, created_at)
  SELECT 'online_confirmation', ?1, ?2, ?3, ?4, ${SQL_NOW}
  WHERE COALESCE((
    SELECT latest.state FROM ops_switch_revisions AS latest
    WHERE latest.switch_name = 'online_confirmation'
    ORDER BY latest.id DESC
    LIMIT 1
  ), 'on') <> ?1
  RETURNING id, created_at AS changedAt`

export type SwitchWriteResult =
  | { readonly kind: 'saved'; readonly revisionId: number; readonly changedAt: string }
  | { readonly kind: 'unchanged' }

/** PUT switch (#43): the revision and its audit row, one batch. */
export async function writeKillSwitch(
  db: D1Database,
  actor: AdminAuditActor,
  state: 'on' | 'off',
  note: string | null,
  auditEntry: AfterWriteAuditEntry,
): Promise<SwitchWriteResult> {
  const insert = db
    .prepare(SWITCH_INSERT_SQL)
    .bind(state, note, actor.uid, actor.reauthAt)
  const [written] = await db.batch<Row>([
    ...auditAfterWrite(db, insert, actor, auditEntry),
  ])
  const row = written?.results.at(0)

  if (row === undefined) {
    return { kind: 'unchanged' }
  }

  const { id, changedAt } = row

  if (!isRowId(id) || !isInstant(changedAt)) {
    return unexpectedRow()
  }

  return { kind: 'saved', revisionId: id, changedAt }
}

// ---------------------------------------------------------------------------
// Business identity (GAP-03; migration 0010)
// ---------------------------------------------------------------------------

/**
 * ?1 legal_name, ?2 licence_number, ?3 vat_status, ?4 actor, ?5 reauth_at.
 * Unchanged when the newest row holds the same three values.
 */
const IDENTITY_INSERT_SQL = `
  INSERT INTO business_identity_revisions (
    legal_name, licence_number, vat_status, created_by, reauth_at, created_at
  )
  SELECT ?1, ?2, ?3, ?4, ?5, ${SQL_NOW}
  WHERE NOT EXISTS (
    SELECT 1 FROM business_identity_revisions AS current_identity
    WHERE current_identity.id = (SELECT MAX(id) FROM business_identity_revisions)
      AND current_identity.legal_name IS ?1
      AND current_identity.licence_number IS ?2
      AND current_identity.vat_status = ?3
  )
  RETURNING id, created_at AS savedAt`

const IDENTITY_CURRENT_SQL = `
  SELECT
    id,
    legal_name AS legalName,
    licence_number AS licenceNumber,
    vat_status AS vatStatus,
    created_at AS savedAt
  FROM business_identity_revisions
  ORDER BY id DESC
  LIMIT 1`

export type IdentityWriteResult =
  | { readonly kind: 'saved'; readonly revisionId: number; readonly savedAt: string }
  | { readonly kind: 'unchanged' }

/**
 * PUT identity (GAP-03): the next revision. Public once saved, so it is
 * never delayed. The revision table is itself the audit trail (append-only,
 * created_by, reauth_at and a SQL-stamped created_at): admin_audit_log has
 * no action for it (shared/audit.ts).
 */
export async function writeBusinessIdentity(
  db: D1Database,
  writer: SettingsWriter,
  identity: BusinessIdentity,
): Promise<IdentityWriteResult> {
  const row = await db
    .prepare(IDENTITY_INSERT_SQL)
    .bind(
      identity.legalName,
      identity.licenceNumber,
      identity.vatStatus,
      writer.uid,
      writer.reauthAt,
    )
    .first<Row>()

  if (row === null) {
    return { kind: 'unchanged' }
  }

  const { id, savedAt } = row

  if (!isRowId(id) || !isInstant(savedAt)) {
    return unexpectedRow()
  }

  return { kind: 'saved', revisionId: id, savedAt }
}

export interface StoredBusinessIdentity extends BusinessIdentity {
  readonly revisionId: number
  readonly savedAt: string
}

/**
 * The current business identity, the one reader of its table (the admin
 * settings view here; the public disclosure page through
 * toPublicBusinessIdentity). A row that fails readStoredBusinessIdentity
 * reads as none, never as an older row (fail closed: nothing is shown).
 */
export async function readCurrentBusinessIdentity(
  db: D1Database,
): Promise<StoredBusinessIdentity | null> {
  const row = await db.prepare(IDENTITY_CURRENT_SQL).first<Row>()

  if (row === null || !isRowId(row.id) || !isInstant(row.savedAt)) {
    return null
  }

  const identity = readStoredBusinessIdentity(row)

  return identity === null
    ? null
    : { ...identity, revisionId: row.id, savedAt: row.savedAt }
}

/** The statements of the non-section writes (tests prepare each one). */
export const SETTINGS_WRITE_OTHER_SQL = {
  settingsHistory: SETTINGS_HISTORY_SQL,
  identityHistory: IDENTITY_HISTORY_SQL,
  termsInsert: TERMS_INSERT_SQL,
  termsCurrent: TERMS_CURRENT_SQL,
  termsList: TERMS_LIST_SQL,
  termsVersion: TERMS_VERSION_SQL,
  deliveryAreas: DELIVERY_AREAS_SQL,
  deliveryArea: DELIVERY_AREA_SQL,
  deliveryAreaInsert: DELIVERY_AREA_INSERT_SQL,
  deliveryAreaUpdate: DELIVERY_AREA_UPDATE_SQL,
  deliveryAreaState: DELIVERY_AREA_STATE_SQL,
  switchInsert: SWITCH_INSERT_SQL,
  identityInsert: IDENTITY_INSERT_SQL,
  identityCurrent: IDENTITY_CURRENT_SQL,
} as const
