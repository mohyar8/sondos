# 11 — Go-live plan: Runs 4–8, the admin portal, and the production launch (rev. 2, reconciled)

| | |
|---|---|
| Date | 2026-09-28 (rev. 2 the same day: reconciled with `13-threat-model.md` and the three plan reviews) |
| Author | Principal full-stack architect (security-minded); rev. 2 by the lead architect |
| Code baseline read | `app/` at `c80f4c2` (tag `design-classic-v1` is the design restore point; untouched here) |
| Binding inputs | Owner decisions of 2026-09-28 (they win over older decisions where they conflict), `decisions.md` "Binding constraints", **`10-security-baseline.md`** (its go-live blockers are build units here), **`13-threat-model.md`** (TM-01…TM-24), the three reviews of 2026-09-28 (threat model TM-nn, architecture/operations B1–L5, UX UX-01…UX-18), `05-adr-architecture.md` (authoritative among the older docs), `06`, `07`, `01`, `02`, `09`, and **`12-motion-spec.md`**, whose units share the combined wave plan in §5 |
| Precedence | Owner 2026-09-28 > **§0 Binding controls** > **code** > ADR-001 > the other planning documents. Every place where the code and a document disagree is listed in §1.3 |
| Scope | Finish the customer journey (Runs 4–8) for the first real clients, give the single admin full visibility, and ship to production. The motion design lives in `12-motion-spec.md`; its units are scheduled here (§5) with exclusive file ownership across both plans |
| Writes | Only this file and `12-motion-spec.md`. Nothing under `app/` was changed. Migration 0007 was verified in rev. 1 (§2.3); migration 0008 was verified in a scratch copy for rev. 2 (§2.5, 42 checks) |

> **The plan in six lines**
> 1. Two additive migrations. **0007** (unchanged, verified) adds admin settings as append-only revisions, versioned terms, delivery areas, an append-only admin audit log, booking snapshots, a single-admin index and tamper triggers. **0008** (new, verified) adds verified-email ownership, session revocation, the 24-hour delayed activation of bank and WhatsApp changes, a database kill switch, CSP report counts and no-delete triggers on booking history.
> 2. **Online confirmation is on in production but self-gating**: flow 2 is offered only when `ONLINE_CONFIRMATION="on"`, the database kill switch is on, and the deposit rule, bank account and a terms version exist, all checked inside the approval SQL.
> 3. **A paid bride never loses her date to a machine**: a WhatsApp deposit notice for the current deadline protects the hold from automatic expiry, and while no email provider is configured the cron never expires flow-2 holds; the admin decides from the queue's «قرارات عاجلة» section.
> 4. **Private media is built, tested and shipped dark** in a separate release train (Train B). Production declares no R2 binding; the receipt goes over WhatsApp and the admin records "deposit received".
> 5. **Admin hardening**: the admin is bound to a uid and a verified email; sessions last at most 12 h and can be revoked instantly; money and fraud-sensitive writes need a sign-in no older than 10 minutes (checked by the Worker and a DB CHECK); a new IBAN or WhatsApp number reaches customers only 24 h later unless a second factor was used; customer-visible admin text cannot carry account numbers, links or phone numbers.
> 6. **Delivery**: 101 build units and 10 review gates in 14 waves across two release trains. **Train A** (waves 0–7) ships the first-client release; **Train B** (waves 8–13) ships private media dark. Nothing merges unless `npm run verify` passes and two independent reviewers sign off; every deploy goes through `scripts/release.mjs` and its preflight.

---

