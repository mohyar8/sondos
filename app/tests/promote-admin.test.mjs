// W1-12 / TM-02 (N-31), TM-07, L2, SB-4, SB-10: scripts/promote-admin.mjs,
// scripts/revoke-sessions.mjs and their helper scripts/lib/wrangler-d1.mjs.
// The scripts run against a database built from the repository's own
// migrations (node:sqlite, foreign keys on, as in D1) through a stand-in for
// `wrangler d1 execute`: it takes the --command token out of the exact
// argument array the script would spawn, splits it into statements as
// wrangler does and runs them as one batch that rolls back on the first
// failure. wrangler itself never runs, so nothing leaves this machine. Each
// case fails if its control is taken out: the uid-and-email match, the
// verified/erased conditions, the single-admin rule, the audit row that
// only a one-row change can write, the typed confirmation, the read-back,
// the Time Travel bookmark line and the strict argument parser. The audit
// rows the scripts write are pinned to shared/audit.ts: only the two
// script-only actions, never the Worker's admin_sessions_revoked, and
// revoke-sessions.mjs never touches the admin row (R-03).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, test } from 'node:test'

import {
  SCRIPT_AUDIT_ACTIONS,
  ScriptFailure,
  UsageError,
  auditStatement,
  parseArguments,
  printable,
  toCommand,
  wranglerArguments,
} from '../scripts/lib/wrangler-d1.mjs'
import { promoteAdmin } from '../scripts/promote-admin.mjs'
import { revokeSessions } from '../scripts/revoke-sessions.mjs'
import { adminAuditActions, adminAuditScriptActions } from '../shared/audit.ts'

const MIGRATIONS = new URL('../migrations/', import.meta.url)
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/
const DATABASE = 'sundus-yar-production'
const LOCAL = ['--database', DATABASE, '--local']

const OWNER = 'OwnerUid0001'
const OWNER_EMAIL = 'owner@example.test'
const OTHER = 'OtherUid0002'
const OTHER_EMAIL = 'other@example.test'
const VERIFIED_AT = '2026-09-01T10:00:00.000Z'
const ERASED_AT = '2026-09-02T10:00:00.000Z'
const EARLIER = 1_700_000_000

/** A database with the migrations up to and including `lastPrefix` (all by default). */
function openMigrated(lastPrefix = '9999') {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')

  for (const name of readdirSync(MIGRATIONS).filter((file) => MIGRATION_FILE.test(file)).sort()) {
    if (name.slice(0, 4) <= lastPrefix) {
      db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'))
    }
  }

  return db
}

function addUser(db, { id, email, role = 'customer', verified = true, erased = false, validAfter = EARLIER }) {
  db.prepare(
    `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at, erased_at, tokens_valid_after)
     VALUES (?, ?, 'اسم', 'تجريبي', '+966500000001', ?, ?, ?, ?)`,
  ).run(id, email, role, verified ? VERIFIED_AT : null, erased ? ERASED_AT : null, BigInt(validAfter))
}

function user(db, id) {
  const row = db.prepare('SELECT role, email, tokens_valid_after FROM users WHERE id = ?').get(id)

  return row === undefined ? null : { ...row }
}

function admins(db) {
  return db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id").all().map((row) => row.id)
}

function auditRows(db) {
  return db
    .prepare('SELECT actor_uid, action, target_id, details, reauth_at, created_at FROM admin_audit_log ORDER BY id')
    .all()
    .map((row) => ({ ...row }))
}

function hasAuditLog(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'admin_audit_log'").get().n === 1
}

/** Splits a --command text at the semicolons outside string literals, as wrangler's splitSqlQuery does. */
function splitStatements(text) {
  const statements = []
  let current = ''
  let quoted = false

  for (const character of text) {
    if (character === "'") {
      quoted = !quoted
    }

    if (character === ';' && !quoted) {
      statements.push(current.trim())
      current = ''
    } else {
      current += character
    }
  }

  assert.equal(quoted, false, 'every string literal is closed')
  assert.equal(current.trim(), '', 'the command ends with a semicolon')

  return statements.filter((statement) => statement !== '')
}

