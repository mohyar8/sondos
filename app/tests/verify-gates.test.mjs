// W1-13 (M6, SB-6, SB-7, SB-12, SB-19, TM-10, TM-14, TM-17, TM-19): the
// gates of scripts/verify.mjs. Every gate is shown a planted violation (it
// must fail) and the shapes the code base really uses (they must pass), so a
// gate that is removed or weakened fails here. Only the pure functions run,
// plus verify's entry, argument and delete-only push paths, which stop before
// any step, the three hooks in a throwaway repository with a stub verify, and
// the gates step alone in a throwaway repository (its record stays there):
// nothing here builds or writes the project's verify record.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BASELINE_WAIVERS,
  ENGINES_NODE,
  FROZEN_DEPENDENCIES,
  GATE_RULES,
  HOOK_FILES,
  TEST_SCRIPT,
  UNASSIGNED,
  analyzeSql,
  applyWaivers,
  checkHooks,
  checkManifest,
  fingerprintContent,
  isReleaseRef,
  isSupportedNode,
  releaseCheckoutReason,
  parseOptions,
  parsePrePushInput,
  recordProblem,
  scanDistText,
  scanSource,
  waiversFor,
} from '../scripts/verify.mjs'

const VERIFY = fileURLToPath(new URL('../scripts/verify.mjs', import.meta.url))
const OLD_NODE_HOOK = new URL('./fixtures/verify-entry/old-node.mjs', import.meta.url).href

/** `gate: detail` for every finding in one planted file. */
function findings(file, code) {
  return scanSource(file, code).map(({ gate, detail }) => `${gate}: ${detail}`)
}

function assertFlags(file, code, expected) {
  assert.deepEqual(findings(file, code), expected, code)
}

function assertClean(file, code) {
  assert.deepEqual(findings(file, code), [], code)
}

function readJson(relative) {
  return JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'))
}

describe('console gate (SB-7, TM-17)', () => {
  const file = 'worker/example.ts'

  test('passes literals and code=/count=/job= templates', () => {
    for (const code of [
      "console.error('BOOKING_NOTIFICATION_FAILED')",
      'console.log(42)',
      'console.warn(`OUTBOX_GAVE_UP count=${summary.gaveUp}`)',
      'console.warn(`HOLD_EXPIRED_EMAIL_NOT_QUEUED code=${email.code}`)',
      'console.error(`SCHEDULED_JOB_FAILED job=${job.name} code=${classifyJobFailure(error)}`)',
      '// console.log(token)',
      "const text = 'console.log(token)'",
    ]) {
      assertClean(file, code)
    }
  })

  test('fails anything else', () => {
    assertFlags(file, 'console.error(error)', ['console: non-literal argument'])
    assertFlags(file, "console.log('signed in', email)", ['console: non-literal argument'])
    assertFlags(file, "console.log('a' + token)", ['console: non-literal argument'])
    assertFlags(file, 'console.warn(`FAILED code=${error.message}`)', ['console: template value "message"'])
    assertFlags(file, 'console.warn(`FAILED code=${error.message.slice(0, 9)}`)', ['console: template value "message"'])
    assertFlags(file, 'console.warn(`FAILED code=${JSON.stringify(body)}`)', [
      'console: template value "stringify"',
      'console: template value "JSON"',
      'console: template value "body"',
    ])
    assertFlags(file, 'console.warn(`FAILED code=${String(error)}`)', ['console: template value "String"'])
    assertFlags(file, 'console.info(`SEARCH q=${query}`)', [
      'console: template key "q"',
      'console: template value "query"',
    ])
    assertFlags(file, 'console.log(`booking ${bookingId}`)', ['console: template value without a key='])
    assertFlags(file, 'console.log(`code=${{ a: 1 }}`)', ['console: template value is not a plain name, member or call'])
  })

  test('fails an error or rejection value interpolated as a whole (Error#toString)', () => {
    const errorValue = (name) => [`console: template value "${name}" is an error or rejection value`]

    assertFlags(file, 'try { x() } catch (error) { console.error(`X_FAILED code=${error}`) }', errorValue('error'))
    assertFlags(file, 'try { x() } catch (err) { console.error(`X_FAILED code=${err}`) }', errorValue('err'))
    assertFlags(file, 'task.catch((reason) => console.error(`X_FAILED code=${reason}`))', errorValue('reason'))
    assertFlags(file, 'console.error(`X_FAILED code=${e}`)', errorValue('e'))
    assertFlags(file, 'console.error(`X_FAILED code=${event.reason}`)', errorValue('reason'))
    assertFlags(file, "console.error(`X_FAILED code=${failed ? error : 'NONE'}`)", errorValue('error'))
    assertFlags(file, "console.error(`X_FAILED code=${error ?? 'NONE'}`)", errorValue('error'))
  })

  test('fails a caught value under any name, except its code or name', () => {
    assertFlags(file, 'try { x() } catch (problem) { console.error(`X_FAILED code=${problem}`) }', [
      'console: template value "problem" reads a caught error',
    ])
    assertFlags(file, 'task.then(done, function (problem) { console.error(`X_FAILED code=${problem.status}`) })', [
      'console: template value "status" reads a caught error',
    ])

    for (const code of [
      'try { x() } catch (problem) { console.error(`X_FAILED code=${problem.code}`) }',
      'try { x() } catch (error) { console.error(`X_FAILED code=${error.name}`) }',
      'try { x() } catch (error) { console.error(`X_FAILED code=${classifyJobFailure(error)}`) }',
      'task.catch((error) => console.error(`X_FAILED code=${classifyJobFailure(error)}`))',
    ]) {
      assertClean(file, code)
    }
  })

  test('fails a caught value copied into a local or destructured from the catch', () => {
    assertFlags(
      file,
      "try { x() } catch (caught) { const detail = caught instanceof Error ? caught.message : 'unknown'; console.error(`X_FAILED code=${detail}`) }",
      ['console: template value "detail" reads a caught error'],
    )
    assertFlags(file, 'try { x() } catch (error) { const failure2 = error; console.error(`X_FAILED code=${failure2}`) }', [
      'console: template value "failure2" reads a caught error',
    ])
    assertFlags(file, 'try { x() } catch ({ message: detail }) { console.error(`X_FAILED code=${detail}`) }', [
      'console: template value "detail" reads a caught error',
    ])
    assertFlags(file, "try { x() } catch (caught) { let text = ''; text = String(caught); console.error(`X_FAILED code=${text}`) }", [
      'console: template value "text" reads a caught error',
    ])
    assertFlags(file, 'task.catch((why) => { const copy = why; const status = copy.status; console.error(`X_FAILED code=${status}`) })', [
      'console: template value "status" reads a caught error',
    ])
    assertFlags(file, 'try { x() } catch (caught) { later(() => { const detail = `${caught.cause}`; console.error(`X_FAILED code=${detail}`) }) }', [
      'console: template value "detail" reads a caught error',
    ])

    for (const code of [
      'try { x() } catch ({ code }) { console.error(`X_FAILED code=${code}`) }',
      'try { x() } catch (error) { const code = error.code; console.error(`X_FAILED code=${code}`) }',
      'try { x() } catch (error) { const code = classifyJobFailure(error); console.error(`X_FAILED code=${code}`) }',
      'let a = b; let b = a; console.log(`X_DONE count=${a}`)',
    ]) {
      assertClean(file, code)
    }
  })

  test('fails a token or personal value under any name that contains it', () => {
    assertFlags(file, 'console.error(`X code=${idToken}`)', ['console: template value "idToken"'])
    assertFlags(file, 'console.error(`X code=${customerEmail}`)', ['console: template value "customerEmail"'])
    assertFlags(file, 'console.error(`X code=${booking.adminPhoneNumber}`)', ['console: template value "adminPhoneNumber"'])
    assertFlags(file, 'console.error(`X code=${mask(bankIban)}`)', ['console: template value "bankIban"'])
    assertFlags(file, 'console.error(`X code=${errorMessage}`)', ['console: template value "errorMessage"'])
    // D1 rows are snake_case.
    assertFlags(file, 'console.error(`X code=${row.first_name}`)', ['console: template value "first_name"'])
    assertFlags(file, 'console.error(`X code=${row.customer_email}`)', ['console: template value "customer_email"'])
    assertFlags(file, 'console.error(`X code=${row.full_name}`)', ['console: template value "full_name"'])
  })

  test('fails console used other than console.method(...)', () => {
    const misuse = 'console: console used other than console.method(...)'
    assertFlags(file, 'const log = console.log', [misuse])
    assertFlags(file, "globalThis.console.log('x')", [misuse])
    assertFlags(file, "console['log']('x')", [misuse])
    assertFlags(file, 'const { log } = console', [misuse])
    assert.ok(findings(file, 'console.log.apply(console, args)').includes(misuse))
  })
})

