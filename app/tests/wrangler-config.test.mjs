// W1-03 / C-4, C-8, TM-10, TM-24, SEC-13, SB-8, SB-11: the committed platform
// config. Each case fails if its setting is removed from or weakened in
// wrangler.jsonc, or if worker-configuration.d.ts drifts from it.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const configUrl = new URL('../wrangler.jsonc', import.meta.url)
const typesUrl = new URL('../worker-configuration.d.ts', import.meta.url)
const buildConfigUrl = new URL(
  '../dist/sundus_yar_website/wrangler.json',
  import.meta.url,
)

/** Removes // and block comments outside JSON strings. */
function stripJsonComments(source) {
  let output = ''
  let index = 0
  let inString = false

  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]

    if (inString) {
      output += character

      if (character === '\\') {
        output += next ?? ''
        index += 2
        continue
      }

      if (character === '"') {
        inString = false
      }

      index += 1
    } else if (character === '"') {
      inString = true
      output += character
      index += 1
    } else if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1
      }
    } else if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)

      assert.notEqual(end, -1, 'unterminated block comment in wrangler.jsonc')
      index = end + 2
    } else {
      output += character
      index += 1
    }
  }

  return output
}

const config = JSON.parse(stripJsonComments(readFileSync(configUrl, 'utf8')))
const environments = {
  production: config,
  preview: config.env?.preview,
  mediatest: config.env?.mediatest,
}

/** 11 §3.1: burst limits per 60 s. */
const expectedLimits = {
  RL_BOOKING: 3,
  RL_PROFILE: 3,
  RL_CUSTOMER_WRITE: 10,
  RL_UPLOAD: 2,
  RL_AVAILABILITY: 60,
  RL_CSP_REPORT: 30,
  RL_ADMIN_READ: 100,
}

/** Names that must never sit in committed vars (secrets or gate openers). */
const forbiddenVars = [
  'PDPL_SIGNOFF_REF',
  'MEDIA_SIGNING_KEY',
  'MEDIA_SIGNING_KEY_PREVIOUS',
  'RETENTION_PURGE',
  'RESEND_API_KEY',
  'ADMIN_REQUIRE_MFA',
]

describe('wrangler.jsonc', () => {
  test('production: account, no preview URLs, new D1, go-live vars (W1-03#1)', () => {
    assert.equal(config.account_id, '52c34fa9a7afb30c9db795d42b13df68')
    assert.equal(config.preview_urls, false)
    assert.deepEqual(
      config.d1_databases.map(({ binding, database_name }) => [binding, database_name]),
      [['DB', 'sundus-yar-production']],
    )
    assert.equal(config.vars.ONLINE_CONFIRMATION, 'on')
    assert.equal(config.vars.ADMIN_MEDIA_MFA, 'required')
    assert.equal(config.vars.ADMIN_SETTINGS_2F, 'off')
    assert.equal(config.vars.PREVIEW_READ_ONLY, undefined)
  })

  test('Firebase placeholders can never match a real project id', () => {
    // Real ids are 6-30 characters of a-z, 0-9 and '-'; Google never issues
    // a token for anything else, so every sign-in fails closed.
    for (const [name, environment] of Object.entries(environments)) {
      const projectId = environment.vars.FIREBASE_PROJECT_ID

      assert.equal(typeof projectId, 'string', name)
      assert.notEqual(projectId, 'sundus-yar-website', `${name}: old project`)

      if (projectId.startsWith('PLACEHOLDER_')) {
        assert.doesNotMatch(projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, name)
      }
    }

    assert.notEqual(
      config.vars.FIREBASE_PROJECT_ID,
      config.env.preview.vars.FIREBASE_PROJECT_ID,
      'preview must not use the production project (TM-24)',
    )
  })

  test('preview: read-only, dev project, OC off, no preview URLs (C-8, TM-24)', () => {
    const preview = environments.preview

    assert.equal(preview.preview_urls, false)
    assert.equal(preview.vars.PREVIEW_READ_ONLY, 'on')
    assert.equal(preview.vars.ONLINE_CONFIRMATION, 'off')
    assert.equal(preview.vars.ADMIN_MEDIA_MFA, 'required')
    assert.deepEqual(preview.triggers.crons, [])
  })

  test('only the local-only mediatest env has an R2 binding (TM-10)', () => {
    assert.equal(config.r2_buckets, undefined)
    assert.equal(environments.preview.r2_buckets, undefined)

    const mediatest = environments.mediatest

    assert.deepEqual(
      mediatest.r2_buckets.map(({ binding }) => binding),
      ['MEDIA'],
    )
    // A deploy would create the missing bucket (wrangler auto-provisioning),
    // so the placeholder account is what keeps every remote command away
    // from the real account.
    assert.equal(mediatest.account_id, '0'.repeat(32))
    assert.notEqual(mediatest.account_id, config.account_id)
    assert.equal(mediatest.workers_dev, false)
    assert.equal(mediatest.preview_urls, false)
    assert.match(mediatest.d1_databases[0].database_id, /^0{8}-0{4}-0{4}-0{4}-0{10}[0-9a-f]{2}$/)
    assert.equal(mediatest.vars.ONLINE_CONFIRMATION, 'on')
    assert.equal(mediatest.vars.ADMIN_MEDIA_MFA, 'required')
  })

  test('ratelimits RL_* at 60 s in every env, unique namespaces (W1-03#2, R-04)', () => {
    const namespaceIds = new Set()

    for (const [name, environment] of Object.entries(environments)) {
      const limits = Object.fromEntries(
        environment.ratelimits.map((binding) => {
          assert.equal(binding.simple.period, 60, `${name} ${binding.name}`)
          assert.match(binding.namespace_id, /^[1-9]\d*$/)
          assert.equal(
            namespaceIds.has(binding.namespace_id),
            false,
            `${name} ${binding.name} reuses namespace ${binding.namespace_id}`,
          )
          namespaceIds.add(binding.namespace_id)

          return [binding.name, binding.simple.limit]
        }),
      )

      assert.deepEqual(limits, expectedLimits, name)
    }
  })

  test('no secret, gate opener or Wave 0 name in any committed vars (SB-8)', () => {
    for (const [name, environment] of Object.entries(environments)) {
      for (const variable of forbiddenVars) {
        assert.equal(
          Object.hasOwn(environment.vars, variable),
          false,
          `${name} vars must not set ${variable}`,
        )
      }
    }
  })
})

