import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

import {
  checkBuildConfig,
  enforceCspHeaders,
  formatFindings,
  parseCspMode,
  parseWranglerConfig,
  workerVars,
  type CspMode,
} from './scripts/config-guard.mjs'

/**
 * The design switch (runs/redo-v2/12-motion-spec.md §7). `VITE_SITE_DESIGN`
 * is a build-time flag read only here: it decides which twin under
 * src/design/<design>/ every `@site-design/<Name>` import resolves to, so a
 * classic bundle contains no cinematic code at all. Application code never
 * reads `import.meta.env.VITE_SITE_DESIGN`, so the value is not embedded in
 * the client bundle either.
 */
const SITE_DESIGNS = ['classic', 'cinematic'] as const

type SiteDesign = (typeof SITE_DESIGNS)[number]

/** Unset or empty builds classic (H6): only a pinned build ships the motion layer. */
const DEFAULT_SITE_DESIGN: SiteDesign = 'classic'

/** Only a value shaped like a design name is echoed back (to spot a typo). */
const ECHOABLE_VALUE = /^[A-Za-z-]{1,32}$/

function readSiteDesign(mode: string): SiteDesign {
  // .env, .env.local, .env.[mode] and .env.[mode].local, the process
  // environment winning — the same sources Vite itself reads.
  const raw =
    loadEnv(mode, process.cwd(), 'VITE_SITE_DESIGN').VITE_SITE_DESIGN ?? ''

  if (raw === '') {
    return DEFAULT_SITE_DESIGN
  }

  const design = SITE_DESIGNS.find((candidate) => candidate === raw)

  if (design === undefined) {
    // Fail closed: a typo must never silently ship the other design.
    const received = ECHOABLE_VALUE.test(raw) ? ` (got "${raw}")` : ''
    throw new Error(
      `VITE_SITE_DESIGN must be "classic" or "cinematic"${received}; leave it unset or empty for classic.`,
    )
  }

  return design
}

/**
 * `CSP_MODE` (plan 11 W2-18, TM-14): a build-time flag read only here, from
 * the same sources as the design switch. Unset or empty ships the launch
 * setting, Content-Security-Policy-Report-Only; "enforce" rewrites the
 * copied `_headers` of a build so the main policy is an enforced
 * Content-Security-Policy plus upgrade-insecure-requests, for the enforced
 * trial on the preview Worker (§7: a preview build with CSP_MODE=enforce).
 * The Trusted Types policy stays Report-Only in both modes. The flag has no
 * VITE_ prefix, so Vite never exposes it to the client, and no source file
 * reads it.
 */
function readCspMode(mode: string): CspMode {
  const raw = loadEnv(mode, process.cwd(), 'CSP_MODE').CSP_MODE ?? ''
  const cspMode = parseCspMode(raw)

  if (cspMode === null) {
    const received = ECHOABLE_VALUE.test(raw) ? ` (got "${raw}")` : ''
    throw new Error(
      `CSP_MODE must be "report-only" or "enforce"${received}; leave it unset for Report-Only.`,
    )
  }

  return cspMode
}

const PLUGIN_NAME = 'sy:config-guard'
const HEADERS_FILE = '_headers'

function isErrnoException(
  error: unknown,
): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}

/** The file's text, or null when it does not exist; any other failure is thrown. */
async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

/**
 * The Worker vars a `vite` dev server runs with, as wrangler resolves them
 * locally: `.dev.vars.<env>` when CLOUDFLARE_ENV is set and that file
 * exists, else `.dev.vars`, on top of the wrangler.jsonc vars (plan 11 §6.1:
 * FIREBASE_PROJECT_ID of the dev project lives in .dev.vars, never in
 * wrangler.jsonc). Only a dev server reads them; a build deploys the
 * committed vars.
 */
async function readDevVars(
  root: string,
  environmentName: string,
): Promise<Record<string, unknown>> {
  const candidates =
    environmentName === ''
      ? ['.dev.vars']
      : [`.dev.vars.${environmentName}`, '.dev.vars']

  for (const candidate of candidates) {
    const text = await readOptionalFile(path.join(root, candidate))

    if (text !== null) {
      const parsed: unknown = parseEnv(text)

      return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {}
    }
  }

  return {}
}

