// W1-16 / MOT-01, H6, TM-14: the build-time design switch in vite.config.ts.
// Each case fails if its control is removed or weakened: unset or empty must
// build classic, only the two allowlisted values pass (anything else fails the
// build), the alias only takes plain names, assetsInlineLimit stays 0, classic
// twins import no CSS, and no client code can embed the flag.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const configHref = new URL('../vite.config.ts', import.meta.url).href
const srcRoot = join(appRoot, 'src')
const TWIN_EXTENSIONS = ['.ts', '.tsx']

// The config is evaluated in a child process whose working directory is an
// empty folder, so no developer .env file can change the outcome, and each
// value is set in that child's own environment.
const emptyDirectory = mkdtempSync(join(tmpdir(), 'sy-design-switch-'))

after(() => {
  rmSync(emptyDirectory, { recursive: true, force: true })
})

const CHILD_SCRIPT = `
import { readFileSync } from 'node:fs'
const { configHref, values } = JSON.parse(readFileSync(0, 'utf8'))
const { default: createConfig } = await import(configHref)
const results = []
for (const value of values) {
  if (value === null) delete process.env.VITE_SITE_DESIGN
  else process.env.VITE_SITE_DESIGN = value
  try {
    const config = createConfig({ command: 'build', mode: 'production', isSsrBuild: false, isPreview: false })
    const [alias] = config.resolve.alias
    results.push({
      value,
      ok: true,
      aliasCount: config.resolve.alias.length,
      find: { source: alias.find.source, flags: alias.find.flags },
      replacement: alias.replacement,
      assetsInlineLimit: config.build.assetsInlineLimit,
    })
  } catch (error) {
    if (!(error instanceof Error)) throw error
    results.push({ value, ok: false, message: error.message })
  }
}
process.stdout.write(JSON.stringify(results))
`

function evaluateConfig(values) {
  const env = { ...process.env }
  delete env.VITE_SITE_DESIGN

  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--no-warnings', '-e', CHILD_SCRIPT],
    {
      cwd: emptyDirectory,
      env,
      input: JSON.stringify({ configHref, values }),
      encoding: 'utf8',
      shell: false,
      timeout: 60_000,
    },
  )

  assert.equal(child.status, 0, `config evaluation failed:\n${child.stderr}`)
  return JSON.parse(child.stdout)
}

function designDirectory(design) {
  return join(srcRoot, 'design', design)
}

/** What `@site-design/<name>` rewrites to under the evaluated alias. */
function rewrite(result, specifier) {
  const find = new RegExp(result.find.source, result.find.flags)
  return specifier.replace(find, result.replacement)
}

function assertBuildsDesign(result, design) {
  assert.equal(result.ok, true, `${JSON.stringify(result.value)} must build`)
  assert.equal(result.aliasCount, 1)
  assert.equal(
    rewrite(result, '@site-design/boot'),
    join(designDirectory(design), 'boot'),
  )
  // TM-14: no asset may be inlined as a data: URI.
  assert.equal(result.assetsInlineLimit, 0)
}

function listFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? listFiles(path) : [path]
  })
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function findTwin(design, name) {
  return TWIN_EXTENSIONS.map((extension) =>
    join(designDirectory(design), `${name}${extension}`),
  ).find((path) => existsSync(path))
}

