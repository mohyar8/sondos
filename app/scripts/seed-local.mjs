#!/usr/bin/env node
// Seeds the LOCAL development database with the journey test data of plan 11
// section 6.2 (scripts/dev-seed.sql): one booking per journey stage for the
// tester customer, fake customers, blocked dates, delivery areas and handover
// slots. It never writes settings, bank details, terms or an admin.
//
//   node scripts/seed-local.mjs --customer-uid <uid>
//   node scripts/seed-local.mjs --customer-uid <uid> --persist-to <folder>
//
// Order after a reset: stop the dev server, delete .wrangler/state, run
// `npx wrangler d1 migrations apply DB --local`, then this script. The uid is
// the tester customer's Firebase uid (Firebase console > Authentication >
// Users); she may sign in before or after the seed. --persist-to is passed to
// wrangler as one --persist-to=<folder> token, for a local state folder other
// than .wrangler/state; a value starting with '-' is refused.
//
// Safety model:
// - Local only. Every wrangler call carries --local; --remote, --env and any
//   unknown option are refused before anything runs, and so is a
//   CLOUDFLARE_ENV other than "mediatest" (the never-deployed local media
//   environment). The release runbook checks that production has no
//   _dev_seed_marker table (plan 11 section 7.4).
// - The uid must match ^[A-Za-z0-9]{1,128}$ before it is put into the SQL,
//   where it is a plain string literal; the marker table's CHECK repeats the
//   rule inside the database and refuses an admin's or an erased row's uid.
// - wrangler runs as `node node_modules/wrangler/bin/wrangler.js ...` through
//   spawnSync with an argument array, so no shell parses any argument.
// - The SQL reaches wrangler through a private temporary file that is deleted
//   afterwards. Output is counts only: no names, addresses or phone numbers.
// - One seed per database: the first statement creates _dev_seed_marker and
//   fails when it exists; wrangler then rolls the whole file back.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '..')
const wranglerCli = path.join(appRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const seedTemplatePath = path.join(__dirname, 'dev-seed.sql')

const USAGE = 'Usage: node scripts/seed-local.mjs --customer-uid <firebase-uid> [--persist-to <folder>]'

/** Firebase-generated uids: 1–128 ASCII letters and digits. */
const UID_PATTERN = /^[A-Za-z0-9]{1,128}$/
const UID_PLACEHOLDER = '{{CUSTOMER_UID}}'
/** The only CLOUDFLARE_ENV the seed accepts besides none: a local-only environment. */
const LOCAL_ONLY_ENVIRONMENTS = new Set(['mediatest'])

class UsageError extends Error {}

/**
 * Parses `--customer-uid <uid>` (required) and `--persist-to <folder>`
 * (optional), each at most once, as `--name value` or `--name=value`.
 * Throws UsageError for anything else, naming --remote and --env explicitly.
 */
function parseArguments(argv) {
  const values = new Map()

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/s.exec(argument)

    if (!match) {
      throw new UsageError(`Unexpected argument: ${argument}`)
    }

    const name = match[1]

    if (name === 'remote' || name === 'env' || name === 'preview' || name === 'local') {
      throw new UsageError(
        `--${name} is not accepted: this script only ever seeds the local database (wrangler --local).`,
      )
    }

    if (name !== 'customer-uid' && name !== 'persist-to') {
      throw new UsageError(`Unknown option --${name}.`)
    }

    if (values.has(name)) {
      throw new UsageError(`--${name} was given more than once.`)
    }

    let value = match[2]

    if (value === undefined) {
      value = argv[index + 1]
      index += 1
    }

    // A value that starts with '-' could be read by wrangler as one of its own flags (-e is --env).
    if (value === undefined || value.length === 0 || value.startsWith('-')) {
      throw new UsageError(`--${name} needs a value that does not start with '-'.`)
    }

    values.set(name, value)
  }

  const uid = values.get('customer-uid')

  if (uid === undefined) {
    throw new UsageError('--customer-uid is required.')
  }

  if (!UID_PATTERN.test(uid)) {
    throw new UsageError(
      '--customer-uid must be a Firebase UID: 1 to 128 letters and digits, copied from the Firebase console.',
    )
  }

  const persistTo = values.get('persist-to') ?? null

  if (persistTo !== null && persistTo.includes('\0')) {
    throw new UsageError('--persist-to must be a folder path.')
  }

  return { uid, persistTo }
}

