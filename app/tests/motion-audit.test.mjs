// W2-21 / MOT-06 (12-motion-spec.md §7.3, §8.2; M7, TM-22): scripts/motion-audit.mjs
// is the classic-parity gate and the motion runtime audit. These tests cover
// every part that runs without Chrome: the strict argument allowlist, the
// redaction that keeps VITE_* values out of the output, the build environment
// (no inherited VITE_*, stub Firebase config), the Chrome command line (port 0
// on 127.0.0.1, temp profile), the DevToolsActivePort parser, the 127.0.0.1-only
// request filter, the static server's path resolution (no traversal, SPA
// fallback), the CSS normalisation and hash gate with its readable diff, the
// PNG codec and pixel comparison, the git ref guard and the cleanup ledger.
// No test starts Chrome, vite or npm.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUDGETS,
  DEFAULT_PATHS,
  PARITY_ROUTES,
  PARITY_VIEWPORTS,
  STUB_FIREBASE_ENV,
  USAGE,
  auditBuildEnvironment,
  chromeArguments,
  compareCss,
  compareImages,
  cssInventory,
  decodeDataUri,
  decodePng,
  diffLines,
  encodePng,
  findChrome,
  isAllowedRequest,
  main,
  normalizeAssetNames,
  normalizeCss,
  normalizeDom,
  npmCli,
  onCleanup,
  parseAuditArguments,
  parseDevToolsActivePort,
  redact,
  resolveCommit,
  resolveStaticPath,
  runCleanups,
  sha256,
  startStaticServer,
} from '../scripts/motion-audit.mjs'
import { ScriptFailure, UsageError } from '../scripts/lib/wrangler-d1.mjs'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const scriptSource = readFileSync(path.join(appRoot, 'scripts', 'motion-audit.mjs'), 'utf8')
const scratch = mkdtempSync(path.join(tmpdir(), 'sy-motion-audit-test-'))

after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function usageError(argv) {
  assert.throws(() => parseAuditArguments(argv), (error) => {
    assert.ok(error instanceof UsageError, `${JSON.stringify(argv)} must be a usage error`)
    assert.equal(error.exitCode, 2)
    return true
  })
}

function scriptFailure(run, pattern) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof ScriptFailure, 'must be a ScriptFailure')
    assert.ok(!(error instanceof UsageError), 'must not be a usage error')
    assert.equal(error.exitCode, 1)
    assert.match(error.message, pattern)
    return true
  })
}

/** A fixture build folder: { 'assets/<name>': text | Buffer } under `name`. */
function fixtureDist(name, files) {
  const distClient = path.join(scratch, name)

  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(distClient, ...relative.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }

  return distClient
}

/** GET `urlPath` on the audit's static server; resolves { status, headers, body }. */
function request(origin, urlPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const client = http.request(`${origin}${urlPath}`, { method }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })
      })
    })
    client.once('error', reject)
    client.end()
  })
}

