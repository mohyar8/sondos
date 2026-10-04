// Firebase config guard and security-header checks (plan 11 W2-18; H1, C-9,
// C-10, TM-14, N-53). Pure functions over text and parsed config, shared by
// the Vite plugin in vite.config.ts (every `vite` and `vite build`) and the
// release preflight (scripts/release-preflight.mjs, W3-19), which runs the
// same checks against the generated wrangler.json and dist/client.
//
// What is guarded (H1): the Firebase web config that Vite embeds in the
// client bundle must belong to the project the target Worker verifies ID
// tokens against, or every sign-in is refused, and verification and reset
// links open on the wrong project. So VITE_FIREBASE_PROJECT_ID must equal the
// FIREBASE_PROJECT_ID var of the CLOUDFLARE_ENV being built, the auth domain
// must be <projectId>.firebaseapp.com (the default action handler for those
// links) and must be allowed by frame-src, and the inline script of
// index.html must keep its hash in the CSP (script-src), or the page breaks
// the day the policy is enforced.
//
// Env files per mode (H1): Vite loads `.env.<mode>.local`, so each target
// has its own file and none can leak into another build:
//   .env.development.local  `vite` (mode development): the dev Firebase
//                           project, paired with FIREBASE_PROJECT_ID in
//                           .dev.vars (wrangler's local vars);
//   .env.preview.local      `vite build --mode preview` with
//                           CLOUDFLARE_ENV=preview (release.mjs --env=preview):
//                           the dev project, as wrangler.jsonc env.preview
//                           declares;
//   .env.production.local   `vite build` (mode production): the production
//                           project, as the top-level vars declare.
// Never `.env.local`: Vite loads it in EVERY mode, so a dev config there
// would ride into a production build (that is the accident this guard
// catches). All of them are git-ignored (*.local).
//
// Rules: hostnames are validated against strict patterns before they are
// compared or written anywhere, and no message ever contains an env value:
// findings name the variable, the file and the environment, never the
// content (a project id is public, but the habit is the control, SB-8).
import { createHash } from 'node:crypto'

import ts from 'typescript'

/**
 * A Firebase (Google Cloud) project id: 6-30 lower-case letters, digits and
 * hyphens, starting with a letter and not ending with a hyphen. The
 * committed wrangler.jsonc placeholders (upper case, underscores) can never
 * match, so a build against a placeholder Worker is "unconfigured", not
 * "aligned".
 */
const FIREBASE_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/
/** The default Firebase Auth domain of a project (H1). */
const FIREBASE_AUTH_DOMAIN_SUFFIX = '.firebaseapp.com'
/** A wrangler environment name we are willing to print back. */
const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
/** A Vite mode we are willing to print back. */
const MODE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** The `_headers` rule that covers every static response, index.html included. */
export const SITE_HEADERS_PATH = '/*'
/** The report endpoint (plan 11 §3.2 #45, worker/csp-report.ts). */
export const CSP_REPORT_PATH = '/api/csp-report'
/** The Reporting-Endpoints group name the policies report to. */
export const CSP_REPORT_GROUP = 'csp'

const CSP_HEADER = 'content-security-policy'
const CSP_REPORT_ONLY_HEADER = 'content-security-policy-report-only'
const REPORTING_ENDPOINTS_HEADER = 'reporting-endpoints'
const UPGRADE_INSECURE_REQUESTS = 'upgrade-insecure-requests'
const TRUSTED_TYPES_DIRECTIVE = 'require-trusted-types-for'

/** CSP_MODE values (vite.config.ts); anything else fails the build. */
export const CSP_MODES = Object.freeze(['report-only', 'enforce'])

/** @typedef {{ code: string, message: string }} Finding */
/** @typedef {{ name: string, value: string, detach: boolean }} HeaderLine */
/** @typedef {{ path: string, headers: HeaderLine[] }} HeadersRule */

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isFirebaseProjectId(value) {
  return typeof value === 'string' && FIREBASE_PROJECT_ID_PATTERN.test(value)
}

/**
 * The auth domain a project must use here: its default Firebase Auth domain,
 * where email verification and password reset links complete (H1).
 * @param {string} projectId a value isFirebaseProjectId accepted
 */
