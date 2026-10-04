#!/usr/bin/env node
// MOT-02 (plan 11 W2-19; 12-motion-spec.md §7.4; H6/TM-05): build or serve
// one design of the site locally. It never deploys: there is one deploy path,
// scripts/release.mjs (W3-19), and this script has no --deploy and no
// --allow-dirty.
//
//   node scripts/build-design.mjs <classic|cinematic> [--env=production|preview]
//   node scripts/build-design.mjs <classic|cinematic> --dev [--env=production|preview] [--port=<1024-65535>]
//
// - Strict allowlist: exactly one design, each option at most once and only
//   in the exact spellings above. Anything else prints the usage and exits 2
//   before anything runs (a typo must never build the other design).
// - tsc -b and vite build (or vite, with --dev) run as
//   `node node_modules/<package>/<bin entry>` through spawnSync with argument
//   arrays and shell: false, so no shell parses any argument.
// - The child environment is the inherited one with VITE_SITE_DESIGN set to
//   the design and CLOUDFLARE_ENV decided explicitly: --env=preview sets it
//   to "preview" (and the Vite mode "preview"); --env=production, the
//   default, removes an inherited one. An inherited NODE_ENV is removed too,
//   so Vite derives it from the command and the mode.
// - After a build it checks that dist/client really is the requested design
//   (§7.3 item 4 markers) and that the generated deploy config targets the
//   Worker wrangler.jsonc declares for --env (a CLOUDFLARE_ENV in a .env file
//   would otherwise redirect the build); a mismatch exits 1. It prints the
//   design and the Worker name, never an environment value.
// - --dev serves on Vite's default host (localhost only); --port pins the
//   port with --strictPort, so a busy port fails instead of moving.

import { spawnSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

import {
  ScriptFailure,
  UsageError,
  appRoot,
  isMainModule,
  printable,
  runCli,
} from './lib/wrangler-d1.mjs'

export const DESIGNS = Object.freeze(['classic', 'cinematic'])
/** --env values, mapped to the wrangler environment (null: the top level). */
export const TARGETS = Object.freeze({ production: null, preview: 'preview' })

export const USAGE = [
  'Usage: node scripts/build-design.mjs <classic|cinematic> [--env=production|preview]',
  '       node scripts/build-design.mjs <classic|cinematic> --dev [--env=production|preview] [--port=<1024-65535>]',
  'Builds (tsc -b, vite build, marker check) or serves (--dev) one design. It never deploys:',
  'deploys go through the release script (scripts/release.mjs).',
].join('\n')

/**
 * §7.3 item 4: none of these may appear in a classic build. The cinematic
 * build must contain every CINEMATIC_MARKERS entry (boot.ts spells the
 * attribute name out, and every cinematic selector requires it).
 */
export const DESIGN_MARKERS = Object.freeze([
  'cine-',
  'data-design',
  'startViewTransition',
  'view-transition',
])
export const CINEMATIC_MARKERS = Object.freeze(['data-design'])

/** Built files read as text by the marker check; fonts and images are skipped. */
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.svg', '.txt'])
/** A Worker name as wrangler accepts it; anything else is never printed. */
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PORT = /^[1-9][0-9]{3,4}$/
const MINIMUM_PORT = 1024
const MAXIMUM_PORT = 65_535
const REFUSED_OPTIONS = new Set(['--deploy', '--allow-dirty'])

export const DEFAULT_PATHS = Object.freeze({
  root: appRoot,
  distRoot: path.join(appRoot, 'dist'),
  distClient: path.join(appRoot, 'dist', 'client'),
  deployConfig: path.join(appRoot, '.wrangler', 'deploy', 'config.json'),
  wranglerConfig: path.join(appRoot, 'wrangler.jsonc'),
})

/** An argument as it may be echoed: terminal-safe and short. */
function shown(argument) {
  const text = printable(argument)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/**
 * The command line as { design, dev, env, port } or { help: true }. Throws
 * UsageError on anything outside the allowlist.
 */
export function parseBuildArguments(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    return { help: true }
  }

  let design = null
  let dev = false
  let env = null
  let port = null

  for (const argument of argv) {
    if (DESIGNS.includes(argument)) {
      if (design !== null) {
        throw new UsageError('Give exactly one design: classic or cinematic.')
      }

      design = argument
    } else if (argument === '--dev') {
      if (dev) {
        throw new UsageError('--dev was given more than once.')
      }

      dev = true
    } else if (argument.startsWith('--env=')) {
      const value = argument.slice('--env='.length)

      if (env !== null) {
        throw new UsageError('--env was given more than once.')
      }

      if (!Object.hasOwn(TARGETS, value)) {
        throw new UsageError('--env accepts only "production" or "preview" (as --env=<value>).')
      }

      env = value
    } else if (argument.startsWith('--port=')) {
      const value = argument.slice('--port='.length)

      if (port !== null) {
        throw new UsageError('--port was given more than once.')
      }

      if (!PORT.test(value) || Number(value) < MINIMUM_PORT || Number(value) > MAXIMUM_PORT) {
        throw new UsageError(`--port must be a number from ${MINIMUM_PORT} to ${MAXIMUM_PORT}.`)
      }

      port = Number(value)
    } else if (REFUSED_OPTIONS.has(argument)) {
      throw new UsageError(
        `${argument} is not an option: this script only builds and serves. Deploys go through scripts/release.mjs.`,
      )
    } else {
      throw new UsageError(`Unknown argument: ${shown(argument)}`)
    }
  }

  if (design === null) {
    throw new UsageError('Give the design to build: classic or cinematic.')
  }

  if (port !== null && !dev) {
    throw new UsageError('--port is for the dev server: use it with --dev.')
  }

  return { design, dev, env: env ?? 'production', port }
}

/**
 * The child processes' environment: a copy of `parent` with the design set
 * and CLOUDFLARE_ENV set or removed explicitly. `parent` is not changed.
 */
export function childEnvironment(parent, { design, env }) {
  const child = { ...parent, VITE_SITE_DESIGN: design }
  delete child.NODE_ENV

  const wranglerEnvironment = TARGETS[env]

  if (wranglerEnvironment === null) {
    delete child.CLOUDFLARE_ENV
  } else {
    child.CLOUDFLARE_ENV = wranglerEnvironment
  }

  return child
}

/** The Vite mode: `preview` for the preview Worker, Vite's own default otherwise. */
export function viteMode({ dev, env }) {
  if (env === 'preview') {
    return 'preview'
  }

  return dev ? 'development' : 'production'
}

/** The arguments after the vite bin entry. */
export function viteArguments(options) {
  const mode = ['--mode', viteMode(options)]

  if (!options.dev) {
    return ['build', ...mode]
  }

  return options.port === null ? mode : [...mode, '--port', String(options.port), '--strictPort']
}

/** The entry file of a tool in node_modules, run as `node <entry>`. */
export function packageBin(root, packageName, binName) {
  const packageDirectory = path.join(root, 'node_modules', packageName)
  let manifest

  try {
    manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new ScriptFailure(`node_modules/${packageName} is missing; run npm ci.`)
    }

    throw error
  }

  const relativeEntry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
  const entry = typeof relativeEntry === 'string' ? path.resolve(packageDirectory, relativeEntry) : null

  if (entry === null || !entry.startsWith(packageDirectory + path.sep)) {
    throw new ScriptFailure(`node_modules/${packageName} has no usable "${binName}" entry; run npm ci.`)
  }

  return entry
}