describe('media gate (TM-10)', () => {
  test('fails every way of reading the MEDIA binding outside gates.ts', () => {
    const file = 'worker/portal/slots/gallery.ts'
    assertFlags(file, 'const bucket = env.MEDIA', ['media: .MEDIA'])
    assertFlags(file, 'const bucket = this.env.MEDIA', ['media: .MEDIA'])
    assertFlags(file, "const bucket = Reflect.get(env, 'MEDIA')", ["media: 'MEDIA' key"])
    assertFlags(file, "const bucket = env['MEDIA']", ["media: 'MEDIA' key"])
    assertFlags(file, 'const { MEDIA } = env', ['media: MEDIA destructured'])
    assertFlags(file, 'const { MEDIA: bucket } = env', ['media: MEDIA destructured'])
  })

  test('passes gates.ts itself, the helper and look-alike names', () => {
    assertClean('worker/portal/gates.ts', "const bucket = env.MEDIA ?? Reflect.get(env, 'MEDIA')")
    assertClean('worker/portal/slots/gallery.ts', 'const bucket = getMediaBucket(env); const key = env.MEDIA_SIGNING_KEY')
    assertClean('worker/platform-env.d.ts', 'interface Env { MEDIA?: R2Bucket }')
  })
})

describe('wa-me gate (TM-19)', () => {
  test('fails WhatsApp link hosts outside src/lib/whatsapp.ts', () => {
    const file = 'src/components/Contact.tsx'
    assertFlags(file, "const url = 'https://wa.me/966500000000'", ['wa-me: wa.me'])
    assertFlags(file, 'const url = `https://wa.me/${number}?text=${text}`', ['wa-me: wa.me'])
    assertFlags(file, 'const a = <a href="https://wa.me/1">x</a>', ['wa-me: wa.me'])
    assertFlags(file, 'const a = <p>wa.me/966500000000</p>', ['wa-me: wa.me'])
    assertFlags(file, 'const isWhatsApp = /wa\\.me/.test(host)', ['wa-me: wa.me'])
    assertFlags(file, "const url = 'https://api.whatsapp.com/send?phone=1'", ['wa-me: api.whatsapp.com'])
    assertFlags(file, "const url = 'whatsapp://send?phone=1'", ['wa-me: whatsapp://'])
  })

  test('passes the link library and comments', () => {
    assertClean('src/lib/whatsapp.ts', "const WA_ME_BASE_URL = 'https://wa.me/'")
    assertClean('src/components/Contact.tsx', '// links come from lib/whatsapp (wa.me)\nconst url = buildWhatsAppUrl(message)')
  })
})

