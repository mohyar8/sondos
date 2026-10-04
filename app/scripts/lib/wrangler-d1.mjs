// Shared helpers for the operator scripts that change a users row in D1
// (scripts/promote-admin.mjs, scripts/revoke-sessions.mjs).
//
// Only promote-admin.mjs touches the admin row, and it writes only the two
// audit actions that shared/audit.ts reserves for it (admin_promoted,
// admin_demoted; adminAuditScriptActions). admin_sessions_revoked belongs to
// the Worker's re-authenticated «تسجيل الخروج من كل الأجهزة» (reauth_at
// required), so no script writes it and an operator's run can never be read
// as the admin's own in-app action.
//
// Safety model (plan 11 W1-12 / R-03; audit SEC-01, SEC-11):
// - The target is always explicit: --database <name> and exactly one of
//   --local or --remote; nothing defaults to a database or to remote. --env
//   accepts "preview" (local or remote) or "mediatest" (local only), and a
//   CLOUDFLARE_ENV that disagrees with --env stops the script, so only --env
//   selects the wrangler environment. --database must be a database_name
//   that the selected environment declares in wrangler.jsonc: a binding such
//   as DB, or another environment's database, is refused, so the name the
//   operator types in the confirmation is the database that changes. wrangler
//   is pointed at that same wrangler.jsonc (--config). Every flag is known,
//   given at most once and carries its value; a value may not start with
//   '-', so it can never become a wrangler flag.
// - uid and email are validated against strict patterns that admit no quote,
//   backslash, semicolon or whitespace before they are put into SQL, and
//   sqlText() still doubles quotes: wrangler d1 execute has no bound
//   parameters, so these literals are the only templated values (SB-4).
// - wrangler runs as `node node_modules/wrangler/bin/wrangler.js ...` through
//   spawnSync with an argument array: no shell parses any argument, and its
//   stdin is closed, so it can never read the operator's confirmation.
// - Every SQL text is printed before it is sent. For --remote, the Time
//   Travel bookmark command is printed before anything else, and a write runs
//   only after the operator types the confirmation phrase.
// - Values read from the database are printed through printable(), so a
//   stored control, escape or bidi character cannot rewrite the terminal.

