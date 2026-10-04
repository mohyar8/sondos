// Builds the site with one of the two designs (12-motion-spec.md §7).
//   npm run build:cinematic   → the motion design (launch default)
//   npm run build:classic     → the previous design, unchanged
// It only sets VITE_SITE_DESIGN for `npm run build`; CLOUDFLARE_ENV (for the
// preview environment) passes through untouched. Deploy afterwards with
// `npx wrangler deploy`.
import { spawnSync } from 'node:child_process'

const design = process.argv[2]

if (design !== 'classic' && design !== 'cinematic') {
  console.error('usage: node scripts/build-design.mjs <classic|cinematic>')
  process.exit(2)
}

const result = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, VITE_SITE_DESIGN: design },
})

process.exit(result.status ?? 1)
