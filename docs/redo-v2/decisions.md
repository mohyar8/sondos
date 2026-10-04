# Run redo-v2 — Brief, constraints and decisions (every agent reads this first)

Project dir: `C:/Users/azooz/Desktop/sundus-yar` · Code: `app/` (git, baseline `d6b7cb2`) · Run artifacts: `runs/redo-v2/`
Inspection facts: `runs/redo-v2/00-inspection-report.md` — trust it over any assumption.

## Goal (owner's words, 2026-09-23)
"Redo the project and make it as perfect as it can be", using the Harrat Ventures prompt as the ambition
reference (expert full-stack + UI/UX + copywriter; expand the content; premium, authoritative, light
aesthetic with disciplined 60/30/10 color proportions; subtle premium entry animations; modular components;
fully responsive), plus new features:
1. After the booking is approved/confirmed on the website, the customer uploads the payment receipt.
2. A confirmation system with clear timing (deadlines, reminders) to maximise customer engagement on the site.
3. The last step is contacting the studio's WhatsApp.
4. The admin uploads the event photos to the website (bulk, "automatically"); the customer chooses her photos there.
5. After selection, the album is picked up or delivered at a scheduled time.
Instagram: @sndsyar (brand evidence in the inspection report).

## Proposed customer journey (to be specified, not yet approved)
1. Request: configure package + pick date → `pending_review` (exists). Admin replies within a stated SLA.
2. Approval → `approved_hold` (exists) with a visible countdown to a hold deadline.
3. On the website the customer accepts the booking terms, transfers the deposit, uploads the receipt → receipt
   under review (reuse `payment_pending` unless the architect proves a better model).
4. Admin verifies the receipt → `confirmed` (or rejects the receipt with a reason and a short extension).
   Holds that pass the deadline expire automatically (cron) and free the date.
5. Pre-event engagement: countdown, pre-event questionnaire (venue, timings, requests, publishing consent —
   default NO), reminders, add-to-calendar.
6. After the event: admin bulk-uploads web-size previews to a PRIVATE gallery; the customer selects exactly the
   number of photos her package includes (30/45/60/80) with favourites, lightbox, counter; submits → locked;
   admin exports the selected file names.
7. Album production status (design → printing → ready), visible to the customer.
8. Handover: pickup or delivery, customer books a time slot; reminder; final step = WhatsApp with a pre-filled
   message containing the booking reference and slot. Afterwards: thank-you, feedback request, and automatic
   deletion of gallery previews after a retention period.

## Owner-supplied site photos (received 2026-09-23 — «صور الموقع»)
Staging (NOT yet in app/public): `assets-incoming/site-photos-7239/` — 32 files, already web-optimised
(31 AVIF + 1 WebP, 77–617 KB, 6.7 MB total), pre-cropped by the owner into three ratios:
- `16-9/` 1920×1080 ×4 — `2M4A0708 ابيض copy.avif` (groom's hand reaching for the bride's hennaed hand,
  red-and-gold sleeve), `2M4A0881 copy 2.avif` (two hands holding phones showing wedding photos),
  `2M4A2256 copy 2.avif` (hand-in-hand detail, watch), `2M4A6038 copy.avif` (dark, gold-toned detail).
- `3.2/` 1800×1200 ×14 — hands, rings, henna, red/gold dress details, rings on satin (`2M4A4068`), the bride in
  her gown with bouquet among men in bishts (`2M4A1670`), ring handover (`2M4A8490`).
- `4.5/` 1600×2000 ×14 — gown displayed under a floral arch (`2M4A1262`), couple seen from behind in a banquet
  hall (`2M4A0379 ستوري`), bride holding her shoes (`IMG_2989`), bouquet against a black-and-gold bisht
  (`IMG_2845 (1) copy.webp`), couple's hands with rings and bouquet (`2M4A8403`), a family group with BLURRED
  faces (`2M4A1589`).