describe('storage gate (SB-12, UX-01)', () => {
  const file = 'src/design/cinematic/LogoIntro.tsx'

  test("passes only the key 'sy:intro:v1'", () => {
    for (const code of [
      "localStorage.getItem('sy:intro:v1')",
      "const INTRO_KEY = 'sy:intro:v1'\nwindow.sessionStorage.setItem(INTRO_KEY, '1')",
      "const INTRO_KEY = 'sy:intro:v1' as const\nwindow.localStorage.removeItem(INTRO_KEY)",
      "const seen = window.sessionStorage['sy:intro:v1']",
      "import { browserLocalPersistence } from 'firebase/auth'",
    ]) {
      assertClean(file, code)
    }
  })

  test('fails every other key, form or storage API', () => {
    assertFlags(file, "localStorage.setItem('idToken', token)", ['storage: localStorage key "idToken"'])
    assertFlags(file, 'window.localStorage.getItem(key)', ['storage: localStorage key not a constant'])
    assertFlags(file, "let KEY = 'sy:intro:v1'\nlocalStorage.getItem(KEY)", ['storage: localStorage key not a constant'])
    assertFlags(file, 'localStorage.clear()', ['storage: localStorage used other than getItem/setItem/removeItem or [key]'])
    assertFlags(file, 'const store = window.sessionStorage', ['storage: sessionStorage used other than getItem/setItem/removeItem or [key]'])
    assertFlags(file, 'const { localStorage } = window', ['storage: localStorage used other than getItem/setItem/removeItem or [key]'])
    assertFlags(file, "window['localStorage'].getItem('sy:intro:v1')", ['storage: localStorage by computed access'])
    assertFlags(file, "indexedDB.open('sy')", ['storage: indexedDB'])
    assertFlags(file, "document.cookie = 'a=b'", ['storage: document.cookie'])
    assertFlags(file, "document['cookie'] = 'a=b'", ['storage: document.cookie by computed access'])
    assertFlags(file, "const all = window.document['cookie']", ['storage: document.cookie by computed access'])
    assertFlags(file, 'navigator.storage.persist()', ['storage: navigator.storage'])
    assertFlags(file, "navigator['storage'].persist()", ['storage: navigator.storage by computed access'])
    assertFlags(file, "caches.open('sy')", ['storage: caches'])
    assertFlags('shared/cache.ts', "globalThis.caches.open('sy')", ['storage: caches'])
  })

  test('does not apply to the Worker (its Cache API is server-side)', () => {
    assertClean('worker/availability.ts', "const cache = caches.default\nconst hit = await cache.match('x')")
  })
})

describe('html-sink gate (SB-6)', () => {
  test('fails every HTML or code sink', () => {
    const file = 'src/components/Example.tsx'
    const cases = [
      ['el.innerHTML = html', 'innerHTML'],
      ['const html = el.outerHTML', 'outerHTML'],
      ["el.insertAdjacentHTML('beforeend', x)", 'insertAdjacentHTML'],
      ['range.createContextualFragment(x)', 'createContextualFragment'],
      ['frame.srcdoc = x', 'srcdoc'],
      ['const a = <iframe srcDoc={x} />', 'srcdoc'],
      ['const a = <div dangerouslySetInnerHTML={{ __html: x }} />', 'dangerouslySetInnerHTML'],
      ['document.write(x)', 'document.write'],
      ['window.document.writeln(x)', 'document.writeln'],
      ['eval(code)', 'eval'],
      ['window.eval(code)', 'eval'],
      ['const run = eval', 'eval'],
      ["new Function('return 1')", 'Function constructor'],
      ["Function('return 1')()", 'Function constructor'],
      ["setTimeout('tick()', 10)", 'string timer'],
      ['window.setInterval(`tick()`, 10)', 'string timer'],
      ["el['innerHTML'] = x", "'innerHTML' key"],
      ["window['eval']('1')", "'eval' key"],
      ["globalThis['eval'](code)", "'eval' key"],
      ["new window['Function']('return 1')", "'Function' key"],
      ["Reflect.get(globalThis, 'Function')", "'Function' key"],
      ["document['write'](x)", 'document.write'],
      ["window.document['writeln'](x)", 'document.writeln'],
    ]

    for (const [code, detail] of cases) {
      assert.ok(findings(file, code).includes(`html-sink: ${detail}`), code)
    }
  })

  test('passes safe look-alikes', () => {
    for (const code of [
      'await writer.write(chunk)',
      'setTimeout(() => tick(), 10)',
      'element.textContent = text',
      'const evaluation = 1',
      'let handler: Function | null = null',
      'const options = { eval: false }',
      "if (typeof callback === 'function') callback()",
      "await stream['write'](chunk)",
    ]) {
      assertClean('src/components/Example.tsx', code)
    }
  })
})

