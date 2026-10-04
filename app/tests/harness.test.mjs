// W1-13 (M6): the test harness itself. Each case fails if its control is
// removed: the resolve hook (tests/setup/resolve-ts.mjs) that lets tests
// import the TypeScript sources, the network guard (tests/setup/no-network.mjs)
// in this process and in Node child processes, and `npm test` being exactly
// the command verify runs.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import dgram from 'node:dgram'
import dns from 'node:dns'
import { lookup as promisedLookup } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import { describe, test } from 'node:test'

import { TEST_SCRIPT } from '../scripts/verify.mjs'

// What the command line (`npm test`) set up, observed before this file
// imports the setup modules itself (importing them would install them).
const GUARD_MARKER = Symbol.for('sundus-yar.tests.no-network')
const guardFromCommandLine = net.Socket.prototype[GUARD_MARKER] === true

async function importFixture() {
  try {
    return await import('./fixtures/resolve-ts/entry.mjs')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      return null
    }

    throw error
  }
}

const fixtureFromCommandLine = await importFixture()
const { NETWORK_BLOCKED_CODE, isLoopbackHost } = await import('./setup/no-network.mjs')
const { resolve, tsSiblingOf } = await import('./setup/resolve-ts.mjs')

const APP_URL = new URL('../', import.meta.url).href
const PARENT = new URL('../worker/index.ts', import.meta.url).href
const BLOCKED = { code: NETWORK_BLOCKED_CODE }
/** RFC 5737 TEST-NET-1: documentation-only, answered by no host on the internet. */
const REMOTE_IP = '192.0.2.1'

/** Checked first in every network case, so no case can reach the network. */
function assertGuardLoaded() {
  assert.equal(
    net.Socket.prototype[GUARD_MARKER],
    true,
    'tests/setup/no-network.mjs is not loaded (run through npm test)',
  )
}

