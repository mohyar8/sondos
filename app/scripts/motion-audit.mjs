#!/usr/bin/env node
// MOT-06 (plan 11 W2-21; 12-motion-spec.md §7.3, §8.2; M7, TM-22, UX-01):
// the classic-parity gate and the motion runtime audit, driving a headless
// Chrome over the DevTools Protocol with Node's global WebSocket. No
// dependency is added: the static server, the PNG codec and the diff are
// written here.
//
//   node scripts/motion-audit.mjs parity --ref <git-ref> [--keep] [--out=<dir>]
//   node scripts/motion-audit.mjs runtime [--design=classic|cinematic] [--no-build] [--throttle] [--loads=<1-50>] [--out=<dir>]
//
// parity (npm run audit:parity -- --ref <commit before the unit>):
// - Builds <ref> as classic in a detached git worktree (`git worktree add
//   --detach`, `npm ci` first, M7) and the working tree as classic, both
//   with the audit's Firebase configuration (§7.3 item 3): none, embedded
//   as explicit empty VITE_FIREBASE_* values — the shape the config guard
//   (W2-18) accepts for audits — so the audit needs no network and no real
//   project and sign-in reads as unavailable on both sides.
// - Hard gate: every emitted .css is compared by sha256 after the hashed
//   asset names inside url() are replaced by the sha256 of the referenced
//   bytes (a data: URI is decoded and hashed the same way, so TM-14's move
//   from inlined fonts to emitted files, review finding W1 #62, compares
//   equal when the bytes are), and the DOM of /, /portfolio, /packages and
//   /my-bookings (signed out) is compared after the hashed asset names are
//   normalised. Any difference prints a readable diff and fails.
// - Supporting check: screenshots at 375×812 and 1280×800 with reduced
//   motion emulated, taken only after document.fonts.ready and decode() of
//   every image in the viewport, may differ in at most 0.1% of the pixels.
// - §7.3 item 4: both builds must pass the classic marker check.
//
// runtime (npm run audit:motion): console errors and warnings, horizontal
// overflow at 320 and 375 px, the reduced-motion running-animation count,
// the intro (present then gone ≤ 2.0 s after t0; none on reload or in a
// second session; Tab at t0 + 300 ms ends it at once with focus on the skip
// link), view transitions (attribute observed, focus on the new H1, a tap
// during the transition reaches the page), LCP element and time, CLS, the
// hero H1/CTA opacity-1 time, the logo-not-ready rate over N Fast 4G loads
// and long tasks; --throttle adds 4× CPU + Fast 4G to the metric loads (A4).
// Checks for a feature the build does not contain yet (no intro, no view
// transition) are reported as n/a, not as failures.
//
// Security (TM-22, SC-0):
// - Chrome starts with --remote-debugging-port=0 (the port is read from the
//   profile's DevToolsActivePort file), a temporary profile and no first-run
//   or background networking, and is killed on exit (Ctrl+C included); the
//   profile, the worktree and the temp files are removed even then.
// - Every request is intercepted (Fetch domain): only http://127.0.0.1:<the
//   audit's own ports> continues, everything else fails as BlockedByClient
//   and is counted per host, so nothing in a build can reach the network
//   (belt and braces: --host-resolver-rules maps every name to NOTFOUND).
// - The static server binds 127.0.0.1:0, serves GET/HEAD only and resolves
//   every path inside the build folder (decoded, no "..", no backslash, no
//   symbolic link); unknown extensionless paths get the SPA fallback.
// - Builds run as `node node_modules/<tool>/<entry>` through spawnSync with
//   argument arrays and shell: false; git is used read-only (rev-parse,
//   worktree add/remove/prune). The child environment carries no inherited
//   VITE_* value (only the stubs and the design); nothing the script prints
//   is an environment value, and every printed line is redacted and made
//   terminal-safe.

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crc32, deflateSync, inflateSync } from 'node:zlib'

import { builtClientText, checkDesignMarkers, packageBin } from './build-design.mjs'
import { ScriptFailure, UsageError, appRoot, isMainModule, printable, runCli } from './lib/wrangler-d1.mjs'

export const USAGE = [
  'Usage: node scripts/motion-audit.mjs parity --ref <git-ref> [--keep] [--out=<dir>]',
  '       node scripts/motion-audit.mjs runtime [--design=classic|cinematic] [--no-build] [--throttle] [--loads=<1-50>] [--out=<dir>]',
  'parity: builds <git-ref> (worktree, npm ci) and the working tree as classic and compares CSS hashes,',
  '        DOM and screenshots (12-motion-spec.md §7.3). runtime: the motion checks of §8.2 MOT-06.',
  'Reports go to node_modules/.tmp/motion-audit/ unless --out is given. Set CHROME_PATH if Chrome is not found.',
].join('\n')

export const MODES = Object.freeze(['parity', 'runtime'])
export const DESIGNS = Object.freeze(['classic', 'cinematic'])
/** The public routes the parity gate compares (§7.3 item 3), signed out. */
export const PARITY_ROUTES = Object.freeze(['/', '/portfolio', '/packages', '/my-bookings'])
export const PARITY_VIEWPORTS = Object.freeze([
  { width: 375, height: 812, mobile: true },
  { width: 1280, height: 800, mobile: false },
])
/** A3: no horizontal page scroll at 375 px and 320 px. */
export const OVERFLOW_VIEWPORTS = Object.freeze([
  { width: 320, height: 568, mobile: true },
  { width: 375, height: 812, mobile: true },
])
export const DESKTOP_VIEWPORT = Object.freeze({ width: 1280, height: 800, mobile: false })
export const MOBILE_VIEWPORT = Object.freeze({ width: 375, height: 812, mobile: true })

/**
 * The Firebase web configuration every audit build embeds (M7): none. The
 * config guard (W2-18, N-53/H1) refuses any VITE_FIREBASE_PROJECT_ID that
 * does not equal the Worker's project id, and the committed wrangler.jsonc
 * holds placeholders, so the one shape an audit build can carry is the
 * guard's documented audit shape — no web config at all, a warning only —
 * under which src/lib/firebase.ts reports sign-in as unavailable and never
 * initialises (the same on both sides of a parity run). The values are
 * explicit empty strings, not absent: Vite's loadEnv lets process.env win
 * over .env.<mode>.local, so a developer's real project can never ride into
 * an audit build.
 */
export const STUB_FIREBASE_ENV = Object.freeze({
  VITE_FIREBASE_API_KEY: '',
  VITE_FIREBASE_AUTH_DOMAIN: '',
  VITE_FIREBASE_PROJECT_ID: '',
  VITE_FIREBASE_APP_ID: '',
  VITE_FIREBASE_STORAGE_BUCKET: '',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '',
})

/** Chrome DevTools' "Fast 4G" preset (4 Mbps down, 3 Mbps up, 20 ms RTT, with its 0.9 and 3.75 factors). */
export const FAST_4G = Object.freeze({
  offline: false,
  latency: 75,
  downloadThroughput: Math.floor(((4 * 1024 * 1024) / 8) * 0.9),
  uploadThroughput: Math.floor(((3 * 1024 * 1024) / 8) * 0.9),
})
export const CPU_THROTTLE_RATE = 4

/** Budgets (12 §8.1 A4/A5, §8.2 MOT-06, UX-01). */
export const BUDGETS = Object.freeze({
  screenshotDiffRatio: 0.001,
  introGoneAfterT0Ms: 2000,
  introInstantFinishMs: 150,
  tabAtMs: 300,
  heroReadyAfterT0Ms: 2200,
  heroReadyAfterFirstPaintMs: 1500,
  cls: 0.01,
  longTaskMs: 50,
  reducedMotionSettleMs: 200,
  lcpElement: 'img.home-hero__image',
})

const DEFAULT_LOADS = 10
const MAXIMUM_LOADS = 50
const NAVIGATION_TIMEOUT_MS = 30_000
const DOM_SETTLE_MS = 750
const DOM_SETTLE_CAP_MS = 12_000
const CHROME_START_TIMEOUT_MS = 30_000
const NPM_CI_TIMEOUT_MINUTES = 20
const BUILD_TIMEOUT_MINUTES = 20
/** Per-channel tolerance for a pixel to count as equal (anti-aliasing noise). */
const PIXEL_TOLERANCE = 2
const DIFF_MAX_LINES = 160