/** Runs `node <args>` in `root`; a failure throws ScriptFailure. */
function runNode(label, args, { root, env, interactive, timeoutMinutes }) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    shell: false,
    stdio: [interactive ? 'inherit' : 'ignore', 'inherit', 'inherit'],
    timeout: timeoutMinutes === null ? undefined : timeoutMinutes * 60_000,
    windowsHide: true,
  })

  if (result.error !== undefined) {
    const code = 'code' in result.error ? result.error.code : result.error.name
    throw new ScriptFailure(`build-design: ${label} did not complete (${code}).`)
  }

  // Stopping the dev server with Ctrl+C (or a kill) is its normal end.
  if (interactive && (result.signal === 'SIGINT' || result.signal === 'SIGTERM')) {
    return
  }

  if (result.status !== 0) {
    throw new ScriptFailure(`build-design: ${label} failed (exit ${result.status ?? result.signal}).`)
  }
}

/** The real runner: `tool` is [package, bin]; the entry is resolved in `root`. */
export function runTool(label, [packageName, binName], args, options) {
  runNode(label, [packageBin(options.root, packageName, binName), ...args], options)
}

/**
 * Every text file of a build below `directory` as { name, text }, `name`
 * relative to `directory` with forward slashes. A symbolic link is refused
 * (it could point the check at other bytes than the ones that ship).
 */
export function collectBuiltText(directory, prefix = '') {
  const files = []

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const fullPath = path.join(directory, entry.name)

    if (lstatSync(fullPath).isSymbolicLink()) {
      throw new ScriptFailure(`build-design: ${shown(name)} in the build output is a symbolic link; refused.`)
    }

    if (entry.isDirectory()) {
      files.push(...collectBuiltText(fullPath, name))
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push({ name, text: readFileSync(fullPath, 'utf8') })
    }
  }

  return files
}

/** The built client files the marker check reads: every asset and index.html. */
export function builtClientText(distClient) {
  return [
    { name: 'index.html', text: readFileSync(path.join(distClient, 'index.html'), 'utf8') },
    ...collectBuiltText(path.join(distClient, 'assets'), 'assets'),
  ]
}