Aesthetic: detail-driven and privacy-first (no identifiable bride faces), palette of ivory, champagne gold,
blush pink, deep red and black bisht. Filenames contain spaces/Arabic/"copy" → clean ASCII slugs when moved
into `public/` (Run 2/3). The old 5000–8000 px portfolio JPEGs stay as originals, backed up, not served.

## Baseline (2026-09-23, after `npm ci`)
`npm run lint`: 0 errors, 2 warnings (react-hooks/exhaustive-deps at AuthDialog.tsx:285 and
BlockedDatesManager.tsx:323). `npm run build`: PASS. Client JS is ONE chunk: 470.79 kB (130.93 kB gzip) —
admin, booking and Firebase all load on the home page. CSS 79.88 kB. Worker 123.72 kB. The wrong favicon path
makes Vite emit a 510.93 kB copy of the logo. Build leaves an untracked `.wrangler/` (not in .gitignore).

## Binding constraints (from the owner's handoff document)
- Preserve: all prices, API contracts (unless a migration is approved), booking-flow behaviour, auth (one
  Firebase listener, one AuthProvider, existing AuthDialog), admin authorisation, Resend design, RTL, lazy images.
- No new dependency without the owner's approval. React Router is forbidden. No `any`, `@ts-ignore`,
  `eslint-disable`, unsafe `as`, empty/broad catch, unhandled promises, uncleaned listeners, secrets in `VITE_*`,
  logging of tokens or customer data.
- Arabic RTL, feminine singular address to the bride, real Arabic strings (never lorem ipsum), keyboard access,
  visible focus, never color-only state, `prefers-reduced-motion` respected.
- Staged delivery: ≤4 changed files per task unless justified with a safe split; lint + build + runtime check
  per stage; a build passing is not proof of runtime behaviour.
- Never invent testimonials, reviews, client names, awards, statistics or prices.
- Privacy is a core brand value («جميع الصور تُنشر بموافقة العروس»): bride photos and receipts are sensitive
  personal data (PDPL). Private by default.

