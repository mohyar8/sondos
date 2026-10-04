#!/usr/bin/env node
// Incident step for a CUSTOMER account (audit SEC-11; plan 11 TM-07): makes
// the Worker refuse every Firebase ID token of ONE customer whose sign-in
// happened before now, by stamping users.tokens_valid_after (migration 0007)
// on that uid's row. The Worker compares the token's auth_time, which a
// refreshed token keeps, so tokens that a stolen refresh token mints later
// are refused as well. The role never changes here.
//
//   node scripts/revoke-sessions.mjs --database sundus-yar-production --uid <uid> --remote
//   node scripts/revoke-sessions.mjs --database sundus-yar-preview --uid <uid> --remote --env preview
//   node scripts/revoke-sessions.mjs --database sundus-yar-production --uid <uid> --local [--persist-to <folder>]
//
// The admin row is refused (R-03): scripts/promote-admin.mjs is the one
// script that touches it and writes its audit rows. For the admin, re-run
// promote-admin.mjs for her own uid (it stamps tokens_valid_after the same
// way and writes admin_promoted), or --replace to a clean account. The
// UPDATE is bound to role = 'customer', so a promotion that lands between
// the read and the write leaves the row untouched and the run fails.
//
// Same safety model as promote-admin.mjs (lib/wrangler-d1.mjs): explicit
// database and --local/--remote, the Time Travel bookmark command first for
// --remote, the account (uid, stored email, role) and the exact SQL shown
// before the typed confirmation, one batch, the result read back. A
// customer's revocation is not an admin action, so no audit row is written.
//
// In one incident, in this order:
// 1. Invalidate in D1: this script. The mark comes from D1's clock
//    (unixepoch()), not this computer's, and never moves an existing mark
//    back.
// 2. In Firebase: disable the user, or reset the password and revoke the
//    refresh tokens (console, or the Admin SDK's revokeRefreshTokens), so
//    nobody can sign in again with the old password.
// 3. Run this script again after step 2: a sign-in with the old password
//    between steps 1 and 2 is newer than the first mark and would pass.
// 4. The account holder signs in again with the new password.

import {
  STAMP_SESSIONS_SQL,
  ScriptFailure,
  UsageError,
  consoleIo,
  describeUnixSeconds,
  isMainModule,
  parseArguments,
  printSql,
  printTarget,
  printable,
  readRows,
  readSchema,
  requireUid,
  rowsOf,
  runCli,
  sqlText,
} from './lib/wrangler-d1.mjs'

export const USAGE = [
  'Usage: node scripts/revoke-sessions.mjs --database <name> --uid <firebase-uid>',
  '         (--local [--persist-to <folder>] | --remote) [--env preview|mediatest]',
  'For the admin account use scripts/promote-admin.mjs (re-run for her uid, or --replace).',
].join('\n')

