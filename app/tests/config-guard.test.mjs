// W2-18 / H1, C-9, C-10, TM-14, N-53, SB-8: the Firebase config guard and the
// security-header checks of scripts/config-guard.mjs, run against the
// committed public/_headers, index.html and wrangler.jsonc. Each case fails
// if its control is taken out: a mismatching project id or auth domain is no
// longer refused, the auth domain no longer has to be in frame-src, the
// inline-script hash no longer has to be in script-src, a header or CSP
// directive of the baseline disappears from _headers, the main policy is
// enforced in the source file, the CSP_MODE=enforce rewrite stops producing a
// policy that passes the enforced checks, a finding starts echoing an env
// value, or vite.config.ts stops wiring the guard. No test runs vite.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CSP_MODES,
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  SITE_HEADERS_PATH,
  checkBuildConfig,
  checkSecurityHeaders,
  cspHeadersOf,
  enforceCspHeaders,
  expectedAuthDomain,
  formatFindings,
  inlineScriptHashes,
  isEnvironmentName,
  isFirebaseAuthDomain,
  isFirebaseProjectId,
  parseCsp,
  parseCspMode,
  parseHeadersFile,
  parseWranglerConfig,
  workerVars,
} from '../scripts/config-guard.mjs'
import * as guard from '../scripts/config-guard.mjs'

const read = (relativePath) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

const headersText = read('public/_headers')
const indexHtml = read('index.html')
const wranglerText = read('wrangler.jsonc')
const viteConfig = read('vite.config.ts')
const declarations = read('scripts/config-guard.d.mts')

/** The project whose default auth domain the committed frame-src allows. */
const ALLOWED_PROJECT = 'sundus-yar-website'
/** A project that is valid but not in frame-src (a new project, D16). */
const OTHER_PROJECT = 'sy-prod-k7q2x'
/** Values no finding may ever echo (SB-8). */
const SECRET_LIKE = [OTHER_PROJECT, `${OTHER_PROJECT}.firebaseapp.com`]

const codesOf = (findings) => findings.map((finding) => finding.code)

/**
 * The _headers text with the first line that starts with `name:` under /*
 * replaced (or removed when `replacement` is null).
 */
function editSiteHeader(name, replacement) {
  const lines = headersText.split('\n')
  const index = lines.findIndex((line) =>
    new RegExp(`^\\s+${name}\\s*:`, 'i').test(line),
  )

  assert.notEqual(index, -1, `${name} must exist under ${SITE_HEADERS_PATH}`)

  if (replacement === null) {
    lines.splice(index, 1)
  } else {
    lines[index] = `  ${replacement}`
  }

  return lines.join('\n')
}

/** The _headers text with one directive of the main policy replaced. */
function editMainDirective(directive, replacement) {
  const line = headersText
    .split('\n')
    .find((candidate) => /Content-Security-Policy-Report-Only: default-src/.test(candidate))

  assert.ok(line, 'the main policy line must exist')

  const pattern = new RegExp(`${directive} [^;]*`)

  assert.match(line, pattern, `${directive} must be in the main policy`)

  const edited = line.replace(pattern, replacement)

  return headersText.replace(line, edited)
}

/** checkBuildConfig over the committed files with the given Firebase values. */
function check(overrides = {}, options = undefined) {
  return checkBuildConfig(
    {
      environmentName: '',
      mode: 'production',
      workerVars: { FIREBASE_PROJECT_ID: ALLOWED_PROJECT },
      clientEnv: {
        VITE_FIREBASE_PROJECT_ID: ALLOWED_PROJECT,
        VITE_FIREBASE_AUTH_DOMAIN: `${ALLOWED_PROJECT}.firebaseapp.com`,
      },
      headersText,
      indexHtml,
      ...overrides,
    },
    options,
  )
}

function assertNoSecretEchoed(findings) {
  for (const finding of findings) {
    for (const value of SECRET_LIKE) {
      assert.ok(
        !finding.message.includes(value),
        `[${finding.code}] must not echo an env value: ${finding.message}`,
      )
    }
  }
}