/** The --command value of the argument array the script would spawn. */
function commandOf(statements, options) {
  const args = wranglerArguments(statements, options)
  const commands = args.filter((arg) => arg.startsWith('--command='))

  assert.equal(commands.length, 1)

  return commands[0].slice('--command='.length)
}

/** One D1 batch: every statement or none (a failing statement rolls back the rest). */
function runBatch(db, text) {
  const results = []
  let committed = false

  db.exec('BEGIN')

  try {
    for (const statement of splitStatements(text)) {
      results.push({ results: db.prepare(statement).all().map((row) => ({ ...row })), success: true })
    }

    db.exec('COMMIT')
    committed = true
  } catch (error) {
    if (error?.code !== 'ERR_SQLITE_ERROR') {
      throw error
    }

    return { ok: false, detail: error.message }
  } finally {
    if (!committed) {
      db.exec('ROLLBACK')
    }
  }

  return { ok: true, results }
}

/**
 * The scripts' io over `db`. `answer` is what the operator types, or a
 * function of the phrase (it may change the database, like a concurrent
 * writer between the read and the write). `events` lists logs, prompts and
 * batches in order.
 */
function fakeIo(db, answer = (phrase) => phrase) {
  const events = []
  const batches = []

  return {
    events,
    batches,
    lines: () => events.filter((event) => event.kind === 'log' || event.kind === 'error').map((event) => event.text),
    io: {
      execute(statements, options) {
        const text = commandOf(statements, options)

        assert.equal(text, toCommand(statements), 'the printed SQL is the SQL that runs')
        batches.push(text)
        events.push({ kind: 'execute', text })

        return runBatch(db, text)
      },
      async confirm(phrase) {
        events.push({ kind: 'confirm', text: phrase })

        return (typeof answer === 'function' ? answer(phrase) : answer) === phrase
      },
      log(text) {
        events.push({ kind: 'log', text })
      },
      error(text) {
        events.push({ kind: 'error', text })
      },
    },
  }
}

function writes(fake) {
  return fake.batches.filter((text) => /^\s*(UPDATE|INSERT)/m.test(text))
}

async function rejectsWith(promise, type, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof type, `${error?.constructor?.name}: ${error?.message}`)
    assert.match(error.message, pattern)

    return true
  })
}

function nowSeconds(db) {
  return db.prepare('SELECT unixepoch() AS now').get().now
}

