// W1-04 / C-16, TM-06, SB-2, SB-11, SB-20: the worker route slots, the
// registry checks and central booking ownership. Every case below fails if
// its control is taken out of worker/portal/portal-routes.ts,
// admin-portal-routes.ts or owned-booking.ts: the ownership query, the one
// 404 answer, the load-time assertions over the assembled registries, the
// admin namespaces, the explicit registration of a slot, the sign-in
// checks the dispatchers apply to private media (CO+M, AD+2F), or the one
// home each of ownership and sign-in freshness has.
//
// No network: the Firebase JWKS is served by a fetch stub from a key made
// here, and D1 is node:sqlite with the repository's migrations applied.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SignJWT, exportJWK, generateKeyPair } from 'jose'

import {
  adminPortalRoutes,
  dispatchAdminPortalRequest,
  isAdminPortalPath,
} from '../worker/portal/admin-portal-routes.ts'
import worker from '../worker/index.ts'
import {
  assembleRouteRegistry,
  customerPortalRoutes,
  dispatchCustomerPortalRequest,
  mediaRoutes,
} from '../worker/portal/portal-routes.ts'
import { resolveOwnedBooking } from '../worker/portal/owned-booking.ts'
import { adminAuditRoutes } from '../worker/portal/slots/admin-audit.ts'
import { adminBookingLogRoutes } from '../worker/portal/slots/admin-booking-log.ts'
import { adminDirectoryRoutes } from '../worker/portal/slots/admin-directory.ts'
import { adminEventProfileRoutes } from '../worker/portal/slots/admin-event-profile.ts'
import { adminExportRoutes } from '../worker/portal/slots/admin-export.ts'
import { adminFeedbackRoutes } from '../worker/portal/slots/admin-feedback.ts'
import { adminGalleryRoutes } from '../worker/portal/slots/admin-gallery.ts'
import { adminHandoverRoutes } from '../worker/portal/slots/admin-handover.ts'
import { adminProductionRoutes } from '../worker/portal/slots/admin-production.ts'
import { adminQueueRoutes } from '../worker/portal/slots/admin-queue.ts'
import { adminReceiptRoutes } from '../worker/portal/slots/admin-receipts.ts'
import { adminSearchRoutes } from '../worker/portal/slots/admin-search.ts'
import { adminSettingsRoutes } from '../worker/portal/slots/admin-settings.ts'
import { confirmationRoutes } from '../worker/portal/slots/confirmation.ts'
import { eventProfileRoutes } from '../worker/portal/slots/event-profile.ts'
import { feedbackRoutes } from '../worker/portal/slots/feedback.ts'
import { galleryRoutes } from '../worker/portal/slots/gallery.ts'
import { handoverRoutes } from '../worker/portal/slots/handover.ts'
import { signedMediaRoutes } from '../worker/portal/slots/media.ts'
import { receiptRoutes } from '../worker/portal/slots/receipts.ts'

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PROJECT_ID = 'sundus-yar-w1-04-test'
const KEY_ID = 'w1-04-test-key'
/** A sub-path no slot will ever register, so these cases hold in every wave. */
const UNREGISTERED = 'w1-04-unregistered'
/** A read of booking_requests (the reclaim DELETE's sub-select is not one). */
const BOOKING_READ = /^\s*SELECT\b[\s\S]*\bFROM\s+booking_requests\b/i
const JOSE_IMPORT = "from 'jose'"
const JOSE_URL = import.meta.resolve('jose')

// ---------------------------------------------------------------------------
// Local stand-ins: D1 over node:sqlite, the JWKS endpoint, ExecutionContext
// ---------------------------------------------------------------------------

class D1StatementStub {
  constructor(database, sql, params = []) {
    this.database = database
    this.sql = sql
    this.params = params
  }

  bind(...params) {
    return new D1StatementStub(this.database, this.sql, params)
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.params)

    if (row === undefined) {
      return null
    }

    return column === undefined ? { ...row } : row[column]
  }

  async all() {
    const results = this.database
      .prepare(this.sql)
      .all(...this.params)
      .map((row) => ({ ...row }))

    return { success: true, results, meta: { changes: 0 } }
  }

  async run() {
    const info = this.database.prepare(this.sql).run(...this.params)

    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
      },
    }
  }
}

class D1DatabaseStub {
  constructor(database) {
    this.database = database
    /** Every SQL text prepared, in order, so a test can count the reads. */
    this.preparedSql = []
  }

  prepare(sql) {
    this.preparedSql.push(sql)

    return new D1StatementStub(this.database, sql)
  }

  async batch(statements) {
    this.database.exec('BEGIN')

    try {
      const results = []

      for (const statement of statements) {
        const returnsRows =
          this.database.prepare(statement.sql).columns().length > 0

        results.push(returnsRows ? await statement.all() : await statement.run())
      }

      this.database.exec('COMMIT')

      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

function migratedDatabase() {
  const database = new DatabaseSync(':memory:')
  const migrationsDirectory = join(APP_ROOT, 'migrations')

  for (const name of readdirSync(migrationsDirectory).filter((file) => file.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join(migrationsDirectory, name), 'utf8'))
  }

  return database
}

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
}

const originalFetch = globalThis.fetch
let signingKey
let publicJwk

/**
 * A Firebase ID token signed by the test key. `secondFactor` adds the TOTP
 * claims an admin sign-in carries, so the admin cases hold whether or not
 * the admin guard asks for them.
 */
async function mintToken({
  uid,
  email,
  emailVerified = true,
  secondFactor = false,
  signedInSecondsAgo = 60,
}) {
  const now = Math.floor(Date.now() / 1000)
  const secondFactorClaims = secondFactor
    ? { sign_in_second_factor: 'totp', second_factor_identifier: 'w1-04-totp' }
    : {}

  return new SignJWT({
    email,
    email_verified: emailVerified,
    auth_time: now - signedInSecondsAgo,
    firebase: {
      sign_in_provider: 'password',
      identities: { email: [email] },
      ...secondFactorClaims,
    },
  })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
    .setIssuer(`https://securetoken.google.com/${PROJECT_ID}`)
    .setAudience(PROJECT_ID)
    .setSubject(uid)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 3600)
    .sign(signingKey)
}