describe('declarations', () => {
  test('every name declared in config-guard.d.mts is exported by the module', () => {
    const declared = [
      ...declarations.matchAll(/^export (?:function|const) ([A-Za-z_]+)/gm),
    ].map((match) => match[1])

    assert.ok(declared.length >= 15, 'the declaration file lists the exports')

    for (const name of declared) {
      assert.ok(name in guard, `${name} is declared but not exported`)
    }

    for (const name of Object.keys(guard)) {
      assert.ok(declared.includes(name), `${name} is exported but not declared`)
    }
  })
})

describe('validators (hostnames validated before use)', () => {
  test('a Firebase project id is 6-30 lower-case letters, digits and hyphens', () => {
    assert.equal(isFirebaseProjectId(ALLOWED_PROJECT), true)
    assert.equal(isFirebaseProjectId('abc-12'), true)
    assert.equal(isFirebaseProjectId('a'.repeat(30)), true)
    assert.equal(isFirebaseProjectId('a'.repeat(31)), false)
    assert.equal(isFirebaseProjectId('abc12'), false)
    assert.equal(isFirebaseProjectId('1abcde'), false)
    assert.equal(isFirebaseProjectId('abcde-'), false)
    assert.equal(isFirebaseProjectId('Abcdef'), false)
    assert.equal(isFirebaseProjectId('abc.def'), false)
    assert.equal(isFirebaseProjectId('abc def'), false)
    assert.equal(isFirebaseProjectId(' abcdef'), false)
    assert.equal(isFirebaseProjectId(''), false)
    assert.equal(isFirebaseProjectId(undefined), false)
    assert.equal(isFirebaseProjectId(42), false)
  })

  test('the committed wrangler placeholders can never pass as a project id', () => {
    const config = parseWranglerConfig(wranglerText)

    assert.equal(isFirebaseProjectId(workerVars(config, '').FIREBASE_PROJECT_ID), false)
    assert.equal(
      isFirebaseProjectId(workerVars(config, 'preview').FIREBASE_PROJECT_ID),
      false,
    )
  })

  test('the expected auth domain is <projectId>.firebaseapp.com and needs a valid id', () => {
    assert.equal(expectedAuthDomain(ALLOWED_PROJECT), `${ALLOWED_PROJECT}.firebaseapp.com`)
    assert.throws(() => expectedAuthDomain('Bad Id'), TypeError)
    assert.throws(() => expectedAuthDomain(''), TypeError)
  })

  test('an auth domain is accepted only as <valid id>.firebaseapp.com', () => {
    assert.equal(isFirebaseAuthDomain(`${ALLOWED_PROJECT}.firebaseapp.com`), true)
    assert.equal(isFirebaseAuthDomain(`${ALLOWED_PROJECT}.web.app`), false)
    assert.equal(isFirebaseAuthDomain('evil.example/x.firebaseapp.com'), false)
    assert.equal(isFirebaseAuthDomain('.firebaseapp.com'), false)
    assert.equal(isFirebaseAuthDomain('ABC.firebaseapp.com'), false)
    assert.equal(isFirebaseAuthDomain(null), false)
  })

  test('only a plain identifier is a printable environment name', () => {
    assert.equal(isEnvironmentName('preview'), true)
    assert.equal(isEnvironmentName('media_test-2'), true)
    assert.equal(isEnvironmentName(''), false)
    assert.equal(isEnvironmentName('Preview'), false)
    assert.equal(isEnvironmentName('pre view'), false)
    assert.equal(isEnvironmentName('x'.repeat(65)), false)
    assert.equal(isEnvironmentName(undefined), false)
  })

  test('CSP_MODE: unset or empty is report-only, enforce is enforce, anything else null', () => {
    assert.deepEqual(CSP_MODES, ['report-only', 'enforce'])
    assert.equal(parseCspMode(undefined), 'report-only')
    assert.equal(parseCspMode(''), 'report-only')
    assert.equal(parseCspMode('  '), 'report-only')
    assert.equal(parseCspMode('report-only'), 'report-only')
    assert.equal(parseCspMode('enforce'), 'enforce')
    assert.equal(parseCspMode(' enforce '), 'enforce')
    assert.equal(parseCspMode('Enforce'), null)
    assert.equal(parseCspMode('on'), null)
    assert.equal(parseCspMode('true'), null)
  })
})