describe('argument parsing (explicit target, N-31, strict values)', () => {
  const cases = [
    [['--email', OWNER_EMAIL, ...LOCAL], /--email without --uid is refused.*N-31/],
    [['--uid', OWNER, ...LOCAL], /--email is required/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--database', DATABASE], /exactly one of --local or --remote/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--remote'], /exactly one of --local or --remote/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--local'], /--database is required[\s\S]*Production: --database sundus-yar-production\. The preview Worker: --database sundus-yar-preview --env preview\./],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--remote', '--env', 'preview'], /--database is required[\s\S]*The "preview" environment: --database sundus-yar-preview --env preview\./],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--database', 'sundus;yar', '--local'], /--database must be a database_name[\s\S]*Production: --database sundus-yar-production/],
    [['--uid', "Owner'--", '--email', OWNER_EMAIL, ...LOCAL], /--uid must be the Firebase UID/],
    [['--uid', 'Owner Uid', '--email', OWNER_EMAIL, ...LOCAL], /--uid must be the Firebase UID/],
    [['--uid', 'a'.repeat(129), '--email', OWNER_EMAIL, ...LOCAL], /--uid must be the Firebase UID/],
    [['--uid', OWNER, '--email', "o'wner@example.test", ...LOCAL], /--email must be one plain email/],
    [['--uid', OWNER, '--email', 'owner@example.test;DROP', ...LOCAL], /--email must be one plain email/],
    [['--uid', '-e', '--email', OWNER_EMAIL, ...LOCAL], /--uid needs a value that does not start with '-'/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--uid', OTHER], /--uid was given more than once/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--yes'], /Unknown option --yes/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, 'extra'], /Unexpected argument: extra/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--local=1'], /--local was given more than once/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--database', DATABASE, '--local=yes'], /--local takes no value/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--replace', '--demote'], /at most one of --replace and --demote/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--database', 'DB', '--local'], /not a D1 database of the top-level \(production\)/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--database', 'sundus-yar-preview', '--remote'], /it declares: sundus-yar-production/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--env', 'preview'], /"preview" environment in wrangler\.jsonc/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--database', 'sundus-yar-mediatest', '--remote', '--env', 'mediatest'], /local-only environment/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--database', DATABASE, '--remote', '--env', 'production'], /--env accepts only/],
    [['--uid', OWNER, '--email', OWNER_EMAIL, '--database', DATABASE, '--remote', '--persist-to', 'state'], /--persist-to .* --local only/],
  ]

  for (const [argv, pattern] of cases) {
    test(argv.join(' ').slice(0, 90), async () => {
      const fake = fakeIo(openMigrated())

      await rejectsWith(promoteAdmin(argv, fake.io), UsageError, pattern)
      assert.equal(fake.batches.length, 0, 'nothing ran')
    })
  }

  test('a CLOUDFLARE_ENV that disagrees with --env stops the script', async () => {
    const saved = process.env.CLOUDFLARE_ENV

    process.env.CLOUDFLARE_ENV = 'preview'

    try {
      const fake = fakeIo(openMigrated())

      await rejectsWith(promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io), UsageError, /CLOUDFLARE_ENV="preview" disagrees/)
      assert.equal(fake.batches.length, 0)
    } finally {
      if (saved === undefined) {
        delete process.env.CLOUDFLARE_ENV
      } else {
        process.env.CLOUDFLARE_ENV = saved
      }
    }
  })

  test('wrangler gets an argument array: one token per value, the checked config, no shell', () => {
    const options = parseArguments(
      ['--database', 'sundus-yar-preview', '--local', '--env', 'preview', '--persist-to', 'my state', '--uid', OWNER],
      { valueFlags: ['uid'], booleanFlags: [] },
    )
    const statements = ['SELECT 1 AS one', 'SELECT 2 AS two']
    const args = wranglerArguments(statements, options)

    assert.match(args[0], /[\\/]node_modules[\\/]wrangler[\\/]bin[\\/]wrangler\.js$/)
    assert.deepEqual(args.slice(1, 6), ['d1', 'execute', 'sundus-yar-preview', '--local', '--json'])
    assert.match(args[6], /^--config=.*[\\/]wrangler\.jsonc$/)
    assert.equal(args[7], `--command=${toCommand(statements)}`)
    assert.equal(args[8], '--env=preview')
    assert.match(args[9], /^--persist-to=.*my state$/)
    assert.equal(args.length, 10)
  })

  test('printable() shows control, escape and bidi characters instead of sending them to the terminal', () => {
    assert.equal(printable('a\u001b[2Jb\u202ec\u0000d\u009be'), 'a\\u{1b}[2Jb\\u{202e}c\\u{0}d\\u{9b}e')
    assert.equal(printable('owner@example.test'), 'owner@example.test')
  })
})