describe('worker-configuration.d.ts', () => {
  const types = readFileSync(typesUrl, 'utf8')
  const baseEnv = /interface __BaseEnv_Env \{([^}]*)\}/.exec(types)

  test('is generated with --strict-vars=false (vars typed as string)', () => {
    assert.match(types, /^\/\/ Generated by Wrangler by running `wrangler types --strict-vars=false`/m)
  })

  test('types exactly the names wrangler.jsonc declares (no .dev.vars leak)', () => {
    assert.ok(baseEnv, '__BaseEnv_Env not found')

    const declared = baseEnv[1]
      .split('\n')
      .map((line) => /^\s*(\w+)\??:/.exec(line)?.[1])
      .filter((name) => name !== undefined)
      .sort()
    const expected = [
      'DB',
      'MEDIA',
      ...Object.keys(expectedLimits),
      ...new Set(
        Object.values(environments).flatMap((environment) =>
          Object.keys(environment.vars),
        ),
      ),
    ].sort()

    assert.deepEqual(declared, expected)
    assert.match(baseEnv[1], /\bMEDIA\?: R2Bucket;/)
  })
})

describe('build output', () => {
  test(
    'a production or preview build declares no R2 bucket and no media secret',
    { skip: !existsSync(buildConfigUrl) && 'no build output (run the build first)' },
    (context) => {
      const output = JSON.parse(readFileSync(buildConfigUrl, 'utf8'))
      const built = Object.entries(environments).find(
        ([, environment]) => (environment.name ?? config.name) === output.name,
      )
      const limiterNames = (environment) =>
        (environment.ratelimits ?? []).map(({ name }) => name).join(',')

      // A build made before the current wrangler.jsonc proves nothing about it.
      if (built === undefined || limiterNames(output) !== limiterNames(built[1])) {
        context.skip('build output is older than wrangler.jsonc (run the build first)')
        return
      }

      const [name] = built

      if (name === 'mediatest') {
        context.skip('a mediatest build is local only (never deployed)')
        return
      }

      assert.deepEqual(output.r2_buckets ?? [], [], name)
      assert.equal(output.preview_urls, false, name)

      for (const variable of forbiddenVars) {
        assert.equal(Object.hasOwn(output.vars ?? {}, variable), false, `${name} ${variable}`)
      }
    },
  )
})