describe('wrangler vars', () => {
  const config = parseWranglerConfig(wranglerText)

  test('the top level is production and env blocks are not inherited', () => {
    assert.equal(workerVars(config, '').ONLINE_CONFIRMATION, 'on')
    assert.equal(workerVars(config, undefined).ONLINE_CONFIRMATION, 'on')
    assert.equal(workerVars(config, 'preview').PREVIEW_READ_ONLY, 'on')
    assert.equal(workerVars(config, 'preview').ONLINE_CONFIRMATION, 'off')
    assert.equal(workerVars(config, 'mediatest').PREVIEW_READ_ONLY, undefined)
  })

  test('an undeclared environment is null, not the production vars', () => {
    assert.equal(workerVars(config, 'production'), null)
    assert.equal(workerVars(config, 'staging'), null)
    assert.equal(workerVars(null, ''), null)
    assert.equal(workerVars('text', ''), null)
  })

  test('an environment without vars is an empty object', () => {
    assert.deepEqual(workerVars({ env: { bare: {} } }, 'bare'), {})
    assert.deepEqual(workerVars({}, ''), {})
  })

  test('a syntax error in wrangler.jsonc is thrown, not read as empty', () => {
    assert.throws(() => parseWranglerConfig('{ "vars": '), /could not be parsed/)
  })
})

describe('_headers parsing', () => {
  const rules = parseHeadersFile(headersText)

  test('every rule of the committed file is read', () => {
    assert.deepEqual(
      rules.map((rule) => rule.path),
      [
        SITE_HEADERS_PATH,
        '/assets/*',
        '/images/*',
        '/my-bookings',
        '/admin',
        'https://sundus-yar-preview.:subdomain.workers.dev/*',
      ],
    )
  })

  test('comments, blank lines, CRLF and detach lines are handled', () => {
    const parsed = parseHeadersFile(
      '# c\r\n\r\n/x\r\n  A: 1: 2\r\n  ! B\r\n  # inner comment\r\n/y\r\n  C:v\r\n',
    )

    assert.deepEqual(parsed, [
      {
        path: '/x',
        headers: [
          { name: 'A', value: '1: 2', detach: false },
          { name: 'B', value: '', detach: true },
        ],
      },
      { path: '/y', headers: [{ name: 'C', value: 'v', detach: false }] },
    ])
  })

  test('a header before any rule, or without a name, is refused', () => {
    assert.throws(() => parseHeadersFile('  A: 1\n/x\n'), /before the first rule/)
    assert.throws(() => parseHeadersFile('/x\n  : 1\n'), /without a name/)
    assert.throws(() => parseHeadersFile('/x\n  no-colon\n'), /without a name/)
  })

  test('no line of the committed file exceeds the platform limit of 2000 characters', () => {
    for (const line of headersText.split('\n')) {
      assert.ok(line.length <= 2000)
    }
  })

  test('a CSP is parsed into directives, first occurrence winning, names lower-cased', () => {
    const directives = parseCsp(
      "Default-Src 'self' ; img-src 'self' blob:;img-src data:; ; report-to csp;",
    )

    assert.deepEqual([...directives.keys()], ['default-src', 'img-src', 'report-to'])
    assert.deepEqual(directives.get('img-src'), ["'self'", 'blob:'])
    assert.deepEqual(directives.get('report-to'), ['csp'])
  })

  test('the committed file has a Report-Only main policy and a separate Report-Only Trusted Types policy', () => {
    const { main, trustedTypes } = cspHeadersOf(rules)

    assert.ok(main)
    assert.equal(main.reportOnly, true)
    assert.ok(trustedTypes)
    assert.equal(trustedTypes.reportOnly, true)
    assert.notEqual(main, trustedTypes)
    assert.equal(trustedTypes.directives.has('default-src'), false)
  })
})