## Contents
0. [Binding controls (reconciliation)](#0-binding-controls-reconciliation)
1. [Gap analysis](#1-gap-analysis)
2. [Migrations 0007 and 0008](#2-migrations-0007-and-0008)
3. [API: new and changed endpoints](#3-api-new-and-changed-endpoints)
4. [Gating matrix and enforcement](#4-gating-matrix-and-enforcement)
5. [Combined wave plan and build units (both plans)](#5-combined-wave-plan-and-build-units-both-plans)
6. [Test plan](#6-test-plan)
7. [Production deploy runbook and rollback](#7-production-deploy-runbook-and-rollback)
8. [Handoff package](#8-handoff-package)
9. [Open questions](#9-open-questions)

---

## 0. Binding controls (reconciliation)

Every required change from the three reviews is listed here with the control as adopted, the units that carry it (combined ids, §5.4 maps them to rev. 1 ids) and its status. A unit that implements a control lists its id under "Security"; the wave's review gate checks it against the stated acceptance. Where the reviewers disagreed, the reconciliation is stated in the row.

### 0.1 BLOCKER and HIGH (all incorporated)

| Id | Sev | Control as adopted | Units | Status |
|---|---|---|---|---|
| TM-01 | BLOCKER | The `10-security-baseline.md` go-live blockers become units: C-1 (W1-02), C-2 (W1-01 schema, W2-15 profile, W3-15 booking re-sync), C-3 (W3-15), C-4 (W1-03 binding, W1-15 helper, W2-15, W3-15), C-5 (W1-14), C-8 (W1-03, W2-17, W5-05), C-9 (W1-14 API, W2-18 SPA), C-10 (W2-17 report route, W2-18 Report-Only with `report-to`, W7-01 enforcement), C-11 (W3-16, W4-08), C-14 (W1-01, W1-02, W2-05), C-16 (W1-04), C-17 (W2-02, W2-03). C-3/C-4 land in wave 3, not 2, because `worker/bookings.ts` is owned by W2-16 in wave 2; both are still before the release gate. The Train A release gate requires **zero open baseline go-live items**; RV gates verify each C-n against its SEC acceptance | W1-01…W7-01 as listed | Incorporated |
| B2 / TM-02 | BLOCKER / HIGH | Admin is promoted **by uid**: `promote-admin.mjs --uid --email` updates `WHERE id=? AND lower(email)=lower(?) AND email_verified_at IS NOT NULL AND erased_at IS NULL` and requires exactly 1 changed row; `authorizeAdminRequest` also requires stored `users.email` = token email (case-insensitive). The owner's account is **created in the new Firebase project's console before the public deploy** (so nobody can register her email first), verified on first sign-in, and her uid is recorded in the release log. `users.email_verified_at` lives in **0008**, not in a second `0007` as the baseline's C-2 proposed | W1-01, W1-02, W1-12, W2-15, W7-01 | Incorporated |
| B1 | BLOCKER | (1) A flow-2 hold with terms accepted and a `deposit_notice_sent` event **for the current deadline** is excluded from the cron expiry and from the approve path's targeted sweep; it appears in the queue section `decide_now`. (2) `confirm_payment` and `extend_hold` stay allowed up to `HOLD_GRACE_HOURS` (72 h) after the deadline while the row is still `approved_hold`, never past the event day's start. (3) New admin action `reinstate_hold` (`expired` → `approved_hold`) succeeds only when the date is free (enforced by the unique index). (4) **While no email provider is configured, the cron does not expire flow-2 holds at all**; the admin expires them from the queue with the new `expire_hold` action. (EM is not added to the settings-complete check, because that would switch flow 2 off in production against the owner's decision.) (5) Flow-2 approvals get their own email copy stating the deadline. (6) Test N-30b | W2-02, W2-03, W2-04, W2-10, W2-13, W2-16, W4-05, W6-03 | Incorporated |
| B3 | BLOCKER | (1) Read-only inventory of the old D1 `sundus-yar-bookings` before any build (counts only). (2) Non-zero future blocking bookings or blocked dates → STOP, or copy those **dates only** into the new database's `blocked_dates` (owner decision, §9 Q3). (3) The first go-live version id is recorded as the **launch floor**; `release.mjs --rollback` refuses any version below it; the rollback drill runs between two post-launch versions or on preview. (4) "Revert to pre-launch" is a separate, owner-approved runbook that reconciles data | W0-03, W3-19, W5-04, W7-01 | Incorporated |
| TM-03 / H2 | HIGH | With `ADMIN_SETTINGS_2F="required"` (set once the owner has enrolled TOTP), bank, contact, deposit and terms writes need the second-factor claim. Otherwise a change to an **existing** bank or contact revision takes effect 24 h after saving (`settings_revisions.effective_at`; customers keep the previous revision until then; the first-ever revision is immediate; re-saving the effective values cancels a pending change). Queue alert and a banner with «إلغاء التغيير». The customer panel shows «آخر تحديث لبيانات الحساب: …», and for 72 h after a contact change the hub and panel show a notice quoting the compiled public number as the check. Every sensitive change sends a direct alert email to `ADMIN_NOTIFICATION_EMAIL` when email is configured. The R1 override (MFA optional at launch) is recorded in `decisions.md` by W0-02 | W0-02, W1-01, W1-06, W2-01, W2-10, W2-13, W3-04, W4-01, W4-05, W5-01 | Incorporated; default "24 h delay at launch, 2F once enrolled" for the owner to confirm (§9 Q1) |
| TM-04 | HIGH | One detector (`shared/text.ts` `findPaymentInstructionLike`) refuses IBAN-like tokens, digit runs of 10 or more, URL-like tokens (`://`, `www.`, `wa.me`, `t.me`, `bit.ly`, bare domains) and phone numbers other than the studio's in **every admin-authored customer-visible text**: pickup address and instructions, delivery-area names, terms body and summary, receipt rejection reasons, any status note shown to the customer. Bidi/format characters are refused by the shared text validator. **Pickup moves to AD+R.** Customer views render admin text as plain text with no autolinking | W1-10, W2-01, W2-02, W3-04, W4-06, W4-01, W4-02 | Incorporated |
| TM-05 / H6 | HIGH | One deploy path: `scripts/release.mjs` (design pinned, clean tree, production only from an annotated `release-*` tag that passed the gate, typed go-ahead, `wrangler deploy --tag --message`, release-log append) calls `scripts/release-preflight.mjs`, which asserts account id and name, a real production D1 id, no `r2_buckets`, `preview_urls:false`, `ONLINE_CONFIRMATION` as expected, no `PDPL_SIGNOFF_REF`/`MEDIA_SIGNING_KEY` in vars, `ADMIN_MEDIA_MFA="required"`, matching Firebase project ids and auth domain, the `_headers` hash of the inline script, design markers, legal texts present, no `data:image` and no secret patterns in `dist/client`. `--allow-dirty` is removed. `VITE_SITE_DESIGN` defaults to **classic** when unset; production builds always pass it explicitly. "Return to classic" = rebuild the **currently released tag** as classic, or roll back to the last classic version at or above the launch floor | W1-16, W2-18, W2-19, W3-19, W7-01; 12 §7 | Incorporated |
| TM-06 | HIGH | The customer dispatcher resolves ownership once (`SELECT … FROM booking_requests WHERE id=? AND user_id=?`) and answers an identical `404 BOOKING_NOT_FOUND` for foreign and non-existent ids; handlers receive an `OwnedBooking` and still bind `user_id=?uid` in their writes; `deliveryAreaId` must be active inside the INSERT; the gallery id is taken only from the owned booking; photo ids are checked through `(gallery_id, photo_id)`; two-customer IDOR matrix over every customer route in both gate states | W1-04, W2-06, W2-09, W2-13, W3-01, W9-02, W10-02, W6-01, W13-01 | Incorporated |
| H1 | HIGH | Browser-key referrers allow `https://<projectId>.firebaseapp.com/*` as well as the site; the smoke test clicks a real verification link and a real reset link; the build guard fails when `VITE_FIREBASE_PROJECT_ID` differs from the `FIREBASE_PROJECT_ID` var of the `CLOUDFLARE_ENV` being built or when the auth domain is not `<projectId>.firebaseapp.com`; env files per mode (`.env.development.local`, `.env.preview.local`, `.env.production.local`; never `.env.local`); README:477 reconciled | W2-18, W3-19, W5-04, W7-01 | Incorporated |
| H3 | HIGH | A database kill switch (`ops_switch_revisions`) toggled from the admin settings tab: **off** needs only the admin guard (a safety action), **on** needs a recent sign-in. Effective online confirmation = env var ∧ switch. While off, the confirmation endpoints answer 503, new approvals take the legacy path and the cron skips flow-2 hold expiry. New admin action `confirm_offline` (AD+R, note and amount required) records terms acceptance and the deposit when the customer cannot finish online. The env var stays as the second, slower switch. The W6-03 kill-switch drill uses the D1 switch | W1-01, W1-06, W2-01, W2-02, W2-03, W3-04, W6-03 | Incorporated (replaces rev. 1 Q6's "no offline escape hatch") |
| H4 | HIGH | `/privacy` and `/disclosure` routes render owner- and lawyer-approved plain text; links at every point of collection (AuthDialog, event-profile form, handover form, footer). The release preflight fails while any legal text is missing, so "approved text is live" is a hard precondition of W7-01 | W3-16, W3-13, W4-02, W4-08, W3-19, W7-01 | Incorporated; the text itself comes from the owner and counsel (§9 Q4) |
| H5 | HIGH | Two release trains. **Train A** (waves 0–7): everything the first clients use, all baseline fixes, the motion layer, with its own red team, QA gate and release. **Train B** (waves 8–13): receipts upload, `/api/media`, galleries, retention, on branch `train-b`, merged into the release branch only after its own gate; it ships dark | §5.3 | Incorporated |
| UX-01 | HIGH | Intro: skipped for 60 days after it played (non-personal day number in `localStorage['sy:intro:v1']`, plus the session flag; fail closed); visible sequence ≤ 1.8 s from t0; after an intro the hero enters with one ≤ 400 ms fade (no veil, no word stagger); F0 decode wait ≤ 200 ms; audit reports the `logo-not-ready` rate; acceptance: hero H1 and primary CTA at opacity 1 by t0 + 2.2 s on 4× CPU + Fast 4G | W5-02, W2-21; 12 §4 | Incorporated |
| UX-02 | HIGH | Variant A of the review: sub-state `deposit_reported` in `/me` and the tracker («أبلغتِنا بالتحويل، وسنؤكد استلام العربون ونبلغكِ»); notice-protected holds are never auto-expired (B1) and go to `decide_now`; N-19 kept (notices never move the deadline). Hold squatting through fake notices is bounded: a notice is accepted only for an approved flow-2 hold with accepted terms, once per deadline, and the admin must confirm or cancel explicitly (abuse case in W0-02 and W6-03) | W2-16, W2-03, W2-10, W2-13, W4-05, W0-02, W6-03 | Incorporated |
| UX-03 | HIGH | Queue items carry `waDigits` (server-validated `^[1-9]\d{7,14}$`, used only in the `href`, never rendered as text), `reference` and the template inputs (amount, slot start, method); the tab renders a real `<a href="https://wa.me/…" target="_blank" rel="noopener noreferrer">`; the extra admin-only fields are recorded in the SB-13 minimisation note; acceptance: 1 tap from `/admin` to a prefilled WhatsApp at 375 × 812 | W2-10, W3-05 | Incorporated |
| UX-04 | HIGH | The owner makes an explicit Resend go/no-go before W7-01 (§9 Q2). With no email: after submitting a request the bride gets a one-tap «أرسلي رقم طلبكِ للاستوديو عبر واتساب»; `pending_review` shows «سنراجع طلبكِ ونتواصل معكِ عبر واتساب» (a response time only if the owner states one); the queue shows its count in `document.title`, refetches on `visibilitychange`/focus and shows «آخر تحديث»; a "no-email" walk in the QA gate | W3-20, W4-05, W3-05, W6-04 | Incorporated |

### 0.2 MEDIUM

| Id | Control as adopted | Units | Status |
|---|---|---|---|
| TM-07 | Every admin route requires `auth_time` ≤ 12 h and ≥ `users.tokens_valid_after` (403 `REAUTH_REQUIRED` → dialog); «تسجيل الخروج من كل الأجهزة» (AD+R) sets `tokens_valid_after`; the promote script sets it too; admin SPA signs out after 30 min idle; incident order: invalidate in D1 → kill switch → Firebase disable → password/MFA reset | W1-01, W1-02, W1-08, W1-12, W2-05, W4-03, W5-01, W5-04 | Incorporated |
| TM-08 | Customer recent sign-in (`auth_time` ≤ 10 min) for consent **grant** (withdrawal stays free), booking a **delivery** handover, and phone/email change; admin sees «موافقة على النشر من العروس، لم يؤكدها الاستوديو بعد» and «تغيّر رقم الجوال بعد إنشاء الحجز»; operating rule: the studio confirms consent with the bride before publishing any photo | W1-02, W1-08, W2-06, W2-15, W3-01, W3-07, W3-11, W3-13, W4-02, W5-04 | Incorporated |
| TM-09 | Upload/serve rules: markup refused before sniffing; end marker required and ≤ 1 KiB trailing bytes; dimension caps (8,000 px / 40 MP receipts, 4,096 px galleries); receipts stripped of metadata server-side, metadata-bearing gallery images refused; sniffed type stored and served; media headers (`default-src 'none'; sandbox`, XFO DENY, nosniff, CORP same-origin, `no-referrer`, generated ASCII filename, `private` cache bounded by the remaining lifetime); MAC over `v1\|key\|e` verified before any I/O; `deleted_at IS NULL` on every GET; lifetimes ≤ 1 h customer / ≤ 10 min admin; R2 bucket private, no custom domain, no CORS | W8-01, W9-01, W9-02, W9-03, W10-01, W10-02, W13-01, W13-03 | Incorporated (Train B) |
| TM-10 | `getMediaBucket(env)` returns null unless `isPrivateMediaAllowed(env)`; grep gate: no `env.MEDIA`/`Reflect.get(env,'MEDIA')` outside `gates.ts`; `PRIVATE_MEDIA_SEGMENTS` extended with `upload(s)`, `file(s)`, `image(s)`, `picture(s)`, `attachment(s)`, `proof(s)`, `slip(s)`, `document(s)`, `download(s)`, `pdf`, `thumb(s)`, `preview(s)` (no open path in §3.2 collides); receipt/gallery `booking_events.details` carry ids only | W1-03, W1-13, W9-01…W10-02 | Incorporated |
| TM-11 | Limits of §3.1: the Cloudflare `ratelimits` binding supports only 10 s or 60 s periods, so it carries the **burst** limits keyed on uid (or IP for public routes), and the hourly/daily limits are **atomic SQL caps over existing rows** (booking requests, receipts, consent events). Event-profile and consent events only on change; consent ≤ 10 changes a day; uploads ≤ 2 concurrent; `/api/availability` edge-cached 60 s and IP-limited | W1-03, W1-15, W2-06, W2-09, W2-13, W2-15, W2-17, W3-01, W3-15, W9-02 | Incorporated (hourly limits as SQL caps; see the note) |
| TM-12 | `shared/text.ts` `normalizeFreeText` for every free-text field (NFC; refuses C0/C1, U+061C, U+200E/F, U+202A–E, U+2066–9, U+200B, U+2060, U+FEFF, U+2028/9; ZWNJ/ZWJ allowed; code-point caps = DB CHECKs; names also refuse URLs and `@` handles); the admin wraps user strings in `<bdi>`; `mailto:`/`tel:` only with fixed schemes and `encodeURIComponent`; no `href` from free text. Covers baseline C-13 | W1-10, every handler unit, W2-04, W3-07, all admin UIs | Incorporated |
| TM-14 | Enforced CSP within 7 days of the first production deploy and before any public promotion or private media, with `report-to`/`report-uri` → `/api/csp-report` (counts; origin only); Google script hosts pruned after a clean Report-Only run on preview; `require-trusted-types-for 'script'` as a separate Report-Only header first; `build.assetsInlineLimit: 0` plus a preflight `data:image` check; an enforced-policy trial on preview with the cinematic build: 0 violations across intro, view transitions, ticker, khatam and every auth flow | W1-16, W2-17, W2-18, W3-19, W5-05, W6-02, W6-05, W7-01 | Incorporated |
| TM-15 | Every capacity/eligibility check inside the writing statement (re-book excludes its own row; capacity decrease is a conditional UPDATE; slot deactivation refused while scheduled handovers exist); `extend_hold` is a compare-and-swap on the status and the `hold_expires_at` it read (reconciled with B1: past-deadline extension is allowed only while the row is still `approved_hold`, i.e. the cron or a sweep has not expired it); new claim jobs use `crypto.randomUUID()` claim tokens; sends re-check eligibility or supersede; purge is two-phase and never touches referenced or < 24 h keys; counts-only logs | W2-02, W2-03, W2-08, W3-01, W3-03, W4-07, W8-02, W11-04 | Incorporated |
| TM-17 | Admin search moves to `POST /api/admin/search/bookings` and `POST /api/admin/search/customers` (the query text never appears in any URL); CSP reports store directive + blocked origin only; RV grep gate: `console.*` arguments are literals or `code=`/`count=`/`job=` templates | W3-02, W3-09, W4-03, W2-17, W1-13 | Incorporated (no owner acceptance needed) |
| M1 | Settings, terms, audit and switch inserts stamp `created_at` in SQL (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`); `reauthAt` comes only from `auth_time` through one helper with a test that tells `iat` and `auth_time` apart; §2.1 wording corrected (the CHECK bounds a bug, it does not make one impossible) | W1-02, W1-09, W2-01, §2.1 | Incorporated |
| M2 | `shared/timing.ts` gains `riyadhStartOfDay`, `riyadhLocalToInstant`, `riyadhTodayKey` with tests; every "today" is a Riyadh date key bound from the Worker, never SQL `date('now')` | W1-10 | Incorporated |
| M3 | One joint wave schedule with exclusive file ownership across both plans (§5.5); the re-auth dialog files are in the MFA unit (W5-01, acceptance "re-auth with TOTP enrolled"); `features.blockers` lives in W1-06 so no wave-2 unit imports a same-wave export without a declared dependency | §5, W1-06, W5-01 | Incorporated |
| M4 | Preview runbook: count admins, bookmark, apply 0007/0008, one Firebase project (the dev project), Cloudflare Access, `PREVIEW_READ_ONLY` (C-8) | W1-03, W2-17, W5-05, §7.10 | Incorporated |
| M5 | `whenReady()` caches the resolved module; the router renders `module.default` directly once loaded, so the view-transition snapshot contains the destination H1 on the first visit | W1-18, W4-09 | Incorporated |
| M6 | `npm test` on built-ins only (`node:test`, `node:sqlite`); `scripts/verify.mjs` (lint, tsc, both design builds, tests, grep gates); `.githooks` pre-push/pre-merge-commit; two independent reviewers per unit; the owner cannot accept a critical or high finding | W1-13, §5.1 | Incorporated |
| M7 | Parity hard gate = DOM comparison + emitted-CSS hashes; screenshots after `document.fonts.ready` and image decode with ≤ 0.1% tolerance; Firebase config stubbed for audit builds; `npm ci` scripted for the worktree | W2-21 | Incorporated |
| UX-05 | Below 48rem at most four primary destinations: «اليوم», «الحجوزات», «التقويم», «المزيد»; fixed queue priority (`decide_now`, `holds_expiring`, `deposit_notices`, `requests_over_sla`, `events_today_tomorrow`, `handovers_today_tomorrow`, then the rest), empty sections hidden, a "today" summary; today's events carry `startTime` and `venueArea`; booking detail on phones has a sticky summary with the primary action and WhatsApp first; sections carry fixed `order` values | W1-05, W2-10, W3-05, W4-03 | Incorporated |
| UX-06 | Opening WhatsApp no longer hides a queue item: the item shows «فُتح واتساب قبل {n}» with «تم الإرسال» and «تجاهل»; an item leaves the queue only on a state change or a logged `sent`/`dismissed` | W1-01, W2-05, W2-10, W3-05, W3-07 | Incorporated |
| UX-07 | `toAsciiDigits` in `shared/text.ts`, applied on input in the client and before validation on the server; `inputmode="numeric"`/`"tel"`; IBAN and phone inputs `dir="ltr"`; N-05/N-21/N-22 extended with Arabic-Indic and Persian digits | W1-10, W1-11, W3-04, W3-13, W4-02, W2-15 | Incorporated |
| UX-08 | IBAN displayed grouped inside `<bdi dir="ltr">` with no control characters in the DOM text; copy buttons copy the raw normalised value (24 characters; amounts as digits only), are ≥ 44 px, labelled, and announce «تم النسخ» politely; the changed-bank state shows «تغيّرت بيانات الحساب بعد موافقتكِ على الشروط. لا تحوّلي قبل التأكد منّا عبر واتساب.» with a real link | W2-13, W4-01 | Incorporated |
| UX-09…UX-12, UX-17, UX-18 | Motion-layer items; adopted in `12-motion-spec.md` §0 and its units (W2-20, W3-17, W4-09, W5-02, W5-03, W4-10). UX-12's admin/customer part: accent text only on paper/surface, `--color-accent-deep` on sunk/tint/hairline backgrounds, `--color-accent-soft` only on ink or dark photos (W1-05) | see 12 §0 | Incorporated |
| UX-13 | DoD rule: every tap target ≥ 44 × 44 CSS px with ≥ 8 px spacing; gallery: tile opens the lightbox, a separate 44 px select toggle with `aria-pressed` and icon + text; counter announced politely; at quota the toggle stays focusable and explains why; the lightbox extends the existing native-`<dialog>` pattern (`src/pages/portfolio/Lightbox.tsx`) with its RTL key and swipe mapping; the admin calendar defaults to an agenda list on phones | §5.1, W3-06, W3-10, W4-02, W11-03, W12-01 | Incorporated |
| UX-14 | Gated-mode copy for `awaiting_previews` («سنرسل لكِ الصور عبر واتساب لتختاري منها» with a WhatsApp link); production stages show «آخر تحديث: {date}»; a typical duration only if the owner supplies one; every stage card has exactly one primary action or an explicit "nothing needed until {date}" line; QA checks "next step and deadline above the fold at 375 px" per stage | W2-16, W4-05, W6-04 | Incorporated |

### 0.3 LOW (incorporated where cheap)

TM-13 (CSV: full-width `＝＋－＠`, leading `|`, U+2028/9 and zero-width stripped, numeric columns unprefixed, PII warning in the export dialog, 4-app test) → W2-12, W4-03. TM-16 → W2-13, W4-01 (with UX-08). TM-18 (`terms_accepted` details carry `bodySha256`; the customer can view the exact version she accepted) → W2-13, W4-01. TM-19 (no `wa.me` literal outside `src/lib/whatsapp.ts`, message cap, number-changed notice) → W1-11, W1-13, W4-05. TM-20 (notices, receipts and hash matches are not proof; `confirm_payment` takes the amount seen in the bank statement; no links followed inside receipt PDFs) → W2-02, W4-04, W11-01, W5-04. TM-21 (exact `off` only; `ADMIN_MFA_DISABLED` blocker; preflight refuses `off` in production) → W1-02, W1-06, W3-19. TM-22 → W2-21. TM-23 (2FA on the Cloudflare and Firebase owner accounts, scoped tokens, bookmark before every remote write, "D1 triggers do not bind account holders" documented) → W0-03, W5-04, W7-01. TM-24 (preview behind Cloudflare Access, dev Firebase project) → W1-03, W5-05. L1 (old admin bundles ignore unknown actions) → W1-07. L2 (no-delete triggers on status history and events; `admin_promoted`/`admin_demoted` audit rows) → W1-01, W1-12. L3 (build/release refuses `ADMIN_MEDIA_MFA` ≠ `required`) → W3-19. L4 (`wrangler tail` during the launch window; hourly queue check on day one) → W7-01, W5-04. L5 (the ticker waits for the owner's written D12 decision) → W5-03, §9 Q5. UX-15 (terms inline without scroll-to-end; the whole checkbox row is the label; receipt-image instruction; «أرسلي صورة الإيصال عبر واتساب», with «أرسلتُ إيصال العربون» only inside the prefilled message) → W4-01, W4-05, W2-14. UX-16 (read-only `autocomplete="username"` field; «التحقق صالح حتى {time}») → W1-08, W3-04.

### 0.4 Deferred or partly deferred (with reasons)

| Item | What is deferred | Reason and residual |
|---|---|---|
| SEC-11 for **customers** (C-14 applies to all users) | `tokens_valid_after` is checked on every admin request; customer requests are not checked | Checking it would add a D1 read to every customer request; residual: a disabled customer token stays valid ≤ 60 min. Revisit with Train B |
| H2 #3 out-of-band alert | Implemented as a direct email when EM is configured; there is no alert channel without a provider | No channel exists without Resend (the owner decides, §9 Q2). Compensating controls: the 24 h delay, the customer-visible "changed" notices, the admin banner |
| TM-11 hourly/daily limits on the binding | The `ratelimits` binding only supports 10 s/60 s windows | Hourly and daily limits are SQL caps over rows that already exist; the binding carries 60 s bursts. Profile writes (no per-write row) get only the burst limit, which is adequate because they are idempotent |
| TM-14 Trusted Types enforcement | `require-trusted-types-for 'script'` stays Report-Only at launch | By design: enforce only after a clean Report-Only period shows Firebase does not violate it |
| C-6/C-7 "MFA required" (baseline) | TOTP is available (W5-01) but not required to sign in | Owner decision 2026-09-28 (MFA optional). SEC-02 is rated HIGH if Train B's gate opens without it, so Train B keeps `ADMIN_MEDIA_MFA="required"` for media admin routes |
| C-12, C-15, C-19 (baseline "recommended") | Not deferred: C-12 → W3-20, C-15 → W1-08, C-19 → W8-02 (hard deadline: 90 days after the first booking reaches a terminal status) | — |

---

## 1. Gap analysis

### 1.1 What already exists in code (Run 3, commit `988d396`, plus the preview env `c80f4c2`)

| Area | Exists (evidence) | State |
|---|---|---|
| Portal schema | `migrations/0005_portal_schema.sql`: `flow_version`, `deposit_amount`, `terms_version`, `terms_accepted_at`, `completed_at` on `booking_requests`; `event_kinds`, `notification_kinds`, `booking_events`, `notification_log`, `job_runs`, `media_objects`, `booking_receipts` (with `attempt_no`, `void`), `event_profiles`, `booking_consents`, `galleries`, `gallery_photos`, `gallery_selections`, `album_production`, `handover_slots`, `handovers` (structured address, `no_show`/`cancelled` — resolves red-team R5), `feedback`. `0006` adds the `hold_expired` event kind and the `(created_at, id)` index | Complete for Runs 4–8 **except** settings, terms versions, delivery areas, admin audit, snapshots (→ 0007) |
| Journey derivation | `shared/journey.ts:480-541` `deriveJourneyStage` (15 stages, sub-states `legacy_flow`, `receipt_rejected`, `awaiting_previews`, `handover_missed`); `worker/portal/journey-loader.ts:57-96` loads the facts for `/api/bookings/me` | Complete; lacks a "terms accepted, deposit owed" fact |
| `/api/bookings/me` | `worker/bookings.ts:57-74` additive `flowVersion`, `stage`, `stageLabel`, `stageSubState`, `stageDeadline`, `depositAmount`, top-level `serverTime` | Complete; no studio contact |
| Cron + outbox | `worker/scheduled.ts`, `worker/jobs/registry.ts:19-25` (hold-expiry, hold-reminders, outbox-drain), `worker/jobs/hold-state.ts` (flow-2 only), `worker/notify/outbox.ts` (idempotent, `skipped` when Resend is absent), `worker/emails/hold.ts` | Works, but hold-reminder copy says «ارفعي إيصال» (`emails/hold.ts:73-75`), wrong while uploads are gated |
| Gate | `worker/portal/gates.ts`: `isPrivateMediaAllowed = ONLINE_CONFIRMATION==='on' && PDPL_SIGNOFF_REF non-blank`; `PRIVATE_MEDIA_SEGMENTS` (`receipt(s)`, `gallery/galleries`, `album(s)`, `photo(s)`, `media`); `assertPrivateMediaRoutesGated` at module load; dispatcher-level `effectiveRouteGate` → 503 | Does **not** check an R2 binding or a signing key; `album` in the deny-list collides with the owner's "album status works while gated" (§1.3 D1) |
| Route registries | `worker/portal/portal-routes.ts:120` `customerPortalRoutes = []`, `:127` `mediaRoutes = []`; `worker/portal/admin-portal-routes.ts:66` `adminPortalRoutes = []`; namespaces `/api/admin/bookings/{id}/<sub>`, `/api/admin/handover-slots`, `/api/admin/queue` | Dispatchers done, **no routes registered** |
| Request guards | `worker/portal/request.ts` `requireVerifiedCustomer`, `readJsonBody` (exact keys, byte cap), `readMultipartBody` (Content-Length required) | Complete |
| Customer hub | `src/features/journey/*` (tracker, countdown, `StageViewHost`), `hub-model.ts:224-253` next-step plan (views `complete`, `details`, `gallery`, `handover`, `feedback`), prefilled WhatsApp per stage (`hub-model.ts:641-723`) | `stage-views.ts:85` `stageViews = {}` — **no view registered**; WhatsApp number hard-coded in `src/lib/whatsapp.ts:11` |
| Admin shell | `src/components/AdminDashboard.tsx` (list with status/date filters, keyset pagination, detail, status history, notes, actions, blocked dates, `?booking=&tab=` deep links), `features/admin-portal/AdminBookingPortal.tsx` host, `sections.ts:94,97` | `adminBookingSections = []`, `adminWorkspaceTabs = []` — **nothing registered** |
| Admin API | `worker/admin.ts`: list (`status`,`from`,`to`,`limit`,`cursor`), detail, `POST …/actions`, `PATCH …/notes`, blocked dates | No search, no calendar, no customers, no export, no timeline of `booking_events`; `allowedActions` is **not flow-aware** (`admin.ts:723`) |
| State machine | `worker/admin-workflow.ts:554-715` atomic transition batch with the `CASE WHEN changes()=1` guard | **Approve never writes flow 2**: `admin-workflow.ts:28` fixed 24 h hold, `ONLINE_CONFIRMATION` is never read, no deposit snapshot; no `extend_hold`/`reject_receipt` (`shared/admin.ts:21-29`) |
| Auth | `worker/auth.ts:69-137` RS256 + JWKS, `aud`/`iss` from `FIREBASE_PROJECT_ID`, requires `auth_time`; `worker/admin-auth.ts` role from D1 | Verifies `auth_time` but **does not return it** → no re-auth possible; no second-factor claim read |
| Admin role | `worker/profile.ts:308-322` inserts `role='customer'` and never updates `role` on conflict; README documents a manual `UPDATE` | No single-admin guarantee, no promotion script |
| Security headers | `public/_headers` CSP **Report-Only**, frame-src hard-codes `sundus-yar-website.firebaseapp.com`, `img-src 'self'` (no `blob:`) | Needs the new Firebase host, `blob:`, then enforcement |
| Config | `wrangler.jsonc`: crons, `ONLINE_CONFIRMATION="off"`, `FIREBASE_PROJECT_ID="sundus-yar-website"`, D1 `sundus-yar-bookings` (`6fda2ba7…`), `env.preview` | No `account_id`, no new production D1; `worker-configuration.d.ts` is **stale** (no `ONLINE_CONFIRMATION`, stray `apiKey`/`authDomain`… names from an old `.dev.vars`) |

### 1.2 What is missing, per run (combined unit ids, §5.4 maps them to rev. 1)

| Run | Missing (built by) |
|---|---|
| **4 — online confirmation** | Admin settings (deposit rule, bank, contact, pickup), terms versions, delayed activation and kill switch (W1-01 schema, W1-06 read, W2-01 API, W3-04/W4-06 UI); flow-2 approval with deposit snapshot, 48 h hold capped before the event, targeted expiry sweep that spares notice-protected holds, `extend_hold`, `expire_hold`, `reinstate_hold`, `confirm_offline`, `reject_receipt`, flow-2 `confirm_payment` recording the amount (W2-02); hold jobs that never expire a paid bride's date (W2-03); flow-2 approval email copy (W2-04); customer confirmation API (W2-13) and panel with countdown and deposit instructions (W4-01); gated in Train B: media primitives (W8-01), `/api/media` (W9-01), receipt upload (W9-02, W10-03), admin receipt review with hash-reuse hint (W10-01, W11-01) |
| **5 — pre-event** | Event profile + publishing consent (default NO, recent sign-in to grant) API (W2-06), customer panel + `.ics` (W3-13), admin view (W3-11), 7 d / 1 d reminders (W3-03) |
| **6 — galleries (Train B, gated)** | Admin gallery API (W9-03), customer gallery API (W10-02), browser resize + resumable uploader (W10-04), admin section (W11-02), selection UI (W11-03), lightbox (W12-01), selection reminders + orphan sweep (W11-04). While gated: offline selection; the admin only advances production status |
| **7 — album + handover** | Production status API on a non-media path (W2-07), admin control (W3-11); delivery areas + pickup settings (0007, W2-01); slot schedule and admin handover actions incl. `no_show` (W2-08, W3-10); customer slot booking with capacity guard, fee snapshot and recent sign-in for delivery (W3-01, W4-02); handover reminder (W3-03) |
| **8 — feedback, retention, queue** | Feedback API (W2-09), panel (W3-14), admin view (W3-12), +2 d request job (W4-07); retention job behind `RETENTION_PURGE` (W8-02); admin work queue API (W2-10) and landing tab (W3-05, W4-03) |
| **Admin "see everything"** | POST search by name/phone/reference/email + customer filter (W3-02), calendar month view with blocked dates (W2-11, W3-06), customers directory (W2-11, W3-09), timeline merging status history + events + email outbox (W2-05, W3-08), one-tap WhatsApp next actions (W2-14, W3-05, W3-07), deposit/terms panel (W4-04), CSV export without formula injection (W2-12, W4-03), audit log view (W2-05, W3-12) |
| **Admin hardening** | `auth_time`/second-factor claims, admin bound to uid + verified email, 12 h sessions, revocation, re-auth guards (W1-02), re-auth dialog + idle sign-out (W1-08), append-only audit (0007/0008, W1-09), single-admin index (0007) + promotion by uid (W1-12), sign out everywhere (W2-05, W5-01), optional TOTP MFA sign-in/enrolment (W5-01) |
| **Baseline go-live blockers** | C-1 (W1-02), C-2 (W1-01, W2-15, W3-15), C-3/C-4 (W1-03, W1-15, W2-15, W3-15), C-5 and API headers (W1-14), C-8 (W1-03, W2-17, W5-05), C-9/C-10 (W2-17, W2-18, W7-01), C-11 (W3-16, W4-08), C-14 (W1-01, W1-02), C-16 (W1-04), C-17 (W2-02, W2-03); recommended C-12 (W3-20), C-13 (W1-10 + handlers), C-15 (W1-08), C-19 (W8-02) |
| **Platform** | `account_id`, new production D1, new Firebase project id, `ONLINE_CONFIRMATION="on"`, `preview_urls: false`, `ratelimits` bindings, a local-only `env.mediatest`, preview read-only (W1-03); limiter and windowed caps (W1-15); shared text validator and Riyadh time helpers (W1-10); security headers, CSP reporting and config guard (W2-17, W2-18); test harness and `verify` (W1-13); one release path with preflight (W3-19); route and UI registry slots so features never edit a shared registry in parallel (W1-04, W1-05) |

### 1.3 Where the code and the documents disagree (code wins unless the owner decided otherwise)

| # | Document says | Code/owner says | This plan |
|---|---|---|---|
| D1 | 07 §3.F `PATCH /api/admin/bookings/{id}/album` | `gates.ts:48` lists `album` as a private-media word → that path answers 503 while media is gated, but the owner wants album status **on** | Resource renamed **`/production`** (no deny-listed word). The deny-list itself is not weakened |
| D2 | 07 §3.D `publishingConsent` inside `event_profiles` | 0005 keeps consent in `booking_consents` (no row = NO), `event_profiles` has no consent column | Separate `PUT /api/bookings/{id}/consent` (a path named `…/publish-photos` would also hit the `photos` deny-word) |
| D3 | 07 §3.G single `deliveryAddress` string | 0005 `handovers`: `delivery_city/district/street/landmark` | Structured address; city is the chosen delivery area's name (snapshot) |
| D4 | ADR §2.1: approve writes flow 2 when the var is on; hold 48 h | `admin-workflow.ts:28,603` 24 h, flow 1 always | Implemented in W2-02, plus the settings-complete and kill-switch predicates |
| D5 | ADR §2.7: bank details in `DEPOSIT_*` Worker secrets; ADR `shared/terms.ts` static terms | Owner 2026-09-28: the admin enters them in the UI; terms are versioned | `settings_revisions` + `terms_versions` in D1; no bank secret exists |
| D6 | ADR/07 §3.B.2: one multipart request carries terms acceptance + file | Owner: receipt upload gated; WhatsApp channel is the production path | Two steps for both channels: accept terms (JSON), then upload **or** WhatsApp. Upload requires terms already accepted |
| D7 | ADR: `ONLINE_CONFIRMATION` affects new approvals only | Fraud incident needs a stop that hides bank details | The var **and the D1 kill switch** (H3) close the customer confirmation endpoints (503 + WhatsApp fallback); admin actions keep working, the cron stops expiring flow-2 holds, and `confirm_offline` finishes in-flight bookings |
| D8 | ADR/decisions R1: TOTP MFA is a hard gate for Runs 4/6 | Owner: MFA optional for sign-in | MFA not required to sign in; **required only for private-media admin routes** (`ADMIN_MEDIA_MFA`, default `required`), which are off in production. Recorded as an owner override (D15); compensating controls in §0 (TM-03, TM-07); §9 Q1 |
| D9 | ADR: `worker/auth.ts` stays unchanged | Re-auth needs `auth_time` | Additive fields only (`authTime`, `secondFactor`) |
| D10 | ADR §6.2 registries appended by each feature, in order | Parallel waves need exclusive files | Per-feature **slot files** created once (W1-04, W1-05); registries never edited again |
| D11 | 07 §3.B.1 confirmation returns receipts | Receipts exist only when the gate is open | `receipts` present only when `receiptChannel = "upload"` |
| D12 | README: `ONLINE_CONFIRMATION` ships `"off"` | Owner: on in production | `"on"` (W1-03); still self-gated by settings |
| D13 | `worker-configuration.d.ts` is regenerated by `wrangler types` | Regenerating today adds `ONLINE_CONFIRMATION: "off"` as required while `platform-env.d.ts` declares it optional → TS2687/TS2430 | W1-03 reconciles: vars declared in `wrangler.jsonc` are typed only by the generated file; `platform-env.d.ts` keeps secrets/optional names only; the R2 binding is read through a runtime guard, never through the (possibly env-merged) type |
| D14 | ADR `admin.ts:986` email key collision noted | Still present at `admin.ts:1171` | Status email skipped when the status did not change (W2-02) |
| D15 | decisions.md R1: TOTP MFA on the sole admin is a hard precondition for Runs 4/6 | Owner 2026-09-28: MFA optional; flow 2 on at launch | Recorded as an owner override in `decisions.md` by W0-02. Compensating controls: TM-03 (24 h delay unless 2F), TM-07 (12 h sessions, revocation, idle sign-out), H2 alert email when EM is configured. Train B keeps 2F for media admin routes |
| D16 | rev. 1 Q6: flow-2 confirmation has no offline escape hatch | Review H3: a kill switch must not strand in-flight bookings | `confirm_offline` admin action (AD+R, note and amount required, audited) |
| D17 | rev. 1 §7.8: "`wrangler rollback`, 0007 is additive so older code runs on it" | Review B3: version bindings roll back with the code, so a rollback below the first go-live version rebinds the **old** D1 and the **old** Firebase project | Launch floor; `release.mjs --rollback` refuses versions below it; "revert to pre-launch" is a separate owner-approved runbook |
| D18 | 12 rev. 1 §7.1: `VITE_SITE_DESIGN` defaults to `cinematic` | Review H6: an unset flag would ship a partial motion layer | Unset → `classic`; `release.mjs` always passes the design explicitly |
| D19 | 10-baseline C-2: `migrations/0007_users_email_verified.sql` | 0007 is the go-live settings migration | `users.email_verified_at` (with C-14's `tokens_valid_after`) lives in **0008** |
| D20 | rev. 1: the cron expires every overdue flow-2 hold; `whatsapp-notice` "never changes status or the deadline" | Reviews B1 and UX-02: a bride who paid can lose her date while the admin is offline, and nothing notifies her | The notice still never changes status or the deadline, but it **protects** the hold from automatic expiry; no automatic flow-2 expiry while EM is off; grace period and `reinstate_hold` |

---

## 2. Migrations 0007 and 0008

### 2.1 Design rules
- **Expand only** (ADD COLUMN, CREATE TABLE/INDEX/TRIGGER, INSERT of vocabulary). Nothing dropped or rewritten; the code at `c80f4c2` keeps working on a 0007 + 0008 database (it never touches the new objects; the new triggers only forbid edits and deletes the code never makes).
- Reuses 0005 wherever it fits: `booking_events` (per-booking audit, actors), `booking_consents`, `event_profiles`, `handover_slots`, `handovers`, `album_production`, `feedback`, `booking_receipts`, `notification_log`.
- **Settings are immutable revisions**: saving a section inserts a row. The **effective** value of a section is its highest-id row whose `COALESCE(effective_at, created_at)` is not in the future (0008 adds `effective_at` for the 24 h delayed activation of bank and contact changes); a newer row that is not yet effective is the section's **pending** change. History, audit and "what did the customer see" are therefore free and tamper-evident.
- Instants are `toISOString()` strings, checked with the 0005 `strftime(...) IS col` pattern; never `CURRENT_TIMESTAMP`. In settings, terms, audit and switch inserts, `created_at` is stamped **by SQL** (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), never bound from the Worker (review M1).
- `reauth_at` (the token's `auth_time`) is stored for sensitive rows, and the database refuses a row whose `reauth_at` is more than 10 minutes before `created_at`. This **bounds** a Worker bug; it does not make one impossible: a Worker that stored `iat` or `now` as `reauth_at` would still pass. The second control is the single helper `reauthAtFromToken()` (W1-02), the only source of `reauthAt`, with a test that tells `iat` and `auth_time` apart.
- Vocabulary inserts use `WHERE column1 NOT IN (…)` (not `INSERT OR IGNORE`, which would also silently swallow a CHECK violation).

### 2.2 DDL — `app/migrations/0007_golive_admin_settings.sql` (W1-01 commits exactly this)

```sql
-- 0007_golive_admin_settings.sql
-- Go-live: admin settings (deposit rule, bank account, studio contact, pickup), versioned booking terms,
-- delivery areas, an append-only admin audit log, and the columns that snapshot what a customer saw.
-- EXPAND ONLY: CREATE TABLE / INDEX / TRIGGER, ADD COLUMN and vocabulary INSERTs. Nothing is dropped,
-- renamed or rewritten. Instants are 'YYYY-MM-DDTHH:MM:SS.sssZ' (UTC) from new Date().toISOString().
-- Requires 0005 and 0006. Fails loudly (it never silently skips) if a precondition is not met, e.g. a
-- database that already has two admins cannot take ux_users_single_admin.

-- 1. Vocabularies (INSERT-only; the NOT IN keeps a re-run harmless and a CHECK failure still errors).
INSERT INTO event_kinds (kind)
SELECT column1 FROM (VALUES
  ('terms_accepted'),
  ('deposit_notice_sent'),
  ('deposit_recorded'),
  ('receipt_verified'),
  ('event_profile_saved'),
  ('feedback_submitted'),
  ('internal_notes_updated'),
  ('admin_whatsapp_opened')
)
WHERE column1 NOT IN (SELECT kind FROM event_kinds);

CREATE TABLE admin_audit_actions (
  action TEXT PRIMARY KEY NOT NULL
    CHECK (length(action) BETWEEN 3 AND 48 AND action NOT GLOB '*[^a-z_]*')
);

INSERT INTO admin_audit_actions (action) VALUES
  ('settings_deposit_updated'), ('settings_bank_updated'), ('settings_contact_updated'),
  ('settings_pickup_updated'), ('terms_published'),
  ('delivery_area_created'), ('delivery_area_updated'),
  ('handover_slot_created'), ('handover_slots_generated'), ('handover_slot_updated'), ('handover_slot_deleted'),
  ('blocked_date_created'), ('blocked_date_deleted'),
  ('bookings_exported'),
  ('receipt_viewed'), ('gallery_selection_exported');

-- 2. At most one admin (owner decision 2026-09-28). The role is granted only by scripts/promote-admin.mjs
--    (wrangler d1 execute); no API writes users.role. Lifting this later is a deliberate DROP INDEX migration.
CREATE UNIQUE INDEX ux_users_single_admin ON users(role) WHERE role = 'admin';

-- 3. Admin settings: one immutable row per saved section. The current value of a section is its row with
--    the highest id. Money- and fraud-sensitive sections carry reauth_at (the Firebase auth_time of the
--    token that saved them), which must be at most 10 minutes before created_at.
CREATE TABLE settings_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL CHECK (section IN ('deposit', 'bank', 'contact', 'pickup')),
  deposit_kind TEXT CHECK (deposit_kind IS NULL OR deposit_kind IN ('fixed', 'percent')),
  deposit_fixed_amount INTEGER
    CHECK (deposit_fixed_amount IS NULL OR (typeof(deposit_fixed_amount) = 'integer' AND deposit_fixed_amount BETWEEN 1 AND 1000000)),
  deposit_percent INTEGER
    CHECK (deposit_percent IS NULL OR (typeof(deposit_percent) = 'integer' AND deposit_percent BETWEEN 1 AND 100)),
  deposit_round_to INTEGER
    CHECK (deposit_round_to IS NULL OR (typeof(deposit_round_to) = 'integer' AND deposit_round_to IN (1, 5, 10, 50, 100))),
  bank_name TEXT
    CHECK (bank_name IS NULL OR (length(bank_name) BETWEEN 2 AND 80 AND bank_name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  bank_account_holder TEXT
    CHECK (bank_account_holder IS NULL OR (length(bank_account_holder) BETWEEN 2 AND 120 AND bank_account_holder NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  bank_iban TEXT
    CHECK (
      bank_iban IS NULL
      OR (
        length(bank_iban) = 24
        AND substr(bank_iban, 1, 2) = 'SA'
        AND substr(bank_iban, 3, 4) NOT GLOB '*[^0-9]*'
        AND substr(bank_iban, 7) NOT GLOB '*[^0-9A-Z]*'
      )
    ),
  whatsapp_number TEXT
    CHECK (whatsapp_number IS NULL OR (length(whatsapp_number) BETWEEN 8 AND 15 AND whatsapp_number NOT GLOB '*[^0-9]*' AND substr(whatsapp_number, 1, 1) <> '0')),
  pickup_address TEXT
    CHECK (pickup_address IS NULL OR (length(pickup_address) BETWEEN 5 AND 300 AND pickup_address NOT GLOB ('*[' || char(1) || '-' || char(9) || char(11) || '-' || char(31) || char(127) || ']*'))),
  pickup_instructions TEXT
    CHECK (pickup_instructions IS NULL OR (length(pickup_instructions) BETWEEN 1 AND 500 AND pickup_instructions NOT GLOB ('*[' || char(1) || '-' || char(9) || char(11) || '-' || char(31) || char(127) || ']*'))),
  created_by TEXT NOT NULL
    REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reauth_at TEXT
    CHECK (reauth_at IS NULL OR (length(reauth_at) = 24 AND substr(reauth_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', reauth_at) IS reauth_at)),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (
    (
      section = 'deposit'
      AND deposit_kind IS NOT NULL AND deposit_round_to IS NOT NULL
      AND (
        (deposit_kind = 'fixed' AND deposit_fixed_amount IS NOT NULL AND deposit_percent IS NULL)
        OR (deposit_kind = 'percent' AND deposit_percent IS NOT NULL AND deposit_fixed_amount IS NULL)
      )
      AND bank_name IS NULL AND bank_account_holder IS NULL AND bank_iban IS NULL
      AND whatsapp_number IS NULL AND pickup_address IS NULL AND pickup_instructions IS NULL
    )
    OR (
      section = 'bank'
      AND bank_name IS NOT NULL AND bank_account_holder IS NOT NULL AND bank_iban IS NOT NULL
      AND deposit_kind IS NULL AND deposit_fixed_amount IS NULL AND deposit_percent IS NULL AND deposit_round_to IS NULL
      AND whatsapp_number IS NULL AND pickup_address IS NULL AND pickup_instructions IS NULL
    )
    OR (
      section = 'contact'
      AND whatsapp_number IS NOT NULL
      AND deposit_kind IS NULL AND deposit_fixed_amount IS NULL AND deposit_percent IS NULL AND deposit_round_to IS NULL
      AND bank_name IS NULL AND bank_account_holder IS NULL AND bank_iban IS NULL
      AND pickup_address IS NULL AND pickup_instructions IS NULL
    )
    OR (
      section = 'pickup'
      AND pickup_address IS NOT NULL
      AND deposit_kind IS NULL AND deposit_fixed_amount IS NULL AND deposit_percent IS NULL AND deposit_round_to IS NULL
      AND bank_name IS NULL AND bank_account_holder IS NULL AND bank_iban IS NULL AND whatsapp_number IS NULL
    )
  ),
  CHECK (section = 'pickup' OR reauth_at IS NOT NULL),
  CHECK (reauth_at IS NULL OR (julianday(created_at) - julianday(reauth_at)) * 1440 BETWEEN 0 AND 10)
);

CREATE INDEX idx_settings_revisions_section ON settings_revisions(section, id);

-- 4. Booking terms: immutable, numbered versions. Publishing = inserting the next version; the current
--    version is the highest seq. Customers accept one exact version (booking_requests.terms_version).
CREATE TABLE terms_versions (
  version TEXT PRIMARY KEY NOT NULL CHECK (version = 'v' || seq),
  seq INTEGER NOT NULL UNIQUE CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 9999),
  body TEXT NOT NULL
    CHECK (length(body) BETWEEN 50 AND 20000 AND body NOT GLOB ('*[' || char(1) || '-' || char(8) || char(11) || char(12) || char(14) || '-' || char(31) || char(127) || ']*')),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  change_summary TEXT
    CHECK (change_summary IS NULL OR (length(change_summary) BETWEEN 1 AND 300 AND change_summary NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  created_by TEXT NOT NULL
    REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reauth_at TEXT NOT NULL
    CHECK (length(reauth_at) = 24 AND substr(reauth_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', reauth_at) IS reauth_at),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK ((julianday(created_at) - julianday(reauth_at)) * 1440 BETWEEN 0 AND 10)
);

-- 5. Delivery areas with a fee (SAR). Deactivated, never deleted once a handover used them.
CREATE TABLE delivery_areas (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  name TEXT NOT NULL UNIQUE
    CHECK (length(name) BETWEEN 2 AND 60 AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')),
  fee INTEGER NOT NULL CHECK (typeof(fee) = 'integer' AND fee BETWEEN 0 AND 5000),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (typeof(sort_order) = 'integer' AND sort_order BETWEEN 0 AND 999),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at)
);

-- 6. Append-only audit of admin actions that are not tied to one booking (per-booking actions stay in
--    booking_status_history and booking_events). details is a small JSON object with ids and counts only.
CREATE TABLE admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_uid TEXT NOT NULL
    REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  action TEXT NOT NULL
    REFERENCES admin_audit_actions(action) ON UPDATE RESTRICT ON DELETE RESTRICT,
  target_id TEXT
    CHECK (target_id IS NULL OR (length(target_id) BETWEEN 1 AND 64 AND target_id NOT GLOB '*[^0-9A-Za-z._:-]*')),
  details TEXT
    CHECK (details IS NULL OR (length(details) <= 2000 AND json_valid(details) AND json_type(details) = 'object')),
  reauth_at TEXT
    CHECK (reauth_at IS NULL OR (length(reauth_at) = 24 AND substr(reauth_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', reauth_at) IS reauth_at)),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (reauth_at IS NULL OR (julianday(created_at) - julianday(reauth_at)) * 1440 BETWEEN 0 AND 10)
);

CREATE INDEX idx_admin_audit_log_created ON admin_audit_log(created_at, id);

-- 7. Snapshots on the booking: which deposit rule produced deposit_amount, which bank details were shown
--    when she accepted the terms, and what the admin recorded as received.
ALTER TABLE booking_requests ADD COLUMN deposit_rule_revision_id INTEGER
  REFERENCES settings_revisions(id)
  CHECK (deposit_rule_revision_id IS NULL OR flow_version = 2);

ALTER TABLE booking_requests ADD COLUMN bank_revision_id INTEGER
  REFERENCES settings_revisions(id)
  CHECK (bank_revision_id IS NULL OR terms_accepted_at IS NOT NULL);

ALTER TABLE booking_requests ADD COLUMN deposit_received_amount INTEGER
  CHECK (deposit_received_amount IS NULL OR (typeof(deposit_received_amount) = 'integer' AND deposit_received_amount BETWEEN 1 AND estimated_total));

ALTER TABLE booking_requests ADD COLUMN deposit_received_at TEXT
  CHECK (
    (deposit_received_at IS NULL) = (deposit_received_amount IS NULL)
    AND (deposit_received_at IS NULL OR (length(deposit_received_at) = 24 AND substr(deposit_received_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', deposit_received_at) IS deposit_received_at))
  );

-- 8. Receipt reuse detection (red-team R6): SHA-256 of the stored bytes; the admin is warned when the same
--    hash appears on another booking.
ALTER TABLE booking_receipts ADD COLUMN content_sha256 TEXT
  CHECK (content_sha256 IS NULL OR (length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'));

CREATE INDEX idx_booking_receipts_sha256 ON booking_receipts(content_sha256) WHERE content_sha256 IS NOT NULL;

-- 9. Delivery area and fee snapshot on a delivery handover.
ALTER TABLE handovers ADD COLUMN delivery_area_id TEXT
  REFERENCES delivery_areas(id) ON UPDATE CASCADE ON DELETE RESTRICT
  CHECK ((delivery_area_id IS NULL) = (method = 'pickup'));

ALTER TABLE handovers ADD COLUMN delivery_fee INTEGER
  CHECK (
    (delivery_fee IS NULL) = (delivery_area_id IS NULL)
    AND (delivery_fee IS NULL OR (typeof(delivery_fee) = 'integer' AND delivery_fee BETWEEN 0 AND 5000))
  );

-- 10. Indexes for the admin views (queue, calendar, search by customer).
CREATE INDEX IF NOT EXISTS idx_booking_requests_user_created ON booking_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_booking_requests_status_event ON booking_requests(status, event_date);
CREATE INDEX IF NOT EXISTS idx_handover_slots_starts ON handover_slots(starts_at);

-- 11. Tamper resistance. settings_revisions, terms_versions and admin_audit_log are append-only;
--     booking_status_history rows never change; a booking_events row may only be redacted (note removed,
--     redacted_at stamped). actor_uid may still change through the users(id) foreign-key actions.
CREATE TRIGGER trg_settings_revisions_no_update BEFORE UPDATE ON settings_revisions
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_SETTINGS_REVISIONS');
END;

CREATE TRIGGER trg_settings_revisions_no_delete BEFORE DELETE ON settings_revisions
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_SETTINGS_REVISIONS');
END;

CREATE TRIGGER trg_terms_versions_no_update BEFORE UPDATE ON terms_versions
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_TERMS_VERSIONS');
END;

CREATE TRIGGER trg_terms_versions_no_delete BEFORE DELETE ON terms_versions
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_TERMS_VERSIONS');
END;

CREATE TRIGGER trg_admin_audit_log_no_update BEFORE UPDATE ON admin_audit_log
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_ADMIN_AUDIT_LOG');
END;

CREATE TRIGGER trg_admin_audit_log_no_delete BEFORE DELETE ON admin_audit_log
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_ADMIN_AUDIT_LOG');
END;

CREATE TRIGGER trg_booking_status_history_no_update BEFORE UPDATE ON booking_status_history
WHEN NEW.id IS NOT OLD.id
  OR NEW.booking_id IS NOT OLD.booking_id
  OR NEW.from_status IS NOT OLD.from_status
  OR NEW.to_status IS NOT OLD.to_status
  OR NEW.note IS NOT OLD.note
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_STATUS_HISTORY');
END;

CREATE TRIGGER trg_booking_events_redact_only BEFORE UPDATE ON booking_events
WHEN NEW.id IS NOT OLD.id
  OR NEW.booking_id IS NOT OLD.booking_id
  OR NEW.actor IS NOT OLD.actor
  OR NEW.event IS NOT OLD.event
  OR NEW.subject_id IS NOT OLD.subject_id
  OR NEW.details IS NOT OLD.details
  OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.note IS NOT OLD.note AND NOT (NEW.note IS NULL AND NEW.redacted_at IS NOT NULL))
  OR (NEW.redacted_at IS NOT OLD.redacted_at AND OLD.redacted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_EVENTS');
END;
```

Why no application-level encryption of the IBAN: it is the business's own receiving account and is shown to every flow-2 customer after she accepts the terms; the risk is **integrity** (a swapped IBAN), not confidentiality. Integrity is covered by immutable revisions, re-auth, the audit log, the per-booking `bank_revision_id` snapshot and the 72-hour "bank details changed" alert (W2-01, W2-10), plus the 24-hour delayed activation of a changed IBAN (0008, §2.4).

### 2.3 Verification evidence (this planning run, scratch copy outside `app/`)
- **node:sqlite 3.53.0**, `PRAGMA foreign_keys=ON`, real files 0001 → 0003 → 0004 → 0005 → 0006, then 0007: applies; 25 tables, 22 indexes, 8 triggers. **56/56 behavioural checks pass**, including: second admin refused (insert and promote); every section-shape CHECK; stale (11 min) and future `reauth_at` refused; lowercase/23-char IBAN refused; control characters refused; UPDATE/DELETE on the three append-only tables abort; atomic `INSERT … SELECT 'v'||(MAX(seq)+1)` publishes v1, v2; the flow-2 approve UPDATE with the settings predicates (`? = MAX(deposit id)`, `EXISTS bank`, `EXISTS terms`) changes 1 row; accepting a stale terms version changes 0 rows; `bank_revision_id` without acceptance refused; deposit received > total or without timestamp refused; status-history note edit aborts while `changed_by → NULL` (FK action path) is allowed; `booking_events` details/note rewrite and un-redaction abort while redaction is allowed; pickup-with-area and delivery-without-area refused; an in-use delivery area cannot be deleted; unknown audit action, non-object or malformed `details` and a spaced `target_id` refused.
- **wrangler 4.124.0 local D1** (`d1 migrations apply --local` in a scratch project with the same 0001, 0003–0007 files): 0007 runs as **30 statements** (the `BEGIN … END` trigger bodies are split correctly); a multi-statement `d1 execute` whose third statement hits the trigger fails with `APPEND_ONLY_SETTINGS_REVISIONS … SQLITE_CONSTRAINT_TRIGGER` and **the whole batch rolls back** (0 users, 0 revisions afterwards).
- **11 of the plan's own runtime statements prepare** against 0001–0007 (search with `ESCAPE '\'`, targeted expiry history + update, capacity-guarded handover insert, queue deposit-notice and bank-mismatch queries, calendar month, current settings, timeline `UNION ALL`, customers directory with keyset, consent upsert). Executed: the capacity-1 slot accepts exactly one booking, and the same insert with another customer's uid inserts 0 rows (IDOR predicate holds).
- W1-01 re-runs all of this inside the repository (`tests/migrations.test.mjs`) and records it in `runs/redo-v2/d1/0007-0008-verification.md`.

### 2.4 DDL — `app/migrations/0008_golive_hardening.sql` (W1-01 commits exactly this)

```sql
-- 0008_golive_hardening.sql
-- Go-live hardening from 10-security-baseline (C-2, C-10, C-14), 13-threat-model (TM-03, TM-07, TM-08, TM-17)
-- and the plan reviews (B1, H3, L2, UX-06). EXPAND ONLY: ADD COLUMN, CREATE TABLE / INDEX / TRIGGER and
-- vocabulary INSERTs. Requires 0007. Instants are 'YYYY-MM-DDTHH:MM:SS.sssZ' (UTC).

-- 1. Vocabularies (the NOT IN keeps a re-run harmless; a CHECK failure still errors).
INSERT INTO event_kinds (kind)
SELECT column1 FROM (VALUES
  ('hold_reinstated'),
  ('terms_accepted_offline'),
  ('admin_whatsapp_sent'),
  ('admin_queue_dismissed')
)
WHERE column1 NOT IN (SELECT kind FROM event_kinds);

INSERT INTO admin_audit_actions (action)
SELECT column1 FROM (VALUES
  ('admin_promoted'),
  ('admin_demoted'),
  ('admin_sessions_revoked'),
  ('online_confirmation_switched')
)
WHERE column1 NOT IN (SELECT action FROM admin_audit_actions);

-- 2. users: an unverified token never owns users.email (C-2: the Worker writes email_verified_at only from a
--    verified token); instant session revocation (C-14 / TM-07: tokens whose auth_time is earlier are refused);
--    a marker for "phone or email changed" that the admin sees next to bookings created before it (TM-08).
ALTER TABLE users ADD COLUMN email_verified_at TEXT
  CHECK (email_verified_at IS NULL OR (length(email_verified_at) = 24 AND substr(email_verified_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', email_verified_at) IS email_verified_at));

ALTER TABLE users ADD COLUMN tokens_valid_after TEXT
  CHECK (tokens_valid_after IS NULL OR (length(tokens_valid_after) = 24 AND substr(tokens_valid_after, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', tokens_valid_after) IS tokens_valid_after));

ALTER TABLE users ADD COLUMN contact_changed_at TEXT
  CHECK (contact_changed_at IS NULL OR (length(contact_changed_at) = 24 AND substr(contact_changed_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', contact_changed_at) IS contact_changed_at));

-- 3. Delayed activation (TM-03): a bank or contact revision that replaces an existing one takes effect at
--    effective_at (created_at + 24 h) unless the token carried a second factor. NULL = effective at created_at.
--    Bounded to 24 h so the column cannot hide a far-future revision.
ALTER TABLE settings_revisions ADD COLUMN effective_at TEXT
  CHECK (
    effective_at IS NULL
    OR (
      section IN ('bank', 'contact')
      AND length(effective_at) = 24 AND substr(effective_at, 12, 2) < '24'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', effective_at) IS effective_at
      AND (julianday(effective_at) - julianday(created_at)) * 86400 BETWEEN 0 AND 86400.5
    )
  );

-- 4. Database kill switch for online confirmation (H3). Append-only; the switch is ON while no row exists.
--    Turning it off needs only the admin guard (a safety action); turning it on needs a recent sign-in.
CREATE TABLE ops_switch_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  switch_name TEXT NOT NULL CHECK (switch_name IN ('online_confirmation')),
  state TEXT NOT NULL CHECK (state IN ('on', 'off')),
  note TEXT
    CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 300 AND note NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  created_by TEXT NOT NULL
    REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reauth_at TEXT
    CHECK (reauth_at IS NULL OR (length(reauth_at) = 24 AND substr(reauth_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', reauth_at) IS reauth_at)),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (state = 'off' OR reauth_at IS NOT NULL),
  CHECK (reauth_at IS NULL OR (julianday(created_at) - julianday(reauth_at)) * 1440 BETWEEN 0 AND 10)
);

CREATE INDEX idx_ops_switch_revisions_name ON ops_switch_revisions(switch_name, id);

CREATE TRIGGER trg_ops_switch_revisions_no_update BEFORE UPDATE ON ops_switch_revisions
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_OPS_SWITCH_REVISIONS');
END;

CREATE TRIGGER trg_ops_switch_revisions_no_delete BEFORE DELETE ON ops_switch_revisions
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_OPS_SWITCH_REVISIONS');
END;

-- 5. CSP violation counts (C-10, TM-17): directive and blocked origin only, never a full URL.
CREATE TABLE csp_report_counts (
  day TEXT NOT NULL CHECK (length(day) = 10 AND date(day) IS day),
  directive TEXT NOT NULL CHECK (length(directive) BETWEEN 3 AND 40 AND directive NOT GLOB '*[^a-z-]*'),
  blocked_origin TEXT NOT NULL
    CHECK (length(blocked_origin) BETWEEN 1 AND 120 AND blocked_origin NOT GLOB '*[^a-z0-9.:/-]*'),
  count INTEGER NOT NULL CHECK (typeof(count) = 'integer' AND count BETWEEN 1 AND 1000000),
  PRIMARY KEY (day, directive, blocked_origin)
) WITHOUT ROWID;

-- 6. Evidence rows are never deleted (L2). No code path deletes booking_requests; these triggers also stop a
--    manual DELETE from cascading into the history.
CREATE TRIGGER trg_booking_status_history_no_delete BEFORE DELETE ON booking_status_history
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_STATUS_HISTORY');
END;

CREATE TRIGGER trg_booking_events_no_delete BEFORE DELETE ON booking_events
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_EVENTS');
END;
```

Why 0008 is a separate file: 0007 was verified byte-for-byte in rev. 1 and nothing in it changes. The baseline's C-2 proposed its own `0007_users_email_verified.sql`; that content lives here instead (D19).

### 2.5 Verification evidence for 0008 (rev. 2, scratch copy outside `app/`)
- **node:sqlite (SQLite 3.53.0)**, `PRAGMA foreign_keys=ON`, the real files 0001 → 0003 → 0004 → 0005 → 0006, then 0007 (extracted from §2.2) and 0008: applies; **27 tables, 23 indexes, 12 triggers** (0007 alone: 25 / 22 / 8). **42/42 behavioural checks pass**, including: the new vocabularies are present and a re-run of the vocabulary inserts is harmless; `email_verified_at` refuses the `CURRENT_TIMESTAMP` format; the admin predicate `lower(email)=lower(?) AND (tokens_valid_after IS NULL OR tokens_valid_after <= ?auth_time)` accepts a fresh token and refuses one issued before the revocation; a bank revision with SQL-stamped `created_at` and a stale (11 min) `reauth_at` is refused; the first bank revision is immediate, the second is pending for 24 h, the effective-revision query returns the first until then and the second after; re-saving the effective values supersedes the pending change at once; `effective_at` on a deposit row, more than 24 h ahead, or before `created_at` is refused; revisions stay append-only; the kill switch accepts "off" without re-auth, refuses "on" without or with a stale `reauth_at`, and is append-only; CSP counts upsert and refuse a full URL, an upper-case directive and an impossible date; DELETE on `booking_status_history`, on `booking_events`, and a DELETE of a booking that would cascade into them all abort, while event redaction still works; the notice-protected predicate (`json_extract(details,'$.holdExpiresAt') = hold_expires_at`) excludes the hold once a notice for the current deadline exists; the `extend_hold` compare-and-swap applies once and a stale second attempt changes 0 rows; `reinstate_hold` on a date held by another booking fails on `ux_booking_requests_blocking_event_date`; the open-request cap inside the INSERT admits the third open request and refuses the fourth; the capacity-decrease conditional UPDATE refuses to go below the scheduled count; the re-book count excludes the booking's own row.
- W1-01 re-runs all of this inside the repository as `tests/migrations.test.mjs` and runs `wrangler d1 migrations apply --local` (0008 is 14 statements) and records both in `runs/redo-v2/d1/0007-0008-verification.md`.

Preconditions on a real database (runbook §7.4 and §7.10): at most one `role='admin'` row (else `ux_users_single_admin` fails, by design, loudly); no `handovers` rows of method `delivery` (none can exist: no route writes them before this build). 0008 has no precondition beyond 0007.

---

## 3. API: new and changed endpoints

### 3.1 Conventions (unchanged from 07 §1 unless stated)
- Envelope: `{ "ok": true, … }` / `{ "ok": false, "error": { "code", "message" } }` via `worker/http.ts`; `Cache-Control: no-store`, `nosniff`; API responses also carry `Strict-Transport-Security` (C-9, W1-14).
- Auth models:
  - **CO** customer-owner: verified email; the dispatcher resolves ownership once (`WHERE id=? AND user_id=?`) and hands the handler an `OwnedBooking`; foreign and non-existent ids get the **same** `404 BOOKING_NOT_FOUND` body; handlers still bind `user_id = ?uid` in their own writes (TM-06).
  - **CO+R** customer-owner whose sign-in is ≤ 10 minutes old (`403 REAUTH_REQUIRED`), for consent grant, delivery handover booking and phone/email change (TM-08).
  - **CO+M** customer-owner whose sign-in is ≤ 12 h old, for private-media routes (C-18, Train B).
  - **AD** admin (`authorizeAdminRequest`): 401 `UNAUTHENTICATED` → 403 `EMAIL_NOT_VERIFIED` → 403 `FORBIDDEN` (not the admin, or stored `users.email` ≠ token email) → 403 `REAUTH_REQUIRED` (sign-in older than 12 h, or issued before `users.tokens_valid_after`) (C-1, TM-02, TM-07).
  - **AD+R** admin with a sign-in ≤ 10 min old (`403 REAUTH_REQUIRED`).
  - **AD+S** settings-sensitive: AD+R, plus the second-factor claim when `ADMIN_SETTINGS_2F === "required"` (`403 SECOND_FACTOR_REQUIRED`); without it, bank and contact changes to an existing revision are delayed 24 h (TM-03).
  - **AD+2F** admin whose token carries a second factor (private-media admin routes only).
  - **SU** signed URL. **PUB** none.
- Bodies: `readJsonBody` exact key sets (unknown/missing key → `400 INVALID_REQUEST_BODY`), UTF-8 byte caps, code-point limits equal to the DB CHECKs. **Every free-text field** goes through `normalizeFreeText` (SB-16), **every admin-authored customer-visible text** through `findPaymentInstructionLike` (SB-17), and digits through `toAsciiDigits` before validation (UX-07). Multipart only for uploads (`Content-Length` required).
- Gates: rows marked **G** answer `503 SERVICE_UNAVAILABLE` from the dispatcher while private media is closed (§4). Rows marked **OC** answer 503 while effective online confirmation is off (env var ∧ D1 switch). On the preview Worker with `PREVIEW_READ_ONLY="on"`, every non-GET `/api/*` except `/api/csp-report` answers `403 PREVIEW_READ_ONLY` (C-8).
- Rate limits (TM-11, SEC-03). The Cloudflare `ratelimits` binding accepts only 10 s or 60 s periods, so it carries the **bursts**; longer windows are **atomic SQL caps over rows that already exist**, inside the writing statement. The binding is fail-open (a missing binding allows the request and logs `code=RL_BINDING_MISSING`); the SQL caps are the hard bound. Over a limit → `429 RATE_LIMITED` with `Retry-After`.

| Route class | Burst (binding, 60 s, key) | Hard cap (inside the statement) |
|---|---|---|
| `POST /api/bookings` | `RL_BOOKING` 3, uid | ≤ 3 open requests per account (`409 OPEN_REQUEST_LIMIT`); ≤ 5 created in the last hour (`429`); event date between today and today + 730 days, Riyadh (`400 DATE_BEYOND_HORIZON`) |
| `PUT /api/profile` | `RL_PROFILE` 3, uid | — (idempotent upsert) |
| Customer writes #3, #4, #7, #8, #11, #12, #14 | `RL_CUSTOMER_WRITE` 10, uid | event-profile and consent events only when the value changes; consent changes ≤ 10 per booking per day; one notice per deadline |
| Receipt upload #5 (Train B) | `RL_UPLOAD` 2, uid | ≤ 6 receipts per booking per hour; `attempt_no` ≤ 10 (DB) |
| `GET /api/availability` | `RL_AVAILABILITY` 60, IP | response edge-cached 60 s |
| `POST /api/csp-report` | `RL_CSP_REPORT` 30, IP | ≤ 200 count rows per day |
| Admin reads | `RL_ADMIN_READ` 100, uid | — |

- New error codes and Arabic messages (fixed strings, feminine address; all new strings go to the copy reviewer against `08-copy-ar.md`):

| Code | HTTP | Message |
|---|---|---|
| `REAUTH_REQUIRED` | 403 | «لحماية الحساب، أعيدي إدخال كلمة المرور لإتمام هذا الإجراء.» (admin and customer) |
| `SECOND_FACTOR_REQUIRED` | 403 | «هذا الإجراء يتطلب التحقق بخطوتين لحساب الإدارة.» |
| `LEGACY_FLOW_NOT_SUPPORTED` | 409 | «يُستكمل هذا الحجز بالتواصل مع الاستوديو عبر واتساب.» |
| `CONFIRMATION_NOT_AVAILABLE` | 409 | «خطوة تأكيد الحجز غير متاحة لهذا الطلب حاليًا.» |
| `TERMS_VERSION_MISMATCH` | 409 | «تم تحديث شروط الحجز. راجعي النسخة الحالية ثم وافقي عليها.» |
| `TERMS_NOT_ACCEPTED` | 409 | «لم تتم الموافقة على شروط الحجز بعد.» |
| `HOLD_EXPIRED` | 409 | «انتهت مهلة الحجز المؤقت لهذا التاريخ. تواصلي معنا عبر واتساب إن رغبتِ في المتابعة.» (ADR §2.1 verbatim) |
| `HOLD_BEYOND_EVENT` | 409 | «لا يمكن تمديد المهلة إلى ما بعد بداية يوم المناسبة.» |
| `HOLD_NOT_OVERDUE` | 409 | «لم تنتهِ مهلة هذا الحجز بعد.» |
| `GRACE_PERIOD_OVER` | 409 | «انتهت فترة السماح لهذا الحجز.» |
| `DATE_NOT_FREE` | 409 | «هذا التاريخ محجوز لطلب آخر.» |
| `SETTINGS_CHANGED` | 409 | «تغيّرت إعدادات العربون أثناء الاعتماد. أعيدي المحاولة.» |
| `TERMS_VERSION_CONFLICT` | 409 | «نُشرت نسخة أحدث من الشروط. حدّثي الصفحة ثم أعيدي المحاولة.» |
| `INVALID_IBAN` | 400 | «رقم الآيبان غير صحيح. يجب أن يبدأ بـ SA ويتكون من 24 خانة.» |
| `INVALID_PHONE` | 400 | «رقم الواتساب غير صحيح.» |
| `INVALID_TEXT` | 400 | «يحتوي النص على رموز غير مسموح بها.» |
| `CONTENT_NOT_ALLOWED` | 400 | «لا يمكن أن يتضمن هذا النص أرقام حسابات أو روابط أو أرقام هواتف.» |
| `NOTE_REQUIRED` | 400 | «يرجى كتابة سبب مختصر.» |
| `DEPOSIT_AMOUNT_REQUIRED` | 400 | «أدخلي مبلغ العربون المستلم.» |
| `NO_PENDING_RECEIPT` | 409 | «لا يوجد إيصال بانتظار المراجعة.» |
| `EVENT_DATE_PASSED` / `EVENT_NOT_YET_HELD` | 409 | «انتهى موعد تعديل تفاصيل المناسبة.» / «لم يحن موعد المناسبة بعد.» |
| `NOT_READY_FOR_HANDOVER`, `SLOT_UNAVAILABLE`, `ALREADY_BOOKED`, `DELIVERY_AREA_UNAVAILABLE`, `DELIVERY_ADDRESS_REQUIRED` | 409/400 | 07 §3.G copy; «هذا الموعد لم يعد متاحًا، يرجى اختيار موعد آخر.» reused |
| `NOT_YET_HANDED_OVER`, `FEEDBACK_ALREADY_SUBMITTED` | 409 | 07 §3.H |
| `INVALID_SEARCH` | 400 | «نص البحث غير صالح.» |
| `EXPORT_TOO_LARGE` | 400 | «نطاق التصدير كبير جدًا. اختاري فترة أقصر.» |
| `RATE_LIMITED` | 429 | «طلبات كثيرة خلال وقت قصير. حاولي مرة أخرى بعد قليل.» |
| `OPEN_REQUEST_LIMIT` | 409 | «لديكِ ثلاثة طلبات مفتوحة. انتظري الرد عليها قبل إرسال طلب جديد.» |
| `DATE_BEYOND_HORIZON` | 400 | «يمكن الحجز لمدة أقصاها سنتان من اليوم.» |
| `PREVIEW_READ_ONLY` | 403 | «هذه نسخة للعرض فقط ولا تقبل التعديلات.» |

### 3.2 Endpoint table (all additive; no existing path, method or field meaning changes)

| # | Method | Path | Auth | Gate | Unit |
|---|---|---|---|---|---|
| 1 | GET | `/api/bookings/me` (CHANGED: per-booking `termsAcceptedAt`, `stageUpdatedAt`, sub-states `awaiting_deposit`, `deposit_reported`; top-level `studio`) | CO (list) | – | W2-16 |
| 2 | GET | `/api/bookings/{id}/confirmation` | CO | OC | W2-13 |
| 3 | POST | `/api/bookings/{id}/confirmation/accept-terms` | CO | OC | W2-13 |
| 4 | POST | `/api/bookings/{id}/confirmation/whatsapp-notice` | CO | OC | W2-13 |
| 5 | POST | `/api/bookings/{id}/receipt` (multipart) | CO+M | G+OC | W9-02 |
| 6 | GET | `/api/bookings/{id}/event-profile` | CO | – | W2-06 |
| 7 | PUT | `/api/bookings/{id}/event-profile` | CO | – | W2-06 |
| 8 | PUT | `/api/bookings/{id}/consent` | CO (grant: CO+R) | – | W2-06 |
| 9 | GET | `/api/bookings/{id}/handover` | CO | – | W3-01 |
| 10 | GET | `/api/bookings/{id}/handover/slots` | CO | – | W3-01 |
| 11 | POST | `/api/bookings/{id}/handover` | CO (delivery: CO+R) | – | W3-01 |
| 12 | GET / POST | `/api/bookings/{id}/feedback` | CO | – | W2-09 |
| 13 | GET | `/api/bookings/{id}/gallery`, `…/gallery/photos` | CO+M | G | W10-02 |
| 14 | POST | `/api/bookings/{id}/gallery/selection`, `…/gallery/submit` | CO+M (submit: CO+R) | G | W10-02 |
| 15 | GET | `/api/media/{key}?e=&s=` | SU | G | W9-01 |
| 16 | GET | `/api/admin/bookings` (CHANGED: `customerId`; summary `flowVersion`, `stage`, `stageLabel`, `stageDeadline`; **no `q`**, see #41) | AD | – | W3-02 |
| 17 | GET | `/api/admin/bookings/{id}` (CHANGED: flow, deposit, terms, snapshots, `approvalPreview`, `features`, `customerContactChangedSinceBooking`, `consent`) | AD | – | W2-02, W3-02 |
| 18 | POST | `/api/admin/bookings/{id}/actions` (CHANGED: `extend_hold`, `expire_hold`, `reinstate_hold`, `confirm_offline`, `reject_receipt`; keys `extendHours`, `depositAmount`) | AD (`confirm_offline`: AD+R) | – | W2-02 |
| 19 | PATCH | `/api/admin/bookings/{id}/notes` (unchanged contract; also writes `internal_notes_updated`) | AD | – | W2-02 |
| 20 | GET | `/api/admin/bookings/{id}/timeline` | AD | – | W2-05 |
| 21 | POST | `/api/admin/bookings/{id}/contact-log` (body gains `outcome`) | AD | – | W2-05 |
| 22 | GET | `/api/admin/bookings/{id}/event-profile` | AD | – | W2-06 |
| 23 | GET / PUT | `/api/admin/bookings/{id}/production` | AD | – | W2-07 |
| 24 | GET / PATCH | `/api/admin/bookings/{id}/handover` | AD | – | W2-08 |
| 25 | GET | `/api/admin/bookings/{id}/feedback` | AD | – | W2-09 |
| 26 | GET | `/api/admin/bookings/{id}/receipts` | AD+2F | G | W10-01 |
| 27 | * | `/api/admin/bookings/{id}/gallery…` (07 §3.E.1–3.E.7) | AD+2F | G | W9-03 |
| 28 | GET / POST | `/api/admin/handover-slots`; POST `…/generate`; PATCH / DELETE `…/{slotId}` | AD | – | W2-08 |
| 29 | GET | `/api/admin/settings` (adds `pending`, `killSwitch`, `settings2f`) | AD | – | W2-01 |
| 30 | PUT | `/api/admin/settings/deposit`, `…/bank`, `…/contact` | AD+S | – | W2-01 |
| 31 | PUT | `/api/admin/settings/pickup` (now AD+R + content rules) | AD+R | – | W2-01 |
| 32 | GET / POST | `/api/admin/settings/terms` (POST = publish) | AD (POST: AD+S) | – | W2-01 |
| 33 | GET | `/api/admin/settings/history?section=` | AD | – | W2-01 |
| 34 | GET / POST / PATCH | `/api/admin/settings/delivery-areas[/{areaId}]` (content rules on names) | AD | – | W2-01 |
| 35 | GET | `/api/admin/queue` | AD | – | W2-10 |
| 36 | GET | `/api/admin/calendar?month=YYYY-MM` | AD | – | W2-11 |
| 37 | GET | `/api/admin/customers`, `/api/admin/customers/{customerId}` (no `q`, see #42) | AD | – | W2-11 |
| 38 | GET | `/api/admin/exports/bookings.csv` | AD+R | – | W2-12 |
| 39 | GET | `/api/admin/audit-log` | AD | – | W2-05 |
| 40 | GET | `/api/admin/session` (adds `sessionFreshUntil`, `idleMinutes`) | AD | – | W2-05 |
| 41 | POST | `/api/admin/search/bookings` | AD | – | W3-02 |
| 42 | POST | `/api/admin/search/customers` | AD | – | W3-02 |
| 43 | PUT | `/api/admin/settings/switch` | AD (to off) / AD+R (to on) | – | W2-01 |
| 44 | POST | `/api/admin/session/revoke-all` | AD+R | – | W2-05 |
| 45 | POST | `/api/csp-report` | PUB | – | W2-17 |
| 46 | POST | `/api/bookings` (CHANGED: caps, horizon, burst limit, email re-sync; new codes only) | verified customer | – | W3-15 |
| 47 | PUT | `/api/profile` (CHANGED: verified-email ownership, CO+R for phone/email change on an existing row, `410` when erased, text validator) | token | – | W2-15 |
| 48 | GET | `/api/availability` (CHANGED: 60 s edge cache, IP burst limit) | PUB | – | W2-17 |

W1-04 adds these admin namespaces to `adminPortalNamespaces`: `^/api/admin/(settings|calendar|customers|exports|audit-log|session|search)(?:/.*)?$` (the booking sub-resource, `handover-slots` and `queue` patterns already exist). No open path above contains a private-media word (checked against `PRIVATE_MEDIA_SEGMENTS` **as extended by TM-10**: `confirmation`, `accept-terms`, `whatsapp-notice`, `event-profile`, `consent`, `handover`, `slots`, `feedback`, `timeline`, `contact-log`, `production`, `settings`, `deposit`, `bank`, `contact`, `pickup`, `terms`, `history`, `delivery-areas`, `switch`, `queue`, `calendar`, `customers`, `exports`, `bookings.csv`, `audit-log`, `session`, `revoke-all`, `search`, `generate`, `csp-report`, `availability`, `profile`).

### 3.3 Contracts

**#1 `GET /api/bookings/me` (changed, additive).** Per booking add `termsAcceptedAt: string|null` and `stageUpdatedAt: string|null` (the time of the last status change or stage event that defines the current stage, e.g. `album_stage_changed`; UX-14). `stageSubState` may now be `"awaiting_deposit"` (flow 2, `approved_hold`, terms accepted, no notice for the current deadline) or `"deposit_reported"` (the same with a `deposit_notice_sent` event for the current deadline; UX-02). Top level add `"studio": { "whatsappNumber": "9665XXXXXXXX", "whatsappNumberChangedAt": null | "…Z" }` from the **effective** contact revision, else the compiled fallback in `src/lib/whatsapp.ts`; `whatsappNumberChangedAt` is set only when an earlier contact revision exists and the change is at most 72 h old (TM-03/TM-19). Existing clients ignore unknown fields (07 §3.A).

**#2 `GET /api/bookings/{id}/confirmation` (CO, OC).** Allowed statuses: flow 2 `approved_hold`, `payment_pending`, `confirmed`.
```json
{ "ok": true,
  "booking": { "id": "…", "status": "approved_hold", "flowVersion": 2, "eventDate": "2026-11-20",
    "holdExpiresAt": "…Z", "estimatedTotal": 6500, "depositAmount": 1300,
    "termsVersion": null, "termsAcceptedAt": null, "depositReceivedAmount": null, "depositReceivedAt": null },
  "terms": { "version": "v2", "body": "…plain text…", "publishedAt": "…Z" },
  "acceptedTerms": null,
  "bankDetails": null,
  "bankDetailsChangedSinceAcceptance": false,
  "receiptChannel": "whatsapp",
  "notice": null,
  "receipts": [],
  "studio": { "whatsappNumber": "9665XXXXXXXX", "whatsappNumberChangedAt": null },
  "serverTime": "…Z" }
```
- `bankDetails` (`{bankName, accountHolder, iban, updatedAt}`, the **effective** revision; `iban` normalised without spaces so the client copies exactly 24 characters) is returned only after she accepted the terms and only while `approved_hold`/`payment_pending`. A pending (not yet effective) bank revision is never returned (TM-03).
- `bankDetailsChangedSinceAcceptance: true` → the client shows the details only under the changed-bank warning (UX-08/TM-16).
- `acceptedTerms` (`{version, bodySha256, body}`) is the exact version she accepted, read-only, even after a newer version exists (TM-18).
- `notice` (`{sentAt, holdProtected: true}`) reflects a `deposit_notice_sent` event for the current deadline.
- `receipts` (status, dates, rejection reason, never a URL) only when `receiptChannel = "upload"`.
- Errors: 401, 403 `EMAIL_NOT_VERIFIED`, 404 `BOOKING_NOT_FOUND`, 405, 409 `LEGACY_FLOW_NOT_SUPPORTED`, 409 `CONFIRMATION_NOT_AVAILABLE`, 503, 500.

**#3 `POST …/confirmation/accept-terms` (CO, OC).** Body `{ "termsVersion": "v2" }` (≤ 256 B). One batch: `UPDATE booking_requests SET terms_version=(current), terms_accepted_at=?now, bank_revision_id=(effective bank), updated_at=?now WHERE id=? AND user_id=?uid AND flow_version=2 AND status='approved_hold' AND hold_expires_at > ?now AND terms_accepted_at IS NULL AND ?termsVersion = (current)` + `booking_events('terms_accepted', details {"termsVersion":"v2","bodySha256":"…"})` guarded by `CASE WHEN changes()=1`. Response `200 { "booking": { "termsVersion", "termsAcceptedAt" }, "bankDetails": {…} }`. Already accepted (same version) → `200` unchanged (idempotent). Errors: 400, 404, 409 `TERMS_VERSION_MISMATCH` / `HOLD_EXPIRED` / `INVALID_STATUS_TRANSITION` / `LEGACY_FLOW_NOT_SUPPORTED`, 429, 503.

**#4 `POST …/confirmation/whatsapp-notice` (CO, OC).** Body `{ "channel": "whatsapp" }`. Records `booking_events('deposit_notice_sent', details {"holdExpiresAt": …})` once per hold deadline (`NOT EXISTS` for the same deadline). It **never changes the status or the deadline**, but a notice for the current deadline **protects the hold**: the cron and the approve path's targeted sweep skip it, and the queue lists it under `decide_now` (B1, UX-02). Accepted while `approved_hold`, terms accepted, and `now < hold_expires_at + HOLD_GRACE_HOURS`. Response `200 { "noticeRecordedAt": "…Z", "holdProtected": true }`. Errors: 409 `TERMS_NOT_ACCEPTED`, 409 `HOLD_EXPIRED`, 404, 429, 503. The client fires it with `keepalive` from the same click that opens `wa.me` (the link is a real `<a>`, so no popup blocker interferes).

**#5 `POST /api/bookings/{id}/receipt` (CO+M, G; Train B).** Multipart, exactly one part `file` (≤ 5 MiB; request cap 5,275,648 B); markup (`<`, BOM + `<`) refused before sniffing; JPEG/PNG/WebP/PDF by magic bytes; images must end with their end marker with ≤ 1 KiB of trailing bytes and be ≤ 8,000 px per side and ≤ 40 MP; JPEG/PNG/WebP metadata stripped server-side before storage; the sniffed type is stored and served; client type ignored; requires terms accepted. Stores `r/<bookingId>/<receiptId>`, `media_objects` row, `booking_receipts(pending, content_sha256)`, status `approved_hold → payment_pending` (or a re-upload after `rejected`), `booking_events('receipt_submitted'|'receipt_resubmitted')` with ids only, outbox `receipt_submitted_admin`; R2 object deleted if the batch fails. `200 { "booking": {…}, "receipt": { "id", "status": "pending", "uploadedAt" } }`. Errors: 07 §3.B.2 list + 409 `TERMS_NOT_ACCEPTED` + 429 (TM-09, TM-11).

**#6/#7/#8 Event profile and consent (CO).**
- `GET` → `{ "eventProfile": null | { "venueName", "venueArea", "startTime", "specialRequests", "updatedAt" }, "consent": { "publishPhotos": { "granted": false, "textVersion": "consent-v1", "updatedAt": null } }, "editable": true, "eventDate": "…" }`.
- `PUT event-profile` body (all keys required, nullable): `{ "venueName", "venueArea", "startTime", "specialRequests" }`; caps 120/120/`HH:MM`/1000 (0005) and the shared text validator. Allowed while `confirmed` and the Riyadh date key of today ≤ `event_date`. Upsert + `booking_events('event_profile_saved')` **only when a value changed** (TM-11). Errors: 400 `FIELD_TOO_LONG`/`INVALID_TIME_FORMAT`/`INVALID_TEXT`, 409 `BOOKING_NOT_CONFIRMED`/`EVENT_DATE_PASSED`, 429.
- `PUT consent` body `{ "purpose": "publish_photos", "granted": false, "textVersion": "consent-v1" }`. Allowed for `confirmed` bookings at any time; **granting requires CO+R** (sign-in ≤ 10 min, TM-08); withdrawal never does and is never time-limited. Upsert into `booking_consents` only when the value changes + `consent_granted`/`consent_withdrawn` event; at most 10 changes per booking per day (SQL count of the consent events). Errors: 403 `REAUTH_REQUIRED` (grant), 409 `BOOKING_NOT_CONFIRMED`, 409 `CONSENT_TEXT_OUTDATED`, 429.

**#9–#11 Handover (CO).**
- `GET handover` → `{ "handover": null | { "method", "slot": { "id", "startsAt", "endsAt" }, "delivery": null | { "areaName", "fee", "district", "street", "landmark" }, "status", "completedAt" }, "options": { "pickup": null | { "address", "instructions" }, "deliveryAreas": [ { "id", "name", "fee" } ] }, "bookable": true }`. `bookable` = confirmed and album `ready` and no active handover. Pickup text and area names are rendered as plain text by the client (no autolink).
- `GET handover/slots?method=pickup|delivery&from=&to=` (default today..+30 d, max 92 d, Riyadh date keys) → active, future, method-compatible, **not full** slots only; capacity numbers are not exposed.
- `POST handover` body `{ "slotId", "method": "pickup" }` or `{ "slotId", "method": "delivery", "deliveryAreaId", "district", "street", "landmark" }` (`landmark` nullable; 80/160/160 code points; text validator). **Delivery requires CO+R** (TM-08). One conditional `INSERT … SELECT` with the ownership, confirmed, album-ready, slot active/future/method, `COUNT(scheduled) < capacity` **and `delivery_areas.is_active = 1`** predicates (TM-06); after `no_show`/`cancelled` the same request re-books with a conditional `UPDATE` whose capacity count **excludes the booking's own row** (TM-15). Snapshots area name → `delivery_city`, area id + fee. `201` / `200` (idempotent same slot). Errors: 400 `DELIVERY_ADDRESS_REQUIRED`/`INVALID_TEXT`, 403 `REAUTH_REQUIRED` (delivery), 404 `SLOT_NOT_FOUND`, 409 `NOT_READY_FOR_HANDOVER` / `SLOT_UNAVAILABLE` / `ALREADY_BOOKED` / `DELIVERY_AREA_UNAVAILABLE`, 429.
- Self-service reschedule (HND-07) is not built; the admin reassigns (#24).

**#12 Feedback (CO).** As 07 §3.H (`rating` 1–5, `comment` ≤ 1000 nullable and text-validated, compare-on-retry, `409 NOT_YET_HANDED_OVER`), plus `booking_events('feedback_submitted')`.

**#13/#14/#27 Gallery (G; Train B).** As 07 §3.E with the 0005 schema (quota snapshot 30/45/60/80 or coverage default 30 or admin 1–500; set-ops selection with the quota predicate; submit requires exactly the quota; admin export of filenames in `sort_order`; the export also writes `admin_audit_log('gallery_selection_exported')`). The gallery id always comes from the owned booking; photo ids are validated through `(gallery_id, photo_id)` (TM-06). Customer routes need CO+M; submit (irreversible) needs CO+R. Admin routes additionally require a second factor. Gallery uploads are refused if they carry metadata or exceed 4,096 px per side (TM-09).

**#15 `/api/media/{key}` (SU, G; Train B).** As 07 §3.C, with TM-09: MAC over `v1|<key>|<e>` verified **before** any D1 or R2 call; lifetime ≤ 3,600 s for customers and ≤ 600 s for the admin; `media_objects` row with `deleted_at IS NULL` required on every GET; headers `Content-Security-Policy: default-src 'none'; img-src 'self'; sandbox`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Content-Disposition` with a generated ASCII filename, `Cache-Control: private, max-age=min(remaining, lifetime)`. 503 when `getMediaBucket(env)` returns null (TM-10) or `MEDIA_SIGNING_KEY` is shorter than 32 bytes; optional `MEDIA_SIGNING_KEY_PREVIOUS` accepted for 2 h after rotation.

**#16 `GET /api/admin/bookings` (changed).** New optional query `customerId` and summary fields `flowVersion`, `stage`, `stageLabel`, `stageDeadline`. Existing `status`, `from`, `to`, `limit`, `cursor` keep their meaning. **Free-text search is not a query parameter** (TM-17): it is #41.

**#17 `GET /api/admin/bookings/{id}` (changed).** Adds `flowVersion`, `depositAmount`, `termsVersion`, `termsAcceptedAt`, `bankRevisionId`, `bankDetailsCurrent` (bool, against the effective revision), `depositReceivedAmount`, `depositReceivedAt`, `completedAt`, `latestReceiptStatus`, `stage`, `stageLabel`, `stageSubState`, `stageDeadline`, `noticeProtected` (bool), `customerContactChangedSinceBooking` (bool, `users.contact_changed_at > created_at`; TM-08), `consent: { publishPhotos: { granted, grantedAt } }`, `approvalPreview` (for `pending_review`: `{ "flowVersion": 2, "depositAmount": 1300, "holdHours": 48 } | { "flowVersion": 1, "reason": "SETTINGS_INCOMPLETE" | "SWITCH_OFF" | "KILL_SWITCH" | "EVENT_TOO_SOON" | "EVENT_PASSED" }`) and `features: { "onlineConfirmationOffered", "privateMedia", "holdAutoExpiry" }`. `allowedActions` becomes flow-aware; old admin bundles ignore action names they do not know (L1, W1-07).

**#18 `POST …/actions` (changed).** Allowed keys widen to `{action, note, extendHours, depositAmount}`; a key not valid for the action → 400. Flow-1 rows: exactly today's map (N-29). Flow 2 (G = `HOLD_GRACE_HOURS` = 72 h; "event start" = `riyadhStartOfDay(event_date)`):

| Status (flow 2) | Actions |
|---|---|
| `pending_review` | `approve` (flow 2 if offered, else legacy), `reject` |
| `approved_hold`, terms not accepted | `extend_hold`, `confirm_offline` (AD+R), `cancel`; `expire_hold` once the deadline has passed |
| `approved_hold`, terms accepted | `confirm_payment` (`depositAmount` required 1..total; below the snapshot → `note` required), `extend_hold`, `cancel`; `expire_hold` once the deadline has passed |
| `payment_pending`, latest receipt `pending` (Train B) | `confirm_payment` (verifies the receipt in the same batch; `depositAmount` optional, default snapshot), `reject_receipt` (`note` required and content-checked; hold = max(hold, now) + `extendHours` default 24), `cancel` |
| `payment_pending`, latest receipt `rejected` (Train B) | `extend_hold`, `cancel` |
| `expired` (flow 2, event not started) | `reinstate_hold` |
| `confirmed` | `cancel` |

- `approve` (flow 2): offered only when effective online confirmation is on (env var ∧ D1 switch) AND deposit, bank and terms exist AND the event date ≥ today + 3 (Riyadh); never for a past date (SEC-19 → `EVENT_PASSED`, legacy approve refused too). One batch: targeted expiry of stale flow-2 holds on the same date, **excluding notice-protected holds and, while automatic expiry is off (no email provider or switch off), all flow-2 holds** (history `INSERT … SELECT` then `UPDATE`, both binding the same `?now`), then `UPDATE … SET status='approved_hold', flow_version=2, deposit_amount=?, deposit_rule_revision_id=?, hold_expires_at=min(now+48 h, event start) WHERE … AND ?ruleId=(effective deposit id) AND EXISTS effective bank AND EXISTS terms` + the existing history guard. If a protected hold still occupies the date, the unique index refuses the approval → `409 DATE_NOT_FREE`. A predicate miss after the pre-read → `409 SETTINGS_CHANGED`.
- `extend_hold`: `extendHours` 1–168 (default 24); a compare-and-swap on `status='approved_hold'` and the exact `hold_expires_at` the handler read (TM-15); allowed until deadline + G (`409 GRACE_PERIOD_OVER` after); the new deadline = max(old, now) + hours and must be before the event start (`409 HOLD_BEYOND_EVENT`); writes `booking_events('hold_extended')` + outbox `hold_extended`.
- `expire_hold` (new, B1 #4): `approved_hold` with `hold_expires_at ≤ now` → `expired` (history + `booking_events('hold_expired', actor admin)`); before the deadline → `409 HOLD_NOT_OVERDUE`.
- `reinstate_hold` (new, B1 #3): `expired` flow-2 row whose event has not started → `approved_hold` with a fresh deadline min(now + 48 h, event start); the partial unique index guarantees the date is still free (`409 DATE_NOT_FREE` otherwise); `booking_events('hold_reinstated')`.
- `confirm_payment` (flow 2): allowed while `approved_hold` (terms accepted) up to deadline + G, or on `payment_pending`; sets `confirmed`, `confirmed_at`, `deposit_received_amount/at`; `booking_events('deposit_recorded', {"amount", "channel": "whatsapp"|"upload"})` (+ `receipt_verified` on the receipt path). The UI states that notices, receipts and hash matches are not proof; the amount is the one seen in the bank statement (TM-20).
- `confirm_offline` (new, H3; AD+R): flow-2 `approved_hold`, terms **not** accepted online; `note` (≥ 10 code points, content-checked) and `depositAmount` required; sets `terms_version` = current, `terms_accepted_at` = now, `confirmed`, the deposit columns; events `terms_accepted_offline` (details `{"termsVersion","bodySha256"}`) and `deposit_recorded` (`channel: "offline"`).
- Status emails are skipped when the status did not change (fixes the `admin.ts:1171` key collision). Flow-2 approvals use the new copy of W2-04 stating the deadline.

**#20 `GET …/timeline` (AD).** Newest first, ≤ 300 entries, merging `booking_status_history` (from, to, by, note), `booking_events` (actor, event, details via the key whitelist, note unless redacted) and `notification_log` (kind, status, created/finished — never recipient or payload). `{ "entries": [ { "source": "status"|"event"|"notification", "at", … } ] }`.

**#21 `POST …/contact-log` (AD).** Body `{ "template": "<template id>", "outcome": "opened" | "sent" | "dismissed" }` (template ids from W2-14's closed list). Writes `booking_events('admin_whatsapp_opened' | 'admin_whatsapp_sent' | 'admin_queue_dismissed', {"template"})`. `opened` is sent with `keepalive` from the WhatsApp click and never blocks opening WhatsApp; **opening does not remove the item from the queue**: only `sent`, `dismissed` or a state change does (UX-06).

**#23 `PUT …/production` (AD).** Body `{ "stage": "design"|"printing"|"ready" }`. Upserts `album_production` (booking `confirmed`, event day passed in Riyadh, else `409 EVENT_NOT_YET_HELD`) + `booking_events('album_stage_changed', {"from","to"})`; moving to `ready` queues `album_ready` once (dedupe `album_ready:<id>:once`) when email is configured. `GET` returns `{ "production": null | { "stage", "updatedAt" } }`.

**#24 `PATCH …/handover` (AD).** Body `{ "action": "complete" | "no_show" | "cancel" }` or `{ "action": "reassign", "slotId" }`. `complete` stamps `handovers.completed_at` and `booking_requests.completed_at` in one batch (+ `handover_completed`, `booking_completed` events); repeat is a no-op. `reassign` uses the same capacity predicate inside the UPDATE, excluding the booking's own row (+ `handover_rescheduled`).

**#28 Handover slots (AD).** `GET ?from&to` (≤ 92 d) with `bookedCount`; `POST { "startsAt", "endsAt", "method", "capacity" }` (`UNIQUE(starts_at, method)` → `409 SLOT_ALREADY_EXISTS`); `POST /generate { "fromDate", "toDate", "weekdays": [0..6], "times": [ { "start": "16:00", "end": "17:00" } ], "method", "capacity" }` → ≤ 200 slots per call, Riyadh local times converted with `riyadhLocalToInstant` (W1-10), duplicates skipped, returns `{ "created", "skipped" }`; `PATCH /{slotId} { "capacity"?, "isActive"? }`: a capacity decrease is one conditional `UPDATE … WHERE ? >= (SELECT COUNT(*) … 'scheduled')` (0 rows → `409 CAPACITY_BELOW_BOOKED`); deactivation is refused while scheduled handovers exist (`409 SLOT_HAS_BOOKINGS`, TM-15); `DELETE /{slotId}` only if never referenced (else `409 SLOT_HAS_BOOKINGS`). Every write → `admin_audit_log`.

**#29 `GET /api/admin/settings` (AD).**
```json
{ "ok": true,
  "settings": {
    "deposit": null | { "revisionId": 3, "kind": "percent", "percent": 20, "fixedAmount": null, "roundTo": 50, "updatedAt": "…Z" },
    "bank": null | { "revisionId": 4, "bankName": "…", "accountHolder": "…", "iban": "SA…", "updatedAt": "…Z" },
    "contact": null | { "revisionId": 5, "whatsappNumber": "9665…", "updatedAt": "…Z" },
    "pickup": null | { "revisionId": 6, "address": "…", "instructions": null, "updatedAt": "…Z" },
    "terms": null | { "version": "v2", "publishedAt": "…Z", "bodySha256": "…" },
    "deliveryAreas": [ { "id", "name", "fee", "isActive", "sortOrder" } ] },
  "pending": { "bank": null | { "revisionId": 7, "effectiveAt": "…Z" }, "contact": null },
  "features": {
    "onlineConfirmation": { "switchOn": true, "killSwitch": "on", "settingsComplete": false, "missing": ["bank", "terms"], "offered": false },
    "privateMedia": { "allowed": false, "blockers": ["PDPL_SIGNOFF_REF", "MEDIA_BINDING", "MEDIA_SIGNING_KEY"] },
    "email": { "configured": false },
    "holdAutoExpiry": false,
    "settings2f": { "required": false },
    "retentionPurge": { "enabled": false } },
  "recentSensitiveChanges": [ { "section": "bank", "revisionId": 4, "at": "…Z" } ],
  "serverTime": "…Z" }
```
`settings.*` are the **effective** revisions. `pending` lists changes saved but not yet effective (TM-03). `recentSensitiveChanges` = bank/contact/deposit/terms/switch changes in the last 72 h (fraud visibility banner). `privateMedia.blockers` may also contain `ADMIN_MFA_DISABLED` (TM-21).

**#30–#34, #43 Settings writes.** All write the revision and an `admin_audit_log` row in **one batch**, with `created_at` stamped by SQL (M1); saving values identical to the effective revision with nothing pending returns `200 { "unchanged": true }` without a new row. Each bank/contact/deposit/terms/switch change also sends a direct alert email to `ADMIN_NOTIFICATION_EMAIL` when email is configured (section, time and "if this was not you" steps only; never the values; H2).
- `PUT deposit` (AD+S): `{ "kind": "fixed", "fixedAmount": 1000, "roundTo": 1 }` or `{ "kind": "percent", "percent": 20, "roundTo": 50 }` (exact key set per kind).
- `PUT bank` (AD+S): `{ "bankName", "accountHolder", "iban" }`; IBAN normalised (Arabic-Indic digits converted, spaces removed, upper-case), `SA` + 22, ISO 13616 mod-97 = 1 → else `400 INVALID_IBAN`; names through the text validator. **Delayed activation**: if a bank revision already exists and the token carries no second factor, the new row gets `effective_at = strftime(…,'now','+24 hours')`; the first-ever revision and 2F-backed saves are immediate; re-saving the effective values is immediate and supersedes a pending change (verified §2.5). Response `200 { "revisionId", "effectiveAt" }`.
- `PUT contact` (AD+S): `{ "whatsappNumber" }` accepting `05XXXXXXXX`, `+9665…`, `9665…` (any digit script) → stored as E.164 digits; same delayed-activation rule.
- `PUT pickup` (**AD+R**, TM-04): `{ "address", "instructions" }`; content rules → `400 CONTENT_NOT_ALLOWED`.
- `POST terms` (AD+S): `{ "body", "changeSummary", "expectedCurrentVersion": "v1" | null }` → optimistic concurrency (`409 TERMS_VERSION_CONFLICT`); plain text, content rules and text validator on body and summary; SHA-256 computed server-side; `201 { "terms": { "version": "v2", "publishedAt" } }`. `GET terms` lists `{version, seq, publishedAt, changeSummary, bodySha256}`; `GET terms?version=v1` returns one body.
- `GET history?section=bank&limit=20&cursor=` → revisions newest first with `createdAt`, `effectiveAt`, `reauthAt` (admin-only; full values).
- Delivery areas: `POST { "name", "fee", "sortOrder" }`, `PATCH /{areaId} { "name"?, "fee"?, "isActive"?, "sortOrder"? }` (no delete route); names content-checked; audited.
- `PUT switch` (#43): `{ "onlineConfirmation": "on" | "off", "note": string | null }`; to `off` needs AD, to `on` needs AD+R (DB CHECK: `state='off' OR reauth_at IS NOT NULL`); audit `online_confirmation_switched`.

**#35 `GET /api/admin/queue` (AD).**
```json
{ "ok": true,
  "summary": { "decideNow": 1, "dueToday": 3, "eventsToday": 0, "handoversToday": 1 },
  "health": { "cronLastOkAt": "…Z", "cronStale": false, "emailConfigured": false, "outboxFailed": 0, "outboxSkipped24h": 4, "cspViolations24h": 0 },
  "alerts": [ { "code": "BANK_DETAILS_CHANGED_RECENTLY" | "SETTINGS_CHANGE_PENDING" | "ONLINE_CONFIRMATION_NOT_OFFERED" | "KILL_SWITCH_OFF" | "CRON_STALE" | "CSP_VIOLATIONS", … } ],
  "sections": [ { "id": "decide_now", "total": 1, "items": [ {
      "bookingId": "…", "reference": "…", "eventDate": "…", "customerFirstName": "…", "status": "…", "stage": "…",
      "dueAt": "…Z", "suggestedTemplate": "hold_reminder", "waDigits": "9665…",
      "templateInputs": { "amount": 1300, "slotStartsAt": null, "method": null },
      "startTime": null, "venueArea": null,
      "lastContact": null | { "template", "outcome", "at" } } ] } ],
  "serverTime": "…Z" }
```
Sections in this **fixed order** (≤ 50 items each; empty sections are omitted; UX-05): `decide_now` (notice-protected holds, and any flow-2 hold past its deadline while automatic expiry is off), `holds_expiring` (< 24 h), `deposit_notices`, `requests_over_sla` (24 h), `events_today_tomorrow` (items add `startTime` and `venueArea`, admin only), `handovers_today_tomorrow`, `terms_pending` (> 12 h after approval), `bank_mismatch` (accepted revision ≠ effective), `receipts_pending` (gate open only), `events_soon_without_details` (≤ 7 d), `awaiting_production`, `selection_overdue` (gate open only), `ready_without_handover`, `handover_no_show`, `feedback_due` (completed + 2 d, no feedback, no `feedback_request` sent). An item stays until its state changes or a `sent`/`dismissed` contact-log row exists for the template (UX-06). `waDigits` is validated `^[1-9]\d{7,14}$` server-side and is used by the client only inside the `href` (UX-03); the SB-13 minimisation note records `waDigits`, `startTime` and `venueArea` as admin-only fields.

**#36 `GET /api/admin/calendar?month=2026-11` (AD).** `{ "month", "days": [ { "date", "blocked": null | { "reason" }, "bookings": [ { "id", "status", "stage", "customerFirstName", "packageName" } ] } ] }`; terminal statuses excluded unless `includeClosed=1`; ≤ 500 rows.

**#37 Customers (AD).** `GET /api/admin/customers?cursor=&limit=` → `{ "customers": [ { "id", "firstName", "lastName", "email", "phone", "createdAt", "contactChangedAt", "bookingCount", "lastEventDate" } ], "nextCursor" }` (keyset on `created_at, id` with its **own** cursor validator, because `users.created_at` uses the `CURRENT_TIMESTAMP` format; erased users excluded). `GET /api/admin/customers/{customerId}` → profile + booking summaries.

**#38 `GET /api/admin/exports/bookings.csv?from=&to=&status=` (AD+R).** `from`/`to` required, ≤ 400 days, ≤ 5,000 rows (else `400 EXPORT_TOO_LARGE`). `Content-Type: text/csv; charset=utf-8`, UTF-8 BOM, CRLF, every text field quoted with `"` doubled; a text cell whose first non-space character is `= + - @ |` or a full-width `＝ ＋ － ＠` (U+FF1D, U+FF0B, U+FF0D, U+FF20), or which starts with TAB/CR, gets a leading `'`; bidi controls, C0/C1 controls, U+2028/U+2029 and zero-width characters stripped; numeric columns (totals, amounts) are emitted from integers without any prefix; phone exported as digits (TM-13). `Content-Disposition: attachment; filename="bookings-YYYYMMDD-YYYYMMDD.csv"`, `X-Frame-Options: DENY`, `no-store`. Columns: reference, created (Riyadh), event date, status code, status (Arabic), stage (Arabic), package, total, deposit expected, deposit received, received at, first name, last name, phone, email, terms version, terms accepted at, handover method, handover slot, production stage. **Internal notes are excluded.** Writes `admin_audit_log('bookings_exported', {"from","to","status","rows"})` with `reauth_at`.

**#39/#40/#44 Audit and session (AD).** `GET audit-log?cursor=&limit=` → `{ "entries": [ { "id", "action", "targetId", "details", "reauthAt", "createdAt" } ], "nextCursor" }`. `GET session` → `{ "admin": { "uid", "authTime": "…Z", "reauthFreshUntil": "…Z", "sessionFreshUntil": "…Z", "secondFactor": null | "totp" | "phone" }, "idleMinutes": 30, "serverTime" }` (lets the UI ask for the password **before** opening the bank form). `POST session/revoke-all` (AD+R) sets `users.tokens_valid_after` = SQL now for the admin row and writes `admin_sessions_revoked`; every existing admin token, including the caller's, is refused afterwards (TM-07).

**#41/#42 Search (AD, TM-17).** `POST /api/admin/search/bookings` body `{ "q", "status"?, "from"?, "to"?, "customerId"?, "cursor"?, "limit"? }` → the #16 list shape; `q` 1–64 code points, text-validated, matched with `LIKE … ESCAPE '\'` on "first last", email, phone digits (when `q` has ≥ 4 digits after `toAsciiDigits`) and booking-id prefix (≥ 6 hex characters). `POST /api/admin/search/customers` body `{ "q", "cursor"?, "limit"? }` → the #37 list shape. The query text never appears in a URL (address bar or API request). Error `400 INVALID_SEARCH`.

**#45 `POST /api/csp-report` (PUB).** Accepts `application/reports+json` and `application/csp-report`, ≤ 8 KiB, burst-limited per IP; stores only `(day, directive, blocked origin)` counts in `csp_report_counts` (a blocked URI is reduced to its origin, or to `inline`/`eval`/`data`); ≤ 200 rows per day; `204`. Nothing else from the report is kept (TM-17).

**#46 `POST /api/bookings` (changed, additive codes).** Inside the INSERT: ≤ 3 open requests per account and ≤ 5 created in the last hour; event date between the Riyadh today and today + 730 days; `RL_BOOKING` burst; the stored `users.email` is re-synced from the verified token (C-2). Legacy success path unchanged.

**#47 `PUT /api/profile` (changed).** `users.email` is written only from a token whose `email_verified` is true (stamps `email_verified_at`); an unverified conflicting row that has no bookings can be reclaimed by the verified owner of that email; unverified registrations keep working without owning the email (C-2, SEC-04); an erased user → `410`; changing phone or email on an existing row needs CO+R and stamps `contact_changed_at` (TM-08); names through the text validator, URLs refused (TM-12).

**#48 `GET /api/availability` (changed).** Same body; `Cache-Control: public, max-age=60` served through the Cache API (the cache key carries no personal data), `RL_AVAILABILITY` per IP.

---

## 4. Gating matrix and enforcement

### 4.1 Conditions
- **OC** `ONLINE_CONFIRMATION === "on"` (exact string). **KS** the latest `ops_switch_revisions` row for `online_confirmation` is `on`, or no row exists. **OCe** (effective online confirmation) = OC ∧ KS.
- **SET** settings complete: an effective `deposit`, an effective `bank` revision and a `terms_versions` row exist.
- **PDPL** `PDPL_SIGNOFF_REF` non-blank. **R2** a `MEDIA` binding that passes a runtime R2-shape guard. **KEY** `MEDIA_SIGNING_KEY` ≥ 32 bytes. **PM** (private media) = OC ∧ PDPL ∧ R2 ∧ KEY; `getMediaBucket(env)` returns null unless PM holds (TM-10).
- **2F** the admin token carries `firebase.sign_in_second_factor` (unless `ADMIN_MEDIA_MFA === "off"` exactly; the release preflight refuses `off` for production, TM-21). **2S** `ADMIN_SETTINGS_2F === "required"`.
- **EM** `RESEND_API_KEY` and `EMAIL_FROM` set. **AX** automatic flow-2 hold expiry = EM ∧ OCe (B1 #4, H3).
- **RA** token `auth_time` ≤ 10 min old. **ADf** admin session fresh: `auth_time` ≤ 12 h old and ≥ `users.tokens_valid_after`. **CR** customer `auth_time` ≤ 10 min. **CM** customer `auth_time` ≤ 12 h (media).
- **RP** `RETENTION_PURGE === "on"`. **PRO** `PREVIEW_READ_ONLY === "on"` (preview only). **RL** rate limits (§3.1).

### 4.2 Matrix

| Feature | Local dev (`.dev.vars`) | `env.mediatest` (local only) | Preview | **Production at go-live** | Condition | Enforcement |
|---|---|---|---|---|---|---|
| Legacy request → approve (flow 1) → manual steps | on | on | read-only (PRO) | **on** (caps, horizon, limits) | always | unchanged code + E4 caps inside the INSERT |
| Flow 2 for **new** approvals | on once the tester saves settings | on | off (OC off) | **on after the owner saves deposit + bank + terms** | OCe ∧ SET ∧ event ≥ today+3 | E4 predicates inside the approve `UPDATE`; `approvalPreview` shows the result beforehand |
| Customer confirmation panel (#2–#4) | on | on | off | **on** | OCe (+ row is flow 2) | E7 var + switch check before the handler; E4 `flow_version=2`, ownership, deadline |
| Deposit via WhatsApp + admin "record deposit" | on | off (upload channel) | – | **on** | ¬PM | `receiptChannel` from `isPrivateMediaAllowed`; `confirm_payment` flow-2 predicates |
| Automatic expiry of flow-2 holds | off unless EM configured | per EM | – | **off** (no email provider) → holds past the deadline go to `decide_now` | AX, and never for notice-protected holds | E4 predicates in the cron and the targeted sweep |
| `confirm_offline` | on | on | – | **on** (AD+R) | always | E4 + E6 |
| Receipt upload / admin receipt review / `/api/media` | off (503) | **on** | off | **off (503)** | PM (+2F admin, CM customer) | E1 registry-load assertion, E2 dispatcher 503, E3 `getMediaBucket` choke point, E6 claims |
| Galleries (admin upload, customer selection) | off | on | off | **off** | PM (+2F admin, CM customer) | same as above |
| Event profile, consent, `.ics` | on | on | read-only | **on** (consent grant needs CR) | always | E0 ownership + E4 status + E6 CR |
| Production (album) status | on | on | read-only | **on** | always | path `production` avoids the deny-list |
| Handover slots + booking (pickup/delivery) | on | on | read-only | **on** (delivery needs CR) | always | E4 capacity + ownership + active-area predicates |
| Feedback | on | on | read-only | **on** | always | E4 |
| Admin queue, calendar, customers, search, timeline, audit view | on | on | on (reads) | **on** | ADf | E0 admin guard |
| Settings writes: deposit, bank, contact, terms | on (RA) | on | off (PRO) | **on (RA; bank/contact changes delayed 24 h unless 2F; 2F required once 2S)** | RA (+2F if 2S) | E6 + E5 CHECK on `reauth_at` + `effective_at` |
| Pickup, delivery areas | on | on | off | **on** (pickup RA; content rules) | RA for pickup | E6 + SB-17 |
| CSV export | on (RA) | on | off | **on (RA)** | RA | E6 + E5 |
| Kill switch (D1) | on | on | – | **on** (off: AD; on: AD+R) | KS | E5 CHECK + E7 |
| Email reminders (outbox) | skipped unless EM | skipped | skipped | **skipped (no provider)** | EM | outbox `skipped` terminal state; queue health |
| Retention purge of D1 text | off | optional | off | **off** | RP | job returns immediately unless RP; never deletes booking or receipt rows (D11) |
| Retention purge of R2 objects, orphan sweep | off | optional | off | **off** | RP ∧ PM | same, plus E3 |
| Optional TOTP MFA sign-in | available if the dev project has Identity Platform | same | same | **available, not required** | Firebase config | client flow; server reads the claim |
| CSP | Report-Only | Report-Only | Report-Only, plus an enforced trial build (W5-05) | **Report-Only at the first deploy, enforced ≤ 7 days later** | release step | `_headers` + `/api/csp-report` |

### 4.3 Enforcement mechanisms (how the server enforces, in order)
- **E0 Guards**: `authorizeAdminRequest` on every admin path (role, stored email = token email, verified email, ADf), the customer dispatcher's `resolveOwnedBooking` on every customer booking path (identical 404), the preview read-only guard in `worker/index.ts`.
- **E1 Load-time assertion**: `assertPrivateMediaRoutesGated` runs on every registry built from the slot files (W1-04 keeps it on the concatenated arrays, with the TM-10 extended deny-list), so a receipt/gallery/album/photo/media/upload/file/… route declared `open` stops the Worker from starting.
- **E2 Dispatcher gate**: `effectiveRouteGate` → 503 before any handler code (customer: before authentication; admin: after authentication); `dispatchMediaRequest` closes the whole `/api/media` namespace.
- **E3 Single choke point**: `getMediaBucket(env)` returns null unless the whole PM predicate holds; no code outside `gates.ts` reads `env.MEDIA` (grep gate, W1-13); `readSigningKey(env)`; either missing → 503.
- **E4 SQL predicates**: status, `flow_version`, deadline and grace (bound from the Worker clock), ownership, capacity counts (excluding the booking's own row on re-book), active delivery area, settings existence and effectiveness, notice protection, windowed caps — all inside the writing statement, with the `changes()` guard row in the same batch.
- **E5 Database constraints**: CHECKs (shape, lengths, IBAN format, reauth window, `effective_at` bound, switch-on needs `reauth_at`), unique indexes (one pending receipt, one handover per booking, single admin, one blocking booking per date), append-only and no-delete triggers.
- **E6 Token claims**: `auth_time` freshness (RA, ADf, CR, CM), `tokens_valid_after`, and the second-factor claim (2F, 2S), read by `worker/recent-auth.ts` and `worker/admin-auth.ts`.
- **E7 Var and switch checks**: `isOnlineConfirmationOn` (env) and the D1 switch for the customer confirmation routes and the approve path; `RP` for purge jobs; `AX` for the cron.
- **E8 UI**: sections/views use `features`/`receiptChannel` for presentation only; never trusted.
- **E9 Release integrity**: every deploy path runs `scripts/release-preflight.mjs` (§7.0), which refuses a build that would open a gate by configuration (R2 binding, media vars, `ADMIN_MEDIA_MFA="off"`) or mismatch the Firebase project.

Fail-closed rule: a missing or malformed var, secret, binding or switch row always means **off**, except the kill switch, whose absence means "not pulled" (on), and the burst limiter, which fails open by design (the SQL caps are the hard bound).

---

## 5. Combined wave plan and build units (both plans)

This section is the **single schedule for both plans**: the feature units of this plan and the motion units of `12-motion-spec.md` (MOT-01…MOT-13, whose detailed acceptance stays in 12 §8.2). Unit ids are `W<wave>-<nn>`; §5.4 maps them to the rev. 1 ids used in older documents, `13-threat-model.md` and the reviews.

### 5.1 Rules for every unit (Definition of Done)
1. **≤ 4 changed files** per unit. Test files under `tests/` that belong to the unit do not count. Justified exceptions: W1-01 (5), W1-04 (23 stubs), W1-05 (24 stubs), W1-16 (5), W3-02 (5), W3-16 (6), W5-01 (6); each states its reason.
2. **Exclusive ownership across both plans**: no file appears in two units of the same wave (checked mechanically over the list below; §5.5 lists every file that more than one unit touches, with its single owner per wave). Registries are never edited after wave 1: features fill their own slot file. Nobody edits `src/styles/*.css` (motion CSS lives in `src/design/cinematic/`, feature CSS in the two panel stylesheets and feature folders). A unit may depend on another unit **of the same wave** only when the dependency is declared; it then branches from the dependency's merged commit (the declared same-wave dependencies are W1-02/W1-06/W1-09/W1-12 → W1-01, W1-06/W1-15 → W1-03, W2-02 → W2-03 and W2-04, W2-10 → W2-03, W3-09 → W3-02, W3-13 → W3-16, W13-03 → W13-01 and W13-02). Every unit of wave n also depends on the previous wave's review gate.
3. **Binding code rules**: no `any`, `@ts-ignore`, `eslint-disable`, unsafe `as`; no empty or broad catch (catch narrowly by type, rethrow the rest); no unhandled promises; listeners, observers, timers and AbortControllers cleaned up; never read `event.currentTarget` in deferred updaters; no new dependency; no React Router; one Firebase listener, one AuthProvider, the existing AuthDialog; Arabic RTL, feminine singular, real strings (new strings go to the copy reviewer); keyboard access, visible focus, never colour-only state, `prefers-reduced-motion`; **every tap target ≥ 44 × 44 CSS px with ≥ 8 px spacing**; **accent text only on paper/surface backgrounds** (UX-12); every free-text field through the shared validator and every customer-visible admin text through the content rules; never invent prices, facts, testimonials, response times or legal text.
4. **Checks per unit**: `npm run verify` (lint with 0 errors and 0 warnings, `tsc -b` for app + node + worker, both design builds, `npm test`, the grep gates of W1-13) and the unit's runtime check on local `npm run dev` with a migrated local D1 (§6). Motion units also meet 12 §8.1 A1–A6.
5. **Adversarial review before any merge, push or deploy**: the wave's review gate assigns **two independent reviewers to every unit** (an application-security reviewer and a domain reviewer: backend, frontend, motion or UX). Critical and high findings must be fixed; **the owner cannot accept them**. Medium and low findings are fixed or accepted in writing by the owner. The merge hooks run `verify`; the gate report records that it ran.
6. **Every unit lists its security controls** (SB-n below plus the TM/B/H/UX ids it implements) and the tests that prove them.

### 5.2 Security baseline (referenced as SB-n in every unit)
- **SB-1 AuthN**: Firebase ID token verified server-side (RS256, JWKS, `aud`/`iss` = `FIREBASE_PROJECT_ID`, `exp`/`iat`/`auth_time`), verified email required.
- **SB-2 AuthZ**: admin from D1 per request, bound to uid and the verified email; customer ownership resolved centrally and bound again in every write; foreign ids → 404 with the same body (no existence oracle).
- **SB-3 Input**: exact-key JSON with byte caps (legacy handlers included), strict UTF-8, runtime type guards, code-point limits equal to DB CHECKs, decoded bounded path params.
- **SB-4 SQL**: bound parameters only; dynamic SQL only from constant fragments; `LIKE` input escaped with `ESCAPE '\'`.
- **SB-5 State integrity**: conditional writes + `changes()` guard in one batch; every capacity/eligibility/cap check inside the writing statement; unique indexes for invariants; server clock only; compare-and-swap for deadline changes.
- **SB-6 Output**: `jsonResponse`; React text only (no `dangerouslySetInnerHTML`); user strings in `<bdi>`; no autolinking; emails `escapeHtml` + bidi isolation; CSV neutralisation; `.ics` escaping.
- **SB-7 Logging**: fixed codes and counts only; never tokens, names, phones, emails, IBANs, addresses, signed URLs, search text or bodies (grep gate).
- **SB-8 Secrets**: Worker secrets/vars only; nothing sensitive in `VITE_*`; `.dev.vars*`/`.env*` ignored; no secrets in commits.
- **SB-9 Errors**: fixed code + Arabic message; no stack traces or SQL text to clients.
- **SB-10 Audit**: status → `booking_status_history`; booking events → `booking_events` (actor); admin non-booking actions → `admin_audit_log`; all append-only and never deleted; `created_at` stamped by SQL.
- **SB-11 Gating**: private media behind E1–E3 (+E6 for admin, CM for customers); `getMediaBucket` is the only door; fail closed.
- **SB-12 Client hygiene**: no tokens/PII in URLs or storage (only `sy:intro:v1`); aborts on unmount; `wa.me` links only from `src/lib/whatsapp.ts`, `target="_blank" rel="noopener noreferrer"`; object URLs revoked; no third-party scripts.
- **SB-13 Privacy (PDPL)**: minimisation (ids/counts only in `details`; admin-only fields listed), consent default NO, retention flags, no PII in keys, privacy notice at every point of collection.
- **SB-14 Re-auth**: sensitive admin writes require `auth_time` ≤ 10 min, re-checked by a DB CHECK on the stored `reauth_at`; `reauthAt` only from `auth_time`.
- **SB-15 Limits**: `ratelimits` bursts plus atomic SQL caps (§3.1).
- **SB-16 Text**: `normalizeFreeText` on every free-text field (bidi/format characters refused).
- **SB-17 Customer-visible admin text**: `findPaymentInstructionLike` refuses account numbers, links and foreign phone numbers; rendered as plain text.
- **SB-18 Sessions**: admin sessions ≤ 12 h and revocable (`tokens_valid_after`), 30 min idle sign-out; customer recent sign-in for consent grant, delivery booking and contact changes.
- **SB-19 Release integrity**: one deploy path (`release.mjs` + preflight), clean tree, annotated release tag, pinned design, launch floor.
- **SB-20 Central ownership**: `OwnedBooking` from the dispatcher; nested ids validated through their parent.

### 5.3 Release trains and wave overview

| Wave | Train | Purpose | Units |
|---|---|---|---|
| 0 | A | Attack the baseline and the plans; inventory the old database (read-only) | W0-01 … W0-03 |
| 1 | A | Foundations: schema, identity, gates/config, slots, contracts, text/time helpers, limiter, test harness, bounded bodies; motion switch, rasters, route readiness | W1-01 … W1-18, W1-RV |
| 2 | A | Core services, profile and entry hardening, headers and config guard; motion tokens/hero/scroll, build scripts, audit tool | W2-01 … W2-21, W2-RV |
| 3 | A | Remaining services, first admin/customer UIs, booking hardening, legal routes, release tooling; display headings, khatam | W3-01 … W3-20, W3-RV |
| 4 | A | Confirmation/handover UIs, admin list/export, hub, privacy links; page transitions, remaining display surfaces | W4-01 … W4-10, W4-RV |
| 5 | A | Optional MFA, handoff docs, preview migration; logo intro, ticker (if decided) | W5-01 … W5-05, W5-RV |
| 6 | A | Independent red teams ×3, runtime QA, motion release gate (all read-only except the motion docs) | W6-01 … W6-05 |
| 7 | A | **Release A** (owner-executed) | W7-01 |
| 8 | B | Media primitives, retention job | W8-01, W8-02, W8-RV |
| 9 | B | Media serving, receipt upload API, gallery admin API | W9-01 … W9-03, W9-RV |
| 10 | B | Admin receipts API, customer gallery API, receipt upload UI, gallery upload pipeline | W10-01 … W10-04, W10-RV |
| 11 | B | Admin receipt review, admin gallery section, customer selection, gallery jobs | W11-01 … W11-04, W11-RV |
| 12 | B | Lightbox, Train B docs | W12-01, W12-02, W12-RV |
| 13 | B | Red team D (media), mediatest QA, **dark release B** (owner-executed) | W13-01 … W13-03 |

- **Train A** is everything the first clients use, all baseline go-live fixes and the motion layer. **Release gate A** (end of wave 6): zero open critical/high findings across W6-01…W6-05; **zero open baseline go-live items** (C-1…C-5, C-8…C-11, C-14, C-16, C-17); legal texts present (preflight); the owner's Resend decision recorded; medium findings fixed or accepted in writing; the launch design is cinematic only if W6-05 passes, otherwise classic.
- **Train B** is private media. It is developed on branch `train-b`, may start once W5-RV passes (its files are disjoint from every wave-6 and wave-7 file, checked mechanically), rebases onto the release branch after every Train A fix, and is merged into the release branch **only after gate B** (W13-01 and W13-02: zero open critical/high). Production stays gated off after the merge (no R2 binding, no `PDPL_SIGNOFF_REF`, no signing key; the preflight refuses them).
- Rev. 1's RV-6 and RV-7 are superseded by W8-RV…W12-RV; rev. 1's G8 media checks moved to W13-01/W13-02.

### 5.4 Rev. 1 → combined ids

| Rev. 1 id | Combined id | Wave | Train |
|---|---|---|---|
| G0-1 | W0-01 | 0 | A |
| G0-2 | W0-02 | 0 | A |
| (new) | W0-03 | 0 | A |
| G1-1 | W1-01 | 1 | A |
| G1-2 | W1-02 | 1 | A |
| G1-3 | W1-03 | 1 | A |
| G1-4 | W1-04 | 1 | A |
| G1-5 | W1-05 | 1 | A |
| G1-6 | W1-06 | 1 | A |
| G1-7 | W1-07 | 1 | A |
| G1-8 | W1-08 | 1 | A |
| G1-9 | W1-09 | 1 | A |
| (new) | W1-10 | 1 | A |
| G1-11 | W1-11 | 1 | A |
| G1-12 | W1-12 | 1 | A |
| (new) | W1-13 | 1 | A |
| (new) | W1-14 | 1 | A |
| (new) | W1-15 | 1 | A |
| MOT-01 | W1-16 | 1 | A |
| MOT-03 | W1-17 | 1 | A |
| MOT-05 | W1-18 | 1 | A |
| RV-1 | W1-RV | 1 | A |
| G2-1 | W2-01 | 2 | A |
| G2-3 | W2-02 | 2 | A |
| G2-14 | W2-03 | 2 | A |
| (new) | W2-04 | 2 | A |
| G2-4 | W2-05 | 2 | A |
| G2-5 | W2-06 | 2 | A |
| G2-6 | W2-07 | 2 | A |
| G2-7 | W2-08 | 2 | A |
| G2-8 | W2-09 | 2 | A |
| G2-9 | W2-10 | 2 | A |
| G2-10 | W2-11 | 2 | A |
| G2-11 | W2-12 | 2 | A |
| G2-12 | W2-13 | 2 | A |
| G2-15 | W2-14 | 2 | A |
| (new) | W2-15 | 2 | A |
| G2-2 | W2-16 | 2 | A |
| (new) | W2-17 | 2 | A |
| G1-10 | W2-18 | 2 | A |
| MOT-02 | W2-19 | 2 | A |
| MOT-04 | W2-20 | 2 | A |
| MOT-06 | W2-21 | 2 | A |
| RV-2 | W2-RV | 2 | A |
| G3-1 | W3-01 | 3 | A |
| G3-2 | W3-02 | 3 | A |
| G3-4 | W3-03 | 3 | A |
| G3-5 | W3-04 | 3 | A |
| G3-6 | W3-05 | 3 | A |
| G3-7 | W3-06 | 3 | A |
| G3-8 | W3-07 | 3 | A |
| G3-9 | W3-08 | 3 | A |
| G3-10 | W3-09 | 3 | A |
| G3-11 | W3-10 | 3 | A |
| G3-12 | W3-11 | 3 | A |
| G3-13 | W3-12 | 3 | A |
| G3-14 | W3-13 | 3 | A |
| G3-15 | W3-14 | 3 | A |
| (new) | W3-15 | 3 | A |
| (new) | W3-16 | 3 | A |
| MOT-07 | W3-17 | 3 | A |
| MOT-08 | W3-18 | 3 | A |
| (new) | W3-19 | 3 | A |
| (new) | W3-20 | 3 | A |
| RV-3 | W3-RV | 3 | A |
| G4-1 | W4-01 | 4 | A |
| G4-2 | W4-02 | 4 | A |
| G4-3 | W4-03 | 4 | A |
| G4-4 | W4-04 | 4 | A |
| G4-5 | W4-05 | 4 | A |
| G4-6 | W4-06 | 4 | A |
| G4-9 | W4-07 | 4 | A |
| (new) | W4-08 | 4 | A |
| MOT-09 | W4-09 | 4 | A |
| MOT-12 | W4-10 | 4 | A |
| RV-4 | W4-RV | 4 | A |
| G5-6 | W5-01 | 5 | A |
| MOT-10 | W5-02 | 5 | A |
| MOT-11 | W5-03 | 5 | A |
| G7-2 | W5-04 | 5 | A |
| (new) | W5-05 | 5 | A |
| RV-5 | W5-RV | 5 | A |
| G8-1 | W6-01 | 6 | A |
| G8-2 | W6-02 | 6 | A |
| G8-3 | W6-03 | 6 | A |
| G8-4 | W6-04 | 6 | A |
| MOT-13 | W6-05 | 6 | A |
| G9-1 | W7-01 | 7 | A |
| G2-13 | W8-01 | 8 | B |
| G5-5 | W8-02 | 8 | B |
| (new) | W8-RV | 8 | B |
| G3-3 | W9-01 | 9 | B |
| G4-7 | W9-02 | 9 | B |
| G4-8 | W9-03 | 9 | B |
| (new) | W9-RV | 9 | B |
| G5-1 | W10-01 | 10 | B |
| G5-2 | W10-02 | 10 | B |
| G5-3 | W10-03 | 10 | B |
| G5-4 | W10-04 | 10 | B |
| (new) | W10-RV | 10 | B |
| G6-1 | W11-01 | 11 | B |
| G6-2 | W11-02 | 11 | B |
| G6-3 | W11-03 | 11 | B |
| G6-4 | W11-04 | 11 | B |
| (new) | W11-RV | 11 | B |
| G7-1 | W12-01 | 12 | B |
| (new) | W12-02 | 12 | B |
| (new) | W12-RV | 12 | B |
| G8-1/G8-2 media parts | W13-01 | 13 | B |
| G8-4 | W13-02 | 13 | B |
| (new) | W13-03 | 13 | B |

### 5.5 Files touched by more than one unit (one owner per wave)

The table is generated from the unit list; no file appears twice within a wave. Every file not listed has exactly one owner in the whole plan, including the high-contention ones: `worker/index.ts` (W2-17), `worker/http.ts` (W1-14), `shared/timing.ts` and `shared/text.ts` (W1-10), `shared/journey.ts` (W2-16), `worker/email-templates.ts` (W2-04), `worker/jobs/hold-state.ts` (W2-03), `src/lib/whatsapp.ts` (W1-11), `src/features/admin-portal/sections.ts` (W1-05), `worker/portal/portal-routes.ts` (W1-04) and `src/pages/home/HeroSection.tsx` (W3-17). No unit edits `src/styles/*.css`.

| File | Owner per wave (one owner in any wave) |
|---|---|
| `docs/OPERATIONS.md` | W5-04 → W12-02 |
| `docs/SECURITY.md` | W5-04 → W12-02 |
| `package.json` | W1-13 → W2-19 → W3-19 |
| `public/_headers` | W2-18 → W7-01 |
| `README.md` | W5-04 → W6-05 |
| `runs/redo-v2/HANDOFF.md` | W5-04 → W12-02 |
| `shared/admin.ts` | W2-02 → W3-02 |
| `src/api/admin.ts` | W1-07 → W3-02 |
| `src/App.tsx` | W3-16 → W4-09 → W5-02 |
| `src/auth/AuthContext.tsx` | W1-08 → W5-01 |
| `src/components/AuthDialog.tsx` | W4-08 → W5-01 |
| `src/design/cinematic/boot.ts` | W1-16 → W2-20 |
| `src/features/admin-audit/registration.ts` | W1-05 → W3-12 |
| `src/features/admin-calendar/registration.ts` | W1-05 → W3-06 |
| `src/features/admin-contact/registration.ts` | W1-05 → W3-07 |
| `src/features/admin-customers/registration.ts` | W1-05 → W3-09 |
| `src/features/admin-deposit/registration.ts` | W1-05 → W4-04 |
| `src/features/admin-event-profile/registration.ts` | W1-05 → W3-11 |
| `src/features/admin-feedback/registration.ts` | W1-05 → W3-12 |
| `src/features/admin-gallery/registration.ts` | W1-05 → W11-02 |
| `src/features/admin-handover/registration.ts` | W1-05 → W3-10 |
| `src/features/admin-production/registration.ts` | W1-05 → W3-11 |
| `src/features/admin-queue/registration.ts` | W1-05 → W3-05 |
| `src/features/admin-receipt/registration.ts` | W1-05 → W11-01 |
| `src/features/admin-security/registration.ts` | W1-05 → W5-01 |
| `src/features/admin-settings/AdminSettingsTab.tsx` | W3-04 → W4-06 |
| `src/features/admin-settings/registration.ts` | W1-05 → W3-04 |
| `src/features/admin-timeline/registration.ts` | W1-05 → W3-08 |
| `src/features/confirmation/ConfirmationStageView.tsx` | W4-01 → W10-03 |
| `src/features/confirmation/registration.ts` | W1-05 → W4-01 |
| `src/features/event-profile/registration.ts` | W1-05 → W3-13 |
| `src/features/feedback/registration.ts` | W1-05 → W3-14 |
| `src/features/gallery/GalleryStageView.tsx` | W11-03 → W12-01 |
| `src/features/gallery/registration.ts` | W1-05 → W11-03 |
| `src/features/handover/registration.ts` | W1-05 → W4-02 |
| `src/features/reauth/ReauthDialog.tsx` | W1-08 → W5-01 |
| `src/features/reauth/use-reauth-retry.ts` | W1-08 → W5-01 |
| `src/layout/lazy-components.ts` | W1-18 → W3-16 |
| `src/pages/home/StorySection.tsx` | W3-18 → W4-10 |
| `src/styles/README.md` | W2-19 → W6-05 |
| `vite.config.ts` | W1-16 → W2-18 |
| `worker/admin.ts` | W1-14 → W2-02 → W3-02 |
| `worker/bookings.ts` | W1-14 → W2-16 → W3-15 |
| `worker/emails/journey.ts` | W3-03 → W4-07 |
| `worker/jobs/registry.ts` | W3-03 → W4-07 → W8-02 → W11-04 |
| `worker/portal/slots/admin-audit.ts` | W1-04 → W2-05 |
| `worker/portal/slots/admin-booking-log.ts` | W1-04 → W2-05 |
| `worker/portal/slots/admin-directory.ts` | W1-04 → W2-11 |
| `worker/portal/slots/admin-event-profile.ts` | W1-04 → W2-06 |
| `worker/portal/slots/admin-export.ts` | W1-04 → W2-12 |
| `worker/portal/slots/admin-feedback.ts` | W1-04 → W2-09 |
| `worker/portal/slots/admin-gallery.ts` | W1-04 → W9-03 |
| `worker/portal/slots/admin-handover.ts` | W1-04 → W2-08 |
| `worker/portal/slots/admin-production.ts` | W1-04 → W2-07 |
| `worker/portal/slots/admin-queue.ts` | W1-04 → W2-10 |
| `worker/portal/slots/admin-receipts.ts` | W1-04 → W10-01 |
| `worker/portal/slots/admin-search.ts` | W1-04 → W3-02 |
| `worker/portal/slots/admin-settings.ts` | W1-04 → W2-01 |
| `worker/portal/slots/confirmation.ts` | W1-04 → W2-13 |
| `worker/portal/slots/event-profile.ts` | W1-04 → W2-06 |
| `worker/portal/slots/feedback.ts` | W1-04 → W2-09 |
| `worker/portal/slots/gallery.ts` | W1-04 → W10-02 |
| `worker/portal/slots/handover.ts` | W1-04 → W3-01 |
| `worker/portal/slots/media.ts` | W1-04 → W9-01 |
| `worker/portal/slots/receipts.ts` | W1-04 → W9-02 |
| `worker/profile.ts` | W1-14 → W2-15 |
| `wrangler.jsonc` | W1-03 → W7-01 |

### 5.6 Units

Generated from the same list as §5.4 and §5.5. Motion units (MOT-nn) keep their detailed acceptance in `12-motion-spec.md` §8.2; the lines here summarise them.

#### Wave 0

**W0-01 · Adversarial review of the baseline (was G0-1)** (docs) — `runs/redo-v2/security/golive/w0-baseline-attack.md`. Deps: none.
- Acceptance:
  - Attacks c80f4c2: JWT edge cases (alg, kid, aud, clock skew), admin guard bypass on both dispatchers, gates.ts bypasses (percent-encoding, case, //, trailing slash, NFKC, synonym paths), request.ts caps (chunked bodies, understated Content-Length), IDOR in /api/bookings/me and admin detail, CSP gaps, secrets hygiene (git log -p key scan, stale worker-configuration.d.ts names), npm audit --omit=dev, lockfile integrity, headers on SPA fallback.
  - Re-checks every 10-security-baseline SEC finding at HEAD and maps each go-live blocker (C-1…C-17) to its combined unit id.
  - Every finding has severity, reproduction and an owner unit; zero open criticals before wave 1.
- Security: Read-only, local only, no production access; No secret values or customer data in the report; Two independent reviewers (appsec + domain).

**W0-02 · Threat-model traceability and decision record (was G0-2; the model itself is 13-threat-model.md)** (docs) — `runs/redo-v2/security/golive/w0-traceability.md`, `runs/redo-v2/decisions.md`. Deps: none.
- Acceptance:
  - Every TM-nn, B/H/M/L and UX-nn item of 11 §0 and 12 §0 maps to a unit id and a test id (N-nn or A-n).
  - Abuse cases include hold squatting through fake deposit notices (UX-02 variant A) and IBAN/WhatsApp swap under the 24 h delay (TM-03).
  - decisions.md records the owner decisions of 2026-09-28, the R1 override (MFA optional at launch; D15) and the owner answers to 11 §9 as they arrive; nothing else in decisions.md changes.
- Security: Owner-approved wording only; No secrets or personal data; Reviewed by the architect and the appsec reviewer.

**W0-03 · Old-database and account inventory (new; owner-executed, read-only)** (data) — `runs/redo-v2/release/w0-inventory.md`. Deps: none.
- Acceptance:
  - Counts (never rows) from D1 sundus-yar-bookings: users, admins, bookings in blocking statuses with event_date >= Riyadh today, blocked_dates >= today; migrations list --remote (D8).
  - Records the currently deployed version id of sundus-yar-website as the pre-launch version (B3).
  - Operational checks O-1…O-3 of the baseline: email-enumeration protection state, version Preview URLs disabled, admin rows; 2FA on the Cloudflare and Firebase owner accounts (TM-23).
  - Any non-zero future booking or blocked-date count opens 11 §9 Q3 before W7-01.
- Security: Read-only SELECT COUNT(*) commands only, each approved by the owner before it runs; No personal data copied into the report; No writes, no deploys.

#### Wave 1

**W1-01 · Migrations 0007 + 0008 and the local seed (was G1-1; adds 0008)** (data) — `migrations/0007_golive_admin_settings.sql`, `migrations/0008_golive_hardening.sql`, `scripts/dev-seed.sql`, `scripts/seed-local.mjs`, `runs/redo-v2/d1/0007-0008-verification.md`. Deps: W0-01, W0-02.
- Acceptance:
  - 11 §2.2 and §2.4 DDL committed byte-for-byte (any change is re-verified); 5 files justified: both migrations are verified together and the seed depends on both.
  - Fresh local D1 applies 0001, 0003-0008 with wrangler (27 tables, 23 indexes, 12 triggers); tests/migrations.test.mjs re-runs the 56 + 42 checks of §2.3 and §2.5 with node:sqlite.
  - seed-local.mjs --customer-uid <uid> creates one booking per journey stage (distinct dates), a notice-protected overdue hold, fake customers (@example.test, ids seed-…) and the _dev_seed_marker table; no settings, bank data or admin.
- Security: Script hard-codes --local and refuses --remote/--env; uid validated ^[A-Za-z0-9]{1,128}$ before templating; wrangler run through spawn with an argument array (no shell); Append-only and no-delete triggers (SB-10, L2); production preflight asserts _dev_seed_marker is absent; SB-4, SB-8.

**W1-02 · Token claims, admin binding, session freshness and re-auth guards (was G1-2 + C-1, TM-02, TM-07, C-14)** (backend) — `worker/auth.ts`, `worker/admin-auth.ts`, `worker/recent-auth.ts`, `shared/admin-session.ts`. Deps: W0-01, W0-02, W1-01.
- Acceptance:
  - AuthenticatedFirebaseUser gains authTime and secondFactor (additive; existing callers unchanged).
  - authorizeAdminRequest also requires lower(users.email) = lower(token email), auth_time within 12 h and auth_time >= users.tokens_valid_after, read in the same D1 query; failures -> 403 REAUTH_REQUIRED (N-32, N-44).
  - recent-auth.ts: requireRecentSignIn (admin, 600 s), requireRecentCustomerSignIn (600 s), requireMediaFreshSignIn (12 h), requireSecondFactor (ADMIN_MEDIA_MFA counts as off only for the exact value "off"), requireSettingsSecondFactor (ADMIN_SETTINGS_2F).
  - reauthAtFromToken() is the only source of reauthAt (auth_time, never iat or now); tests/recent-auth.test.mjs tells iat and auth_time apart (M1).
- Security: C-1, TM-02, TM-07, C-14, TM-21, M1; Claims validated as finite numbers <= now; fail closed on missing claims; No token or email logging (SB-7); SB-1, SB-14, SB-18.

**W1-03 · Platform config and private-media gate v2 (was G1-3 + TM-10, C-4/C-8 config, SEC-13)** (fullstack) — `wrangler.jsonc`, `worker-configuration.d.ts`, `worker/platform-env.d.ts`, `worker/portal/gates.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - account_id, preview_urls false, D1 DB -> sundus-yar-production (placeholder id), ONLINE_CONFIRMATION "on", FIREBASE_PROJECT_ID placeholder, ADMIN_MEDIA_MFA "required", ADMIN_SETTINGS_2F "off"; env.mediatest local-only with R2 MEDIA.
  - ratelimits bindings RL_BOOKING, RL_PROFILE, RL_CUSTOMER_WRITE, RL_UPLOAD, RL_AVAILABILITY, RL_CSP_REPORT, RL_ADMIN_READ (60 s periods) in production and preview.
  - env.preview: dev Firebase project id, PREVIEW_READ_ONLY "on", preview_urls false (M4, C-8, TM-24).
  - gates.ts: getMediaBucket(env) returns null unless isPrivateMediaAllowed(env) (OC ∧ PDPL ∧ R2 shape ∧ KEY); PRIVATE_MEDIA_SEGMENTS extended with upload(s), file(s), image(s), picture(s), attachment(s), proof(s), slip(s), document(s), download(s), pdf, thumb(s), preview(s); getPrivateMediaBlockers; build output has no r2_buckets.
- Security: TM-10 single choke point; runtime structural guard, never the generated type; All flags fail closed; Key length checked without logging the key; SB-8, SB-11.

**W1-04 · Worker route slots and central ownership (was G1-4 + C-16/TM-06)** (backend) — `worker/portal/portal-routes.ts`, `worker/portal/admin-portal-routes.ts`, `worker/portal/owned-booking.ts`, `worker/portal/slots/confirmation.ts`, `worker/portal/slots/receipts.ts`, `worker/portal/slots/event-profile.ts`, `worker/portal/slots/handover.ts`, `worker/portal/slots/feedback.ts`, `worker/portal/slots/gallery.ts`, `worker/portal/slots/media.ts`, `worker/portal/slots/admin-settings.ts`, `worker/portal/slots/admin-audit.ts`, `worker/portal/slots/admin-booking-log.ts`, `worker/portal/slots/admin-event-profile.ts`, `worker/portal/slots/admin-production.ts`, `worker/portal/slots/admin-handover.ts`, `worker/portal/slots/admin-feedback.ts`, `worker/portal/slots/admin-queue.ts`, `worker/portal/slots/admin-directory.ts`, `worker/portal/slots/admin-export.ts`, `worker/portal/slots/admin-search.ts`, `worker/portal/slots/admin-receipts.ts`, `worker/portal/slots/admin-gallery.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - Justified > 4: behaviour-free typed empty slot arrays reviewed as one; they remove every later shared-registry edit.
  - Customer dispatcher: requireVerifiedCustomer -> resolveOwnedBooking (SELECT id, status, flow_version, event_date, hold_expires_at … WHERE id=? AND user_id=?) -> identical 404 body for foreign and non-existent ids; handlers receive OwnedBooking.
  - assertPrivateMediaRoutesGated runs over the concatenated registries; admin namespaces extended with settings, calendar, customers, exports, audit-log, session, search; existing responses unchanged (404 for unregistered paths).
- Security: C-16, TM-06: ownership resolved once, handlers still bind user_id in writes (SB-20); E1 kept; explicit greppable registrations, no dynamic imports; SB-2, SB-11.

**W1-05 · UI registry slots and shared panel styles (was G1-5 + UX-05 order, UX-12 contrast, UX-13 targets)** (frontend) — `src/features/journey/stage-views.ts`, `src/features/admin-portal/sections.ts`, `src/features/journey/stage-panels.css`, `src/features/admin-portal/admin-panels.css`, `src/features/confirmation/registration.ts`, `src/features/event-profile/registration.ts`, `src/features/handover/registration.ts`, `src/features/feedback/registration.ts`, `src/features/gallery/registration.ts`, `src/features/admin-settings/registration.ts`, `src/features/admin-queue/registration.ts`, `src/features/admin-calendar/registration.ts`, `src/features/admin-customers/registration.ts`, `src/features/admin-audit/registration.ts`, `src/features/admin-contact/registration.ts`, `src/features/admin-timeline/registration.ts`, `src/features/admin-deposit/registration.ts`, `src/features/admin-event-profile/registration.ts`, `src/features/admin-production/registration.ts`, `src/features/admin-handover/registration.ts`, `src/features/admin-feedback/registration.ts`, `src/features/admin-receipt/registration.ts`, `src/features/admin-gallery/registration.ts`, `src/features/admin-security/registration.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - Justified > 4: mechanical stubs plus two token-based stylesheets; with every stub empty the hub and dashboard render exactly as today.
  - Section descriptors carry fixed numeric order values (summary 0, actions 10, contact 20, deposit 30, receipts 35, handover 40, production 50, gallery 55, event profile 60, timeline 70, feedback 80); workspace tabs carry group primary|more (UX-05).
  - Panel CSS: accent text only on paper/surface, --color-accent-deep on sunk/tint/hairline backgrounds, --color-accent-soft only on ink or dark photos (UX-12); every control >= 44 x 44 CSS px with >= 8 px spacing (UX-13); existing tokens only; no edit to src/styles/*.css.
- Security: Descriptors import components lazily only; No inline styles from data; SB-12.

**W1-06 · Settings contracts, deposit math, effective/pending read side and features (was G1-6 + M3, TM-03, H3, B1)** (backend) — `shared/settings.ts`, `shared/deposit.ts`, `worker/settings/settings-read.ts`, `worker/settings/features.ts`. Deps: W0-01, W0-02, W1-01, W1-03.
- Acceptance:
  - Typed section inputs and guards (IBAN normalise + mod-97; WhatsApp digits; lengths = DB CHECKs); computeDeposit integer-only with worked examples.
  - Effective revision = highest id with COALESCE(effective_at, created_at) <= now; pending revision per section (verified §2.5).
  - features.ts (all exports needed by wave 2, including blockers; M3): onlineConfirmation {switchOn, killSwitch, settingsComplete, missing, offered}, privateMedia.blockers (incl. ADMIN_MFA_DISABLED), email.configured, holdAutoExpiry = EM ∧ OCe, settings2f.
  - Every SQL string prepared against 0007 + 0008 in tests/settings-read.test.mjs.
- Security: No float money math; integers bounded; IBAN never logged; read-only module; TM-03, TM-21, H3; SB-3, SB-4, SB-7.

**W1-07 · API client v2 and forward-compatible admin parser (was G1-7 + L1)** (frontend) — `src/lib/api-client.ts`, `src/api/admin.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - requestBlob (CSV; checks Content-Type), upload (XHR with progress and abort), postJson, keepalive option; REAUTH_REQUIRED, SECOND_FACTOR_REQUIRED and RATE_LIMITED recognised with their Arabic messages.
  - The admin detail parser ignores unknown allowedActions entries, so a tab running an older bundle keeps working when new actions ship (L1).
  - Existing callers unchanged.
- Security: Only same-origin /api/ paths; token never in a URL; Responses parsed by caller guards; no logging; SB-12.

**W1-08 · Re-auth dialog (admin and customer), idle sign-out API and displayName fix (was G1-8 + UX-16, C-15, TM-07, TM-08)** (frontend) — `src/auth/AuthContext.tsx`, `src/auth/auth-context.ts`, `src/features/reauth/ReauthDialog.tsx`, `src/features/reauth/use-reauth-retry.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - reauthenticateWithPassword inside the single provider; accessible dialog (labelled, focus-trapped, Escape cancels, focus returns) usable by admin and customer, feminine copy.
  - A read-only autocomplete="username" field with the account email plus current-password; after success shows «التحقق صالح حتى {time}» (UX-16); the hook retries the original request once.
  - startIdleSignOut(minutes) on the context (pointerdown/keydown activity, cleaned up) for the admin shell (TM-07); displayName no longer set from the full name (C-15); an MFA challenge surfaces as "use the MFA sign-in" until W5-01.
- Security: Password held only in component state and cleared on close; never logged or stored; No new Firebase listener; one AuthProvider; SB-12, SB-14, SB-18.

**W1-09 · Admin audit writer with SQL-stamped time (was G1-9 + M1, L2)** (backend) — `worker/audit/admin-audit.ts`, `shared/audit.ts`. Deps: W0-01, W0-02, W1-01.
- Acceptance:
  - Typed action union = 0007 + 0008 vocabulary; auditStatement(...) returns a prepared statement for the caller batch.
  - INSERT stamps created_at with strftime('%Y-%m-%dT%H:%M:%fZ','now'), never a bound value (M1).
  - Per-action details allowlist builders (ids, counts, dates, section names only).
- Security: details <= 2,000 chars enforced before the DB; no PII fields possible by type; SB-10, SB-13.

**W1-10 · Shared text validator, payment-instruction detector, digit normaliser and Riyadh time helpers (new: TM-12, TM-04, UX-07, M2, C-3)** (backend) — `shared/text.ts`, `shared/timing.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - normalizeFreeText: NFC; refuses C0/C1 (optional newlines), U+061C, U+200E/F, U+202A-E, U+2066-9, U+200B, U+2060, U+FEFF, U+2028/9; allows ZWNJ/ZWJ; code-point caps; names also refuse URLs and @ handles (N-41).
  - findPaymentInstructionLike(text, studioDigits): IBAN-like tokens, digit runs >= 10, URL-like tokens (://, www., wa.me, t.me, bit.ly, bare domains), phone runs other than the studio number (N-33 table); toAsciiDigits for Arabic-Indic and Persian digits.
  - timing.ts: riyadhStartOfDay, riyadhLocalToInstant, riyadhTodayKey and constants BOOKING_HORIZON_DAYS 730, HOLD_GRACE_HOURS 72, ADMIN_SESSION_MAX_HOURS 12, RECENT_SIGN_IN_SECONDS 600, SETTINGS_DELAY_HOURS 24; tests cover the 21:00-24:00 Riyadh boundary (M2).
- Security: Pure functions, no I/O, no logging; Every free-text handler must call it (SB-16, SB-17); "today" is never SQL date('now'); TM-12, TM-04, M2.

**W1-11 · WhatsApp link library (was G1-11 + TM-19)** (frontend) — `src/lib/whatsapp.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - toWaMeDigits (E.164 digits or null, any digit script), buildWhatsAppUrlFor(number, message), isolateLtr(); existing exports unchanged.
  - Message length capped; the compiled public number stays the fallback and the check quoted to customers after a number change.
  - Links for +9665…, 05…, Arabic-Indic digits, invalid input (button disabled with a reason).
- Security: Number must match ^[1-9]\d{7,14}$ or no link is produced; message only through encodeURIComponent; verify.mjs: no wa.me literal outside this file (TM-19); SB-6, SB-12.

**W1-12 · Admin promotion by uid (was G1-12 + TM-02/B2, L2, TM-07)** (data) — `scripts/promote-admin.mjs`. Deps: W0-01, W0-02, W1-01.
- Acceptance:
  - node scripts/promote-admin.mjs --database <name> --uid <uid> --email <email> (--local | --remote) [--replace]; --email without --uid is a usage error (N-31).
  - UPDATE users SET role='admin', tokens_valid_after=<SQL now> WHERE id=? AND lower(email)=lower(?) AND email_verified_at IS NOT NULL AND erased_at IS NULL must change exactly 1 row; shows uid and stored email before the typed confirmation.
  - Writes admin_audit_log admin_promoted / admin_demoted with the promoted uid as actor in the same batch (L2); prints the Time Travel bookmark command first for --remote; verifies exactly one admin afterwards.
- Security: Only a uid validated ^[A-Za-z0-9]{1,128}$ and a validated email (quotes doubled) are templated; spawn with an argument array; never runs without an explicit target flag; No API writes users.role (grep gate); SB-4, SB-10.

**W1-13 · Test harness, verify script and merge hooks (new: M6, TM-17, TM-10, TM-19, TM-14)** (fullstack) — `package.json`, `scripts/verify.mjs`, `.githooks/pre-push`, `.githooks/pre-merge-commit`. Deps: W0-01, W0-02.
- Acceptance:
  - npm test = node --test on tests/ using node:test and node:sqlite only, with tests/setup/resolve-ts.mjs (a module.register hook mapping a missing .js specifier to its .ts sibling); no dependency.
  - npm run verify = lint + tsc -b + build (classic and cinematic) + tests + grep gates: console.* args only literals or code=/count=/job= templates; no env.MEDIA outside gates.ts; no wa.me outside src/lib/whatsapp.ts; storage APIs only for sy:intro:v1; no innerHTML/dangerouslySetInnerHTML/eval/new Function; no data:image in dist/client; no users.role write except the customer insert.
  - Hooks run verify on pre-push and block a merge commit into release/* unless verify passes; the RV gate records that verify ran.
- Security: No network access in tests; shell false for every spawn; No new dependency (package-lock unchanged); SB-7, SB-19.

**W1-14 · Bounded bodies for legacy handlers and API security headers (new: C-5, C-9 API part)** (backend) — `worker/http.ts`, `worker/profile.ts`, `worker/bookings.ts`, `worker/admin.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - readBoundedJson(request, maxBytes) in http.ts (Content-Length first, then a streamed byte counter so chunked bodies are capped) adopted by PUT /api/profile, POST /api/bookings and the blocked-dates handlers; over cap -> 413 (SEC-05 reproduction closed).
  - jsonResponse adds Strict-Transport-Security; existing behaviour otherwise identical (N-29).
- Security: C-5, C-9; No body echo in errors; SB-3, SB-9.

**W1-15 · Rate-limit and windowed-cap helpers (new: TM-11, C-4 core)** (backend) — `worker/ratelimit.ts`, `shared/limits.ts`. Deps: W0-01, W0-02, W1-03.
- Acceptance:
  - limitBurst(binding, key) wrapper over the ratelimits binding (60 s); missing binding -> allow + code=RL_BINDING_MISSING (fail-open by design).
  - shared/limits.ts holds the §3.1 table and the SQL windowed-cap constants used inside writing statements; 429 RATE_LIMITED with Retry-After.
- Security: Keys are uid or the connecting IP, never logged; SQL caps remain the hard bound; SB-15.

**W1-16 · MOT-01 Design switch foundation (unset -> classic; assetsInlineLimit 0)** (frontend) — `vite.config.ts`, `tsconfig.app.json`, `src/main.tsx`, `src/design/classic/boot.ts`, `src/design/cinematic/boot.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - 12 §8.2 MOT-01 as amended: 5 files justified; unset or empty VITE_SITE_DESIGN -> classic (H6); invalid value fails the build.
  - build.assetsInlineLimit: 0 so no data: URI can be emitted (TM-14).
  - Classic build identical to design-classic-v1 in CSS/DOM; cinematic differs only by data-design on <html>.
- Security: Allowlisted flag values, fail closed; Flag never embedded in client code; SC-0.

**W1-17 · MOT-03 Intro logo rasters** (frontend) — `scripts/make-brand-assets.mjs`, `src/data/brand-images.ts`, `public/images/brand/logo-ink-448.webp`, `public/images/brand/logo-ink-672.webp`. Deps: W0-01, W0-02.
- Acceptance:
  - 12 §8.2 MOT-03: existing brand files byte-identical; sizes <= 25 KB / 40 KB; visual check at 200%.
- Security: Reads only the local master; writes only public/images/brand/; No EXIF/XMP in outputs; SC-0.

**W1-18 · MOT-05 Route-chunk readiness API and loaded-module cache (+M5)** (frontend) — `src/layout/retryable-lazy.ts`, `src/layout/lazy-components.ts`. Deps: W0-01, W0-02.
- Acceptance:
  - 12 §8.2 MOT-05 as amended: whenReady() resolves on success and failure, never rejects; loadedModule() returns the resolved module synchronously once loaded (M5); routeReady(path).
  - Classic and cinematic behaviour unchanged (nothing calls it yet).
- Security: No new rejection paths; failed-chunk re-arm logic untouched; SC-0.

**W1-RV · Wave-1 adversarial review (was RV-1)** (docs) — `runs/redo-v2/security/golive/w1-review.md`. Deps: W1-01, W1-02, W1-03, W1-04, W1-05, W1-06, W1-07, W1-08, W1-09, W1-10, W1-11, W1-12, W1-13, W1-14, W1-15, W1-16, W1-17, W1-18.
- Acceptance:
  - Two independent reviewers per unit (appsec + domain); every diff checked against SB-1…SB-20 and the unit's listed controls.
  - Runs the database part of N-10, N-11…N-14, N-31, N-32, N-44, N-48, the migration tests, npm run verify and 12 A1/A2 for the motion units.
  - Verifies C-1, C-5 and C-16 against their SEC acceptance (TM-01); critical/high findings fixed before wave 2 (the owner cannot waive them).
- Security: Read-only review; local only; No production tokens.

#### Wave 2

**W2-01 · Admin settings API with delayed activation, content rules, kill switch and alerts (was G2-1 + TM-03, TM-04, TM-18, M1, H2, H3)** (backend) — `worker/settings/settings-write.ts`, `worker/settings/admin-settings-handlers.ts`, `worker/portal/slots/admin-settings.ts`, `worker/emails/admin-alert.ts`. Deps: W1-RV, W1-01, W1-02, W1-03, W1-04, W1-06, W1-09, W1-10, W1-15.
- Acceptance:
  - Endpoints #29-#34 and #43; revision + audit in one batch with SQL-stamped created_at; unchanged values -> unchanged: true.
  - Bank/contact change to an existing revision without a 2F claim -> effective_at = now + 24 h; first-ever and 2F-backed saves immediate; re-saving the effective values cancels a pending change; ADMIN_SETTINGS_2F=required -> 2F for bank/contact/deposit/terms (N-45).
  - Content rules on pickup, delivery-area names, terms body and summary -> 400 CONTENT_NOT_ALLOWED (N-33); pickup is AD+R (N-34); switch off = AD, on = AD+R.
  - Direct alert email to ADMIN_NOTIFICATION_EMAIL on each bank/contact/deposit/terms/switch change when email is configured (section and time only), skipped otherwise.
- Security: TM-03, TM-04, TM-12, TM-18, M1, H2, H3; RA/AD+S on sensitive writes; IBAN mod-97; E.164 digits; terms plain text only; Bank values never in audit details or alert emails; SB-2…SB-4, SB-10, SB-14, SB-17.

**W2-02 · Flow-aware booking state machine with grace, reinstate and offline confirmation (was G2-3 + C-17, B1, H3, TM-15, TM-20)** (fullstack) — `shared/admin.ts`, `worker/admin-workflow.ts`, `worker/admin.ts`, `src/components/BookingActions.tsx`. Deps: W1-RV, W1-01, W1-03, W1-06, W1-09, W1-10, W2-03, W2-04.
- Acceptance:
  - Action map of #18 incl. expire_hold, reinstate_hold, confirm_offline (AD+R); approve refuses past dates (SEC-19) and targets flow 2 only when OCe ∧ SET ∧ event >= today+3; targeted sweep excludes notice-protected holds and all flow-2 holds while AX is off.
  - extend_hold is a compare-and-swap on status and the read hold_expires_at, allowed up to deadline + 72 h while approved_hold, never past the event start; confirm_payment allowed within the same grace (N-30b); reinstate only when the date is free (DATE_NOT_FREE).
  - BookingActions shows the flow approve will take, the amount field with the bank-statement hint (TM-20), hours for extend, required reasons; flow-1 behaviour byte-identical (N-29); status email skipped when unchanged; notes shown to customers pass the content rules.
- Security: Every transition conditional on status + flow + deadline in one batch with the changes() guard; Server clock only; integers within the total; B1, H3, C-17, TM-15, TM-20; SB-2, SB-3, SB-5, SB-9, SB-10.

**W2-03 · Hold lifecycle jobs: protected holds, no auto-expiry without email, channel-aware reminders (was G2-14 + B1, H3, TM-15)** (backend) — `worker/jobs/hold-state.ts`, `worker/jobs/hold-expiry.ts`, `worker/jobs/hold-reminders.ts`, `worker/emails/hold.ts`. Deps: W1-RV, W1-01, W1-06.
- Acceptance:
  - Exported NOTICE_PROTECTED predicate: a deposit_notice_sent event whose details.holdExpiresAt equals the current hold_expires_at; the cron never expires such holds (N-50).
  - The cron expires flow-2 holds only when holdAutoExpiry (EM ∧ OCe); otherwise overdue holds stay approved_hold for the queue decide_now section; the kill switch stops expiry (N-52).
  - Reminder copy chooses between accept the terms, transfer and send the receipt on WhatsApp, and upload the receipt; legacy rows untouched; new claims use crypto.randomUUID tokens.
- Security: B1, H3, TM-15; Escaped templates; bidi isolation of reference and phone; no PII in dedupe keys; SB-6, SB-13.

**W2-04 · Legacy email copy: flow-2 approval deadline and name isolation (new: B1 #5, C-13 email part)** (backend) — `worker/email-templates.ts`. Deps: W1-RV, W1-10.
- Acceptance:
  - New status-email variant for flow-2 approvals stating the deadline (Riyadh time, isolated), the deposit amount and that the steps continue on the bookings page; flow-1 copy unchanged.
  - Names and references wrapped in bidi isolation after escapeHtml in every legacy template.
- Security: No bank details in any email (portal only); SB-6; B1, TM-12.

**W2-05 · Audit log, session, timeline, contact log and sign-out-everywhere API (was G2-4 + TM-07, UX-06)** (backend) — `worker/audit/admin-audit-handlers.ts`, `worker/portal/admin-booking-log.ts`, `worker/portal/slots/admin-audit.ts`, `worker/portal/slots/admin-booking-log.ts`. Deps: W1-RV, W1-01, W1-02, W1-04, W1-09.
- Acceptance:
  - #20, #21 (outcome opened|sent|dismissed -> admin_whatsapp_opened/sent/admin_queue_dismissed), #39, #40 (sessionFreshUntil, idleMinutes), #44 revoke-all (AD+R, tokens_valid_after = SQL now, audit admin_sessions_revoked).
  - Timeline merges three sources, <= 300 entries, notification rows without recipient or payload.
- Security: Admin-only; redacted notes stay hidden; keyset cursors validated; TM-07, UX-06; SB-2, SB-7, SB-13, SB-18.

**W2-06 · Event profile and consent with recent sign-in to grant (was G2-5 + TM-08, TM-11, TM-12)** (backend) — `shared/portal/event-profile.ts`, `worker/portal/event-profile.ts`, `worker/portal/slots/event-profile.ts`, `worker/portal/slots/admin-event-profile.ts`. Deps: W1-RV, W1-01, W1-02, W1-04, W1-10, W1-15.
- Acceptance:
  - #6-#8 and #22 on OwnedBooking; consent default NO; grant needs CO+R (N-39); withdrawal always allowed.
  - Events written only when a value changes; consent changes <= 10 per booking per day; burst limit (N-40).
  - Every free-text field through the shared validator; admin view returns grantedAt for the "not yet confirmed by the studio" label.
- Security: Ownership central + user_id bound in writes (TM-06); Free text treated as PII (never logged, purge-ready); TM-08, TM-11, TM-12; SB-2, SB-3, SB-13, SB-15, SB-16.

**W2-07 · Production (album) status (was G2-6)** (backend) — `shared/portal/production.ts`, `worker/portal/production.ts`, `worker/portal/slots/admin-production.ts`, `worker/emails/album.ts`. Deps: W1-RV, W1-01, W1-04, W1-10.
- Acceptance:
  - #23 on the production path (open while media is gated); event-passed rule uses the Riyadh date key; album_stage_changed; album_ready queued once only if EM.
- Security: Admin-only; stage enum; outbox dedupe; escaped copy; SB-2, SB-5, SB-6.

**W2-08 · Handover slots and admin handover with in-statement capacity rules (was G2-7 + TM-15, M2)** (backend) — `shared/portal/handover.ts`, `worker/portal/admin-handover-slots.ts`, `worker/portal/admin-handover.ts`, `worker/portal/slots/admin-handover.ts`. Deps: W1-RV, W1-01, W1-04, W1-09, W1-10.
- Acceptance:
  - #24, #28 incl. bulk generate (<= 200, Riyadh -> UTC via riyadhLocalToInstant).
  - Capacity decrease is a conditional UPDATE; deactivation refused while scheduled handovers exist; reassign uses the capacity predicate excluding its own row; completion stamps both completed_at columns in one batch; audit rows.
- Security: Generation bounds (range <= 92 d, <= 200 slots, times validated); Admin-only; TM-15; SB-4, SB-5, SB-10.

**W2-09 · Feedback (was G2-8 + TM-12, TM-11)** (backend) — `shared/portal/feedback.ts`, `worker/portal/feedback.ts`, `worker/portal/slots/feedback.ts`, `worker/portal/slots/admin-feedback.ts`. Deps: W1-RV, W1-01, W1-04, W1-10, W1-15.
- Acceptance:
  - #12, #25 on OwnedBooking; compare-on-retry; never published; comment through the shared validator.
- Security: Ownership; one row per booking (PK); comment <= 1000 rendered as text; SB-2, SB-3, SB-6, SB-15, SB-16.

**W2-10 · Work queue API: decide-now, fixed priority, one-tap WhatsApp data (was G2-9 + B1, UX-02, UX-03, UX-05, UX-06, TM-03)** (backend) — `shared/portal/admin-queue.ts`, `worker/portal/admin-queue.ts`, `worker/portal/slots/admin-queue.ts`. Deps: W1-RV, W1-01, W1-04, W1-06, W1-10, W2-03.
- Acceptance:
  - #35 shape: summary, health (incl. cspViolations24h), alerts (SETTINGS_CHANGE_PENDING, KILL_SWITCH_OFF…), sections in the fixed order with decide_now first; empty sections omitted.
  - Items carry reference, waDigits (validated ^[1-9]\d{7,14}$), templateInputs, lastContact; today/tomorrow events add startTime and venueArea.
  - An item leaves only on a state change or a sent/dismissed contact-log row (UX-06); seeded data shows every section; <= 50 items per section.
- Security: Admin-only; first names only; waDigits used only in hrefs (never rendered as text); SB-13 minimisation note lists the admin-only fields; B1, UX-02, UX-03, UX-05, UX-06; SB-2, SB-13.

**W2-11 · Calendar and customers directory (was G2-10; search moves to W3-02)** (backend) — `shared/portal/admin-directory.ts`, `worker/portal/admin-calendar.ts`, `worker/portal/admin-customers.ts`, `worker/portal/slots/admin-directory.ts`. Deps: W1-RV, W1-01, W1-04, W1-10.
- Acceptance:
  - #36, #37 without q; month parsing strict; keyset on users (created_at, id) with its own cursor validator (CURRENT_TIMESTAMP format); erased users excluded; contactChangedAt exposed.
- Security: Limits <= 100; admin-only; SB-2, SB-4.

**W2-12 · CSV export with extended neutralisation (was G2-11 + TM-13)** (backend) — `worker/csv.ts`, `worker/portal/admin-export.ts`, `worker/portal/slots/admin-export.ts`. Deps: W1-RV, W1-02, W1-04, W1-09.
- Acceptance:
  - #38 exactly; worker/csv.ts pure functions with tests/csv.test.mjs covering =HYPERLINK, +SUM, -1+1, @cmd, TAB/CR, full-width ＝＋－＠, |cmd, U+202E, U+2028, zero-width (N-09, N-42).
  - Numeric columns emitted as unprefixed integers; the file opens with Arabic intact in Excel, LibreOffice, Google Sheets and Numbers.
- Security: RA; range and row caps; audit row written before the body is returned; Attachment disposition with an ASCII filename; X-Frame-Options DENY; TM-13; SB-6, SB-10, SB-14.

**W2-13 · Customer confirmation API: effective bank details, accepted-terms view, protecting notices (was G2-12 + TM-03, TM-16, TM-18, B1, UX-08)** (backend) — `shared/portal/confirmation.ts`, `worker/portal/confirmation.ts`, `worker/portal/slots/confirmation.ts`. Deps: W1-RV, W1-01, W1-03, W1-04, W1-06, W1-10, W1-15.
- Acceptance:
  - #2-#4: OCe closed -> 503; bank details from the effective revision only after acceptance, IBAN normalised (24 chars); bankDetailsChangedSinceAcceptance; studio number and change time.
  - acceptedTerms returns the exact accepted version read-only; terms_accepted details carry bodySha256 (TM-18).
  - The notice records once per deadline, never changes status or deadline, returns holdProtected: true; accepted within the grace window while approved_hold; IDOR and stale-version cases (N-04, N-16, N-19, N-36).
- Security: Ownership + flow + deadline inside the write; bank details only to the owner of a flow-2 booking in an owed state; No receipt URLs; pending bank revisions never exposed; TM-03, TM-16, TM-18, B1; SB-2, SB-3, SB-5, SB-13, SB-15.

**W2-14 · WhatsApp message templates, admin to customer (was G2-15 + UX-15, TM-19)** (frontend) — `src/features/admin-contact/whatsapp-templates.ts`. Deps: W1-RV, W1-11.
- Acceptance:
  - Closed template ids (request_received, approved_online, approved_legacy, hold_reminder, terms_reminder, deposit_recorded, event_details_request, event_reminder, production_update, album_ready, handover_confirmation, handover_day, feedback_request, offline_selection); approved_online states the deadline in Riyadh time.
  - Arabic, feminine, studio voice, aligned with 08-copy-ar.md and reviewed by the copy reviewer; messages under the length cap.
- Security: Templates never include bank details or any link other than the site origin; Pure functions; no PII beyond what the message needs; SB-6, SB-13.

**W2-15 · Profile hardening: verified-email ownership, recent sign-in for contact changes (new: C-2, C-4, TM-08, TM-12, SEC-14)** (backend) — `worker/profile.ts`. Deps: W1-RV, W1-01, W1-02, W1-10, W1-15.
- Acceptance:
  - users.email written only from a verified token (email_verified_at stamped); an unverified conflicting row without bookings can be reclaimed by the verified owner; unverified registration still works (SEC-04 reproduction closed).
  - Erased user -> 410 (SEC-14); phone/email change on an existing row needs CO+R and stamps contact_changed_at (TM-08); names through the validator, URLs refused; RL_PROFILE burst.
- Security: C-2, C-4, TM-08, TM-12; No email or phone in logs; SB-1, SB-3, SB-15, SB-16, SB-18.

**W2-16 · Journey facts v2 and /me additions: deposit_reported, stage times, studio number changes (was G2-2 + UX-02, UX-14, TM-03, TM-19)** (backend) — `shared/journey.ts`, `worker/portal/journey-loader.ts`, `worker/bookings.ts`, `src/api/bookings.ts`. Deps: W1-RV, W1-01, W1-06.
- Acceptance:
  - JourneyFacts gains termsAcceptedAt, noticeForCurrentDeadline, stageUpdatedAt; sub-states awaiting_deposit and deposit_reported; loadJourneyRecordsByBookingIds(env, ids <= 100) for admin use.
  - /me adds termsAcceptedAt, stageUpdatedAt and studio {whatsappNumber, whatsappNumberChangedAt} from the effective contact revision; client parser accepts old and new shapes; legacy rows unchanged.
- Security: /me still filtered by uid; loader by ids is admin-only; Bound IN (?…) list built from a count; UX-02, UX-14; SB-2, SB-4.

**W2-17 · Worker entry hardening: preview read-only, CSP report route, cached availability (new: C-8, C-10, TM-11, TM-17)** (backend) — `worker/index.ts`, `worker/csp-report.ts`. Deps: W1-RV, W1-01, W1-03, W1-15.
- Acceptance:
  - PREVIEW_READ_ONLY="on" -> every non-GET /api/* except /api/csp-report answers 403 PREVIEW_READ_ONLY, and preview responses carry X-Robots-Tag noindex.
  - /api/availability served with a 60 s edge cache (no personal data in the key) and an IP burst limit.
  - POST /api/csp-report: reports+json and csp-report, <= 8 KiB, burst-limited, stores only day + directive + blocked origin counts (<= 200 rows/day), 204.
- Security: No URL or report body stored; Bounded body; no auth required but limited; C-8, C-10, TM-11, TM-17; SB-3, SB-7, SB-15.

**W2-18 · Security headers, CSP reporting and Firebase config guard (was G1-10 + H1, C-9, C-10, TM-14)** (fullstack) — `vite.config.ts`, `public/_headers`, `scripts/config-guard.mjs`. Deps: W1-RV, W1-16.
- Acceptance:
  - config-guard.mjs pure checks shared with the release preflight: VITE_FIREBASE_PROJECT_ID equals the FIREBASE_PROJECT_ID of the CLOUDFLARE_ENV being built; auth domain is <projectId>.firebaseapp.com and appears in frame-src; the inline-script hash of index.html is in _headers (N-53).
  - _headers: COOP same-origin on the SPA, img-src self blob:, Reporting-Endpoints + report-to + report-uri /api/csp-report, a separate Report-Only require-trusted-types-for 'script'; still Report-Only.
  - A build-time CSP_MODE=enforce option (not exposed to the client) emits the enforced header for preview trials; env files per mode documented (.env.development.local, .env.preview.local, .env.production.local).
- Security: Hostnames validated before use; no env values printed; H1, C-9, C-10, TM-14; SB-6, SB-8, SB-19.

**W2-19 · MOT-02 Design build and dev scripts (deploy moved to W3-19)** (frontend) — `package.json`, `scripts/build-design.mjs`, `src/styles/README.md`. Deps: W1-RV, W1-16.
- Acceptance:
  - 12 §8.2 MOT-02 as amended: build/dev only (no --deploy, no --allow-dirty); marker check; strict argument allowlist; CLOUDFLARE_ENV set or removed explicitly.
- Security: shell false with argument arrays; No secrets read or printed; SC-0.

**W2-20 · MOT-04 Cinematic tokens, hero entrance, scroll reveals, wipes, parallax (+UX-09 entry guard, UX-10, UX-12)** (motion) — `src/design/cinematic/boot.ts`, `src/design/cinematic/tokens.css`, `src/design/cinematic/hero.css`, `src/design/cinematic/scroll.css`. Deps: W1-RV, W1-16.
- Acceptance:
  - 12 §8.2 MOT-04 as amended: VT timings shortened, corners in --cine-gold with an ink hairline, photo wipes only through the reveal contract (a filter change adds no motion), E2/E7 suppressed under data-cine-entry.
- Security: Every selector prefixed :root[data-design="cinematic"]; no hex; no url(); SC-0.

**W2-21 · MOT-06 Motion audit and classic-parity tool (+M7, TM-22, UX-01 metrics)** (frontend) — `scripts/motion-audit.mjs`. Deps: W1-RV, W1-16.
- Acceptance:
  - 12 §8.2 MOT-06 as amended: parity hard gate = DOM + emitted-CSS hashes; screenshots after fonts.ready and decode with <= 0.1% tolerance; Firebase config stubbed; npm ci in the worktree; reports logo-not-ready rate and hero readiness time.
- Security: Chrome --remote-debugging-port=0 on 127.0.0.1 with a temp profile, killed on exit; never prints VITE_* values; Fetch interception keeps traffic on 127.0.0.1; TM-22; SC-0.

**W2-RV · Wave-2 adversarial review (was RV-2)** (docs) — `runs/redo-v2/security/golive/w2-review.md`. Deps: W2-01, W2-02, W2-03, W2-04, W2-05, W2-06, W2-07, W2-08, W2-09, W2-10, W2-11, W2-12, W2-13, W2-14, W2-15, W2-16, W2-17, W2-18, W2-19, W2-20, W2-21.
- Acceptance:
  - Two reviewers per unit; runs N-01…N-11, N-15…N-19, N-22, N-26, N-29, N-30, N-30b, N-33, N-34, N-36, N-39, N-40, N-41, N-42, N-45, N-50, N-52, N-53 with curl against local.
  - Verifies C-2 (profile), C-8, C-9, C-10 (report route), C-17 against SEC acceptance; 12 A1-A6 for motion units.
- Security: Read-only; local only; no production tokens.

#### Wave 3

**W3-01 · Customer handover API with active-area and re-book rules (was G3-1 + TM-06, TM-08, TM-15)** (backend) — `worker/portal/handover.ts`, `worker/portal/slots/handover.ts`. Deps: W2-RV, W1-02, W1-06, W1-10, W1-15, W2-08.
- Acceptance:
  - #9-#11 on OwnedBooking; delivery booking needs CO+R; delivery_areas.is_active = 1 inside the INSERT; re-book after no_show/cancelled excludes its own row.
  - Concurrency test N-18 (two customers, last slot -> exactly one success); N-36.
- Security: The §2.3-verified conditional insert; address treated as PII; full slots hidden; TM-06, TM-08, TM-15; SB-2, SB-5, SB-13, SB-16.

**W3-02 · Admin search by POST, detail enrichment and blocked-date audit (was G3-2 + TM-17, TM-08)** (fullstack) — `worker/admin.ts`, `shared/admin.ts`, `src/api/admin.ts`, `worker/portal/admin-search.ts`, `worker/portal/slots/admin-search.ts`. Deps: W2-RV, W1-09, W2-01, W2-02, W2-16.
- Acceptance:
  - 5 files justified: the POST search reuses the list builder and the same summary type.
  - #16 (customerId + stage fields, no q), #17 enrichment (noticeProtected, customerContactChangedSinceBooking, consent), #41/#42 POST search; blocked-date create/delete write admin_audit_log in the same batch.
  - Client parsers extended; pagination with a query stable; the query text never appears in a URL.
- Security: LIKE escaped with ESCAPE '\'; q validated and digit-normalised; stage loading bounded to the page; RL_ADMIN_READ; TM-17; SB-4, SB-10, SB-15.

**W3-03 · Event and handover reminder jobs (was G3-4 + TM-15)** (backend) — `worker/jobs/event-reminders.ts`, `worker/jobs/handover-reminders.ts`, `worker/emails/journey.ts`, `worker/jobs/registry.ts`. Deps: W2-RV, W2-06, W2-08.
- Acceptance:
  - -7 d/-1 d event reminders while confirmed, -1 d handover reminder, send window 09-21 Riyadh, anchors per ADR §2.2; skipped without EM; heartbeat rows; bounded per tick.
  - Random claim tokens; eligibility re-checked or the row superseded before sending (N-46).
- Security: Outbox dedupe keys without PII; escaped templates; TM-15; SB-6, SB-7, SB-13.

**W3-04 · Admin settings tab with pending-change banner and kill switch (was G3-5 + TM-03, TM-04, H3, UX-07, UX-16)** (frontend) — `src/features/admin-settings/AdminSettingsTab.tsx`, `src/features/admin-settings/settings-api.ts`, `src/features/admin-settings/BankAccountForm.tsx`, `src/features/admin-settings/registration.ts`. Deps: W2-RV, W1-05, W1-07, W1-08, W1-10, W2-01, W2-05.
- Acceptance:
  - Tab «الإعدادات»: feature status (why online confirmation is not offered), deposit rule with a live example, bank form (grouped IBAN, checksum hint, re-auth before submit), WhatsApp number, pickup.
  - Pending-change banner with the effective time and «إلغاء التغيير» (re-saves the effective values); 72 h change banner; kill-switch card (off with a confirmation, on with re-auth).
  - Digits normalised on input; inputmode and dir="ltr" on IBAN and phone; content-rule errors shown inline; keyboard, RTL, visible focus, loading/empty/error states.
- Security: IBAN typed by the admin only; masked in lists except while editing; autocomplete off on bank fields; no drafts in storage; TM-03, TM-04, H3, UX-07; SB-12, SB-14.

**W3-05 · Admin work queue tab: one-tap WhatsApp, sent/dismiss, live count (was G3-6 + UX-03, UX-04, UX-05, UX-06)** (frontend) — `src/features/admin-queue/AdminQueueTab.tsx`, `src/features/admin-queue/queue-api.ts`, `src/features/admin-queue/registration.ts`. Deps: W2-RV, W1-11, W2-05, W2-10, W2-14.
- Acceptance:
  - «اليوم» summary, sections in server order, empty sections hidden, due times server-time corrected.
  - Each item renders a real <a href="https://wa.me/…" target="_blank" rel="noopener noreferrer"> from its own data: 1 tap from /admin to a prefilled chat at 375 x 812 (UX-03); «فُتح واتساب قبل {n}» with «تم الإرسال» and «تجاهل» (UX-06).
  - Pending count in document.title; refetch on visibilitychange and focus; «آخر تحديث» (UX-04); empty state «لا يوجد ما يحتاج متابعة اليوم».
- Security: Links only through the W1-11 builder; phone digits never rendered as text; SB-12.

**W3-06 · Admin calendar tab with an agenda list on phones (was G3-7 + UX-13)** (frontend) — `src/features/admin-calendar/AdminCalendarTab.tsx`, `src/features/admin-calendar/calendar-api.ts`, `src/features/admin-calendar/registration.ts`. Deps: W2-RV, W2-11.
- Acceptance:
  - Month grid (Riyadh dates) on wide screens and an agenda/week list by default below 48rem; blocked days; bookings with status icon + text; RTL arrow mapping as in BookingCalendar; month switching aborts stale requests.
- Security: Text rendering only; aborts on unmount; SB-12.

**W3-07 · Admin contact section with safe links and change labels (was G3-8 + TM-12, TM-08, UX-06)** (frontend) — `src/features/admin-contact/AdminContactSection.tsx`, `src/features/admin-contact/registration.ts`. Deps: W2-RV, W2-02, W2-05, W2-14.
- Acceptance:
  - Customer name/phone/email wrapped in <bdi>, copy buttons, templates relevant to the stage first, last contact per template with outcome; «تغيّر رقم الجوال بعد إنشاء الحجز» label.
  - mailto:/tel: built only with fixed schemes and encodeURIComponent; no href from free text.
- Security: Clipboard writes only on click; TM-12, TM-08; SB-6, SB-12.

**W3-08 · Admin timeline section (was G3-9)** (frontend) — `src/features/admin-timeline/AdminTimelineSection.tsx`, `src/features/admin-timeline/timeline-api.ts`, `src/features/admin-timeline/registration.ts`. Deps: W2-RV, W2-05.
- Acceptance:
  - Merged timeline with Arabic labels per event kind (incl. hold_reinstated, terms_accepted_offline, admin_whatsapp_sent), actor, Riyadh time, email status; loads on demand.
- Security: Details rendered through a whitelist of known keys, never raw JSON as HTML; SB-6.

**W3-09 · Admin customers tab with POST search (was G3-10 + TM-17)** (frontend) — `src/features/admin-customers/AdminCustomersTab.tsx`, `src/features/admin-customers/customers-api.ts`, `src/features/admin-customers/registration.ts`. Deps: W2-RV, W2-11, W2-14, W3-02.
- Acceptance:
  - Search through POST #42 (in memory, debounced, aborts), list with booking counts, customer detail with bookings, WhatsApp button.
- Security: Search text never in a URL; results limited; text rendering in <bdi>; TM-17; SB-12.

**W3-10 · Admin handover section and slots tab (was G3-11 + UX-13)** (frontend) — `src/features/admin-handover/AdminHandoverSection.tsx`, `src/features/admin-handover/AdminSlotsTab.tsx`, `src/features/admin-handover/handover-admin-api.ts`, `src/features/admin-handover/registration.ts`. Deps: W2-RV, W2-08.
- Acceptance:
  - Slot list by date with fill rate, create/generate/deactivate/delete with confirmations and the in-statement refusals surfaced; booking section with method, slot, address (delivery), complete/no-show/cancel/reassign; 44 px targets.
- Security: Destructive actions confirmed with the safe button focused; address shown only in the booking section; SB-12, SB-13.

**W3-11 · Admin production and event-profile sections (was G3-12 + TM-08)** (frontend) — `src/features/admin-production/AdminProductionSection.tsx`, `src/features/admin-production/registration.ts`, `src/features/admin-event-profile/AdminEventProfileSection.tsx`, `src/features/admin-event-profile/registration.ts`. Deps: W2-RV, W2-06, W2-07.
- Acceptance:
  - Stage control (design/printing/ready) visible only after the event; profile and consent history; «الموافقة على النشر: لا» by default; a granted consent shows «موافقة على النشر من العروس، لم يؤكدها الاستوديو بعد» (text + icon).
- Security: Consent read-only to the admin; text rendering in <bdi>; TM-08; SB-6, SB-13.

**W3-12 · Admin feedback section and audit log tab (was G3-13)** (frontend) — `src/features/admin-feedback/AdminFeedbackSection.tsx`, `src/features/admin-feedback/registration.ts`, `src/features/admin-audit/AdminAuditTab.tsx`, `src/features/admin-audit/registration.ts`. Deps: W2-RV, W2-05, W2-09.
- Acceptance:
  - Read-only feedback; audit list with Arabic action labels (incl. admin_promoted, admin_sessions_revoked, online_confirmation_switched), re-auth marker, pagination.
- Security: No edit/delete affordances; text rendering; SB-6, SB-10.

**W3-13 · Customer event-details view and .ics, consent re-auth, privacy link (was G3-14 + TM-08, H4, UX-07)** (frontend) — `src/features/event-profile/EventDetailsStageView.tsx`, `src/features/event-profile/event-profile-api.ts`, `src/features/event-profile/ics.ts`, `src/features/event-profile/registration.ts`. Deps: W2-RV, W1-08, W2-06, W3-16.
- Acceptance:
  - Form with limits and Arabic validation; consent toggle default «لا»; granting opens the re-auth dialog when the sign-in is older than 10 minutes; withdrawal note.
  - Link to /privacy at the point of collection (H4); digits normalised; countdown; .ics (all-day, CRLF, escaped text, no PII beyond the event title) through a revoked Blob URL.
- Security: .ics escaping; no venue text in the file name; object URL revoked; TM-08, H4; SB-6, SB-12, SB-13.

**W3-14 · Customer feedback view (was G3-15)** (frontend) — `src/features/feedback/FeedbackStageView.tsx`, `src/features/feedback/feedback-api.ts`, `src/features/feedback/registration.ts`. Deps: W2-RV, W2-09.
- Acceptance:
  - Rating as a radio group with text labels, optional comment, thank-you state, «لن يُنشر رأيكِ دون إذنكِ»; 44 px targets.
- Security: Text rendering; single submission; SB-6.

**W3-15 · Booking-request hardening: open-request cap, horizon, limits, email re-sync (new: C-3, C-4, C-2)** (fullstack) — `worker/bookings.ts`, `src/components/BookingCalendar.tsx`. Deps: W2-RV, W1-10, W1-15, W2-15.
- Acceptance:
  - POST /api/bookings: <= 3 open requests and <= 5 per hour inside the INSERT (409 OPEN_REQUEST_LIMIT / 429), event date between Riyadh today and today + 730 days (400 DATE_BEYOND_HORIZON), RL_BOOKING burst; SEC-03 reproduction closed.
  - Stored email re-synced from the verified token (C-2); BookingCalendar max date = horizon; legacy success path identical (N-29).
- Security: C-3, C-4, C-2; Caps atomic inside the statement; SB-5, SB-15.

**W3-16 · Privacy notice and e-commerce disclosure routes (new: H4, C-11, SEC-15)** (frontend) — `src/pages/LegalPage.tsx`, `src/data/legal-texts.ts`, `src/layout/navigation.ts`, `src/layout/route-meta.ts`, `src/layout/lazy-components.ts`, `src/App.tsx`. Deps: W2-RV.
- Acceptance:
  - 6 files justified: the custom router needs the path type, meta, lazy registration and the switch case atomically; no React Router.
  - /privacy and /disclosure render owner- and lawyer-supplied plain text from legal-texts.ts; nothing is invented; a missing text is an explicit placeholder that the release preflight refuses (H4 precondition).
  - Classic and cinematic parity for every existing route unchanged.
- Security: Text rendered as React text; no HTML or markdown; H4, C-11; SB-6, SB-13.

**W3-17 · MOT-07 Display headings (Arabic-safe words) and hero H1 (+UX-17, entry guard)** (motion) — `src/design/cinematic/DisplayHeading.tsx`, `src/design/cinematic/words.css`, `src/design/classic/DisplayHeading.tsx`, `src/pages/home/HeroSection.tsx`. Deps: W2-RV, W2-20.
- Acceptance:
  - 12 §8.2 MOT-07 as amended: TalkBack/Chrome Android and VoiceOver iOS (one stop per heading); resting line breaks with motion on = classic at 320/375/768; E5 suppressed under data-cine-entry.
- Security: String prop rendered as React text; --wi from a clamped integer; SC-0.

**W3-18 · MOT-08 Gold khatam ornament and story mark** (motion) — `src/design/cinematic/Khatam.tsx`, `src/design/cinematic/khatam.css`, `src/design/classic/Khatam.tsx`, `src/pages/home/StorySection.tsx`. Deps: W2-RV, W2-20.
- Acceptance:
  - 12 §8.2 MOT-08: geometry per §5.1, draws counter-clockwise from the top, reduced motion fully drawn, decorative.
- Security: Static path data only; SC-0.

**W3-19 · Release tooling: one deploy path with preflight, tag rule and launch floor (new: TM-05, H6, B3, TM-21, L3, H1, H4)** (fullstack) — `scripts/release-preflight.mjs`, `scripts/release.mjs`, `package.json`. Deps: W2-RV, W1-03, W2-18, W2-19.
- Acceptance:
  - release-preflight.mjs asserts from the generated wrangler.json and dist: account_id and name; real production D1 id; no r2_buckets; preview_urls false; ONLINE_CONFIRMATION expected; no PDPL_SIGNOFF_REF/MEDIA_SIGNING_KEY in vars; ADMIN_MEDIA_MFA "required"; Firebase ids and auth domain (config-guard); _headers hash; design markers; legal texts present; no data:image and no secret patterns (N-35).
  - release.mjs --env=production|preview --design=classic|cinematic [--rollback <version>]: clean tree; production only from an annotated release-* tag that passed the gate; design pinned; right Vite mode; preflight; prints target, design and commit and asks for a typed go-ahead; wrangler deploy --tag --message; appends to the release log (N-54).
  - --rollback refuses versions below the recorded launch floor (N-62); package.json deploy:* scripts all route to release.mjs; --allow-dirty does not exist.
- Security: shell false with argument arrays; never prints env values; TM-05, H6, B3, TM-21, L3; SB-8, SB-19.

**W3-20 · Booking request form: quantity ceilings and WhatsApp after submit (new: C-12, UX-04)** (frontend) — `shared/booking.ts`, `src/data/packages.ts`, `src/components/PackageConfigurator.tsx`, `src/components/PackageConfigurator.css`. Deps: W2-RV, W1-11.
- Acceptance:
  - Per-item maximum quantities enforced by the shared validator (server and client); prices unchanged (SEC-09).
  - Success state shows a real <a> «أرسلي رقم طلبكِ للاستوديو عبر واتساب» with the reference prefilled and «سنراجع طلبكِ ونتواصل معكِ عبر واتساب»; no response time unless the owner provides one.
- Security: Link through the W1-11 builder with the compiled public number; C-12, UX-04; SB-3, SB-12.

**W3-RV · Wave-3 adversarial review (was RV-3)** (docs) — `runs/redo-v2/security/golive/w3-review.md`. Deps: W3-01, W3-02, W3-03, W3-04, W3-05, W3-06, W3-07, W3-08, W3-09, W3-10, W3-11, W3-12, W3-13, W3-14, W3-15, W3-16, W3-17, W3-18, W3-19, W3-20.
- Acceptance:
  - Two reviewers per unit; UI XSS sweep (N-20), N-08, N-09, N-18, N-21, N-35, N-46, N-54, N-55, N-57, N-62, accessibility spot checks (44 px, contrast, keyboard).
  - Verifies C-3, C-4, C-11 against SEC acceptance.
- Security: Read-only; local only.

#### Wave 4

**W4-01 · Customer confirmation view: terms inline, safe IBAN copy, changed-bank and number notices (was G4-1 + TM-16, UX-08, UX-15, TM-03, TM-18, UX-02)** (frontend) — `src/features/confirmation/ConfirmationStageView.tsx`, `src/features/confirmation/confirmation-api.ts`, `src/features/confirmation/DepositInstructions.tsx`, `src/features/confirmation/registration.ts`. Deps: W3-RV, W1-11, W2-13, W2-16.
- Acceptance:
  - Step 1 terms rendered inline (or in a disclosure) without scroll-to-end, the whole checkbox row is the >= 44 px label, version shown; the accepted version stays viewable read-only.
  - Step 2 amount + bank details: IBAN grouped inside <bdi dir="ltr">, copy buttons copy the raw 24-character IBAN and digit-only amount and announce «تم النسخ»; «آخر تحديث لبيانات الحساب»; changed-bank warning with a WhatsApp link; 72 h number-changed notice quoting the compiled number.
  - Step 3: «بعد التحويل، أرفقي صورة الإيصال في محادثة واتساب», button «أرسلي صورة الإيصال عبر واتساب» (prefilled with reference, amount and «أرسلتُ إيصال العربون»), notice via keepalive; then «أبلغتِنا بالتحويل، وسنؤكد استلام العربون ونبلغكِ»; countdown with server offset; expired and TERMS_VERSION_MISMATCH states.
- Security: Bank details and terms rendered as plain text, no autolink; nothing stored locally; N-56 (paste yields exactly 24 characters); TM-16, UX-08, TM-03; SB-6, SB-12.

**W4-02 · Customer handover view with delivery re-auth and privacy link (was G4-2 + TM-08, H4, UX-13)** (frontend) — `src/features/handover/HandoverStageView.tsx`, `src/features/handover/SlotPicker.tsx`, `src/features/handover/handover-api.ts`, `src/features/handover/registration.ts`. Deps: W3-RV, W1-08, W3-01.
- Acceptance:
  - Pickup vs delivery (area + fee, address fields with digit normalisation), slot picker (keyboard, grouped by day, Riyadh times, 44 px targets), SLOT_UNAVAILABLE recovery, WhatsApp final step on handover day.
  - Booking a delivery opens the re-auth dialog when the sign-in is older than 10 minutes; link to /privacy next to the address fields; pickup text rendered plain without autolink.
- Security: Address never echoed into URLs or logs; validation mirrors the server; TM-08, H4; SB-12, SB-13.

**W4-03 · Admin bookings: POST search, export, queue landing, four-destination mobile layout, idle sign-out (was G4-3 + UX-05, TM-07, TM-13, TM-17)** (frontend) — `src/components/AdminDashboard.tsx`, `src/components/AdminDashboard.css`, `src/features/admin-export/ExportBookingsDialog.tsx`, `src/features/admin-portal/admin-location.ts`. Deps: W3-RV, W1-08, W2-12, W3-02, W3-05.
- Acceptance:
  - Search box through POST #41 combined with filters (in memory), result count; export dialog (date range, status, re-auth, PII warning «يحتوي الملف على بيانات شخصية. احذفيه بعد الاستخدام», Blob download, revoke).
  - Below 48rem at most four primary destinations «اليوم»، «الحجوزات»، «التقويم»، «المزيد»; booking detail on phones has a sticky summary (first name, event date, stage, deadline) with the primary action and WhatsApp first; default landing = queue; existing deep links still work.
  - Mounts startIdleSignOut(30) for the admin shell; REAUTH_REQUIRED after 12 h opens the re-auth dialog.
- Security: Query text never written to the address bar or an API URL; export only via requestBlob; object URL revoked; TM-07, TM-13, TM-17, UX-05; SB-12, SB-14, SB-18.

**W4-04 · Admin deposit and terms section (was G4-4 + TM-20)** (frontend) — `src/features/admin-deposit/AdminDepositSection.tsx`, `src/features/admin-deposit/registration.ts`. Deps: W3-RV, W3-02.
- Acceptance:
  - Expected vs received amount, terms version/time (incl. offline), bank revision vs effective (warning), notices with the hold-protected marker, next-action hint; states that notices, receipts and hash matches are not proof of payment.
- Security: Read-only; text rendering; TM-20; SB-6.

**W4-05 · Customer hub integration: deposit_reported, last updated, one next step per stage (was G4-5 + UX-14, UX-02, UX-15, TM-03, TM-19)** (frontend) — `src/components/MyBookings.tsx`, `src/features/journey/hub-model.ts`, `src/components/MyBookings.css`. Deps: W3-RV, W1-11, W2-16.
- Acceptance:
  - Studio number from /me (fallback constant) with the 72 h number-changed notice; awaiting_deposit and deposit_reported copy; pending_review «سنراجع طلبكِ ونتواصل معكِ عبر واتساب».
  - Gated-mode awaiting_previews «سنرسل لكِ الصور عبر واتساب لتختاري منها» with a WhatsApp link; «آخر تحديث: {date}» on production stages; every stage card has exactly one primary action or an explicit "nothing needed until {date}" line; next step and deadline above the fold at 375 px.
- Security: No new storage; links via W1-11; UX-02, UX-14, TM-19; SB-12.

**W4-06 · Admin settings: terms editor, delivery areas, history with pending changes (was G4-6 + TM-04, TM-18, TM-03)** (frontend) — `src/features/admin-settings/TermsEditor.tsx`, `src/features/admin-settings/DeliveryAreasEditor.tsx`, `src/features/admin-settings/SettingsHistory.tsx`, `src/features/admin-settings/AdminSettingsTab.tsx`. Deps: W3-RV, W3-04.
- Acceptance:
  - Plain-text editor with the compliance topic checklist from 02-compliance.md (topics only, no invented legal text), diff against the current version, publish with re-auth + optimistic concurrency; content-rule errors inline.
  - Areas CRUD (no delete); history per section with effective time and pending marker.
- Security: Terms rendered as text; RA/AD+S; no local drafts of terms or bank data; TM-04, TM-18; SB-6, SB-14.

**W4-07 · Feedback request job (was G4-9 + TM-15)** (backend) — `worker/jobs/feedback-request.ts`, `worker/jobs/registry.ts`, `worker/emails/journey.ts`. Deps: W3-RV, W2-09, W3-03.
- Acceptance:
  - +2 d after completion, once, only if no feedback and no feedback_request sent; skipped without EM; random claim tokens; eligibility re-check before send.
- Security: Dedupe; escaped copy; TM-15; SB-6.

**W4-08 · Privacy links at every point of collection: auth dialog and footer (new: H4, C-11)** (frontend) — `src/components/AuthDialog.tsx`, `src/layout/SiteFooter.tsx`. Deps: W3-RV, W3-16.
- Acceptance:
  - Registration form links /privacy before collecting the name and phone; footer links /privacy and /disclosure; classic parity report attributes the footer difference to this unit.
- Security: No new listener; existing AuthDialog only; H4, C-11; SB-12.

**W4-09 · MOT-09 SPA page transitions (+UX-09, M5)** (motion) — `src/App.tsx`, `src/design/cinematic/page-transition.ts`, `src/design/cinematic/transitions.css`, `src/design/classic/page-transition.ts`. Deps: W3-RV, W1-18, W2-20, W3-16.
- Acceptance:
  - 12 §8.2 MOT-09 as amended: 450 ms veil, ::view-transition pointer-events none, pending feedback, mobile menu closes instantly, data-cine-entry="vt" suppresses E5/E7, router renders loadedModule() so the snapshot contains the destination H1 (M5).
- Security: Primitives computed synchronously; every VT promise handled; /admin excluded; SC-0.

**W4-10 · MOT-12 Display headings and ornament on the remaining surfaces (+UX-12)** (frontend) — `src/pages/home/StorySection.tsx`, `src/pages/sections/ContactSection.tsx`, `src/pages/PortfolioPage.tsx`, `src/pages/PackagesPage.tsx`. Deps: W3-RV, W3-17, W3-18.
- Acceptance:
  - 12 §8.2 MOT-12 as amended: classic DOM identical; packages H1 >= 4.5:1 at rest against the lightest banner pixel under the scrim.
- Security: SC-0.

**W4-RV · Wave-4 adversarial review (was RV-4)** (docs) — `runs/redo-v2/security/golive/w4-review.md`. Deps: W4-01, W4-02, W4-03, W4-04, W4-05, W4-06, W4-07, W4-08, W4-09, W4-10.
- Acceptance:
  - Two reviewers per unit; full flow-2 walk on the WhatsApp channel incl. the B1 paid-bride scenario; CSV attack table; export audit; N-20 on the new views; N-56; 12 A1-A6.
- Security: Read-only; local only.

#### Wave 5

**W5-01 · Optional TOTP MFA, re-auth with TOTP, account security tab (was G5-6 + M3, C-6, TM-07, TM-03)** (frontend) — `src/auth/AuthContext.tsx`, `src/components/AuthDialog.tsx`, `src/features/reauth/ReauthDialog.tsx`, `src/features/reauth/use-reauth-retry.ts`, `src/features/admin-security/AccountSecurityTab.tsx`, `src/features/admin-security/registration.ts`. Deps: W4-RV, W1-02, W1-08, W2-05, W4-08.
- Acceptance:
  - 6 files justified: the MFA sign-in resolver and re-auth with an enrolled TOTP must land together or re-auth breaks once enrolled (M3).
  - Sign-in handles auth/multi-factor-auth-required with a TOTP step; «أمان الحساب» tab to enrol (secret + otpauth URI as text, no QR dependency) and unenrol with re-auth; re-auth with TOTP enrolled works.
  - «تسجيل الخروج من كل الأجهزة» (AD+R) calls #44; explains setting ADMIN_SETTINGS_2F=required after enrolment; works unchanged without Identity Platform (feature hidden).
- Security: TOTP secret shown once, never stored or logged; enrolment needs fresh re-auth; One listener, one provider, the existing AuthDialog; SB-1, SB-12, SB-14, SB-18.

**W5-02 · MOT-10 Logo intro (+UX-01, UX-11, UX-12)** (motion) — `src/design/cinematic/LogoIntro.tsx`, `src/design/cinematic/intro.css`, `src/design/classic/LogoIntro.tsx`, `src/App.tsx`. Deps: W4-RV, W1-17, W2-20, W3-17, W3-18, W4-09.
- Acceptance:
  - 12 §8.2 MOT-10 as amended: 60-day repeat rule, <= 1.8 s sequence, single <= 400 ms hero fade after the intro, focusin/click instant finish, 50 ms jank guard, hero H1 + CTA visible by t0 + 2.2 s on 4x CPU + Fast 4G.
- Security: Narrow DOMException/TypeError catches; storage value is a non-personal day number; No new Firebase listener; SC-0.

**W5-03 · MOT-11 Services ticker, only after the owner's written D12 decision (+UX-18, L5)** (motion) — `src/design/cinematic/ServicesTicker.tsx`, `src/design/cinematic/ticker.css`, `src/design/classic/ServicesTicker.tsx`, `src/pages/HomePage.tsx`. Deps: W4-RV, W2-20, W3-18.
- Acceptance:
  - 12 §8.2 MOT-11 as amended: without a written "keep the ticker" decision the unit ships the static band for everyone; static on coarse pointers; paused while any dialog or the mobile menu is open; toggling accessible name.
- Security: Items are compile-time constants; SC-0.

**W5-04 · Handoff documentation (was G7-2 + TM-20, TM-23, M4, B3, H1, H3, L4)** (docs) — `README.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`, `runs/redo-v2/HANDOFF.md`. Deps: W4-RV.
- Acceptance:
  - README: setup with the dev Firebase project, env files per mode (README:477 reconciled), .dev.vars names, seed, promote by uid, run, env.mediatest, npm test/verify, release.mjs, features/gates table, architecture map.
  - OPERATIONS: §7 runbook incl. launch floor, revert-to-pre-launch, preview runbook, kill switch (D1 first, env var second, keep_vars caveat), incident order, daily and day-one routine (hourly queue check), "notices and receipts are not proof".
  - SECURITY: SB list, threat-model summary, gates, re-auth, sessions, audit, MFA how-to, key rotation, what is off, "D1 triggers do not bind account holders"; HANDOFF: status per unit, open questions, known issues.
- Security: Names of secrets only, never values; no customer data in examples; SB-8.

**W5-05 · Preview environment migration and hardening (new; owner-executed: M4, TM-24, C-8, TM-14)** (data) — `runs/redo-v2/release/preview-log.md`. Deps: W4-RV, W1-01, W1-03, W2-17, W3-19.
- Acceptance:
  - Counts admins on sundus-yar-preview first (> 1 -> stop and decide), Time Travel bookmark, applies 0007/0008, confirms the dev Firebase project and PREVIEW_READ_ONLY.
  - Cloudflare Access policy on the preview host (owner and named reviewers only); deploy through release.mjs --env=preview --design=cinematic, plus an enforced-CSP trial build for W6-02.
- Security: Each remote command approved by the owner and logged; No production data on preview; SB-19.

**W5-RV · Wave-5 adversarial review (was RV-5)** (docs) — `runs/redo-v2/security/golive/w5-review.md`. Deps: W5-01, W5-02, W5-03, W5-04, W5-05.
- Acceptance:
  - Two reviewers per unit; MFA sign-in and re-auth with TOTP; sign out everywhere; docs checked against the code; 12 A1-A6 for MOT-10/MOT-11.
- Security: Read-only.

#### Wave 6

**W6-01 · Red team A: API, authz, injection, baseline re-run (was G8-1, non-media part)** (docs) — `runs/redo-v2/security/golive/w6-redteam-api.md`. Deps: W5-RV.
- Acceptance:
  - Full N-catalogue (non-media) against local and preview; two-customer IDOR matrix over every customer route in both gate states; body/size/content-type fuzzing; gate bypass attempts incl. synonym paths; LIKE/numeric edge cases; races (slot capacity, double confirm, concurrent terms publish, extend vs cron).
  - Re-runs every baseline go-live attack (SEC-01…SEC-05, SEC-07, SEC-08, SEC-12, SEC-13, SEC-15, SEC-16, SEC-19) and confirms each closed.
- Security: Local and preview only; no production tokens.

**W6-02 · Red team B: browser, CSP, data handling (was G8-2)** (docs) — `runs/redo-v2/security/golive/w6-redteam-web.md`. Deps: W5-RV.
- Acceptance:
  - Stored-XSS sweep of every text field into every view and email; enforced-CSP trial on preview with the cinematic build: 0 violations across intro, view transitions, ticker, khatam, sign-in/up/reset/verify, admin (N-43, TM-14); Google hosts needed or not.
  - Clickjacking; token/PII in URLs/storage/logs; CSV in four spreadsheet apps; npm audit; bundle secret scan; headers on all SPA routes.
- Security: Preview behind Access; no production tokens.

**W6-03 · Red team C: business logic and fraud (was G8-3 + B1, TM-03, H3, UX-02)** (docs) — `runs/redo-v2/security/golive/w6-redteam-fraud.md`. Deps: W5-RV.
- Acceptance:
  - IBAN and WhatsApp swap end to end under the 24 h delay and with 2F; payment instructions planted in pickup/area/terms text; kill-switch drill using the D1 switch; confirm_offline abuse.
  - Paid bride with the admin offline for 48 h keeps her date (N-30b); hold squatting through fake notices; reinstate races; deposit under/over-recording; single-admin lockout and recovery by uid; audit tamper attempts; approval with incomplete settings.
- Security: Local and preview only.

**W6-04 · Runtime QA walk, Train A (was G8-4 + UX-04, UX-05, UX-14)** (docs) — `runs/redo-v2/verification/golive-qa.md`. Deps: W5-RV.
- Acceptance:
  - §6.5 walk of all 15 stages in the default env, legacy regression, the no-email walk (UX-04), per-stage "next step and deadline above the fold at 375 px", admin at 375 x 812 (today's items and the first WhatsApp action visible without scrolling).
  - RTL and feminine copy, keyboard, reduced motion, no horizontal scroll at 320/375 px, console clean, chunk sizes vs the 470.79 kB baseline, cron catch-up.
- Security: Local and preview only.

**W6-05 · MOT-13 Motion release gate and final motion docs** (frontend) — `README.md`, `src/styles/README.md`, `runs/redo-v2/verification/motion-qa.md`. Deps: W5-RV.
- Acceptance:
  - 12 §8.2 MOT-13 as amended: every A-check on the final build across Chrome, Safari/iOS, Firefox, Samsung Internet or 4x throttle; parity against design-classic-v1 with each difference attributed; decides whether the Train A release ships cinematic or classic.
- Security: SC-0 grep across src/design/; Confirms 0 CSP violations with the enforced trial (with W6-02).

#### Wave 7

**W7-01 · Production release, Train A (was G9-1; owner-executed)** (fullstack) — `wrangler.jsonc`, `public/_headers`, `runs/redo-v2/release/golive-release-log.md`. Deps: W0-03, W5-04, W5-05, W6-01, W6-02, W6-03, W6-04, W6-05.
- Acceptance:
  - Release gate A met: zero open critical/high, zero open baseline go-live items, legal texts live, Resend decision recorded, design chosen by W6-05; real production D1 id and Firebase project id committed (no other change).
  - Runbook §7: old-D1 decision applied; owner account created and verified in the new Firebase project before the public deploy, uid recorded; first deploy via release.mjs (Report-Only) = launch floor; promotion by uid; settings; smoke incl. real verification and reset links; wrangler tail during the launch window.
  - CSP enforced by a second release within 7 days after 0 violations (Google hosts pruned if unused); rollback drill between two post-launch versions or on preview; gated routes 503.
- Security: Every production write approved by the owner in the log; secrets via wrangler secret put (names only); No seed marker in production; post-deploy header check; SB-8, SB-11, SB-19.

#### Wave 8

**W8-01 · Media primitives with dimension, trailing-data and metadata rules (was G2-13 + TM-09)** (backend) — `shared/media.ts`, `worker/media/sniff.ts`, `worker/media/signing.ts`, `worker/media/image-meta.ts`. Deps: W5-RV, W1-03.
- Acceptance:
  - Magic-byte sniffing after refusing markup; end marker required with <= 1 KiB trailing bytes; header dimension parsing (PNG IHDR, JPEG SOFn, WebP VP8/VP8L/VP8X) with caps; JPEG APP1-APP15 (keeping APP0/ICC), PNG eXIf/tEXt/iTXt/zTXt, WebP EXIF/XMP stripping; tests of polyglots and truncated headers (N-37).
  - HMAC-SHA256 over v1|key|e with crypto.subtle.verify, rotation, lifetimes <= 3,600 s customer / <= 600 s admin, key regex.
- Security: Constant-time verification; keys are UUIDs only; no key material logged; TM-09; SB-7, SB-11.

**W8-02 · Retention job, off by default, two-phase (was G5-5 + C-19, TM-15)** (backend) — `shared/retention.ts`, `worker/jobs/retention.ts`, `worker/jobs/registry.ts`. Deps: W5-RV, W1-06, W4-07.
- Acceptance:
  - Returns immediately unless RP; purges questionnaire text (90 d after the event), delivery address (30 d after completion/no-show/cancel), terminal outbox rows (180 d) and, only with PM, R2 objects per media_objects.expires_at through purge_claim -> delete -> deleted_at.
  - Never deletes booking_requests, booking_receipts rows, consents or audit (D11); never touches referenced keys or keys younger than 24 h; booking_events notes redacted through the allowed trigger path; C-19 hard deadline documented.
- Security: Fail-closed flag; counts-only logs; TM-15, C-19; SB-7, SB-13.

**W8-RV · Wave-8 adversarial review (Train B)** (docs) — `runs/redo-v2/security/golive/w8-review.md`. Deps: W8-01, W8-02.
- Acceptance:
  - Two reviewers; sniff/strip tables; retention dry run with RP on locally (counts only).
- Security: Read-only; local only.

#### Wave 9

**W9-01 · Media serving with revocation and strict headers (was G3-3 + TM-09)** (backend) — `worker/media/serve.ts`, `worker/portal/slots/media.ts`. Deps: W8-RV, W8-01.
- Acceptance:
  - #15: MAC verified before any D1/R2 call; deleted_at IS NULL per GET; media headers of §3.3; 304 via onlyIf; tested only under env.mediatest; 503 in the default env (N-38).
- Security: Bucket only through getMediaBucket; no edge caching of private bytes; TM-09, TM-10; SB-11.

**W9-02 · Receipt upload API (was G4-7 + TM-09, TM-11, C-18)** (backend) — `shared/portal/receipt.ts`, `worker/portal/receipts.ts`, `worker/portal/slots/receipts.ts`. Deps: W8-RV, W8-01, W2-13.
- Acceptance:
  - #5 under env.mediatest: CO+M, sniffed type stored, metadata stripped, SHA-256 stored, R2 object deleted on batch failure; <= 6 per booking per hour and RL_UPLOAD; 503 in the default env.
- Security: Content-Length before read; UUID keys; media_objects registered with expiry; one pending receipt (index); ids only in events; SB-3, SB-5, SB-11, SB-15.

**W9-03 · Gallery admin API (was G4-8 + TM-09)** (backend) — `shared/portal/gallery.ts`, `worker/portal/admin-galleries.ts`, `worker/portal/slots/admin-gallery.ts`. Deps: W8-RV, W8-01, W1-02.
- Acceptance:
  - #27 (07 §3.E.1-3.E.7 on the 0005 schema); 2F required; uploads with metadata or > 4,096 px refused; export audited.
- Security: 1.5 MiB/256 KiB caps; filename never in keys, URLs or logs; <= 1,000 photos; SB-11, SB-13.

**W9-RV · Wave-9 adversarial review (Train B)** (docs) — `runs/redo-v2/security/golive/w9-review.md`. Deps: W9-01, W9-02, W9-03.
- Acceptance:
  - Two reviewers; N-23, N-24, N-37, N-38, N-48 under env.mediatest.
- Security: Read-only; local only.

#### Wave 10

**W10-01 · Admin receipts API (was G5-1 + TM-09, TM-20)** (backend) — `worker/portal/admin-receipts.ts`, `worker/portal/slots/admin-receipts.ts`. Deps: W9-RV, W9-02, W1-02, W1-09.
- Acceptance:
  - #26 with signed URLs of <= 10 minutes, hash-reuse hint (same content_sha256 on another booking), receipt_viewed audit per list call.
- Security: 2F; URLs minted only after the admin check; no URL logging; SB-10, SB-11.

**W10-02 · Customer gallery API (was G5-2 + TM-06, C-18)** (backend) — `worker/portal/galleries.ts`, `worker/portal/slots/gallery.ts`. Deps: W9-RV, W9-03.
- Acceptance:
  - #13/#14 with the quota predicate (two tabs cannot exceed the quota), submit-and-lock (CO+R), CO+M on reads, hourly signed URLs; gallery id only from the owned booking; photo ids through (gallery_id, photo_id).
- Security: Ownership + gallery status in every statement; set-ops idempotent; TM-06; SB-2, SB-5, SB-11.

**W10-03 · Receipt upload UI (was G5-3 + UX-13)** (frontend) — `src/features/confirmation/ReceiptUpload.tsx`, `src/features/confirmation/receipt-encode.ts`, `src/features/confirmation/ConfirmationStageView.tsx`. Deps: W9-RV, W4-01, W9-02.
- Acceptance:
  - Shown only when receiptChannel = "upload"; images re-encoded to <= 2000 px JPEG, PDFs as-is; progress, retry, RECEIPT_ALREADY_PENDING treated as success; 44 px targets.
- Security: Client pre-checks mirror the server (the server decides); object URLs revoked; no file kept after upload; SB-12, SB-13.

**W10-04 · Admin gallery upload pipeline (was G5-4)** (frontend) — `src/features/admin-gallery/resize.worker.ts`, `src/features/admin-gallery/resize.ts`, `src/features/admin-gallery/upload-queue.ts`. Deps: W9-RV, W9-03.
- Acceptance:
  - Module worker, one decode at a time, bitmap closed, WebP ~0.80 -> JPEG fallback, 1600/480 px, 3 concurrent uploads with retries, resume by filename, beforeunload guard, cancellation.
- Security: Originals never uploaded; metadata stripped by re-encoding (the server refuses metadata anyway); listeners removed; worker terminated on unmount; SB-12, SB-13.

**W10-RV · Wave-10 adversarial review (Train B)** (docs) — `runs/redo-v2/security/golive/w10-review.md`. Deps: W10-01, W10-02, W10-03, W10-04.
- Acceptance:
  - Two reviewers; gated flows under env.mediatest with 2F on/off; N-36 gallery part.
- Security: Read-only; local only.

#### Wave 11

**W11-01 · Admin receipt review (was G6-1 + TM-20)** (frontend) — `src/features/admin-receipt/AdminReceiptSection.tsx`, `src/features/admin-receipt/receipt-admin-api.ts`, `src/features/admin-receipt/registration.ts`. Deps: W10-RV, W10-01.
- Acceptance:
  - Receipt image/PDF link (signed), zoom, expected amount, hash-reuse hint, confirm/reject via BookingActions; warns not to follow links inside a receipt PDF.
- Security: <img>/<a download> only from /api/media URLs; PDF never embedded inline; TM-20; SB-11, SB-12.

**W11-02 · Admin gallery section (was G6-2)** (frontend) — `src/features/admin-gallery/AdminGallerySection.tsx`, `src/features/admin-gallery/gallery-admin-api.ts`, `src/features/admin-gallery/registration.ts`. Deps: W10-RV, W10-04.
- Acceptance:
  - Create (quota source shown), upload via W10-04, open/extend, selection progress, export .txt/comma list (Blob, revoked).
- Security: Filenames rendered as text; export audited server-side; SB-6, SB-12.

**W11-03 · Customer gallery selection (was G6-3 + UX-13)** (frontend) — `src/features/gallery/GalleryStageView.tsx`, `src/features/gallery/gallery-api.ts`, `src/features/gallery/use-selection-queue.ts`, `src/features/gallery/registration.ts`. Deps: W10-RV, W10-02.
- Acceptance:
  - Grid with lazy thumbnails (width/height); tapping a tile opens the lightbox; a separate 44 px select toggle with aria-pressed and icon + text; counter «اخترتِ {n} من أصل {quota}» announced politely; at quota the toggle stays focusable and explains why; debounced idempotent ops with rollback; submit dialog; locked state.
- Security: No URLs persisted; queue flushed/aborted on unmount; SB-12.

**W11-04 · Selection reminders and orphan sweep, two-phase (was G6-4 + TM-15)** (backend) — `worker/jobs/selection-reminders.ts`, `worker/jobs/orphan-sweep.ts`, `worker/jobs/registry.ts`, `worker/emails/gallery.ts`. Deps: W10-RV, W10-02, W8-02.
- Acceptance:
  - -7 d/-2 d/overdue per ADR; orphan sweep Fridays (Riyadh) for unreferenced R2 objects older than 24 h, only with PM; claim -> delete -> mark; bounded paging; random claim tokens.
- Security: Never deletes a referenced key; counts-only logging; TM-15; SB-7, SB-11.

**W11-RV · Wave-11 adversarial review (Train B)** (docs) — `runs/redo-v2/security/golive/w11-review.md`. Deps: W11-01, W11-02, W11-03, W11-04.
- Acceptance:
  - Two reviewers; UI XSS sweep of gallery/receipt views; N-46 for the new jobs.
- Security: Read-only; local only.

#### Wave 12

**W12-01 · Gallery lightbox on the existing dialog pattern (was G7-1 + UX-13)** (frontend) — `src/features/gallery/GalleryLightbox.tsx`, `src/features/gallery/GalleryStageView.tsx`. Deps: W11-RV, W11-03.
- Acceptance:
  - Extends the native <dialog> pattern of src/pages/portfolio/Lightbox.tsx with its RTL arrow and swipe mapping; Escape and optionally Android Back close; focus trap/return; select from the lightbox; reduced-motion safe.
- Security: Listeners removed on close; no new storage; SB-12.

**W12-02 · Train B documentation: switching private media on (new)** (docs) — `docs/OPERATIONS.md`, `docs/SECURITY.md`, `runs/redo-v2/HANDOFF.md`. Deps: W11-RV.
- Acceptance:
  - Switch-on procedure (PDPL sign-off, R2 bucket private with no custom domain and no CORS (N-47), signing key rotation, 2F enrolment, preflight changes), retention enablement conditions (D11), receipt handling rules.
- Security: Names only, never values; SB-8.

**W12-RV · Wave-12 adversarial review (Train B)** (docs) — `runs/redo-v2/security/golive/w12-review.md`. Deps: W12-01, W12-02.
- Acceptance:
  - Two reviewers; lightbox keyboard/RTL; docs checked against the code.
- Security: Read-only.

#### Wave 13

**W13-01 · Red team D: private media (new, from G8-1/G8-2 media parts)** (docs) — `runs/redo-v2/security/golive/w13-redteam-media.md`. Deps: W12-RV.
- Acceptance:
  - Upload and serve attacks N-23, N-24, N-37, N-38, N-47, N-48; synonym-path and binding-merge attempts; two-customer IDOR on gallery and receipts; signed-URL sharing and replay; admin 2F on/off.
- Security: env.mediatest and preview only.

**W13-02 · Runtime QA walk, mediatest (from G8-4)** (docs) — `runs/redo-v2/verification/train-b-qa.md`. Deps: W12-RV.
- Acceptance:
  - mediatest walk: upload receipt -> reject -> re-upload -> confirm -> gallery -> select exactly the quota -> submit -> production -> handover -> complete; retention dry run; accessibility of the gallery and lightbox at 375 px.
- Security: Local only.

**W13-03 · Train B dark release (new; owner-executed)** (fullstack) — `runs/redo-v2/release/train-b-release-log.md`. Deps: W13-01, W13-02.
- Acceptance:
  - Gate B met (zero open critical/high); train-b merged into the release branch; release.mjs production deploy; preflight proves no r2_buckets, PDPL_SIGNOFF_REF or MEDIA_SIGNING_KEY; every gated route answers 503 in production.
- Security: Owner approval per production write; Launch floor unchanged; rollback only >= floor; SB-11, SB-19.

---

## 6. Test plan

### 6.1 Environments
- **Dev Firebase project** (not production; also the preview project): Email/Password on, `localhost` authorised; accounts: a tester admin, a tester customer and a second customer for IDOR tests. Its web config lives in `app/.env.development.local` (loaded by `vite` in development mode only); **never in `.env.local`**, which Vite also loads in production mode (H1). `app/.dev.vars` sets `FIREBASE_PROJECT_ID=<dev project>` and optionally `ADMIN_MEDIA_MFA=off` for gated admin tests without MFA (the release preflight refuses `off` for production).
- **Env files per mode**: `.env.development.local` (dev), `.env.preview.local` (dev project, used by `release.mjs --env=preview`, Vite mode `preview`), `.env.production.local` (the new production project). The config guard (W2-18) fails a build whose Firebase project id or auth domain does not match the target environment.
- **Local D1 reset**: stop the dev server, delete `.wrangler/state`, `npx wrangler d1 migrations apply sundus-yar-production --local` (0001, 0003–0008), `node scripts/seed-local.mjs --customer-uid <tester customer uid>`, then sign in once as the tester admin (so the profile row carries `email_verified_at`) and `node scripts/promote-admin.mjs --database sundus-yar-production --uid <tester admin uid> --email <tester admin email> --local`.
- **Default env** (`npm run dev`): production-like gates (OC on, PM off, no email → AX off).
- **Media env** (`CLOUDFLARE_ENV=mediatest npm run dev`): local R2 through Miniflare; `.dev.vars.mediatest` holds `PDPL_SIGNOFF_REF=LOCAL-TEST-ONLY`, `MEDIA_SIGNING_KEY=<32+ random bytes, base64url>`, `FIREBASE_PROJECT_ID=<dev>`; never deployed (placeholder D1 id and the preflight make a deploy fail).
- **Cron**: `curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*"` (and `0+0+*+*+*`), then read `job_runs` and `notification_log` with `wrangler d1 execute … --local`. N-46 fires two ticks concurrently.
- **Tokens for curl** (local only): copy the `Authorization` header of a request from the browser's Network tab of the local site; never paste production tokens anywhere.
- **Preview env**: behind Cloudflare Access, dev Firebase project, `PREVIEW_READ_ONLY="on"`, its own D1 (migrated by W5-05); used for owner review and the enforced-CSP trial.

### 6.2 Seed data (`scripts/dev-seed.sql` + `seed-local.mjs`)
One booking per stage for the tester customer with distinct dates: `pending_review` (created 30 h ago → SLA), flow-2 `approved_hold` without terms (hold in 20 h), flow-2 `approved_hold` with terms (+ a `deposit_notice_sent` event for its deadline), flow-2 `approved_hold` with terms and a notice **past its deadline** (notice-protected, `decide_now`), flow-2 `approved_hold` past its deadline without a notice (expirable only when AX is on), flow-2 `expired` with a free date (for `reinstate_hold`), flow-2 `payment_pending` with a pending receipt row (media env), `confirmed` without profile (event +10 d), `confirmed` with profile and a granted consent (event +5 d), `confirmed` after the event (awaiting previews), gallery `open`/`locked` (media env), production `design`/`printing`/`ready`, handover scheduled tomorrow, handover today, completed with/without feedback, completed without gallery (privacy clean-up), legacy `contract_pending`, `expired`, `cancelled`. Plus 6 fake customers (not able to sign in; one with `contact_changed_at` after its booking) with bookings across two months, 3 blocked dates, 2 delivery areas and 10 handover slots. No settings, no bank data, no admin, no switch rows (the tester enters settings through the UI).

### 6.3 Runtime check per unit (the DoD's last column)

| Unit | Runtime check |
|---|---|
| W1-01 | migrations apply fresh (27/23/12); `tests/migrations.test.mjs`; seed refuses `--remote`; marker table present locally |
| W1-02 | admin and customer endpoints unchanged for a fresh token; a token older than 12 h and one issued before `tokens_valid_after` → 403 (N-44); stored-email mismatch → 403 (N-32) |
| W1-03 | default build has no R2; `mediatest` boots; `/api/media/x` → 503; gated admin path → 503; `getMediaBucket` null without PDPL (N-48) |
| W1-04 / W1-05 | every existing page and API unchanged; unregistered paths 404; foreign and unknown booking ids give byte-identical 404 bodies |
| W1-06 | SQL prepared against 0007 + 0008; deposit examples; effective vs pending revision |
| W1-07 / W1-08 | existing hub loads; re-auth dialog on a forced `REAUTH_REQUIRED` (via W2-01); an old admin bundle with an unknown action still loads the detail |
| W1-09 | exercised by W2-01/W2-12 (audit rows appear with SQL time) |
| W1-10 | `tests/text.test.mjs`, `tests/timing.test.mjs` |
| W1-11 | links for `+9665…`, `05…`, `٠٥…`, invalid input (disabled) |
| W1-12 | local promote by uid, email mismatch refused (N-31), second-admin refusal, `--replace` swap, audit rows |
| W1-13 | `npm run verify` passes on HEAD; each grep gate fails on a planted violation in a scratch branch |
| W1-14 | chunked 2 MB body to `PUT /api/profile` → 413; normal flows unchanged |
| W1-15 | binding absent locally → allowed with the counts-only log line; SQL caps unit-tested |
| W2-01 | each section saved; history; stale token 403; unchanged → no new row; second bank save pending 24 h, cancel works; content rules (N-33); pickup re-auth (N-34); switch off/on |
| W2-02 | approve → flow 2 with deposit and 48 h/event cap; incomplete settings → flow 1; past date refused; `SETTINGS_CHANGED` race; extend/expire/reinstate/confirm/confirm_offline matrix; paid-bride grace (N-30b); legacy rows identical (N-29) |
| W2-03 | cron tick: notice-protected hold untouched (N-50); AX off → no flow-2 expiry; switch off → none (N-52); reminder copy per channel |
| W2-04 | flow-2 approval email copy with the deadline in the outbox/local log (never sent without EM) |
| W2-05 | timeline; contact-log outcomes; audit list; session fields; revoke-all → next request 403 |
| W2-06 … W2-09 | endpoints per §3.3 with the seeded stages; IDOR with the second customer (N-36); consent re-auth (N-39); events only on change (N-40) |
| W2-10 / W2-11 | every queue section populated by the seed in the fixed order; `waDigits` present only in items; calendar months; customer list cursor |
| W2-12 | CSV attack table (N-09, N-42); audit row; stale token 403 |
| W2-13 | #2–#4 for own/other bookings; OC or switch off → 503; stale terms version; notice → `holdProtected`; pending bank revision never shown |
| W2-14 | template snapshot review by the copy reviewer |
| W2-15 | SEC-04 squatting reproduction closed; phone change with an old token → 403; erased → 410 |
| W2-16 | `/me` fields for seeded bookings; `awaiting_deposit`, `deposit_reported`, `stageUpdatedAt`, studio change time |
| W2-17 | preview guard (403 on writes with the var on); availability cache header; CSP report stored as counts only |
| W2-18 | build fails with a mismatching project id or auth domain (N-53), passes when aligned; headers present |
| W3-01 | N-18, N-36, delivery re-auth |
| W3-02 | POST search with `%`, `_`, `\`, 65 chars, control characters (N-08); no query text in any request URL (Network tab) |
| W3-03 / W4-07 | cron tick; payload copy; `skipped` without EM; cancelled booking gets no reminder (N-46) |
| W3-15 | fourth open request → 409; sixth in an hour → 429; date beyond 730 days → 400 |
| W3-16 / W4-08 | `/privacy`, `/disclosure` render the provided text; links present in the auth dialog, footer, event-profile and handover forms |
| W3-19 | preflight refuses each planted defect (N-35); release refuses a dirty tree, a non-tag HEAD and an unset design (N-54); rollback below the floor refused (N-62) |
| W3-20 | quantity above the ceiling refused by server and client; WhatsApp link after submit carries the reference |
| W3-x / W4-x UIs | keyboard-only pass, RTL, 375 px and 320 px, reduced motion, loading/empty/error states, 44 px targets, no console output |
| W5-01 | sign-in with and without enrolled TOTP (dev project with Identity Platform); re-auth with TOTP; sign out everywhere |
| W5-05 | preview log complete; Access in front; read-only guard active |
| Train B units | full gated flows in `mediatest`, 503 in the default env |
| Motion units | 12 §8.1 A1–A6 and the unit's own acceptance |

### 6.4 Negative-test catalogue (reviewers and red teams)
**Rev. 1 (kept, with rev. 2 updates in brackets)**: N-01 no token → 401 on every new route · N-02 customer token on admin routes → 403 · N-03 unverified email → 403 · N-04 other customer's booking id → 404 on every customer route [identical body to an unknown id] · N-05 unknown/missing/wrong-type keys → 400 [plus Arabic-Indic and Persian digits accepted where digits are expected] · N-06 oversized bodies → 413/domain error, including chunked bodies on legacy handlers; multipart without `Content-Length` → 411 · N-07 wrong `Content-Type` → 415 · N-08 search with `%`, `_`, `\`, 65 chars, control chars [through POST #41/#42] · N-09 CSV formula and bidi payloads in names/addresses · N-10 re-auth window (10 min 1 s) on every AD+R/AD+S route; direct SQL insert with a stale `reauth_at` fails [against SQL-stamped `created_at`] · N-11 UPDATE/DELETE on append-only tables abort [plus DELETE on status history and events, and the cascade] · N-12 second admin via SQL fails; grep proves no API writes `role` · N-13 gated routes 503 in all encodings (`%72eceipt`, `Receipt`, `//`, trailing `/`, `%2F`) [plus synonym words] · N-14 temporarily registering a `receipt` route as `open` stops the Worker (reverted) · N-15 approve with incomplete settings → flow 1 [also with the kill switch off] · N-16 stale terms version / expired hold on accept · N-17 flow-2 confirm without terms, amount > total, amount < snapshot without note · N-18 two customers race for the last slot → exactly one success · N-19 repeated WhatsApp notices never move the deadline · N-20 `<img src=x onerror=alert(1)>` and `javascript:` in every text field → inert text everywhere (UI, CSV, email, `.ics`, WhatsApp text) · N-21 WhatsApp number `966500000000?text=x` or `+966…` with letters refused [Arabic-Indic digits accepted] · N-22 IBAN checksum/format/spacing/lowercase [Arabic-Indic digits normalised] · N-23 signed URL: expired, > lifetime ahead, tampered, wrong key pattern, cross-booking key · N-24 upload: HTML renamed `.jpg`, polyglot, 5 MiB + 1 B · N-25 device clock skew ±2 h does not change deadlines · N-26 export > 400 days or > 5,000 rows · N-27 CSP Report-Only console clean on sign-in/register/reset/verify/admin/my-bookings · N-28 no token/PII in console, storage, URLs [including API request URLs] · N-29 legacy flow-1 rows: same actions, labels, emails · N-30 cron: an unprotected flow-2 hold past its deadline is expired only when AX is on; reminders copy per channel; legacy rows untouched.

**Rev. 2 additions**:
- **N-30b** (B1) A bride accepted the terms, transferred and sent the WhatsApp notice at hour 47; the admin is offline for 48 h; cron ticks and another request for the same date is approved → her booking stays `approved_hold`, the date is not freed (`DATE_NOT_FREE` for the other approval), the queue shows it under `decide_now`, and `confirm_payment` succeeds afterwards.
- **N-31 … N-48** exactly as `13-threat-model.md` §10 (promote by uid; stored-email mismatch; content rules; pickup re-auth; preflight; two-customer IDOR incl. nested ids; upload rules; signed-URL revocation; consent re-auth; limits and events on change; bidi/format characters; CSV additions; `data:image` and enforced CSP; 12 h session and revocation; delayed bank change; concurrent cron ticks; R2 bucket checks; `getMediaBucket` without PDPL).
- **N-49** (B3) The old-database inventory is present in the release log before W7-01; non-zero future counts without a recorded decision block the release.
- **N-50** A notice for the **current** deadline protects the hold from the cron and the targeted sweep; a notice for an earlier deadline does not.
- **N-51** `reinstate_hold` succeeds on a free date, fails with `DATE_NOT_FREE` on a held date, and is refused after the event start.
- **N-52** (H3) With the D1 switch off: #2–#4 → 503, new approvals take the legacy path, the cron expires no flow-2 hold, `confirm_offline` works with a note and amount; switching on without re-auth is refused.
- **N-53** (H1) Builds with a mismatching `VITE_FIREBASE_PROJECT_ID`/`FIREBASE_PROJECT_ID` or a non-`firebaseapp.com` auth domain fail; the smoke test's verification and reset links load on the production auth domain.
- **N-54** (TM-05/H6) `release.mjs` refuses: a dirty tree, a production release from a non-tag HEAD, an unset design, a design marker mismatch; `npm run deploy:classic` goes through the same preflight.
- **N-55** (UX-07) `٠٥٥١٢٣٤٥٦٧` as a WhatsApp number, an IBAN typed with Arabic-Indic digits, and slot times in Arabic-Indic digits are accepted and normalised.
- **N-56** (UX-08) Copying the IBAN and pasting it into a notes app yields exactly 24 characters with no invisible characters; the amount pastes as digits only.
- **N-57** (UX-03) From `/admin` at 375 × 812, one tap on a queue item's WhatsApp button opens the chat with a prefilled message (iOS Safari and Chrome Android).
- **N-58** (M1) A settings insert that binds `reauth_at` from `iat` is caught by the `reauthAtFromToken` test; an insert with a bound (fake) `created_at` is impossible because the statement stamps it.
- **N-59** (M2) Between 21:00 and 24:00 Riyadh, "today" on the handover, event-profile and production rules is the Riyadh date, not the UTC date.
- **N-60** (L1) An admin tab running the previous bundle opens a booking whose `allowedActions` include `reinstate_hold` without an error.
- **N-61** (TM-17) While searching, no request URL, log line or CSP report contains the query text.
- **N-62** (B3) `release.mjs --rollback <version below the launch floor>` is refused; a rollback between two post-launch versions succeeds on preview.

### 6.5 Journey walks (W6-04)
For each seeded stage open `/my-bookings?booking=<id>` and `/admin?booking=<id>`: stage label, tracker position (15 stages → 7 phases), deadline/countdown, exactly one next step (button, WhatsApp link, or "nothing needed until {date}") above the fold at 375 px, admin sections present in their fixed order, allowed actions, queue membership. Then drive a fresh booking end to end:
- **Default env, WhatsApp channel**: request → WhatsApp "send my reference" link → approve (flow 2) → accept terms → copy IBAN → WhatsApp notice → `deposit_reported` → record deposit (amount from the "bank statement") → confirmed → details + consent (re-auth) → event passes (seeded date) → production design → printing → ready → book delivery slot (re-auth) → handover day WhatsApp → complete → feedback → privacy clean-up.
- **No-email walk (UX-04)**: with `EM` off confirm that every customer-facing step has a queue item with a one-tap WhatsApp, the queue count shows in the tab title and refreshes on focus, and no flow-2 hold expires by itself.
- **Kill-switch walk (H3)**: switch off mid-flow, finish the booking with `confirm_offline`, switch on with re-auth.
- **Train B (W13-02, `mediatest`)**: upload receipt → reject → re-upload → confirm → gallery → select exactly the quota → submit → production → handover → complete.

### 6.6 Automated tests (M6)
`npm test` runs `node --test` over `tests/` with only Node built-ins (`node:test`, `node:sqlite`, `node:assert`) and the `tests/setup/resolve-ts.mjs` resolve hook. Minimum content by the end of Train A: migrations (§2.3 + §2.5 checks), SQL predicates (approve with settings, notice protection, grace, reinstate, caps, capacity, IDOR predicate), gate encodings (N-13 incl. synonyms), text validator and content rules (N-33, N-41), digit normalisation, timing boundaries (N-59), CSV attack table (N-09, N-42), `reauthAtFromToken` (N-58), config guard and preflight (N-35, N-53). Each unit adds the tests for its own controls; the RV gate checks they exist and fail when the control is removed.

---

## 7. Production deploy runbook and rollback

Every production write needs the owner's explicit approval, recorded in `runs/redo-v2/release/golive-release-log.md` (W7-01). Commands run from `app/`. Agents never run a production write.

### 7.0 One deploy path (TM-05, H6)
Every deploy, including "return to classic", preview, rollback and Train B's dark release, goes through `npm run release -- --env=<production|preview> --design=<classic|cinematic>` (or `-- --rollback <version-id>`), i.e. `scripts/release.mjs`:
1. refuses a dirty tree; for production, refuses unless HEAD is an annotated `release-*` tag whose message names the passed gate report;
2. builds with `VITE_SITE_DESIGN` pinned and the Vite mode of the environment (`production` or `preview`, so the matching `.env.<mode>.local` is used);
3. runs `scripts/release-preflight.mjs` over `dist/sundus_yar_website/wrangler.json`, `dist/client` and `public/_headers` (§0 TM-05 list, plus "legal texts present" and "no `_dev_seed_marker` expected");
4. prints the target Worker, environment, design and commit, and waits for the owner to type the Worker name;
5. runs `wrangler deploy --tag design-<d> --message "design=<d> commit=<sha>"`, records the version id and appends a line to the release log.

`--rollback` runs `wrangler rollback <version>` only when the version is at or above the recorded **launch floor** (B3). `--allow-dirty` does not exist.

### 7.1 Preconditions
- Release gate A passed (§5.3); `git status` clean on the annotated release tag; `npm ci && npm run verify` pass.
- The owner is logged in: `npx wrangler login`, then `npx wrangler whoami` shows account `52c34fa9a7afb30c9db795d42b13df68` and the workers.dev subdomain `sundusyar`. The Cloudflare and Firebase owner accounts have 2FA; any API token is scoped (TM-23).
- Workers plan decided (§9 Q6). Resend decision recorded (§9 Q2). Legal texts provided (§9 Q4).

### 7.2 Old database and launch floor (B3)
1. From W0-03: counts on `sundus-yar-bookings` (users, blocking bookings with `event_date` ≥ today, blocked dates ≥ today) and the pre-launch version id of `sundus-yar-website`.
2. All counts zero → proceed. Any non-zero future count → **stop** until the owner decides (§9 Q3): either migrate nothing and contact those clients, or copy **only those dates** into the new database's `blocked_dates` (reason «حجز سابق», no names or contact data), approved and logged.
3. After the first go-live deploy (§7.6) the version id is written to the release log as the **launch floor**. `release.mjs --rollback` refuses anything below it. Going back to the pre-launch site is not a rollback: it is the separate "revert to pre-launch" runbook in `docs/OPERATIONS.md`, which the owner approves and which reconciles bookings made after launch.

### 7.3 New Firebase project (owner's Google account)
1. Create the project; add a Web app; copy its config into `app/.env.production.local` (git-ignored by `*.local`): `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN` (`<projectId>.firebaseapp.com`), `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` (+ optional storage bucket, messaging sender id). These are public identifiers, not secrets. Nothing goes into `.env.local`.
2. Authentication → enable Email/Password; Settings → Authorised domains: `sundus-yar-website.sundusyar.workers.dev` and the default `<projectId>.firebaseapp.com` only (remove `localhost`; no preview host); enable **email enumeration protection**; set the email template language to Arabic and the sender name.
3. Google Cloud console → Credentials → the Browser key: HTTP-referrer restriction **`https://sundus-yar-website.sundusyar.workers.dev/*` and `https://<projectId>.firebaseapp.com/*`** (the default action handler for verification and reset runs there, H1); API restriction to Identity Toolkit API and Token Service API.
4. **Before any public deploy**: in Authentication → Users, **add the owner's account** with her email (so nobody can register it first), and record its uid in the release log (TM-02/B2). She verifies the email on first sign-in after the deploy.
5. Optional (§9 Q1): upgrade to Identity Platform, enable TOTP MFA and a password policy; after she enrols (W5-01), set `ADMIN_SETTINGS_2F="required"` in a release.
6. One-line config changes (W7-01 commit): `wrangler.jsonc` `vars.FIREBASE_PROJECT_ID = "<project id>"`; `public/_headers` `frame-src https://<project>.firebaseapp.com`. The config guard fails the build if they disagree with the env file.

### 7.4 New production D1
```bash
npx wrangler d1 create sundus-yar-production --location eeur        # location per §9 Q5; prints the database_id
# put the id into wrangler.jsonc d1_databases[0].database_id (commit in W7-01)
npx wrangler d1 time-travel info sundus-yar-production              # record the bookmark (empty DB)
npx wrangler d1 migrations list sundus-yar-production --remote      # expect 0001, 0003, 0004, 0005, 0006, 0007, 0008 pending
npx wrangler d1 migrations apply sundus-yar-production --remote
npx wrangler d1 execute sundus-yar-production --remote --command "SELECT type, COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' GROUP BY type"
#   expect 27 tables, 23 indexes, 12 triggers
npx wrangler d1 execute sundus-yar-production --remote --command "SELECT name FROM sqlite_master WHERE name = '_dev_seed_marker'"
#   expect no rows (seed never ran remotely)
```
Rules: never edit an applied migration; never delete rows from `d1_migrations`; never run `scripts/seed-local.mjs` or `wrangler d1 export` against production; record a Time Travel bookmark before every remote write. The old database `sundus-yar-bookings` (`6fda2ba7…`) is left untouched (§7.2). D1 triggers do not bind Cloudflare account holders (TM-23): account access is protected by 2FA only.

### 7.5 Vars, secrets, bindings
- In `wrangler.jsonc` (committed): `ONLINE_CONFIRMATION="on"`, `FIREBASE_PROJECT_ID`, `ADMIN_MEDIA_MFA="required"`, `ADMIN_SETTINGS_2F` (`"off"` until TOTP is enrolled), `account_id`, `preview_urls: false`, crons, the seven `ratelimits` bindings (production and preview), and for `env.preview` `PREVIEW_READ_ONLY="on"` and the dev project id.
- **Not set** in production (feature stays off; the preflight refuses them): `PDPL_SIGNOFF_REF`, `MEDIA_SIGNING_KEY`, `RETENTION_PURGE`, any `r2_buckets`.
- Secrets (prompted, values never typed into files or chats): `npx wrangler secret put APP_BASE_URL` (`https://sundus-yar-website.sundusyar.workers.dev`); email ones only when Resend exists (`RESEND_API_KEY`, `EMAIL_FROM`, `ADMIN_NOTIFICATION_EMAIL`, `EMAIL_REPLY_TO`). `npx wrangler secret list` shows names only.

### 7.6 Build and deploy
```bash
npm ci && npm run verify
npm run release -- --env=production --design=<classic|cinematic>   # design per the W6-05 decision; typed go-ahead
npx wrangler deployments list                                       # confirm; the version id is the launch floor
```

### 7.7 Admin promotion (owner)
1. The owner signs in on the production site with the account created in §7.3 step 4, verifies her email, completes the profile (row created as `customer` with `email_verified_at`).
2. `npx wrangler d1 time-travel info sundus-yar-production` → record the bookmark.
3. `node scripts/promote-admin.mjs --database sundus-yar-production --uid <uid from §7.3> --email <owner email> --remote` (shows uid and stored email; typed confirmation; verifies exactly one admin; writes `admin_promoted`).
4. The owner opens `/admin` → «الإعدادات»: deposit rule, bank account (re-auth), terms v1 (her own text; the editor lists the compliance topics), WhatsApp number (re-auth), pickup address (re-auth), delivery areas; «مواعيد التسليم»: generate slots. Check `features.onlineConfirmation.offered = true`. The first bank and contact revisions are immediate; later changes wait 24 h unless 2F.
5. Optional: enrol TOTP (Identity Platform), then set `ADMIN_SETTINGS_2F="required"` in the next release.

### 7.8 Smoke tests (production)
- `wrangler tail` runs for the whole launch window, filtered to fixed codes; the owner checks the queue hourly on day one (L4).
- `curl -s https://sundus-yar-website.sundusyar.workers.dev/api/health` → `ok:true`.
- `curl -sI …/admin` and `…/my-bookings` → CSP (Report-Only), `Reporting-Endpoints`, COOP, `X-Frame-Options: DENY`, `X-Robots-Tag: noindex, nofollow`.
- `curl -s -o /dev/null -w "%{http_code}" …/api/media/r/x` → `503`; an authenticated admin `GET /api/admin/bookings/<id>/receipts` → `503`.
- Pages render; sign-up works; **click a real verification link and a real password-reset link** (they open on `<projectId>.firebaseapp.com` and complete, H1); no Report-Only violations in the console.
- One real booking by the owner's second account on a far-future date: WhatsApp link after submit, approve (flow 2 shown in the preview), accept terms, copy IBAN (24 characters), WhatsApp notice → `deposit_reported`, record deposit, confirmed, then cancel with the note «اختبار الإطلاق».
- After 15–30 minutes: `SELECT job, last_ok_at, last_status FROM job_runs` (remote, read-only) shows the heartbeat; queue health shows cron fresh.
- CSV export of the test day opens in a spreadsheet; the audit log shows promotion, settings and the export.
- **Within 7 days** and before any public promotion: after zero violations in `csp_report_counts`, a second release switches `_headers` to the enforced `Content-Security-Policy` (+ `upgrade-insecure-requests`), drops Google script hosts the reports show unused, keeps Trusted Types Report-Only, and is rechecked (TM-14, C-10).

### 7.9 Rollback and switches
| What broke | Action |
|---|---|
| New code misbehaves | `npm run release -- --rollback <version>` to a version **at or above the launch floor** (refused below it), then fix forward |
| Online confirmation must stop (e.g. bank details doubt) | Admin → «الإعدادات» → «إيقاف التأكيد الإلكتروني» (D1 switch; one tap; audited): new approvals legacy, confirmation endpoints 503 (bank details hidden), no flow-2 expiry; finish in-flight bookings with `confirm_offline`. Second path: set `ONLINE_CONFIRMATION="off"` in `wrangler.jsonc` and release (a dashboard var edit is faster but the next deploy overwrites it unless `keep_vars` is set) |
| Bad settings value | save a corrected revision (history keeps both); a pending bank/contact change is cancelled by re-saving the effective values; the queue lists bookings that accepted an older bank revision |
| Wrong design live | `npm run release -- --env=production --design=classic` on the **currently released tag** (not HEAD), or `--rollback` to the last classic version at or above the floor |
| Bad data write | `npx wrangler d1 time-travel restore sundus-yar-production --bookmark=<bookmark>` reverts **all** writes after the bookmark; owner approval; last resort |
| Migration problem | never down-migrate; write the next migration as a forward fix |
| Firebase misconfiguration | fix the console setting or release the previous tag; the config guard ensures the Worker's `FIREBASE_PROJECT_ID` matches the build's `VITE_FIREBASE_PROJECT_ID` |
| Need the pre-launch site back | not a rollback: the "revert to pre-launch" runbook (owner-approved, reconciles data) |

### 7.10 Preview environment (M4; W5-05)
1. `npx wrangler d1 execute sundus-yar-preview --remote --command "SELECT COUNT(*) FROM users WHERE role='admin'"` → more than 1 → stop and decide which to demote (the single-admin index would fail).
2. Bookmark, then `npx wrangler d1 migrations apply sundus-yar-preview --remote --env preview` (0007, 0008).
3. Cloudflare Zero Trust → Access application on the preview host (owner and named reviewers only). Preview uses the **dev** Firebase project everywhere (wrangler var, `.env.preview.local`); `PREVIEW_READ_ONLY="on"`.
4. `npm run release -- --env=preview --design=cinematic`; for the TM-14 trial, a preview build with `CSP_MODE=enforce`.

### 7.11 Incident runbooks (summarised; full text in `app/docs/OPERATIONS.md`, W5-04)
- **Admin account compromised or bank details tampered** (TM-07 order): (1) invalidate in D1: «تسجيل الخروج من كل الأجهزة», or, from the owner's machine, re-run `promote-admin.mjs` for her own uid (it stamps `tokens_valid_after`) or `--replace` to a clean account; (2) kill switch off; (3) disable the Firebase user in the console; (4) reset the password and MFA. Then review `settings_revisions` (cancel any pending change), `admin_audit_log`, exports; restore settings with re-auth; contact every booking whose `bank_revision_id` is the bad revision via WhatsApp; PDPL breach assessment (72-hour duty per `02-compliance.md`); switch on.
- **Cron stale**: the queue shows `CRON_STALE`; check the dashboard triggers; holds are still enforced at write time and flow-2 holds never expire by themselves without email anyway.
- **CSP violations after enforcement**: the queue health shows the count; release the previous tag (≥ floor) if a sign-in flow breaks.
- Operating rules (TM-20, TM-08): WhatsApp notices, receipts and hash matches are not proof of payment; record the amount seen in the bank statement; the studio confirms publishing consent with the bride before publishing any photo.

---

## 8. Handoff package
- Documents: this plan, `12-motion-spec.md`, `13-threat-model.md`, W5-04 and W12-02 outputs (`README.md`, `docs/OPERATIONS.md`, `docs/SECURITY.md`, `runs/redo-v2/HANDOFF.md`), all review/red-team/QA reports under `runs/redo-v2/security/golive/` and `runs/redo-v2/verification/`, the release logs and the inventory.
- Code archive: `git archive --format=zip -o ../sundus-yar-app-<tag>.zip <release tag>` (tracked files only, so `.dev.vars*`, `.env*.local`, `.wrangler/`, `node_modules/`, `dist/` are excluded by construction; history is not included, which also keeps the original photos of baseline SEC-06 out). The `runs/` folder is zipped separately.
- **Do not include** `assets-originals/` or `assets-incoming/` (owner photos) unless the owner approves; never include any `.dev.vars*` or `.env*.local`.
- The colleague needs: Cloudflare account access from the owner (not shared credentials), a dev Firebase project of their own, this repository, and `git config core.hooksPath .githooks`.

---

## 9. Open questions

Only the questions that need the owner are open; everything else has a decided default recorded in §0 or §1.3.

**Open (owner decides; defaults apply until she does)**
1. **Bank/WhatsApp change protection (TM-03, H2).** At launch, a new IBAN or WhatsApp number reaches customers 24 h after she saves it (the first entry is immediate; she can cancel a pending change). Once she enables Identity Platform and enrols TOTP, changes become immediate but need the second factor. *Default:* 24 h delay now, TOTP when she is ready. This also records that MFA stays optional at launch (the R1 override).
2. **Email provider (Resend) at launch (UX-04, B1, H2).** Without email: no automatic expiry of flow-2 holds, no alert email on sensitive changes, and every customer update is a one-tap WhatsApp from the queue. *Default:* no email at launch.
3. **Old database contents (B3).** Only if W0-03 finds future bookings or blocked dates in `sundus-yar-bookings`: migrate nothing and contact those clients, or copy only the dates into the new database. *Default:* stop the release until she chooses.
4. **Privacy notice and e-commerce disclosure text (H4, D11).** The owner and her lawyer supply the text (identity, VAT status, cancellation/refund, complaints, data use and cross-border transfer). *Default:* none; the release is blocked until provided.
5. **Ticker vs "nothing slides in from off-screen" (D12, L5).** Keep the slow, pausable services ticker (static on phones), or the static band for everyone. *Default:* static band until she decides in writing.
6. **Workers plan and D1 location.** Workers Paid (cron and CPU limits on Free are tight) and the new D1's location (`eeur` pending the PDPL residency answer U1). *Default:* Paid, `eeur`.
7. **Sign-in friction from the security amendments (TM-07, TM-08, TM-04).** The admin re-enters her password after 12 h and is signed out after 30 min idle; brides re-enter their password (if their sign-in is older than 10 min) to grant photo-publishing consent, book a delivery or change their phone/email; pickup changes need re-auth; admin text shown to customers cannot contain account numbers, links or other phone numbers. *Default:* adopted.

**Decided (rev. 1 questions and their answers)**: Q1 old D1 → see open Q3; Q2 location → open Q6; Q3 Workers plan → open Q6; Q4 public-site WhatsApp number stays compiled (it is also the check quoted after a number change); Q5 auto-extend on notice → replaced by notice protection (no deadline change, B1); Q6 no offline escape hatch → replaced by `confirm_offline` (H3); Q7 2F for media admin routes → yes; Q8 48 h hold, flow 2 only ≥ 3 days ahead → yes; Q9 delivery fee collected offline → yes; Q10 retention purge off until the accountant/lawyer confirm → yes (C-19 deadline tracked); Q11 privacy/disclosure pages → built in this plan (W3-16, W4-08), text open Q4; Q12 email → open Q2; Q13 shared files with the motion plan → resolved by the combined schedule (§5.5); Q14 notes excluded from CSV → yes; Q15 no self-reschedule → yes; Q16 single-admin index → keep; Q17 Identity Platform → open Q1; Q18 log WhatsApp opens → yes, but opening no longer hides the item (UX-06); Q19 `account_id` committed → yes; Q20 preview → dev Firebase project, Access, read-only (M4); Q21 old Firebase users → greenfield, the owner informs anyone who registered on the old site; Q22 Workers Logs → stay off, and admin search no longer puts personal data in URLs (TM-17).
