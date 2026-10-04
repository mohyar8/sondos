# Sundus Yar booking site — handoff (2026-10-01, updated)

Arabic RTL website and booking system for «المصورة سندس يار» (bridal photographer, Madinah).
React 19 + TypeScript + Vite SPA, Cloudflare Worker API + D1 (SQLite), Firebase Auth.

## What is in this zip

| Path | What it is |
|---|---|
| `app/` | The code, as a **git repository with a clean history** (the old history contained the original full-resolution photos with camera metadata, so it was not carried over). |
| `app` branch `main` | The **reviewed** state: redesign + security hardening + go-live foundations. Lint, type-check, both design builds and **793/793 tests** pass (`npm run verify`). |
| `app` branch `wip/wave2-unreviewed` | Unfinished work of plan wave 2 (settings API, booking state machine, jobs, admin queue, calendar, export, handover, feedback, first motion pieces). **Not reviewed — do not deploy or merge before review.** |
| `docs/redo-v2/` | Every plan, decision and security report (see "Read first"). |

## Read first

1. `docs/redo-v2/decisions.md` — every owner decision (D1–D20). D14–D20 are the latest.
2. `docs/redo-v2/11-golive-plan.md` — the go-live plan (API contracts §3, gating §4, units §5, tests §6, **deploy runbook §7**).
3. `docs/redo-v2/10-security-baseline.md` — security audit of the original code and the fix plan.
4. `docs/redo-v2/13-threat-model.md` and `docs/redo-v2/security/golive/w1-review.md` (latest review gate).
5. `app/README.md` — run, build, admin promotion, incident runbook.

## Run it locally (PowerShell)

```powershell
cd app
npm ci
npx wrangler d1 migrations apply DB --local
node scripts/seed-local.mjs          # optional fake data (local only)
npm run dev                          # http://localhost:5173
npm run verify                       # lint + tsc + both design builds + tests
```

Sign-in needs Firebase web config in `app/.env.local` (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
`VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` — public identifiers, not secrets) and the same project id in
`wrangler.jsonc` → `FIREBASE_PROJECT_ID`. Without it the site works, but sign-in shows «unavailable».

## Status

**Done (branch `main`)**
- Premium RTL redesign with the **cinematic motion design**: drawn logo intro (gold ring + khatam star, inked logo,
  diagonal lift), word-by-word headline reveals (`src/components/DisplayHeading.tsx`), drawn gold ornaments, hero
  entrance, scroll reveals and parallax, services ticker, portfolio filter morph and diagonal page transitions
  (View Transitions), gold scroll-progress line, button shine — all off under reduced motion
  (`src/design/cinematic/`). `npm run build:classic` returns the previous design.
- Owner's prices (2 h 1,450 · 4 h 3,000 · 6 h 4,500 · 8 h 6,100) and optional add-ons (mobile behind-the-scenes
  via AirDrop 200, second camera 500), priced by the server.
- FAQ: other occasions, next-day photo delivery by Drive, album timeline, album layout. 53 portfolio photos.
- Booking requests, «حجوزاتي» journey hub, admin dashboard (list, filters, detail, actions, blocked dates) with
  **one-tap WhatsApp messages for every step** (request received → deposit → confirmed → photos → album → feedback).
  The deposit receipt is sent by WhatsApp; bank details and Drive links are never stored on the site.
- Security: audit fixes (Wave 0) and go-live foundations (Wave 1) — admin bound to uid + verified email, session
  revocation, 12 h admin sessions, rate limits, byte caps, quantity ceilings, append-only audit tables. 799 tests,
  `npm run verify` passes.
- Production D1 `sundus-yar-production` created and migrated. Preview: https://sundus-yar-preview.sundusyar.workers.dev

**Waiting on the owner** — see `app/LAUNCH.md`: Google 2-Step Verification → Firebase project → config → deploy →
promote admin.

**Optional later** (plan waves 2–6, Train B): in-site admin settings (deposit/bank shown on the site), handover
time slots, galleries with photo selection, receipt upload. Wave 2 is partly built on `wip/wave2-unreviewed`.

## How to continue the plan

The plan was executed wave by wave with `docs/redo-v2/tools/wave-runner.js` (a Claude Code workflow script:
builder per unit, two reviewers per unit, skeptics, integration check, fix rounds) and
`docs/redo-v2/tools/make-wave-args.mjs` (builds each wave's brief from `11-units.json` + `11-amendments.json`).
It is thorough but expensive; a human team can follow the same unit list (`11-units.json`) manually.
Rules every change must follow are in plan §5.1–§5.2 and `decisions.md` "Binding constraints".

For wave 2: check out `wip/wave2-unreviewed`, review each unit against `docs/redo-v2/waves/w2.json`
(W2-01 and W2-03 were reviewed; their open findings are in the workflow output), run `npm run verify`, then merge.

## Live preview

https://sundus-yar-preview.sundusyar.workers.dev — browse-only (writes return 403), noindex, its own empty D1.
Cloudflare account "Lofe1122@gmail.com's Account", workers.dev subdomain `sundusyar`.

## Owner to-do before launch

1. Turn on Google 2-Step Verification, then create the Firebase project (Email/Password sign-in, authorized domains).
2. Create the production D1 (`wrangler d1 create sundus-yar-production`), put its id in `wrangler.jsonc`, apply migrations.
3. Sign up on the site once, then promote that account by uid with `node scripts/promote-admin.mjs`
   (read the header of the script for its flags; `app/README.md` still names the older `grant-admin.mjs`,
   which `promote-admin.mjs` replaced — update the README in wave 5).
4. In admin settings: deposit rule, bank details, terms, pickup address, delivery areas, business identity.
5. Lawyer review: PDPL / cross-border storage, privacy notice, booking terms (all drafts).
6. Optional: Resend (email), Workers Paid plan, custom domain, Cloudflare 2FA.
