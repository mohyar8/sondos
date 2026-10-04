// W2-19 / MOT-02 (12-motion-spec.md §7.4, H6/TM-05): scripts/build-design.mjs
// builds or serves one design and never deploys. Each case fails if its
// control is taken out: the strict argument allowlist (usage and exit 2 for
// anything else, --deploy and --allow-dirty included), CLOUDFLARE_ENV set or
// removed explicitly, shell-free spawns through node_modules entries, the
// marker check (a swapped design exits non-zero), the stale-output and
// Worker-target checks, and the package.json scripts that reach it. Builds
// are replaced by a stand-in runner that writes fixture output into a temp
// folder, so no test runs tsc or vite.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  DESIGN_MARKERS,
  checkDesignMarkers,
  childEnvironment,
  collectBuiltText,
  declaredWorkerName,
  main,
  packageBin,
  parseBuildArguments,
  viteArguments,
} from '../scripts/build-design.mjs'
import { ScriptFailure, UsageError } from '../scripts/lib/wrangler-d1.mjs'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const script = path.join(appRoot, 'scripts', 'build-design.mjs')
const wranglerConfig = path.join(appRoot, 'wrangler.jsonc')
const scratch = mkdtempSync(path.join(tmpdir(), 'sy-build-design-'))

after(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function usageError(argv) {
  assert.throws(() => parseBuildArguments(argv), (error) => {
    assert.ok(error instanceof UsageError, `${JSON.stringify(argv)} must be a usage error`)
    assert.equal(error.exitCode, 2)
    return true
  })
}

describe('argument allowlist', () => {
  test('the documented command lines parse', () => {
    assert.deepEqual(parseBuildArguments(['classic']), {
      design: 'classic',
      dev: false,
      env: 'production',
      port: null,
    })
    assert.deepEqual(parseBuildArguments(['cinematic', '--env=preview']), {
      design: 'cinematic',
      dev: false,
      env: 'preview',
      port: null,
    })
    assert.deepEqual(parseBuildArguments(['--env=production', 'classic']), {
      design: 'classic',
      dev: false,
      env: 'production',
      port: null,
    })
    assert.deepEqual(parseBuildArguments(['cinematic', '--dev', '--port=5418']), {
      design: 'cinematic',
      dev: true,
      env: 'production',
      port: 5418,
    })
    assert.deepEqual(parseBuildArguments(['--help']), { help: true })
  })

  test('anything outside the allowlist is a usage error', () => {
    for (const argv of [
      [],
      ['foo'],
      ['Classic'],
      ['classic '],
      [''],
      ['classic', 'cinematic'],
      ['classic', 'classic'],
      ['classic', '--deploy'],
      ['cinematic', '--allow-dirty'],
      ['--deploy'],
      ['classic', '--env', 'preview'],
      ['classic', '--env=staging'],
      ['classic', '--env=mediatest'],
      ['classic', '--env='],
      ['classic', '--env=preview', '--env=preview'],
      ['classic', '--dev', '--dev'],
      ['classic', '--port=5418'],
      ['classic', '--dev', '--port=80'],
      ['classic', '--dev', '--port=65536'],
      ['classic', '--dev', '--port=05418'],
      ['classic', '--dev', '--port=5418 '],
      ['classic', '--dev', '--port=5418', '--port=5419'],
      ['classic', '--dev', '--host'],
      ['classic', '--', '--mode=production'],
      ['classic', '-h'],
      ['classic', '--help'],
      ['classic', '--env=toString'],
      ['classic', '--env=__proto__'],
    ]) {
      usageError(argv)
    }
  })

  test('the CLI prints the usage and exits 2 before running anything', () => {
    for (const argv of [['foo'], ['classic', '--deploy'], ['cinematic', '--allow-dirty'], ['--env=preview']]) {
      const child = spawnSync(process.execPath, [script, ...argv], {
        cwd: scratch,
        encoding: 'utf8',
        shell: false,
        timeout: 60_000,
      })

      assert.equal(child.status, 2, `${argv.join(' ')}: ${child.stderr}`)
      assert.match(child.stderr, /Usage: node scripts\/build-design\.mjs/)
      assert.doesNotMatch(child.stdout, /building design=/)
    }
  })

  test('an unknown argument is echoed terminal-safe and short', () => {
    assert.throws(
      () => parseBuildArguments(['classic', `\u001b[31m${'x'.repeat(100)}`]),
      (error) => {
        assert.ok(error instanceof UsageError)
        assert.doesNotMatch(error.message, /\u001b/)
        assert.ok(error.message.length < 80)
        return true
      },
    )
  })
})

describe('child environment and commands', () => {
  test('preview sets CLOUDFLARE_ENV; production removes an inherited one', () => {
    const parent = Object.freeze({
      PATH: 'x',
      CLOUDFLARE_ENV: 'mediatest',
      VITE_SITE_DESIGN: 'cinematic',
      NODE_ENV: 'development',
    })

    const production = childEnvironment(parent, { design: 'classic', env: 'production' })
    assert.equal(Object.hasOwn(production, 'CLOUDFLARE_ENV'), false)
    assert.equal(Object.hasOwn(production, 'NODE_ENV'), false)
    assert.equal(production.VITE_SITE_DESIGN, 'classic')
    assert.equal(production.PATH, 'x')

    const preview = childEnvironment(parent, { design: 'cinematic', env: 'preview' })
    assert.equal(preview.CLOUDFLARE_ENV, 'preview')
    assert.equal(preview.VITE_SITE_DESIGN, 'cinematic')

    assert.equal(parent.CLOUDFLARE_ENV, 'mediatest')
  })

  test('vite runs with an explicit mode, and a pinned port never moves', () => {
    assert.deepEqual(viteArguments({ dev: false, env: 'production', port: null }), [
      'build',
      '--mode',
      'production',
    ])
    assert.deepEqual(viteArguments({ dev: false, env: 'preview', port: null }), [
      'build',
      '--mode',
      'preview',
    ])
    assert.deepEqual(viteArguments({ dev: true, env: 'production', port: null }), [
      '--mode',
      'development',
    ])
    assert.deepEqual(viteArguments({ dev: true, env: 'preview', port: 5418 }), [
      '--mode',
      'preview',
      '--port',
      '5418',
      '--strictPort',
    ])
  })

  test('tools resolve to entry files inside node_modules', () => {
    for (const [packageName, binName] of [
      ['vite', 'vite'],
      ['typescript', 'tsc'],
    ]) {
      const entry = packageBin(appRoot, packageName, binName)
      assert.ok(entry.startsWith(path.join(appRoot, 'node_modules', packageName) + path.sep))
    }

    assert.throws(() => packageBin(scratch, 'vite', 'vite'), ScriptFailure)
  })

  test('the script spawns only node, with shell: false', () => {
    const source = readFileSync(script, 'utf8')
    assert.match(source, /spawnSync\(process\.execPath, args, \{/)
    assert.match(source, /shell: false/)
    assert.doesNotMatch(source, /shell: true|\bexec(?:Sync)?\(|execFile/)
    // No wrangler tool and no "deploy" argument: the only "deploy" string is
    // the path of the generated deploy config the target check reads.
    const withoutDeployConfigPath = source.replaceAll("'.wrangler', 'deploy', 'config.json'", '')
    assert.doesNotMatch(withoutDeployConfigPath, /['"]deploy['"]|['"]wrangler['"]/)
  })
})

/** A fake build output under `root`, as vite and the Cloudflare plugin write it. */
function writeBuild(root, { assets, worker = 'sundus-yar-website', configPath }) {
  const distClient = path.join(root, 'dist', 'client')
  const workerDirectory = path.join(root, 'dist', worker.replaceAll('-', '_'))
  mkdirSync(path.join(distClient, 'assets'), { recursive: true })
  mkdirSync(workerDirectory, { recursive: true })
  mkdirSync(path.join(root, '.wrangler', 'deploy'), { recursive: true })

  writeFileSync(path.join(distClient, 'index.html'), '<!doctype html><div id="root"></div>')

  for (const [name, text] of Object.entries(assets)) {
    writeFileSync(path.join(distClient, 'assets', name), text)
  }

  writeFileSync(path.join(workerDirectory, 'wrangler.json'), JSON.stringify({ name: worker, vars: {} }))
  writeFileSync(
    path.join(root, '.wrangler', 'deploy', 'config.json'),
    JSON.stringify({
      configPath: configPath ?? path.join('..', '..', 'dist', worker.replaceAll('-', '_'), 'wrangler.json'),
    }),
  )
}

const CLASSIC_ASSETS = {
  'index-a1.js': 'document.getElementById("root");',
  'index-b2.css': '.reveal{opacity:1}',
}
const CINEMATIC_ASSETS = {
  'index-a1.js': 'document.documentElement.setAttribute("data-design","cinematic");',
  'index-b2.css': ':root[data-design=cinematic]{--cine-dur-tick:.18s}',
}

let fixtureCount = 0

/** Runs main() against a temp root with a stand-in runner; returns the calls and log. */
function runMain(argv, output, { parentEnv = { CLOUDFLARE_ENV: 'preview', PATH: 'x' } } = {}) {
  fixtureCount += 1
  const root = path.join(scratch, `root-${fixtureCount}`)
  mkdirSync(root, { recursive: true })

  const calls = []
  const lines = []
  const paths = {
    root,
    distRoot: path.join(root, 'dist'),
    distClient: path.join(root, 'dist', 'client'),
    deployConfig: path.join(root, '.wrangler', 'deploy', 'config.json'),
    wranglerConfig,
  }
  const run = (label, tool, args, options) => {
    calls.push({ label, tool, args, env: options.env })

    if (label === 'vite build' && output !== null) {
      writeBuild(root, output)
    }
  }

  let error = null

  try {
    main(argv, { run, log: (line) => lines.push(line), paths, parentEnv })
  } catch (caught) {
    if (!(caught instanceof ScriptFailure)) {
      throw caught
    }

    error = caught
  }

  return { calls, lines, error, root }
}

describe('build and marker check', () => {
  test('a classic build runs tsc -b then vite build without CLOUDFLARE_ENV and passes', () => {
    const { calls, lines, error } = runMain(['classic'], { assets: CLASSIC_ASSETS })

    assert.equal(error, null)
    assert.deepEqual(
      calls.map(({ tool, args }) => [tool, args]),
      [
        [['typescript', 'tsc'], ['-b']],
        [['vite', 'vite'], ['build', '--mode', 'production']],
      ],
    )

    for (const call of calls) {
      assert.equal(Object.hasOwn(call.env, 'CLOUDFLARE_ENV'), false)
      assert.equal(call.env.VITE_SITE_DESIGN, 'classic')
    }

    assert.match(lines.at(-1), /design=classic for the Worker sundus-yar-website \(env=production\)/)
  })

  test('a cinematic preview build targets sundus-yar-preview', () => {
    const { calls, lines, error } = runMain(['cinematic', '--env=preview'], {
      assets: CINEMATIC_ASSETS,
      worker: 'sundus-yar-preview',
    })

    assert.equal(error, null)
    assert.equal(calls[1].env.CLOUDFLARE_ENV, 'preview')
    assert.deepEqual(calls[1].args, ['build', '--mode', 'preview'])
    assert.match(lines.at(-1), /the Worker sundus-yar-preview/)
  })

  test('swapped markers fail the build (both directions)', () => {
    const asClassic = runMain(['classic'], { assets: CINEMATIC_ASSETS })
    assert.ok(asClassic.error instanceof ScriptFailure)
    assert.equal(asClassic.error.exitCode, 1)
    assert.match(asClassic.error.message, /not a classic build/)

    const asCinematic = runMain(['cinematic'], { assets: CLASSIC_ASSETS })
    assert.ok(asCinematic.error instanceof ScriptFailure)
    assert.match(asCinematic.error.message, /does not contain "data-design"/)
  })

  test('every §7.3 marker fails a classic build on its own', () => {
    for (const marker of DESIGN_MARKERS) {
      const problems = checkDesignMarkers('classic', [
        { name: 'assets/index-a1.js', text: `x("${marker}")` },
      ])
      assert.equal(problems.length, 1, marker)
    }

    assert.deepEqual(checkDesignMarkers('classic', [{ name: 'assets/a.js', text: 'ok' }]), [])
    assert.equal(checkDesignMarkers('cinematic', []).length, 2)
  })

  test('a build for the wrong Worker is refused', () => {
    const { error } = runMain(['classic', '--env=preview'], {
      assets: CLASSIC_ASSETS,
      worker: 'sundus-yar-website',
    })

    assert.ok(error instanceof ScriptFailure)
    assert.match(error.message, /targets the Worker sundus-yar-website, but --env=preview is sundus-yar-preview/)
  })

  test('a deploy config pointing outside dist/ is refused', () => {
    const { error } = runMain(['classic'], {
      assets: CLASSIC_ASSETS,
      configPath: path.join('..', '..', 'wrangler.json'),
    })

    assert.ok(error instanceof ScriptFailure)
    assert.match(error.message, /does not point inside dist/)
  })

  test('stale output from an earlier build is refused', () => {
    fixtureCount += 1
    const root = path.join(scratch, `stale-${fixtureCount}`)
    writeBuild(root, { assets: CLASSIC_ASSETS })
    const old = new Date('2026-01-01T00:00:00Z')
    utimesSync(path.join(root, 'dist', 'client', 'index.html'), old, old)

    assert.throws(
      () =>
        main(['classic'], {
          run: () => {},
          log: () => {},
          parentEnv: {},
          paths: {
            root,
            distRoot: path.join(root, 'dist'),
            distClient: path.join(root, 'dist', 'client'),
            deployConfig: path.join(root, '.wrangler', 'deploy', 'config.json'),
            wranglerConfig,
          },
        }),
      /was not written by this build/,
    )
  })

  test('a dev run starts vite once, without tsc, with the design set', () => {
    const { calls, error } = runMain(['cinematic', '--dev', '--port=5418'], null)

    assert.equal(error, null)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].tool, ['vite', 'vite'])
    assert.deepEqual(calls[0].args, ['--mode', 'development', '--port', '5418', '--strictPort'])
    assert.equal(calls[0].env.VITE_SITE_DESIGN, 'cinematic')
    assert.equal(Object.hasOwn(calls[0].env, 'CLOUDFLARE_ENV'), false)
  })

  test('only text files are read, nested folders included', () => {
    const directory = path.join(scratch, 'collect')
    mkdirSync(path.join(directory, 'nested'), { recursive: true })
    writeFileSync(path.join(directory, 'a.js'), 'a')
    writeFileSync(path.join(directory, 'nested', 'b.CSS'), 'b')
    writeFileSync(path.join(directory, 'font.woff2'), Buffer.from([0, 1, 2]))

    assert.deepEqual(
      collectBuiltText(directory, 'assets').map(({ name }) => name).sort(),
      ['assets/a.js', 'assets/nested/b.CSS'],
    )
  })

  test('wrangler.jsonc names the production and preview Workers', () => {
    assert.equal(declaredWorkerName(wranglerConfig, 'production'), 'sundus-yar-website')
    assert.equal(declaredWorkerName(wranglerConfig, 'preview'), 'sundus-yar-preview')
  })
})

describe('package.json scripts', () => {
  const { scripts } = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8'))

  test('the design scripts call build-design.mjs with allowlisted arguments', () => {
    assert.equal(scripts['build:classic'], 'node scripts/build-design.mjs classic')
    assert.equal(scripts['build:cinematic'], 'node scripts/build-design.mjs cinematic')
    assert.equal(scripts['dev:classic'], 'node scripts/build-design.mjs classic --dev')
    assert.equal(scripts['dev:cinematic'], 'node scripts/build-design.mjs cinematic --dev')

    for (const [name, command] of Object.entries(scripts)) {
      if (command.includes('build-design.mjs')) {
        const argv = command.split(' ').slice(2)
        assert.doesNotThrow(() => parseBuildArguments(argv), name)
      }
    }
  })

  test('npm run build and dev stay the unset default (classic)', () => {
    assert.equal(scripts.build, 'tsc -b && vite build')
    assert.equal(scripts.dev, 'vite')
  })

  test('no script deploys except through the release script', () => {
    for (const [name, command] of Object.entries(scripts)) {
      assert.doesNotMatch(command, /--allow-dirty/, name)

      if (/\bdeploy\b/.test(command) || name.startsWith('deploy')) {
        assert.match(command, /^node scripts\/release\.mjs(?: |$)/, name)
      }
    }
  })
})