describe('argument allowlist', () => {
  test('the documented command lines parse', () => {
    assert.deepEqual(parseAuditArguments(['parity', '--ref', 'HEAD']), {
      mode: 'parity',
      out: null,
      ref: 'HEAD',
      keep: false,
    })
    assert.deepEqual(parseAuditArguments(['parity', '--ref=design-classic-v1', '--keep', '--out=reports']), {
      mode: 'parity',
      out: path.resolve('reports'),
      ref: 'design-classic-v1',
      keep: true,
    })
    assert.deepEqual(parseAuditArguments(['runtime']), {
      mode: 'runtime',
      out: null,
      design: 'cinematic',
      build: true,
      throttle: false,
      loads: 10,
    })
    assert.deepEqual(parseAuditArguments(['runtime', '--design=classic', '--no-build', '--throttle', '--loads=3']), {
      mode: 'runtime',
      out: null,
      design: 'classic',
      build: false,
      throttle: true,
      loads: 3,
    })
    assert.deepEqual(parseAuditArguments(['--help']), { help: true })
    assert.deepEqual(parseAuditArguments(['-h']), { help: true })
  })

  test('the mode is required and must be parity or runtime', () => {
    usageError([])
    usageError(['build'])
    usageError(['--ref', 'HEAD'])
    usageError(['Parity', '--ref', 'HEAD'])
  })

  test('parity needs --ref and refuses anything that is not a plain git ref', () => {
    usageError(['parity'])
    usageError(['parity', '--ref'])
    usageError(['parity', '--ref', '--keep'])
    usageError(['parity', '--ref', '-rf'])
    usageError(['parity', '--ref', 'a..b'])
    usageError(['parity', '--ref', 'main branch'])
    usageError(['parity', '--ref', "x'y"])
    usageError(['parity', '--ref', 'HEAD', '--ref', 'HEAD'])
    usageError(['parity', '--ref', 'HEAD', '--keep', '--keep'])
    usageError(['parity', '--ref', 'HEAD', '--loads=3'])
    usageError(['parity', '--ref', 'HEAD', '--design=classic'])
    usageError(['parity', '--ref', 'HEAD', '--deploy'])
  })

  test('runtime options are spelled exactly and bounded', () => {
    usageError(['runtime', '--design=modern'])
    usageError(['runtime', '--design'])
    usageError(['runtime', '--loads=0'])
    usageError(['runtime', '--loads=51'])
    usageError(['runtime', '--loads=abc'])
    usageError(['runtime', '--loads=3', '--loads=3'])
    usageError(['runtime', '--ref', 'HEAD'])
    usageError(['runtime', '--keep'])
    usageError(['runtime', '--build'])
    usageError(['runtime', '--out='])
    usageError(['runtime', '--out=-x'])
    usageError(['runtime', 'extra'])
  })

  test('the usage text names both modes and the Chrome override', () => {
    assert.match(USAGE, /parity --ref <git-ref>/)
    assert.match(USAGE, /runtime \[--design=classic\|cinematic\]/)
    assert.match(USAGE, /CHROME_PATH/)
  })

  test('main prints the usage for --help and runs nothing', async () => {
    const lines = []
    const original = console.log
    console.log = (line) => lines.push(line)

    try {
      await main(['--help'])
    } finally {
      console.log = original
    }

    assert.deepEqual(lines, [USAGE])
  })
})

describe('redaction (TM-22: no VITE_* value is printed)', () => {
  test('VITE_* assignments are hidden', () => {
    assert.equal(redact('VITE_FIREBASE_API_KEY=AIzaSyRealKey123'), 'VITE_…=«redacted»')
    assert.equal(redact('VITE_FIREBASE_PROJECT_ID: my-project, next'), 'VITE_…=«redacted», next')
    assert.equal(redact('VITE_SITE_DESIGN=cinematic'), 'VITE_…=«redacted»')
  })

  test('plain text passes, line breaks stay, control and format characters are escaped', () => {
    assert.equal(redact('served on 127.0.0.1:4123'), 'served on 127.0.0.1:4123')
    assert.equal(redact('a\u001b[31mb\u200e'), 'a\\u{1b}[31mb\\u{200e}')
    assert.equal(redact('line one\nline two\r\n'), 'line one\nline two\\u{d}\n')
    assert.equal(redact('- a\n+ VITE_FIREBASE_API_KEY=secret\n'), '- a\n+ VITE_\u2026=\u00abredacted\u00bb\n')
  })
})

describe('build environment (M7: stub Firebase config, no inherited VITE_*)', () => {
  test('every VITE_* value, CLOUDFLARE_ENV and NODE_ENV are dropped; the stubs and the design are set', () => {
    const parent = {
      PATH: '/usr/bin',
      VITE_FIREBASE_API_KEY: 'real-key',
      vite_other: 'x',
      Vite_Mixed: 'y',
      VITE_SITE_DESIGN: 'cinematic',
      CLOUDFLARE_ENV: 'preview',
      NODE_ENV: 'development',
      npm_execpath: '/npm/npm-cli.js',
    }
    const snapshot = { ...parent }
    const child = auditBuildEnvironment(parent, 'classic')

    assert.deepEqual(parent, snapshot, 'the parent environment is not changed')
    assert.equal(child.PATH, '/usr/bin')
    assert.equal(child.npm_execpath, '/npm/npm-cli.js')
    assert.equal(child.VITE_SITE_DESIGN, 'classic')
    assert.equal(child.VITE_FIREBASE_API_KEY, '', 'the real key is replaced by the empty audit value')
    assert.equal('vite_other' in child, false)
    assert.equal('Vite_Mixed' in child, false)
    assert.equal('CLOUDFLARE_ENV' in child, false)
    assert.equal('NODE_ENV' in child, false)

    for (const [name, value] of Object.entries(STUB_FIREBASE_ENV)) {
      assert.equal(child[name], value)
    }
  })

  test('the audit configuration is the config guard\'s audit shape: every Firebase value explicitly empty', () => {
    assert.deepEqual(Object.keys(STUB_FIREBASE_ENV).sort(), [
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_APP_ID',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_MESSAGING_SENDER_ID',
      'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_STORAGE_BUCKET',
    ])
    assert.ok(Object.values(STUB_FIREBASE_ENV).every((value) => value === ''))
  })
})