import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const appRoot = path.resolve(__dirname, '..', '..')
const wranglerCli = path.join(appRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const wranglerConfig = path.join(appRoot, 'wrangler.jsonc')
/** Generous for a few small statements; a hung wrangler is reported, not waited on forever. */
const WRANGLER_TIMEOUT_MS = 120_000

/** Firebase-generated uids: 1–128 ASCII letters and digits. */
const UID_PATTERN = /^[A-Za-z0-9]{1,128}$/
/** A plain address: no quotes, spaces, backslashes or semicolons can pass. */
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/
const MAXIMUM_EMAIL_LENGTH = 254
/** A D1 database name as wrangler.jsonc declares it. */
const DATABASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** wrangler environments: "preview" is deployed, "mediatest" never is. */
const ENVIRONMENTS = new Set(['preview', 'mediatest'])
const LOCAL_ONLY_ENVIRONMENTS = new Set(['mediatest'])

/** A refusal or failure whose message is meant for the operator; exit code 1. */
export class ScriptFailure extends Error {
  exitCode = 1
}

/** A command line that cannot run; printed with the usage text, exit code 2. */
export class UsageError extends ScriptFailure {
  exitCode = 2
}

/**
 * `value` as terminal-safe text: control characters (C0, DEL, C1, line and
 * paragraph separators) and format characters (bidi overrides, zero-width
 * marks) are shown as \u{…} instead of acting on the terminal.
 */
export function printable(value) {
  return String(value).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0).toString(16)}}`,
  )
}

/**
 * The database_name values that wrangler.jsonc declares for `environment`
 * (null: the top level, i.e. production). An environment does not inherit
 * d1_databases, so only its own list counts. The file is read with
 * TypeScript's JSONC parser (comments, trailing commas), a dependency the
 * repository already has.
 */
export function declaredDatabases(environment) {
  const parsed = ts.parseConfigFileTextToJson(wranglerConfig, readFileSync(wranglerConfig, 'utf8'))

  if (parsed.error !== undefined) {
    throw new ScriptFailure('Refused: wrangler.jsonc could not be parsed. Nothing was changed.')
  }

  const scope = environment === null ? parsed.config : parsed.config?.env?.[environment]
  const databases = scope?.d1_databases

  return Array.isArray(databases)
    ? databases.map((entry) => entry?.database_name).filter((name) => typeof name === 'string')
    : []
}

/**
 * The exact --database (and --env) to pass, read from wrangler.jsonc, for a
 * command line that left it out, e.g. one copied from an older runbook: the
 * chosen environment's names, or production's and the preview Worker's when
 * no --env was given.
 */
function databaseChoices(environment) {
  const choices = (names, suffix) =>
    names.length === 0
      ? 'none declared'
      : names.map((name) => `--database ${printable(name)}${suffix}`).join(' or ')

  return environment === null
    ? `Production: ${choices(declaredDatabases(null), '')}. The preview Worker: ${choices(declaredDatabases('preview'), ' --env preview')}.`
    : `The "${environment}" environment: ${choices(declaredDatabases(environment), ` --env ${environment}`)}.`
}

/**
 * Parses `--name value`, `--name=value` and `--flag` arguments. Besides the
 * script's own `valueFlags` and `booleanFlags`, every script takes
 * --database (required), --local/--remote (exactly one), --env and
 * --persist-to (with --local only). Throws UsageError on an unknown,
 * repeated or value-less flag, on any positional argument, or on a target
 * that is missing, doubled, inconsistent or not declared in wrangler.jsonc.
 */
export function parseArguments(argv, { valueFlags, booleanFlags }) {
  const values = new Map()
  const flags = new Set()
  const allowedValueFlags = new Set([...valueFlags, 'database', 'env', 'persist-to'])
  const allowedBooleanFlags = new Set([...booleanFlags, 'local', 'remote'])

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(argument)

    if (!match) {
      throw new UsageError(`Unexpected argument: ${printable(argument)}`)
    }

    const name = match[1]

    if (values.has(name) || flags.has(name)) {
      throw new UsageError(`--${name} was given more than once.`)
    }

    if (allowedBooleanFlags.has(name)) {
      if (match[2] !== undefined) {
        throw new UsageError(`--${name} takes no value.`)
      }

      flags.add(name)
      continue
    }

    if (!allowedValueFlags.has(name)) {
      throw new UsageError(`Unknown option --${name}.`)
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

  if (flags.has('local') === flags.has('remote')) {
    throw new UsageError('Choose the database explicitly: exactly one of --local or --remote.')
  }

  const target = flags.has('local') ? '--local' : '--remote'
  const environment = values.get('env') ?? null

  if (environment !== null && !ENVIRONMENTS.has(environment)) {
    throw new UsageError('--env accepts only "preview" or "mediatest" (omit it for production).')
  }

  if (environment !== null && LOCAL_ONLY_ENVIRONMENTS.has(environment) && target !== '--local') {
    throw new UsageError(`--env ${environment} is a local-only environment: use it with --local.`)
  }

  const database = values.get('database')

  if (database === undefined || !DATABASE_PATTERN.test(database)) {
    throw new UsageError(
      `${database === undefined ? '--database is required' : '--database must be a database_name'}: ` +
        `the D1 database_name from wrangler.jsonc, never a binding. ${databaseChoices(environment)}`,
    )
  }

  const inheritedEnvironment = process.env.CLOUDFLARE_ENV ?? ''

  if (inheritedEnvironment !== '' && inheritedEnvironment !== environment) {
    throw new UsageError(
      `CLOUDFLARE_ENV="${printable(inheritedEnvironment)}" disagrees with --env: unset it, or pass the same environment with --env.`,
    )
  }

  const persistTo = values.get('persist-to') ?? null

  if (persistTo !== null && target !== '--local') {
    throw new UsageError('--persist-to names a local state folder: use it with --local only.')
  }

  if (persistTo !== null && persistTo.includes('\0')) {
    throw new UsageError('--persist-to must be a folder path.')
  }

  const declared = declaredDatabases(environment)

  if (!declared.includes(database)) {
    throw new UsageError(
      `--database ${database} is not a D1 database of the ${environment === null ? 'top-level (production)' : `"${environment}"`} ` +
        `environment in wrangler.jsonc (it declares: ${declared.length === 0 ? 'none' : declared.join(', ')}). ` +
        'Give the database_name that matches --env, not a binding.',
    )
  }

  return {
    values,
    flags,
    database,
    target,
    environment,
    persistTo: persistTo === null ? null : path.resolve(persistTo),
  }
}

export function isPlainUid(value) {
  return typeof value === 'string' && UID_PATTERN.test(value)
}

export function requireUid(value) {
  if (!isPlainUid(value)) {
    throw new UsageError('--uid must be the Firebase UID (1 to 128 letters and digits), copied from the Firebase console.')
  }

  return value
}

export function requireEmail(value) {
  if (
    typeof value !== 'string' ||
    value.length > MAXIMUM_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(value)
  ) {
    throw new UsageError('--email must be one plain email address.')
  }

  return value
}

/** A SQL string literal for a value that already passed requireUid/requireEmail/isPlainUid. */
export function sqlText(value) {
  return `'${value.replaceAll("'", "''")}'`
}

