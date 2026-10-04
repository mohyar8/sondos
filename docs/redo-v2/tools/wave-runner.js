export const meta = {
  name: 'sundus-wave-runner',
  description: 'Build one plan wave: builders on disjoint files, two reviewers per unit, skeptics, integration check, fix rounds',
  phases: [
    { title: 'Build', detail: 'one builder per unit, same-wave deps honoured' },
    { title: 'Review', detail: 'appsec + domain reviewer per unit' },
    { title: 'Verify', detail: 'skeptics on serious findings' },
    { title: 'Integrate', detail: 'full lint/tsc/build/tests/migrations/runtime' },
    { title: 'Fix', detail: 'owners fix confirmed findings; recheck' },
    { title: 'Gate', detail: 'write the wave review report' },
  ],
}

const P = 'C:/Users/azooz/Desktop/sundus-yar/app'
const R = 'C:/Users/azooz/Desktop/sundus-yar/runs/redo-v2'
const A = args
const WAVE = A.wave
const units = A.units
const idx = {}
units.forEach((u, i) => { idx[u.id] = i })
const ownerOf = {}
for (const u of units) for (const f of u.files) ownerOf[f] = u.id
const ownershipTable = units.map((u) => `${u.id}: ${u.files.join(', ')}`).join('\n')

const RULES = `
PROJECT: ${P} (git repo). Arabic RTL bridal-photography booking site for «المصورة سندس يار»: React 19 + TS SPA (src/), Cloudflare Worker API (worker/), shared/ code, D1 migrations (migrations/), Firebase Auth ID tokens verified in the Worker. The owner demands secure-coding discipline — "no AI slop that is weak and vulnerable"; your work is attacked by independent reviewers before it can merge.
PLAN: ${R}/11-golive-plan.md rev. 2 (single source of truth: §0 binding controls, §2 DDL, §3 API contracts, §4 gating matrix, §5.1 Definition of Done, §5.2 security baseline SB-1…SB-20, §5.6 unit entries, §6 tests, §7 runbook). Motion: ${R}/12-motion-spec.md rev. 2. Threat model: ${R}/13-threat-model.md. Baseline audit: ${R}/10-security-baseline.md. Decisions (D14–D19 are the owner's decisions of 2026-09-28 and override older text): ${R}/decisions.md.
BINDING CODE RULES: preserve prices and existing API contracts (additive only), one Firebase listener + one AuthProvider + the existing AuthDialog, no React Router, NO new dependencies, no \`any\`, no @ts-ignore, no eslint-disable, no unsafe \`as\`, no empty or broad catch (narrow by type, rethrow the rest), no unhandled promises, clean up listeners/observers/timers/AbortControllers, never read event.currentTarget in deferred updaters, no secrets in VITE_*, never log tokens or customer data, Arabic RTL + feminine singular + real Arabic strings (never lorem ipsum, never invented prices/facts/testimonials/legal promises), keyboard access + visible focus + never colour-only state + prefers-reduced-motion, tap targets ≥ 44×44 px, accent text only on paper/surface backgrounds, match the surrounding code style and comment density.
WAVE BRIEF FILE: ${A.argsPath} (JSON). Read it first: "landed" = what already landed before this wave (build on it, never revert it); "renames" = plan file name → actual repo file (use the actual file); "units" = every unit of this wave with its full acceptance (including the orchestrator's amendment lines) and security_controls.
GIT: never commit, stage, stash, checkout, reset, rebase, or change git config/hooks. Leave changes in the working tree.
WAVE ${WAVE} FILE OWNERSHIP (one owner per file; nobody edits a file owned by another unit or by no unit of this wave):
${ownershipTable}`

function persona(role) {
  return {
    backend: 'a senior backend/security engineer (Cloudflare Workers, D1/SQLite, jose, secure API design)',
    data: 'a senior data engineer / database architect (SQLite/D1 migrations, invariants, seed tooling)',
    fullstack: 'a senior full-stack engineer (React 19 + Cloudflare Workers) with a security mindset',
    frontend: 'a senior frontend engineer (React 19 + TS, Arabic RTL, accessibility, Firebase web SDK v12)',
    motion: 'a senior motion designer-engineer (native CSS/SVG/Web Animations, RTL typography, performance, accessibility)',
    docs: 'a senior technical writer / security reviewer who writes precise, verified documentation',
  }[role] || 'a senior software engineer'
}