/** Status, every header and the body text: what "byte-identical" compares. */
async function snapshot(response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()],
    body: await response.text(),
  }
}

async function errorCode(response) {
  const body = await response.json()

  return body.error?.code
}

// ---------------------------------------------------------------------------
// Fixture: two verified customers (A owns two bookings, B owns one), one admin
// ---------------------------------------------------------------------------

const customerA = { uid: 'w104CustomerA', email: 'bride-a@example.test' }
const customerB = { uid: 'w104CustomerB', email: 'bride-b@example.test' }
const admin = { uid: 'w104Admin', email: 'studio-admin@example.test' }
const bookingOfA = randomUUID()
const holdOfA = randomUUID()
const bookingOfB = randomUUID()
const holdExpiresAt = '2027-03-02T09:00:00.000Z'
let env
let tokenA
let tokenB
let adminToken

function insertUser(database, user, role = 'customer') {
  database
    .prepare(
      `INSERT INTO users (id, email, first_name, last_name, phone, role, email_verified_at)
       VALUES (?, ?, 'اختبار', 'اختبار', '0500000000', ?, '2026-09-01T10:00:00.000Z')`,
    )
    .run(user.uid, user.email, role)
}

function insertBooking(database, { id, uid, eventDate, status, flowVersion, hold, deposit }) {
  database
    .prepare(
      `INSERT INTO booking_requests
         (id, user_id, event_date, status, package_snapshot, estimated_total,
          hold_expires_at, flow_version, deposit_amount)
       VALUES (?, ?, ?, ?, '{}', 6500, ?, ?, ?)`,
    )
    .run(id, uid, eventDate, status, hold, flowVersion, deposit)
}

before(async () => {
  const keyPair = await generateKeyPair('RS256', { extractable: true })

  signingKey = keyPair.privateKey
  publicJwk = {
    ...(await exportJWK(keyPair.publicKey)),
    kid: KEY_ID,
    alg: 'RS256',
    use: 'sig',
  }

  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))

    if (url.hostname === 'www.googleapis.com' && url.pathname.includes('securetoken')) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    throw new Error('Tests have no network access.')
  }

  const database = migratedDatabase()

  insertUser(database, customerA)
  insertUser(database, customerB)
  insertUser(database, admin, 'admin')
  insertBooking(database, {
    id: bookingOfA,
    uid: customerA.uid,
    eventDate: '2027-05-20',
    status: 'pending_review',
    flowVersion: 1,
    hold: null,
    deposit: null,
  })
  insertBooking(database, {
    id: holdOfA,
    uid: customerA.uid,
    eventDate: '2027-06-12',
    status: 'approved_hold',
    flowVersion: 2,
    hold: holdExpiresAt,
    deposit: 1300,
  })
  insertBooking(database, {
    id: bookingOfB,
    uid: customerB.uid,
    eventDate: '2027-07-01',
    status: 'pending_review',
    flowVersion: 1,
    hold: null,
    deposit: null,
  })

  env = {
    DB: new D1DatabaseStub(database),
    FIREBASE_PROJECT_ID: PROJECT_ID,
  }
  tokenA = await mintToken(customerA)
  tokenB = await mintToken(customerB)
  adminToken = await mintToken({ ...admin, secondFactor: true })
})

after(() => {
  globalThis.fetch = originalFetch
})

/**
 * env with every private-media condition met (gates.ts), for the open state.
 * `overrides` replaces single vars, e.g. a missing or misspelt
 * ADMIN_MEDIA_MFA.
 */