/** The environment wrangler will select locally; refuses anything but none or a local-only one. */
function readLocalEnvironment() {
  const environment = process.env.CLOUDFLARE_ENV ?? ''

  if (environment !== '' && !LOCAL_ONLY_ENVIRONMENTS.has(environment)) {
    throw new UsageError(
      `CLOUDFLARE_ENV="${environment}" is not accepted: unset it (or use "mediatest") to seed a local database.`,
    )
  }

  return environment === '' ? null : environment
}

/** dev-seed.sql with the uid in place of its single placeholder. */
function renderSeedSql(uid) {
  const template = readFileSync(seedTemplatePath, 'utf8')
  const parts = template.split(UID_PLACEHOLDER)

  if (parts.length !== 2) {
    throw new Error(`dev-seed.sql must contain ${UID_PLACEHOLDER} exactly once.`)
  }

  return parts.join(uid)
}

/** Runs wrangler with the given arguments and --local; returns its parsed --json output. */
function runWranglerLocal(commandArguments, { persistTo }) {
  const args = [wranglerCli, 'd1', 'execute', 'DB', '--local', '--json', ...commandArguments]

  if (persistTo !== null) {
    // One token, so no part of the folder name can become a separate wrangler argument.
    args.push(`--persist-to=${persistTo}`)
  }

  const result = spawnSync(process.execPath, args, {
    cwd: appRoot,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })

  if (result.error) {
    throw result.error
  }

  let parsed = null

  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }
  }

  if (result.status !== 0 || !Array.isArray(parsed) || parsed.some((entry) => entry?.success !== true)) {
    return { ok: false, detail: describeWranglerFailure(parsed, result.stderr) }
  }

  return { ok: true, results: parsed }
}

/** SQLite's own message (e.g. a CHECK or "no such table"), never row data. */
function describeWranglerFailure(parsed, stderr) {
  const message =
    typeof parsed?.error?.text === 'string'
      ? parsed.error.text
      : String(stderr ?? '')
          .split(/\r?\n/)
          .find((line) => /error|failed|SQLITE/i.test(line))

  return message ? message.trim().slice(0, 300) : 'wrangler exited with an error.'
}

function firstRow(results) {
  const rows = results[0]?.results

  return Array.isArray(rows) && rows.length === 1 ? rows[0] : null
}

// Rows the seed must never add (settings, terms, switch, audit, admins).
const UNTOUCHED_COUNTS_SQL = `
  (SELECT COUNT(*) FROM settings_revisions) AS settings,
  (SELECT COUNT(*) FROM terms_versions) AS terms,
  (SELECT COUNT(*) FROM ops_switch_revisions) AS switches,
  (SELECT COUNT(*) FROM admin_audit_log) AS audit,
  (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins`

/** Runs the rendered seed from a private temporary file, which is always removed afterwards. */
function runSeedFile(seedSql, options) {
  const workFolder = mkdtempSync(path.join(tmpdir(), 'sundus-seed-'))

  try {
    const sqlFile = path.join(workFolder, 'dev-seed.sql')

    writeFileSync(sqlFile, seedSql, { encoding: 'utf8', mode: 0o600 })

    return runWranglerLocal(['--file', sqlFile], options)
  } finally {
    rmSync(workFolder, { recursive: true, force: true })
  }
}