const BUILD = {
  type: 'object',
  properties: {
    changed_files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    acceptance: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, status: { type: 'string', enum: ['met', 'partial', 'not_met', 'n/a'] }, evidence: { type: 'string' } }, required: ['criterion', 'status', 'evidence'] } },
    deviations: { type: 'string' },
    notes_for_reviewers: { type: 'string' },
  },
  required: ['changed_files', 'summary', 'acceptance', 'deviations', 'notes_for_reviewers'],
}

function builderPrompt(u, extra) {
  const port = A.portBase + idx[u.id]
  return `You are ${persona(u.role)}.
${RULES}

YOUR UNIT: ${u.id} — "${u.title}" (wave ${WAVE}, role ${u.role}).
Your unit entry (identical to 11-golive-plan.md §5.6) is in the wave brief. Do NOT read the whole 2,000-line plan: grep/read only the sections, TM/UX ids and contracts your acceptance lines reference${u.role === 'motion' || /MOT-/.test(u.title) ? ', plus your MOT entry in 12-motion-spec.md (§0 and §8)' : ''}.${A.resumeNote ? '\n' + A.resumeNote : ''}
ACCEPTANCE AND SECURITY CONTROLS: take them from the "${u.id}" object in the wave brief file ${A.argsPath} — every acceptance line (plan + amendment lines) must be met and every security control implemented.
FILES YOU OWN (only these may change; tests under tests/ that belong to your unit are also allowed): ${u.files.join(', ')}
CONCURRENCY: other builders are editing other files of this wave right now, so the tree may briefly fail to type-check in files you do not own — ignore those; YOUR files must be clean. Do NOT run \`npm run build\` or \`npm run verify\` (the integration reviewer runs them after all builders finish). Do run: \`npx eslint <your files>\` and \`npx tsc -b --pretty false\` (report only errors in your files).
RUNTIME CHECK (plan §6.3 for your unit): use ONLY port ${port}. API: \`npx wrangler d1 migrations apply DB --local --persist-to <your own scratch dir>\` then \`npx wrangler dev --port ${port} --persist-to <same dir>\` from ${P}. UI: \`npx vite --port ${port} --strictPort\` from ${P}. Stop every server you start. Put scratch files in your own temp dir and delete them.
If the plan entry conflicts with code that already landed, keep the landed security behaviour, meet the acceptance, and explain in deviations. If an acceptance item is impossible without the owner (e.g. Firebase console), implement everything up to that point and mark it partial with the reason.${extra || ''}
Return the JSON result.`
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          unit: { type: 'string', description: 'unit id that owns the file, or "none"' },
          file: { type: 'string' },
          line: { type: 'integer' },
          evidence: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'unit', 'file', 'evidence', 'problem', 'fix'],
      },
    },
    checks_run: { type: 'string' },
  },
  required: ['findings', 'checks_run'],
}

const REVIEW_RULES = RULES.replace('GIT: never commit', 'REVIEWERS ARE READ-ONLY: do not modify any file in the repo. GIT: never commit')