describe('Chrome (TM-22)', () => {
  test('the command line uses a random loopback debugging port, a temp profile and no background traffic', () => {
    const profile = path.join(scratch, 'profile')
    const args = chromeArguments(profile)

    assert.ok(args.includes('--headless=new'))
    assert.ok(args.includes('--remote-debugging-port=0'))
    assert.ok(args.includes('--remote-debugging-address=127.0.0.1'))
    assert.ok(args.includes(`--user-data-dir=${profile}`))
    assert.ok(args.includes('--no-first-run'))
    assert.ok(args.includes('--disable-background-networking'))
    assert.ok(args.includes('--disable-component-update'))
    assert.ok(args.some((argument) => argument.startsWith('--host-resolver-rules=MAP * ~NOTFOUND')))
    assert.ok(args.some((argument) => argument.includes('EXCLUDE 127.0.0.1')))
    assert.equal(args.at(-1), 'about:blank')
    assert.ok(!args.some((argument) => /^--remote-debugging-port=(?!0$)/.test(argument)))
    assert.ok(!args.some((argument) => argument.startsWith('--remote-debugging-pipe')))
    assert.ok(!args.some((argument) => argument.startsWith('--proxy-server')))
  })

  test('DevToolsActivePort is read strictly', () => {
    assert.deepEqual(parseDevToolsActivePort('54321\n/devtools/browser/8d8a-4c1b\n'), {
      port: 54321,
      path: '/devtools/browser/8d8a-4c1b',
    })
    assert.deepEqual(parseDevToolsActivePort('54321\r\n/devtools/browser/abc'), {
      port: 54321,
      path: '/devtools/browser/abc',
    })
    assert.equal(parseDevToolsActivePort(''), null)
    assert.equal(parseDevToolsActivePort('54321'), null)
    assert.equal(parseDevToolsActivePort('0\n/devtools/browser/abc'), null)
    assert.equal(parseDevToolsActivePort('54321\n/devtools/page/abc'), null)
    assert.equal(parseDevToolsActivePort('54321\n/devtools/browser/../x'), null)
    assert.equal(parseDevToolsActivePort('54321\nws://evil/devtools/browser/abc'), null)
  })

  test('the browser binary comes from CHROME_PATH (a file) or the platform locations', () => {
    const fakeRoot = path.join(scratch, 'programs')
    const chrome = path.join(fakeRoot, 'Google', 'Chrome', 'Application', 'chrome.exe')
    mkdirSync(path.dirname(chrome), { recursive: true })
    writeFileSync(chrome, '')

    assert.equal(findChrome({ CHROME_PATH: chrome }, 'linux'), path.resolve(chrome))
    assert.equal(findChrome({ PROGRAMFILES: fakeRoot }, 'win32'), chrome)
    scriptFailure(() => findChrome({ CHROME_PATH: path.join(scratch, 'missing.exe') }, 'win32'), /CHROME_PATH/)
    scriptFailure(() => findChrome({ CHROME_PATH: fakeRoot }, 'win32'), /CHROME_PATH/)
    scriptFailure(() => findChrome({ PROGRAMFILES: path.join(scratch, 'nowhere') }, 'win32'), /Chrome was not found/)
    scriptFailure(() => findChrome({}, 'freebsd'), /Chrome was not found/)
  })

  test('only plain http to 127.0.0.1 on the audit ports continues; everything else is blocked', () => {
    const ports = new Set(['4123', '4124'])

    assert.equal(isAllowedRequest('http://127.0.0.1:4123/', ports), true)
    assert.equal(isAllowedRequest('http://127.0.0.1:4124/assets/index.css?v=1', ports), true)
    assert.equal(isAllowedRequest('http://127.0.0.1:4125/', ports), false)
    assert.equal(isAllowedRequest('http://127.0.0.1/', ports), false)
    assert.equal(isAllowedRequest('https://127.0.0.1:4123/', ports), false)
    assert.equal(isAllowedRequest('http://localhost:4123/', ports), false)
    assert.equal(isAllowedRequest('http://[::1]:4123/', ports), false)
    assert.equal(isAllowedRequest('http://127.0.0.2:4123/', ports), false)
    assert.equal(isAllowedRequest('http://127.0.0.1:4123@evil.example/', ports), false)
    assert.equal(isAllowedRequest('https://www.googleapis.com/identitytoolkit/v3', ports), false)
    assert.equal(isAllowedRequest('https://audit-stub.firebaseapp.com/__/auth/iframe', ports), false)
    assert.equal(isAllowedRequest('ws://127.0.0.1:4123/', ports), false)
    assert.equal(isAllowedRequest('data:text/plain,hi', ports), false)
    assert.equal(isAllowedRequest('not a url', ports), false)
    assert.equal(isAllowedRequest('', ports), false)
  })
})