/** Seeds the local database; returns the process exit code (0 seeded, 1 refused or failed). */
function main() {
  const { uid, persistTo } = parseArguments(process.argv.slice(2))
  const environment = readLocalEnvironment()
  const seedSql = renderSeedSql(uid)
  const options = { persistTo }

  console.log(
    `Target: local database of the ${environment === null ? 'default' : environment} environment` +
      `${persistTo === null ? '' : ` (state folder ${persistTo})`}.`,
  )

  // Uses only sqlite_master and tables that exist after 0001, so it also answers on a database that was
  // never migrated past 0001.
  const precheck = runWranglerLocal(
    [
      '--command',
      `SELECT
        (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_dev_seed_marker') AS seeded,
        (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('settings_revisions', 'ops_switch_revisions', 'csp_report_counts')) AS golive_tables,
        (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'users' AND sql LIKE '%contact_changed_at%') AS has_0009,
        (SELECT COUNT(*) FROM users WHERE id = '${uid}' AND role <> 'customer') AS uid_is_admin,
        (SELECT COUNT(*) FROM users WHERE id = '${uid}' AND erased_at IS NOT NULL) AS uid_is_erased`,
    ],
    options,
  )
  const state = precheck.ok ? firstRow(precheck.results) : null

  if (state === null) {
    console.error(`Refused: could not read the local database (${precheck.ok ? 'unexpected answer' : precheck.detail}).`)
    console.error('Apply the migrations first: npx wrangler d1 migrations apply DB --local')
    return 1
  }

  if (state.seeded !== 0) {
    console.error('Refused: this local database was already seeded (_dev_seed_marker exists).')
    console.error('To seed again: stop the dev server, delete the local state folder, migrate, then run this script.')
    return 1
  }

  if (state.golive_tables !== 3 || state.has_0009 !== 1) {
    console.error('Refused: migrations 0008 and 0009 are not applied. Run: npx wrangler d1 migrations apply DB --local')
    return 1
  }

  if (state.uid_is_admin !== 0 || state.uid_is_erased !== 0) {
    console.error('Refused: this uid belongs to an admin or an erased row. Use the tester CUSTOMER account.')
    return 1
  }

  const before = runWranglerLocal(['--command', `SELECT ${UNTOUCHED_COUNTS_SQL}`], options)
  const untouchedBefore = before.ok ? firstRow(before.results) : null

  if (untouchedBefore === null) {
    console.error(`Refused: could not read the current counts (${before.ok ? 'unexpected answer' : before.detail}).`)
    return 1
  }

  const seed = runSeedFile(seedSql, options)

  if (!seed.ok) {
    console.error(`The seed failed and wrangler rolled it back: ${seed.detail}`)
    return 1
  }

  const after = runWranglerLocal(
    [
      '--command',
      `SELECT
        (SELECT COUNT(*) FROM _dev_seed_marker WHERE customer_uid = '${uid}') AS markers,
        (SELECT COUNT(*) FROM sqlite_master WHERE name = '_dev_seed_plan') AS leftover_plan,
        (SELECT COUNT(*) FROM booking_requests WHERE user_id = '${uid}' AND id GLOB '5eedb00c-*') AS tester_bookings,
        (SELECT COUNT(*) FROM users WHERE id GLOB 'seed-customer-*') AS fake_customers,
        (SELECT COUNT(*) FROM booking_requests WHERE user_id GLOB 'seed-customer-*') AS fake_bookings,
        (SELECT COUNT(*) FROM handover_slots WHERE id GLOB '5eed5107-*') AS slots,
        (SELECT COUNT(*) FROM delivery_areas WHERE id GLOB '5eedaea0-*') AS delivery_areas,
        ${UNTOUCHED_COUNTS_SQL}`,
    ],
    options,
  )
  const counts = after.ok ? firstRow(after.results) : null

  if (counts === null) {
    console.error(`Could not read the result (${after.ok ? 'unexpected answer' : after.detail}).`)
    return 1
  }

  const untouchedKeys = ['settings', 'terms', 'switches', 'audit', 'admins']
  const failures = [
    counts.markers === 1 ? null : 'marker row',
    counts.leftover_plan === 0 ? null : 'plan table left behind',
    counts.tester_bookings === 27 ? null : 'tester bookings',
    counts.fake_customers === 6 ? null : 'fake customers',
    counts.fake_bookings === 9 ? null : 'fake bookings',
    counts.slots === 11 ? null : 'handover slots',
    counts.delivery_areas === 2 ? null : 'delivery areas',
    ...untouchedKeys.map((key) => (counts[key] === untouchedBefore[key] ? null : `${key} changed`)),
  ].filter((failure) => failure !== null)

  console.log(
    `Seeded: ${counts.tester_bookings} bookings for the tester, ${counts.fake_customers} fake customers with ` +
      `${counts.fake_bookings} bookings, ${counts.slots} handover slots, ${counts.delivery_areas} delivery areas. ` +
      'No settings, terms, switch, audit or admin rows were written.',
  )

  if (failures.length > 0) {
    console.error(`Check failed: ${failures.join(', ')}.`)
    return 1
  }

  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  if (!(error instanceof UsageError)) {
    throw error
  }

  console.error(`${error.message}\n\n${USAGE}`)
  process.exitCode = 2
}