export function expectedAuthDomain(projectId) {
  if (!isFirebaseProjectId(projectId)) {
    throw new TypeError('expectedAuthDomain needs a validated project id')
  }

  return `${projectId}${FIREBASE_AUTH_DOMAIN_SUFFIX}`
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isFirebaseAuthDomain(value) {
  return (
    typeof value === 'string' &&
    value.endsWith(FIREBASE_AUTH_DOMAIN_SUFFIX) &&
    isFirebaseProjectId(value.slice(0, -FIREBASE_AUTH_DOMAIN_SUFFIX.length))
  )
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isEnvironmentName(value) {
  return typeof value === 'string' && ENVIRONMENT_NAME_PATTERN.test(value)
}

/**
 * CSP_MODE as the build reads it: unset or empty is report-only (the launch
 * setting, TM-14), "enforce" emits the enforced header for a preview trial,
 * anything else is null so the caller fails the build.
 * @param {string | undefined} raw
 * @returns {'report-only' | 'enforce' | null}
 */
export function parseCspMode(raw) {
  const value = (raw ?? '').trim()

  if (value === '') {
    return 'report-only'
  }

  return value === 'report-only' || value === 'enforce' ? value : null
}

/**
 * wrangler.jsonc (comments, trailing commas) parsed with TypeScript's JSONC
 * parser, a dependency the repository already has. Throws on a syntax error.
 * @param {string} text
 * @returns {unknown}
 */
export function parseWranglerConfig(text) {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', text)

  if (parsed.error !== undefined) {
    throw new Error('wrangler.jsonc could not be parsed')
  }

  return parsed.config
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `vars` the Worker of `environmentName` deploys with ('' or undefined:
 * the top level, i.e. production). wrangler does not inherit vars, so only
 * the environment's own block counts; a missing block is an empty object.
 * Null when the environment is not declared at all.
 * @param {unknown} config parseWranglerConfig output
 * @param {string | undefined} environmentName
 * @returns {Record<string, unknown> | null}
 */
export function workerVars(config, environmentName) {
  if (!isRecord(config)) {
    return null
  }

  const name = environmentName ?? ''

  if (name === '') {
    return isRecord(config.vars) ? config.vars : {}
  }

  if (!isRecord(config.env) || !isRecord(config.env[name])) {
    return null
  }

  const environment = config.env[name]

  return isRecord(environment.vars) ? environment.vars : {}
}

/**
 * Parses the `_headers` format: a non-indented line starts a rule (a path
 * or URL pattern), each indented line under it is `Name: value` or
 * `! Name` (detach); `#` comments and blank lines are skipped.
 * @param {string} text
 * @returns {HeadersRule[]}
 */
export function parseHeadersFile(text) {
  /** @type {HeadersRule[]} */
  const rules = []

  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) {
      continue
    }

    if (!/^\s/.test(rawLine)) {
      rules.push({ path: rawLine.trim(), headers: [] })
      continue
    }

    const rule = rules.at(-1)

    if (rule === undefined) {
      throw new Error('_headers: a header line before the first rule')
    }

    const line = rawLine.trim()

    if (line.startsWith('!')) {
      rule.headers.push({ name: line.slice(1).trim(), value: '', detach: true })
      continue
    }

    const separator = line.indexOf(':')

    if (separator <= 0) {
      throw new Error('_headers: a header line without a name')
    }

    rule.headers.push({
      name: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
      detach: false,
    })
  }

  return rules
}

/**
 * A policy's directives: name (lower case) to its source tokens as written.
 * Repeated directives keep the first occurrence, as browsers do.
 * @param {string} policy
 * @returns {Map<string, string[]>}
 */
export function parseCsp(policy) {
  /** @type {Map<string, string[]>} */
  const directives = new Map()

  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter((token) => token !== '')
    const name = tokens[0]?.toLowerCase()

    if (name !== undefined && !directives.has(name)) {
      directives.set(name, tokens.slice(1))
    }
  }

  return directives
}

/**
 * The headers of the rule for `path`, header names lower-cased; empty when
 * the rule does not exist.
 * @param {HeadersRule[]} rules
 * @param {string} path
 */
function headersOfRule(rules, path) {
  return rules
    .filter((rule) => rule.path === path)
    .flatMap((rule) => rule.headers)
    .filter((header) => !header.detach)
    .map((header) => ({ name: header.name.toLowerCase(), value: header.value }))
}

/**
 * The site's CSP headers, each parsed: the main policy is the one that
 * carries default-src, the Trusted Types policy the one that carries
 * require-trusted-types-for (TM-14 keeps it a separate Report-Only header).
 * @param {HeadersRule[]} rules
 */
export function cspHeadersOf(rules) {
  const policies = headersOfRule(rules, SITE_HEADERS_PATH)
    .filter(
      (header) =>
        header.name === CSP_HEADER || header.name === CSP_REPORT_ONLY_HEADER,
    )
    .map((header) => ({
      reportOnly: header.name === CSP_REPORT_ONLY_HEADER,
      directives: parseCsp(header.value),
    }))

  return {
    main: policies.find((policy) => policy.directives.has('default-src')) ?? null,
    trustedTypes:
      policies.find((policy) => policy.directives.has(TRUSTED_TYPES_DIRECTIVE)) ??
      null,
  }
}