describe('users-role gate (W1-12, SB-2)', () => {
  // The two real statements that touch users (worker/profile.ts and
  // worker/users.ts), reduced to their structure.
  const CUSTOMER_UPSERT = `
    INSERT INTO users (id, email, email_verified_at, first_name, last_name, phone, role)
    SELECT ?, ?, ?, ?, ?, ?, 'customer'
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?)
    ON CONFLICT(id) DO UPDATE SET
      email = CASE WHEN users.role = 'customer' AND excluded.email_verified_at IS NOT NULL
        THEN excluded.email ELSE users.email END,
      email_verified_at = CASE WHEN users.email <> excluded.email AND users.role <> 'customer'
        THEN users.email_verified_at ELSE excluded.email_verified_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE users.erased_at IS NULL`
  const EMAIL_SYNC = `
    UPDATE users
    SET email = ?, email_verified_at = CASE WHEN email_verified_at IS NOT NULL AND email = ? THEN email_verified_at ELSE ? END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND erased_at IS NULL AND (role = 'customer' OR email = ?)`

  test('passes the customer insert and writes that leave role alone', () => {
    for (const sql of [
      CUSTOMER_UPSERT,
      EMAIL_SYNC,
      "INSERT INTO users (id, email, role) VALUES (?, ?, 'customer')",
      "INSERT INTO users (id, role) SELECT ?, 'customer' AS role",
      'INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)',
      "DELETE FROM users WHERE id = ? AND role = 'customer'",
      "SELECT role FROM users WHERE id = ? AND role = 'admin'",
      'UPDATE booking_requests SET role = ? WHERE id = ?',
      'Update users when the address changes.',
    ]) {
      assert.deepEqual(analyzeSql(sql), [], sql)
    }
  })

  test('fails every other write of users.role', () => {
    const cases = [
      ["UPDATE users SET role = 'admin' WHERE id = ?", 'UPDATE users SET role'],
      ['update users set "role" = ? where id = ?', 'UPDATE users SET role'],
      ['UPDATE users SET email = ?, users.role = ? WHERE id = ?', 'UPDATE users SET role'],
      ['UPDATE users SET (email, role) = (?, ?) WHERE id = ?', 'UPDATE users SET role'],
      ['UPDATE OR REPLACE main.users AS u SET [role] = ? WHERE id = ?', 'UPDATE users SET role'],
      ['UPDATE users NOT INDEXED SET role = ? WHERE id = ?', 'UPDATE users SET role'],
      ['UPDATE users INDEXED BY users_email SET role = ? WHERE id = ?', 'UPDATE users SET role'],
      ['UPDATE users AS u INDEXED BY users_email SET role = ?', 'UPDATE users SET role'],
      ['UPDATE other.users u NOT INDEXED SET role = ?', 'UPDATE users SET role'],
      ['UPDATE users', 'UPDATE users without its SET clause in the same string'],
      ['INSERT INTO users (id, role) VALUES (?, ?)', "INSERT INTO users role value is not 'customer'"],
      ["INSERT INTO users (id, role) VALUES (?, 'admin')", "INSERT INTO users role value is not 'customer'"],
      ["INSERT INTO users (id, role) VALUES (?, 'customer'), (?, 'admin')", "INSERT INTO users role value is not 'customer'"],
      ['INSERT INTO users (id, role) SELECT ?, role FROM users', "INSERT INTO users role value is not 'customer'"],
      ["INSERT INTO users (id, role) VALUES (?, COALESCE(?, 'customer'))", "INSERT INTO users role value is not 'customer'"],
      ['INSERT INTO users VALUES (?, ?)', 'INSERT INTO users without a column list'],
      ['INSERT OR REPLACE INTO users (id) VALUES (?)', 'REPLACE INTO users (replaces the role too)'],
      ['REPLACE INTO users (id) VALUES (?)', 'REPLACE INTO users (replaces the role too)'],
      [
        "INSERT INTO users (id, role) VALUES (?, 'customer') ON CONFLICT(id) DO UPDATE SET role = excluded.role",
        'upsert SET role',
      ],
    ]

    for (const [sql, detail] of cases) {
      assert.deepEqual(analyzeSql(sql), [detail], sql)
    }
  })

  test('sees through string assembly in code', () => {
    const file = 'worker/admin.ts'
    const detail = 'users-role: UPDATE users SET role'

    assertClean(file, `db.prepare(${JSON.stringify(CUSTOMER_UPSERT)})`)
    assertFlags(file, "db.prepare('UPDATE users ' + 'SET role = ? WHERE id = ?')", [detail])
    assertFlags(file, "db.prepare(('UPDATE users SET ') + ('role = ?'))", [detail])
    assertFlags(file, 'db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`)', [
      'users-role: UPDATE users SET clause is assembled at run time',
    ])
    assertFlags(file, "db.prepare('UPDATE users ' + clause)", ['users-role: UPDATE users is assembled at run time'])
    assertFlags(file, "db.prepare(['UPDATE users', 'SET role = ?'].join(' '))", [
      'users-role: UPDATE users without its SET clause in the same string',
    ])
  })

  test('counts a table name assembled at run time as users when role is written', () => {
    const file = 'worker/admin.ts'
    const table = '<table assembled at run time>'

    assertFlags(file, "const USERS = 'users'\ndb.prepare(`UPDATE ${USERS} SET role = ? WHERE id = ?`)", [
      `users-role: UPDATE ${table} SET role`,
    ])
    assertFlags(file, "db.prepare('UPDATE ' + table + ' SET role = ? WHERE id = ?')", [`users-role: UPDATE ${table} SET role`])
    assertFlags(file, 'db.prepare(`UPDATE main.${table} AS u NOT INDEXED SET (email, role) = (?, ?)`)', [
      `users-role: UPDATE ${table} SET role`,
    ])
    assertFlags(file, 'db.prepare(`UPDATE users_${suffix} SET role = ?`)', [`users-role: UPDATE ${table} SET role`])
    assertFlags(file, 'db.prepare(`UPDATE ${table} SET ${assignments}`)', [
      `users-role: UPDATE ${table} SET clause is assembled at run time`,
    ])
    assertFlags(file, 'db.prepare(`INSERT INTO ${T} (uid, role) VALUES (?, ?)`)', [`users-role: INSERT INTO ${table} names role`])
    assertFlags(file, "db.prepare(`INSERT INTO ${T} (uid, role) VALUES (?, 'customer')`)", [`users-role: INSERT INTO ${table} names role`])
    assertFlags(file, 'db.prepare(`INSERT INTO ${T} VALUES (?, ?)`)', [`users-role: INSERT INTO ${table} without a column list`])
    assertFlags(file, 'db.prepare(`REPLACE INTO ${T} (id) VALUES (?)`)', [`users-role: REPLACE INTO ${table} (replaces the role too)`])

    // A run-time table whose write leaves role alone passes.
    assertClean(file, 'db.prepare(`UPDATE ${table} SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`)')
    assertClean(file, 'db.prepare(`INSERT INTO ${table} (id, note) VALUES (?, ?)`)')
  })
})

describe('data-image gate (TM-14)', () => {
  test('fails a data:image URI in any built text file', () => {
    assert.deepEqual(
      scanDistText('dist/client/assets/index.css', 'a{background:url(data:image/png;base64,AAAA)}b{background:url("DATA:IMAGE/svg+xml,x")}'),
      [{ gate: 'data-image', file: 'dist/client/assets/index.css', line: 0, detail: 'data:image x2' }],
    )
  })

  test('passes built files without one', () => {
    assert.deepEqual(scanDistText('dist/client/index.html', '<img src="/images/brand/logo.webp" alt="">'), [])
  })
})