describe('promote by uid (TM-02, N-31, L2)', () => {
  test('promotes the verified row, stamps tokens_valid_after from D1 and writes admin_promoted in the same batch', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: 'Owner@Example.test' })

    const before = nowSeconds(db)
    const fake = fakeIo(db)

    await promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io)

    assert.deepEqual(admins(db), [OWNER])
    assert.ok(user(db, OWNER).tokens_valid_after >= before, 'every earlier sign-in is refused')

    const [row, ...rest] = auditRows(db)

    assert.deepEqual(rest, [])
    assert.equal(row.actor_uid, OWNER)
    assert.equal(row.action, 'admin_promoted')
    assert.equal(row.target_id, OWNER)
    assert.equal(row.details, null)
    assert.equal(row.reauth_at, null)
    assert.match(row.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)

    const [write] = writes(fake)

    assert.match(write, /UPDATE users SET role = 'admin', tokens_valid_after = MAX\(COALESCE\(tokens_valid_after, 0\), unixepoch\(\)\)/)
    assert.match(write, /WHERE id = 'OwnerUid0001' AND lower\(email\) = lower\('owner@example\.test'\)/)
    assert.match(write, /AND email_verified_at IS NOT NULL AND erased_at IS NULL/)
    assert.match(write, /INSERT INTO admin_audit_log/)
    assert.equal(writes(fake).length, 1, 'the change and its audit row are one batch')

    // uid and stored email, and the exact write SQL, come before the typed confirmation.
    const confirmAt = fake.events.findIndex((event) => event.kind === 'confirm')
    const shown = fake.events.slice(0, confirmAt).map((event) => event.text).join('\n')

    assert.equal(fake.events[confirmAt].text, `promote ${DATABASE}`)
    assert.match(shown, /uid OwnerUid0001/)
    assert.match(shown, /stored email: +Owner@Example\.test/)
    assert.ok(shown.includes(write.split('\n')[0]), 'the write SQL is printed before the confirmation')
    assert.ok(fake.events.slice(0, confirmAt).every((event) => event.kind !== 'execute' || !/^\s*UPDATE/m.test(event.text)))
    assert.match(fake.lines().at(-1), /OwnerUid0001 is the only admin/)
  })

  test('--remote prints the Time Travel bookmark command before anything runs', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const fake = fakeIo(db)

    await promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, '--database', DATABASE, '--remote'], fake.io)

    const firstExecute = fake.events.findIndex((event) => event.kind === 'execute')
    const before = fake.events.slice(0, firstExecute).map((event) => event.text)

    assert.match(before[0], /Time Travel bookmark/)
    assert.equal(before[1], `  npx wrangler d1 time-travel info ${DATABASE}`)
    assert.ok(before.some((line) => line === `Target: ${DATABASE}, REMOTE (Cloudflare)`))
    assert.deepEqual(admins(db), [OWNER])
  })

  test('--local prints no bookmark line', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const fake = fakeIo(db)

    await promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io)
    assert.ok(fake.lines().every((line) => !line.includes('time-travel')))
  })

  const refusals = [
    ['a different stored email (N-31)', { id: OWNER, email: 'attacker@example.test' }, /stores a different email \(N-31\)/],
    ['an unverified email', { id: OWNER, email: OWNER_EMAIL, verified: false }, /never confirmed by a verified sign-in/],
    ['an erased row', { id: OWNER, email: OWNER_EMAIL, erased: true }, /this row was erased/],
    ['no row for the uid', { id: OTHER, email: OWNER_EMAIL }, /no users row has this uid/],
  ]

  for (const [name, row, pattern] of refusals) {
    test(`refuses ${name}: 0 rows changed, no audit row, no confirmation asked`, async () => {
      const db = openMigrated()

      addUser(db, row)

      const fake = fakeIo(db)

      await rejectsWith(promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io), ScriptFailure, pattern)
      assert.deepEqual(admins(db), [])
      assert.equal(user(db, row.id).tokens_valid_after, EARLIER)
      assert.deepEqual(auditRows(db), [])
      assert.deepEqual(writes(fake), [])
      assert.ok(fake.events.every((event) => event.kind !== 'confirm'))
    })
  }

  test('refuses a second admin without --replace', async () => {
    const db = openMigrated()

    addUser(db, { id: OTHER, email: OTHER_EMAIL, role: 'admin' })
    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const fake = fakeIo(db)

    await rejectsWith(
      promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io),
      ScriptFailure,
      /another account is the admin \(OtherUid0002 {2}other@example\.test\).*--replace/,
    )
    assert.deepEqual(admins(db), [OTHER])
    assert.deepEqual(writes(fake), [])
  })

  test('a wrong confirmation changes nothing', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const fake = fakeIo(db, 'yes')

    await rejectsWith(promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io), ScriptFailure, /^Cancelled/)
    assert.deepEqual(admins(db), [])
    assert.deepEqual(auditRows(db), [])
    assert.deepEqual(writes(fake), [])
  })

  const lateChanges = [
    ['the email moved', "UPDATE users SET email = 'moved@example.test' WHERE id = ?"],
    ['the verification was cleared', 'UPDATE users SET email_verified_at = NULL WHERE id = ?'],
    ['the row was erased', "UPDATE users SET erased_at = '2026-09-03T10:00:00.000Z' WHERE id = ?"],
  ]

  for (const [name, change] of lateChanges) {
    test(`${name} after the read: the UPDATE matches 0 rows, the audit row fails the batch, nothing is written`, async () => {
      const db = openMigrated()

      addUser(db, { id: OWNER, email: OWNER_EMAIL })

      const fake = fakeIo(db, (phrase) => {
        db.prepare(change).run(OWNER)

        return phrase
      })

      await rejectsWith(
        promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io),
        ScriptFailure,
        /^Failed: the batch was not applied; nothing changed/,
      )
      assert.deepEqual(admins(db), [])
      assert.equal(user(db, OWNER).tokens_valid_after, EARLIER)
      assert.deepEqual(auditRows(db), [])
      assert.ok(fake.lines().some((line) => /NOT NULL constraint failed: admin_audit_log\.created_at/.test(line)))
    })
  }

  test('an admin that appears after the read: the promotion does not create a second admin', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })
    addUser(db, { id: OTHER, email: OTHER_EMAIL })

    const fake = fakeIo(db, (phrase) => {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(OTHER)

      return phrase
    })

    await rejectsWith(promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io), ScriptFailure, /^Failed/)
    assert.deepEqual(admins(db), [OTHER])
    assert.deepEqual(auditRows(db), [])
  })

  test('re-running for the current admin keeps the role, ends its sessions and writes admin_promoted (TM-07 step 1)', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL, role: 'admin' })

    const fake = fakeIo(db)

    await promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fake.io)

    assert.deepEqual(admins(db), [OWNER])
    assert.ok(user(db, OWNER).tokens_valid_after > EARLIER)
    // Never the Worker's admin_sessions_revoked: that row means the admin's
    // own re-authenticated «تسجيل الخروج من كل الأجهزة».
    assert.deepEqual(
      auditRows(db).map(({ actor_uid, action, target_id, details, reauth_at }) => ({ actor_uid, action, target_id, details, reauth_at })),
      [{ actor_uid: OWNER, action: 'admin_promoted', target_id: OWNER, details: null, reauth_at: null }],
    )
    assert.match(writes(fake)[0], /AND role = 'admin'/)
  })
})