/**
 * `'sha256-…'` sources for every inline script of an HTML document (a
 * script element without src, whatever its type): the SHA-256 of the exact
 * text between the tags, base64, as CSP script-src wants it.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScriptHashes(html) {
  /** @type {string[]} */
  const hashes = []
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi

  for (const match of html.matchAll(scriptPattern)) {
    const [, attributes, body] = match

    if (/\bsrc\s*=/i.test(attributes ?? '')) {
      continue
    }

    hashes.push(
      `'sha256-${createHash('sha256').update(body ?? '', 'utf8').digest('base64')}'`,
    )
  }

  return hashes
}

/**
 * `_headers` text with the site's main policy switched from Report-Only to
 * enforced, plus upgrade-insecure-requests (which browsers ignore in a
 * Report-Only policy). The Trusted Types Report-Only header and every other
 * line are kept byte for byte. Exactly one Report-Only line with default-src
 * must exist under /*, or the transform refuses (a policy that was already
 * enforced, or missing, is not silently accepted).
 * @param {string} text
 * @returns {string}
 */
export function enforceCspHeaders(text) {
  const lines = text.split(/\r?\n/)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  let currentRule = ''
  let rewritten = 0

  const output = lines.map((line) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      return line
    }

    if (!/^\s/.test(line)) {
      currentRule = line.trim()

      return line
    }

    const match = /^(\s+)([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(line)

    if (
      currentRule !== SITE_HEADERS_PATH ||
      match === null ||
      match[2]?.toLowerCase() !== CSP_REPORT_ONLY_HEADER ||
      !parseCsp(match[3] ?? '').has('default-src')
    ) {
      return line
    }

    rewritten += 1

    const policy = (match[3] ?? '').replace(/;?\s*$/, '')
    const upgraded = parseCsp(policy).has(UPGRADE_INSECURE_REQUESTS)
      ? policy
      : `${policy}; ${UPGRADE_INSECURE_REQUESTS}`

    return `${match[1]}Content-Security-Policy: ${upgraded}`
  })

  if (rewritten !== 1) {
    throw new Error(
      `_headers: expected exactly one Report-Only policy with default-src under ${SITE_HEADERS_PATH}, found ${rewritten}`,
    )
  }

  return output.join(newline)
}

/**
 * The name to print for an environment: the declared name when it is a
 * plain identifier, "production" for the top level, otherwise a label that
 * reveals nothing.
 * @param {string | undefined} environmentName
 */
function describeEnvironment(environmentName) {
  const name = environmentName ?? ''

  if (name === '') {
    return 'the production (top-level) environment'
  }

  return isEnvironmentName(name)
    ? `the "${name}" environment`
    : 'an environment whose CLOUDFLARE_ENV name is not printable'
}

/**
 * @param {string | undefined} mode
 */
function describeMode(mode) {
  return typeof mode === 'string' && MODE_PATTERN.test(mode)
    ? `.env.${mode}.local`
    : '.env.<mode>.local'
}

/**
 * The security headers every static response must carry (C-9 SPA part,
 * C-10, TM-14, audit SEC-12), checked against the parsed `_headers`.
 * `cspMode` says which name the main policy must ship under: the source
 * file is always report-only; a CSP_MODE=enforce build output is enforced.
 * @param {HeadersRule[]} rules
 * @param {'report-only' | 'enforce'} cspMode
 * @returns {Finding[]}
 */