function reviewPrompt(u, lens, build) {
  const port = A.portBase + 40 + idx[u.id] * 2 + (lens === 'appsec' ? 0 : 1)
  const lensText = lens === 'appsec'
    ? 'LENS: application security. Attack this unit: authn/authz and ownership (SB-1, SB-2, SB-20), input handling and byte caps (SB-3), SQL (SB-4), state integrity/races/TOCTOU (SB-5), output encoding/XSS/CSV/.ics/WhatsApp link injection (SB-6), logging of PII/tokens (SB-7), secrets (SB-8), error leakage (SB-9), audit (SB-10), private-media gate (SB-11), client hygiene (SB-12), PDPL (SB-13), re-auth/session rules (SB-14, SB-18), limits (SB-15), text rules (SB-16, SB-17), and the TM ids listed for the unit. Try to break it.'
    : `LENS: domain correctness for a ${u.role} unit — does it meet EVERY acceptance item and the plan entry exactly; contracts match §3; migrations match §2; UI: Arabic copy (feminine singular, natural), RTL, a11y, 375 px, reduced motion, no console errors; motion: 12-motion-spec acceptance; code quality per the binding rules; hidden bugs and regressions to existing behaviour.`
  return `You are an independent ${lens === 'appsec' ? 'application-security reviewer' : 'senior domain reviewer'} on the wave ${WAVE} review gate.
${REVIEW_RULES}

UNIT UNDER REVIEW: ${u.id} — "${u.title}". Files: ${u.files.join(', ')}. Its acceptance and security controls are in the "${u.id}" object of ${A.argsPath}.
Builder's report: ${JSON.stringify(build)}
${lensText}
Inspect the unit's diff (\`git -C ${P} diff -- <files>\` and new untracked files). Other units of this wave may still be mid-edit — judge only this unit's files and the contracts it exposes/consumes. Runtime checks allowed on port ${port} only (same commands as builders, own scratch persist dir; stop servers).
Report only real problems with quoted evidence (file:line) and a concrete failure or attack scenario; set unit to the owning unit id from the ownership table (or "none"). No generic advice. An empty findings array is a valid answer.`
}

const VERDICT = { type: 'object', properties: { confirmed: { type: 'boolean' }, reason: { type: 'string' } }, required: ['confirmed', 'reason'] }

function skeptic(f, angle) {
  return agent(`${REVIEW_RULES}\n\nYou are an adversarial SKEPTIC on the wave ${WAVE} gate. Try to REFUTE this review finding against the CURRENT working tree. Angle: ${angle}. Set confirmed=false only if you can show concretely that it is not real, not reachable, or already handled; otherwise confirmed=true.\nFINDING: ${JSON.stringify(f)}`,
    { label: `verify:${f.unit}:${f.title.slice(0, 24)}`, phase: 'Verify', schema: VERDICT, agentType: 'general-purpose' }).catch(() => null)
}

async function verifyFinding(f) {
  if (f.severity === 'LOW') return { ...f, confirmed: true, votes: 0 }
  const angles = f.severity === 'MEDIUM'
    ? ['Is it real and reachable in the current code?']
    : ['Is it real and reachable in the current code?', 'Is it already mitigated elsewhere (another layer, a DB constraint, a guard)?']
  const votes = (await parallel(angles.map((a) => () => skeptic(f, a)))).filter(Boolean)
  const confirms = votes.filter((v) => v.confirmed).length
  const confirmed = votes.length === 0 ? true : confirms * 2 >= votes.length
  return { ...f, confirmed, votes: votes.length, skeptics: votes.map((v) => v.reason) }
}

// ---------- Build + per-unit review (pipelined per unit, same-wave deps honoured) ----------
const building = {}
function build(u) {
  if (building[u.id]) return building[u.id]
  building[u.id] = (async () => {
    const deps = u.depends_on.filter((d) => d in idx)
    await Promise.all(deps.map((d) => build(units[idx[d]])))
    const failed = (why) => ({ failed: true, changed_files: [], summary: `BUILDER FAILED: ${why}`, acceptance: [], deviations: '', notes_for_reviewers: '' })
    return agent(builderPrompt(u), { label: `build:${u.id}`, phase: 'Build', schema: BUILD, agentType: 'general-purpose' })
      .then((r) => r || failed('no result (agent stopped)'))
      .catch((e) => failed(String(e)))
  })()
  return building[u.id]
}