describe('--replace and --demote', () => {
  test('--replace moves the role in one batch; both accounts are stamped; admin_demoted then admin_promoted, actor the promoted uid', async () => {
    const db = openMigrated()

    addUser(db, { id: OTHER, email: OTHER_EMAIL, role: 'admin' })
    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const fake = fakeIo(db)

    await promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--replace'], fake.io)

    assert.deepEqual(admins(db), [OWNER])
    assert.equal(user(db, OTHER).role, 'customer')
    assert.ok(user(db, OTHER).tokens_valid_after > EARLIER)
    assert.ok(user(db, OWNER).tokens_valid_after > EARLIER)
    assert.deepEqual(
      auditRows(db).map(({ actor_uid, action, target_id }) => ({ actor_uid, action, target_id })),
      [
        { actor_uid: OWNER, action: 'admin_demoted', target_id: OTHER },
        { actor_uid: OWNER, action: 'admin_promoted', target_id: OWNER },
      ],
    )
    assert.equal(writes(fake).length, 1)
    assert.equal(fake.events.find((event) => event.kind === 'confirm').text, `replace ${DATABASE}`)
  })

  test('--replace that fails at the promotion rolls the demotion back too', async () => {
    const db = openMigrated()

    addUser(db, { id: OTHER, email: OTHER_EMAIL, role: 'admin' })
    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const fake = fakeIo(db, (phrase) => {
      db.prepare("UPDATE users SET erased_at = '2026-09-03T10:00:00.000Z' WHERE id = ?").run(OWNER)

      return phrase
    })

    await rejectsWith(promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--replace'], fake.io), ScriptFailure, /^Failed/)
    assert.deepEqual(admins(db), [OTHER])
    assert.equal(user(db, OTHER).tokens_valid_after, EARLIER)
    assert.deepEqual(auditRows(db), [])
  })

  test('--replace refuses when there is no admin, or the uid already is the admin', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })
    await rejectsWith(
      promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--replace'], fakeIo(db).io),
      ScriptFailure,
      /no admin to replace/,
    )

    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(OWNER)
    await rejectsWith(
      promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--replace'], fakeIo(db).io),
      ScriptFailure,
      /already is the admin/,
    )
    assert.deepEqual(auditRows(db), [])
  })

  test('--demote leaves no admin, stamps the row and writes admin_demoted', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL, role: 'admin' })

    const fake = fakeIo(db)

    await promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--demote'], fake.io)

    assert.deepEqual(admins(db), [])
    assert.ok(user(db, OWNER).tokens_valid_after > EARLIER)
    assert.deepEqual(
      auditRows(db).map(({ actor_uid, action, target_id }) => ({ actor_uid, action, target_id })),
      [{ actor_uid: OWNER, action: 'admin_demoted', target_id: OWNER }],
    )
    assert.match(fake.lines().at(-1), /NO admin/)
  })

  test('--demote refuses a customer and a different stored email', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })
    await rejectsWith(
      promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--demote'], fakeIo(db).io),
      ScriptFailure,
      /not an admin/,
    )

    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(OWNER)
    await rejectsWith(
      promoteAdmin(['--uid', OWNER, '--email', OTHER_EMAIL, ...LOCAL, '--demote'], fakeIo(db).io),
      ScriptFailure,
      /different email/,
    )
    assert.deepEqual(admins(db), [OWNER])
  })

  test('a long uid goes into details, and a stored escape sequence is printed as text', async () => {
    const db = openMigrated()
    const longUid = 'L'.repeat(100)

    addUser(db, { id: OTHER, email: 'evil\u001b[2J\u202e@example.test', role: 'admin' })
    addUser(db, { id: longUid, email: OWNER_EMAIL })

    const fake = fakeIo(db)

    await promoteAdmin(['--uid', longUid, '--email', OWNER_EMAIL, ...LOCAL, '--replace'], fake.io)

    assert.deepEqual(admins(db), [longUid])
    assert.deepEqual(
      auditRows(db).map(({ action, target_id, details }) => ({ action, target_id, details })),
      [
        { action: 'admin_demoted', target_id: OTHER, details: null },
        { action: 'admin_promoted', target_id: null, details: JSON.stringify({ targetUid: longUid }) },
      ],
    )

    const output = fake.lines().join('\n')

    assert.ok(!output.includes('\u001b') && !output.includes('\u202e'), 'no raw control or bidi character reaches the terminal')
    assert.ok(output.includes('evil\\u{1b}[2J\\u{202e}@example.test'))
  })
})