describe('baseline waivers', () => {
  const [waiver] = BASELINE_WAIVERS.filter((candidate) => candidate.gate === 'wa-me')

  test('absorb exactly their own findings, never more', () => {
    const own = { gate: 'wa-me', file: waiver.file, line: 211, detail: 'wa.me' }
    const extra = { ...own, line: 300 }
    const elsewhere = { ...own, file: 'src/components/Other.tsx' }
    const otherDetail = { ...own, detail: 'api.whatsapp.com' }
    const result = applyWaivers([own, extra, elsewhere, otherDetail])

    assert.deepEqual(result.waived, [own])
    assert.deepEqual(result.failures, [extra, elsewhere, otherDetail])
    assert.ok(result.stale.every((stale) => stale.gate !== 'wa-me'))
  })

  test('report a waiver that no longer matches', () => {
    const { stale } = applyWaivers([])
    assert.equal(stale.length, BASELINE_WAIVERS.length)
    assert.ok(stale.every((entry) => entry.unused === entry.count))
  })

  test('a release/* branch or a release-* tag at HEAD makes every run a release run', () => {
    assert.equal(releaseCheckoutReason('main', []), null)
    assert.equal(releaseCheckoutReason(null, []), null)
    assert.equal(releaseCheckoutReason('feature/release/1', ['v1', 'prerelease-1']), null)
    assert.match(releaseCheckoutReason('release/1', []), /release\/1/)
    assert.match(releaseCheckoutReason(null, ['v1', 'release-2026-10-01']), /release-2026-10-01/)
    assert.match(releaseCheckoutReason('main', ['release-2026-10-01']), /release-2026-10-01/)
    // Tags that could not be read fail closed.
    assert.notEqual(releaseCheckoutReason('main', null), null)
  })

  test('never apply to a release run', () => {
    const own = { gate: 'wa-me', file: waiver.file, line: 211, detail: 'wa.me' }

    assert.deepEqual(waiversFor(true), [])
    assert.equal(waiversFor(false), BASELINE_WAIVERS)
    assert.deepEqual(applyWaivers([own], waiversFor(true)).failures, [own])
  })

  test('each names its gate, file, the unit that removes it and a reason', () => {
    for (const entry of BASELINE_WAIVERS) {
      assert.ok(entry.gate in GATE_RULES, entry.gate)
      assert.match(entry.file, /^(src|worker|shared)\//)
      assert.ok(Number.isInteger(entry.count) && entry.count > 0)
      assert.ok(/^W\d+-\d{2}$/.test(entry.removeBy) || entry.removeBy === UNASSIGNED, entry.removeBy)
      assert.ok(entry.reason.length > 0)
    }
  })
})

describe('manifest gate (M6)', () => {
  const manifest = readJson('package.json')
  const lock = readJson('package-lock.json')

  test('passes the repository as it is', () => {
    assert.deepEqual(checkManifest(manifest, lock), [])
    assert.equal(manifest.scripts.test, TEST_SCRIPT)
    assert.equal(manifest.engines.node, ENGINES_NODE)
  })

  test('fails an engines.node that is not the floor verify enforces', () => {
    for (const engines of [undefined, {}, { node: '>=22' }]) {
      assert.deepEqual(
        checkManifest({ ...manifest, engines }, lock).map((finding) => finding.detail),
        [`engines.node is not "${ENGINES_NODE}"`],
      )
    }
  })

  test('fails a changed test script, a new dependency or a lock that disagrees', () => {
    const details = (candidate, candidateLock = lock) =>
      checkManifest(candidate, candidateLock).map((finding) => finding.detail)

    assert.deepEqual(details({ ...manifest, scripts: { ...manifest.scripts, test: 'node --test' } }), [
      'scripts.test is not the harness command',
    ])
    assert.deepEqual(
      details({ ...manifest, dependencies: { ...manifest.dependencies, 'left-pad': '^1.3.0' } }),
      ['new dependency "left-pad"', 'dependencies differ from package.json'],
    )
    assert.deepEqual(
      details(manifest, {
        ...lock,
        packages: { ...lock.packages, '': { ...lock.packages[''], devDependencies: {} } },
      }),
      ['devDependencies differ from package.json'],
    )
    assert.equal(FROZEN_DEPENDENCIES.includes('left-pad'), false)
  })
})

describe('hooks gate (M6, SB-19)', () => {
  const [PRE_PUSH, PRE_MERGE, PRE_COMMIT] = HOOK_FILES

  test('passes hooks that exist and are untracked or tracked as 100755', () => {
    assert.deepEqual(
      checkHooks({
        [PRE_PUSH]: { exists: true, indexMode: null },
        [PRE_MERGE]: { exists: true, indexMode: '100755' },
        [PRE_COMMIT]: { exists: true, indexMode: null },
      }),
      [],
    )
  })

  test('fails a missing hook or one git would ignore as not executable', () => {
    const details = checkHooks({
      [PRE_PUSH]: { exists: false, indexMode: null },
      [PRE_MERGE]: { exists: true, indexMode: '100644' },
    }).map((finding) => `${finding.file}: ${finding.detail}`)

    assert.deepEqual(details, [
      `${PRE_PUSH}: missing`,
      `${PRE_MERGE}: tracked as 100644; run: git update-index --chmod=+x ${PRE_MERGE}`,
      `${PRE_COMMIT}: missing`,
    ])
  })

  test('the hook files run verify in hook mode', () => {
    assert.deepEqual(HOOK_FILES, ['.githooks/pre-push', '.githooks/pre-merge-commit', '.githooks/pre-commit'])

    for (const file of HOOK_FILES) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      const mode = path.posix.basename(file)

      assert.match(text, /^#!\/bin\/sh\n/)
      assert.doesNotMatch(text, /\r/)
      assert.match(text, new RegExp(`^exec node scripts/verify\\.mjs --hook=${mode}$`, 'm'))
    }
  })
})

describe('release hooks in a repository (SB-19)', () => {
  // The real hooks in a throwaway repository whose scripts/verify.mjs is a
  // stub that logs each call and fails (or passes with STUB_PASS=1). Git
  // runs with no global or system configuration and none of this process's
  // GIT_* variables, so nothing reaches the project's repository.
  function setUpRepository(t) {
    const root = mkdtempSync(path.join(tmpdir(), 'sy-verify-hooks-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const repository = path.join(root, 'repo')
    const log = path.join(root, 'verify-calls.log')
    const emptyConfig = path.join(root, 'gitconfig')
    writeFileSync(emptyConfig, '')
    writeFileSync(log, '')

    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Verify Test',
      GIT_AUTHOR_EMAIL: 'verify-test@example.invalid',
      GIT_COMMITTER_NAME: 'Verify Test',
      GIT_COMMITTER_EMAIL: 'verify-test@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
      STUB_LOG: log,
    }

    const run = (args, extraEnv = {}) =>
      spawnSync('git', ['-c', `core.hooksPath=${path.join(repository, '.githooks')}`, ...args], {
        cwd: repository,
        encoding: 'utf8',
        env: { ...env, ...extraEnv },
        shell: false,
        timeout: 60_000,
        windowsHide: true,
      })
    const git = (args, extraEnv) => {
      const result = run(args, extraEnv)
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
      return result.stdout.trim()
    }
    const commitFile = (name, text, message, extraEnv) => {
      writeFileSync(path.join(repository, name), text)
      git(['add', name], extraEnv)
      git(['commit', '-q', '-m', message], extraEnv)
    }

    mkdirSync(path.join(repository, '.githooks'), { recursive: true })
    mkdirSync(path.join(repository, 'scripts'))

    for (const file of HOOK_FILES) {
      const target = path.join(repository, file)
      copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), target)
      chmodSync(target, 0o755)
    }

    writeFileSync(
      path.join(repository, 'scripts', 'verify.mjs'),
      "import { appendFileSync } from 'node:fs'\n" +
        "appendFileSync(process.env.STUB_LOG, `${process.argv.slice(2).join(' ')}\\n`)\n" +
        "process.exitCode = process.env.STUB_PASS === '1' ? 0 : 1\n",
    )

    const init = spawnSync('git', ['init', '-q', '-b', 'main', repository], {
      encoding: 'utf8',
      env,
      shell: false,
      timeout: 60_000,
      windowsHide: true,
    })
    assert.equal(init.status, 0, init.stderr)

    const calls = () => readFileSync(log, 'utf8').split('\n').filter((line) => line !== '')

    return { repository, run, git, commitFile, calls }
  }

  test('a merge into release/* is not committed while verify fails, however it is committed', (t) => {
    const { repository, run, git, commitFile, calls } = setUpRepository(t)

    commitFile('a.txt', 'a\n', 'base')
    git(['checkout', '-q', '-b', 'feat'])
    commitFile('b.txt', 'b\n', 'feature')
    git(['checkout', '-q', 'main'])
    git(['checkout', '-q', '-b', 'release/1'])
    assert.deepEqual(calls(), [])

    // Any commit on release/*: stopped while verify fails, created once it passes.
    writeFileSync(path.join(repository, 'c.txt'), 'c\n')
    git(['add', 'c.txt'])
    assert.notEqual(run(['commit', '-q', '-m', 'release note']).status, 0)
    git(['commit', '-q', '-m', 'release note'], { STUB_PASS: '1' })
    assert.deepEqual(calls(), ['--hook=pre-commit', '--hook=pre-commit'])
    const releaseHead = git(['rev-parse', 'HEAD'])

    // git merge: pre-merge-commit stops the merge commit git creates.
    assert.notEqual(run(['merge', '--no-ff', '--no-edit', 'feat']).status, 0)
    // `git commit`, as git then suggests, runs pre-commit, which stops it too.
    assert.notEqual(run(['commit', '--no-edit']).status, 0)
    assert.equal(git(['rev-parse', 'HEAD']), releaseHead)
    git(['merge', '--abort'])

    // --no-commit and --squash end in `git commit`: stopped the same way.
    git(['merge', '--no-ff', '--no-commit', 'feat'])
    assert.notEqual(run(['commit', '--no-edit']).status, 0)
    git(['merge', '--abort'])
    git(['merge', '--squash', 'feat'])
    assert.notEqual(run(['commit', '-m', 'squash']).status, 0)
    assert.equal(git(['rev-parse', 'HEAD']), releaseHead)
    git(['reset', '-q', '--hard'])

    assert.deepEqual(calls().slice(2), [
      '--hook=pre-merge-commit',
      '--hook=pre-commit',
      '--hook=pre-commit',
      '--hook=pre-commit',
    ])

    // With verify passing, the merge commit is created.
    git(['merge', '--no-ff', '--no-edit', 'feat'], { STUB_PASS: '1' })
    assert.equal(git(['rev-parse', 'HEAD^1']), releaseHead)
    assert.equal(git(['rev-parse', 'HEAD^2']), git(['rev-parse', 'feat']))
    assert.equal(calls().at(-1), '--hook=pre-merge-commit')
  })

  test('commits on other branches do not start verify', (t) => {
    const { git, commitFile, calls } = setUpRepository(t)

    commitFile('a.txt', 'a\n', 'base')
    git(['checkout', '-q', '-b', 'feature/release/x'])
    commitFile('b.txt', 'b\n', 'feature')
    assert.deepEqual(calls(), [])
  })
})