phase('Build')
const perUnit = await parallel(units.map((u) => async () => {
  const b = await build(u)
  if (b.failed) return { id: u.id, build: b, findings: [], failed: true }
  const reviews = await parallel(['appsec', 'domain'].map((lens) => () =>
    agent(reviewPrompt(u, lens, b), { label: `review:${lens}:${u.id}`, phase: 'Review', schema: FINDINGS, agentType: 'general-purpose' }).catch(() => null)))
  if (reviews.filter(Boolean).length === 0) return { id: u.id, build: b, findings: [], failed: true, reviewFailed: true }
  const found = reviews.filter(Boolean).flatMap((r) => r.findings.map((f) => ({ ...f, unit: f.unit && f.unit !== 'none' ? f.unit : (ownerOf[f.file] || u.id) })))
  const verified = await parallel(found.map((f) => () => verifyFinding(f)))
  return { id: u.id, build: b, findings: verified.filter(Boolean) }
}))

const failedUnits = perUnit.filter((x) => !x || x.failed).map((x, i) => (x ? x.id : units[i].id))
if (failedUnits.length) {
  log(`wave ${WAVE}: ${failedUnits.length} unit(s) did not finish (${failedUnits.join(', ')}); stopping before integration — resume this run to retry them`)
  return {
    wave: WAVE,
    aborted: true,
    failedUnits,
    done: perUnit.filter((x) => x && !x.failed).map((x) => ({ id: x.id, files: x.build.changed_files, findings: x.findings.length })),
  }
}

// ---------- Integration (needs the whole wave) ----------
phase('Integrate')
const integration = await agent(`You are the wave ${WAVE} INTEGRATION reviewer.
${REVIEW_RULES}
All builders of this wave have finished. From ${P} run, in order: \`npm ci\` only if node_modules is missing; \`npm run lint\`; \`npx tsc -b --pretty false\`; \`npm run build\`; \`npm test\` and \`npm run verify\` if those scripts exist; apply ALL migrations to a FRESH local D1 in a scratch persist dir and confirm they apply cleanly in order; start \`npx wrangler dev --port ${A.portBase + 90} --persist-to <that dir>\` and smoke-test /api/health, /api/availability and every endpoint this wave added (unauthenticated → 401/403, malformed → 400, oversize → 413); start \`npx vite --port ${A.portBase + 91} --strictPort\` and load /, /portfolio, /packages, /my-bookings, /admin in headless Chrome (Node 24 global WebSocket + CDP, or a quick check with curl if Chrome is unavailable) looking for console errors and horizontal overflow at 375 px. Stop all servers. Also grep the diff for forbidden patterns: \`any\`, @ts-ignore, eslint-disable, console.log of request data, dangerouslySetInnerHTML, innerHTML, new dependencies in package.json.
Report every failure as a finding attributed to the owning unit via the ownership table (unit "none" if no unit owns the file). An empty findings array means the wave integrates cleanly.`,
  { label: `integrate:wave${WAVE}`, phase: 'Integrate', schema: FINDINGS, agentType: 'general-purpose' }).catch(() => null)

const integ = integration ? await parallel(integration.findings.map((f) => () => verifyFinding({ ...f, unit: f.unit && f.unit !== 'none' ? f.unit : (ownerOf[f.file] || 'none') }))) : []
let open = perUnit.flatMap((x) => x.findings).concat(integ.filter(Boolean)).filter((f) => f.confirmed)
log(`wave ${WAVE}: ${open.length} confirmed findings (${open.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').length} high+) before fixes`)