describe('static server (dist/client only, SPA fallback)', () => {
  const root = fixtureDist('serve', {
    'index.html': '<!doctype html><html lang="ar" dir="rtl"><body>home</body></html>',
    'assets/index-abcdefgh.css': 'body{margin:0}',
    'images/hero.avif': Buffer.from([0, 1, 2, 3]),
  })
  writeFileSync(path.join(scratch, 'outside.txt'), 'secret')

  test('path resolution never leaves the root', () => {
    assert.deepEqual(resolveStaticPath(root, '/index.html'), { kind: 'file', file: path.join(root, 'index.html') })
    assert.deepEqual(resolveStaticPath(root, '/assets/index-abcdefgh.css'), {
      kind: 'file',
      file: path.join(root, 'assets', 'index-abcdefgh.css'),
    })
    assert.deepEqual(resolveStaticPath(root, '/'), { kind: 'fallback' })
    assert.deepEqual(resolveStaticPath(root, '/portfolio'), { kind: 'fallback' })
    assert.deepEqual(resolveStaticPath(root, '/my-bookings'), { kind: 'fallback' })
    assert.deepEqual(resolveStaticPath(root, '/assets'), { kind: 'fallback' })
    assert.deepEqual(resolveStaticPath(root, '/images/missing.avif'), { kind: 'missing' })
    assert.deepEqual(resolveStaticPath(root, '/../outside.txt'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, '/assets/../../outside.txt'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, '/%2e%2e/outside.txt'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, '/..%2Foutside.txt'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, '/assets\\..\\..\\outside.txt'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, '/%5c..%5coutside.txt'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, '/index.html%00.png'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, '/C:/Windows/win.ini'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, 'http://127.0.0.1/index.html'), { kind: 'bad' })
    assert.deepEqual(resolveStaticPath(root, '/%E0%A4%A'), { kind: 'bad' })
  })

  test('the server binds 127.0.0.1, answers GET/HEAD only and falls back for routes but not /api', async () => {
    const server = await startStaticServer(root)

    try {
      assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/)

      const home = await request(server.origin, '/')
      assert.equal(home.status, 200)
      assert.equal(home.headers['content-type'], 'text/html; charset=utf-8')
      assert.equal(home.headers['cache-control'], 'no-store')
      assert.equal(home.headers['x-content-type-options'], 'nosniff')
      assert.match(home.body.toString('utf8'), /home/)

      const css = await request(server.origin, '/assets/index-abcdefgh.css?v=2')
      assert.equal(css.status, 200)
      assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')
      assert.equal(css.body.toString('utf8'), 'body{margin:0}')

      const image = await request(server.origin, '/images/hero.avif')
      assert.equal(image.status, 200)
      assert.equal(image.headers['content-type'], 'image/avif')
      assert.deepEqual([...image.body], [0, 1, 2, 3])

      const route = await request(server.origin, '/portfolio')
      assert.equal(route.status, 200)
      assert.match(route.body.toString('utf8'), /home/)

      const api = await request(server.origin, '/api/bookings')
      assert.equal(api.status, 404)
      assert.deepEqual(JSON.parse(api.body.toString('utf8')), { error: { code: 'AUDIT_OFFLINE' } })

      const missing = await request(server.origin, '/images/missing.avif')
      assert.equal(missing.status, 404)

      const traversal = await request(server.origin, '/assets/..%2F..%2Foutside.txt')
      assert.equal(traversal.status, 400)
      assert.deepEqual(JSON.parse(traversal.body.toString('utf8')), { error: { code: 'BAD_PATH' } })

      const head = await request(server.origin, '/index.html', 'HEAD')
      assert.equal(head.status, 200)
      assert.equal(head.body.length, 0)

      const post = await request(server.origin, '/api/bookings', 'POST')
      assert.equal(post.status, 405)
      assert.equal(post.headers.allow, 'GET, HEAD')
    } finally {
      await server.close()
    }
  })
})