describe('plain verify on a release checkout (no --release)', () => {
  // The real verify, gates step only, in a throwaway repository under the
  // project's node_modules/.tmp (so it resolves typescript from the project;
  // its record goes to the throwaway's own node_modules). The one planted
  // file holds exactly one waived finding.
  const APP = fileURLToPath(new URL('..', import.meta.url))

  test('applies the waiver on main and refuses the waived finding on release/1 or at a release-* tag', (t) => {
    const scratch = path.join(APP, 'node_modules', '.tmp')
    mkdirSync(scratch, { recursive: true })
    const root = mkdtempSync(path.join(scratch, 'verify-release-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))

    const repository = path.join(root, 'repo')
    const emptyConfig = path.join(root, 'gitconfig')
    writeFileSync(emptyConfig, '')
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: emptyConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Verify Test',
      GIT_AUTHOR_EMAIL: 'verify-test@example.invalid',
      GIT_COMMITTER_NAME: 'Verify Test',
      GIT_COMMITTER_EMAIL: 'verify-test@example.invalid',
      GIT_TERMINAL_PROMPT: '0',
    }
    const spawn = (command, args, cwd = repository) =>
      spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        env,
        shell: false,
        timeout: 120_000,
        windowsHide: true,
      })
    const git = (args) => {
      const result = spawn('git', args)
      assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
    }
    const verify = () => spawn(process.execPath, ['scripts/verify.mjs', '--only=gates'])

    const waiver = BASELINE_WAIVERS.find(
      (entry) => entry.file === 'worker/notify/outbox.ts' && entry.detail === 'template key "released"',
    )
    assert.ok(waiver !== undefined)

    for (const file of ['scripts/verify.mjs', 'package.json', 'package-lock.json', ...HOOK_FILES]) {
      mkdirSync(path.dirname(path.join(repository, file)), { recursive: true })
      copyFileSync(path.join(APP, file), path.join(repository, file))
    }

    mkdirSync(path.join(repository, 'worker', 'notify'), { recursive: true })
    writeFileSync(
      path.join(repository, waiver.file),
      'export function reportReleased(released: number): void {\n  console.log(`OUTBOX_RELEASED released=${released}`)\n}\n',
    )
    writeFileSync(path.join(repository, '.gitignore'), 'node_modules\n')

    const init = spawn('git', ['init', '-q', '-b', 'main', repository], root)
    assert.equal(init.status, 0, init.stderr)
    git(['add', '.'])
    git(['add', '--chmod=+x', ...HOOK_FILES])
    git(['commit', '-q', '-m', 'base'])

    const onMain = verify()
    assert.equal(onMain.status, 0, onMain.stdout + onMain.stderr)
    assert.match(onMain.stdout, /gates: clean \(1 baseline finding\(s\) waived\)/)

    git(['checkout', '-q', '-b', 'release/1'])
    const onRelease = verify()
    assert.equal(onRelease.status, 1, onRelease.stdout + onRelease.stderr)
    assert.match(onRelease.stdout, /release run \(branch release\/1 is checked out\)/)
    assert.match(onRelease.stderr, /worker\/notify\/outbox\.ts:2 {2}template key "released"/)
    const record = JSON.parse(readFileSync(path.join(repository, 'node_modules', '.tmp', 'verify-record.json'), 'utf8'))
    assert.equal(record.strict, true)
    assert.equal(record.result, 'fail')

    git(['checkout', '-q', 'main'])
    git(['tag', '-a', '-m', 'release', 'release-2026-10-01'])
    const atTag = verify()
    assert.equal(atTag.status, 1, atTag.stdout + atTag.stderr)
    assert.match(atTag.stdout, /release run \(HEAD is tagged release-2026-10-01\)/)
    assert.match(atTag.stderr, /template key "released"/)
  })
})