describe('a database without the admin audit log (migrations up to 0007)', () => {
  test('a promotion is refused: every promotion is audited (L2)', async () => {
    const db = openMigrated('0007')

    assert.equal(hasAuditLog(db), false)
    addUser(db, { id: OWNER, email: OWNER_EMAIL })
    await rejectsWith(
      promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fakeIo(db).io),
      ScriptFailure,
      /no admin audit log yet.*migrations 0008 and 0009/s,
    )
    assert.deepEqual(admins(db), [])
  })

  test('--demote runs unaudited and checks that exactly one row changed (plan 11 section 7.10)', async () => {
    const db = openMigrated('0007')

    addUser(db, { id: OWNER, email: OWNER_EMAIL, role: 'admin' })
    addUser(db, { id: OTHER, email: OTHER_EMAIL, role: 'admin' })

    const fake = fakeIo(db)

    await promoteAdmin(['--uid', OTHER, '--email', OTHER_EMAIL, ...LOCAL, '--demote'], fake.io)

    assert.deepEqual(admins(db), [OWNER])
    assert.ok(user(db, OTHER).tokens_valid_after > EARLIER)
    assert.match(writes(fake)[0], /SELECT changes\(\) AS changed;$/)
    assert.ok(fake.lines().some((line) => /NOT audited/.test(line)))
  })

  test('the admin row: both scripts refuse to end its sessions unaudited and point to --demote', async () => {
    const db = openMigrated('0007')

    addUser(db, { id: OWNER, email: OWNER_EMAIL, role: 'admin' })
    await rejectsWith(
      promoteAdmin(['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL], fakeIo(db).io),
      ScriptFailure,
      /every promotion is audited \(L2\)[\s\S]*--demote runs unaudited/,
    )
    await rejectsWith(
      revokeSessions(['--uid', OWNER, ...LOCAL], fakeIo(db).io),
      ScriptFailure,
      /this uid is the admin[\s\S]*no admin audit log yet[\s\S]*node scripts\/promote-admin\.mjs --database sundus-yar-production --uid OwnerUid0001 --email <her stored email> --local --demote/,
    )
    assert.deepEqual(admins(db), [OWNER])
    assert.equal(user(db, OWNER).tokens_valid_after, EARLIER)
  })
})

describe('revoke-sessions.mjs (SEC-11, TM-07)', () => {
  test('a customer: the mark is stamped from D1, the role stays, no audit row', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const before = nowSeconds(db)
    const fake = fakeIo(db)

    await revokeSessions(['--uid', OWNER, ...LOCAL], fake.io)

    assert.equal(user(db, OWNER).role, 'customer')
    assert.ok(user(db, OWNER).tokens_valid_after >= before)
    assert.deepEqual(auditRows(db), [])
    assert.equal(fake.events.find((event) => event.kind === 'confirm').text, `revoke ${DATABASE}`)
  })

  test('the admin row is refused and points to promote-admin.mjs: nothing written, no confirmation asked (R-03)', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL, role: 'admin' })

    const fake = fakeIo(db)

    await rejectsWith(
      revokeSessions(['--uid', OWNER, ...LOCAL, '--persist-to', 'state'], fake.io),
      ScriptFailure,
      /this uid is the admin\. Only scripts\/promote-admin\.mjs changes the admin row[\s\S]*node scripts\/promote-admin\.mjs --database sundus-yar-production --uid OwnerUid0001 --email <her stored email> --local --persist-to <the same folder>/,
    )
    assert.deepEqual(admins(db), [OWNER])
    assert.equal(user(db, OWNER).tokens_valid_after, EARLIER)
    assert.deepEqual(auditRows(db), [])
    assert.deepEqual(writes(fake), [])
    assert.ok(fake.events.every((event) => event.kind !== 'confirm'))
  })

  test('a promotion between the read and the write: the customer-bound UPDATE leaves the admin row untouched', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const fake = fakeIo(db, (phrase) => {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(OWNER)

      return phrase
    })

    await rejectsWith(
      revokeSessions(['--uid', OWNER, ...LOCAL], fake.io),
      ScriptFailure,
      /tokens_valid_after was not stamped; the role changed during the run; the UPDATE did not change exactly one row/,
    )
    assert.match(writes(fake)[0], /WHERE id = 'OwnerUid0001' AND role = 'customer'/)
    assert.equal(user(db, OWNER).tokens_valid_after, EARLIER)
    assert.deepEqual(auditRows(db), [])
  })

  test('never moves an existing mark back, and refuses an unknown uid', async () => {
    const db = openMigrated()
    const future = nowSeconds(db) + 3600

    addUser(db, { id: OWNER, email: OWNER_EMAIL, validAfter: future })
    await revokeSessions(['--uid', OWNER, ...LOCAL], fakeIo(db).io)
    assert.equal(user(db, OWNER).tokens_valid_after, future)

    await rejectsWith(revokeSessions(['--uid', OTHER, ...LOCAL], fakeIo(db).io), ScriptFailure, /no users row has this uid/)
    await rejectsWith(revokeSessions(['--uid', OWNER, '--database', DATABASE], fakeIo(db).io), UsageError, /exactly one of --local or --remote/)
  })

  test('a command line without --database (an older runbook form) names the exact databases and runs nothing', async () => {
    const db = openMigrated()

    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const fake = fakeIo(db)

    await rejectsWith(
      revokeSessions(['--uid', OWNER, '--remote'], fake.io),
      UsageError,
      /--database is required[\s\S]*Production: --database sundus-yar-production\. The preview Worker: --database sundus-yar-preview --env preview\./,
    )
    assert.deepEqual(fake.events, [])
    assert.equal(user(db, OWNER).tokens_valid_after, EARLIER)
  })
})

