#!/usr/bin/env node
// The one admin script (plan 11 W1-12 / R-03; threat model TM-02/B2, TM-07;
// L2). It gives the admin role to ONE users row chosen by Firebase uid, moves
// it to another uid (--replace) or takes it away (--demote). It replaces Wave
// 0's grant-admin.mjs; no API writes users.role (scripts/verify.mjs gate).
//
//   node scripts/promote-admin.mjs --database sundus-yar-production --uid <uid> --email <email> --remote
//   node scripts/promote-admin.mjs --database sundus-yar-production --uid <uid> --email <email> --remote --replace
//   node scripts/promote-admin.mjs --database sundus-yar-production --uid <uid> --email <email> --remote --demote
//   node scripts/promote-admin.mjs --database sundus-yar-preview --uid <uid> --email <email> --remote --env preview
//   node scripts/promote-admin.mjs --database sundus-yar-production --uid <uid> --email <email> --local [--persist-to <folder>]
//
// Never by email alone (N-31): an address in D1 can belong to a different uid
// than the owner's verified account. Take the uid from the Firebase console
// (Authentication > Users) of the owner's account, which is created there
// before the public deploy (plan 11 section 7.3). She signs in to the site
// once with that verified email first, so the row exists and
// users.email_verified_at proves the address.
//
// One run is one wrangler batch, shown in full (uid, stored email, exact SQL)
// before the operator types the confirmation:
// - promote: UPDATE users SET role = 'admin', tokens_valid_after = <D1 now>
//   WHERE id = <uid> AND lower(email) = lower(<email>) AND email_verified_at
//   IS NOT NULL AND erased_at IS NULL, also requiring the role shown to the
//   operator and no other admin, plus the audit row admin_promoted (actor and
//   target: the uid). Run for the uid that already is the admin, the same
//   UPDATE keeps the role and ends every session of that account, audited
//   as admin_promoted as well: step 1 of the TM-07 incident order (plan 11
//   section 7.11) from the owner's machine. This is the only script that
//   touches the admin row (revoke-sessions.mjs refuses it).
// - --replace: the current admin is demoted (admin_demoted, actor: the
//   promoted uid), then the uid is promoted as above. Both accounts' earlier
//   sign-ins are refused afterwards.
// - --demote: the admin row with this uid and stored email becomes a
//   customer (admin_demoted) and its sessions end. On a database without the
//   audit log (migrations 0008/0009 not applied yet) only --demote runs,
//   unaudited, e.g. to leave one admin before 0008's single-admin index
//   (plan 11 section 7.10).
// Each audit row takes its created_at only when the UPDATE before it changed
// exactly one row; otherwise its NOT NULL fails the batch, which D1 rolls
// back (lib/wrangler-d1.mjs). The script writes only admin_promoted and
// admin_demoted, with reauth_at NULL: shared/audit.ts reserves exactly these
// two for it, and admin_sessions_revoked stays the Worker's re-authenticated
// «تسجيل الخروج من كل الأجهزة», so an incident review never mistakes this
// operator run for the admin's own action. Afterwards the script reads the
// database again: exactly one admin, the uid (none left by --demote), fresh
// tokens_valid_after on every changed row and exactly the audit rows written.
//
// tokens_valid_after is stamped from D1's clock, so every sign-in before the
// run is refused (worker/users.ts): the new admin signs in again before
// opening /admin, and a session that existed before the promotion never gains
// admin access. The Worker binds admin access to the stored email as well
// (worker/admin-auth.ts), and an admin row's email never follows the token:
// if the owner changes her login email, --demote, she signs in once with the
// new verified email, then promote again with the new --email.

import {
  AUDIT_BASELINE_SQL,
  STAMP_SESSIONS_SQL,
  ScriptFailure,
  UsageError,
  auditBaseline,
  auditRowsMatch,
  auditRowsSinceStatement,
  auditStatement,
  consoleIo,
  describeUnixSeconds,
  isMainModule,
  isPlainUid,
  migrationsCommand,
  parseArguments,
  printSql,
  printTarget,
  printable,
  readRows,
  readSchema,
  requireEmail,
  requireUid,
  rowsOf,
  runCli,
  sqlText,
} from './lib/wrangler-d1.mjs'

export const USAGE = [
  'Usage: node scripts/promote-admin.mjs --database <name> --uid <firebase-uid> --email <email>',
  '         (--local [--persist-to <folder>] | --remote) [--env preview|mediatest] [--replace | --demote]',
].join('\n')