/** The database the command will change, as the operator should read it. */
export function describeTarget({ database, target, environment, persistTo }) {
  const where =
    target === '--remote'
      ? 'REMOTE (Cloudflare)'
      : `local copy${persistTo === null ? '' : ` in ${printable(persistTo)}`}`

  return `${database}, ${where}${environment === null ? '' : `, wrangler env "${environment}"`}`
}

function environmentSuffix({ environment }) {
  return environment === null ? '' : ` --env ${environment}`
}

/**
 * Prints the target. For --remote the Time Travel bookmark command comes
 * first (plan 11 section 7.4: a bookmark before every remote write).
 */
export function printTarget(io, options) {
  if (options.target === '--remote') {
    io.log('Remote database. Before any change, record a Time Travel bookmark (the restore point) in the release log:')
    io.log(`  npx wrangler d1 time-travel info ${options.database}${environmentSuffix(options)}`)
    io.log(
      `Last resort, reverts EVERY write after it: npx wrangler d1 time-travel restore ${options.database} --bookmark=<bookmark>${environmentSuffix(options)}`,
    )
    io.log('')
  }

  io.log(`Target: ${describeTarget(options)}`)
}

/** The exact text handed to `wrangler d1 execute --command`. */
export function toCommand(statements) {
  return `${statements.map((statement) => statement.trim()).join(';\n')};`
}

/** Prints the exact SQL text before it runs. */
export function printSql(io, label, statements) {
  io.log(`SQL (${label}):`)

  for (const line of toCommand(statements).split('\n')) {
    io.log(`  ${line}`)
  }
}

/**
 * The argument array for `node wrangler.js d1 execute`; never passed through
 * a shell. Every value is one `--name=value` token, so no part of it can
 * become a separate wrangler argument.
 */
export function wranglerArguments(statements, { database, target, environment, persistTo }) {
  const args = [
    wranglerCli,
    'd1',
    'execute',
    database,
    target,
    '--json',
    `--config=${wranglerConfig}`,
    `--command=${toCommand(statements)}`,
  ]

  if (environment !== null) {
    args.push(`--env=${environment}`)
  }

  if (persistTo !== null) {
    args.push(`--persist-to=${persistTo}`)
  }

  return args
}

/** SQLite's own message (e.g. a constraint or "no such table"), never row data. */
function describeWranglerFailure(parsed, stderr) {
  const message =
    typeof parsed?.error?.text === 'string'
      ? parsed.error.text
      : String(stderr ?? '')
          .split(/\r?\n/)
          .find((line) => /error|failed|SQLITE/i.test(line))

  return message ? printable(message.trim().slice(0, 300)) : 'wrangler exited with an error.'
}

/**
 * Runs the statements as one `wrangler d1 execute --command`. D1 runs the
 * statements of one command as one batch (locally Miniflare's db.batch(),
 * remotely the /query endpoint), which is rolled back as a whole when a
 * statement fails; the scripts still read the database back afterwards and
 * report any difference. Returns { ok: true, results } with one entry per
 * statement, or { ok: false, detail } when wrangler fails, does not finish or
 * answers with something unexpected.
 */