describe('hook input', () => {
  const A = 'a'.repeat(40)
  const ZERO = '0'.repeat(40)

  test('parses the ref updates git passes to pre-push', () => {
    assert.deepEqual(
      parsePrePushInput(`refs/heads/main ${A} refs/heads/main ${ZERO}\r\n(delete) ${ZERO} refs/heads/old ${A}\n`),
      [
        { localRef: 'refs/heads/main', localSha: A, remoteRef: 'refs/heads/main', deletion: false },
        { localRef: '(delete)', localSha: ZERO, remoteRef: 'refs/heads/old', deletion: true },
      ],
    )
    assert.deepEqual(parsePrePushInput(''), [])
  })

  test('refuses anything else (fail closed)', () => {
    for (const text of ['garbage', `refs/heads/main ${A} refs/heads/main`, `refs/heads/main xyz refs/heads/main ${ZERO}`]) {
      assert.throws(() => parsePrePushInput(text), /unexpected input/)
    }
  })

  test('a release branch or tag is pushed without waivers', () => {
    for (const ref of ['refs/heads/release/1', 'refs/heads/release/2026-10', 'refs/tags/release-2026-10-01']) {
      assert.equal(isReleaseRef(ref), true, ref)
    }

    for (const ref of ['refs/heads/main', 'refs/heads/releases/1', 'refs/heads/feature/release/1', 'refs/tags/v1', 'release/1', 'HEAD']) {
      assert.equal(isReleaseRef(ref), false, ref)
    }
  })
})

describe('command line', () => {
  const run = (args, input = '') =>
    spawnSync(process.execPath, [VERIFY, ...args], {
      encoding: 'utf8',
      input,
      shell: false,
      timeout: 60_000,
      windowsHide: true,
    })

  test('modes and their steps', () => {
    const all = ['gates', 'lint', 'types', 'build', 'test']

    assert.deepEqual(parseOptions([]), { mode: 'manual', steps: all, release: false })
    assert.deepEqual(parseOptions(['--only=test,gates']), { mode: 'manual', steps: ['gates', 'test'], release: false })
    assert.deepEqual(parseOptions(['--release']), { mode: 'release', steps: all, release: true })
    assert.deepEqual(parseOptions(['--check-record']), { mode: 'check-record', steps: all, release: false })
    assert.deepEqual(parseOptions(['--check-record', '--release']), { mode: 'check-record', steps: all, release: true })

    for (const hook of ['pre-push', 'pre-merge-commit', 'pre-commit']) {
      assert.deepEqual(parseOptions([`--hook=${hook}`]), { mode: hook, steps: all, release: false })
    }
  })

  test('a push that only deletes refs is not verified; bad arguments are usage errors (exit 2)', () => {
    const A = 'a'.repeat(40)
    const ZERO = '0'.repeat(40)
    const deletion = run(['--hook=pre-push'], `(delete) ${ZERO} refs/heads/old ${A}\n`)
    assert.equal(deletion.status, 0, deletion.stderr)
    assert.match(deletion.stdout, /only deletes refs/)

    for (const args of [
      ['--bogus'],
      ['--only=deploy'],
      ['--hook=post-merge'],
      ['--hook=pre-push', '--only=gates'],
      ['--hook=pre-commit', '--release'],
      ['--only=gates', '--only=lint'],
      ['--release', '--only=gates'],
      ['--check-record', '--only=test'],
      ['--release', '--release'],
    ]) {
      assert.throws(() => parseOptions(args), /./, args.join(' '))
      assert.equal(run(args).status, 2, args.join(' '))
    }
  })
})