/**
 * The Firebase config guard (H1, N-53) and the CSP_MODE writer, one plugin.
 *
 * configResolved (every `vite` and `vite build`): the checks of
 * scripts/config-guard.mjs against wrangler.jsonc, public/_headers,
 * index.html and the env files of this mode. A build whose
 * VITE_FIREBASE_PROJECT_ID differs from the FIREBASE_PROJECT_ID var of the
 * CLOUDFLARE_ENV being built, whose auth domain is not
 * <projectId>.firebaseapp.com or is missing from frame-src, or whose
 * index.html inline script has no matching hash in _headers, fails here
 * with the variable names only (no env value is ever printed).
 *
 * writeBundle (client environment, CSP_MODE=enforce): rewrites the
 * `_headers` Vite copied from public/ so the main policy is enforced. The
 * source file is never touched, so the repository stays Report-Only.
 */
function configGuard(cspMode: CspMode): Plugin {
  return {
    name: PLUGIN_NAME,

    async configResolved(config) {
      const { root, envDir, mode } = config
      // Where the Cloudflare plugin reads it too: env files of this mode,
      // then the process environment.
      const environmentName =
        loadEnv(mode, envDir, 'CLOUDFLARE_ENV').CLOUDFLARE_ENV ?? ''
      const clientEnv = loadEnv(mode, envDir, 'VITE_FIREBASE_')

      const [wranglerText, headersText, indexHtml] = await Promise.all([
        readFile(path.join(root, 'wrangler.jsonc'), 'utf8'),
        readFile(path.join(config.publicDir, HEADERS_FILE), 'utf8'),
        readFile(path.join(root, 'index.html'), 'utf8'),
      ])

      let vars = workerVars(parseWranglerConfig(wranglerText), environmentName)

      if (config.command === 'serve' && vars !== null) {
        vars = { ...vars, ...(await readDevVars(root, environmentName)) }
      }

      const { problems, warnings } = checkBuildConfig({
        environmentName,
        mode,
        workerVars: vars,
        clientEnv,
        headersText,
        indexHtml,
        // The source file is always Report-Only; only a build's copy changes.
        cspMode: 'report-only',
      })

      // The Cloudflare plugin loads this config once per environment pass,
      // so a line below appears once per pass of one command.
      for (const warning of warnings) {
        config.logger.warn(`[${PLUGIN_NAME}] ${warning.message}`)
      }

      if (problems.length > 0) {
        throw new Error(
          `[${PLUGIN_NAME}] the Firebase or header configuration of this build is refused (N-53):\n${formatFindings(problems)}`,
        )
      }

      if (cspMode === 'enforce') {
        config.logger.info(
          `[${PLUGIN_NAME}] CSP_MODE=enforce: the built ${HEADERS_FILE} will enforce the main policy (preview trial only)`,
        )
      }
    },

    async writeBundle() {
      if (cspMode !== 'enforce' || this.environment.name !== 'client') {
        return
      }

      const { root, build } = this.environment.config
      const file = path.resolve(root, build.outDir, HEADERS_FILE)

      await writeFile(file, enforceCspHeaders(await readFile(file, 'utf8')))
    },
  }
}

export default defineConfig(({ mode }) => {
  const designDirectory = fileURLToPath(
    new URL(`./src/design/${readSiteDesign(mode)}/`, import.meta.url),
  )

  return {
    plugins: [react(), cloudflare(), configGuard(readCspMode(mode))],
    resolve: {
      alias: [
        {
          // Plain names only, so an import can never leave the design folder.
          // A `$` in the folder path is doubled so the replacement pattern
          // reads it literally.
          find: /^@site-design\/([A-Za-z-]+)$/,
          replacement: `${designDirectory.replaceAll('$', () => '$$')}$1`,
        },
      ],
    },
    build: {
      // TM-14: never inline an asset as a data: URI (the CSP allows only
      // img-src 'self', and the release preflight refuses data:image).
      // Known parity delta: design-classic-v1 inlined the two El Messiri
      // latin-ext-600 fonts (woff2, woff) in index.css; they are now emitted
      // files with the same bytes, so the MOT-06 CSS parity check must build
      // its ref with this limit too (or compare each url() by the sha256 of
      // its bytes). Never raise the limit to match the tag.
      assetsInlineLimit: 0,
    },
  }
})