/** Reads --uid and --email; the uid is required whenever the email is given (N-31). */
function requireIdentity(values) {
  if (!values.has('uid')) {
    throw new UsageError(
      values.has('email')
        ? '--email without --uid is refused: the admin is chosen by Firebase uid, and the email is only compared with the stored one (N-31).'
        : '--uid is required: the Firebase UID of the account, from the Firebase console.',
    )
  }

  if (!values.has('email')) {
    throw new UsageError('--email is required: the email stored for this uid, compared case-insensitively.')
  }

  return { uid: requireUid(values.get('uid')), email: requireEmail(values.get('email')) }
}

/**
 * The promotion UPDATE of the plan (W1-12), also bound to the role shown to
 * the operator and to "no other admin", so it cannot create a second admin
 * even without migration 0008's single-admin index.
 */
function promoteStatement(uid, email, currentRole) {
  return [
    `UPDATE users SET role = 'admin', ${STAMP_SESSIONS_SQL}, updated_at = CURRENT_TIMESTAMP`,
    `WHERE id = ${sqlText(uid)} AND lower(email) = lower(${sqlText(email)})`,
    '  AND email_verified_at IS NOT NULL AND erased_at IS NULL',
    `  AND role = ${sqlText(currentRole)}`,
    `  AND NOT EXISTS (SELECT 1 FROM users AS other WHERE other.role = 'admin' AND other.id <> ${sqlText(uid)})`,
  ].join('\n')
}

/** Demotes one admin row; with an email, only while the row still stores it. */
function demoteStatement(uid, email) {
  return [
    `UPDATE users SET role = 'customer', ${STAMP_SESSIONS_SQL}, updated_at = CURRENT_TIMESTAMP`,
    `WHERE id = ${sqlText(uid)}${email === null ? '' : ` AND lower(email) = lower(${sqlText(email)})`} AND role = 'admin'`,
  ].join('\n')
}

function readState(io, options, { uid, email, auditLog }) {
  const statements = [
    [
      'SELECT id, email, role, email_verified_at, erased_at IS NOT NULL AS erased, tokens_valid_after,',
      `  lower(email) = lower(${sqlText(email)}) AS email_matches`,
      `FROM users WHERE id = ${sqlText(uid)}`,
    ].join('\n'),
    "SELECT id, email, tokens_valid_after FROM users WHERE role = 'admin' ORDER BY id",
    'SELECT unixepoch() AS now',
  ]

  if (auditLog) {
    statements.push(AUDIT_BASELINE_SQL)
  }

  const results = readRows(io, options, statements)
  const accounts = rowsOf(results, 0)
  const now = rowsOf(results, 2)[0]?.now

  if (accounts.length > 1 || !Number.isSafeInteger(now)) {
    throw new ScriptFailure('Refused: unexpected answer from the database. Nothing was changed.')
  }

  return {
    account: accounts[0] ?? null,
    admins: rowsOf(results, 1),
    now,
    lastAuditId: auditLog ? auditBaseline(rowsOf(results, 3)[0], options) : null,
  }
}

function refuse(reason) {
  throw new ScriptFailure(`Refused: ${reason} Nothing was changed.`)
}

/** "uid email" of an admin row read from the database, safe to print. */
function describeAdmin(admin) {
  return `${printable(admin.id)}  ${printable(admin.email)}`
}

/**
 * Decides the batch for `mode` from the state read before it, or refuses.
 * `expect` is what the database must hold afterwards.
 */