describe('inline script hashes (N-53)', () => {
  test('the one inline script of index.html has its hash in script-src', () => {
    const hashes = inlineScriptHashes(indexHtml)
    const { main } = cspHeadersOf(parseHeadersFile(headersText))

    assert.equal(hashes.length, 1)

    for (const hash of hashes) {
      assert.ok(main.directives.get('script-src').includes(hash), `${hash} missing`)
    }
  })

  test('the hash is the base64 SHA-256 of the exact text between the tags', () => {
    const body = "if(a){b()}\n  "
    const expected = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`

    assert.deepEqual(inlineScriptHashes(`<p></p><script>${body}</script>`), [expected])
    assert.deepEqual(inlineScriptHashes('<SCRIPT type="module">x</SCRIPT >'), [
      `'sha256-${createHash('sha256').update('x', 'utf8').digest('base64')}'`,
    ])
  })

  test('external scripts and documents without inline scripts yield nothing', () => {
    assert.deepEqual(inlineScriptHashes('<script type="module" src="/src/main.tsx"></script>'), [])
    assert.deepEqual(inlineScriptHashes("<script src='/a.js'>ignored</script>"), [])
    assert.deepEqual(inlineScriptHashes('<html><body>no script</body></html>'), [])
  })
})

describe('security headers of the SPA (C-9, C-10, TM-14)', () => {
  test('the committed file passes as Report-Only', () => {
    assert.deepEqual(checkSecurityHeaders(parseHeadersFile(headersText), 'report-only'), [])
  })

  test('the committed file is not an enforced policy', () => {
    const codes = codesOf(checkSecurityHeaders(parseHeadersFile(headersText), 'enforce'))

    assert.ok(codes.includes('csp-mode-mismatch'))
    assert.ok(codes.includes('upgrade-insecure-requests-missing'))
  })

  const removed = [
    ['Cross-Origin-Opener-Policy', 'coop-missing'],
    ['X-Frame-Options', 'x-frame-options-missing'],
    ['X-Content-Type-Options', 'nosniff-missing'],
    ['Reporting-Endpoints', 'reporting-endpoints-missing'],
  ]

  for (const [name, code] of removed) {
    test(`removing ${name} is refused (${code})`, () => {
      const codes = codesOf(
        checkSecurityHeaders(parseHeadersFile(editSiteHeader(name, null)), 'report-only'),
      )

      assert.deepEqual(codes, [code])
    })
  }

  test('a weaker COOP or X-Frame-Options is refused', () => {
    assert.deepEqual(
      codesOf(
        checkSecurityHeaders(
          parseHeadersFile(
            editSiteHeader('Cross-Origin-Opener-Policy', 'Cross-Origin-Opener-Policy: unsafe-none'),
          ),
          'report-only',
        ),
      ),
      ['coop-missing'],
    )
    assert.deepEqual(
      codesOf(
        checkSecurityHeaders(
          parseHeadersFile(editSiteHeader('X-Frame-Options', 'X-Frame-Options: SAMEORIGIN')),
          'report-only',
        ),
      ),
      ['x-frame-options-missing'],
    )
  })

  test('the Reporting-Endpoints group must point at /api/csp-report', () => {
    const codes = codesOf(
      checkSecurityHeaders(
        parseHeadersFile(
          editSiteHeader('Reporting-Endpoints', 'Reporting-Endpoints: csp="/api/other"'),
        ),
        'report-only',
      ),
    )

    assert.deepEqual(codes, ['reporting-endpoints-missing'])
    assert.equal(CSP_REPORT_PATH, '/api/csp-report')
    assert.equal(CSP_REPORT_GROUP, 'csp')
  })

  test('the main policy must report to the group and the path', () => {
    assert.deepEqual(
      codesOf(
        checkSecurityHeaders(
          parseHeadersFile(editMainDirective('report-to', 'report-to other')),
          'report-only',
        ),
      ),
      ['csp-reporting-missing'],
    )
    assert.deepEqual(
      codesOf(
        checkSecurityHeaders(
          parseHeadersFile(editMainDirective('report-uri', 'report-uri /api/x')),
          'report-only',
        ),
      ),
      ['csp-reporting-missing'],
    )
  })

  test("img-src must allow 'self' and blob:, never less", () => {
    assert.deepEqual(
      codesOf(
        checkSecurityHeaders(
          parseHeadersFile(editMainDirective('img-src', "img-src 'self'")),
          'report-only',
        ),
      ),
      ['img-src-mismatch'],
    )
  })

  test("script-src with 'unsafe-inline' or 'unsafe-eval' is refused", () => {
    for (const token of ["'unsafe-inline'", "'unsafe-eval'", "'UNSAFE-INLINE'"]) {
      assert.deepEqual(
        codesOf(
          checkSecurityHeaders(
            parseHeadersFile(editMainDirective('script-src', `script-src 'self' ${token}`)),
            'report-only',
          ),
        ),
        ['script-src-unsafe'],
      )
    }
  })

  test('object-src, base-uri and frame-ancestors must keep their exact values', () => {
    const cases = [
      ['object-src', "object-src 'self'", 'object-src-mismatch'],
      ['base-uri', 'base-uri https://example.com', 'base-uri-mismatch'],
      ['frame-ancestors', "frame-ancestors 'self'", 'frame-ancestors-mismatch'],
    ]

    for (const [directive, replacement, code] of cases) {
      assert.deepEqual(
        codesOf(
          checkSecurityHeaders(
            parseHeadersFile(editMainDirective(directive, replacement)),
            'report-only',
          ),
        ),
        [code],
      )
    }
  })

  test('the main policy must exist', () => {
    const withoutMain = headersText
      .split('\n')
      .filter((line) => !/Content-Security-Policy-Report-Only: default-src/.test(line))
      .join('\n')
    const codes = codesOf(checkSecurityHeaders(parseHeadersFile(withoutMain), 'report-only'))

    assert.ok(codes.includes('csp-missing'))
  })

  test('the Trusted Types policy must be a separate Report-Only header that reports to the group', () => {
    const trustedTypesLine = headersText
      .split('\n')
      .find((line) =>
        /^\s+Content-Security-Policy-Report-Only: require-trusted-types-for/.test(line),
      )

    assert.ok(trustedTypesLine)

    const without = headersText.replace(`${trustedTypesLine}\n`, '')

    assert.deepEqual(codesOf(checkSecurityHeaders(parseHeadersFile(without), 'report-only')), [
      'trusted-types-report-only-missing',
    ])

    const enforced = headersText.replace(
      trustedTypesLine,
      trustedTypesLine.replace('Content-Security-Policy-Report-Only', 'Content-Security-Policy'),
    )

    assert.deepEqual(codesOf(checkSecurityHeaders(parseHeadersFile(enforced), 'report-only')), [
      'trusted-types-report-only-missing',
    ])

    const silent = headersText.replace(
      trustedTypesLine,
      "  Content-Security-Policy-Report-Only: require-trusted-types-for 'script'",
    )

    assert.deepEqual(codesOf(checkSecurityHeaders(parseHeadersFile(silent), 'report-only')), [
      'trusted-types-policy-mismatch',
    ])
  })
})

describe('CSP_MODE=enforce rewrite', () => {
  const enforced = enforceCspHeaders(headersText)

  test('the result passes the enforced checks and keeps Trusted Types Report-Only', () => {
    assert.deepEqual(checkSecurityHeaders(parseHeadersFile(enforced), 'enforce'), [])

    const { main, trustedTypes } = cspHeadersOf(parseHeadersFile(enforced))

    assert.equal(main.reportOnly, false)
    assert.ok(main.directives.has('upgrade-insecure-requests'))
    assert.equal(trustedTypes.reportOnly, true)
  })

  test('only the main policy line changes; every other line is byte-identical', () => {
    const before = headersText.split('\n')
    const after = enforced.split('\n')

    assert.equal(before.length, after.length)

    const changed = before
      .map((line, index) => (line === after[index] ? null : index))
      .filter((index) => index !== null)

    assert.equal(changed.length, 1)
    assert.match(before[changed[0]], /^\s+Content-Security-Policy-Report-Only: default-src/)
    assert.match(after[changed[0]], /^\s+Content-Security-Policy: default-src/)
    assert.equal(
      after[changed[0]],
      before[changed[0]].replace('Content-Security-Policy-Report-Only', 'Content-Security-Policy') +
        '; upgrade-insecure-requests',
    )
  })

  test('the inline-script hash and the auth domain survive the rewrite', () => {
    const { problems } = checkBuildConfig({
      environmentName: 'preview',
      mode: 'preview',
      workerVars: { FIREBASE_PROJECT_ID: ALLOWED_PROJECT },
      clientEnv: {
        VITE_FIREBASE_PROJECT_ID: ALLOWED_PROJECT,
        VITE_FIREBASE_AUTH_DOMAIN: `${ALLOWED_PROJECT}.firebaseapp.com`,
      },
      headersText: enforced,
      indexHtml,
      cspMode: 'enforce',
    })

    assert.deepEqual(problems, [])
  })

  test('an already enforced or missing main policy is refused, never silently accepted', () => {
    assert.throws(() => enforceCspHeaders(enforced), /expected exactly one Report-Only policy/)
    assert.throws(() => enforceCspHeaders('/*\n  X-Frame-Options: DENY\n'), /found 0/)
  })

  test('a Report-Only policy under another path is left alone', () => {
    const text = "/*\n  Content-Security-Policy-Report-Only: default-src 'self'\n/other\n  Content-Security-Policy-Report-Only: default-src 'none'\n"
    const result = enforceCspHeaders(text)

    assert.equal(
      result,
      "/*\n  Content-Security-Policy: default-src 'self'; upgrade-insecure-requests\n/other\n  Content-Security-Policy-Report-Only: default-src 'none'\n",
    )
  })

  test('CRLF files keep CRLF and a trailing semicolon is not doubled', () => {
    const text = "/*\r\n  Content-Security-Policy-Report-Only: default-src 'self'; \r\n"

    assert.equal(
      enforceCspHeaders(text),
      "/*\r\n  Content-Security-Policy: default-src 'self'; upgrade-insecure-requests\r\n",
    )
  })
})

describe('build config (H1, N-53)', () => {
  test('an aligned build passes with no problems and no warnings', () => {
    assert.deepEqual(check(), { problems: [], warnings: [] })
  })

  test('the preview environment aligned with the same project passes too', () => {
    assert.deepEqual(check({ environmentName: 'preview', mode: 'preview' }).problems, [])
  })

  test('a client project id that differs from the Worker var is refused', () => {
    const { problems } = check({ workerVars: { FIREBASE_PROJECT_ID: OTHER_PROJECT } })

    assert.deepEqual(codesOf(problems), ['project-id-mismatch'])
    assert.match(problems[0].message, /VITE_FIREBASE_PROJECT_ID/)
    assert.match(problems[0].message, /\.env\.production\.local/)
    assert.match(problems[0].message, /production \(top-level\)/)
    assertNoSecretEchoed(problems)
  })

  test('the environment being built is named, never its values', () => {
    const { problems } = check({
      environmentName: 'preview',
      mode: 'preview',
      workerVars: { FIREBASE_PROJECT_ID: OTHER_PROJECT },
    })

    assert.deepEqual(codesOf(problems), ['project-id-mismatch'])
    assert.match(problems[0].message, /"preview" environment/)
    assert.match(problems[0].message, /\.env\.preview\.local/)
    assertNoSecretEchoed(problems)
  })

  test('a Worker var still on the placeholder is refused once the client is configured', () => {
    const { problems } = check({
      workerVars: workerVars(parseWranglerConfig(wranglerText), ''),
    })

    assert.deepEqual(codesOf(problems), ['worker-project-id-unset'])
    assert.doesNotMatch(problems[0].message, /PLACEHOLDER/)
  })

  test('an auth domain other than <projectId>.firebaseapp.com is refused', () => {
    for (const domain of [
      `${ALLOWED_PROJECT}.web.app`,
      `${OTHER_PROJECT}.firebaseapp.com`,
      'auth.example.com',
      '',
    ]) {
      const { problems } = check({
        clientEnv: {
          VITE_FIREBASE_PROJECT_ID: ALLOWED_PROJECT,
          VITE_FIREBASE_AUTH_DOMAIN: domain,
        },
      })

      assert.ok(codesOf(problems).includes('auth-domain-mismatch'), domain)
      assertNoSecretEchoed(problems)
    }
  })

  test('an auth domain that frame-src does not allow is refused', () => {
    const { problems } = check({
      workerVars: { FIREBASE_PROJECT_ID: OTHER_PROJECT },
      clientEnv: {
        VITE_FIREBASE_PROJECT_ID: OTHER_PROJECT,
        VITE_FIREBASE_AUTH_DOMAIN: `${OTHER_PROJECT}.firebaseapp.com`,
      },
    })

    assert.deepEqual(codesOf(problems), ['auth-domain-not-in-frame-src'])
    assertNoSecretEchoed(problems)
  })

  test('frame-src is compared case-insensitively on the host', () => {
    const upper = headersText.replace(
      `https://${ALLOWED_PROJECT}.firebaseapp.com`,
      `https://${ALLOWED_PROJECT.toUpperCase()}.FIREBASEAPP.COM`,
    )

    assert.deepEqual(check({ headersText: upper }).problems, [])
  })

  test('no Firebase web config at all is a warning for a dev or test build', () => {
    const result = check({
      workerVars: workerVars(parseWranglerConfig(wranglerText), ''),
      clientEnv: {},
    })

    assert.deepEqual(result.problems, [])
    assert.deepEqual(codesOf(result.warnings), ['firebase-unconfigured'])
    assert.match(result.warnings[0].message, /sign-in is unavailable/)
  })

  test('no Firebase web config against a configured Worker is still a warning, saying so', () => {
    const result = check({ clientEnv: {} })

    assert.deepEqual(result.problems, [])
    assert.match(result.warnings[0].message, /is a real project/)
  })

  test('the release preflight requires the client config', () => {
    const result = check({ clientEnv: {} }, { requireClientConfig: true })

    assert.deepEqual(codesOf(result.problems), ['firebase-unconfigured'])
    assert.deepEqual(result.warnings, [])
  })

  test('an auth domain without a project id, or an invalid id, is refused without echo', () => {
    const missing = check({
      clientEnv: { VITE_FIREBASE_AUTH_DOMAIN: `${OTHER_PROJECT}.firebaseapp.com` },
    })

    assert.deepEqual(codesOf(missing.problems), ['client-project-id-missing'])
    assertNoSecretEchoed(missing.problems)

    const invalid = check({
      clientEnv: {
        VITE_FIREBASE_PROJECT_ID: 'Not A Project; rm -rf /',
        VITE_FIREBASE_AUTH_DOMAIN: 'x',
      },
    })

    assert.deepEqual(codesOf(invalid.problems), ['client-project-id-invalid'])
    assert.doesNotMatch(invalid.problems[0].message, /Not A Project/)
  })

  test('values are trimmed before they are compared', () => {
    assert.deepEqual(
      check({
        workerVars: { FIREBASE_PROJECT_ID: ` ${ALLOWED_PROJECT} ` },
        clientEnv: {
          VITE_FIREBASE_PROJECT_ID: `${ALLOWED_PROJECT}\n`,
          VITE_FIREBASE_AUTH_DOMAIN: ` ${ALLOWED_PROJECT}.firebaseapp.com`,
        },
      }).problems,
      [],
    )
  })

  test('a CLOUDFLARE_ENV that wrangler.jsonc does not declare is refused', () => {
    const { problems } = check({ environmentName: 'staging', workerVars: null })

    assert.deepEqual(codesOf(problems), ['unknown-environment'])
    assert.match(problems[0].message, /"staging" environment/)
  })

  test('an unprintable environment name or mode is never echoed', () => {
    const { problems } = check({
      environmentName: 'Evil $(whoami)',
      mode: '../x',
      workerVars: null,
    })

    assert.deepEqual(codesOf(problems), ['unknown-environment'])
    assert.doesNotMatch(problems[0].message, /whoami/)
    assert.match(problems[0].message, /not printable/)

    const mismatch = check({ mode: '../x', workerVars: { FIREBASE_PROJECT_ID: OTHER_PROJECT } })

    assert.doesNotMatch(mismatch.problems[0].message, /\.\.\/x/)
    assert.match(mismatch.problems[0].message, /\.env\.<mode>\.local/)
  })

  test('an inline script whose hash is not in script-src is refused', () => {
    const { problems } = check({
      indexHtml: indexHtml.replace('</script>', ' </script>'),
    })

    assert.deepEqual(codesOf(problems), ['inline-script-hash-missing'])
    assert.match(problems[0].message, /'sha256-[A-Za-z0-9+/]+=*'/)
  })

  test('an unparsable _headers is one finding, and the Firebase checks still run', () => {
    const { problems } = check({
      headersText: '  X: 1\n',
      workerVars: { FIREBASE_PROJECT_ID: OTHER_PROJECT },
    })

    assert.deepEqual(codesOf(problems), ['project-id-mismatch', 'headers-unparsable'])
  })

  test('a header problem and a Firebase problem are both reported', () => {
    const { problems } = check({
      headersText: editSiteHeader('Cross-Origin-Opener-Policy', null),
      workerVars: { FIREBASE_PROJECT_ID: OTHER_PROJECT },
    })

    assert.deepEqual(codesOf(problems).sort(), ['coop-missing', 'project-id-mismatch'])
  })

  test('findings format as one line each with the code', () => {
    assert.equal(
      formatFindings([
        { code: 'a', message: 'first' },
        { code: 'b', message: 'second' },
      ]),
      '  - [a] first\n  - [b] second',
    )
  })
})

