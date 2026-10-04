import {
  ADMIN_AUDIT_DETAILS_MAX_LENGTH,
  isAdminAuditEntry,
  isAdminAuditWorkerAction,
  isAuditInstant,
  type AdminAuditEntry,
  type AdminAuditPlacement,
  type AdminAuditTarget,
  type AfterWriteAuditEntry,
  type StandaloneAuditEntry,
} from '../../shared/audit.js'

/**
 * The one writer of admin_audit_log (migration 0008, table 6; plan 11 W1-09,
 * SB-10, SB-13, M1, L2). It never runs a query: it returns prepared
 * statements for the caller's D1 batch, so the audit row and the write it
 * records commit together or not at all.
 *
 * - created_at is stamped by SQLite, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
 *   and never bound from the Worker (M1): the log's clock is the database's,
 *   the same clock as the reauth_at CHECK (at most 10 minutes before
 *   created_at).
 * - Only the entries the shared/audit.ts builders returned are accepted, so
 *   details hold allowlisted ids, counts, dates and codes, and never exceed
 *   ADMIN_AUDIT_DETAILS_MAX_LENGTH (re-checked here, before D1). The two
 *   promotion actions are refused: only scripts/promote-admin.mjs writes
 *   them (L2).
 * - The table is append-only (triggers), so a row written by mistake can
 *   never be removed. An action whose write may change nothing by design is
 *   accepted only by auditAfterWrite, which ties the row to that write: no
 *   row when it changed nothing (a stale version, a full slot, an unchanged
 *   setting), and a failed batch, with nothing committed, when it changed
 *   more than one row or did not insert the revision the entry names. Which
 *   function takes an action is fixed in shared/audit.ts
 *   (adminAuditPlacements), by the entry's type and again here at run time.
 * - The SQL is fixed text; every value is a bound parameter (SB-4).
 */

/** An admin uid, as scripts/promote-admin.mjs checks it before promoting. */
const ADMIN_UID_PATTERN = /^[A-Za-z0-9]{1,128}$/
/** admin_audit_log.target_id CHECK. */
const TARGET_ID_PATTERN = /^[0-9A-Za-z._:-]{1,64}$/

const INSERT_AUDIT_ROW = `
  INSERT INTO admin_audit_log (
    actor_uid,
    action,
    target_id,
    details,
    reauth_at,
    created_at
  )
  VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
`

/*
 * The after-write statements read changes() and last_insert_rowid(), which
 * still describe the previous statement of the batch while this one runs
 * (triggers do not move either). They insert nothing when that write
 * changed no row. Otherwise action is NULL unless the write changed exactly
 * one row (and, for a revision, inserted that revision), and the NOT NULL
 * constraint on action then fails the statement and rolls the whole batch
 * back; the same guard as worker/jobs/hold-expiry.ts.
 */

/** Binds: actor, action, target id, details, reauth_at. */
const INSERT_AUDIT_ROW_AFTER_WRITE = `
  INSERT INTO admin_audit_log (
    actor_uid,
    action,
    target_id,
    details,
    reauth_at,
    created_at
  )
  SELECT
    ?,
    CASE WHEN changes() = 1 THEN ? END,
    ?,
    ?,
    ?,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE changes() <> 0
`

/**
 * The target is the settings_revisions row the write inserted: of this
 * section, by this actor, and not audited yet. The last check matters
 * because last_insert_rowid() belongs to the connection, not the batch:
 * after a write that inserted nothing it still holds an older id, which may
 * be that of a revision audited earlier. (admin_audit_log has no index on
 * target_id; the scan runs only on the rare settings and switch saves.)
 * Binds: actor, section, actor, action, action, details, reauth_at.
 */
