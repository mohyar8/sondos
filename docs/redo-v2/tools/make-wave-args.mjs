// Usage: node make-wave-args.mjs <wave> <landedFile>
// Writes runs/redo-v2/waves/w<wave>.json (full brief) and prints the slim Workflow args.
// Refuses if two units of the wave own the same file.
import { readFileSync, writeFileSync } from 'node:fs'

const R = 'C:/Users/azooz/Desktop/sundus-yar/runs/redo-v2'
const wave = Number(process.argv[2])
const landed = readFileSync(process.argv[3], 'utf8').trim()
const units = JSON.parse(readFileSync(`${R}/11-units.json`, 'utf8'))
const am = JSON.parse(readFileSync(`${R}/11-amendments.json`, 'utf8'))

const rename = (f) => am.renames[f] ?? f
const out = units.concat(am.new_units)
  .filter((u) => u.wave === wave && !u.id.endsWith('-RV'))
  .map((u) => ({
    ...u,
    files: [...new Set(u.files.map(rename).concat(am.add_files[u.id] ?? []))],
    acceptance: u.acceptance.concat(am.extra_acceptance[u.id] ?? []),
  }))

const owner = new Map()
for (const u of out) for (const f of u.files) {
  if (owner.has(f)) { console.error(`OWNERSHIP CONFLICT wave ${wave}: ${f} -> ${owner.get(f)} and ${u.id}`); process.exit(1) }
  owner.set(f, u.id)
}
const renames = Object.entries(am.renames).map(([a, b]) => `${a} -> ${b}`).join('; ')
  + '; scripts/promote-admin.mjs is the single admin script'
const portBase = 5200 + (wave % 10) * 100
const reportPath = `${R}/security/golive/w${wave}-review.md`
const argsPath = `${R}/waves/w${wave}.json`
writeFileSync(argsPath, JSON.stringify({ wave, units: out, landed, renames, portBase, reportPath }, null, 1))
process.stdout.write(JSON.stringify({
  wave, argsPath, portBase, reportPath,
  units: out.map((u) => ({ id: u.id, title: u.title, role: u.role, files: u.files, depends_on: u.depends_on })),
}))
console.error(`wave ${wave}: ${out.length} units, ${owner.size} files, no ownership conflicts`)