describe('entry (fails closed on every Node)', () => {
  const VERIFY_URL = pathToFileURL(VERIFY).href

  /** Node as it runs verify, optionally without import.meta.main and as another version. */
  function node(args, { olderNode = false, version } = {}) {
    const env = { ...process.env }
    delete env.VERIFY_FIXTURE_NODE_VERSION

    if (version !== undefined) {
      env.VERIFY_FIXTURE_NODE_VERSION = version
    }

    return spawnSync(process.execPath, [...(olderNode ? ['--import', OLD_NODE_HOOK] : []), ...args], {
      encoding: 'utf8',
      env,
      input: '',
      shell: false,
      timeout: 60_000,
      windowsHide: true,
    })
  }

  const importVerify = ['--input-type=module', '-e', `await import(${JSON.stringify(VERIFY_URL)})`]

  test('importing verify (as the tests do) runs nothing', () => {
    const imported = node(importVerify)
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(imported.stdout, '')
  })

  test('without import.meta.main, a supported Node still tells running from importing', () => {
    const usage = node([VERIFY, '--bogus'], { olderNode: true })
    assert.equal(usage.status, 2, usage.stderr)
    assert.match(usage.stderr, /Unexpected argument: --bogus/)

    const imported = node(importVerify, { olderNode: true })
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(imported.stdout, '')
  })

  test('a Node older than the floor is refused (exit 2), whether it runs or imports verify', () => {
    const refusal = new RegExp(
      `Node ${ENGINES_NODE.replaceAll('.', '\\.')} is required \\(this is 22\\.17\\.0\\); nothing was verified`,
    )

    for (const args of [[VERIFY, '--hook=pre-push'], [VERIFY], importVerify]) {
      const result = node(args, { olderNode: true, version: '22.17.0' })
      assert.equal(result.status, 2, args.join(' '))
      assert.match(result.stderr, refusal)
      assert.doesNotMatch(result.stdout, /== verify/)
    }
  })

  test('the floor', () => {
    assert.equal(ENGINES_NODE, '>=24.2.0')

    for (const version of ['24.2.0', '24.16.0', '25.0.0', '100.0.0']) {
      assert.equal(isSupportedNode(version), true, version)
    }

    for (const version of ['24.1.9', '24.0.0', '23.11.1', '22.18.0', '22.17.0', 'x', '']) {
      assert.equal(isSupportedNode(version), false, version)
    }
  })
})

describe('verify record (ties a pass to the reviewed content)', () => {
  const base = {
    head: 'a'.repeat(40),
    diff: Buffer.from('diff --git a/x.ts b/x.ts\n-1\n+2\n'),
    untracked: [{ path: 'worker/new.ts', content: Buffer.from('export {}\n') }],
  }

  test('the fingerprint changes with HEAD, any tracked change and any untracked file', () => {
    const fingerprint = fingerprintContent(base)
    assert.match(fingerprint, /^[0-9a-f]{64}$/)
    assert.equal(fingerprintContent({ ...base, untracked: [...base.untracked] }), fingerprint)

    for (const changed of [
      { ...base, head: 'b'.repeat(40) },
      { ...base, diff: Buffer.from('diff --git a/x.ts b/x.ts\n-1\n+3\n') },
      { ...base, untracked: [{ path: 'worker/new.ts', content: Buffer.from('export {} \n') }] },
      { ...base, untracked: [{ path: 'worker/other.ts', content: base.untracked[0].content }] },
      { ...base, untracked: [] },
      // Bytes moved from a file into its path do not collide.
      { ...base, untracked: [{ path: 'worker/new.tsexport {}', content: Buffer.from('\n') }] },
    ]) {
      assert.notEqual(fingerprintContent(changed), fingerprint)
    }
  })

  test('a record proves only a full pass of the same content', () => {
    const current = { head: base.head, fingerprint: fingerprintContent(base) }
    const record = {
      tool: 'scripts/verify.mjs',
      result: 'pass',
      mode: 'manual',
      strict: false,
      partial: false,
      fingerprint: current.fingerprint,
      git: { head: current.head },
    }

    assert.equal(recordProblem(record, current), null)
    assert.equal(recordProblem({ ...record, strict: true }, current, { release: true }), null)
    assert.match(recordProblem(record, current, { release: true }), /--release/)
    assert.match(recordProblem(null, current), /no verify record/)
    assert.match(recordProblem({ ...record, tool: 'other' }, current), /no verify record/)
    assert.match(recordProblem({ ...record, result: 'fail' }, current), /did not pass/)
    assert.match(recordProblem({ ...record, result: 'refused' }, current), /did not pass/)
    assert.match(recordProblem({ ...record, partial: true }, current), /partial/)
    assert.match(recordProblem({ ...record, fingerprint: null }, current), /fingerprint is missing/)
    assert.match(recordProblem(record, { ...current, fingerprint: null }), /fingerprint is missing/)
    assert.match(recordProblem({ ...record, git: { head: 'b'.repeat(40) } }, current), /not the one/)
    assert.match(
      recordProblem(record, { ...current, fingerprint: fingerprintContent({ ...base, untracked: [] }) }),
      /not the one/,
    )
  })
})