## Decisions
| # | Decision | Status |
|---|---|---|
| D1 | Styling: plain CSS rebuilt on ONE token-based design system + native motion (CSS transitions/keyframes + IntersectionObserver), `prefers-reduced-motion` honoured. No Tailwind, no animation library. `sharp` approved as a DEV-ONLY dependency for the image pipeline. | DECIDED 2026-09-23 (owner delegated: "as u see best") |
| D2 | Confirmation: after admin approval the customer accepts the booking terms online and uploads the deposit receipt before the hold deadline; admin verifies → `confirmed`. Replaces the manual admin steps `mark_contract_sent` / `mark_contract_signed` (legacy statuses must stay readable for existing rows). | DECIDED 2026-09-23 (owner delegated: "what u see best") |
| D3 | Album handover: BOTH — pickup at a set location or delivery to an address, each with a bookable time slot. | DECIDED 2026-09-23 |
| D4 | Deposit rule (amount or %), bank details shown to customers | OPEN |
| D5 | Timing defaults: hold 48 h, hold reminders 24 h + 6 h before, admin response SLA 24 h, receipt verification SLA 24 h, receipt-rejection extension +24 h, event reminders 7 d + 1 d, selection window 14 d with reminders 7 d + 2 d, handover reminder 1 d, feedback request 2 d after completion, preview retention 30 d after handover | DECIDED 2026-09-23 (owner approved) |
| D9 | Fonts: El Messiri (600) + Cairo (400/700) self-hosted via `@fontsource/el-messiri` + `@fontsource/cairo` (font-only packages, no JS) | DECIDED 2026-09-23 (owner approved) |
| D10 | Sequencing: Runs 2–3 now; Run 4 (receipts) and Run 6 (private galleries) only after the PDPL/transfer answer (U1) and admin MFA (R1) | DECIDED 2026-09-23 (owner approved) |
| D12 | Owner's portfolio prompt (2026-09-24) FOLDED INTO the redo (stack unchanged: plain CSS + native motion, no Tailwind/Framer): portfolio category filter; lightbox = smooth full-screen, keyboard (arrows, Esc) + touch swipe; slow hover scale on gallery items; solid dominant-colour placeholder per image; reveal-once on scroll; optional light hero parallax (reduced-motion safe); an About section (her story + approach); a real README (run, swap images, edit copy, deploy); final test report covering the lightbox by keyboard, 375 px width with no horizontal scroll, console errors, and the production build. Nothing bounces, spins or slides in from off-screen. | DECIDED 2026-09-24 (owner) |
| D13 | Nav label and /packages title: «الخدمات والباقات» (replaces the handoff's «الخدمات والبكجات»); «الباقة» everywhere in copy, never «بكج». | DECIDED 2026-09-24 (owner) |
| D14 | Go-live scope (owner, 2026-09-28: "finish it all and give full access to me as an admin ... make the function and real deal so we can test on the first clients"): Runs 4–8 + the full admin portal + admin settings, executed as `11-golive-plan.md` rev. 2 — Train A (waves 0–7) is the first-client release; Train B (waves 8–13, private media) is merged dark. Supersedes D10's sequencing for everything except private media. | DECIDED 2026-09-28 (owner) |
| D15 | Security-first working rule (owner, 2026-09-28): multiple agents review and attack the code and the baseline before any edit, merge, push or deploy. Baseline audit = `10-security-baseline.md` (0 critical, 0 high, 6 medium); its go-live fixes land first (Wave 0). | DECIDED 2026-09-28 (owner) |
| D16 | Firebase: a NEW project under the owner's Google account replaces `sundus-yar-website` (its owner is unknown; its web config is not recoverable). All Firebase specifics come from config. Blocked on the owner enabling Google 2-Step Verification (Firebase console requirement). | DECIDED 2026-09-28 (orchestrator, owner delegated: "do the best method") |
| D17 | Private media (receipt upload, galleries): built and tested, shipped GATED OFF (no R2 binding, no `PDPL_SIGNOFF_REF`). First clients send the deposit receipt by a pre-filled WhatsApp message and the admin records the deposit. Online confirmation (terms + deposit instructions + hold countdown) is ON once the admin settings are complete. | DECIDED 2026-09-28 (orchestrator, owner delegated: "what is best") |
| D18 | Motion: "cinematic native" (12-motion-spec.md rev. 2) — Harrat-style vocabulary adapted to the bridal identity, no new dependencies, one build flag returns the classic design; git tag `design-classic-v1` (= c80f4c2) is the restore point. Launch design is cinematic only if the motion release gate (W6-05) passes. | DECIDED 2026-09-28 (orchestrator, owner delegated: "what is best and suits the identity and also leave a command to return to the current design") |
| D19 | Defaults for 11 §9 open questions, taken under the owner's delegation and to be confirmed by the owner: (a) new IBAN / studio WhatsApp number reaches customers 24 h after saving (first entry immediate, cancellable); MFA optional at launch (R1 override); (b) no email provider at launch (Resend optional later); (c) old D1 `sundus-yar-bookings` (6fda2ba7…) is not in the deploying Cloudflare account → production starts on a fresh D1, nothing migrated; (d) privacy notice and e-commerce disclosure drafted by the team strictly from the system's actual data handling, business-identity fields (legal name, licence/CR number, VAT status) filled by the owner in admin settings and hidden until filled, marked "pending legal review" in the handoff; (e) services ticker = static band (keeps D12); (f) Workers Free plan, production D1 location hint `eeur`. | DEFAULTED 2026-09-28 (orchestrator) — owner to confirm |
| D20 | Speed vs depth (owner, 2026-09-29, after usage limits paused Wave 1 three times): "Launch first" — finish Train A (waves 1–7) with full review depth (two reviewers per unit + skeptics + integration + fix rounds), launch, then deliver the handoff zip. Train B (waves 8–13, private receipts/galleries, gated off at launch anyway) is NOT built now; it is handed to the colleague as a ready plan (11-units.json waves 8–13 + 11-amendments.json + the wave runner). | DECIDED 2026-09-29 (owner) |
| D11 | Compliance (02-compliance.md, drafting assistance — needs named human sign-off): LAWYER REQUIRED before Runs 4/6 on cross-border transfer and photo classification; add a data-subject-request + guest-removal contact path, an E-Commerce disclosure page (identity, VAT status, cancellation/refund, complaints), a minors default-exclusion rule for public posting, and a breach runbook; retention purge must NOT run on booking/receipt rows until the accountant confirms minimums; owner's VAT status UNKNOWN (threshold SAR 375,000). | RECORDED 2026-09-23 |
| D6 | Photo storage: Cloudflare R2 private bucket + short-lived signed URLs; previews only (originals delivered offline) | PROPOSED |
| D7 | Real testimonials: only from the owner (Instagram «لُطفكم») | PROPOSED |
| D8 | Production D1 migration state (needs `wrangler d1 migrations list … --remote`) | UNKNOWN |

## Run 1 outcome (2026-09-23, fleet workflow wf_969705ba-a3c, 9 agents, ~110 min)
Artifacts: 01-product-spec (67 stories, 56 MVP) · 02-compliance (first attempt ran out of turns; re-run in
progress) · 03-design-system (Paper #FAF6EF, Surface #FFFCF7, Ink #241E1A, Accent #8A6A2E, Line #8F8270;
El Messiri 600 display + Cairo 400/700 text; 4 breakpoints 36/48/64/80rem) · 04-seo (recovered from a
schema-rejected return) · 05-adr-architecture (AUTHORITATIVE where artifacts disagree) · 06-data-model (its agent
ran out of turns while re-checking SQL syntax → the SQL must be validated before Run 3) · 07-api-contracts (33
endpoints, 0 breaking) · 08-copy-ar · 09-red-team (GO-WITH-FIXES).
06-data-model SQL VALIDATED by the orchestrator (2026-09-23, node:sqlite / SQLite 3.53.0): on top of 0001+0003+0004
the 0005 DDL applies cleanly (21 tables, 41 indexes); all 141 write/read statements prepare without error; the only
two failures touch wrangler's own `d1_migrations` table (absent in a plain SQLite file — expected). Re-applying
0005 fails on ALTER ADD COLUMN, as expected for a tracked migration.
ADR agent names map to fleet members: frontend-engineer / design-system-engineer → frontend-developer;
backend-engineer / data-engineer → backend-developer (schema work: database-architect); full-stack-engineer →
fullstack-developer; qa-engineer → qa-tester.

## Binding amendments from the red team (apply in the runs named)
- R1 (Run 4 + Run 6 go-live gate): TOTP MFA on the sole admin account is a HARD precondition, same tier as U1.
- R2 (Run 3, W3-3): the PDPL/U1 gate and `ONLINE_CONFIRMATION` must be enforced in code — receipt/gallery/media
  routes refuse to register unless a dated sign-off record exists — not by convention.
- R3 (Run 3, W3-7): map the 15 derived journey stages onto the stepper explicitly (incl. the two post-handover
  stages) before building it; 03-design-system §4.8's 8-step stepper is superseded.
- R4: there is NO /gallery route — gallery and handover are stage views inside /my-bookings (ADR wins over spec §2).
- R5 (Run 7): handovers.status gains `no_show`, or the spec drops it — decide in Run 7's preflight.
- R6 (Run 4): store a content hash per receipt; warn the admin when the same receipt appears on two bookings.
- R7 (compliance): cover minors in event photos and data-subject requests from guests without accounts.
- R8: D5 timing defaults need the owner's explicit go before Run 3 encodes them in shared/timing.ts.
- R9: receipts may be financial records with a minimum retention — owner/accountant confirms before Run 4.
- Sequencing: Runs 2–3 carry no new personal-data categories and may proceed; Runs 4 and 6 (receipts, private
  photos) stay gated on U1 (PDPL answer), R1 (MFA) and the owner's business inputs (D4 deposit + bank details).