describe('script audit rows follow shared/audit.ts (W1-09 contract, L2, SB-10)', () => {
  test('the scripts write exactly the actions shared/audit.ts reserves for them, and no Worker action', () => {
    assert.deepEqual([...SCRIPT_AUDIT_ACTIONS], [...adminAuditScriptActions])

    for (const action of adminAuditActions.filter((name) => !SCRIPT_AUDIT_ACTIONS.includes(name))) {
      assert.throws(
        () => auditStatement({ actorUid: OWNER, action, targetUid: OWNER }),
        /Only admin_promoted and admin_demoted are written by a script/,
        action,
      )
    }

    assert.throws(() => auditStatement({ actorUid: OWNER, action: 'admin_promoted', targetUid: null }), /plain Firebase uid/)
    assert.throws(() => auditStatement({ actorUid: "x'", action: 'admin_promoted', targetUid: OWNER }), /plain Firebase uid/)
  })

  test('every script run leaves rows of one shape: a script action, actor and target uids, reauth_at NULL, no details', async () => {
    const db = openMigrated()

    addUser(db, { id: OTHER, email: OTHER_EMAIL })
    addUser(db, { id: OWNER, email: OWNER_EMAIL })

    const runs = [
      ['--uid', OTHER, '--email', OTHER_EMAIL, ...LOCAL],
      ['--uid', OTHER, '--email', OTHER_EMAIL, ...LOCAL],
      ['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--replace'],
      ['--uid', OWNER, '--email', OWNER_EMAIL, ...LOCAL, '--demote'],
    ]

    for (const argv of runs) {
      await promoteAdmin(argv, fakeIo(db).io)
    }

    await revokeSessions(['--uid', OTHER, ...LOCAL], fakeIo(db).io)

    const rows = auditRows(db)

    assert.deepEqual(
      rows.map(({ actor_uid, action, target_id, details, reauth_at }) => ({ actor_uid, action, target_id, details, reauth_at })),
      [
        { actor_uid: OTHER, action: 'admin_promoted', target_id: OTHER, details: null, reauth_at: null },
        { actor_uid: OTHER, action: 'admin_promoted', target_id: OTHER, details: null, reauth_at: null },
        { actor_uid: OWNER, action: 'admin_demoted', target_id: OTHER, details: null, reauth_at: null },
        { actor_uid: OWNER, action: 'admin_promoted', target_id: OWNER, details: null, reauth_at: null },
        { actor_uid: OWNER, action: 'admin_demoted', target_id: OWNER, details: null, reauth_at: null },
      ],
    )
    assert.ok(rows.every((row) => adminAuditScriptActions.includes(row.action)))
    assert.deepEqual(admins(db), [])
  })
})