describe('VITE_SITE_DESIGN selects the design at build time', () => {
  const invalid = [
    'clasic',
    'Classic',
    'CINEMATIC',
    ' classic',
    'classic ',
    'cinematic\n',
    'classic,cinematic',
    '../cinematic',
    'cinematic/../classic',
    '0',
    'true',
  ]
  const unechoed = ['$(id)', 'cinematic;rm', 'x'.repeat(33), 'ab\u001b[31mc']
  const results = evaluateConfig([
    null,
    '',
    'classic',
    'cinematic',
    ...invalid,
    ...unechoed,
  ])
  const byValue = new Map(results.map((result) => [result.value, result]))

  test('unset builds classic (H6)', () => {
    assertBuildsDesign(byValue.get(null), 'classic')
  })

  test('empty builds classic (H6)', () => {
    assertBuildsDesign(byValue.get(''), 'classic')
  })

  test('classic and cinematic are the only accepted values', () => {
    assertBuildsDesign(byValue.get('classic'), 'classic')
    assertBuildsDesign(byValue.get('cinematic'), 'cinematic')
  })

  test('any other value fails the build with the message (fail closed)', () => {
    for (const value of [...invalid, ...unechoed]) {
      const result = byValue.get(value)
      assert.equal(result.ok, false, `${JSON.stringify(value)} must fail`)
      assert.match(
        result.message,
        /^VITE_SITE_DESIGN must be "classic" or "cinematic"/,
      )
    }
    assert.match(byValue.get('clasic').message, /\(got "clasic"\)/)
  })

  test('only a name-shaped value is echoed back', () => {
    for (const value of unechoed) {
      const { message } = byValue.get(value)
      assert.doesNotMatch(message, /\(got /)
      assert.equal(message.includes(value), false)
    }
  })

  test('the alias only takes plain names inside the design folder', () => {
    const result = byValue.get('classic')
    const find = new RegExp(result.find.source, result.find.flags)

    for (const name of ['boot', 'DisplayHeading', 'page-transition']) {
      assert.equal(find.test(`@site-design/${name}`), true, name)
    }
    for (const specifier of [
      '@site-design/../cinematic/boot',
      '@site-design/..',
      '@site-design/boot.ts',
      '@site-design/boot/index',
      '@site-design/tokens.css',
      '@site-design/boot?raw',
      '@site-design/',
      '@site-design',
      'x@site-design/boot',
      '@site-design/boot\n',
    ]) {
      assert.equal(find.test(specifier), false, JSON.stringify(specifier))
    }
  })
})

describe('design twins', () => {
  const sourceFiles = listFiles(srcRoot).filter((path) =>
    /\.(ts|tsx)$/.test(path),
  )

  test('every @site-design import has a classic and a cinematic twin', () => {
    const names = new Set()

    for (const path of sourceFiles) {
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/['"]@site-design\/([^'"]*)['"]/g)) {
        assert.match(match[1], /^[A-Za-z-]+$/, path)
        names.add(match[1])
      }
    }

    assert.equal(names.has('boot'), true, 'src/main.tsx imports the boot twin')
    for (const name of names) {
      assert.notEqual(findTwin('classic', name), undefined, `classic/${name}`)
      assert.notEqual(findTwin('cinematic', name), undefined, `cinematic/${name}`)
    }
  })

  test('classic twins import no CSS and the classic boot is empty', () => {
    for (const path of listFiles(designDirectory('classic'))) {
      assert.equal(/\.(ts|tsx)$/.test(path), true, `${path} is not a twin`)
      const code = stripComments(readFileSync(path, 'utf8'))
      assert.doesNotMatch(code, /\.css['"]/, path)
    }

    const boot = stripComments(
      readFileSync(join(designDirectory('classic'), 'boot.ts'), 'utf8'),
    )
    assert.equal(boot.trim(), 'export {}')
  })

  test('the cinematic boot marks <html> with data-design="cinematic"', () => {
    const boot = stripComments(
      readFileSync(join(designDirectory('cinematic'), 'boot.ts'), 'utf8'),
    )
    assert.match(
      boot,
      /document\.documentElement\.setAttribute\('data-design', 'cinematic'\)/,
    )
  })
})

describe('the flag never reaches client code', () => {
  test('no source file reads VITE_SITE_DESIGN or the whole import.meta.env', () => {
    for (const path of listFiles(srcRoot)) {
      const source = readFileSync(path, 'utf8')
      assert.equal(source.includes('VITE_SITE_DESIGN'), false, path)
      // A whole-object reference would inline every VITE_* value, the flag
      // included; property reads inline only the named value.
      assert.doesNotMatch(source, /import\.meta\.env(?!\.[A-Za-z_$])/, path)
    }
  })
})