/** The problems that show `files` are not a `design` build; empty when they are. */
export function checkDesignMarkers(design, files) {
  const problems = []

  if (!files.some((file) => file.name.startsWith('assets/') && file.name.endsWith('.js'))) {
    problems.push('no JavaScript asset was found under dist/client/assets')
  }

  if (design === 'classic') {
    for (const marker of DESIGN_MARKERS) {
      for (const file of files.filter((candidate) => candidate.text.includes(marker))) {
        problems.push(`the classic build contains "${marker}" in ${shown(file.name)}`)
      }
    }
  } else {
    for (const marker of CINEMATIC_MARKERS) {
      if (!files.some((file) => file.text.includes(marker))) {
        problems.push(`the cinematic build does not contain "${marker}"`)
      }
    }
  }

  return problems
}

/** The Worker name wrangler.jsonc declares for --env (the top level for production). */
export function declaredWorkerName(wranglerConfig, env) {
  const parsed = ts.parseConfigFileTextToJson(wranglerConfig, readFileSync(wranglerConfig, 'utf8'))
  const environment = TARGETS[env]
  const scope = environment === null ? parsed.config : parsed.config?.env?.[environment]
  const name = scope?.name

  if (parsed.error !== undefined || typeof name !== 'string' || !WORKER_NAME.test(name)) {
    throw new ScriptFailure(`build-design: wrangler.jsonc declares no usable Worker name for --env=${env}.`)
  }

  return name
}

/** Throws unless `file` was written at or after `startedAt` (ms). */
function requireFresh(file, label, startedAt) {
  // Whole seconds: some file systems store coarse modification times.
  if (statSync(file).mtimeMs < Math.floor(startedAt / 1000) * 1000) {
    throw new ScriptFailure(`build-design: ${label} was not written by this build; refused.`)
  }
}

/**
 * The Worker name in the deploy config the build generated
 * (.wrangler/deploy/config.json points at dist/<worker>/wrangler.json).
 * Only `name` is used; the pointer must stay inside dist/.
 */
export function builtWorkerName({ deployConfig, distRoot }, startedAt) {
  requireFresh(deployConfig, '.wrangler/deploy/config.json', startedAt)

  const pointer = JSON.parse(readFileSync(deployConfig, 'utf8'))
  const configPath =
    typeof pointer?.configPath === 'string'
      ? path.resolve(path.dirname(deployConfig), pointer.configPath)
      : null

  if (configPath === null || !configPath.startsWith(path.resolve(distRoot) + path.sep)) {
    throw new ScriptFailure('build-design: the generated deploy config does not point inside dist/; refused.')
  }

  requireFresh(configPath, 'the generated Worker config', startedAt)

  const { name } = JSON.parse(readFileSync(configPath, 'utf8'))

  if (typeof name !== 'string' || !WORKER_NAME.test(name)) {
    throw new ScriptFailure('build-design: the generated Worker config has no valid Worker name.')
  }

  return name
}

/**
 * Builds or serves one design. `deps` lets the tests replace the runner, the
 * output and the paths; the defaults are the real ones.
 */
export function main(
  argv,
  {
    run = runTool,
    log = (line) => console.log(line),
    paths = DEFAULT_PATHS,
    parentEnv = process.env,
    now = Date.now,
  } = {},
) {
  const options = parseBuildArguments(argv)

  if ('help' in options) {
    log(USAGE)
    return
  }

  const { design, dev, env } = options
  const runOptions = {
    root: paths.root,
    env: childEnvironment(parentEnv, options),
    interactive: dev,
    timeoutMinutes: dev ? null : 20,
  }

  if (dev) {
    log(`build-design: dev server, design=${design}, env=${env}`)
    run('vite (dev)', ['vite', 'vite'], viteArguments(options), runOptions)
    return
  }

  log(`build-design: building design=${design} for env=${env}`)
  const startedAt = now()
  run('tsc -b', ['typescript', 'tsc'], ['-b'], { ...runOptions, timeoutMinutes: 10 })
  run('vite build', ['vite', 'vite'], viteArguments(options), runOptions)

  requireFresh(path.join(paths.distClient, 'index.html'), 'dist/client/index.html', startedAt)
  const problems = checkDesignMarkers(design, builtClientText(paths.distClient))

  if (problems.length > 0) {
    throw new ScriptFailure(
      [`build-design: dist/client is not a ${design} build:`, ...problems.map((problem) => `  - ${problem}`)].join('\n'),
    )
  }

  const expected = declaredWorkerName(paths.wranglerConfig, env)
  const target = builtWorkerName(paths, startedAt)

  if (target !== expected) {
    throw new ScriptFailure(
      `build-design: the build targets the Worker ${target}, but --env=${env} is ${expected} ` +
        '(is CLOUDFLARE_ENV set in a .env file?). Refused.',
    )
  }

  log(`build-design: built design=${design} for the Worker ${target} (env=${env}); marker check passed.`)
}

if (isMainModule(import.meta.url)) {
  await runCli(() => main(process.argv.slice(2)), USAGE)
}