export function executeWrangler(statements, options) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== 'CLOUDFLARE_ENV'),
  )
  const result = spawnSync(process.execPath, wranglerArguments(statements, options), {
    cwd: appRoot,
    env: { ...environment, WRANGLER_SEND_METRICS: 'false' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
    timeout: WRANGLER_TIMEOUT_MS,
    windowsHide: true,
  })

  // A start failure, the timeout or an overfull buffer. wrangler may still
  // have written, so the caller reads the database back.
  if (result.error !== undefined) {
    const reason = 'code' in result.error && typeof result.error.code === 'string' ? result.error.code : result.error.name

    return { ok: false, detail: `wrangler did not finish (${printable(reason)}).` }
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

/** The command that applies the repository's migrations to the chosen database. */
export function migrationsCommand(options) {
  return `npx wrangler d1 migrations apply ${options.database} ${options.target}${environmentSuffix(options)}`
}

/**
 * Prints and runs read-only statements. Before the write, a failure stops
 * the script with nothing changed; after it, the operator must check by hand.
 */
export function readRows(io, options, statements, { afterWrite = false } = {}) {
  printSql(io, 'read', statements)

  const answer = io.execute(statements, options)

  if (!answer.ok) {
    throw new ScriptFailure(
      afterWrite
        ? `Could not read the database after the write (${answer.detail}). Check the users row and admin_audit_log by hand.`
        : `Refused: could not read the database (${answer.detail}). Nothing was changed.\n` +
            `If it names a missing table or column, apply the migrations first: ${migrationsCommand(options)}`,
    )
  }

  return answer.results
}

/** The rows of the n-th statement of an execute result. */
export function rowsOf(results, index) {
  const rows = results[index]?.results

  return Array.isArray(rows) ? rows : []
}

/**
 * Which schema the database has: migration 0007's users columns are
 * required; the admin audit log (0008) with the admin_* actions (0009) is
 * reported so that a script can require it or run unaudited only where the
 * plan allows it. Reads sqlite_master only, so it answers on any version.
 */
export function readSchema(io, options) {
  const [row] = rowsOf(
    readRows(io, options, [
      [
        'SELECT',
        "  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'users' AND sql LIKE '%email_verified_at%' AND sql LIKE '%tokens_valid_after%' AND sql LIKE '%erased_at%') AS user_columns,",
        "  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('admin_audit_log', 'admin_audit_actions')) AS audit_tables",
      ].join('\n'),
    ]),
    0,
  )

  if (row?.user_columns !== 1) {
    throw new ScriptFailure(
      `Refused: users has no email_verified_at, tokens_valid_after or erased_at column (migrations 0005 and 0007). Nothing was changed.\nApply the migrations first: ${migrationsCommand(options)}`,
    )
  }

  if (row.audit_tables !== 0 && row.audit_tables !== 2) {
    throw new ScriptFailure('Refused: the admin audit tables are only partly present. Nothing was changed; check the migrations.')
  }

  return { auditLog: row.audit_tables === 2 }
}

/**
 * The admin_audit_log actions promote-admin.mjs writes (migration 0009):
 * exactly shared/audit.ts adminAuditScriptActions, which the Worker never
 * writes (tests/promote-admin.test.mjs compares the two). Their rows carry
 * reauth_at NULL: an operator run has no Firebase sign-in to record.
 */
export const SCRIPT_AUDIT_ACTIONS = Object.freeze(['admin_promoted', 'admin_demoted'])
const SCRIPT_AUDIT_ACTIONS_SQL = SCRIPT_AUDIT_ACTIONS.map(sqlText).join(', ')

/** Reads the last audit id before the write and whether 0009's actions exist. */
export const AUDIT_BASELINE_SQL = [
  'SELECT COALESCE(MAX(id), 0) AS last_id,',
  `  (SELECT COUNT(*) FROM admin_audit_actions WHERE action IN (${SCRIPT_AUDIT_ACTIONS_SQL})) AS actions`,
  'FROM admin_audit_log',
].join('\n')

/** The last audit id from an AUDIT_BASELINE_SQL row; refuses a database without migration 0009. */
export function auditBaseline(row, options) {
  if (row?.actions !== SCRIPT_AUDIT_ACTIONS.length) {
    throw new ScriptFailure(
      `Refused: admin_audit_actions lacks ${SCRIPT_AUDIT_ACTIONS.join(', ')} (migration 0009). Nothing was changed.\nApply the migrations first: ${migrationsCommand(options)}`,
    )
  }

  if (!Number.isSafeInteger(row.last_id) || row.last_id < 0) {
    throw new ScriptFailure('Refused: unexpected answer for the last audit id. Nothing was changed.')
  }

  return row.last_id
}

/**
 * The revocation mark (migration 0007) from D1's clock: every sign-in
 * before it is refused (worker/users.ts). It never moves an existing mark back.
 */
export const STAMP_SESSIONS_SQL = 'tokens_valid_after = MAX(COALESCE(tokens_valid_after, 0), unixepoch())'

/** admin_audit_log.target_id holds 1 to 64 characters (migration 0008). */
const AUDIT_TARGET_MAXIMUM = 64

/**
 * The admin_audit_log row (L2, SB-10) for the UPDATE right before it in the
 * same batch. created_at stays NULL unless that UPDATE changed exactly one
 * row: the NOT NULL then fails this statement and the batch with it, so a
 * change and its audit row are written together or not at all (the Worker's
 * auditAfterWrite skips the row instead; a script must fail loudly). There
 * is no signed-in actor, so the actor is the account the script promotes,
 * and reauth_at stays NULL. The target is the uid whose role the UPDATE
 * set: target_id, or details {"targetUid"} for a uid longer than target_id
 * allows (64 characters, migration 0008).
 */
export function auditStatement({ actorUid, action, targetUid }) {
  if (!SCRIPT_AUDIT_ACTIONS.includes(action)) {
    throw new Error(`Only ${SCRIPT_AUDIT_ACTIONS.join(' and ')} are written by a script, not ${action}.`)
  }

  if (!isPlainUid(actorUid) || !isPlainUid(targetUid)) {
    throw new Error('An audit row names a plain Firebase uid as actor and target.')
  }

  const fitsTarget = targetUid.length <= AUDIT_TARGET_MAXIMUM
  const target = fitsTarget ? sqlText(targetUid) : 'NULL'
  const details = fitsTarget ? 'NULL' : `json_object('targetUid', ${sqlText(targetUid)})`

  return [
    'INSERT INTO admin_audit_log (actor_uid, action, target_id, details, reauth_at, created_at)',
    `VALUES (${sqlText(actorUid)}, ${sqlText(action)}, ${target}, ${details}, NULL,`,
    "  CASE WHEN changes() = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END)",
  ].join('\n')
}

/** The script's audit rows written after `lastId` by `actorUid`, oldest first. */
export function auditRowsSinceStatement(lastId, actorUid) {
  if (!Number.isSafeInteger(lastId) || lastId < 0) {
    throw new Error('lastId must be a non-negative integer.')
  }

  return [
    'SELECT id, action, target_id, details FROM admin_audit_log',
    `WHERE id > ${lastId} AND actor_uid = ${sqlText(actorUid)} AND action IN (${SCRIPT_AUDIT_ACTIONS_SQL})`,
    'ORDER BY id',
  ].join('\n')
}

/** The uid a script audit row names: target_id, or details.targetUid for a long uid; null if neither. */
function auditTargetUid(row) {
  if (row.target_id !== null) {
    return row.target_id
  }

  if (row.details === null) {
    return null
  }

  try {
    return JSON.parse(row.details)?.targetUid ?? null
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

/** True when `rows` are exactly the `expected` [{ action, targetUid }], in order. */
export function auditRowsMatch(rows, expected) {
  return (
    rows.length === expected.length &&
    rows.every((row, index) => row.action === expected[index].action && auditTargetUid(row) === expected[index].targetUid)
  )
}

/** Unix seconds from D1 as an ISO instant, for the operator's eyes. */
export function describeUnixSeconds(value) {
  return Number.isSafeInteger(value) ? new Date(value * 1000).toISOString() : 'never'
}

/**
 * Asks the operator to type `phrase` on stdin. Resolves true only for that
 * exact line; anything else, end of input or Ctrl+C resolves false.
 */
export function askConfirmation(phrase) {
  return new Promise((resolve) => {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
    let answered = false

    prompt.on('SIGINT', () => {
      prompt.close()
    })
    prompt.on('close', () => {
      if (!answered) {
        answered = true
        resolve(false)
      }
    })
    prompt.question(`Type "${phrase}" to run it, anything else cancels: `, (answer) => {
      answered = true
      prompt.close()
      resolve(answer.trim() === phrase)
    })
  })
}

/** The real input/output: wrangler, the terminal and the console. */
export function consoleIo() {
  return {
    execute: executeWrangler,
    confirm: askConfirmation,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  }
}

/** True when the module at `moduleUrl` is the script node was started with. */
export function isMainModule(moduleUrl) {
  const entry = process.argv[1]

  return entry !== undefined && pathToFileURL(realpathSync(entry)).href === moduleUrl
}

/**
 * Runs `main`, turning a UsageError into the usage text and exit code 2 and
 * another ScriptFailure into its message and exit code 1. Anything else is
 * a bug and is rethrown.
 */
export async function runCli(main, usage) {
  try {
    await main()
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n\n${usage}`)
      process.exitCode = error.exitCode
      return
    }

    if (error instanceof ScriptFailure) {
      console.error(error.message)
      process.exitCode = error.exitCode
      return
    }

    throw error
  }
}