/** A git ref as typed by an operator: no leading '-', no whitespace, no quotes. */
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,119}$/
/** Vite's hashed asset names: <name>-<8 chars of [A-Za-z0-9_-]>.<ext>. */
const HASHED_ASSET = /(\/assets\/[^\s"'()]*?)-[A-Za-z0-9_-]{8}(\.[A-Za-z0-9]+)(?![A-Za-z0-9_-])/g
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g
/** A `<link rel="modulepreload">` element as Chrome serialises it (any attribute order). */
const MODULEPRELOAD_LINK = /<link\b[^>]*\brel="modulepreload"[^>]*>/g
const LOADS = /^[1-9][0-9]?$/

export const DEFAULT_PATHS = Object.freeze({
  root: appRoot,
  distClient: path.join(appRoot, 'dist', 'client'),
  reports: path.join(appRoot, 'node_modules', '.tmp', 'motion-audit'),
})

// ---------------------------------------------------------------------------
// Output

/** An argument as it may be echoed: terminal-safe and short. */
function shown(argument) {
  const text = printable(argument)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/**
 * `text` as this script prints it: anything shaped like a VITE_* assignment
 * is hidden (TM-22: no VITE_* value is ever printed), and control and
 * format characters are escaped line by line, so a usage text or a diff
 * keeps its line breaks and nothing else can act on the terminal.
 */
export function redact(text) {
  return String(text)
    .replace(/VITE_[A-Z0-9_]*\s*[=:]\s*[^\s,;"']*/g, 'VITE_…=«redacted»')
    .split('\n')
    .map((line) => printable(line))
    .join('\n')
}

function log(line) {
  console.log(redact(line))
}

function warn(line) {
  console.error(redact(line))
}

// ---------------------------------------------------------------------------
// Arguments

/**
 * The command line as { mode, ... } or { help: true }. Every option is
 * known, spelled exactly and given at most once; anything else is a
 * UsageError (exit 2) before anything runs.
 */
export function parseAuditArguments(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { help: true }
  }

  const [mode, ...rest] = argv

  if (!MODES.includes(mode)) {
    throw new UsageError(
      mode === undefined ? 'Give the mode: parity or runtime.' : `Unknown mode: ${shown(mode)} (parity or runtime).`,
    )
  }

  const seen = new Set()
  const once = (name) => {
    if (seen.has(name)) {
      throw new UsageError(`${name} was given more than once.`)
    }

    seen.add(name)
  }
  const options = { mode, out: null }

  if (mode === 'parity') {
    options.ref = null
    options.keep = false
  } else {
    options.design = 'cinematic'
    options.build = true
    options.throttle = false
    options.loads = DEFAULT_LOADS
  }

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]

    if (argument.startsWith('--out=')) {
      once('--out')
      const value = argument.slice('--out='.length)

      if (value === '' || value.includes('\0') || value.startsWith('-')) {
        throw new UsageError('--out needs a folder path (as --out=<dir>).')
      }

      options.out = path.resolve(value)
    } else if (mode === 'parity' && (argument === '--ref' || argument.startsWith('--ref='))) {
      once('--ref')
      let value

      if (argument === '--ref') {
        value = rest[index + 1]
        index += 1
      } else {
        value = argument.slice('--ref='.length)
      }

      if (typeof value !== 'string' || !GIT_REF.test(value) || value.includes('..')) {
        throw new UsageError('--ref needs a git ref: a commit, tag or branch name (letters, digits, . _ / ~ ^ -).')
      }

      options.ref = value
    } else if (mode === 'parity' && argument === '--keep') {
      once('--keep')
      options.keep = true
    } else if (mode === 'runtime' && argument.startsWith('--design=')) {
      once('--design')
      const value = argument.slice('--design='.length)

      if (!DESIGNS.includes(value)) {
        throw new UsageError('--design accepts only "classic" or "cinematic" (as --design=<value>).')
      }

      options.design = value
    } else if (mode === 'runtime' && argument === '--no-build') {
      once('--no-build')
      options.build = false
    } else if (mode === 'runtime' && argument === '--throttle') {
      once('--throttle')
      options.throttle = true
    } else if (mode === 'runtime' && argument.startsWith('--loads=')) {
      once('--loads')
      const value = argument.slice('--loads='.length)

      if (!LOADS.test(value) || Number(value) > MAXIMUM_LOADS) {
        throw new UsageError(`--loads must be a number from 1 to ${MAXIMUM_LOADS}.`)
      }

      options.loads = Number(value)
    } else {
      throw new UsageError(`Unknown argument for ${mode}: ${shown(argument)}`)
    }
  }

  if (mode === 'parity' && options.ref === null) {
    throw new UsageError('parity needs --ref <git-ref>: the commit before the unit (12 §7.3 item 3).')
  }

  return options
}

// ---------------------------------------------------------------------------
// Cleanup (Ctrl+C included)

const cleanups = []
let cleaningUp = false

/** Registers a synchronous cleanup step; steps run in reverse order, once. */
export function onCleanup(label, step) {
  const entry = { label, step }
  cleanups.push(entry)

  return () => {
    const index = cleanups.indexOf(entry)

    if (index !== -1) {
      cleanups.splice(index, 1)
    }
  }
}

export function runCleanups() {
  if (cleaningUp) {
    return
  }

  cleaningUp = true

  while (cleanups.length > 0) {
    const { label, step } = cleanups.pop()

    try {
      step()
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }

      const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name
      warn(`motion-audit: cleanup "${label}" did not finish (${code}).`)
    }
  }

  cleaningUp = false
}

function installSignalHandlers() {
  const onSignal = (signal) => {
    warn(`motion-audit: ${signal} received; cleaning up.`)
    runCleanups()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }

  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  process.once('SIGHUP', onSignal)
  process.on('exit', runCleanups)
}

/** rmSync with retries: Chrome and npm may hold a file for a moment after they exit. */
function removeTree(directory) {
  rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
}

// ---------------------------------------------------------------------------
// Processes

/** Runs `node <args>` in `cwd`; a failure throws ScriptFailure. Never a shell. */
function runNode(label, args, { cwd, env, timeoutMinutes }) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMinutes * 60_000,
    windowsHide: true,
  })

  if (result.error !== undefined) {
    const code = 'code' in result.error ? result.error.code : result.error.name
    throw new ScriptFailure(`motion-audit: ${label} did not complete (${code}).`)
  }

  if (result.status !== 0) {
    throw new ScriptFailure(`motion-audit: ${label} failed (exit ${result.status ?? result.signal}).`)
  }
}

/** git (read-only commands), captured; a failure throws ScriptFailure. */
function git(args, { cwd = appRoot, allowFailure = false } = {}) {
  const result = spawnSync('git', ['--no-pager', ...args], {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    windowsHide: true,
  })

  if (result.error !== undefined) {
    const code = 'code' in result.error ? result.error.code : result.error.name
    throw new ScriptFailure(`motion-audit: git did not run (${code}); is git installed?`)
  }

  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr ?? '')
      .split(/\r?\n/)
      .find((line) => line.trim() !== '')
    throw new ScriptFailure(`motion-audit: git ${args[0]} failed${detail ? `: ${redact(detail.slice(0, 200))}` : '.'}`)
  }

  return { status: result.status, stdout: String(result.stdout ?? '') }
}

/**
 * The npm CLI entry as `node <file>`: the one npm that started this script
 * (npm_execpath, set by `npm run`), or the npm shipped next to this node.
 */
export function npmCli(env = process.env, execPath = process.execPath) {
  const candidates = []
  const fromNpm = env.npm_execpath

  if (typeof fromNpm === 'string' && fromNpm.endsWith('.js')) {
    candidates.push(fromNpm)
  }

  const nodeDirectory = path.dirname(execPath)
  candidates.push(
    path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  )

  const found = candidates.find((candidate) => existsSync(candidate))

  if (found === undefined) {
    throw new ScriptFailure('motion-audit: npm-cli.js was not found next to node; run this through `npm run audit:parity`.')
  }

  return path.resolve(found)
}

/**
 * The child environment of an audit build: the parent's without any VITE_*
 * value, CLOUDFLARE_ENV or NODE_ENV, plus the audit's (empty) Firebase web
 * config and the design. `parent` is not changed.
 */
export function auditBuildEnvironment(parent, design) {
  const child = {}

  for (const [name, value] of Object.entries(parent)) {
    const upper = name.toUpperCase()

    if (upper.startsWith('VITE_') || upper === 'CLOUDFLARE_ENV' || upper === 'NODE_ENV') {
      continue
    }

    child[name] = value
  }

  return { ...child, ...STUB_FIREBASE_ENV, VITE_SITE_DESIGN: design }
}

/** `vite build --mode production` of `design` in `root` (no deploy, no tsc: verify owns the type check). */
function buildDesign(root, design, label) {
  log(`motion-audit: building ${label} (${design})…`)
  runNode(`${label} build`, [packageBin(root, 'vite', 'vite'), 'build', '--mode', 'production'], {
    cwd: root,
    env: auditBuildEnvironment(process.env, design),
    timeoutMinutes: BUILD_TIMEOUT_MINUTES,
  })

  const distClient = path.join(root, 'dist', 'client')
  const problems = checkDesignMarkers(design, builtClientText(distClient))

  if (problems.length > 0) {
    throw new ScriptFailure(
      [`motion-audit: ${label} is not a ${design} build:`, ...problems.map((problem) => `  - ${problem}`)].join('\n'),
    )
  }

  return distClient
}

/** `npm ci` in `root` (M7): the ref's own lockfile, no lifecycle scripts, no audit or funding chatter. */
function installDependencies(root) {
  log('motion-audit: npm ci in the worktree…')
  runNode(
    'npm ci',
    [npmCli(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error'],
    { cwd: root, env: auditBuildEnvironment(process.env, 'classic'), timeoutMinutes: NPM_CI_TIMEOUT_MINUTES },
  )
}

/** The commit `ref` names (read-only; --end-of-options keeps the ref from reading as a flag). */
export function resolveCommit(ref) {
  if (!GIT_REF.test(ref) || ref.includes('..')) {
    throw new UsageError('--ref needs a git ref: a commit, tag or branch name.')
  }

  const { status, stdout } = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], {
    allowFailure: true,
  })
  const sha = stdout.trim()

  if (status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new ScriptFailure(`motion-audit: ${shown(ref)} is not a commit of this repository.`)
  }

  return sha
}

/** A detached worktree of `sha` at `directory`, removed by cleanup. */
function addWorktree(sha, directory) {
  git(['worktree', 'add', '--detach', directory, sha])

  return onCleanup('git worktree', () => {
    git(['worktree', 'remove', '--force', directory], { allowFailure: true })

    if (existsSync(directory)) {
      removeTree(directory)
    }

    git(['worktree', 'prune'], { allowFailure: true })
  })
}

// ---------------------------------------------------------------------------
// Chrome

const CHROME_CANDIDATES = Object.freeze({
  win32: [
    ['PROGRAMFILES', 'Google', 'Chrome', 'Application', 'chrome.exe'],
    ['PROGRAMFILES(X86)', 'Google', 'Chrome', 'Application', 'chrome.exe'],
    ['LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe'],
    ['PROGRAMFILES', 'Chromium', 'Application', 'chrome.exe'],
  ],
  darwin: [
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
  ],
  linux: [
    ['/usr/bin/google-chrome'],
    ['/usr/bin/google-chrome-stable'],
    ['/usr/bin/chromium'],
    ['/usr/bin/chromium-browser'],
    ['/snap/bin/chromium'],
  ],
})

/**
 * The Chrome binary: CHROME_PATH (an existing file) or the platform's usual
 * locations. The path is printed; it is not a secret.
 */