function openMediaEnv(overrides = {}) {
  const bucket = {}

  for (const method of ['head', 'get', 'put', 'delete', 'list', 'createMultipartUpload', 'resumeMultipartUpload']) {
    bucket[method] = () => {
      throw new Error('The dispatcher must not touch the bucket.')
    }
  }

  return {
    ...env,
    ONLINE_CONFIRMATION: 'on',
    PDPL_SIGNOFF_REF: 'PDPL-W1-04-TEST',
    MEDIA: bucket,
    MEDIA_SIGNING_KEY: 'w1-04-test-signing-key-'.padEnd(48, 'k'),
    ADMIN_MEDIA_MFA: 'required',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Registries built from the slots
// ---------------------------------------------------------------------------

describe('registries are the explicit concatenation of every slot', () => {
  test('customer registry: confirmation, receipts, event-profile, handover, feedback, gallery', () => {
    assert.deepEqual(customerPortalRoutes, [
      ...confirmationRoutes,
      ...receiptRoutes,
      ...eventProfileRoutes,
      ...handoverRoutes,
      ...feedbackRoutes,
      ...galleryRoutes,
    ])
    assert.equal(Object.isFrozen(customerPortalRoutes), true)
  })

  test('media registry: the signed-media slot', () => {
    assert.deepEqual(mediaRoutes, [...signedMediaRoutes])
    assert.equal(Object.isFrozen(mediaRoutes), true)
  })

  test('admin registry: every admin slot', () => {
    assert.deepEqual(adminPortalRoutes, [
      ...adminBookingLogRoutes,
      ...adminEventProfileRoutes,
      ...adminProductionRoutes,
      ...adminHandoverRoutes,
      ...adminFeedbackRoutes,
      ...adminReceiptRoutes,
      ...adminGalleryRoutes,
      ...adminSettingsRoutes,
      ...adminQueueRoutes,
      ...adminDirectoryRoutes,
      ...adminExportRoutes,
      ...adminAuditRoutes,
      ...adminSearchRoutes,
    ])
    assert.equal(Object.isFrozen(adminPortalRoutes), true)
  })
})

describe('assembleRouteRegistry', () => {
  const handlers = { GET: async () => new Response(null, { status: 204 }) }
  const route = (path) => ({ path, gate: 'open', handlers })

  test('keeps slot order and refuses nothing valid', () => {
    const first = route(['handover-slots'])
    const second = route(['handover-slots', 'generate'])
    const third = route(['handover-slots', ':slotId'])
    const fourth = route(['queue'])

    assert.deepEqual(
      assembleRouteRegistry('/api/admin', {
        handover: [first, second, third],
        queue: [fourth],
      }),
      [first, second, third, fourth],
    )
  })

  test('two slots that could serve the same path are refused', () => {
    const cases = [
      [['handover'], [':section']],
      [['gallery', '*rest'], ['gallery', 'photos']],
      [['*rest'], ['queue', ':id']],
      [['settings', ':area'], ['settings', 'bank']],
    ]

    for (const [firstPath, secondPath] of cases) {
      assert.throws(
        () =>
          assembleRouteRegistry('/api/admin', {
            first: [route(firstPath)],
            second: [route(secondPath)],
          }),
        /^Error: PORTAL_ROUTE_OVERLAP /,
      )
    }
  })

  test('slots with disjoint paths may share a prefix', () => {
    assert.doesNotThrow(() =>
      assembleRouteRegistry('/api/bookings/{bookingId}', {
        handover: [route(['handover']), route(['handover', 'slots'])],
        feedback: [route(['feedback'])],
        gallery: [route(['gallery', '*rest'])],
        other: [route(['gallery'])],
      }),
    )
  })

  test('a route its own slot can never reach is refused', () => {
    for (const paths of [
      [['handover-slots', ':slotId'], ['handover-slots', 'generate']],
      [['settings'], ['settings']],
      [['gallery', '*rest'], ['gallery', 'photos', ':photoId']],
    ]) {
      assert.throws(
        () => assembleRouteRegistry('/api/admin', { slot: paths.map(route) }),
        /^Error: PORTAL_ROUTE_SHADOWED /,
      )
    }
  })

  test('malformed templates and routes without a method are refused', () => {
    for (const path of [
      [],
      ['*rest', 'tail'],
      [':'],
      ['*'],
      [':id', ':id'],
      ['a/b'],
      ['%72eceipt'],
      [''],
      [':1st'],
    ]) {
      assert.throws(
        () => assembleRouteRegistry('/api/admin', { slot: [route(path)] }),
        /^Error: PORTAL_ROUTE_INVALID /,
      )
    }

    assert.throws(
      () =>
        assembleRouteRegistry('/api/admin', {
          slot: [{ path: ['queue'], gate: 'open', handlers: {} }],
        }),
      /^Error: PORTAL_ROUTE_INVALID /,
    )
  })
})

// ---------------------------------------------------------------------------
// E1 over the assembled registries: a planted slot stops the module loading
// ---------------------------------------------------------------------------

describe('load-time checks run over the registries built from the slots', () => {
  const temporaryRoots = []

  after(() => {
    for (const root of temporaryRoots) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /**
   * Copies worker/ and shared/ to a temporary directory, pins the one bare
   * import ('jose') to this checkout's copy, replaces the given slot files
   * and imports the copied registry module.
   */
  async function importWithSlots(registryFile, slotSources) {
    const root = mkdtempSync(join(tmpdir(), 'w1-04-slots-'))

    temporaryRoots.push(root)
    cpSync(join(APP_ROOT, 'worker'), join(root, 'worker'), { recursive: true })
    cpSync(join(APP_ROOT, 'shared'), join(root, 'shared'), { recursive: true })

    for (const directory of ['worker', 'shared']) {
      for (const name of readdirSync(join(root, directory), { recursive: true })) {
        const file = join(root, directory, name)

        if (!file.endsWith('.ts')) {
          continue
        }

        const source = readFileSync(file, 'utf8')

        if (source.includes(JOSE_IMPORT)) {
          writeFileSync(file, source.replaceAll(JOSE_IMPORT, `from '${JOSE_URL}'`))
        }
      }
    }

    for (const [slotFile, source] of Object.entries(slotSources)) {
      writeFileSync(join(root, 'worker', 'portal', 'slots', slotFile), source)
    }

    return import(pathToFileURL(join(root, 'worker', 'portal', registryFile)).href)
  }

  test('the copied registries load while no slot is planted (control)', async () => {
    const customer = await importWithSlots('portal-routes.ts', {})
    const admin = await importWithSlots('admin-portal-routes.ts', {})

    assert.equal(customer.customerPortalRoutes.length, customerPortalRoutes.length)
    assert.equal(admin.adminPortalRoutes.length, adminPortalRoutes.length)
  })

  test('every slot file is registered, once, in the 11 §3.2 order', async () => {
    const customerSlots = [
      ['confirmation.ts', 'confirmationRoutes'],
      ['receipts.ts', 'receiptRoutes'],
      ['event-profile.ts', 'eventProfileRoutes'],
      ['handover.ts', 'handoverRoutes'],
      ['feedback.ts', 'feedbackRoutes'],
      ['gallery.ts', 'galleryRoutes'],
    ]
    const adminSlots = [
      ['admin-booking-log.ts', 'adminBookingLogRoutes'],
      ['admin-event-profile.ts', 'adminEventProfileRoutes'],
      ['admin-production.ts', 'adminProductionRoutes'],
      ['admin-handover.ts', 'adminHandoverRoutes'],
      ['admin-feedback.ts', 'adminFeedbackRoutes'],
      ['admin-receipts.ts', 'adminReceiptRoutes'],
      ['admin-gallery.ts', 'adminGalleryRoutes'],
      ['admin-settings.ts', 'adminSettingsRoutes'],
      ['admin-queue.ts', 'adminQueueRoutes'],
      ['admin-directory.ts', 'adminDirectoryRoutes'],
      ['admin-export.ts', 'adminExportRoutes'],
      ['admin-audit.ts', 'adminAuditRoutes'],
      ['admin-search.ts', 'adminSearchRoutes'],
    ]
    // One distinct probe per slot; 'private-media' so E1 never objects.
    const plant = (exportName, path) =>
      `export const ${exportName} = [
        { path: ${JSON.stringify(path)}, gate: 'private-media', handlers: { GET: async () => new Response(null) } },
      ]\n`
    const pathsOf = (routes) => routes.map((route) => route.path.join('/'))

    const customer = await importWithSlots('portal-routes.ts', {
      ...Object.fromEntries(
        customerSlots.map(([file, name]) => [file, plant(name, [`w104-${name}`])]),
      ),
      'media.ts': plant('signedMediaRoutes', ['w104-signedMediaRoutes']),
    })
    const admin = await importWithSlots(
      'admin-portal-routes.ts',
      Object.fromEntries(
        adminSlots.map(([file, name]) => [file, plant(name, ['queue', `w104-${name}`])]),
      ),
    )

    assert.deepEqual(
      pathsOf(customer.customerPortalRoutes),
      customerSlots.map(([, name]) => `w104-${name}`),
    )
    assert.deepEqual(pathsOf(customer.mediaRoutes), ['w104-signedMediaRoutes'])
    assert.deepEqual(
      pathsOf(admin.adminPortalRoutes),
      adminSlots.map(([, name]) => `queue/w104-${name}`),
    )
  })

  test('a customer receipt route declared open stops portal-routes.ts from loading (N-14)', async () => {
    await assert.rejects(
      importWithSlots('portal-routes.ts', {
        'receipts.ts': `export const receiptRoutes = [
          { path: ['receipt'], gate: 'open', handlers: { POST: async () => new Response(null) } },
        ]\n`,
      }),
      /PORTAL_ROUTE_GATE_MISMATCH \/api\/bookings\/\{bookingId\}\/receipt /,
    )
  })

  test('an admin upload route declared open stops admin-portal-routes.ts from loading', async () => {
    await assert.rejects(
      importWithSlots('admin-portal-routes.ts', {
        'admin-gallery.ts': `export const adminGalleryRoutes = [
          { path: ['bookings', ':bookingId', 'uploads'], gate: 'open', handlers: { POST: async () => new Response(null) } },
        ]\n`,
      }),
      /PORTAL_ROUTE_GATE_MISMATCH \/api\/admin\/bookings\/:bookingId\/uploads /,
    )
  })

  test('an admin slot route outside every admin namespace stops the module loading', async () => {
    await assert.rejects(
      importWithSlots('admin-portal-routes.ts', {
        'admin-queue.ts': `export const adminQueueRoutes = [
          { path: ['blocked-dates', 'export'], gate: 'open', handlers: { GET: async () => new Response(null) } },
        ]\n`,
      }),
      /PORTAL_ROUTE_OUTSIDE_NAMESPACE \/api\/admin\/blocked-dates\/export/,
    )
  })

  test('two admin slots claiming the same path stop the module loading', async () => {
    await assert.rejects(
      importWithSlots('admin-portal-routes.ts', {
        'admin-queue.ts': `export const adminQueueRoutes = [
          { path: ['queue', 'w1-04-twin'], gate: 'open', handlers: { GET: async () => new Response(null) } },
        ]\n`,
        'admin-search.ts': `export const adminSearchRoutes = [
          { path: ['queue', 'w1-04-twin'], gate: 'open', handlers: { POST: async () => new Response(null) } },
        ]\n`,
      }),
      /PORTAL_ROUTE_OVERLAP \/api\/admin\/queue\/w1-04-twin \(slot admin-search\) and \/api\/admin\/queue\/w1-04-twin \(slot admin-queue\)/,
    )
  })
})

// ---------------------------------------------------------------------------
// Registrations are explicit and static (no dynamic imports, no cycles)
// ---------------------------------------------------------------------------

describe('slot registrations are static and greppable', () => {
  const portalDirectory = join(APP_ROOT, 'worker', 'portal')
  const slotFiles = readdirSync(join(portalDirectory, 'slots'))
    .filter((file) => file.endsWith('.ts'))
    .sort()
  const registrySources = ['portal-routes.ts', 'admin-portal-routes.ts'].map((file) =>
    readFileSync(join(portalDirectory, file), 'utf8'),
  )
  const DYNAMIC_IMPORT = /\bimport\s*\(/

  test('each slot file is imported by exactly one registry module, by a static import', () => {
    assert.equal(slotFiles.length, 20)

    for (const file of slotFiles) {
      const specifier = `from './slots/${file.replace(/\.ts$/, '.js')}'`
      const importers = registrySources.filter((source) => source.includes(specifier))

      assert.equal(importers.length, 1, file)
    }
  })

  test('no registry or slot module loads code through a dynamic import', () => {
    for (const source of registrySources) {
      assert.doesNotMatch(source, DYNAMIC_IMPORT)
    }

    for (const file of slotFiles) {
      assert.doesNotMatch(
        readFileSync(join(portalDirectory, 'slots', file), 'utf8'),
        DYNAMIC_IMPORT,
        file,
      )
    }
  })

  test('slot files take only types from the registry modules (no runtime cycle)', () => {
    const registryImport = /^import\b[^;]*?from '\.\.\/(?:admin-)?portal-routes\.js'/gm

    for (const file of slotFiles) {
      const source = readFileSync(join(portalDirectory, 'slots', file), 'utf8')
      const imports = source.match(registryImport) ?? []

      assert.ok(imports.length > 0, file)

      for (const statement of imports) {
        assert.match(statement, /^import type \{/, `${file}: ${statement}`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Ownership and sign-in freshness have one home each (C-16, TM-06, TM-08)
// ---------------------------------------------------------------------------

describe('no Worker module uses the superseded request.ts helpers', () => {
  // request.ts still exports the Wave-0 loadOwnedBooking (with its own,
  // narrower OwnedBooking) and requireRecentAuthentication, whose window is
  // a deprecated worker/auth.ts constant rather than recent-auth.ts (it once
  // resolved to the 12-hour media window) and whose comment still names a
  // 401. Deleting them is outside W1-04's files. Until then no Worker module
  // may reach them: freshness comes only from recent-auth.ts
  // (requireRecentCustomerSignIn for CO+R, requireMediaFreshSignIn for CO+M)
  // and ownership stays the one owned-booking.ts query. The check still
  // holds once they are gone.
  const workerDirectory = join(APP_ROOT, 'worker')
  const requestModule = join(workerDirectory, 'portal', 'request.ts')
  const SUPERSEDED_HELPER = /\b(?:requireRecentAuthentication|loadOwnedBooking)\b/g
  const SUPERSEDED_TYPES = new Set(['OwnedBooking', 'OwnedBookingResult'])
  const MODULE_LINK =
    /^(import|export)\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\}|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s+'([^']+)'/gm
  // Comments may name the helpers (a deprecation note does); only code counts.
  // Block comments are taken from the start of a line only, so a string such
  // as 'image/*' never opens one; `//` after `:` (a URL) is not a comment.
  const BLOCK_COMMENT = /^\s*\/\*[\s\S]*?\*\//gm
  const LINE_COMMENT = /(^|\s)\/\/[^\n]*/g

  function withoutComments(source) {
    return source.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '$1')
  }

  /** The import/export clauses of `source` (the file at `path`) that name request.ts. */
  function requestModuleLinks(path, source) {
    return [...withoutComments(source).matchAll(MODULE_LINK)]
      .filter(
        ([, , , specifier]) =>
          specifier.startsWith('.') &&
          resolve(dirname(path), specifier.replace(/\.js$/, '.ts')) === requestModule,
      )
      .map(([, keyword, clause]) => ({ keyword, clause }))
  }

  /** Every way `source` reaches a superseded helper or type; [] when none. */
  function supersededUses(path, source) {
    const uses = [...withoutComments(source).matchAll(SUPERSEDED_HELPER)].map(([name]) => name)

    for (const { keyword, clause } of requestModuleLinks(path, source)) {
      if (keyword === 'export' && clause.startsWith('*')) {
        uses.push('export *')
        continue
      }

      for (const entry of clause.match(/\{([^}]*)\}/)?.[1].split(',') ?? []) {
        const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]

        if (SUPERSEDED_TYPES.has(name)) {
          uses.push(name)
        }
      }
    }

    return uses
  }

  test('the check sees every way in, and nothing else (control)', () => {
    const slot = join(workerDirectory, 'portal', 'slots', 'w1-04-probe.ts')

    for (const [path, source, expected] of [
      [slot, "import { requireRecentAuthentication } from '../request.js'\n", ['requireRecentAuthentication']],
      [slot, "import * as guards from '../request.js'\nguards.loadOwnedBooking(db, id, customer)\n", ['loadOwnedBooking']],
      [slot, "import type { OwnedBooking } from '../request.js'\n", ['OwnedBooking']],
      [
        join(workerDirectory, 'w1-04-probe.ts'),
        "import {\n  requireVerifiedCustomer,\n  type OwnedBookingResult as Result,\n} from './portal/request.js'\n",
        ['OwnedBookingResult'],
      ],
      [join(workerDirectory, 'portal', 'w1-04-probe.ts'), "export * from './request.js'\n", ['export *']],
      [
        slot,
        "const accept = 'image/*'\n/** Not requireRecentAuthentication: see recent-auth.ts. */\n" +
          "const url = 'https://example.test/x' // loadOwnedBooking is gone\nrequireRecentAuthentication(customer)\n",
        ['requireRecentAuthentication'],
      ],
      [
        slot,
        "import type { OwnedBooking } from '../owned-booking.js'\n" +
          "import { requireVerifiedCustomer, type VerifiedCustomer } from '../request.js'\n" +
          "import { requireRecentCustomerSignIn } from '../../recent-auth.js'\n" +
          '// loadOwnedBooking and requireRecentAuthentication were replaced.\n',
        [],
      ],
    ]) {
      assert.deepEqual(supersededUses(path, source), expected, source)
    }
  })

  test('no module under worker/ imports, re-exports or calls them', () => {
    const files = readdirSync(workerDirectory, { recursive: true })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => join(workerDirectory, file))
      .filter((path) => path !== requestModule)
    const linked = []

    for (const path of files) {
      const source = readFileSync(path, 'utf8')

      if (requestModuleLinks(path, source).length > 0) {
        linked.push(path)
      }

      assert.deepEqual(supersededUses(path, source), [], path)
    }

    // The scan resolves real imports: the dispatcher does take its customer
    // guard from request.ts.
    assert.ok(linked.includes(join(workerDirectory, 'portal', 'portal-routes.ts')))
  })
})

// ---------------------------------------------------------------------------
// Admin namespaces (11 §3.2)
// ---------------------------------------------------------------------------

describe('admin portal namespaces', () => {
  test('the W1-04 namespaces and everything below them go to the admin portal', () => {
    for (const path of [
      '/api/admin/settings',
      '/api/admin/settings/bank',
      '/api/admin/settings/delivery-areas/area-1',
      '/api/admin/calendar',
      '/api/admin/customers',
      '/api/admin/customers/uid-1',
      '/api/admin/exports/bookings.csv',
      '/api/admin/audit-log',
      '/api/admin/session',
      '/api/admin/session/revoke-all',
      '/api/admin/search/bookings',
      '/api/admin/search/customers',
      '/api/admin/queue',
      '/api/admin/handover-slots/generate',
      '/api/admin/bookings/b-1/timeline',
      '/api/admin/bookings/b-1/receipts',
    ]) {
      assert.equal(isAdminPortalPath(path), true, path)
    }
  })

  test('legacy admin paths and look-alikes stay with worker/admin.ts', () => {
    for (const path of [
      '/api/admin',
      '/api/admin/',
      '/api/admin/bookings',
      '/api/admin/bookings/b-1',
      '/api/admin/bookings/b-1/actions',
      '/api/admin/bookings/b-1/notes',
      '/api/admin/blocked-dates',
      '/api/admin/blocked-dates/2027-01-01',
      '/api/admin/settingsx',
      '/api/admin/sessions',
      '/api/admin/searching',
      '/api/admin/Settings',
    ]) {
      assert.equal(isAdminPortalPath(path), false, path)
    }
  })
})

// ---------------------------------------------------------------------------
// Customer dispatcher: central ownership (C-16, TM-06)
// ---------------------------------------------------------------------------

describe('customer dispatcher resolves ownership once', () => {
  const calls = []
  const probeRoutes = assembleRouteRegistry('/api/bookings/{bookingId}', {
    probe: [
      {
        path: ['probe', ':section'],
        gate: 'open',
        handlers: {
          GET: async (context) => {
            calls.push(context)

            return new Response(null, { status: 204 })
          },
          PUT: async (context) => {
            calls.push(context)

            return new Response(null, { status: 204 })
          },
        },
      },
      {
        path: ['receipt'],
        gate: 'private-media',
        handlers: {
          POST: async (context) => {
            calls.push(context)

            return new Response(null, { status: 204 })
          },
        },
      },
    ],
  })

  function dispatch(bookingId, subPath, { method = 'GET', token, environment = env } = {}) {
    const url = new URL(`https://example.test/api/bookings/${bookingId}/${subPath}`)
    const headers = token ? { Authorization: `Bearer ${token}` } : {}
    const request = new Request(url, { method, headers })

    return dispatchCustomerPortalRequest(request, environment, url, executionContext, probeRoutes)
  }

  test('the owner reaches the handler with the verified customer and an OwnedBooking', async () => {
    calls.length = 0

    const response = await dispatch(holdOfA, 'probe/terms', { token: tokenA })

    assert.equal(response.status, 204)
    assert.equal(calls.length, 1)

    const [context] = calls

    assert.equal(context.customer.uid, customerA.uid)
    assert.equal(context.bookingId, holdOfA)
    assert.deepEqual(context.booking, {
      id: holdOfA,
      status: 'approved_hold',
      flowVersion: 2,
      eventDate: '2027-06-12',
      holdExpiresAt,
    })
    assert.deepEqual({ ...context.params }, { section: 'terms' })
  })

  test('a legacy flow-1 booking arrives with flowVersion 1 and no hold', async () => {
    calls.length = 0

    const response = await dispatch(bookingOfA, 'probe/x', { method: 'PUT', token: tokenA })

    assert.equal(response.status, 204)
    assert.deepEqual(calls[0]?.booking, {
      id: bookingOfA,
      status: 'pending_review',
      flowVersion: 1,
      eventDate: '2027-05-20',
      holdExpiresAt: null,
    })
  })

  test('foreign, unknown and malformed ids get the same 404, byte for byte (N-04, N-36)', async () => {
    calls.length = 0

    const foreign = await snapshot(await dispatch(bookingOfA, 'probe/x', { token: tokenB }))
    const foreignWrite = await snapshot(
      await dispatch(holdOfA, 'probe/x', { method: 'PUT', token: tokenB }),
    )
    const unknown = await snapshot(await dispatch(randomUUID(), 'probe/x', { token: tokenB }))
    const malformed = await snapshot(await dispatch('%E0%A4%A', 'probe/x', { token: tokenB }))
    const overLong = await snapshot(await dispatch('b'.repeat(129), 'probe/x', { token: tokenB }))
    const controlCharacter = await snapshot(await dispatch('%0A', 'probe/x', { token: tokenB }))

    assert.equal(foreign.status, 404)
    assert.equal(JSON.parse(foreign.body).error.code, 'BOOKING_NOT_FOUND')

    for (const other of [foreignWrite, unknown, malformed, overLong, controlCharacter]) {
      assert.deepEqual(other, foreign)
    }

    assert.equal(calls.length, 0)
  })

  test('B reaches her own booking, never A’s', async () => {
    calls.length = 0

    assert.equal((await dispatch(bookingOfB, 'probe/x', { token: tokenB })).status, 204)
    assert.equal(calls[0]?.booking.id, bookingOfB)
    assert.equal(calls[0]?.customer.uid, customerB.uid)
  })

  test('no token → 401 and an unverified email → 403, both before any booking read', async () => {
    calls.length = 0

    const anonymous = await dispatch(holdOfA, 'probe/x')
    const unverified = await dispatch(holdOfA, 'probe/x', {
      token: await mintToken({ ...customerA, emailVerified: false }),
    })

    assert.equal(anonymous.status, 401)
    assert.equal(await errorCode(anonymous), 'UNAUTHORIZED')
    assert.equal(unverified.status, 403)
    assert.equal(await errorCode(unverified), 'EMAIL_NOT_VERIFIED')
    assert.equal(calls.length, 0)
  })

  test('unregistered path → 404 NOT_FOUND and unknown method → 405, before authentication', async () => {
    const unregistered = await dispatch(holdOfA, UNREGISTERED)
    const wrongMethod = await dispatch(holdOfA, 'probe/x', { method: 'DELETE' })

    assert.equal(unregistered.status, 404)
    assert.equal(await errorCode(unregistered), 'NOT_FOUND')
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('Allow'), 'GET, PUT')
  })

  test('a private-media route answers 503 before authentication and ownership, for any id', async () => {
    calls.length = 0

    const own = await snapshot(await dispatch(holdOfA, 'receipt', { method: 'POST', token: tokenA }))
    const foreign = await snapshot(await dispatch(holdOfA, 'receipt', { method: 'POST', token: tokenB }))
    const anonymous = await snapshot(await dispatch(randomUUID(), 'receipt', { method: 'POST' }))

    assert.equal(own.status, 503)
    assert.deepEqual(foreign, own)
    assert.deepEqual(anonymous, own)
    assert.equal(calls.length, 0)
  })

  test('with private media open, ownership still decides: owner 204, others the same 404', async () => {
    const open = openMediaEnv()

    calls.length = 0

    const own = await dispatch(holdOfA, 'receipt', { method: 'POST', token: tokenA, environment: open })

    assert.equal(own.status, 204)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].booking.id, holdOfA)

    const foreign = await snapshot(
      await dispatch(holdOfA, 'receipt', { method: 'POST', token: tokenB, environment: open }),
    )
    const unknown = await snapshot(
      await dispatch(randomUUID(), 'receipt', { method: 'POST', token: tokenB, environment: open }),
    )

    assert.equal(foreign.status, 404)
    assert.equal(JSON.parse(foreign.body).error.code, 'BOOKING_NOT_FOUND')
    assert.deepEqual(unknown, foreign)
    assert.equal(calls.length, 1)
  })

  test('with private media open, a stale sign-in is refused before any booking read', async () => {
    const open = openMediaEnv()
    // Older than the CO+M window (12 h).
    const staleA = await mintToken({ ...customerA, signedInSecondsAgo: 13 * 60 * 60 })

    calls.length = 0
    env.DB.preparedSql.length = 0

    const own = await snapshot(
      await dispatch(holdOfA, 'receipt', { method: 'POST', token: staleA, environment: open }),
    )
    const foreign = await snapshot(
      await dispatch(bookingOfB, 'receipt', { method: 'POST', token: staleA, environment: open }),
    )

    assert.equal(JSON.parse(own.body).error.code, 'REAUTH_REQUIRED')
    assert.deepEqual(foreign, own)
    assert.equal(calls.length, 0)
    assert.equal(
      env.DB.preparedSql.some((sql) => BOOKING_READ.test(sql)),
      false,
    )
  })

  test('with private media open, CO+M is the 12-hour window, not the 10-minute CO+R one', async () => {
    const open = openMediaEnv()
    const elevenHoursAgo = await mintToken({ ...customerA, signedInSecondsAgo: 11 * 60 * 60 })
    const justOverTwelve = await mintToken({ ...customerA, signedInSecondsAgo: 12 * 60 * 60 + 60 })

    calls.length = 0

    const withinWindow = await dispatch(holdOfA, 'receipt', {
      method: 'POST',
      token: elevenHoursAgo,
      environment: open,
    })

    assert.equal(withinWindow.status, 204)
    assert.equal(calls.length, 1)

    const pastWindow = await dispatch(holdOfA, 'receipt', {
      method: 'POST',
      token: justOverTwelve,
      environment: open,
    })

    assert.equal(pastWindow.status, 403)
    assert.equal(await errorCode(pastWindow), 'REAUTH_REQUIRED')
    assert.equal(calls.length, 1)
  })

  test('ownership is one booking read per request, bound to id and uid', async () => {
    for (const [bookingId, token, status] of [
      [holdOfA, tokenA, 204],
      [holdOfA, tokenB, 404],
      [randomUUID(), tokenA, 404],
    ]) {
      env.DB.preparedSql.length = 0

      assert.equal((await dispatch(bookingId, 'probe/x', { token })).status, status)

      const bookingReads = env.DB.preparedSql.filter((sql) => BOOKING_READ.test(sql))

      assert.equal(bookingReads.length, 1)
      assert.match(bookingReads[0], /WHERE\s+id\s*=\s*\?\s+AND\s+user_id\s*=\s*\?/)
    }
  })

  test('resolveOwnedBooking binds the verified customer: the same id is found for A only', async () => {
    const forA = await resolveOwnedBooking(env.DB, holdOfA, { uid: customerA.uid })
    const forB = await resolveOwnedBooking(env.DB, holdOfA, { uid: customerB.uid })

    assert.equal(forA.ok, true)
    assert.equal(forB.ok, false)
    assert.equal(forB.response.status, 404)
  })
})

// ---------------------------------------------------------------------------
// Admin dispatcher: the admin guard, then the route (11 §4.3 E0, E2)
// ---------------------------------------------------------------------------

describe('admin dispatcher runs the admin guard before any routing', () => {
  const calls = []
  const record = async (context) => {
    calls.push(context)

    return new Response(null, { status: 204 })
  }
  const probeRoutes = assembleRouteRegistry('/api/admin', {
    probe: [
      { path: ['queue', ':section'], gate: 'open', handlers: { GET: record } },
      {
        path: ['bookings', ':bookingId', 'receipts'],
        gate: 'private-media',
        handlers: { GET: record },
      },
    ],
  })

  function dispatch(path, { method = 'GET', token } = {}) {
    const url = new URL(`https://example.test/api/admin/${path}`)
    const headers = token ? { Authorization: `Bearer ${token}` } : {}

    return dispatchAdminPortalRequest(
      new Request(url, { method, headers }),
      env,
      url,
      executionContext,
      probeRoutes,
    )
  }

  test('the admin reaches the handler with her uid and the decoded captures', async () => {
    calls.length = 0

    const response = await dispatch('queue/w104%20today', { token: adminToken })

    assert.equal(response.status, 204)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].admin.uid, admin.uid)
    assert.deepEqual({ ...calls[0].params }, { section: 'w104 today' })
  })

  test('anonymous and customer callers get the guard answer on every path, route or not', async () => {
    calls.length = 0

    for (const [token, status, code] of [
      [undefined, 401, 'UNAUTHENTICATED'],
      [tokenA, 403, 'FORBIDDEN'],
    ]) {
      const onRoute = await snapshot(await dispatch('queue/x', { token }))

      assert.equal(onRoute.status, status)
      assert.equal(JSON.parse(onRoute.body).error.code, code)

      for (const [path, method] of [
        [UNREGISTERED, 'GET'],
        ['queue/x', 'DELETE'],
        [`bookings/${holdOfA}/receipts`, 'GET'],
      ]) {
        assert.deepEqual(await snapshot(await dispatch(path, { method, token })), onRoute, path)
      }
    }

    assert.equal(calls.length, 0)
  })

  test('after the guard: 404 unregistered, 503 closed private media, 405 method, 404 bad capture', async () => {
    calls.length = 0

    const unregistered = await dispatch(UNREGISTERED, { token: adminToken })
    const closed = await dispatch(`bookings/${holdOfA}/receipts`, { token: adminToken })
    const wrongMethod = await dispatch('queue/x', { method: 'POST', token: adminToken })
    const badCapture = await dispatch('queue/%E0%A4%A', { token: adminToken })

    assert.equal(unregistered.status, 404)
    assert.equal(await errorCode(unregistered), 'NOT_FOUND')
    assert.equal(closed.status, 503)
    assert.equal(await errorCode(closed), 'SERVICE_UNAVAILABLE')
    assert.equal(wrongMethod.status, 405)
    assert.equal(wrongMethod.headers.get('Allow'), 'GET')
    assert.equal(badCapture.status, 404)
    assert.equal(await errorCode(badCapture), 'NOT_FOUND')
    assert.equal(calls.length, 0)
  })
})

describe('admin dispatcher enforces the second factor on private media (AD+2F, TM-21)', () => {
  const calls = []
  const record = async (context) => {
    calls.push(context)

    return new Response(null, { status: 204 })
  }
  // The handlers check nothing themselves: only the dispatcher stands
  // between a password-only admin session and these routes.
  const probeRoutes = assembleRouteRegistry('/api/admin', {
    probe: [
      { path: ['queue', ':section'], gate: 'open', handlers: { GET: record } },
      {
        path: ['bookings', ':bookingId', 'receipts'],
        gate: 'private-media',
        handlers: { GET: record },
      },
    ],
  })
  let passwordOnlyAdminToken

  before(async () => {
    passwordOnlyAdminToken = await mintToken(admin)
  })

  function dispatch(path, { method = 'GET', token, environment }) {
    const url = new URL(`https://example.test/api/admin/${path}`)

    return dispatchAdminPortalRequest(
      new Request(url, { method, headers: { Authorization: `Bearer ${token}` } }),
      environment,
      url,
      executionContext,
      probeRoutes,
    )
  }

  test('a password-only admin gets 403 SECOND_FACTOR_REQUIRED and the handler never runs', async () => {
    // A missing or misspelt ADMIN_MEDIA_MFA keeps the second factor required.
    for (const setting of ['required', undefined, 'OFF', ' off']) {
      calls.length = 0

      const response = await dispatch(`bookings/${holdOfA}/receipts`, {
        token: passwordOnlyAdminToken,
        environment: openMediaEnv({ ADMIN_MEDIA_MFA: setting }),
      })

      assert.equal(response.status, 403, String(setting))
      assert.equal(await errorCode(response), 'SECOND_FACTOR_REQUIRED')
      assert.equal(calls.length, 0)
    }
  })

  test('the refusal comes before the method check and covers a path-derived private-media gate', async () => {
    calls.length = 0

    const environment = openMediaEnv()
    const wrongMethod = await dispatch(`bookings/${holdOfA}/receipts`, {
      method: 'DELETE',
      token: passwordOnlyAdminToken,
      environment,
    })
    // An 'open' route whose request path names a receipt runs under the
    // private-media gate (gates.ts effectiveRouteGate), so it needs TOTP too.
    const pathDerived = await dispatch('queue/receipts', {
      token: passwordOnlyAdminToken,
      environment,
    })

    assert.equal(wrongMethod.status, 403)
    assert.equal(await errorCode(wrongMethod), 'SECOND_FACTOR_REQUIRED')
    assert.equal(pathDerived.status, 403)
    assert.equal(await errorCode(pathDerived), 'SECOND_FACTOR_REQUIRED')
    assert.equal(calls.length, 0)
  })

  test('a TOTP admin reaches the private-media handler', async () => {
    calls.length = 0

    const response = await dispatch(`bookings/${holdOfA}/receipts`, {
      token: adminToken,
      environment: openMediaEnv(),
    })

    assert.equal(response.status, 204)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].admin.uid, admin.uid)
    assert.equal(calls[0].admin.secondFactor, 'totp')
  })

  test('routes outside private media stay open to a password-only admin (no global switch)', async () => {
    calls.length = 0

    const response = await dispatch('queue/today', {
      token: passwordOnlyAdminToken,
      environment: openMediaEnv(),
    })

    assert.equal(response.status, 204)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].admin.secondFactor, null)
  })

  test('with private media closed, a password-only admin gets the same 503 as a TOTP admin', async () => {
    calls.length = 0

    const passwordOnly = await snapshot(
      await dispatch(`bookings/${holdOfA}/receipts`, { token: passwordOnlyAdminToken, environment: env }),
    )
    const withTotp = await snapshot(
      await dispatch(`bookings/${holdOfA}/receipts`, { token: adminToken, environment: env }),
    )

    assert.equal(passwordOnly.status, 503)
    assert.deepEqual(passwordOnly, withTotp)
    assert.equal(calls.length, 0)
  })
})