function planChange({ mode, uid, email, auditLog, state, options }) {
  const { account, admins } = state

  if (account === null) {
    refuse(
      'no users row has this uid. The account signs in to the site once (and saves its profile) first; check the uid in the Firebase console.',
    )
  }

  if (account.email_matches !== 1) {
    refuse('the row with this uid stores a different email (N-31). Check the uid and the email in the Firebase console.')
  }

  const others = admins.filter((admin) => admin.id !== uid)
  const otherIds = others.map((admin) => admin.id)

  if (mode === 'demote') {
    if (account.role !== 'admin') {
      refuse('this uid is not an admin: there is nothing to demote.')
    }

    return {
      verb: 'demote',
      summary: auditLog
        ? `demote ${uid} to customer and end its sessions; audit row admin_demoted.`
        : `demote ${uid} to customer and end its sessions. This database has no admin audit log yet (migrations 0008/0009): the change is NOT audited.`,
      statements: [
        demoteStatement(uid, email),
        auditLog ? auditStatement({ actorUid: uid, action: 'admin_demoted', targetUid: uid }) : 'SELECT changes() AS changed',
      ],
      expect: {
        admins: otherIds,
        stamped: [uid],
        audit: auditLog ? [{ action: 'admin_demoted', targetUid: uid }] : null,
        changedAt: auditLog ? null : 1,
      },
      done:
        otherIds.length === 0
          ? `Done: ${uid} is a customer now and the site has NO admin. Promote the owner's account again when she is ready.`
          : `Done: ${uid} is a customer now.`,
    }
  }

  if (!auditLog) {
    refuse(
      `this database has no admin audit log yet, and every promotion is audited (L2). Apply migrations 0008 and 0009 first: ${migrationsCommand(options)}` +
        (account.role === 'admin' ? '\nTo end the sessions of this admin before that, --demote runs unaudited.' : ''),
    )
  }

  if (account.erased !== 0) {
    refuse('this row was erased.')
  }

  if (account.email_verified_at === null) {
    refuse('this email was never confirmed by a verified sign-in. She verifies it in Firebase, signs in to the site once, then retry.')
  }

  if (mode === 'replace') {
    if (account.role === 'admin') {
      refuse('this uid already is the admin: there is nothing to replace. Without --replace, the run only ends its sessions.')
    }

    if (others.length !== 1) {
      refuse(
        others.length === 0
          ? 'there is no admin to replace. Run without --replace.'
          : `${others.length} admin rows exist (${otherIds.map(printable).join(', ')}). Demote all but one with --demote first.`,
      )
    }

    const [previous] = others

    if (!isPlainUid(previous.id)) {
      refuse('the current admin row has an id that is not a plain Firebase uid; review it by hand.')
    }

    return {
      verb: 'replace',
      summary: `demote the current admin ${previous.id} (${printable(previous.email)}) and promote ${uid}, in one batch; every earlier sign-in of both accounts is refused afterwards; audit rows admin_demoted and admin_promoted.`,
      statements: [
        demoteStatement(previous.id, null),
        auditStatement({ actorUid: uid, action: 'admin_demoted', targetUid: previous.id }),
        promoteStatement(uid, email, 'customer'),
        auditStatement({ actorUid: uid, action: 'admin_promoted', targetUid: uid }),
      ],
      expect: {
        admins: [uid],
        stamped: [previous.id, uid],
        audit: [
          { action: 'admin_demoted', targetUid: previous.id },
          { action: 'admin_promoted', targetUid: uid },
        ],
        changedAt: null,
      },
      done: `Done: ${uid} is the only admin; ${previous.id} is a customer. Both sign in again; the new admin then opens /admin.`,
    }
  }

  if (others.length > 0) {
    refuse(
      `another account is the admin (${others.map(describeAdmin).join(', ')}). The site has one admin: use --replace to move the role in one batch.`,
    )
  }

  if (account.role === 'admin') {
    return {
      verb: 'promote',
      summary: `${uid} already is the admin: the role stays, and every session of this account ends (tokens_valid_after); audit row admin_promoted.`,
      statements: [
        promoteStatement(uid, email, 'admin'),
        auditStatement({ actorUid: uid, action: 'admin_promoted', targetUid: uid }),
      ],
      expect: {
        admins: [uid],
        stamped: [uid],
        audit: [{ action: 'admin_promoted', targetUid: uid }],
        changedAt: null,
      },
      done: `Done: every earlier sign-in of the admin ${uid} is refused. She signs in again (after a password reset, if this is an incident).`,
    }
  }

  return {
    verb: 'promote',
    summary: `promote ${uid} to admin; every earlier sign-in of this account is refused afterwards (tokens_valid_after); audit row admin_promoted.`,
    statements: [
      promoteStatement(uid, email, 'customer'),
      auditStatement({ actorUid: uid, action: 'admin_promoted', targetUid: uid }),
    ],
    expect: {
      admins: [uid],
      stamped: [uid],
      audit: [{ action: 'admin_promoted', targetUid: uid }],
      changedAt: null,
    },
    done: `Done: ${uid} is the only admin. She signs in again, then opens /admin.`,
  }
}

function printAdmins(io, admins) {
  io.log(`Admin rows now (${admins.length}):${admins.length === 0 ? ' none' : ''}`)

  for (const admin of admins) {
    io.log(`  ${describeAdmin(admin)}`)
  }
}

function printState(io, { account, admins }) {
  io.log('')
  io.log(`Account:           uid ${printable(account.id)}`)
  io.log(`  stored email:    ${printable(account.email)}`)
  io.log(`  email verified:  ${account.email_verified_at === null ? 'never' : printable(account.email_verified_at)}`)
  io.log(`  role:            ${printable(account.role)}${account.erased === 0 ? '' : ' (erased)'}`)
  io.log(`  sign-ins valid after: ${describeUnixSeconds(account.tokens_valid_after)}`)
  printAdmins(io, admins)
}

function sameIds(first, second) {
  const sorted = (ids) => [...ids].sort().join('\n')

  return sorted(first) === sorted(second)
}