export function findChrome(env = process.env, platform = process.platform) {
  const configured = env.CHROME_PATH

  if (typeof configured === 'string' && configured !== '') {
    if (!existsSync(configured) || !statSync(configured).isFile()) {
      throw new ScriptFailure('motion-audit: CHROME_PATH does not name a file.')
    }

    return path.resolve(configured)
  }

  for (const parts of CHROME_CANDIDATES[platform] ?? []) {
    const [first, ...rest] = parts
    const base = platform === 'win32' ? env[first] : first

    if (typeof base !== 'string' || base === '') {
      continue
    }

    const candidate = path.join(base, ...rest)

    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new ScriptFailure('motion-audit: Chrome was not found; set CHROME_PATH to the browser binary.')
}

/** The Chrome command line (TM-22): random loopback debugging port, temp profile, no background traffic. */
export function chromeArguments(profileDirectory) {
  return [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-features=Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions',
    '--metrics-recording-only',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--window-size=1280,800',
    '--lang=ar',
    'about:blank',
  ]
}

/**
 * The debugging endpoint from a profile's DevToolsActivePort file: line 1
 * the port, line 2 the browser target path. Null until Chrome wrote it.
 */
export function parseDevToolsActivePort(text) {
  const [portLine, pathLine] = String(text).split(/\r?\n/)

  if (!/^[1-9][0-9]{0,4}$/.test(portLine ?? '') || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(pathLine ?? '')) {
    return null
  }

  return { port: Number(portLine), path: pathLine }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Kills the Chrome process tree (taskkill /T on Windows, the process group elsewhere). */
function killChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      stdio: 'ignore',
      timeout: 15_000,
      windowsHide: true,
    })
    return
  }

  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
      throw error
    }
  }
}

/**
 * Starts Chrome on a temp profile and connects to it. The process and the
 * profile are removed by cleanup.
 */