const INSERT_AUDIT_ROW_FOR_SETTINGS_REVISION = `
  INSERT INTO admin_audit_log (
    actor_uid,
    action,
    target_id,
    details,
    reauth_at,
    created_at
  )
  SELECT
    ?,
    CASE
      WHEN changes() = 1 AND EXISTS (
        SELECT 1 FROM settings_revisions AS revision
        WHERE revision.id = last_insert_rowid()
          AND revision.section = ?
          AND revision.created_by = ?
          AND NOT EXISTS (
            SELECT 1 FROM admin_audit_log AS audited
            WHERE audited.action = ?
              AND audited.target_id = CAST(revision.id AS TEXT)
          )
      )
      THEN ?
    END,
    CAST(last_insert_rowid() AS TEXT),
    ?,
    ?,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE changes() <> 0
`

/**
 * The same for the online_confirmation row of ops_switch_revisions: of this
 * state, by this actor, and not audited yet. Binds: actor, state, actor,
 * action, action, details, reauth_at.
 */
const INSERT_AUDIT_ROW_FOR_SWITCH_REVISION = `
  INSERT INTO admin_audit_log (
    actor_uid,
    action,
    target_id,
    details,
    reauth_at,
    created_at
  )
  SELECT
    ?,
    CASE
      WHEN changes() = 1 AND EXISTS (
        SELECT 1 FROM ops_switch_revisions AS revision
        WHERE revision.id = last_insert_rowid()
          AND revision.switch_name = 'online_confirmation'
          AND revision.state = ?
          AND revision.created_by = ?
          AND NOT EXISTS (
            SELECT 1 FROM admin_audit_log AS audited
            WHERE audited.action = ?
              AND audited.target_id = CAST(revision.id AS TEXT)
          )
      )
      THEN ?
    END,
    CAST(last_insert_rowid() AS TEXT),
    ?,
    ?,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE changes() <> 0
`

/** Who acted, from the route's admin guard. */
export interface AdminAuditActor {
  /** The admin's Firebase uid (users.id). */
  readonly uid: string
  /**
   * The token's auth_time as an ISO instant, from reauthAtFromToken
   * (worker/recent-auth.ts) and nothing else, on a route behind the
   * recent-sign-in guard (AD+R, AD+S); null on any other route.
   * The database refuses a value more than 10 minutes before created_at,
   * and with it the whole batch.
   */
  readonly reauthAt: string | null
}

type AuditDatabase = Pick<D1Database, 'prepare'>

/** The checked values every audit statement binds. */
interface CheckedRow {
  readonly actorUid: string
  readonly action: string
  readonly details: string | null
  readonly reauthAt: string | null
}

/**
 * Re-checks everything the row will carry before any SQL runs. A failure is
 * a bug in the calling handler; the message names the rule, never a value.
 */
function checkRow(
  actor: AdminAuditActor,
  entry: AdminAuditEntry,
  placement: AdminAuditPlacement,
): CheckedRow {
  if (!isAdminAuditEntry(entry)) {
    throw new TypeError(
      'Admin audit: the entry must come from a shared/audit.ts builder.',
    )
  }

  if (!isAdminAuditWorkerAction(entry.action)) {
    throw new TypeError('Admin audit: the Worker does not record this action.')
  }

  if (entry.placement !== placement) {
    throw new TypeError(
      entry.placement === 'after_write'
        ? 'Admin audit: this action is recorded only after its write, with auditAfterWrite.'
        : 'Admin audit: this action is recorded on its own, with auditStatement.',
    )
  }

  if (typeof actor.uid !== 'string' || !ADMIN_UID_PATTERN.test(actor.uid)) {
    throw new TypeError('Admin audit: the actor uid is not an admin uid.')
  }

  if (actor.reauthAt !== null && !isAuditInstant(actor.reauthAt)) {
    throw new TypeError('Admin audit: reauthAt must be an ISO-8601 instant.')
  }

  if (entry.reauthRequired && actor.reauthAt === null) {
    throw new TypeError(
      'Admin audit: this action is recorded only with a recent sign-in time.',
    )
  }

  const details = entry.detailsJson

  if (
    details !== null &&
    (details.length > ADMIN_AUDIT_DETAILS_MAX_LENGTH ||
      !details.startsWith('{'))
  ) {
    throw new RangeError(
      `Admin audit: details must be a JSON object of at most ${ADMIN_AUDIT_DETAILS_MAX_LENGTH} characters.`,
    )
  }

  const { target } = entry

  switch (target.kind) {
    case 'none':
      break
    case 'id':
      if (!TARGET_ID_PATTERN.test(target.id)) {
        throw new TypeError('Admin audit: the target id is not a valid id.')
      }
      break
    case 'settings_revision':
    case 'switch_revision':
      if (placement === 'standalone') {
        throw new TypeError(
          'Admin audit: an entry for an inserted revision needs auditAfterWrite.',
        )
      }
      break
    default:
      throw new TypeError('Admin audit: unknown target.')
  }

  return {
    actorUid: actor.uid,
    action: entry.action,
    details,
    reauthAt: actor.reauthAt,
  }
}