function moduleNotFound(specifier) {
  return Object.assign(new Error(`Cannot find module '${specifier}'`), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
}

/** A nextResolve that knows only the given specifiers. */
function fakeResolver(known) {
  const calls = []

  async function nextResolve(specifier) {
    calls.push(specifier)

    if (known.includes(specifier)) {
      return { url: `resolved:${specifier}` }
    }

    throw moduleNotFound(specifier)
  }

  return { calls, nextResolve }
}

describe('resolve-ts hook', () => {
  test('npm test registers it: .js and extensionless specifiers reach the .ts files', () => {
    assert.notEqual(
      fixtureFromCommandLine,
      null,
      'npm test must load tests/setup/resolve-ts.mjs with --import',
    )
    assert.equal(fixtureFromCommandLine.jsSpecifier, 'js-specifier.ts')
    assert.equal(fixtureFromCommandLine.bareSpecifier, 'bare-specifier.ts')
  })

  test('a specifier with no .ts sibling fails with the original error', async () => {
    await assert.rejects(import('./fixtures/resolve-ts/missing.js'), (error) => {
      assert.equal(error.code, 'ERR_MODULE_NOT_FOUND')
      assert.match(error.message, /missing\.js/)
      assert.doesNotMatch(error.message, /missing\.ts/)
      return true
    })
  })

  test('maps only relative .js or extensionless specifiers of local files outside node_modules', () => {
    assert.equal(tsSiblingOf('./http.js', PARENT), './http.ts')
    assert.equal(tsSiblingOf('../shared/text.js', PARENT), '../shared/text.ts')
    assert.equal(tsSiblingOf('./api-client', PARENT), './api-client.ts')
    assert.equal(tsSiblingOf('../lib', PARENT), '../lib.ts')

    for (const specifier of ['jose', 'node:fs', '/abs/x.js', 'file:///x.js', './a.css', './b.tsx', './c.json', './', '../']) {
      assert.equal(tsSiblingOf(specifier, PARENT), null, specifier)
    }

    // A copy of the sources in a temporary folder (planted-violation tests).
    assert.equal(tsSiblingOf('./http.js', 'file:///tmp/w1-04-slots-x/worker/index.ts'), './http.ts')
    assert.equal(tsSiblingOf('./x.js', `${APP_URL}node_modules/pkg/index.js`), null)
    assert.equal(tsSiblingOf('./x.js', `${APP_URL}Node_Modules/pkg/index.js`), null)
    assert.equal(tsSiblingOf('./x.js', 'https://example.com/a.mjs'), null)
    assert.equal(tsSiblingOf('./x.js', 'data:text/javascript,0'), null)
    assert.equal(tsSiblingOf('./x.js', undefined), null)
  })

  test('resolve retries the sibling only after ERR_MODULE_NOT_FOUND', async () => {
    const found = fakeResolver(['./a.js'])
    assert.deepEqual(await resolve('./a.js', { parentURL: PARENT }, found.nextResolve), { url: 'resolved:./a.js' })
    assert.deepEqual(found.calls, ['./a.js'])

    const sibling = fakeResolver(['./b.ts'])
    assert.deepEqual(await resolve('./b.js', { parentURL: PARENT }, sibling.nextResolve), { url: 'resolved:./b.ts' })
    assert.deepEqual(sibling.calls, ['./b.js', './b.ts'])

    const otherFailure = new TypeError('bad specifier')
    await assert.rejects(
      resolve('./c.js', { parentURL: PARENT }, async () => {
        throw otherFailure
      }),
      (error) => error === otherFailure,
    )

    const nothing = fakeResolver([])
    await assert.rejects(
      resolve('./d.js', { parentURL: PARENT }, nothing.nextResolve),
      (error) => error.message.includes("'./d.js'"),
    )

    const bare = fakeResolver([])
    await assert.rejects(resolve('pkg', { parentURL: PARENT }, bare.nextResolve), {
      code: 'ERR_MODULE_NOT_FOUND',
    })
    assert.deepEqual(bare.calls, ['pkg'])
  })
})

describe('no-network guard', () => {
  test('npm test installs it before any test file runs', () => {
    assert.equal(
      guardFromCommandLine,
      true,
      'npm test must load tests/setup/no-network.mjs with --import',
    )
  })

  test('recognises loopback hosts only', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
      assert.equal(isLoopbackHost(host), true, host)
    }

    for (const host of [REMOTE_IP, 'example.com', 'localhost.example.com', '::ffff:192.0.2.1', '10.0.0.1', '', undefined, null]) {
      assert.equal(isLoopbackHost(host), false, String(host))
    }
  })

  test('TCP and TLS to a remote host are refused before any lookup', () => {
    assertGuardLoaded()
    assert.throws(() => net.connect({ host: REMOTE_IP, port: 9 }), BLOCKED)
    assert.throws(() => net.connect(9, 'example.com'), BLOCKED)
    assert.throws(() => new net.Socket().connect({ host: 'example.com', port: 80 }), BLOCKED)
    assert.throws(() => tls.connect({ host: 'example.com', port: 443 }), BLOCKED)
    assert.throws(() => net.connect({ path: `\\\\${REMOTE_IP}\\pipe\\x` }), BLOCKED)
    assert.throws(() => new net.Socket().connect(`\\\\${REMOTE_IP}\\pipe\\x`), BLOCKED)
  })

  test('fetch to a remote host rejects with the guard as its cause', async () => {
    assertGuardLoaded()

    for (const url of [`http://${REMOTE_IP}/`, 'https://example.com/']) {
      await assert.rejects(fetch(url), (error) => error.cause?.code === NETWORK_BLOCKED_CODE)
    }
  })

  test('DNS queries and UDP are refused', async () => {
    assertGuardLoaded()
    assert.throws(() => dns.lookup('example.com', () => {}), BLOCKED)
    assert.throws(() => dns.resolve4('example.com', () => {}), BLOCKED)
    assert.throws(() => new dns.Resolver().resolveTxt('example.com', () => {}), BLOCKED)
    await assert.rejects(promisedLookup('example.com'), BLOCKED)
    await assert.rejects(dns.promises.resolveMx('example.com'), BLOCKED)
    await assert.rejects(new dns.promises.Resolver().resolve6('example.com'), BLOCKED)

    const socket = dgram.createSocket('udp4')

    try {
      assert.throws(() => socket.send('x', 9, REMOTE_IP), BLOCKED)
      assert.throws(() => socket.bind(0), BLOCKED)
    } finally {
      socket.close()
    }
  })

  test('loopback stays usable for a test that serves itself', async () => {
    assertGuardLoaded()
    assert.equal(typeof (await promisedLookup('localhost')).address, 'string')

    const server = net.createServer((connection) => connection.end())

    try {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(0, '127.0.0.1', resolveListen)
      })

      const client = net.connect(server.address().port, '127.0.0.1')

      try {
        await new Promise((resolveConnect, rejectConnect) => {
          client.once('connect', resolveConnect)
          client.once('error', rejectConnect)
        })
      } finally {
        client.destroy()
      }
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  })

  test('a Node child process started by a test is guarded too', () => {
    assertGuardLoaded()

    const child = spawnSync(
      process.execPath,
      ['-e', `require('node:net').connect({ host: '${REMOTE_IP}', port: 9 })`],
      { encoding: 'utf8', shell: false, timeout: 30_000, windowsHide: true },
    )

    assert.notEqual(child.status, 0)
    assert.match(child.stderr, new RegExp(NETWORK_BLOCKED_CODE))
  })
})

describe('npm test', () => {
  test('package.json runs the harness command verify runs', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

    assert.equal(manifest.scripts.test, TEST_SCRIPT)
    assert.match(TEST_SCRIPT, /--import \.\/tests\/setup\/no-network\.mjs/)
    assert.match(TEST_SCRIPT, /--import \.\/tests\/setup\/resolve-ts\.mjs/)
    assert.match(TEST_SCRIPT, /--test "tests\/\*\*\/\*\.test\.mjs"$/)
  })
})