describe('CSS gate (M7: sha256 of every emitted stylesheet, url() bytes hashed)', () => {
  const font = Buffer.from('woff2-bytes-of-the-font')
  const css = (fontName) => `@font-face{font-family:"Cairo";src:url(/assets/${fontName}) format("woff2")}body{margin:0}`

  test('hashed asset names normalise to <name>.<ext>', () => {
    assert.equal(normalizeAssetNames('/assets/index-mDp_qCTe.css'), '/assets/index.css')
    assert.equal(normalizeAssetNames('<link href="/assets/PortfolioPage-DK5gaIDz.css">'), '<link href="/assets/PortfolioPage.css">')
    assert.equal(normalizeAssetNames('url(/assets/cairo-arabic-400-A1b2C3d4.woff2)'), 'url(/assets/cairo-arabic-400.woff2)')
    assert.equal(normalizeAssetNames('/images/hero-wide.avif'), '/images/hero-wide.avif')
    assert.equal(normalizeAssetNames('/assets/short-abc.css'), '/assets/short-abc.css')
  })

  test('the DOM gate drops the server origin and the preload helper links, keeps stylesheet links in order', () => {
    const html = [
      '<html lang="ar" dir="rtl"><head>',
      '<link rel="stylesheet" crossorigin="" href="/assets/index-mDp_qCTe.css">',
      '<link rel="modulepreload" as="script" crossorigin="" href="http://127.0.0.1:62502/assets/PortfolioPage-D1Upa_Yp.js">',
      '<link rel="stylesheet" crossorigin="" href="http://127.0.0.1:62502/assets/PortfolioPage-DK5gaIDz.css">',
      '<link as="script" rel="modulepreload" href="http://127.0.0.1:62502/assets/firebase-C92aB03N.js" crossorigin="">',
      '</head><body><img src="/images/hero.avif"><a href="http://127.0.0.1:62502/packages">x</a></body></html>',
    ].join('')
    const other = html.replaceAll('127.0.0.1:62502', '127.0.0.1:62503').replaceAll('D1Upa_Yp', 'Zz9yX8wV')

    assert.equal(
      normalizeDom(html, 'http://127.0.0.1:62502'),
      [
        '<html lang="ar" dir="rtl"><head>',
        '<link rel="stylesheet" crossorigin="" href="/assets/index.css">',
        '<link rel="stylesheet" crossorigin="" href="/assets/PortfolioPage.css">',
        '</head><body><img src="/images/hero.avif"><a href="/packages">x</a></body></html>',
      ].join(''),
    )
    assert.equal(normalizeDom(html, 'http://127.0.0.1:62502'), normalizeDom(other, 'http://127.0.0.1:62503'))
    assert.notEqual(
      normalizeDom(html, 'http://127.0.0.1:62502'),
      normalizeDom(html.replace('<img src="/images/hero.avif">', '<img src="/images/hero.avif" loading="lazy">'), 'http://127.0.0.1:62502'),
    )
  })

  test('data: URIs decode (base64 and percent-encoded)', () => {
    assert.equal(decodeDataUri('data:text/plain;base64,aGVsbG8=').toString('utf8'), 'hello')
    assert.equal(decodeDataUri('data:text/plain,hello%20world').toString('utf8'), 'hello world')
    assert.equal(decodeDataUri('data:,').length, 0)
    assert.equal(decodeDataUri('/assets/x.woff2'), null)
    assert.equal(decodeDataUri('data:font/woff2,%E0%A4%A'), null)
  })

  test('two builds with different hashed names but the same bytes compare equal', () => {
    const reference = fixtureDist('css-reference', {
      'assets/index-aaaaaaaa.css': css('cairo-bbbbbbbb.woff2'),
      'assets/cairo-bbbbbbbb.woff2': font,
    })
    const head = fixtureDist('css-head', {
      'assets/index-cccccccc.css': css('cairo-dddddddd.woff2'),
      'assets/cairo-dddddddd.woff2': font,
    })
    const result = compareCss(cssInventory(reference), cssInventory(head))

    assert.deepEqual(result, { ok: true, problems: [] })
    assert.deepEqual([...cssInventory(head).keys()], ['/assets/index.css'])
    assert.equal(cssInventory(head).get('/assets/index.css').normalizedSha256, cssInventory(reference).get('/assets/index.css').normalizedSha256)
    assert.notEqual(cssInventory(head).get('/assets/index.css').rawSha256, cssInventory(reference).get('/assets/index.css').rawSha256)
  })

  test('an inlined data: URI equals an emitted file with the same bytes (TM-14, W1 #62)', () => {
    const inlined = fixtureDist('css-inlined', {
      'assets/index-aaaaaaaa.css': `@font-face{font-family:"Cairo";src:url(data:font/woff2;base64,${font.toString('base64')}) format("woff2")}body{margin:0}`,
    })
    const emitted = fixtureDist('css-emitted', {
      'assets/index-eeeeeeee.css': css('cairo-ffffffff.woff2'),
      'assets/cairo-ffffffff.woff2': font,
    })

    assert.equal(compareCss(cssInventory(inlined), cssInventory(emitted)).ok, true)
    assert.match(normalizeCss(css('cairo-ffffffff.woff2'), { distClient: emitted, cssFile: path.join(emitted, 'assets', 'index-eeeeeeee.css') }), new RegExp(`url\\(sha256:${sha256(font)}\\)`))
  })

  test('a referenced file with different bytes or a missing file fails the gate', () => {
    const reference = fixtureDist('css-font-reference', {
      'assets/index-aaaaaaaa.css': css('cairo-bbbbbbbb.woff2'),
      'assets/cairo-bbbbbbbb.woff2': font,
    })
    const changedFont = fixtureDist('css-font-changed', {
      'assets/index-aaaaaaaa.css': css('cairo-bbbbbbbb.woff2'),
      'assets/cairo-bbbbbbbb.woff2': Buffer.concat([font, Buffer.from('!')]),
    })
    const missingFont = fixtureDist('css-font-missing', {
      'assets/index-aaaaaaaa.css': css('cairo-bbbbbbbb.woff2'),
    })

    assert.equal(compareCss(cssInventory(reference), cssInventory(changedFont)).ok, false)
    const missing = compareCss(cssInventory(reference), cssInventory(missingFont))
    assert.equal(missing.ok, false)
    assert.match(missing.problems[0].diff, /url\(missing:\/assets\/cairo\.woff2\)/)
  })

  test('one changed byte fails with a readable diff naming the stylesheet and both lines', () => {
    const reference = fixtureDist('css-byte-reference', {
      'assets/index-aaaaaaaa.css': 'body{margin:0}.site-header{padding:12px}.btn{color:#111}',
      'assets/PortfolioPage-aaaaaaaa.css': '.tile{display:grid}',
    })
    const head = fixtureDist('css-byte-head', {
      'assets/index-bbbbbbbb.css': 'body{margin:0}.site-header{padding:13px}.btn{color:#111}',
      'assets/PortfolioPage-bbbbbbbb.css': '.tile{display:grid}',
    })
    const result = compareCss(cssInventory(reference), cssInventory(head))

    assert.equal(result.ok, false)
    assert.equal(result.problems.length, 1)
    assert.equal(result.problems[0].name, '/assets/index.css')
    assert.match(result.problems[0].detail, /sha256 [0-9a-f]{12}… \(reference\) ≠ [0-9a-f]{12}… \(working tree\)/)
    assert.match(result.problems[0].diff, /^@@ line \d+: -\d+ \+\d+ @@/)
    assert.match(result.problems[0].diff, /^- padding:12px;?$/m)
    assert.match(result.problems[0].diff, /^\+ padding:13px;?$/m)
  })

  test('a stylesheet emitted by one build only is a failure in both directions', () => {
    const reference = fixtureDist('css-only-reference', {
      'assets/index-aaaaaaaa.css': 'body{margin:0}',
      'assets/Extra-aaaaaaaa.css': '.x{top:0}',
    })
    const head = fixtureDist('css-only-head', {
      'assets/index-aaaaaaaa.css': 'body{margin:0}',
      'assets/New-aaaaaaaa.css': '.y{top:0}',
    })
    const result = compareCss(cssInventory(reference), cssInventory(head))

    assert.equal(result.ok, false)
    assert.deepEqual(
      result.problems.map((problem) => [problem.name, problem.detail]).sort(),
      [
        ['/assets/Extra.css', 'emitted by the reference build only'],
        ['/assets/New.css', 'emitted by the working-tree build only'],
      ],
    )
  })

  test('the diff trims the common prefix and suffix and keeps two lines of context', () => {
    assert.equal(diffLines(['a', 'b'], ['a', 'b']), '')
    const diff = diffLines(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'X', 'e', 'f'])
    assert.equal(diff, ['@@ line 4: -1 +1 @@', '  b', '  c', '- d', '+ X'].join('\n'))
    const added = diffLines(['a'], ['a', 'b', 'c'])
    assert.equal(added, ['@@ line 2: -0 +2 @@', '  a', '+ b', '+ c'].join('\n'))
  })
})