async function launchChrome(scratch) {
  const chrome = findChrome()
  const profileDirectory = path.join(scratch, 'profile')
  mkdirSync(profileDirectory, { recursive: true })
  log(`motion-audit: Chrome ${chrome}`)

  const child = spawn(chrome, chromeArguments(profileDirectory), {
    cwd: scratch,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  })
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.once('error', () => {
    exited = true
  })

  const forget = onCleanup('Chrome', () => {
    killChrome(child)
    removeTree(profileDirectory)
  })

  const portFile = path.join(profileDirectory, 'DevToolsActivePort')
  const deadline = Date.now() + CHROME_START_TIMEOUT_MS
  let endpoint = null

  while (endpoint === null) {
    if (exited) {
      throw new ScriptFailure('motion-audit: Chrome exited before it opened its debugging port.')
    }

    if (Date.now() > deadline) {
      throw new ScriptFailure('motion-audit: Chrome did not open its debugging port in time.')
    }

    if (existsSync(portFile)) {
      endpoint = parseDevToolsActivePort(readFileSync(portFile, 'utf8'))
    }

    if (endpoint === null) {
      await sleep(100)
    }
  }

  const devtools = await DevTools.connect(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`)
  const { product } = await devtools.send('Browser.getVersion')
  log(`motion-audit: ${product} on 127.0.0.1:${endpoint.port}`)

  return {
    devtools,
    async close() {
      try {
        await Promise.race([devtools.send('Browser.close'), sleep(5000)])
      } catch (error) {
        if (!(error instanceof DevToolsError)) {
          throw error
        }
      }

      devtools.close()
      const gone = Date.now() + 5000

      while (!exited && Date.now() < gone) {
        await sleep(100)
      }

      forget()
      killChrome(child)
      removeTree(profileDirectory)
    },
  }
}

// ---------------------------------------------------------------------------
// DevTools Protocol client (Node's global WebSocket)

class DevToolsError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DevToolsError'
    this.code = code
  }
}

class DevTools {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      this.#receive(String(event.data))
    })
    socket.addEventListener('close', () => {
      for (const { reject, method } of this.#pending.values()) {
        reject(new DevToolsError(`${method}: the DevTools connection closed.`, 'CDP_CLOSED'))
      }

      this.#pending.clear()
    })
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => resolve(new DevTools(socket)), { once: true })
      socket.addEventListener(
        'error',
        () => reject(new ScriptFailure('motion-audit: could not connect to Chrome on 127.0.0.1.')),
        { once: true },
      )
    })
  }

  #receive(text) {
    let message

    try {
      message = JSON.parse(text)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }

      warn('motion-audit: Chrome sent a frame that is not JSON; ignored.')
      return
    }

    if (message === null || typeof message !== 'object') {
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)

      if (pending === undefined) {
        return
      }

      this.#pending.delete(message.id)

      if (message.error !== undefined) {
        pending.reject(new DevToolsError(`${pending.method}: ${message.error.message}`, 'CDP_ERROR'))
      } else {
        pending.resolve(message.result ?? {})
      }

      return
    }

    for (const listener of this.#listeners.get(`${message.sessionId ?? ''}:${message.method}`) ?? []) {
      listener(message.params ?? {})
    }
  }

  /** Sends `method`; rejects with a DevToolsError once the socket is no longer open. */
  send(method, params = {}, sessionId = undefined) {
    return new Promise((resolve, reject) => {
      if (this.#socket.readyState !== WebSocket.OPEN) {
        reject(new DevToolsError(`${method}: the DevTools connection is closed.`, 'CDP_CLOSED'))
        return
      }

      const id = this.#nextId
      this.#nextId += 1
      this.#pending.set(id, { resolve, reject, method })
      const message = { id, method, params }

      if (sessionId !== undefined) {
        message.sessionId = sessionId
      }

      this.#socket.send(JSON.stringify(message))
    })
  }

  /** Subscribes to `method` events of `sessionId`; returns the unsubscribe function. */
  on(method, sessionId, listener) {
    const key = `${sessionId ?? ''}:${method}`
    const list = this.#listeners.get(key) ?? []
    list.push(listener)
    this.#listeners.set(key, list)

    return () => {
      const current = this.#listeners.get(key) ?? []
      const index = current.indexOf(listener)

      if (index !== -1) {
        current.splice(index, 1)
      }
    }
  }

  close() {
    this.#socket.close()
  }
}

/**
 * True when a page request may leave Chrome: plain http to 127.0.0.1 on one
 * of the audit's own ports (TM-22). Anything unparsable is refused.
 */
export function isAllowedRequest(url, allowedPorts) {
  let parsed

  try {
    parsed = new URL(url)
  } catch (error) {
    if (error instanceof TypeError) {
      return false
    }

    throw error
  }

  return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && allowedPorts.has(parsed.port)
}

/** The host of a blocked request as it is counted (no path, query or credentials). */
function blockedHost(url) {
  try {
    return new URL(url).host || '(no host)'
  } catch (error) {
    if (error instanceof TypeError) {
      return '(unparsable)'
    }

    throw error
  }
}

/**
 * One page (a target in its own browser context): every request is
 * intercepted, console output and exceptions are collected, the viewport
 * and media are emulated, and an optional probe runs on every new document.
 */
class AuditPage {
  #devtools
  #session
  #targetId
  #contextId
  #disposeContext
  #unsubscribe = []
  #loadWaiters = []
  console = []
  blocked = new Map()

  constructor(devtools, session, targetId, contextId, disposeContext) {
    this.#devtools = devtools
    this.#session = session
    this.#targetId = targetId
    this.#contextId = contextId
    this.#disposeContext = disposeContext
  }

  /**
   * A page in a fresh browser context (own storage), or in `contextId`. The
   * context is disposed by close() when `disposeContext` is true: by default
   * for a fresh context; a caller that reuses a context across pages keeps
   * it alive on the first page and disposes it with the last.
   */
  static async open(
    devtools,
    {
      allowedPorts,
      viewport,
      reducedMotion = false,
      probe = null,
      network = null,
      cpuRate = 1,
      contextId = null,
      disposeContext = contextId === null,
    },
  ) {
    const browserContextId =
      contextId === null
        ? (await devtools.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId
        : contextId
    const { targetId } = await devtools.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
      width: viewport.width,
      height: viewport.height,
    })
    const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new AuditPage(devtools, sessionId, targetId, browserContextId, disposeContext)
    await page.#prepare({ allowedPorts, viewport, reducedMotion, probe, network, cpuRate })

    return page
  }

  get contextId() {
    return this.#contextId
  }

  async #prepare({ allowedPorts, viewport, reducedMotion, probe, network, cpuRate }) {
    const send = (method, params) => this.#devtools.send(method, params, this.#session)
    const on = (method, listener) => this.#unsubscribe.push(this.#devtools.on(method, this.#session, listener))

    on('Fetch.requestPaused', ({ requestId, request }) => {
      if (isAllowedRequest(request.url, allowedPorts)) {
        void send('Fetch.continueRequest', { requestId }).catch(swallowClosed)
        return
      }

      const host = blockedHost(request.url)
      this.blocked.set(host, (this.blocked.get(host) ?? 0) + 1)
      void send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(swallowClosed)
    })
    on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error' || type === 'warning' || type === 'assert') {
        const first = args?.[0]
        const text = typeof first?.value === 'string' ? first.value : (first?.description ?? '')
        this.console.push({ source: 'console', level: type, text: text.slice(0, 200) })
      }
    })
    on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const text = exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? 'exception'
      this.console.push({ source: 'exception', level: 'error', text: String(text).slice(0, 200) })
    })
    on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error' || entry.level === 'warning') {
        this.console.push({ source: entry.source, level: entry.level, text: String(entry.text ?? '').slice(0, 200) })
      }
    })
    on('Page.loadEventFired', () => {
      const waiters = this.#loadWaiters
      this.#loadWaiters = []

      for (const resolve of waiters) {
        resolve()
      }
    })

    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Log.enable')
    await send('Network.enable')
    await send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    })
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }],
    })

    if (network !== null) {
      await send('Network.emulateNetworkConditions', network)
    }

    if (cpuRate !== 1) {
      await send('Emulation.setCPUThrottlingRate', { rate: cpuRate })
    }

    if (probe !== null) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: probe })
    }
  }

  /** Full navigation; resolves after the load event (or fails after the timeout). */
  async navigate(url) {
    const loaded = new Promise((resolve) => {
      this.#loadWaiters.push(resolve)
    })
    const { errorText } = await this.#devtools.send('Page.navigate', { url }, this.#session)

    if (typeof errorText === 'string' && errorText !== '') {
      throw new ScriptFailure(`motion-audit: navigation to ${url} failed (${errorText}).`)
    }

    await withTimeout(loaded, NAVIGATION_TIMEOUT_MS, `the load event of ${url}`)
  }

  async reload() {
    const loaded = new Promise((resolve) => {
      this.#loadWaiters.push(resolve)
    })
    await this.#devtools.send('Page.reload', {}, this.#session)
    await withTimeout(loaded, NAVIGATION_TIMEOUT_MS, 'the load event of the reload')
  }

  /** Evaluates `expression` (a promise is awaited) and returns its JSON value. */
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.#devtools.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.#session,
    )

    if (exceptionDetails !== undefined) {
      const text = exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'exception'
      throw new ScriptFailure(`motion-audit: page script failed: ${redact(String(text).slice(0, 300))}`)
    }

    return result?.value
  }

  /** Polls `expression` until it is truthy; returns the value, or null after `timeoutMs`. */
  async waitFor(expression, timeoutMs, intervalMs = 50) {
    const deadline = Date.now() + timeoutMs

    for (;;) {
      const value = await this.evaluate(expression)

      if (value) {
        return value
      }

      if (Date.now() > deadline) {
        return null
      }

      await sleep(intervalMs)
    }
  }

  async screenshot() {
    const { data } = await this.#devtools.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      this.#session,
    )

    return Buffer.from(data, 'base64')
  }

  async pressTab() {
    const send = (method, params) => this.#devtools.send(method, params, this.#session)
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  }

  async click(x, y) {
    const send = (method, params) => this.#devtools.send(method, params, this.#session)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  async close() {
    for (const unsubscribe of this.#unsubscribe) {
      unsubscribe()
    }

    this.#unsubscribe = []

    try {
      await this.#devtools.send('Target.closeTarget', { targetId: this.#targetId })

      if (this.#disposeContext) {
        await this.#devtools.send('Target.disposeBrowserContext', { browserContextId: this.#contextId })
      }
    } catch (error) {
      if (!(error instanceof DevToolsError)) {
        throw error
      }
    }
  }
}

/** A Fetch answer that arrives after the page went away is not a failure. */
function swallowClosed(error) {
  if (!(error instanceof DevToolsError)) {
    throw error
  }
}

function withTimeout(promise, ms, what) {
  let timer

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ScriptFailure(`motion-audit: timed out waiting for ${what}.`)), ms)
    }),
  ]).finally(() => {
    clearTimeout(timer)
  })
}

// ---------------------------------------------------------------------------
// Static server for dist/client (SPA fallback)

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
})

/**
 * What the server answers for `urlPath` under `root`: { kind: 'file', file }
 * for a regular file inside root (never a symbolic link), { kind: 'fallback' }
 * for an extensionless path (the SPA route), { kind: 'missing' } for a file
 * that does not exist, { kind: 'bad' } for anything that could leave root.
 */
export function resolveStaticPath(root, urlPath) {
  let decoded

  try {
    decoded = decodeURIComponent(urlPath)
  } catch (error) {
    if (error instanceof URIError) {
      return { kind: 'bad' }
    }

    throw error
  }

  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) {
    return { kind: 'bad' }
  }

  const segments = decoded.split('/')

  if (segments.some((segment) => segment === '..' || /^[A-Za-z]:$/.test(segment))) {
    return { kind: 'bad' }
  }

  const base = path.resolve(root)
  const file = path.resolve(base, `.${decoded}`)

  if (file !== base && !file.startsWith(base + path.sep)) {
    return { kind: 'bad' }
  }

  let stats = null

  try {
    stats = lstatSync(file)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      throw error
    }
  }

  if (stats !== null && stats.isSymbolicLink()) {
    return { kind: 'bad' }
  }

  if (stats !== null && stats.isFile()) {
    return { kind: 'file', file }
  }

  const last = segments.at(-1) ?? ''

  return path.extname(last) === '' ? { kind: 'fallback' } : { kind: 'missing' }
}

/** Serves `root` on 127.0.0.1:0; resolves { port, close }. */
export function startStaticServer(root) {
  const base = path.resolve(root)
  const index = path.join(base, 'index.html')

  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' })
      response.end()
      return
    }

    const urlPath = String(request.url ?? '/').split('?')[0].split('#')[0]
    const resolved = resolveStaticPath(base, urlPath)
    let file = null
    let status = 200

    if (resolved.kind === 'file') {
      file = resolved.file
    } else if (resolved.kind === 'fallback' && !urlPath.startsWith('/api/')) {
      file = index
    } else if (resolved.kind === 'bad') {
      status = 400
    } else {
      status = 404
    }

    if (file === null) {
      const body = JSON.stringify({ error: { code: status === 400 ? 'BAD_PATH' : 'AUDIT_OFFLINE' } })
      response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      })
      response.end(request.method === 'HEAD' ? undefined : body)
      return
    }

    let body

    try {
      body = readFileSync(file)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error)) {
        throw error
      }

      response.writeHead(404)
      response.end()
      return
    }

    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      const forget = onCleanup('static server', () => {
        server.close()
      })

      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            forget()
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Build comparison: asset names, CSS hashes, DOM, diffs

/** `text` with every hashed asset name reduced to <name>.<ext>. */
export function normalizeAssetNames(text) {
  return String(text).replace(HASHED_ASSET, '$1$2')
}

/**
 * A page's outerHTML as the DOM gate compares it: the audit server's origin
 * removed (Vite's preload helper writes absolute URLs, and each side has its
 * own port), the `<link rel="modulepreload">` elements that helper injects
 * dropped (they mirror the JS chunk graph, which §7.3 item 3 lets differ;
 * stylesheet links stay, in order) and the hashed asset names normalised.
 */
export function normalizeDom(html, origin) {
  return normalizeAssetNames(String(html).replaceAll(origin, '').replace(MODULEPRELOAD_LINK, ''))
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The bytes of a data: URI (base64 or percent-encoded), or null. */
export function decodeDataUri(value) {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(value)

  if (match === null) {
    return null
  }

  if (match[2] !== undefined) {
    return Buffer.from(match[3], 'base64')
  }

  try {
    return Buffer.from(decodeURIComponent(match[3]), 'utf8')
  } catch (error) {
    if (error instanceof URIError) {
      return null
    }

    throw error
  }
}

/**
 * A stylesheet's text with every url() replaced by the sha256 of the bytes
 * it points at: a file of the build (root-absolute or relative to the
 * stylesheet) or a data: URI. So two builds compare equal exactly when
 * every rule and every referenced byte is the same, whatever the hashed
 * file names are (§7.3 item 3, M7, W1 review #62).
 */
export function normalizeCss(cssText, { distClient, cssFile }) {
  return String(cssText).replace(CSS_URL, (whole, _quote, rawValue) => {
    const value = rawValue.trim()

    if (value.startsWith('data:')) {
      const bytes = decodeDataUri(value)
      return bytes === null ? 'url(unreadable-data-uri)' : `url(sha256:${sha256(bytes)})`
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('#') || value.startsWith('//')) {
      return whole
    }

    const bare = value.split('?')[0].split('#')[0]
    const file = bare.startsWith('/')
      ? path.resolve(distClient, `.${bare}`)
      : path.resolve(path.dirname(cssFile), bare)
    const base = path.resolve(distClient)

    if (!file.startsWith(base + path.sep)) {
      return `url(outside-build:${normalizeAssetNames(bare)})`
    }

    try {
      return `url(sha256:${sha256(readFileSync(file))})`
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EISDIR')) {
        return `url(missing:${normalizeAssetNames(bare)})`
      }

      throw error
    }
  })
}

/** Every .css file below `directory`, recursively, as dist-relative names with forward slashes. */
function collectCssFiles(directory, prefix = '') {
  const files = []

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const fullPath = path.join(directory, entry.name)

    if (lstatSync(fullPath).isSymbolicLink()) {
      throw new ScriptFailure(`motion-audit: ${shown(name)} in a build is a symbolic link; refused.`)
    }

    if (entry.isDirectory()) {
      files.push(...collectCssFiles(fullPath, name))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.css')) {
      files.push({ name, file: fullPath })
    }
  }

  return files
}

/**
 * The emitted stylesheets of a build keyed by their normalised name:
 * { rawSha256, normalized, normalizedSha256 }.
 */
export function cssInventory(distClient) {
  const inventory = new Map()

  for (const { name, file } of collectCssFiles(path.join(distClient, 'assets'), 'assets')) {
    const key = normalizeAssetNames(`/${name}`)
    const text = readFileSync(file, 'utf8')
    const normalized = normalizeCss(text, { distClient, cssFile: file })

    if (inventory.has(key)) {
      throw new ScriptFailure(`motion-audit: two stylesheets normalise to ${shown(key)}; refused.`)
    }

    inventory.set(key, { rawSha256: sha256(text), normalized, normalizedSha256: sha256(normalized) })
  }

  return inventory
}

/** CSS split into one line per selector, declaration and closing brace, for a readable diff. */
function cssLines(text) {
  return text
    .replace(/\{/g, '{\n')
    .replace(/\}/g, '\n}\n')
    .replace(/;/g, ';\n')
    .split('\n')
    .filter((line) => line !== '')
}

/** HTML split at tag boundaries, for a readable diff. */
function htmlLines(text) {
  return text.replace(/></g, '>\n<').split('\n')
}

/**
 * The differing lines of `before` and `after` as a unified-style text with
 * two lines of context, at most DIFF_MAX_LINES lines. The common prefix and
 * suffix are trimmed first; the middle is aligned by longest common
 * subsequence when it is small enough, else listed side by side.
 */
export function diffLines(before, after) {
  let start = 0

  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1
  }

  let endBefore = before.length
  let endAfter = after.length

  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }

  const a = before.slice(start, endBefore)
  const b = after.slice(start, endAfter)

  if (a.length === 0 && b.length === 0) {
    return ''
  }

  const context = 2
  // The last lines of the common prefix, so the first change has context.
  const operations = before.slice(Math.max(0, start - context), start).map((line) => [' ', line])

  if (a.length * b.length <= 4_000_000) {
    const table = new Uint32Array((a.length + 1) * (b.length + 1))
    const width = b.length + 1

    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] =
          a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }

    let i = 0
    let j = 0

    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        operations.push([' ', a[i]])
        i += 1
        j += 1
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        operations.push(['-', a[i]])
        i += 1
      } else {
        operations.push(['+', b[j]])
        j += 1
      }
    }

    for (; i < a.length; i += 1) {
      operations.push(['-', a[i]])
    }

    for (; j < b.length; j += 1) {
      operations.push(['+', b[j]])
    }
  } else {
    for (const line of a) {
      operations.push(['-', line])
    }

    for (const line of b) {
      operations.push(['+', line])
    }
  }

  const lines = []

  for (let index = 0; index < operations.length; index += 1) {
    const [kind, text] = operations[index]

    if (kind !== ' ') {
      const from = Math.max(0, index - context)

      for (let k = from; k < index; k += 1) {
        if (operations[k][0] === ' ' && !lines.includes(`  ${operations[k][1]}`)) {
          lines.push(`  ${operations[k][1]}`)
        }
      }

      lines.push(`${kind} ${text}`)
    }
  }

  const header = `@@ line ${start + 1}: -${a.length} +${b.length} @@`
  const shownLines = lines.slice(0, DIFF_MAX_LINES)

  if (lines.length > DIFF_MAX_LINES) {
    shownLines.push(`… ${lines.length - DIFF_MAX_LINES} more line(s)`)
  }

  return [header, ...shownLines].join('\n')
}

/**
 * The CSS gate: the two inventories must have the same stylesheets with the
 * same normalised bytes. Returns { ok, problems: [{ name, detail, diff }] }.
 */
export function compareCss(reference, head) {
  const problems = []

  for (const name of reference.keys()) {
    if (!head.has(name)) {
      problems.push({ name, detail: 'emitted by the reference build only', diff: '' })
    }
  }

  for (const name of head.keys()) {
    if (!reference.has(name)) {
      problems.push({ name, detail: 'emitted by the working-tree build only', diff: '' })
    }
  }

  for (const [name, ref] of reference) {
    const current = head.get(name)

    if (current === undefined || current.normalizedSha256 === ref.normalizedSha256) {
      continue
    }

    problems.push({
      name,
      detail: `sha256 ${ref.normalizedSha256.slice(0, 12)}… (reference) ≠ ${current.normalizedSha256.slice(0, 12)}… (working tree)`,
      diff: diffLines(cssLines(ref.normalized), cssLines(current.normalized)),
    })
  }

  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------------------
// PNG (8-bit RGB/RGBA, non-interlaced: what Chrome captures)

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)

  if (pa <= pb && pa <= pc) {
    return a
  }

  return pb <= pc ? b : c
}

/** { width, height, rgba } from a PNG buffer; anything but 8-bit RGB/RGBA non-interlaced is refused. */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ScriptFailure('motion-audit: not a PNG file.')
  }

  let offset = 8
  let header = null
  const idat = []

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }

    offset += 12 + length
  }

  if (
    header === null ||
    header.bitDepth !== 8 ||
    (header.colorType !== 6 && header.colorType !== 2) ||
    header.interlace !== 0
  ) {
    throw new ScriptFailure('motion-audit: unsupported PNG (only 8-bit RGB/RGBA, non-interlaced).')
  }

  const channels = header.colorType === 6 ? 4 : 3
  const stride = header.width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const rgba = new Uint8Array(header.width * header.height * 4)
  let previous = new Uint8Array(stride)

  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      let value = line[x]

      if (filter === 1) {
        value += left
      } else if (filter === 2) {
        value += up
      } else if (filter === 3) {
        value += Math.floor((left + up) / 2)
      } else if (filter === 4) {
        value += paeth(left, up, upLeft)
      } else if (filter !== 0) {
        throw new ScriptFailure('motion-audit: corrupt PNG (unknown filter).')
      }

      line[x] = value & 255
    }

    for (let x = 0; x < header.width; x += 1) {
      const source = x * channels
      const target = (y * header.width + x) * 4
      rgba[target] = line[source]
      rgba[target + 1] = line[source + 1]
      rgba[target + 2] = line[source + 2]
      rgba[target + 3] = channels === 4 ? line[source + 3] : 255
    }

    previous = line
  }

  return { width: header.width, height: header.height, rgba }
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData) >>> 0)

  return Buffer.concat([length, typeAndData, crc])
}

/** A PNG buffer from { width, height, rgba } (filter 0, RGBA 8-bit). */
export function encodePng({ width, height, rgba }) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)

  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The share of pixels that differ between two decoded images (a channel
 * off by more than PIXEL_TOLERANCE), with a diff image: the reference
 * lightened, differing pixels in red. Different sizes differ entirely.
 */
export function compareImages(reference, head) {
  if (reference.width !== head.width || reference.height !== head.height) {
    return { ratio: 1, differing: reference.width * reference.height, total: reference.width * reference.height, diff: null }
  }

  const total = reference.width * reference.height
  const diff = new Uint8Array(total * 4)
  let differing = 0

  for (let index = 0; index < total; index += 1) {
    const at = index * 4
    const delta = Math.max(
      Math.abs(reference.rgba[at] - head.rgba[at]),
      Math.abs(reference.rgba[at + 1] - head.rgba[at + 1]),
      Math.abs(reference.rgba[at + 2] - head.rgba[at + 2]),
      Math.abs(reference.rgba[at + 3] - head.rgba[at + 3]),
    )

    if (delta > PIXEL_TOLERANCE) {
      differing += 1
      diff[at] = 220
      diff[at + 1] = 30
      diff[at + 2] = 30
    } else {
      const grey = Math.round(
        (0.299 * reference.rgba[at] + 0.587 * reference.rgba[at + 1] + 0.114 * reference.rgba[at + 2]) * 0.35 + 165,
      )
      diff[at] = grey
      diff[at + 1] = grey
      diff[at + 2] = grey
    }

    diff[at + 3] = 255
  }

  return { ratio: differing / total, differing, total, diff: { width: reference.width, height: reference.height, rgba: diff } }
}

// ---------------------------------------------------------------------------
// Page scripts

/** Installs a mutation clock; the caller polls domSettled() until it is old enough. */
const INSTALL_MUTATION_CLOCK = `(() => {
  const w = window
  if (!w.__syMutationObserver) {
    w.__syLastMutation = performance.now()
    w.__syMutationObserver = new MutationObserver(() => { w.__syLastMutation = performance.now() })
    w.__syMutationObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  }
  return true
})()`

const MUTATION_AGE = '(() => performance.now() - (window.__syLastMutation ?? 0))()'

/** Resolves once fonts are loaded and every image in the viewport is decoded (failures counted, not thrown). */
const WAIT_FOR_PAINT_INPUTS = `(async () => {
  await document.fonts.ready
  const inViewport = (image) => {
    const rect = image.getBoundingClientRect()
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
  }
  const images = Array.from(document.images).filter(inViewport)
  const results = await Promise.all(images.map((image) => image.decode().then(() => true, () => false)))
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  return { images: images.length, undecoded: results.filter((ok) => !ok).length }
})()`

const OUTER_HTML = 'document.documentElement.outerHTML'

const OVERFLOW_CHECK = `(() => {
  const root = document.scrollingElement
  const scrollWidth = root ? root.scrollWidth : 0
  const offenders = []
  const clipped = (element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowX
      if (overflow !== 'visible') return true
    }
    return false
  }
  for (const element of document.querySelectorAll('body *')) {
    const rect = element.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if ((rect.right > innerWidth + 1 || rect.left < -1) && !clipped(element)) {
      const name = element.tagName.toLowerCase() + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
      if (!offenders.includes(name)) offenders.push(name)
      if (offenders.length >= 8) break
    }
  }
  return { scrollWidth, innerWidth, offenders }
})()`

const SCROLL_TO_BOTTOM = `(() => { window.scrollTo(0, document.scrollingElement.scrollHeight); return true })()`

const RUNNING_ANIMATIONS = `document.getAnimations().filter((a) => a.playState === 'running').length`

/**
 * The runtime probe, installed before any page script on every new
 * document: records the intro attributes (t0 = the overlay leaving its wait
 * phase), view-transition and entry attributes, the paint timings, LCP, CLS,
 * long tasks and long animation frames, and the first frame at which the
 * hero H1 and primary CTA are both at opacity 1 (UX-01). It touches no DOM.
 */
function motionAuditProbe() {
  const state = {
    intro: { playingAt: null, t0: null, goneAt: null, reason: null, phases: [] },
    vt: [],
    entry: null,
    firstPaint: null,
    firstContentfulPaint: null,
    lcp: null,
    cls: 0,
    longTasks: [],
    longFrames: [],
    heroReadyAt: null,
    heroSeenAt: null,
  }
  window.__syMotionAudit = state
  const html = document.documentElement
  const now = () => performance.now()

  new MutationObserver((records) => {
    for (const record of records) {
      const name = record.attributeName
      const value = html.getAttribute(name)

      if (name === 'data-cine-intro') {
        if (value !== null && state.intro.playingAt === null) state.intro.playingAt = now()
        if (value === null && state.intro.playingAt !== null && state.intro.goneAt === null) state.intro.goneAt = now()
      } else if (name === 'data-cine-intro-reason') {
        state.intro.reason = value
      } else if (name === 'data-cine-vt') {
        state.vt.push({ value, at: now() })
      } else if (name === 'data-cine-entry') {
        state.entry = value
      }
    }
  }).observe(html, {
    attributes: true,
    attributeFilter: ['data-cine-intro', 'data-cine-intro-reason', 'data-cine-vt', 'data-cine-entry'],
  })

  new MutationObserver(() => {
    const overlay = document.querySelector('.cine-intro')
    if (!overlay) return
    const phase = overlay.getAttribute('data-phase')
    const last = state.intro.phases[state.intro.phases.length - 1]
    if (last && last.phase === phase) return
    state.intro.phases.push({ phase, at: now() })
    if (phase !== 'wait' && state.intro.t0 === null) state.intro.t0 = now()
  }).observe(html, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase'] })

  const supported = PerformanceObserver.supportedEntryTypes || []
  const observe = (type, handler) => {
    if (!supported.includes(type)) return
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) handler(entry)
    }).observe({ type, buffered: true })
  }
  observe('paint', (entry) => {
    if (entry.name === 'first-paint') state.firstPaint = entry.startTime
    if (entry.name === 'first-contentful-paint') state.firstContentfulPaint = entry.startTime
  })
  observe('largest-contentful-paint', (entry) => {
    const element = entry.element
    const describe = element
      ? element.tagName.toLowerCase() +
        (element.className && typeof element.className === 'string'
          ? '.' + element.className.trim().split(/\s+/).join('.')
          : '')
      : '(none)'
    state.lcp = { at: entry.startTime, element: describe, size: entry.size }
  })
  observe('layout-shift', (entry) => {
    if (!entry.hadRecentInput) state.cls += entry.value
  })
  observe('longtask', (entry) => {
    state.longTasks.push(Math.round(entry.duration))
  })
  observe('long-animation-frame', (entry) => {
    if (entry.duration > 50) state.longFrames.push(Math.round(entry.duration))
  })

  const opaque = (element) => {
    for (let node = element; node && node !== document; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.opacity !== '1' || style.visibility === 'hidden' || style.display === 'none') return false
    }
    return true
  }
  const started = now()
  const frame = () => {
    const h1 = document.querySelector('.home-hero__title')
    const cta = document.querySelector('.home-hero__actions .btn--primary')
    if (h1 && cta) {
      if (state.heroSeenAt === null) state.heroSeenAt = now()
      if (opaque(h1) && opaque(cta)) {
        state.heroReadyAt = now()
        return
      }
    }
    if (now() - started < 20000) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

const PROBE_SOURCE = `(${motionAuditProbe.toString()})()`
const PROBE_STATE = 'JSON.parse(JSON.stringify(window.__syMotionAudit ?? null))'

// ---------------------------------------------------------------------------
// Shared page steps

/** Waits until the DOM has been still for DOM_SETTLE_MS (capped); returns whether it settled. */
async function settleDom(page) {
  await page.evaluate(INSTALL_MUTATION_CLOCK)
  const deadline = Date.now() + DOM_SETTLE_CAP_MS

  for (;;) {
    const age = await page.evaluate(MUTATION_AGE)

    if (typeof age === 'number' && age >= DOM_SETTLE_MS) {
      return true
    }

    if (Date.now() > deadline) {
      return false
    }

    await sleep(100)
  }
}

function median(values) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b)

  if (sorted.length === 0) {
    return null
  }

  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function ms(value) {
  return typeof value === 'number' ? `${Math.round(value)} ms` : 'n/a'
}

function routeSlug(route) {
  return route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^A-Za-z0-9-]+/g, '-')
}

/** The results ledger: pass/fail/na lines and the JSON report. */
class Ledger {
  entries = []

  pass(check, detail = '') {
    this.entries.push({ status: 'pass', check, detail })
    log(`  ok    ${check}${detail ? ` — ${detail}` : ''}`)
  }

  fail(check, detail = '') {
    this.entries.push({ status: 'fail', check, detail })
    log(`  FAIL  ${check}${detail ? ` — ${detail}` : ''}`)
  }

  na(check, detail = '') {
    this.entries.push({ status: 'n/a', check, detail })
    log(`  n/a   ${check}${detail ? ` — ${detail}` : ''}`)
  }

  info(check, detail = '') {
    this.entries.push({ status: 'info', check, detail })
    log(`  info  ${check}${detail ? ` — ${detail}` : ''}`)
  }

  get failures() {
    return this.entries.filter((entry) => entry.status === 'fail')
  }
}

function reportDirectory(options, mode) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const directory = path.join(options.out ?? DEFAULT_PATHS.reports, `${mode}-${stamp}`)
  mkdirSync(directory, { recursive: true })

  return directory
}

function writeReport(directory, report) {
  writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// parity

async function runParity(options) {
  const sha = resolveCommit(options.ref)
  const report = reportDirectory(options, 'parity')
  const scratch = mkdtempSync(path.join(tmpdir(), 'sy-motion-audit-'))
  const forgetScratch = onCleanup('temp folder', () => {
    if (!options.keep) {
      removeTree(scratch)
    }
  })
  log(`motion-audit: parity — reference ${sha.slice(0, 12)} (${options.ref}) vs the working tree; report in ${report}`)

  // 1. Reference build in a detached worktree (npm ci first, M7).
  const worktree = path.join(scratch, 'ref')
  const forgetWorktree = addWorktree(sha, worktree)
  installDependencies(worktree)
  const referenceDist = path.join(scratch, 'builds', 'reference')
  cpSync(buildDesign(worktree, 'classic', 'the reference'), referenceDist, { recursive: true })
  forgetWorktree()
  git(['worktree', 'remove', '--force', worktree], { allowFailure: true })
  git(['worktree', 'prune'], { allowFailure: true })

  // 2. Working-tree build.
  const headDist = path.join(scratch, 'builds', 'head')
  cpSync(buildDesign(appRoot, 'classic', 'the working tree'), headDist, { recursive: true })

  const ledger = new Ledger()
  const summary = { mode: 'parity', ref: options.ref, sha, css: {}, dom: {}, screenshots: {}, blocked: {} }
  log('motion-audit: hard gate — emitted CSS')

  // 3. CSS hashes (hard gate).
  const referenceCss = cssInventory(referenceDist)
  const headCss = cssInventory(headDist)
  const css = compareCss(referenceCss, headCss)

  for (const [name, entry] of headCss) {
    const ref = referenceCss.get(name)
    summary.css[name] = {
      workingTree: entry.rawSha256,
      reference: ref?.rawSha256 ?? null,
      normalizedEqual: ref !== undefined && ref.normalizedSha256 === entry.normalizedSha256,
    }
  }

  if (css.ok) {
    ledger.pass(`CSS: ${headCss.size} stylesheet(s) identical after url() bytes are hashed`)
  } else {
    for (const problem of css.problems) {
      ledger.fail(`CSS ${problem.name}`, problem.detail)

      if (problem.diff !== '') {
        const file = path.join(report, `css-${path.basename(problem.name)}.diff.txt`)
        writeFileSync(file, `${problem.diff}\n`)
        log(problem.diff)
        log(`  (written to ${file})`)
      }
    }
  }

  // 4. DOM and screenshots in Chrome.
  const referenceServer = await startStaticServer(referenceDist)
  const headServer = await startStaticServer(headDist)
  const allowedPorts = new Set([String(referenceServer.port), String(headServer.port)])
  const chrome = await launchChrome(scratch)

  try {
    log('motion-audit: hard gate — DOM of the public routes (reduced motion, 1280×800)')

    for (const route of PARITY_ROUTES) {
      const captures = {}
      const blocked = new Map()

      for (const [label, server] of [
        ['reference', referenceServer],
        ['workingTree', headServer],
      ]) {
        const page = await AuditPage.open(chrome.devtools, {
          allowedPorts,
          viewport: DESKTOP_VIEWPORT,
          reducedMotion: true,
        })

        try {
          await page.navigate(`${server.origin}${route}`)
          const settled = await settleDom(page)
          await page.evaluate(WAIT_FOR_PAINT_INPUTS)
          captures[label] = { html: normalizeDom(await page.evaluate(OUTER_HTML), server.origin), settled }

          for (const [host, count] of page.blocked) {
            blocked.set(host, (blocked.get(host) ?? 0) + count)
          }
        } finally {
          await page.close()
        }
      }

      summary.blocked[route] = Object.fromEntries(blocked)
      const same = captures.reference.html === captures.workingTree.html
      summary.dom[route] = {
        equal: same,
        reference: sha256(captures.reference.html),
        workingTree: sha256(captures.workingTree.html),
        settled: captures.reference.settled && captures.workingTree.settled,
      }

      if (same) {
        ledger.pass(`DOM ${route}`, `${captures.workingTree.html.length} chars, sha256 ${summary.dom[route].workingTree.slice(0, 12)}…`)
      } else {
        const diff = diffLines(htmlLines(captures.reference.html), htmlLines(captures.workingTree.html))
        const file = path.join(report, `dom-${routeSlug(route)}.diff.txt`)
        writeFileSync(file, `${diff}\n`)
        ledger.fail(`DOM ${route}`, summary.dom[route].settled ? 'differs' : 'differs (the DOM kept changing; see the diff)')
        log(diff)
        log(`  (written to ${file})`)
      }
    }

    log(`motion-audit: supporting check — screenshots (≤ ${BUDGETS.screenshotDiffRatio * 100}% differing pixels)`)

    for (const viewport of PARITY_VIEWPORTS) {
      for (const route of PARITY_ROUTES) {
        const images = {}

        for (const [label, server] of [
          ['reference', referenceServer],
          ['workingTree', headServer],
        ]) {
          const page = await AuditPage.open(chrome.devtools, { allowedPorts, viewport, reducedMotion: true })

          try {
            await page.navigate(`${server.origin}${route}`)
            await settleDom(page)
            const inputs = await page.evaluate(WAIT_FOR_PAINT_INPUTS)
            const png = await page.screenshot()
            images[label] = { png, inputs }
          } finally {
            await page.close()
          }
        }

        const key = `${route} @ ${viewport.width}×${viewport.height}`
        const prefix = path.join(report, `shot-${routeSlug(route)}-${viewport.width}x${viewport.height}`)
        writeFileSync(`${prefix}-reference.png`, images.reference.png)
        writeFileSync(`${prefix}-working-tree.png`, images.workingTree.png)
        const result = compareImages(decodePng(images.reference.png), decodePng(images.workingTree.png))
        const percent = `${(result.ratio * 100).toFixed(3)}%`
        const undecoded = images.reference.inputs.undecoded + images.workingTree.inputs.undecoded
        summary.screenshots[key] = { ratio: result.ratio, differing: result.differing, total: result.total, undecoded }

        if (result.ratio <= BUDGETS.screenshotDiffRatio) {
          ledger.pass(`screenshot ${key}`, `${result.differing} of ${result.total} pixels differ (${percent})`)
        } else {
          if (result.diff !== null) {
            writeFileSync(`${prefix}-diff.png`, encodePng(result.diff))
          }

          ledger.fail(`screenshot ${key}`, `${percent} differing pixels; see ${prefix}-*.png`)
        }

        if (undecoded > 0) {
          ledger.info(`screenshot ${key}`, `${undecoded} image(s) in the viewport did not decode`)
        }
      }
    }
  } finally {
    await chrome.close()
    await referenceServer.close()
    await headServer.close()
  }

  const blockedTotal = Object.values(summary.blocked).reduce(
    (sum, hosts) => sum + Object.values(hosts).reduce((a, b) => a + b, 0),
    0,
  )
  ledger.info('blocked requests', blockedTotal === 0 ? 'none' : `${blockedTotal} (${describeBlocked(summary.blocked)})`)

  summary.checks = ledger.entries
  writeReport(report, summary)
  forgetScratch()

  if (!options.keep) {
    removeTree(scratch)
  } else {
    log(`motion-audit: builds kept in ${scratch}`)
  }

  finish(ledger, `parity vs ${options.ref}`)
}

function describeBlocked(byRoute) {
  const hosts = new Map()

  for (const entry of Object.values(byRoute)) {
    for (const [host, count] of Object.entries(entry)) {
      hosts.set(host, (hosts.get(host) ?? 0) + count)
    }
  }

  return [...hosts].map(([host, count]) => `${host} ×${count}`).join(', ')
}

function finish(ledger, label) {
  const failures = ledger.failures

  if (failures.length === 0) {
    log(`motion-audit: ${label} OK (${ledger.entries.filter((entry) => entry.status === 'pass').length} check(s) passed).`)
    return
  }

  throw new ScriptFailure(
    [`motion-audit: ${label} FAILED (${failures.length} check(s)):`, ...failures.map((entry) => `  - ${entry.check}${entry.detail ? `: ${entry.detail}` : ''}`)].join(
      '\n',
    ),
  )
}

// ---------------------------------------------------------------------------
// runtime

/** Which motion features the build contains (§7.3 item 4 markers), so absent ones read as n/a. */
function buildFeatures(distClient) {
  const files = builtClientText(distClient)
  const has = (marker) => files.some((file) => file.text.includes(marker))

  return {
    cinematic: has('data-design'),
    intro: has('cine-intro'),
    viewTransitions: has('startViewTransition'),
  }
}

async function runRuntime(options) {
  const report = reportDirectory(options, 'runtime')
  const scratch = mkdtempSync(path.join(tmpdir(), 'sy-motion-audit-'))
  const forgetScratch = onCleanup('temp folder', () => {
    removeTree(scratch)
  })
  let distClient = DEFAULT_PATHS.distClient

  if (options.build) {
    distClient = buildDesign(appRoot, options.design, 'the working tree')
  } else {
    const problems = existsSync(path.join(distClient, 'index.html'))
      ? checkDesignMarkers(options.design, builtClientText(distClient))
      : ['dist/client/index.html is missing']

    if (problems.length > 0) {
      throw new ScriptFailure(
        [`motion-audit: dist/client is not a ${options.design} build (drop --no-build):`, ...problems.map((p) => `  - ${p}`)].join('\n'),
      )
    }
  }

  const features = buildFeatures(distClient)
  log(
    `motion-audit: runtime — design=${options.design}, intro ${features.intro ? 'built' : 'not built'}, view transitions ${features.viewTransitions ? 'built' : 'not built'}; report in ${report}`,
  )
  const server = await startStaticServer(distClient)
  const allowedPorts = new Set([String(server.port)])
  const chrome = await launchChrome(scratch)
  const ledger = new Ledger()
  const summary = { mode: 'runtime', design: options.design, throttle: options.throttle, features, routes: {}, metrics: {} }
  const blocked = new Map()
  const collectBlocked = (page) => {
    for (const [host, count] of page.blocked) {
      blocked.set(host, (blocked.get(host) ?? 0) + count)
    }
  }
  const open = (settings) => AuditPage.open(chrome.devtools, { allowedPorts, ...settings })

  try {
    // A3: console and overflow per route and viewport.
    log('motion-audit: console and horizontal overflow')

    for (const route of PARITY_ROUTES) {
      summary.routes[route] = {}

      for (const viewport of [...OVERFLOW_VIEWPORTS, DESKTOP_VIEWPORT]) {
        const page = await open({ viewport })

        try {
          await page.navigate(`${server.origin}${route}`)
          const readings = []
          const record = async (label) => {
            readings.push({ label, ...(await page.evaluate(OVERFLOW_CHECK)) })
          }
          await record('t=0')
          await sleep(1000)
          await record('t=1s')
          await sleep(2000)
          await record('t=3s')
          await page.evaluate(SCROLL_TO_BOTTOM)
          await sleep(300)
          await record('bottom')
          collectBlocked(page)

          const size = `${viewport.width}×${viewport.height}`
          const pageErrors = page.console.filter((entry) => entry.source !== 'network')
          const networkErrors = page.console.length - pageErrors.length
          summary.routes[route][size] = { console: page.console, overflow: readings }

          if (pageErrors.length === 0) {
            ledger.pass(`console ${route} @ ${size}`, networkErrors === 0 ? 'clean' : `clean (${networkErrors} network entries: the audit serves no API)`)
          } else {
            ledger.fail(
              `console ${route} @ ${size}`,
              pageErrors.map((entry) => `${entry.level}: ${entry.text}`).join(' | ').slice(0, 400),
            )
          }

          if (viewport.mobile) {
            const bad = readings.filter((reading) => reading.scrollWidth > reading.innerWidth || reading.offenders.length > 0)

            if (bad.length === 0) {
              ledger.pass(`overflow ${route} @ ${size}`, 'no horizontal scroll, no element past the viewport')
            } else {
              ledger.fail(
                `overflow ${route} @ ${size}`,
                bad
                  .map((reading) => `${reading.label}: scrollWidth ${reading.scrollWidth} > ${reading.innerWidth}${reading.offenders.length > 0 ? `; ${reading.offenders.join(', ')}` : ''}`)
                  .join(' | '),
              )
            }
          }
        } finally {
          await page.close()
        }
      }
    }

    // A5: reduced motion — no running animation 200 ms after load and after a navigation.
    log('motion-audit: reduced motion')

    for (const viewport of [MOBILE_VIEWPORT, DESKTOP_VIEWPORT]) {
      const page = await open({ viewport, reducedMotion: true, probe: PROBE_SOURCE })

      try {
        await page.navigate(`${server.origin}/`)
        await sleep(BUDGETS.reducedMotionSettleMs)
        const afterLoad = await page.evaluate(RUNNING_ANIMATIONS)
        const state = await page.evaluate(PROBE_STATE)
        const size = `${viewport.width}×${viewport.height}`

        if (afterLoad === 0) {
          ledger.pass(`reduced motion @ ${size}: 0 running animations 200 ms after load`)
        } else {
          ledger.fail(`reduced motion @ ${size}`, `${afterLoad} running animation(s) 200 ms after load`)
        }

        if (features.intro && state?.intro?.playingAt !== null) {
          ledger.fail(`reduced motion @ ${size}`, 'the intro played')
        }

        const navigated = await clickNavigation(page, '/portfolio')

        if (navigated) {
          await sleep(BUDGETS.reducedMotionSettleMs)
          const afterNavigation = await page.evaluate(RUNNING_ANIMATIONS)

          if (afterNavigation === 0) {
            ledger.pass(`reduced motion @ ${size}: 0 running animations 200 ms after a navigation`)
          } else {
            ledger.fail(`reduced motion @ ${size}`, `${afterNavigation} running animation(s) 200 ms after a navigation`)
          }
        } else {
          ledger.fail(`reduced motion @ ${size}`, 'the header link to /portfolio did not navigate')
        }

        collectBlocked(page)
      } finally {
        await page.close()
      }
    }

    // Intro (UX-01, UX-11) — only when the build contains it.
    log('motion-audit: intro')

    if (!features.intro) {
      ledger.na('intro', options.design === 'classic' ? 'classic build' : 'not built yet (MOT-10 / W5-02)')
    } else {
      await auditIntro({ open, server, ledger, collectBlocked })
    }

    // View transitions (UX-09, M5) — only when the build contains them.
    log('motion-audit: view transitions')

    if (!features.viewTransitions) {
      ledger.na('view transitions', options.design === 'classic' ? 'classic build' : 'not built yet (MOT-09 / W4-09)')
    } else {
      await auditViewTransitions({ open, server, ledger, collectBlocked })
    }

    // A4 / UX-01 metrics over N loads (Fast 4G; 4× CPU with --throttle).
    log(`motion-audit: metrics over ${options.loads} load(s) of / at 375×812 on Fast 4G${options.throttle ? ' + 4× CPU' : ''}`)
    const loads = []

    for (let index = 0; index < options.loads; index += 1) {
      const page = await open({
        viewport: MOBILE_VIEWPORT,
        probe: PROBE_SOURCE,
        network: FAST_4G,
        cpuRate: options.throttle ? CPU_THROTTLE_RATE : 1,
      })

      try {
        await page.navigate(`${server.origin}/`)
        await page.waitFor('(window.__syMotionAudit?.heroReadyAt ?? null) !== null', 12_000, 100)
        await sleep(1500)
        const state = await page.evaluate(PROBE_STATE)
        collectBlocked(page)
        loads.push(summariseLoad(state))
      } finally {
        await page.close()
      }
    }

    summary.metrics = { loads, ...reportMetrics(loads, features, ledger) }
    ledger.info('blocked requests', blocked.size === 0 ? 'none' : [...blocked].map(([host, count]) => `${host} ×${count}`).join(', '))
    summary.blocked = Object.fromEntries(blocked)
  } finally {
    await chrome.close()
    await server.close()
  }

  summary.checks = ledger.entries
  writeReport(report, summary)
  forgetScratch()
  removeTree(scratch)
  finish(ledger, `runtime (${options.design})`)
}

/** Clicks the header link to `route` with a real mouse event; true once location.pathname is `route`. */
async function clickNavigation(page, route, { waitMs = 5000 } = {}) {
  const centre = await page.evaluate(`(() => {
    const link = document.querySelector('header a[href="${route}"]') ?? document.querySelector('a[href="${route}"]')
    if (!link) return null
    link.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = link.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)

  if (centre === null) {
    return false
  }

  await page.click(centre.x, centre.y)

  return (await page.waitFor(`location.pathname === '${route}'`, waitMs)) !== null
}

function summariseLoad(state) {
  const intro = state?.intro ?? {}
  const t0 = intro.t0 ?? intro.playingAt ?? null
  const reference = t0 ?? state?.firstPaint ?? state?.firstContentfulPaint ?? null

  return {
    introReason: intro.reason ?? null,
    t0,
    introGoneAfterT0: typeof intro.goneAt === 'number' && typeof t0 === 'number' ? intro.goneAt - t0 : null,
    firstPaint: state?.firstPaint ?? null,
    heroReadyAt: state?.heroReadyAt ?? null,
    heroReadyAfterReference:
      typeof state?.heroReadyAt === 'number' && typeof reference === 'number' ? state.heroReadyAt - reference : null,
    lcp: state?.lcp ?? null,
    cls: typeof state?.cls === 'number' ? Number(state.cls.toFixed(4)) : null,
    longTasks: state?.longTasks ?? [],
    longFrames: state?.longFrames ?? [],
  }
}

function reportMetrics(loads, features, ledger) {
  const withIntro = loads.filter((load) => load.introReason === 'play' || load.introReason === 'logo-not-ready')
  const notReady = loads.filter((load) => load.introReason === 'logo-not-ready').length
  const lcpAt = median(loads.map((load) => load.lcp?.at))
  const lcpElements = [...new Set(loads.map((load) => load.lcp?.element ?? '(none)'))]
  const cls = Math.max(...loads.map((load) => load.cls ?? 0), 0)
  const heroAfter = median(loads.map((load) => load.heroReadyAfterReference))
  const heroBudget = features.intro && withIntro.length > 0 ? BUDGETS.heroReadyAfterT0Ms : BUDGETS.heroReadyAfterFirstPaintMs
  const heroReference = features.intro && withIntro.length > 0 ? 't0' : 'first paint'
  const longTasks = loads.flatMap((load) => load.longTasks)

  if (lcpElements.length === 1 && lcpElements[0] === BUDGETS.lcpElement) {
    ledger.pass('LCP element', `${BUDGETS.lcpElement}; median LCP ${ms(lcpAt)}`)
  } else {
    ledger.fail('LCP element', `expected ${BUDGETS.lcpElement}, saw ${lcpElements.join(', ')}; median LCP ${ms(lcpAt)}`)
  }

  if (cls <= BUDGETS.cls) {
    ledger.pass('CLS', `max ${cls.toFixed(4)} (budget ${BUDGETS.cls})`)
  } else {
    ledger.fail('CLS', `max ${cls.toFixed(4)} > ${BUDGETS.cls}`)
  }

  if (heroAfter === null) {
    ledger.fail('hero readiness', 'the hero H1 and primary CTA never reached opacity 1')
  } else if (heroAfter <= heroBudget) {
    ledger.pass('hero readiness', `median ${ms(heroAfter)} after ${heroReference} (budget ${heroBudget} ms)`)
  } else {
    ledger.fail('hero readiness', `median ${ms(heroAfter)} after ${heroReference} > ${heroBudget} ms`)
  }

  if (features.intro) {
    const rate = loads.length === 0 ? 0 : notReady / loads.length
    ledger.info('logo-not-ready rate', `${notReady} of ${loads.length} Fast 4G load(s) (${(rate * 100).toFixed(0)}%)`)
    const gone = median(loads.map((load) => load.introGoneAfterT0))
    ledger.info('intro duration', `median ${ms(gone)} after t0 over ${withIntro.length} load(s) that played`)
  } else {
    ledger.na('logo-not-ready rate', 'no intro in this build')
  }

  ledger.info(
    'long tasks',
    longTasks.length === 0 ? 'none > 50 ms' : `${longTasks.length} over ${loads.length} load(s), longest ${Math.max(...longTasks)} ms`,
  )

  return {
    medianLcpMs: lcpAt,
    lcpElements,
    maxCls: cls,
    medianHeroReadyMs: heroAfter,
    heroReference,
    logoNotReady: features.intro ? { count: notReady, loads: loads.length } : null,
    longTasks: longTasks.length,
  }
}

async function auditIntro({ open, server, ledger, collectBlocked }) {
  // First visit in a fresh context: plays, gone ≤ 2.0 s after t0.
  // The browser context outlives the first page: the second-session check
  // below opens a new page on the same storage and disposes it.
  const first = await open({ viewport: MOBILE_VIEWPORT, probe: PROBE_SOURCE, disposeContext: false })
  const contextId = first.contextId

  try {
    await first.navigate(`${server.origin}/`)
    await first.waitFor('(window.__syMotionAudit?.intro?.goneAt ?? null) !== null', 6000, 50)
    const state = await first.evaluate(PROBE_STATE)
    const intro = state?.intro ?? {}
    collectBlocked(first)

    if (intro.reason !== 'play' || intro.playingAt === null) {
      ledger.fail('intro: first visit', `did not play (reason ${intro.reason ?? 'none'})`)
    } else if (intro.goneAt === null) {
      ledger.fail('intro: first visit', 'played but never finished')
    } else {
      const t0 = intro.t0 ?? intro.playingAt
      const after = intro.goneAt - t0

      if (after <= BUDGETS.introGoneAfterT0Ms) {
        ledger.pass('intro: first visit', `played and gone ${ms(after)} after t0 (entry ${state.entry ?? 'unset'})`)
      } else {
        ledger.fail('intro: first visit', `gone ${ms(after)} after t0 > ${BUDGETS.introGoneAfterT0Ms} ms`)
      }
    }

    // Reload: no intro.
    await first.reload()
    await sleep(800)
    const reloaded = await first.evaluate(PROBE_STATE)

    if (reloaded?.intro?.playingAt === null) {
      ledger.pass('intro: reload', `no intro (reason ${reloaded.intro.reason ?? 'none'})`)
    } else {
      ledger.fail('intro: reload', 'the intro played again')
    }
  } finally {
    await first.close()
  }

  // A second session (new page, same storage) within 60 days: no intro.
  const second = await open({ viewport: MOBILE_VIEWPORT, probe: PROBE_SOURCE, contextId, disposeContext: true })

  try {
    await second.navigate(`${server.origin}/`)
    await sleep(800)
    const state = await second.evaluate(PROBE_STATE)

    if (state?.intro?.playingAt === null) {
      ledger.pass('intro: second session', `no intro (reason ${state.intro.reason ?? 'none'})`)
    } else {
      ledger.fail('intro: second session', 'the intro played again')
    }

    collectBlocked(second)
  } finally {
    await second.close()
  }

  // Tab at t0 + 300 ms: gone at once, focus on the skip link (UX-11).
  const tabbed = await open({ viewport: DESKTOP_VIEWPORT, probe: PROBE_SOURCE })

  try {
    await tabbed.navigate(`${server.origin}/`)
    const t0 = await tabbed.waitFor('window.__syMotionAudit?.intro?.t0 ?? window.__syMotionAudit?.intro?.playingAt ?? null', 3000, 20)

    if (t0 === null) {
      ledger.fail('intro: Tab at 300 ms', 'the intro did not start')
    } else {
      const elapsed = await tabbed.evaluate(`performance.now() - ${t0}`)
      await sleep(Math.max(0, BUDGETS.tabAtMs - elapsed))
      await tabbed.pressTab()
      await sleep(BUDGETS.introInstantFinishMs)
      const result = await tabbed.evaluate(`({
        attribute: document.documentElement.getAttribute('data-cine-intro'),
        overlay: document.querySelector('.cine-intro') !== null,
        skipLink: document.activeElement?.classList.contains('skip-link') === true,
      })`)

      if (result.attribute === null && !result.overlay && result.skipLink) {
        ledger.pass('intro: Tab at 300 ms', `gone within ${BUDGETS.introInstantFinishMs} ms, focus on the skip link`)
      } else {
        ledger.fail(
          'intro: Tab at 300 ms',
          `attribute ${result.attribute ?? 'absent'}, overlay ${result.overlay ? 'present' : 'gone'}, skip link ${result.skipLink ? 'focused' : 'not focused'}`,
        )
      }
    }

    collectBlocked(tabbed)
  } finally {
    await tabbed.close()
  }
}

async function auditViewTransitions({ open, server, ledger, collectBlocked }) {
  const page = await open({ viewport: DESKTOP_VIEWPORT, probe: PROBE_SOURCE })

  try {
    await page.navigate(`${server.origin}/`)
    await settleDom(page)
    const navigated = await clickNavigation(page, '/portfolio')
    await sleep(700)
    const state = await page.evaluate(PROBE_STATE)
    const focus = await page.evaluate(`(() => {
      const h1 = document.querySelector('main h1')
      return { h1: h1 !== null, focused: h1 !== null && document.activeElement === h1, vt: document.documentElement.hasAttribute('data-cine-vt') }
    })()`)

    if (!navigated) {
      ledger.fail('view transition: navigation', 'the header link to /portfolio did not navigate')
    } else if ((state?.vt ?? []).length === 0) {
      ledger.fail('view transition: attribute', 'data-cine-vt was never set during the navigation')
    } else {
      const values = state.vt.map((entry) => entry.value ?? 'removed').join(' → ')
      ledger.pass('view transition: attribute', `observed (${values})${focus.vt ? '; STILL SET' : ''}`)

      if (focus.vt) {
        ledger.fail('view transition: attribute', 'data-cine-vt is still set 700 ms after the navigation')
      }
    }

    if (focus.focused) {
      ledger.pass('view transition: focus', 'the new H1 is focused')
    } else {
      ledger.fail('view transition: focus', focus.h1 ? 'the new H1 is not focused' : 'no main h1 after the navigation')
    }

    // A tap during the transition reaches the page (UX-09): navigate to
    // /packages and, 100 ms in, tap the header link back to /portfolio.
    await settleDom(page)
    const started = await clickNavigation(page, '/packages', { waitMs: 50 })
    await sleep(started ? 0 : 100)
    const tapped = await clickNavigation(page, '/portfolio', { waitMs: 2500 })

    if (tapped) {
      ledger.pass('view transition: taps reach the page', 'a tap 100 ms into the transition navigated')
    } else {
      ledger.fail('view transition: taps reach the page', 'the tap during the transition was lost')
    }

    collectBlocked(page)
  } finally {
    await page.close()
  }
}

// ---------------------------------------------------------------------------
// CLI

export async function main(argv) {
  const options = parseAuditArguments(argv)

  if ('help' in options) {
    log(USAGE)
    return
  }

  if (typeof WebSocket !== 'function') {
    throw new ScriptFailure('motion-audit: this Node has no global WebSocket; Node 24 is required.')
  }

  installSignalHandlers()

  if (options.mode === 'parity') {
    await runParity(options)
  } else {
    await runRuntime(options)
  }
}

if (isMainModule(import.meta.url)) {
  await runCli(() => main(process.argv.slice(2)), USAGE)
}
