import { fileURLToPath } from 'node:url'
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

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

export default defineConfig(({ mode }) => {
  const designDirectory = fileURLToPath(
    new URL(`./src/design/${readSiteDesign(mode)}/`, import.meta.url),
  )

  return {
    plugins: [react(), cloudflare()],
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