describe('screenshots (PNG codec and ≤ 0.1% pixel tolerance)', () => {
  function image(width, height, paint) {
    const rgba = new Uint8Array(width * height * 4)

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [r, g, b] = paint(x, y)
        const at = (y * width + x) * 4
        rgba[at] = r
        rgba[at + 1] = g
        rgba[at + 2] = b
        rgba[at + 3] = 255
      }
    }

    return { width, height, rgba }
  }

  test('encode and decode round-trip', () => {
    const source = image(7, 5, (x, y) => [x * 30, y * 50, (x + y) * 10])
    const decoded = decodePng(encodePng(source))

    assert.equal(decoded.width, 7)
    assert.equal(decoded.height, 5)
    assert.deepEqual([...decoded.rgba], [...source.rgba])
    scriptFailure(() => decodePng(Buffer.from('not a png')), /not a PNG/)
  })

  test('identical images differ by 0; a changed block is counted and marked red in the diff image', () => {
    const base = image(100, 100, () => [250, 245, 240])
    const same = compareImages(base, image(100, 100, () => [251, 246, 241]))
    assert.equal(same.ratio, 0)
    assert.equal(same.differing, 0)

    const changed = compareImages(base, image(100, 100, (x, y) => (x < 10 && y < 10 ? [20, 20, 20] : [250, 245, 240])))
    assert.equal(changed.differing, 100)
    assert.equal(changed.total, 10_000)
    assert.equal(changed.ratio, 0.01)
    assert.ok(changed.ratio > BUDGETS.screenshotDiffRatio)
    assert.deepEqual([...changed.diff.rgba.subarray(0, 4)], [220, 30, 30, 255])
    assert.notDeepEqual([...changed.diff.rgba.subarray((50 * 100 + 50) * 4, (50 * 100 + 50) * 4 + 3)], [220, 30, 30])

    const sizes = compareImages(base, image(100, 50, () => [250, 245, 240]))
    assert.equal(sizes.ratio, 1)
    assert.equal(sizes.diff, null)
  })

  test('the budget is 0.1% and the parity routes and viewports are the ones of §7.3', () => {
    assert.equal(BUDGETS.screenshotDiffRatio, 0.001)
    assert.deepEqual([...PARITY_ROUTES], ['/', '/portfolio', '/packages', '/my-bookings'])
    assert.deepEqual(
      PARITY_VIEWPORTS.map((viewport) => `${viewport.width}x${viewport.height}`),
      ['375x812', '1280x800'],
    )
    assert.equal(BUDGETS.heroReadyAfterT0Ms, 2200)
    assert.equal(BUDGETS.introGoneAfterT0Ms, 2000)
  })
})