/**
 * Reads the result back. Returns every way it differs from `plan.expect`,
 * and whether anything this batch writes changed at all (the role or
 * tokens_valid_after of the rows it updates, its audit rows), which tells a
 * failed batch that rolled back from one that did not.
 */
function verifyResult(io, options, { uid, plan, state, write }) {
  const { expect } = plan
  const before = new Map([
    ...state.admins.map((admin) => [admin.id, { role: 'admin', tokensValidAfter: admin.tokens_valid_after }]),
    [state.account.id, { role: state.account.role, tokensValidAfter: state.account.tokens_valid_after }],
  ])
  const watched = [...new Set([...expect.stamped, ...before.keys()])].filter(isPlainUid)
  const statements = [
    [
      'SELECT id, email, role, tokens_valid_after FROM users',
      `WHERE role = 'admin' OR id IN (${watched.map(sqlText).join(', ')})`,
      'ORDER BY id',
    ].join('\n'),
  ]

  if (expect.audit !== null) {
    statements.push(auditRowsSinceStatement(state.lastAuditId, uid))
  }

  const results = readRows(io, options, statements, { afterWrite: true })
  const rows = rowsOf(results, 0)
  const admins = rows.filter((row) => row.role === 'admin')
  const auditRows = expect.audit === null ? [] : rowsOf(results, 1)

  printAdmins(io, admins)

  const problems = []
  const adminIds = admins.map((admin) => admin.id)

  if (!sameIds(adminIds, expect.admins)) {
    problems.push(`the admin rows are [${adminIds.map(printable).join(', ')}], expected [${expect.admins.join(', ')}]`)
  }

  for (const id of expect.stamped) {
    const row = rows.find((candidate) => candidate.id === id)

    if (!Number.isSafeInteger(row?.tokens_valid_after) || row.tokens_valid_after < state.now) {
      problems.push(`tokens_valid_after of ${id} was not stamped`)
    }
  }

  if (expect.audit !== null && !auditRowsMatch(auditRows, expect.audit)) {
    problems.push(`the audit rows written are not exactly ${expect.audit.map((entry) => entry.action).join(', ')}`)
  }

  if (write.ok && expect.changedAt !== null && rowsOf(write.results, expect.changedAt)[0]?.changed !== 1) {
    problems.push('the UPDATE did not change exactly one row')
  }

  const changed =
    auditRows.length > 0 ||
    expect.stamped.some((id) => {
      const row = rows.find((candidate) => candidate.id === id)
      const earlier = before.get(id)

      return row?.role !== earlier?.role || row?.tokens_valid_after !== earlier?.tokensValidAfter
    })

  return { problems, changed }
}

export async function promoteAdmin(argv, io) {
  const options = parseArguments(argv, { valueFlags: ['uid', 'email'], booleanFlags: ['replace', 'demote'] })
  const { uid, email } = requireIdentity(options.values)

  if (options.flags.has('replace') && options.flags.has('demote')) {
    throw new UsageError('Choose at most one of --replace and --demote.')
  }

  const mode = options.flags.has('demote') ? 'demote' : options.flags.has('replace') ? 'replace' : 'promote'

  printTarget(io, options)

  const { auditLog } = readSchema(io, options)
  const state = readState(io, options, { uid, email, auditLog })
  const plan = planChange({ mode, uid, email, auditLog, state, options })

  printState(io, state)
  io.log(`Change: ${plan.summary}`)
  printSql(io, 'write, one batch', plan.statements)

  const phrase = `${plan.verb} ${options.database}`

  if (!(await io.confirm(phrase))) {
    throw new ScriptFailure('Cancelled: the confirmation did not match. Nothing was changed.')
  }

  const write = io.execute(plan.statements, options)

  if (!write.ok) {
    io.error(`The database answered with an error: ${write.detail}`)
  }

  const { problems, changed } = verifyResult(io, options, { uid, plan, state, write })

  if (!write.ok && !changed) {
    throw new ScriptFailure(
      'Failed: the batch was not applied; nothing changed (read back above). Check the reason above and the uid, email and admin rows.',
    )
  }

  if (!write.ok && problems.length === 0) {
    throw new ScriptFailure(
      `wrangler reported an error, but the database now shows the complete change. Check the admin rows above once more. (${plan.done})`,
    )
  }

  if (problems.length > 0) {
    throw new ScriptFailure(
      `Check failed: ${problems.join('; ')}.${changed ? ' The database CHANGED: a remote database can be restored to the bookmark printed first.' : ''}`,
    )
  }

  io.log(plan.done)
}

if (isMainModule(import.meta.url)) {
  await runCli(() => promoteAdmin(process.argv.slice(2), consoleIo()), USAGE)
}