describe('vite.config.ts wiring', () => {
  test('the guard plugin runs on every build and CSP_MODE never reaches the client', () => {
    assert.match(viteConfig, /from '\.\/scripts\/config-guard\.mjs'/)
    assert.match(viteConfig, /configGuard\(readCspMode\(mode\)\)/)
    assert.match(viteConfig, /loadEnv\(mode, process\.cwd\(\), 'CSP_MODE'\)/)
    assert.doesNotMatch(viteConfig, /VITE_CSP_MODE/)
    assert.match(viteConfig, /assetsInlineLimit: 0/)
  })

  test('the source _headers is always checked as Report-Only; only a build copy is enforced', () => {
    assert.match(viteConfig, /cspMode: 'report-only'/)
    assert.match(viteConfig, /this\.environment\.name !== 'client'/)
    assert.match(viteConfig, /enforceCspHeaders\(/)
  })

  test('no application, shared or Worker source reads CSP_MODE', () => {
    const offenders = []

    for (const folder of ['src', 'shared', 'worker']) {
      const root = new URL(`../${folder}/`, import.meta.url)

      for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.(ts|tsx|mts|js|mjs|css)$/.test(entry.name)) {
          continue
        }

        const file = path.join(entry.parentPath, entry.name)

        if (readFileSync(file, 'utf8').includes('CSP_MODE')) {
          offenders.push(path.relative(fileURLToPath(new URL('../', import.meta.url)), file))
        }
      }
    }

    assert.deepEqual(offenders, [])
  })
})