describe('git and npm (read-only, no shell)', () => {
  test('resolveCommit returns the full sha of a real ref and refuses option-shaped or unknown refs', () => {
    assert.match(resolveCommit('HEAD'), /^[0-9a-f]{40}$/)
    assert.throws(() => resolveCommit('--output=/tmp/x'), UsageError)
    assert.throws(() => resolveCommit('-x'), UsageError)
    assert.throws(() => resolveCommit('a..b'), UsageError)
    scriptFailure(() => resolveCommit('no-such-ref-for-the-motion-audit'), /is not a commit of this repository/)
  })

  test('npmCli prefers npm_execpath and falls back to the npm next to node', () => {
    const fake = path.join(scratch, 'fake-npm', 'npm-cli.js')
    mkdirSync(path.dirname(fake), { recursive: true })
    writeFileSync(fake, '')

    assert.equal(npmCli({ npm_execpath: fake }), path.resolve(fake))
    const nodeDirectory = path.join(scratch, 'fake-node')
    mkdirSync(path.join(nodeDirectory, 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
    assert.equal(
      npmCli({}, path.join(nodeDirectory, 'node.exe')),
      path.resolve(path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
    )
    scriptFailure(() => npmCli({ npm_execpath: '/usr/bin/npm' }, path.join(scratch, 'empty', 'node')), /npm-cli\.js was not found/)
  })

  test('the source spawns without a shell and uses git for rev-parse and worktrees only', () => {
    assert.doesNotMatch(scriptSource, /shell:\s*true/)
    assert.doesNotMatch(scriptSource, /(?<![.\w])exec(?:Sync|File|FileSync)?\s*\(/)
    assert.doesNotMatch(scriptSource, /\bimport\s*\{[^}]*\bexec/)
    const gitCalls = [...scriptSource.matchAll(/git\(\['([a-z-]+)'/g)].map((match) => match[1])
    assert.ok(gitCalls.length >= 3)
    assert.deepEqual([...new Set(gitCalls)].sort(), ['rev-parse', 'worktree'])
    assert.doesNotMatch(scriptSource, /'(?:checkout|commit|reset|stash|push|rebase|config)'/)
    assert.match(scriptSource, /--remote-debugging-port=0/)
    assert.doesNotMatch(scriptSource, /process\.env\.VITE_/)
  })
})

describe('cleanup ledger (Ctrl+C included)', () => {
  test('steps run in reverse order, once, and a forgotten step does not run', () => {
    const order = []
    onCleanup('first', () => order.push('first'))
    const forget = onCleanup('second', () => order.push('second'))
    onCleanup('third', () => order.push('third'))
    forget()
    runCleanups()
    runCleanups()

    assert.deepEqual(order, ['third', 'first'])
  })

  test('a failing step is reported and the others still run', () => {
    const order = []
    const errors = []
    const original = console.error
    console.error = (line) => errors.push(line)
    onCleanup('a', () => order.push('a'))
    onCleanup('b', () => {
      const error = new Error('busy')
      error.code = 'EBUSY'
      throw error
    })
    onCleanup('c', () => order.push('c'))

    try {
      runCleanups()
    } finally {
      console.error = original
    }

    assert.deepEqual(order, ['c', 'a'])
    assert.deepEqual(errors, ['motion-audit: cleanup "b" did not finish (EBUSY).'])
  })
})

describe('package.json', () => {
  test('audit:motion and audit:parity reach the script', () => {
    const pkg = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'))

    assert.equal(pkg.scripts['audit:motion'], 'node scripts/motion-audit.mjs runtime')
    assert.equal(pkg.scripts['audit:parity'], 'node scripts/motion-audit.mjs parity')
    assert.equal(DEFAULT_PATHS.distClient, path.join(appRoot, 'dist', 'client'))
  })

  test('sha256 is hex of the bytes', () => {
    assert.equal(sha256(Buffer.from('abc')), createHash('sha256').update('abc').digest('hex'))
  })
})