// ---------------------------------------------------------------------------
// The real Worker: existing responses unchanged (11 §6.3 W1-04)
// ---------------------------------------------------------------------------

describe('the Worker answers unregistered paths exactly as before', () => {
  function fetchWorker(path, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {}

    return worker.fetch(new Request(`https://example.test${path}`, { headers }), env, executionContext)
  }

  test('customer portal: 404 NOT_FOUND for every booking id, owner or not', async () => {
    const own = await snapshot(await fetchWorker(`/api/bookings/${holdOfA}/${UNREGISTERED}`, tokenA))
    const foreign = await snapshot(await fetchWorker(`/api/bookings/${holdOfA}/${UNREGISTERED}`, tokenB))
    const unknown = await snapshot(await fetchWorker(`/api/bookings/${randomUUID()}/${UNREGISTERED}`))

    assert.equal(own.status, 404)
    assert.equal(JSON.parse(own.body).error.code, 'NOT_FOUND')
    assert.deepEqual(foreign, own)
    assert.deepEqual(unknown, own)
  })

  test('new admin namespaces answer like any unknown admin path', async () => {
    for (const token of [undefined, tokenA, adminToken]) {
      const legacy = await snapshot(await fetchWorker(`/api/admin/${UNREGISTERED}`, token))

      for (const namespace of ['settings', 'calendar', 'customers', 'exports', 'audit-log', 'session', 'search']) {
        const portal = await snapshot(await fetchWorker(`/api/admin/${namespace}/${UNREGISTERED}`, token))

        assert.deepEqual(portal, legacy, namespace)
      }
    }
  })
})