export async function revokeSessions(argv, io) {
  const options = parseArguments(argv, { valueFlags: ['uid'], booleanFlags: [] })

  if (!options.values.has('uid')) {
    throw new UsageError('--uid is required: the Firebase UID of the account, from the Firebase console.')
  }

  const uid = requireUid(options.values.get('uid'))

  printTarget(io, options)
  // Only the users columns of migration 0007 are needed; no audit row is
  // written. The audit log decides what the admin refusal points to.
  const { auditLog } = readSchema(io, options)

  const results = readRows(io, options, [
    `SELECT id, email, role, erased_at IS NOT NULL AS erased, tokens_valid_after FROM users WHERE id = ${sqlText(uid)}`,
    'SELECT unixepoch() AS now',
  ])
  const accounts = rowsOf(results, 0)
  const now = rowsOf(results, 1)[0]?.now

  if (accounts.length !== 1) {
    throw new ScriptFailure('Refused: no users row has this uid. Check the uid in the Firebase console. Nothing was changed.')
  }

  const [account] = accounts

  if (account.role === 'admin') {
    throw new ScriptFailure(
      [
        'Refused: this uid is the admin. Only scripts/promote-admin.mjs changes the admin row and writes its audit rows. Nothing was changed.',
        ...(auditLog
          ? [
              'To end every session of the admin, re-run it for her own uid (it keeps the role and stamps tokens_valid_after):',
              `  node scripts/promote-admin.mjs ${promoteArguments(options, uid)}`,
              'or move the role to a clean account with --replace (plan 11 section 7.11).',
            ]
          : [
              // promote-admin.mjs refuses an unaudited promotion (L2), so
              // before 0008/0009 its only admin change is --demote.
              'This database has no admin audit log yet (migrations 0008/0009), so its one admin change is --demote,',
              'which ends every session of the admin and removes the role (unaudited):',
              `  node scripts/promote-admin.mjs ${promoteArguments(options, uid)} --demote`,
            ]),
      ].join('\n'),
    )
  }

  if (account.role !== 'customer' || !Number.isSafeInteger(now)) {
    throw new ScriptFailure('Refused: unexpected answer from the database. Nothing was changed.')
  }

  const write = [
    [
      `UPDATE users SET ${STAMP_SESSIONS_SQL}, updated_at = CURRENT_TIMESTAMP`,
      `WHERE id = ${sqlText(uid)} AND role = 'customer'`,
    ].join('\n'),
    'SELECT changes() AS changed',
  ]

  io.log('')
  io.log(`Account:           uid ${printable(account.id)}`)
  io.log(`  stored email:    ${printable(account.email)}`)
  io.log(`  role:            ${account.role}${account.erased === 0 ? '' : ' (erased)'}`)
  io.log(`  sign-ins valid after: ${describeUnixSeconds(account.tokens_valid_after)}`)
  io.log('Change: refuse every sign-in of this account before now (D1 clock). No audit row: this is not an admin action.')
  printSql(io, 'write, one batch', write)

  if (!(await io.confirm(`revoke ${options.database}`))) {
    throw new ScriptFailure('Cancelled: the confirmation did not match. Nothing was changed.')
  }

  const answer = io.execute(write, options)

  if (!answer.ok) {
    io.error(`The database answered with an error: ${answer.detail}`)
  }

  // Read back even after an error: a timed-out wrangler may still have written.
  const after = readRows(io, options, [`SELECT role, tokens_valid_after FROM users WHERE id = ${sqlText(uid)}`], {
    afterWrite: true,
  })
  const row = rowsOf(after, 0)[0]
  const validAfter = row?.tokens_valid_after
  const problems = []

  if (!Number.isSafeInteger(validAfter) || validAfter < now) {
    problems.push('tokens_valid_after was not stamped')
  }

  if (row?.role !== 'customer') {
    problems.push('the role changed during the run')
  }

  if (answer.ok && rowsOf(answer.results, 1)[0]?.changed !== 1) {
    problems.push('the UPDATE did not change exactly one row')
  }

  if (!answer.ok) {
    throw new ScriptFailure(
      problems.length === 0
        ? 'wrangler reported an error, but the database shows the new mark. Check the row once more by hand.'
        : `Failed: ${problems.join('; ')}. Check the uid and run it again.`,
    )
  }

  if (problems.length > 0) {
    throw new ScriptFailure(`Check failed: ${problems.join('; ')}.`)
  }

  io.log(`Sign-ins before ${describeUnixSeconds(validAfter)} (D1 clock) are now refused for this uid.`)
  io.log('If the password was not reset and the refresh tokens not revoked in Firebase BEFORE this run, do it now and run this script again.')
  io.log('Then the account holder signs in again with the new password.')
}

/**
 * The promote-admin.mjs arguments for the same target. Placeholders stand
 * for the stored email and the folder, so no database value or path is
 * printed into a line the operator may paste into a shell.
 */
function promoteArguments({ database, target, environment, persistTo }, uid) {
  return [
    `--database ${database}`,
    `--uid ${uid}`,
    '--email <her stored email>',
    target,
    ...(environment === null ? [] : [`--env ${environment}`]),
    ...(persistTo === null ? [] : ['--persist-to <the same folder>']),
  ].join(' ')
}

if (isMainModule(import.meta.url)) {
  await runCli(() => revokeSessions(process.argv.slice(2), consoleIo()), USAGE)
}