export function checkSecurityHeaders(rules, cspMode) {
  /** @type {Finding[]} */
  const problems = []
  const site = headersOfRule(rules, SITE_HEADERS_PATH)
  const valueOf = (/** @type {string} */ name) =>
    site.find((header) => header.name === name)?.value ?? null
  const { main, trustedTypes } = cspHeadersOf(rules)

  const expectHeader = (
    /** @type {string} */ name,
    /** @type {string} */ expected,
    /** @type {string} */ code,
  ) => {
    if (valueOf(name)?.toLowerCase() !== expected) {
      problems.push({
        code,
        message: `_headers ${SITE_HEADERS_PATH} must send "${name}: ${expected}"`,
      })
    }
  }

  expectHeader('cross-origin-opener-policy', 'same-origin', 'coop-missing')
  expectHeader('x-frame-options', 'deny', 'x-frame-options-missing')
  expectHeader('x-content-type-options', 'nosniff', 'nosniff-missing')

  const endpoints = valueOf(REPORTING_ENDPOINTS_HEADER) ?? ''

  if (!endpoints.includes(`${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`)) {
    problems.push({
      code: 'reporting-endpoints-missing',
      message: `_headers ${SITE_HEADERS_PATH} must send Reporting-Endpoints: ${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`,
    })
  }

  if (main === null) {
    problems.push({
      code: 'csp-missing',
      message: `_headers ${SITE_HEADERS_PATH} has no Content-Security-Policy(-Report-Only) with default-src`,
    })
  } else {
    if (main.reportOnly !== (cspMode === 'report-only')) {
      problems.push({
        code: 'csp-mode-mismatch',
        message:
          cspMode === 'enforce'
            ? '_headers: the main policy must be an enforced Content-Security-Policy (CSP_MODE=enforce)'
            : '_headers: the main policy must stay Content-Security-Policy-Report-Only (TM-14: enforce through CSP_MODE=enforce, or W7-01)',
      })
    }

    if (cspMode === 'enforce' && !main.directives.has(UPGRADE_INSECURE_REQUESTS)) {
      problems.push({
        code: 'upgrade-insecure-requests-missing',
        message: `_headers: the enforced policy must include ${UPGRADE_INSECURE_REQUESTS}`,
      })
    }

    const reportUri = main.directives.get('report-uri') ?? []
    const reportTo = main.directives.get('report-to') ?? []

    if (!reportUri.includes(CSP_REPORT_PATH) || !reportTo.includes(CSP_REPORT_GROUP)) {
      problems.push({
        code: 'csp-reporting-missing',
        message: `_headers: the main policy must end with "report-uri ${CSP_REPORT_PATH}; report-to ${CSP_REPORT_GROUP}"`,
      })
    }

    const imgSrc = main.directives.get('img-src') ?? []

    if (!imgSrc.includes("'self'") || !imgSrc.includes('blob:')) {
      problems.push({
        code: 'img-src-mismatch',
        message: "_headers: img-src must allow 'self' and blob:",
      })
    }

    const scriptSrc = main.directives.get('script-src') ?? []

    if (scriptSrc.some((token) => /^'unsafe-(inline|eval)'$/i.test(token))) {
      problems.push({
        code: 'script-src-unsafe',
        message: "_headers: script-src must not allow 'unsafe-inline' or 'unsafe-eval'",
      })
    }

    for (const [directive, expected] of [
      ['object-src', "'none'"],
      ['base-uri', "'self'"],
      ['frame-ancestors', "'none'"],
    ]) {
      if ((main.directives.get(directive) ?? []).join(' ') !== expected) {
        problems.push({
          code: `${directive}-mismatch`,
          message: `_headers: ${directive} must be exactly ${expected}`,
        })
      }
    }
  }

  if (trustedTypes === null || !trustedTypes.reportOnly) {
    problems.push({
      code: 'trusted-types-report-only-missing',
      message: `_headers ${SITE_HEADERS_PATH} must send a separate Content-Security-Policy-Report-Only: ${TRUSTED_TYPES_DIRECTIVE} 'script' (TM-14)`,
    })
  } else if (
    (trustedTypes.directives.get(TRUSTED_TYPES_DIRECTIVE) ?? []).join(' ') !==
      "'script'" ||
    !(trustedTypes.directives.get('report-to') ?? []).includes(CSP_REPORT_GROUP)
  ) {
    problems.push({
      code: 'trusted-types-policy-mismatch',
      message: `_headers: the Trusted Types policy must be "${TRUSTED_TYPES_DIRECTIVE} 'script'" and report to ${CSP_REPORT_GROUP}`,
    })
  }

  return problems
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The N-53 checks. Inputs are already-read text and already-resolved values
 * so the same function serves the Vite plugin (wrangler.jsonc + env files)
 * and the preflight (generated wrangler.json + dist/client).
 *
 * Returns problems (the build or release must fail) and warnings (printed).
 * A build with no Firebase web config at all against a Worker that also has
 * no real project id (the committed placeholders) is a warning: nothing can
 * sign in, nothing can mismatch, and tests and audits build that way.
 * With `requireClientConfig` (the release preflight) it is a problem.
 *
 * @param {{
 *   environmentName?: string,
 *   mode?: string,
 *   workerVars: Record<string, unknown> | null,
 *   clientEnv: Record<string, string | undefined>,
 *   headersText: string,
 *   indexHtml: string,
 *   cspMode?: 'report-only' | 'enforce',
 * }} input
 * @param {{ requireClientConfig?: boolean }} [options]
 * @returns {{ problems: Finding[], warnings: Finding[] }}
 */
export function checkBuildConfig(input, options = {}) {
  /** @type {Finding[]} */
  const problems = []
  /** @type {Finding[]} */
  const warnings = []
  const environment = describeEnvironment(input.environmentName)
  const envFile = describeMode(input.mode)
  const cspMode = input.cspMode ?? 'report-only'

  const workerId = trimmedString(input.workerVars?.FIREBASE_PROJECT_ID)
  const workerConfigured = isFirebaseProjectId(workerId)
  const clientId = trimmedString(input.clientEnv.VITE_FIREBASE_PROJECT_ID)
  const clientAuthDomain = trimmedString(input.clientEnv.VITE_FIREBASE_AUTH_DOMAIN)

  if (input.workerVars === null) {
    problems.push({
      code: 'unknown-environment',
      message: `CLOUDFLARE_ENV names ${environment}, which wrangler.jsonc does not declare`,
    })
  }

  if (clientId === '' && clientAuthDomain === '') {
    const finding = {
      code: 'firebase-unconfigured',
      message: `VITE_FIREBASE_PROJECT_ID is not set (${envFile}): sign-in is unavailable in this build${
        workerConfigured
          ? `, although FIREBASE_PROJECT_ID of ${environment} is a real project`
          : ''
      }`,
    }

    if (options.requireClientConfig === true) {
      problems.push(finding)
    } else {
      warnings.push(finding)
    }
  } else if (clientId === '') {
    problems.push({
      code: 'client-project-id-missing',
      message: `VITE_FIREBASE_AUTH_DOMAIN is set but VITE_FIREBASE_PROJECT_ID is not (${envFile})`,
    })
  } else if (!isFirebaseProjectId(clientId)) {
    problems.push({
      code: 'client-project-id-invalid',
      message: `VITE_FIREBASE_PROJECT_ID (${envFile}) is not a Firebase project id (6-30 lower-case letters, digits and hyphens)`,
    })
  } else {
    if (input.workerVars !== null && !workerConfigured) {
      problems.push({
        code: 'worker-project-id-unset',
        message: `FIREBASE_PROJECT_ID of ${environment} in wrangler.jsonc is not a Firebase project id (still the placeholder?) while VITE_FIREBASE_PROJECT_ID is set (${envFile})`,
      })
    } else if (workerConfigured && workerId !== clientId) {
      problems.push({
        code: 'project-id-mismatch',
        message: `VITE_FIREBASE_PROJECT_ID (${envFile}) differs from FIREBASE_PROJECT_ID of ${environment} in wrangler.jsonc (H1)`,
      })
    }

    if (clientAuthDomain !== expectedAuthDomain(clientId)) {
      problems.push({
        code: 'auth-domain-mismatch',
        message: `VITE_FIREBASE_AUTH_DOMAIN (${envFile}) must be exactly <VITE_FIREBASE_PROJECT_ID>${FIREBASE_AUTH_DOMAIN_SUFFIX} (H1: verification and reset links complete there)`,
      })
    }
  }

  let rules
  try {
    rules = parseHeadersFile(input.headersText)
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }

    problems.push({ code: 'headers-unparsable', message: error.message })

    return { problems, warnings }
  }

  problems.push(...checkSecurityHeaders(rules, cspMode))

  const { main } = cspHeadersOf(rules)

  if (main !== null) {
    const frameSrc = (main.directives.get('frame-src') ?? []).map((token) =>
      token.toLowerCase(),
    )

    // Only a consistent client config is checked against frame-src; an
    // inconsistent one is already refused above, and a second finding about
    // the same value would only add noise.
    if (
      isFirebaseProjectId(clientId) &&
      clientAuthDomain === expectedAuthDomain(clientId) &&
      !frameSrc.includes(`https://${clientAuthDomain}`)
    ) {
      problems.push({
        code: 'auth-domain-not-in-frame-src',
        message:
          'frame-src in public/_headers does not allow https://<VITE_FIREBASE_AUTH_DOMAIN>: add the auth domain of this build (and drop the old one)',
      })
    }

    const scriptSrc = main.directives.get('script-src') ?? []

    for (const hash of inlineScriptHashes(input.indexHtml)) {
      if (!scriptSrc.includes(hash)) {
        problems.push({
          code: 'inline-script-hash-missing',
          message: `index.html has an inline script whose hash ${hash} is not in script-src of public/_headers (recompute it after editing the script)`,
        })
      }
    }
  }

  return { problems, warnings }
}

/**
 * The findings as one message for a thrown Error or a log, one per line.
 * @param {Finding[]} findings
 */
export function formatFindings(findings) {
  return findings.map((finding) => `  - [${finding.code}] ${finding.message}`).join('\n')
}