/**
 * The INSERT of one unconditional audit row, only for the actions that
 * write nothing else or record the counts of their own writes:
 * bookings_exported, receipt_viewed, gallery_selection_exported and
 * handover_slots_generated. Batch it with the caller's other statements,
 * or run it on its own (an export, whose row must exist before the file is
 * returned) and check that it changed exactly one row.
 *
 * Never for a row that follows a write which may change nothing: the
 * settings, switch, terms and delivery-area saves (W2-01), revoke-all
 * (W2-05), handover slot create, update and delete (W2-08) and blocked
 * dates (W3-02) go through auditAfterWrite. Their entries are refused here,
 * by type and at run time.
 */
export function auditStatement(
  db: AuditDatabase,
  actor: AdminAuditActor,
  entry: StandaloneAuditEntry,
): D1PreparedStatement {
  const row = checkRow(actor, entry, 'standalone')
  const { target } = entry

  return db
    .prepare(INSERT_AUDIT_ROW)
    .bind(
      row.actorUid,
      row.action,
      target.kind === 'id' ? target.id : null,
      row.details,
      row.reauthAt,
    )
}

/**
 * `write` followed by its audit row, for every action whose write may
 * change no row by design (the settings, switch, terms and delivery-area
 * saves, revoke-all, handover slot create, update and delete, blocked
 * dates). Spread it into the caller's batch in this order:
 * `db.batch([...auditAfterWrite(db, write, actor, entry)])`. `write` is the
 * one statement that makes the change, with the route's condition in it
 * (the capacity rule, the terms version, the unreferenced slot); for a
 * settings or switch entry, the single-row INSERT of that revision, by this
 * actor. The caller reads both results: changes 1 and 1 means written and
 * audited, 0 and 0 means the write was refused by its own condition and
 * nothing was recorded. Any other outcome is a thrown batch with nothing
 * committed.
 */
export function auditAfterWrite(
  db: AuditDatabase,
  write: D1PreparedStatement,
  actor: AdminAuditActor,
  entry: AfterWriteAuditEntry,
): readonly [D1PreparedStatement, D1PreparedStatement] {
  const row = checkRow(actor, entry, 'after_write')

  return [write, afterWriteStatement(db, row, entry.target)]
}

function afterWriteStatement(
  db: AuditDatabase,
  row: CheckedRow,
  target: AdminAuditTarget,
): D1PreparedStatement {
  switch (target.kind) {
    case 'none':
    case 'id':
      return db
        .prepare(INSERT_AUDIT_ROW_AFTER_WRITE)
        .bind(
          row.actorUid,
          row.action,
          target.kind === 'id' ? target.id : null,
          row.details,
          row.reauthAt,
        )
    case 'settings_revision':
      return db
        .prepare(INSERT_AUDIT_ROW_FOR_SETTINGS_REVISION)
        .bind(
          row.actorUid,
          target.section,
          row.actorUid,
          row.action,
          row.action,
          row.details,
          row.reauthAt,
        )
    case 'switch_revision':
      return db
        .prepare(INSERT_AUDIT_ROW_FOR_SWITCH_REVISION)
        .bind(
          row.actorUid,
          target.state,
          row.actorUid,
          row.action,
          row.action,
          row.details,
          row.reauthAt,
        )
  }
}