// ---------- Fix rounds ----------
phase('Fix')
const FIX = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, how: { type: 'string' } }, required: ['title', 'how'] } },
    not_fixed: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'why'] } },
  },
  required: ['fixed', 'not_fixed'],
}
const fixLog = []
let round = 0
while (open.length && round < 2) {
  round++
  const groups = {}
  for (const f of open) { const k = f.unit in idx ? f.unit : 'none'; (groups[k] = groups[k] || []).push(f) }
  if (Object.keys(groups).every((k) => k === 'none')) break
  const fixes = await parallel(Object.keys(groups).filter((k) => k !== 'none').map((k) => () =>
    agent(builderPrompt(units[idx[k]], `\n\nFIX ROUND ${round}: your unit's work is in the working tree. The review gate CONFIRMED these problems — fix every one properly (never by suppressing checks or weakening a control), re-run your checks, and report what you fixed:\n${JSON.stringify(groups[k], null, 1)}`),
      { label: `fix:${k}:r${round}`, phase: 'Fix', schema: FIX, agentType: 'general-purpose' }).then((r) => (r ? { unit: k, ...r } : null)).catch(() => null)))
  fixLog.push(...fixes.filter(Boolean))
  const fixersMissing = fixes.filter((x) => !x).length
  if (fixersMissing) {
    log(`wave ${WAVE} fix round ${round}: ${fixersMissing} fixer(s) did not finish — stopping; resume this run to continue`)
    return { wave: WAVE, aborted: true, stage: `fix-r${round}`, fixersMissing, open: open.length }
  }
  const recheck = await agent(`You are the wave ${WAVE} RE-CHECK reviewer (round ${round}).
${REVIEW_RULES}
These confirmed findings were sent to their owners, who report fixes. Verify each against the CURRENT tree (quote the new code); run \`npm run lint\`, \`npx tsc -b --pretty false\` and \`npm run build\` (and \`npm test\` / \`npm run verify\` if present). Return every finding still open or newly introduced (keep the unit attribution); findings with unit "none" cannot be fixed by an owner — return them unchanged.
FINDINGS: ${JSON.stringify(open)}
OWNER REPORTS: ${JSON.stringify(fixes.filter(Boolean))}`,
    { label: `recheck:wave${WAVE}:r${round}`, phase: 'Fix', schema: FINDINGS, agentType: 'general-purpose' }).catch(() => null)
  if (!recheck) {
    log(`wave ${WAVE} recheck round ${round} did not finish — stopping; resume this run to continue`)
    return { wave: WAVE, aborted: true, stage: `recheck-r${round}`, open: open.length }
  }
  open = recheck.findings
  log(`wave ${WAVE} fix round ${round}: ${open.length} still open`)
}

// ---------- Gate report ----------
phase('Gate')
const gate = await agent(`You are the wave ${WAVE} gate secretary. Write ${A.reportPath} (create folders as needed; the ONLY file you may write) — a concise Markdown review report: per unit (id, title, builder summary in 2–3 lines, acceptance status table, deviations), every confirmed finding with severity/verdict/fix outcome, the integration check results, and a final line "GATE: PASS" if no CRITICAL/HIGH/MEDIUM remains open, otherwise "GATE: OPEN" with the list. Data:
UNITS: ${JSON.stringify(perUnit.map((x) => ({ id: x.id, build: x.build })))}
FINDINGS (pre-fix, all): ${JSON.stringify(perUnit.flatMap((x) => x.findings).concat(integ.filter(Boolean)))}
INTEGRATION CHECKS: ${integration ? integration.checks_run : 'integration reviewer failed'}
FIX LOG: ${JSON.stringify(fixLog)}
STILL OPEN: ${JSON.stringify(open)}
Return {"gate": "PASS"|"OPEN", "open_summary": "..."}.`,
  { label: `gate:wave${WAVE}`, phase: 'Gate', agentType: 'general-purpose', schema: { type: 'object', properties: { gate: { type: 'string', enum: ['PASS', 'OPEN'] }, open_summary: { type: 'string' } }, required: ['gate', 'open_summary'] } }).catch(() => null)

return {
  wave: WAVE,
  gate,
  units: perUnit.map((x) => ({ id: x.id, files: x.build.changed_files, summary: x.build.summary.slice(0, 600), notMet: x.build.acceptance.filter((a) => a.status !== 'met' && a.status !== 'n/a').map((a) => `${a.status}: ${a.criterion.slice(0, 160)} — ${a.evidence.slice(0, 200)}`), deviations: x.build.deviations.slice(0, 600) })),
  findingsTotal: perUnit.reduce((n, x) => n + x.findings.length, 0) + integ.length,
  stillOpen: open,
  integrationChecks: integration ? integration.checks_run.slice(0, 1500) : 'FAILED',
}
