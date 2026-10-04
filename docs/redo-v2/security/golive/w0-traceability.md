# W0-02 — Traceability matrix: threats, review items and baseline findings → units → tests

| | |
|---|---|
| Unit | **W0-02** (was G0-2), Train A, wave 0: the traceability half |
| Date | 2026-09-29 |
| Author | Security architect (plan unit W0-02) |
| Inputs | `11-golive-plan.md` rev. 2 (§0, §3.1, §4, §5.4, §5.6, §6.3–§6.5, §7, §9), `11-units.json` (111 units), `12-motion-spec.md` rev. 2 (§0, §8.1), `13-threat-model.md` (§6, §8, §9, §10), `10-security-baseline.md` (§2, §6), `decisions.md` (D14–D19), `release/w0-inventory.md` |
| Code state read | `app/` at `c80f4c2` plus the **Wave 0 security change set**. At the time of writing `git status` shows it as uncommitted work on `c80f4c2`: 43 tracked files modified and 13 new files. It is pending its review gate. Read-only here. |
| Writes | This file only. The decision-record half of W0-02 (acceptance line 3) is already done: the orchestrator recorded D14–D19 in `decisions.md`, including the R1 override as D19(a). This file does not change `decisions.md` or `app/`. |
| Review | Architect and appsec reviewer (W0-02 security line) |

> **The matrix in five lines**
> 1. All 24 TM controls, all 21 B/H/M/L review items and all 18 UX items map to at least one unit. 48 of those 63 have an N-, A- or motion A-check test. The other 15 are proved only by an acceptance line or an §6.3 runtime check (§12.2).
> 2. 19 of the 20 baseline findings (SEC-nn) have an implementing unit. **SEC-06 / H-1 (git-history rewrite) has neither a unit nor a test.** 15 fix-plan commits landed in the Wave 0 change set (C-13 and C-17 only partly) and are extended by named units (§7).
> 3. The five requested abuse cases are in §9: fake-notice hold squatting, IBAN/WhatsApp swap under the 24 h delay, admin session theft, email squatting and booking flooding. Each gives the attack path, the controls with their units and tests, and the residual risk.
> 4. **7 gaps** (§12.1). Each is a threat or finding with no implementing unit or no test. Two came up only while tracing: the sequential WhatsApp-then-IBAN swap, and Free-plan quota exhaustion.
> 5. **8 reconciliation items** (§11) where the Wave 0 change set and the plan disagree. Two block wave 1: the migration `0007` numbering and column-type collision (R-01), and token revocation checked against `iat` instead of `auth_time` (R-02).

---

## Contents
0. [Conventions and test ids](#0-conventions-and-test-ids)
1. [Coverage summary](#1-coverage-summary)
2. [Threat-model controls TM-01 … TM-24](#2-threat-model-controls-tm-01--tm-24)
3. [Review items B, H, M, L](#3-review-items-b-h-m-l)
4. [UX items UX-01 … UX-18 and the storage rule](#4-ux-items-ux-01--ux-18-and-the-storage-rule)
5. [Deferred items (11 §0.4)](#5-deferred-items-11-04)
6. [Baseline findings SEC-01 … SEC-20](#6-baseline-findings-sec-01--sec-20)
7. [Baseline fix plan C-1 … C-19, H-1 and O-1 … O-5](#7-baseline-fix-plan-c-1--c-19-h-1-and-o-1--o-5)
8. [Decisions D14 … D19](#8-decisions-d14--d19)
9. [Abuse cases](#9-abuse-cases)
10. [Threat-model abuse list AB-1 … AB-21 (13 §8)](#10-threat-model-abuse-list-ab-1--ab-21-13-8)
11. [Wave 0 change set vs plan: reconciliation items](#11-wave-0-change-set-vs-plan-reconciliation-items)
12. [Gaps and weak coverage](#12-gaps-and-weak-coverage)

---

## 0. Conventions and test ids

| Notation | Meaning | Source |
|---|---|---|
| `N-nn` | Negative test N-01 … N-62, including N-30b. N-31 … N-48 are defined in 13 §10. | 11 §6.4 |
| `A-1` … `A-5` | Journey walks. 11 §6.5 does not number them, so they are numbered here. Proposal: adopt these ids in 11 §6.5. | 11 §6.5 |
| `MA1` … `MA6` | Motion common acceptance A1–A6 of 12 §8.1. Renamed here so they do not collide with the journey walks. | 12 §8.1 |
| `Wx-yy#k` | Acceptance line *k* of unit Wx-yy, counted in the order of `11-units.json` | 11 §5.6 |
| `RT Wx-yy` | The unit's runtime-check row | 11 §6.3 |
| `Wx-RV#k` | Acceptance line *k* of a wave's review gate | 11 §5.6 |
| `SMOKE` | Production smoke tests | 11 §7.8 |
| `13·C-7`, `13·A-3` | STRIDE rows of 13 §6. The prefix is needed because 13 §6 reuses `C-n` and `A-n` for threat rows. | 13 §6 |

**Journey walks (11 §6.5).**

| Id | Walk |
|---|---|
| A-1 | Per-stage walk: every seeded stage opened on `/my-bookings?booking=` and `/admin?booking=`. Checks the label, tracker position, deadline, exactly one next step above the fold at 375 px, admin sections in fixed order, allowed actions and queue membership. |
| A-2 | Default env, WhatsApp channel, end to end: request → WhatsApp reference → approve (flow 2) → accept terms → copy IBAN → WhatsApp notice → `deposit_reported` → record deposit → confirmed → details and consent (re-auth) → production → delivery slot (re-auth) → handover → complete → feedback → privacy clean-up |
| A-3 | No-email walk (UX-04): every customer-facing step has a queue item with a one-tap WhatsApp, the count shows in the tab title and refreshes on focus, and no flow-2 hold expires by itself |
| A-4 | Kill-switch walk (H3): switch off mid-flow, finish with `confirm_offline`, switch on with re-auth |
| A-5 | Train B walk in `mediatest` (W13-02): upload → reject → re-upload → confirm → gallery → select the quota → submit → production → handover → complete; retention dry run |

**Status values.**
- `planned`: implemented by the named units, not yet built.
- `landed in Wave 0 security commit (pending gate), extended by <unit>`: code exists in the Wave 0 change set, and the named unit completes it to the plan's acceptance.
- `deferred`: owner decision or by design, with the reason given.
- `open`: waits on an owner action.
- `GAP-nn`: see §12.1.

"Acc. only" in a test column means the item is proved only by an acceptance line or an §6.3 runtime check. It has no N-, A- or MA- test.

---

## 1. Coverage summary

| Category | Items | With an implementing unit | With an N-, A- or MA- test | Acceptance or RT only | No unit or no test |
|---|---|---|---|---|---|
| TM-01 … TM-24 (13 §9, 11 §0) | 24 | 24 | 20 | 4 (TM-18, TM-22, TM-23, TM-24) | 0 |
| B1–B3, H1–H6, M1–M7, L1–L5 (11 §0, 12 §0.1) | 21 | 21 | 14 | 7 (H4, M3, M4, M5, M6, L4, L5) | 0 |
| UX-01 … UX-18 (11 §0, 12 §0.2) | 18 | 18 | 14 | 4 (UX-12, UX-16, UX-17, UX-18) | 0 |
| SEC-01 … SEC-20 (10 §2) | 20 | 19 | 11 | 8 | 1 (SEC-06) |
| C-1 … C-19 and H-1 (10 §6) | 20 | 19 | 11 | 8 | 1 (H-1) |
| **Gaps** (§12.1; sub-controls, decisions and new threats included) | — | — | — | — | **7** |

---

## 2. Threat-model controls TM-01 … TM-24

| Id | Sev | Control as adopted (11 §0) | Implementing units | Proving tests | Status |
|---|---|---|---|---|---|
| TM-01 | BLOCKER | The baseline go-live items become units. Gate A requires zero open baseline go-live items. | Per C-n in §7: W1-01, W1-02, W1-03, W1-04, W1-14, W1-15, W2-02, W2-03, W2-15, W2-17, W2-18, W3-15, W3-16, W4-08, W5-05, W7-01 | The N-tests of each C-n (§7). W1-RV#3 (C-1, C-5, C-16), W2-RV#2 (C-2, C-8, C-9, C-10, C-17), W3-RV#2 (C-3, C-4, C-11); W6-01#2 re-runs the SEC attacks; gate A is checked in W7-01#1 | planned. Most C-n landed in Wave 0 (§7). See also §12.3 I-02. |
| TM-02 (=B2) | HIGH | Promote by uid with the stored email verified. The admin guard requires the stored email to equal the token email. The owner account is created in the new Firebase project before the public deploy and her uid is recorded. | W1-01 (0008 `email_verified_at`), W1-02, W1-12, W2-15, W7-01 | N-31, N-32, N-12; RT W1-12; SMOKE (uid in the release log) | planned. The C-1 part landed in Wave 0 (R-01, R-03). |
| TM-03 (=H2) | HIGH | Bank, contact, deposit and terms writes need a second factor once `ADMIN_SETTINGS_2F="required"`. Until then a change to an existing bank or contact revision takes effect after 24 h, and re-saving the effective values cancels it. Customers see «آخر تحديث…» and a 72 h number-changed notice. An alert email is sent when email is configured. | W1-01, W1-06, W2-01, W2-10, W2-13, W2-16, W3-04, W4-01, W4-05, W5-01 | N-45; RT W2-01 (pending 24 h, cancel); RT W2-13 (a pending revision is never shown); W6-03#1; A-2; §9 AC-2 | planned. The default is D19(a). **GAP-05** (sequential swap). |
| TM-04 | HIGH | `findPaymentInstructionLike` runs on every admin-authored text a customer sees. Pickup moves to AD+R. Such text is rendered plain, with no autolinking. | W1-10, W2-01, W2-02, W3-04, W4-01, W4-02, W4-06 | N-33, N-34, N-20; `tests/text.test.mjs` (RT W1-10); W6-03#1 | planned |
| TM-05 (=H6) | HIGH | One deploy path: `release.mjs` plus preflight, a clean tree, the annotated-tag rule and a pinned design. An unset design flag means classic. | W1-16, W2-18, W2-19, W3-19, W7-01 | N-35, N-54, N-62 | planned |
| TM-06 | HIGH | Ownership is resolved centrally, with an identical 404 for foreign and unknown ids. Nested ids are validated through their parent. A two-customer IDOR matrix is run. | W1-04, W2-06, W2-09, W2-13, W3-01, W9-02, W10-02; verified in W6-01, W13-01 | N-04, N-36; RT W1-04 (byte-identical 404); W6-01#1; W13-01#1 | planned. The C-16 part landed in Wave 0. |
| TM-07 | MED | Every admin route requires `auth_time` ≤ 12 h and ≥ `tokens_valid_after`. "Sign out everywhere" and the promote script both stamp that mark. Idle sign-out after 30 min. Incident order is fixed. | W1-01, W1-02, W1-08, W1-12, W2-05, W4-03, W5-01, W5-04 | N-44; RT W2-05 (revoke-all → 403); W5-RV#1; §9 AC-3 | planned. The 12 h check and revocation landed in Wave 0 with `iat` semantics (**R-02**). **GAP-06**. |
| TM-08 | MED | Customers need a sign-in ≤ 10 min old to grant consent, book a delivery or change phone or email. The admin sees labels for "consent not yet confirmed" and "phone changed". | W1-02, W1-08, W2-06, W2-15, W3-01, W3-07, W3-11, W3-13, W4-02, W5-04 | N-39; RT W2-15 (phone change with an old token → 403); RT W3-01 (delivery re-auth); A-2 | planned |
| TM-09 | MED | Upload and serve rules: sniff before storing, cap trailing bytes and dimensions, strip or refuse metadata, strict media headers, MAC verified before any I/O, revocation check, bounded lifetimes, private bucket | W8-01, W9-01, W9-02, W9-03, W10-01, W10-02, W12-02 (N-47 procedure), W13-01, W13-03 | N-23, N-24, N-37, N-38, N-47; A-5 | planned (Train B, dark) |
| TM-10 | MED | `getMediaBucket` is the single choke point. A grep gate enforces it. The deny-list is extended. Events carry ids only. | W1-03, W1-04 (E1), W1-13, W9-01, W9-02, W9-03, W10-01, W10-02 | N-13, N-14, N-48; RT W1-03; RT W1-13 (planted violation) | planned |
| TM-11 | MED | The binding carries burst limits. Hourly and daily caps are SQL caps. Events are written only on change. Consent ≤ 10 changes a day. `RL_UPLOAD` is 2. Availability is edge-cached and IP-limited. | W1-03, W1-15, W2-06, W2-09, W2-13, W2-15, W2-17, W3-01, W3-15, W9-02 | N-40; RT W1-15, RT W2-17, RT W3-15 | planned. The C-4 burst part landed (binding names: **R-04**). |
| TM-12 | MED | `normalizeFreeText` on every free-text field. User strings go in `<bdi>`. `mailto:` and `tel:` use fixed schemes only. No `href` is built from free text. Covers C-13. | W1-10, every handler unit (W2-01, W2-06, W2-08, W2-09, W2-15, W3-01), W2-04, W3-07 and the admin UIs | N-41, N-20; `tests/text.test.mjs` | planned. The C-13 part landed (partial). |
| TM-13 | LOW | CSV neutralisation additions: numeric columns unprefixed, PII warning, tested in 4 spreadsheet apps | W2-12, W4-03 | N-09, N-42, N-26; `tests/csv.test.mjs`; W6-02#2 | planned |
| TM-14 | MED | CSP enforced within 7 days of the first deploy. Report endpoint added. Unused Google hosts pruned. Trusted Types in Report-Only. `assetsInlineLimit: 0` plus a preflight check. Enforced-CSP trial on preview. | W1-16, W2-17, W2-18, W3-19, W5-05, W6-02, W6-05, W7-01 | N-27, N-43; RT W2-17 (counts only); SMOKE (enforcement within 7 days) | planned (see §12.3 I-02) |
| TM-15 | MED | Capacity and eligibility checks inside the writing statement. `extend_hold` is a compare-and-swap. Random claim tokens. Re-check before send. Two-phase purge. | W2-02, W2-03, W2-08, W3-01, W3-03, W4-07, W8-02, W11-04 | N-18, N-46, N-30b; W6-01#1 (extend vs cron, slot capacity) | planned |
| TM-16 | LOW | IBAN shown in `<bdi dir="ltr">`, grouped. The copy button copies the normalised value. A warning shows when the bank changed after acceptance. | W2-13, W4-01 | N-56; W6-03 walk | planned |
| TM-17 | MED | Console grep gate. Search moves to POST. CSP reports keep the directive and origin only. | W1-13, W2-17, W3-02, W3-09, W4-03 | N-08, N-28, N-61; RT W1-13 | planned |
| TM-18 | LOW | The `terms_accepted` event carries `bodySha256`. The customer can view the exact version she accepted. | W2-01, W2-13, W4-01, W4-06 | W2-13#2; N-16 covers the version mismatch only. **Acc. only** for the hash. | planned |
| TM-19 | LOW | One WhatsApp builder, with no `wa.me` literal anywhere else. Message cap. Number-changed notice. | W1-11, W1-13, W2-14, W4-05 | N-21; RT W1-11; W1-13 grep gate | planned |
| TM-20 | LOW | Notices, receipts and hash matches are not proof of payment. `confirm_payment` records the amount seen in the bank statement. Links inside receipt PDFs are not followed. | W2-02, W4-04, W5-04, W11-01 | N-17; W6-03#2 (under- and over-recording) | planned |
| TM-21 | LOW | `ADMIN_MEDIA_MFA` counts as off only for the exact value "off". The blocker is listed. The preflight refuses "off" in production. | W1-02, W1-06, W3-19 | N-35 | planned. The landed `ADMIN_REQUIRE_MFA` must also be covered (**R-04**). |
| TM-22 | LOW | Motion tooling binds 127.0.0.1 on a random port with a temp profile, and never prints `VITE_*` values | W2-21 | W2-21#1; W2-RV. **Acc. only**. | planned |
| TM-23 | LOW | 2FA on the Cloudflare and Firebase owner accounts. Scoped tokens. A bookmark before every remote write. Documented that D1 triggers do not bind account holders. | W0-03, W5-04, W7-01 | W0-03#3; W7-01 release log. **Acc. only**. | **open**. W0-03 found Google 2-Step Verification in progress and Cloudflare 2FA not verified. |
| TM-24 | LOW | Preview behind Cloudflare Access, on the dev Firebase project, read-only | W1-03, W2-17, W5-05 | RT W5-05; RT W2-17; W6-02. **Acc. only**. | planned. The read-only guard landed through C-8. |

---

## 3. Review items B, H, M, L

B, H, M and L items come from 11 §0 and 12 §0.1. H2 = TM-03 and H6 = TM-05 (12 §0.1 lists H6 together with TM-05).

| Id | Sev | Control as adopted | Implementing units | Proving tests | Status |
|---|---|---|---|---|---|
| B1 | BLOCKER | A notice for the current deadline protects the hold. `confirm_payment` and `extend_hold` stay allowed for a 72 h grace. `reinstate_hold` works only when the date is free. No automatic flow-2 expiry without email. Flow-2 approval email. `decide_now` queue section. | W2-02, W2-03, W2-04, W2-10, W2-13, W2-16, W4-05, W6-03 | N-30, N-30b, N-50, N-51, N-19; A-2, A-3; §9 AC-1 | planned |
| B2 | BLOCKER | = TM-02 | W1-01, W1-02, W1-12, W2-15, W7-01 | N-31, N-32, N-12 | planned. C-1 landed. |
| B3 | BLOCKER | Old-database inventory. Launch floor. Rollback below the floor refused. A separate "revert to pre-launch" runbook. | W0-03, W3-19, W5-04, W7-01 | N-49, N-62 | planned. **W0-03 done 2026-09-28**: the old D1 is not in the deploying account and no pre-launch version exists (D19(c)). The evidence N-49 needs exists. |
| H1 | HIGH | Browser-key referrers include `<projectId>.firebaseapp.com`. Real verification and reset links are clicked. Config guard. Env files per mode. | W2-18, W3-19, W5-04, W7-01 | N-53; SMOKE (real links) | planned. Blocked by D16 until the owner enables Google 2-Step Verification. |
| H2 | HIGH | = TM-03 | as TM-03 | N-45 | planned. The H2 #3 alert is deferred (§5). |
| H3 | HIGH | D1 kill switch: off needs AD, on needs AD+R. `confirm_offline`. The cron skips flow-2 expiry while the switch is off. | W1-01, W1-06, W2-01, W2-02, W2-03, W3-04, W6-03 | N-52, N-15; A-4 | planned |
| H4 | HIGH | `/privacy` and `/disclosure` exist. Links at every point of collection. The preflight refuses a release while any legal text is missing. | W3-13, W3-16, W3-19, W4-02, W4-08, W7-01 | RT W3-16 and W4-08; W3-19#1 (legal texts present); SMOKE. **Acc. only**. | planned. **GAP-03**: nobody is assigned to write the text or add the business-identity fields. |
| H5 | HIGH | Two release trains. Train B ships dark. | §5.3 structure, W13-03 | N-35 (no `r2_buckets`); W13-03#1 (every gated route 503); SMOKE | planned |
| H6 | HIGH | = TM-05 (unset design flag means classic, one deploy path) | W1-16, W2-19, W3-19 | N-54 | planned |
| M1 | MED | `created_at` stamped by SQL. `reauthAt` comes only from `auth_time`. | W1-02, W1-09, W2-01 | N-58, N-10 | planned |
| M2 | MED | Riyadh day and time helpers. "Today" is never SQL `date('now')`. | W1-10 | N-59; `tests/timing.test.mjs` | planned |
| M3 | MED | Joint schedule with exclusive file ownership. The re-auth dialog files belong to the MFA unit. `features.blockers` lives in W1-06. | §5.5, W1-06, W5-01 | Mechanical ownership check over §5.5; W5-RV#1. **Acc. only**. | planned. **R-07**: the Wave 0 files are outside the owner map. |
| M4 | MED | Preview runbook: count admins, bookmark, migrate, Access, read-only | W1-03, W2-17, W5-05 | RT W5-05; RT W2-17. **Acc. only**. | planned |
| M5 | MED | `whenReady()` caches the loaded module. The router renders it directly, so the view-transition snapshot holds the destination H1. | W1-18, W4-09 | W1-18#1, W4-09#1. **Acc. only**. | planned |
| M6 | MED | `npm test` on Node built-ins. `verify`. Merge hooks. Two reviewers per unit. | W1-13, every RV gate | RT W1-13 (each gate fails on a planted violation). **Acc. only**. | planned |
| M7 | MED | Classic-parity hard gate: DOM plus emitted-CSS hashes; screenshots after fonts and decode | W2-21 | MA2; W2-21#1 | planned |
| L1 | LOW | An old admin bundle ignores unknown actions | W1-07 | N-60 | planned |
| L2 | LOW | No-delete triggers on status history and events. `admin_promoted` and `admin_demoted` audit rows. | W1-01, W1-12 | N-11; RT W1-12 (audit rows) | planned. The landed `grant-admin.mjs` writes no audit row (**R-03**). |
| L3 | LOW | Build and release refuse `ADMIN_MEDIA_MFA` values other than "required" | W3-19 | N-35 | planned |
| L4 | LOW | `wrangler tail` during the launch window. Hourly queue check on day one. | W5-04, W7-01 | W7-01#2 (release log). **Acc. only**. | planned |
| L5 | LOW | The ticker waits for the owner's written D12 decision | W5-03 | W5-03#1. **Acc. only**. | Decided by default: D19(e), static band |

---

## 4. UX items UX-01 … UX-18 and the storage rule

| Id | Sev | Control as adopted | Implementing units | Proving tests | Status |
|---|---|---|---|---|---|
| UX-01 | HIGH | Intro skipped for 60 days after it plays. Visible sequence ≤ 1.8 s. One fade ≤ 400 ms. Decode wait ≤ 200 ms. Hero H1 and CTA visible by t0 + 2.2 s. | W5-02, W2-21 | MA4 (includes t0 + 2.2 s); W5-02#1; W2-21#1 (`logo-not-ready` rate); W6-05 | planned |
| UX-02 | HIGH | `deposit_reported` sub-state. Notices never move the deadline. Protected holds go to `decide_now`. Squatting is bounded (§9 AC-1). | W2-03, W2-10, W2-13, W2-16, W4-05, W6-03 (the W0-02 abuse case is §9 AC-1) | N-19, N-50, N-30b; A-2; W6-03#2 | planned. **GAP-04**. |
| UX-03 | HIGH | `waDigits` used only in the `href`. One tap from `/admin` to a prefilled WhatsApp. | W2-10, W3-05 | N-57 | planned |
| UX-04 | HIGH | No-email path: WhatsApp reference after submit, pending copy, count in the tab title, refetch on focus | W3-05, W3-20, W4-05, W6-04 | A-3; RT W3-20 | planned. In effect under D19(b). |
| UX-05 | MED | Four primary destinations below 48rem. Fixed queue order. Sticky summary on phones. | W1-05, W2-10, W3-05, W4-03 | RT W2-10 (fixed order); W6-04#1 (admin at 375 × 812); A-1 | planned |
| UX-06 | MED | A queue item leaves only on a state change or a sent/dismissed log row | W1-01, W2-05, W2-10, W3-05, W3-07 | RT W2-05 (contact-log outcomes); W3-05#2; A-3 | planned |
| UX-07 | MED | `toAsciiDigits` on client and server. `inputmode` set. `dir="ltr"` on IBAN and phone inputs. | W1-10, W1-11, W2-15, W3-04, W3-13, W4-02 | N-05, N-21, N-22, N-55 | planned. A client helper landed in Wave 0 (**R-07**). |
| UX-08 | MED | IBAN grouped inside `<bdi>`. The copy button copies the raw 24 characters. Changed-bank copy. | W2-13, W4-01 | N-56 | planned |
| UX-09 | MED | View-transition timings. `pointer-events: none`. Pending hairline. Entry through a view transition skips E5 and E7. | W4-09 | W4-09#1; MA3, MA5; W6-05 | planned |
| UX-10 | MED | No mount veils. A filter change adds no motion. | W2-20 | W2-20#1; MA2, MA3; W6-05 | planned |
| UX-11 | MED | The intro finishes on focusin, click or navigation. Jank guard. VoiceOver and TalkBack acceptance. | W5-02 | W5-02#1; MA3; W6-05 | planned |
| UX-12 | MED | Gold corners with an ink hairline. Accent text only on paper or surface. ≥ 4.5:1 at rest. | W1-05, W2-20, W4-10, W5-02 | W1-05#3, W4-10#1; W3-RV#1 contrast spot checks. **Acc. only**. | planned |
| UX-13 | MED | Tap targets ≥ 44 × 44 px. Gallery select toggle. Lightbox on the existing dialog pattern. Agenda view on phones. | §5.1 DoD, W1-05, W3-06, W3-10, W4-02, W11-03, W12-01 | MA3 (≥ 44 px); RT for the W3-x and W4-x UIs; W3-RV#1; A-5 | planned |
| UX-14 | MED | Gated-mode copy. «آخر تحديث». Exactly one primary action per stage. | W2-16, W4-05, W6-04 | A-1 (next step and deadline above the fold at 375 px); W6-04#1 | planned |
| UX-15 | LOW | Terms inline. The whole checkbox row is the label. Receipt sent as an image over WhatsApp. | W2-14, W4-01, W4-05 | A-2; W4-01#1, W4-01#3; RT W2-14 (copy review) | planned |
| UX-16 | LOW | Read-only username field. «التحقق صالح حتى» | W1-08, W3-04 | W1-08#2; W5-RV. **Acc. only**. | planned. A re-auth host landed in Wave 0 (**R-07**). |
| UX-17 | LOW | TalkBack. One screen-reader stop per heading. Line breaks equal classic. | W3-17 | W3-17#1. **Acc. only**. | planned |
| UX-18 | LOW | Ticker static on coarse pointers, paused under dialogs, toggle name switches | W5-03 | W5-03#1. **Acc. only**. | planned. Moot while the static band ships (D19(e)). |
| Storage (12 §0.2) | — | Only `sy:intro:v1` is stored | W1-13 (grep gate), W5-02 | N-28; MA6 | planned |

---

## 5. Deferred items (11 §0.4)

| Item | What is deferred | Compensating controls (units) | Tests | Status |
|---|---|---|---|---|
| SEC-11 for customers | The plan checks `tokens_valid_after` on admin requests only | Customer residual ≤ 60 min | — | Deferred in the plan, but partly superseded: Wave 0 checks revocation wherever the users row is loaded, customers included (**R-08**, §12.3 I-03) |
| H2 #3 out-of-band alert | The alert email is sent only when email is configured | 24 h delay, customer notices, admin banner and queue alert (W2-01, W2-10, W3-04, W4-01) | N-45 | Deferred: D19(b), no email provider at launch |
| TM-11 hourly limits on the binding | The binding supports only 10 s and 60 s windows | SQL caps inside the writing statement (W1-15, W3-15) | RT W3-15, N-40 | By design |
| TM-14 Trusted Types enforcement | Trusted Types stays Report-Only at launch | CSP enforced separately (W2-18, W7-01) | N-43 | Deferred until a clean Report-Only period |
| C-6/C-7 "MFA required" | TOTP is available but not required to sign in | TM-03 delay, TM-07 sessions; Train B keeps `ADMIN_MEDIA_MFA="required"` (W1-02, W3-19) | N-44, N-45, N-35 | Deferred by owner decision D19(a) (R1 override). C-7's 12 h part landed. |
| C-12, C-15, C-19 | Not deferred | W3-20, W1-08, W8-02 | see §7 | C-19 in production: **GAP-02** |

---

## 6. Baseline findings SEC-01 … SEC-20

| SEC | Sev | Finding (short) | Fix plan | Implementing units | Proving tests | Status |
|---|---|---|---|---|---|---|
| SEC-01 | MED | Admin role granted by email; unverified email never re-synced | C-1, C-2 | W1-02, W1-12, W2-15, W7-01 | N-31, N-32, N-12; W6-01#2 | landed in Wave 0 security commit (pending gate), extended by W1-02, W1-12 |
| SEC-02 | MED | Single-factor admin, no session age, SPA cannot complete MFA | C-6, C-7 (+TM-07, TM-03) | W1-02, W1-08, W2-05, W5-01 | N-44; W5-RV#1 | C-7 (12 h `auth_time`, `ADMIN_REQUIRE_MFA` default off) landed in Wave 0 security commit (pending gate), extended by W1-02. C-6 planned in W5-01. MFA-required deferred (§5). |
| SEC-03 | MED | Unbounded booking requests | C-3, C-4 | W1-15, W2-17, W3-15 | RT W3-15 (4th open → 409, 6th in an hour → 429, beyond 730 days → 400); W6-01#2. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W3-15, W1-15 |
| SEC-04 | MED | Email squatting through an unverified token email | C-2 | W1-01, W2-15, W3-15 | RT W2-15 (squatting reproduction closed); N-31, N-32 (admin path); W6-01#2 | landed in Wave 0 security commit (pending gate), extended by W2-15, W3-15 |
| SEC-05 | MED | Request bodies buffered without a byte cap | C-5 | W1-14 | N-06; RT W1-14 (chunked 2 MB → 413) | landed in Wave 0 security commit (pending gate), extended by W1-14 |
| SEC-06 | MED | Git history holds full-resolution originals with camera metadata | H-1 | **none** | **none** | **GAP-01** |
| SEC-07 | LOW | CSP Report-Only with no reporting endpoint | C-10 | W2-17, W2-18, W7-01 | N-27, N-43; RT W2-17; SMOKE | planned |
| SEC-08 | LOW | "Browse-only" preview exposes the write API | C-8 | W1-03, W2-17, W5-05 | RT W2-17 (403 `PREVIEW_READ_ONLY`); RT W5-05. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W2-17, W5-05 |
| SEC-09 | LOW | Item quantities unbounded | C-12 | W3-20 | RT W3-20. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W3-20 |
| SEC-10 | LOW | Bidi controls and URLs in names; no isolation | C-13 (partial) | W1-10, W2-04, W2-15, W3-07 | N-41, N-20 | landed in Wave 0 security commit (pending gate) as partial, extended by W1-10, W2-04 |
| SEC-11 | LOW | No token revocation | C-14 | W1-01, W1-02, W2-05, W5-01 | N-44 (see GAP-06) | landed in Wave 0 security commit (pending gate), extended by W1-02, W2-05 (**R-01**, **R-02**) |
| SEC-12 | LOW | No HSTS or COOP | C-9 | W1-14, W2-18, W7-01 | SMOKE (header check); W6-02#2. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W1-14, W2-18 |
| SEC-13 | LOW | Version Preview URLs on by default | C-8 | W1-03, W3-19 | N-35 (`preview_urls`) | landed in Wave 0 security commit (pending gate), extended by W1-03, W3-19 |
| SEC-14 | LOW | Pseudonymisation undone by `PUT /api/profile` | C-2 | W2-15 | RT W2-15 (erased → 410). **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W2-15 |
| SEC-15 | LOW | PII collected with no privacy notice | C-11 | W3-13, W3-16, W3-19, W4-02, W4-08 | RT W3-16 and W4-08; W3-19#1. **Acc. only**. | planned. The text is **GAP-03**. |
| SEC-16 | INFO | Ownership left to each future handler | C-16 | W1-04 | N-04, N-36; RT W1-04 | landed in Wave 0 security commit (pending gate), extended by W1-04 |
| SEC-17 | INFO | No retention or erasure | C-19 | W8-02 (Train B, off in production) | W8-RV#1 (dry run); A-5 | planned in Train B only. Production enablement and erasure: **GAP-02**. |
| SEC-18 | INFO | Full name copied into Firebase `displayName` | C-15 | W1-08 | W1-08#3. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W1-08 |
| SEC-19 | INFO | 24 h hold unenforced; past-dated approvals accepted | C-17 (partial) | W2-02, W2-03 | N-30, N-30b; RT W2-02 (past date refused) | landed in Wave 0 security commit (pending gate) as partial, extended by W2-02, W2-03 |
| SEC-20 | INFO | No recent-auth requirement for private-media routes | C-18 | W1-02, W9-02, W10-02 | W10-RV#1; W13-01#1. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W1-02, W9-02, W10-02 (**R-06**) |

---

## 7. Baseline fix plan C-1 … C-19, H-1 and O-1 … O-5

"Wave 0 evidence" names files observed in the Wave 0 change set. Behaviour is not re-verified here; that is the job of the Wave 0 gate and W0-01.

| C | Findings | Commit intent (10 §6) | Wave 0 evidence | Extending units | Proving tests | Status |
|---|---|---|---|---|---|---|
| C-1 | SEC-01 a, b | Admin bound to uid and verified email; promote by uid | `worker/admin-auth.ts`, `worker/users.ts`, `scripts/grant-admin.mjs` | W1-02 (guard, `auth_time`), W1-12 (promote script, audit, stamp) | N-31, N-32; W1-RV#3 | landed in Wave 0 security commit (pending gate), extended by W1-02, W1-12 |
| C-2 | SEC-04, SEC-01 c, SEC-14 | `email_verified_at`, conditional upsert, reclaim, erased → 410, re-sync | `migrations/0007_users_email_verified_and_token_revocation.sql`, `worker/profile.ts`, `worker/users.ts`, `worker/bookings.ts` | W1-01 (0008, **R-01**), W2-15, W3-15 | RT W2-15; N-31; W2-RV#2; W6-01#2 | landed in Wave 0 security commit (pending gate), extended by W1-01, W2-15, W3-15 |
| C-3 | SEC-03 | Open-request cap of 3 and a 730-day horizon | `worker/bookings.ts`, `shared/timing.ts`, `src/components/BookingCalendar.tsx` | W3-15 (≤ 5 per hour SQL cap, plan codes) | RT W3-15; W3-RV#2. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W3-15 |
| C-4 | SEC-03 | Rate-limit bindings on booking and profile writes | `wrangler.jsonc`, `worker/rate-limit.ts`, `worker/profile.ts`, `worker/bookings.ts` | W1-03, W1-15, W2-15, W3-15 (**R-04**) | RT W1-15; RT W3-15; W3-RV#2. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W1-15 |
| C-5 | SEC-05 | Bounded JSON reader for the legacy handlers | `worker/http.ts`, `worker/profile.ts`, `worker/bookings.ts`, `worker/admin.ts` | W1-14 | N-06; RT W1-14; W1-RV#3 | landed in Wave 0 security commit (pending gate), extended by W1-14 |
| C-6 | SEC-02 part 1 | MFA sign-in resolver, TOTP enrolment, re-auth | — | W5-01 (re-auth base in W1-08) | RT W5-01; W5-RV#1. **Acc. only**. | planned |
| C-7 | SEC-02 part 2, R1 | TOTP required and a 12 h `auth_time` limit | `worker/auth.ts`, `worker/admin-auth.ts` (12 h check; `ADMIN_REQUIRE_MFA` switch, default off) | W1-02 (RA and 2F helpers), W3-19 (the preflight must cover the new var) | N-44; N-35 | landed in Wave 0 security commit (pending gate), extended by W1-02. "MFA required" stays off (D19(a)). |
| C-8 | SEC-08, SEC-13 | Preview read-only; `preview_urls: false` | `wrangler.jsonc`, `worker/index.ts` | W1-03, W2-17, W5-05 (Access) | N-35; RT W2-17; RT W5-05; W2-RV#2 | landed in Wave 0 security commit (pending gate), extended by W2-17, W5-05 |
| C-9 | SEC-12 | COOP on the SPA; HSTS on the API | `public/_headers`, `worker/http.ts` | W1-14#2, W2-18 | SMOKE; W6-02#2; W2-RV#2. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W1-14, W2-18 |
| C-10 | SEC-07 | Enforced CSP with violation reporting | — | W2-17, W2-18, W7-01 | N-27, N-43; RT W2-17; SMOKE | planned (§12.3 I-02) |
| C-11 | SEC-15 | Privacy route and point-of-collection links | — | W3-16, W4-08 | RT W3-16 and W4-08; W3-RV#2. **Acc. only**. | planned. The text is **GAP-03**. |
| C-12 | SEC-09 | Per-item quantity ceilings | `shared/booking.ts`, `src/components/PackageConfigurator.tsx` | W3-20 | RT W3-20. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W3-20 |
| C-13 | SEC-10 | Refuse bidi characters; isolate names in admin views and emails | Partial: name isolation in `worker/email-templates.ts`, `src/auth/person-name.ts` | W1-10 (validator), W2-04, W2-15, W3-07 | N-41, N-20 | landed in Wave 0 security commit (pending gate) as partial, extended by W1-10 |
| C-14 | SEC-11 | `tokens_valid_after` revocation and the incident runbook | Migration `0007_…` (landed), `worker/users.ts`, `scripts/revoke-sessions.mjs` | W1-01, W1-02, W2-05, W5-04 (**R-01**, **R-02**) | N-44 (**GAP-06**) | landed in Wave 0 security commit (pending gate), extended by W1-02, W2-05 |
| C-15 | SEC-18 | Stop copying the full name into `displayName` | `src/auth/AuthContext.tsx` | W1-08 | W1-08#3. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W1-08 |
| C-16 | SEC-16 | Central ownership in the dispatchers | `worker/portal/portal-routes.ts`, `worker/portal/request.ts` | W1-04 | N-04, N-36; RT W1-04; W1-RV#3 | landed in Wave 0 security commit (pending gate), extended by W1-04 |
| C-17 | SEC-19 | Flow 2 on approve; targeted expiry; no past-date approval | Partial: past-date approval refused in `worker/admin-workflow.ts`; small edits to the hold jobs | W2-02, W2-03 | N-30, N-30b; RT W2-02; W2-RV#2 | landed in Wave 0 security commit (pending gate) as partial, extended by W2-02, W2-03 |
| C-18 | SEC-20 | Recent sign-in required for private-media routes | `worker/portal/request.ts` (10 min) | W1-02 (12 h CO+M helper), W9-02, W10-02 (**R-06**) | W10-RV#1; W13-01#1. **Acc. only**. | landed in Wave 0 security commit (pending gate), extended by W1-02, W9-02, W10-02 |
| C-19 | SEC-17 | Retention prune, text purge and a scripted erase, with a 90-day hard deadline | — | W8-02 (job only; off by default and refused by the production preflight) | W8-RV#1; A-5 | planned (Train B). **GAP-02**. |
| H-1 | SEC-06 | Rewrite history before the first push | — | **none** | **none** | **GAP-01** |

**Operational checks (10 §6.0).**

| O | Action | Units | Evidence | Status |
|---|---|---|---|---|
| O-1 | Compare the admin rows with the owner's verified uid | W0-03#3, W7-01 (promotion by uid) | `release/w0-inventory.md` | Moot for the old D1 (not in the account, D19(c)). Applies to the new D1 at W7-01. |
| O-2 | Email-enumeration protection on; password policy; preview host not in authorised domains | W0-03#3, W7-01 (runbook §7.3 step 2) | SMOKE | open. Waits for the new Firebase project (D16). |
| O-3 | Version Preview URLs disabled | C-8 (`preview_urls: false` landed), W1-03 | N-35 | landed in config. The production Worker is not deployed yet. |
| O-4 | No preview rebuild before C-8; no git remote or push before H-1 | — | — | C-8 part landed. The H-1 part is **GAP-01**. |
| O-5 | Record the Resend quota to size the SEC-03 limits | — | — | Moot under D19(b) (no email at launch) |

---

## 8. Decisions D14 … D19

The orchestrator recorded these in `decisions.md`. Tracing them here closes W0-02 acceptance line 3.

| D | Decision (short) | Units | Tests | Status |
|---|---|---|---|---|
| D14 | Train A is the first-client release; Train B (private media) is merged dark | §5.3; W7-01, W13-03 | Gate A (W7-01#1); gate B (W13-03#1); N-35 | planned |
| D15 | Security first: reviews and attacks before any edit, merge, push or deploy; baseline fixes land first | W0-01, every Wx-RV, W6-01…W6-03, W13-01 | RV reports; W6-01#2 | in force. The Wave 0 change set is pending its gate. |
| D16 | New Firebase project under the owner's Google account | W2-18 (config guard), W3-19, W7-01 (§7.3) | N-53; SMOKE | **open**. Blocked until the owner enables Google 2-Step Verification. |
| D17 | Private media built, tested and shipped gated off; deposit receipts go over WhatsApp | W1-03, W3-19, W4-01, W4-05, W7-01, W13-03 | N-13, N-35, N-48; SMOKE (media routes → 503) | planned |
| D18 | "Cinematic native" motion; build flag and tag `design-classic-v1` as the restore point; cinematic only if W6-05 passes | W1-16, W2-19, W3-19, W6-05 | N-54; MA2; W6-05#1 | planned |
| D19(a) | 24 h delay for IBAN and WhatsApp changes; MFA optional (R1 override) | W2-01, W3-04, W4-01, W5-01 | N-45 | defaulted, owner to confirm. **GAP-05**. |
| D19(b) | No email provider at launch | W2-03 (AX off), W3-05, W3-20, W4-05 | N-30, A-3 | defaulted |
| D19(c) | Fresh production D1; nothing migrated | W0-03 (done), W7-01 | N-49 | defaulted. Inventory recorded. |
| D19(d) | Privacy notice and disclosure drafted by the team from the actual data handling; business-identity fields filled by the owner in admin settings, hidden until filled; marked "pending legal review" | W3-16, W4-08 (render only) | RT W3-16 | **GAP-03** (no drafting unit, no identity fields) |
| D19(e) | Services ticker is a static band | W5-03 | W5-03#1 | defaulted |
| D19(f) | Workers Free plan; production D1 location hint `eeur` | W7-01 (§7.4) | — | defaulted. **GAP-07**. |

---

## 9. Abuse cases

Attacker labels follow 13 §3:
- X1: anonymous.
- X2: registered customer.
- X3: someone on the bride's device or a relative.
- X4a: stolen admin token, no password.
- X4b: stolen admin password.
- X5: shared or lost device.
- X6: operator or cloud-account holder.

### 9.1 AC-1: Hold squatting through fake deposit notices (UX-02 variant A)

| | |
|---|---|
| Attacker | X2: a customer with a verified email, for example a competitor, or a bride keeping a second studio in reserve |
| Goal | Keep a sought-after date blocked without paying, or for longer than the 48 h hold |
| Preconditions | Effective online confirmation on with complete settings. The admin approved the request. No email provider (D19(b)), so no flow-2 hold expires by itself (B1 #4). |

**Attack path**
1. Request the date. Wave 0 already caps her at 3 open requests, with a 730-day horizon.
2. The admin approves. The booking becomes flow 2, with a 48 h hold capped before the event.
3. Accept the terms (#3). The sub-state becomes `awaiting_deposit`.
4. Post the notice (#4) without paying. The sub-state becomes `deposit_reported`, and the hold is now notice-protected: neither the cron nor the targeted sweep expires it.
5. When the studio asks, claim an inter-bank delay to get `extend_hold`. After each extension, send one more notice (one per deadline).
6. Scale out with more accounts and more dates.

| Control | Unit (acceptance) | Test |
|---|---|---|
| A notice is accepted only for the owner's approved flow-2 hold with accepted terms, and only once per deadline. It never changes status or deadline. | W2-13#3 | N-19, N-50; RT W2-13 |
| Protected and overdue holds land in `decide_now`, the first queue section. The count shows in the tab title. | W2-10#1, W3-05#3 | RT W2-10; A-3 |
| A notice is not a payment. `confirm_payment` records the amount seen in the bank statement. | W2-02#3, W4-04#1, W5-04#2 | N-17; W6-03#2 |
| The admin ends the squat explicitly with `expire_hold`. A wrong call can be undone with `reinstate_hold`, only while the date is free. | W2-02#1, W2-02#2 | N-30, N-51; RT W2-02 |
| `extend_hold` is a compare-and-swap and never passes the event start. A notice for an earlier deadline does not protect. | W2-02#2, W2-03#1 | N-50; W6-01#1 (extend vs cron race) |
| Volume is bounded before any hold exists: admin approval, ≤ 3 open requests, ≤ 5 per hour, horizon | W3-15#1 (C-3, C-4 landed) | RT W3-15 |
| Red-team drill | W6-03#2 ("hold squatting through fake notices") | W6-03 report |

**Residual.**
- The date stays held until the admin acts. This is intended: under B1 a paid bride must never lose her date to a machine.
- Without email, the queue is the only signal (UX-04).
- **No unit shows repeat offenders** (prior expired holds, or notices never followed by a recorded deposit). 13 §8 AB-5 names this as a control → **GAP-04**.

**Recommended operating rule for W5-04 (OPERATIONS.md):** decide every `decide_now` item the same day, and never extend a hold on the strength of a notice alone.

**Verdict:** bounded by the admin's decision. Acceptable for launch once GAP-04 is decided.

### 9.2 AC-2: IBAN or studio-WhatsApp swap under the 24 h delay (TM-03)

| | |
|---|---|
| Attacker | Mainly X4b (the admin password was phished or reused). X4a counts too if the stolen token is fresh (`auth_time` ≤ 10 min), because it then passes RA. |
| Goal | Customers transfer deposits to the attacker, or the attacker's WhatsApp "confirms" a new IBAN over chat |
| Preconditions | MFA optional (D19(a)), so `ADMIN_SETTINGS_2F` is off and changed bank or contact revisions are delayed 24 h. No email, so no out-of-band alert (H2 #3 deferred). |

| Variant | Path | Controls (units) | Tests | Residual |
|---|---|---|---|---|
| (a) IBAN swap | Re-auth → save a new bank revision → `effective_at` = now + 24 h. Customers keep the old IBAN. | Delayed activation, cancel by re-save (W1-01, W1-06#2, W2-01#2); pending-change banner with «إلغاء التغيير» (W3-04#2); queue alert `SETTINGS_CHANGE_PENDING` (W2-10#1); a pending revision is never exposed (W2-13) | N-45; RT W2-01; RT W2-13; W6-03#1 | If the owner does not open `/admin` within 24 h, the new IBAN goes live. Customers who accepted earlier then see the changed-bank warning (UX-08, W4-01#2). |
| (b) WhatsApp swap | Save a new contact revision → effective after 24 h → notices and questions reach the attacker | Same delay (W2-01); 72 h number-changed notice quoting the **compiled** public number (W2-16#2, W4-01#2, W4-05#1, W1-11#2); templates and emails carry no bank details (W2-14, W2-04) | N-45 (bank only); N-21; A-2 | Social engineering over WhatsApp (13 §12) |
| (c) Both at once | (a) and (b) together | Two banners and two queue alerts; kill switch (W3-04, W2-01); `confirm_offline` for in-flight bookings (W2-02) | N-52; A-4; W6-03#1 | Detection needs the owner to open `/admin` |
| (d) **Sequential** (found while tracing) | (b) first → wait until the 72 h notice lapses (about 96 h after saving) → then (a). After 24 h the changed-bank warning offers «التأكد منّا عبر واتساب», but its link is built from the **effective** contact revision (`/me` `studio.whatsappNumber`, 11 §3.3 #1), which is now the attacker's. No number-changed notice is shown any more. | No unit states that bank-change verification uses the compiled number | **none** | **GAP-05** |
| (e) Planted instructions | Put an IBAN, phone number or link into pickup, delivery-area, terms or rejection text, which X4a can do without the password | `findPaymentInstructionLike` (W1-10#2, W2-01#3, W2-02#3); pickup needs AD+R (W2-01#3); plain text with no autolink (W4-01, W4-02) | N-33, N-34, N-20 | Low |
| (f) With TOTP enrolled | `ADMIN_SETTINGS_2F="required"` makes changes immediate but needs the second factor | W2-01#2, W5-01 | N-45 (2F → immediate); W5-RV#1 | Real-time phishing of password and TOTP (13 §12) |
| (g) Kill-switch abuse | Turn online confirmation off (AD) | Off is a safety action; on needs AD+R (W2-01#3, W3-04#2) | N-52 | Denial of service only; audited |

**Incident path:** «تسجيل الخروج من كل الأجهزة» → kill switch → disable in Firebase → password or MFA reset. Then review `settings_revisions`, the audit log and the bookings on the bad `bank_revision_id` (W5-04#2, 11 §7.11). **Tested by** the W6-03#1 drill.

**Verdict:** variants (a), (b), (c), (e) and (f) are bounded, provided the owner opens `/admin` at least once a day. Variant (d) is open (GAP-05). Recommended fix: every "verify with us" link and notice tied to a bank change uses the compiled public number from `src/lib/whatsapp.ts`, never the effective contact revision. Optionally, a bank change within N days of a contact change needs 2F.

### 9.3 AC-3: Admin session theft

| Vector | Controls (units) | Tests | Residual |
|---|---|---|---|
| Stolen ID or refresh token (XSS, malicious extension, stolen laptop) used for PII reads | `auth_time` ≤ 12 h and ≥ `tokens_valid_after` on every admin route (W1-02#2; the 12 h check landed with C-7); "sign out everywhere", AD+R (W2-05#1, W5-01#3); 30-min idle sign-out (W1-08#3, W4-03#3) | N-44; RT W2-05; W5-RV#1 | Up to 12 h of reads unless revoked; admin PII reads are not audited (13 §12). **R-02** and **GAP-06**: with the landed `iat` comparison, a refreshed token passes after revocation. |
| Stolen token used for sensitive writes | AD+R: the token's `auth_time` must be ≤ 10 min, re-checked by a DB CHECK on `reauth_at`; `reauthAt` comes only from `auth_time` (W1-02#3, W1-02#4, W1-09, W2-01) | N-10, N-34, N-58 | A token stolen within 10 min of sign-in passes RA; bank and contact changes are still delayed 24 h (AC-2) |
| XSS as the theft channel | React text only; validator; `<bdi>`; no `href` from free text (W1-10, W3-07#2, SB-6); CSP enforced within 7 days, Trusted Types Report-Only (W2-18, W7-01#3) | N-20, N-41, N-27, N-43; W6-02#1 | In the first ≤ 7 days the CSP is Report-Only |
| Token or PII in URLs, storage or logs | Token never in a URL (W1-07); POST search (W3-02); grep gates (W1-13) | N-28, N-61 | — |
| Clickjacking the re-auth dialog or settings save | XFO DENY; `frame-ancestors` (W2-18) | SMOKE; W6-02#2 | — |
| Shared or lost device | Idle sign-out; export PII warning (W4-03#1) | W6-02#2 | Optional `browserSessionPersistence` is not scheduled (13 §7.15, owner's choice) |
| Phished password | → AC-2; optional TOTP (W5-01) | N-45 | MFA optional at launch (D19(a)) |
| Revocation from the owner's machine | The promote script stamps `tokens_valid_after` (W1-12#2); incident order (W5-04#2) | N-31; W6-03#2 | Landed `grant-admin.mjs` does not stamp (**R-03**) |

**Verdict:** the design is sound. The implementation must use `auth_time` for revocation (R-02), and N-44 must cover the refreshed-token case (GAP-06) before gate A.

### 9.4 AC-4: Email squatting (SEC-04)

| | |
|---|---|
| Attacker | X1: registers a Firebase account with the victim's email address, which stays unverified |
| Goal | Block the real owner of the address (409 on profile), misdirect notifications, or, for the owner's own email, get promoted to admin (SEC-01, 13·I-1, AB-13) |

| Variant | Controls (units) | Tests | Residual |
|---|---|---|---|
| Squat a customer's email before she registers | `users.email` is written only from a verified token, which stamps `email_verified_at`. A verified owner can reclaim an unverified row that has no bookings. (C-2 landed; W2-15#1 extends it.) Booking creation already requires a verified email, so a squatter row cannot acquire bookings. | RT W2-15 (reproduction closed); W6-01#2 | Low |
| Squat the owner's email before launch (admin takeover) | Owner account created in the new Firebase console before the public deploy, uid recorded (W7-01#2, §7.3 step 4); promotion by uid plus a verified stored email (C-1 landed; W1-12); the guard compares the stored email with the token email (C-1 landed; W1-02#2); single-admin index (W1-01) | N-31, N-32, N-12; SMOKE | Blocked on D16 (new project) |
| Take over an existing address later (email change) | Phone or email change needs CO+R and stamps `contact_changed_at`; the admin sees a label (W2-15#2, W3-07#1) | RT W2-15 (old token → 403) | — |
| Resurrect an erased profile | Erased user → 410 (C-2 landed; W2-15#2) | RT W2-15 | No erasure mechanism exists yet (GAP-02) |
| Enumerate registered emails | Firebase email-enumeration protection (O-2; §7.3 step 2) | SMOKE | Open until the new project exists |

**Verdict:** closed by C-1/C-2 plus TM-02, provided the owner account is created before the public deploy.

### 9.5 AC-5: Booking-request flooding (SEC-03)

| | |
|---|---|
| Attacker | X2: one or many accounts, scripted |
| Goal | Bury the admin queue, mark public dates as pending, or exhaust plan quotas |

| Variant | Controls (units) | Tests | Residual |
|---|---|---|---|
| One account floods requests | Burst limiter (C-4 landed; W1-15); ≤ 3 open requests and a 730-day horizon (C-3 landed); ≤ 5 per hour SQL cap and plan error codes (W3-15#1); bounded bodies (C-5, W1-14) | RT W3-15; N-06; W6-01#2 | Low |
| Many accounts (Sybil) | Each account needs a verified email (N-03); 3 open requests each; the admin rejects from `requests_over_sla` (W2-10) | N-03; A-1 | 13 AB-16 residual ("many accounts × limits"); no bulk-reject tool |
| Availability scraping | Edge cache 60 s; IP burst limit (W2-17#2) | RT W2-17 | — |
| Profile-write churn | `RL_PROFILE` burst (W2-15#2); idempotent upsert | RT W2-15 | Rows written per day (see below) |
| Email-quota exhaustion | No email at launch (D19(b)); the outbox skips | N-30 | Moot until Resend |
| **Plan-quota exhaustion** (found while tracing) | None. Under D19(f) the Workers Free plan has a daily request allowance, and D1 Free has a daily rows-written allowance (verify the current published values). Rejected (429) requests still count against the request allowance. | **none** | **GAP-07** |

**Verdict:** per-account flooding is closed. Sybil flooding is an accepted residual. Quota exhaustion on the Free plan is an untracked denial-of-service lever (GAP-07).

---

## 10. Threat-model abuse list AB-1 … AB-21 (13 §8)

| AB | Abuse | Units | Tests | Note |
|---|---|---|---|---|
| AB-1 | IBAN swap after admin takeover | see AC-2 | N-45; W6-03#1 | GAP-05 |
| AB-2 | Payment instructions planted in admin text | W1-10, W2-01, W2-02, W4-06 | N-33, N-34 | — |
| AB-3 | WhatsApp swap or studio impersonation | W1-11, W2-01, W4-01, W4-05 | N-45, N-21 | GAP-05 |
| AB-4 | Fake "I sent the receipt" notices | W2-13, W2-02, W4-04 | N-17, N-19, N-50 | AC-1 |
| AB-5 | Hold squatting | W2-02, W2-10, W2-13, W3-15 | N-19, N-50, N-51; W6-03#2 | GAP-04 (repeat offenders) |
| AB-6 | Receipt reuse or forgery | W10-01 (hash hint), W11-01, W2-02 (TM-20) | N-17; A-5 | Forged images are always possible |
| AB-7 | CSV injection | W2-12, W4-03 | N-09, N-42 | — |
| AB-8 | Stored XSS | W1-10, W2-04, W3-07, W2-18, W7-01 | N-20, N-41, N-43; W6-02#1 | — |
| AB-9 | Booking-id enumeration | W1-04 | N-04, N-36 | — |
| AB-10 | Gated-route bypass | W1-03, W1-04, W1-13, W3-19 | N-13, N-14, N-35, N-48 | — |
| AB-11 | Single-admin lockout | W1-12, W5-04 | W6-03#2 | Landed `--demote` vs planned `--replace` (R-03) |
| AB-12 | Audit tampering | W1-01, W1-09, W2-13 (hash), W0-03, W7-01 | N-11 | 13 cites "TM-25" (§12.3 I-01); account holders can drop triggers |
| AB-13 | Admin role takeover at launch | see AC-4 | N-31, N-32 | — |
| AB-14 | Consent granted by someone other than the bride | W2-06, W3-11, W3-13 | N-39 | Studio confirms consent before publishing (W5-04) |
| AB-15 | Album delivery redirected | W2-15, W3-01, W3-07, W4-02 | RT W3-01; RT W2-15 | The courier checks the name |
| AB-16 | Booking or event flood | see AC-5; W2-06 (events only on change) | N-40; RT W3-15 | GAP-07 |
| AB-17 | Slot double-booking | W2-08, W3-01 | N-18 | — |
| AB-18 | EXIF/GPS leakage | W8-01, W9-02, W9-03, W10-04 | N-37 | Train B |
| AB-19 | Signed URL shared or replayed | W8-01, W9-01 | N-23, N-38 | ≤ 1 h window |
| AB-20 | Wrong build deployed | W3-19, W7-01 | N-35, N-54 | — |
| AB-21 | PII in logs | W1-13, W3-02, W2-17 | N-28, N-61 | — |

---

## 11. Wave 0 change set vs plan: reconciliation items

The Wave 0 change set closes most baseline items early, but in places it made different choices from the plan's units. Every "extended by" in §6–§7 depends on these being resolved before wave 1 branches. Each item names who resolves it.

| R | Divergence | Why it matters | Resolve in |
|---|---|---|---|
| **R-01** | **Migration collision.** Wave 0 adds `migrations/0007_users_email_verified_and_token_revocation.sql`, which creates `users.email_verified_at` and `users.tokens_valid_after` as **INTEGER** Unix seconds. The plan's W1-01 commits `0007_golive_admin_settings.sql` and `0008_golive_hardening.sql`. That 0008 adds the same two columns again, with `tokens_valid_after` as **TEXT** ISO instants (11 §2.4, §1.3 D19). | The `0007` prefix collides. 0008 would fail with a duplicate column. The verified counts (27 tables, 23 indexes, 12 triggers) and the 56 + 42 checks of §2.3/§2.5 assume the plan's chain. **Blocks W1-01.** | Orchestrator plus W1-01: renumber (for example, keep the landed 0007 and shift the plan's files), drop the duplicate `ADD COLUMN`s, choose one type, re-verify. Record the result in the W1-RV report. |
| **R-02** | **Revocation semantics.** Wave 0 refuses a token whose `iat` is earlier than `tokens_valid_after`. The plan (TM-07, W1-02#2, 11 §3.1 AD) compares `auth_time`. | Firebase refresh tokens mint a new ID token with a new `iat` and the old `auth_time`. With `iat`, "sign out everywhere" (#44) stops holding after the next refresh (≤ 1 h) unless the Firebase refresh tokens are also revoked. The landed runbook pairs revocation with a password reset; the plan's in-app button does not. | W1-02 (compare `auth_time`), W2-05, W5-04; test in GAP-06 |
| R-03 | **Admin scripts.** Wave 0 has `scripts/grant-admin.mjs` (`--demote`) and `scripts/revoke-sessions.mjs`. The plan and runbook (W1-12, §7.7, §7.11, N-31) name `scripts/promote-admin.mjs` (`--replace`). The plan's script stamps `tokens_valid_after`, writes `admin_promoted`/`admin_demoted` audit rows (L2), prints the bookmark command and verifies exactly one admin. The landed script stamps nothing and writes no audit (that table arrives with the plan's 0007). | Runbook commands and N-31 would target a missing file. L2 and TM-07 stay open. | W1-12 (extend the landed script or rename it and update the plan and runbook references), W5-04 |
| R-04 | **Names of vars and bindings.** Wave 0 has `ADMIN_REQUIRE_MFA` (every admin route, default "off") and the rate-limit bindings `BOOKING_RATE_LIMITER` and `PROFILE_RATE_LIMITER`. The plan uses `ADMIN_MEDIA_MFA="required"`, `ADMIN_SETTINGS_2F` and `RL_BOOKING`, `RL_PROFILE` plus five more (W1-03#2). | The preflight (W3-19, N-35) and `features` (W1-06) assert the plan's names. Also, `ADMIN_REQUIRE_MFA="on"` before the owner enrols TOTP would lock out the only admin, and no preflight rule stops that. | W1-03, W1-15, W3-19 (refuse `ADMIN_REQUIRE_MFA="on"` unless enrolment is recorded), W1-06 |
| R-05 | **Error contract.** Wave 0 answers 401 `REAUTH_REQUIRED` (admin 12 h, media 10 min) and 401 for revoked tokens, and uses the codes `TOO_MANY_OPEN_REQUESTS` and `ADMIN_MFA_REQUIRED`. Plan 11 §3.1 says 403 `REAUTH_REQUIRED`, `OPEN_REQUEST_LIMIT` and `SECOND_FACTOR_REQUIRED`. | N-34, N-39 and N-44 and the client mapping in W1-07 expect the plan's codes. A 401 may drive the SPA to a sign-out instead of the re-auth dialog. | W1-02, W1-07, W3-15: pick one contract and update 11 §3.1 or the code |
| R-06 | **Media freshness.** Wave 0 requires a sign-in ≤ 10 min old on private-media customer routes. The plan uses CO+M (≤ 12 h) for media reads and CO+R (10 min) only for submit-and-lock. | Stricter than planned, but gallery browsing would ask for the password every 10 minutes | W1-02 (`requireMediaFreshSignIn` 12 h), W10-02 |
| R-07 | **File-ownership drift** (M3). New Wave 0 files outside §5.5: `worker/rate-limit.ts` (plan W1-15 names `worker/ratelimit.ts`), `worker/users.ts`, `src/lib/ascii-digits.ts` (plan W1-10: `toAsciiDigits` in `shared/text.ts`), `src/auth/ReauthenticationHost.tsx` (plan W1-08: `src/features/reauth/ReauthDialog.tsx`), `src/features/admin-portal/AdminSecurityPanel.tsx` (plan W5-01: `src/features/admin-security/AccountSecurityTab.tsx`), `src/lib/modal-stack.ts`, `src/lib/server-error-messages.ts`, `src/auth/person-name.ts`, `scripts/lib/wrangler-d1.mjs`. Wave 0 also edits files the plan gives to wave-1 owners, such as `sections.ts` (W1-05), `http.ts` (W1-14), `shared/timing.ts` (W1-10), `portal-routes.ts` (W1-04) and `wrangler.jsonc` (W1-03). | Without updated file lists, wave 1 will create duplicates: two limiters, two re-auth dialogs, two digit normalisers. | Orchestrator: update `11-units.json` file lists before wave 1 |
| R-08 | **Customer revocation.** Wave 0 checks `tokens_valid_after` wherever the users row is loaded, customers included. 11 §0.4 still defers it for customers. | The deferral note is stale. This is an improvement. | W5-04 docs; W1-RV confirms |

---

## 12. Gaps and weak coverage

### 12.1 Gaps: no implementing unit or no test (7)

| Gap | Item | Missing | Why it matters | Proposed action (the orchestrator decides) |
|---|---|---|---|---|
| **GAP-01** | SEC-06 / H-1 (and O-4) | **Unit and test** | Git history holds the full-resolution original wedding photos with camera metadata. It blocks any git remote or push, and any handoff that includes history. The `git archive` handoff (11 §8) avoids it; it does not fix it. | Add an owner-approved housekeeping unit: backup, then re-root or `filter-repo`, recreate `design-classic-v1`, and check the release-tag rule (commit hashes change). Test: an object scan finds none of the listed blobs, and the tag's tree equals the old one. Needed before any remote, not for W7-01. |
| **GAP-02** | SEC-17 / C-19, plus D11 (data-subject requests) | **Unit for production** | W8-02 builds the job, but in Train B, off by default, and the production preflight refuses `RETENTION_PURGE` (11 §7.5). No unit or dated step turns text purge on before C-19's hard deadline (90 days after the first booking reaches a terminal status). The scripted erase (`scripts/erase-customer.*`) and the D11 data-subject-request and guest-removal contact path have no unit. | Add a unit for an owner-run erase script and a DSR contact path, plus a dated release-log step (with a preflight exception after sign-off) to enable text purge. Booking and receipt rows stay (D11). Test: the erase pseudonymises a seeded customer, a later `PUT /api/profile` gets 410, and the bookings are kept. |
| **GAP-03** | D19(d); H4 / C-11 / SEC-15 text | **Unit and test** | 0007's settings sections are limited to deposit, bank, contact and pickup (11 §2.2), so no unit adds legal name, licence/CR number or VAT status, or the "hidden until filled" display. W3-16 renders supplied text only, and no unit drafts the privacy notice and disclosure from the real data flows as D19(d) decided. The preflight refuses a release while any text is missing, so **W7-01 cannot pass H4**. | Add (a) a docs unit that drafts both texts from `02-compliance.md` and the actual data handling, marked "pending legal review"; (b) a schema, API and UI unit for the business-identity fields (content rules, RA, audit). Test: the preflight refuses placeholders, and `/disclosure` hides unfilled fields. |
| **GAP-04** | AB-5 / UX-02: repeat-offender visibility | **Unit and test** | 13 §8 lists "the queue shows repeat offenders" as a hold-squatting control. No acceptance line in W2-10, W3-05, W3-09 or W4-04 carries it. | Add per-customer counts (expired holds, notices with no recorded deposit) to the queue item and the customer detail (W2-10, W3-09). Test in W6-03#2. |
| **GAP-05** | TM-03 / AB-1 / AB-3: sequential WhatsApp-then-IBAN swap (§9.2 (d)) | **Control and test** | After the 72 h number-changed notice lapses, a later bank change shows a warning whose WhatsApp link goes to the effective, attacker-controlled number. N-45 covers only a single bank change. | W2-13, W2-16, W4-01, W4-05: every verification link and notice tied to a bank change uses the compiled public number. Optionally require 2F for a bank change within N days of a contact change. New N-63: contact swap, then more than 72 h, then bank swap → the warning links to the compiled number. |
| **GAP-06** | TM-07 / C-14 / SEC-11: revocation vs refreshed tokens | **Test**, and a code mismatch (R-02) | N-44 checks only "a token issued earlier". It does not check a token refreshed after "sign out everywhere" (new `iat`, old `auth_time`), so the landed `iat` rule would pass N-44 and still fail in practice. | New N-44b: after revoke-all, force-refresh the other session's ID token → 403 on every admin route, and on customer routes if customer revocation stays. Implement with `auth_time` (W1-02). |
| **GAP-07** | D19(f): Workers Free plan quotas as a denial-of-service lever (new threat) | **Unit and test** | The daily request allowance, the D1 rows-written allowance and the per-invocation CPU limit are not tracked by any unit. Rejected 429 requests still consume the request allowance. No one has checked whether the heaviest calls (a 5,000-row CSV export, cold JWKS verification, cron batches) fit the CPU limit. Verify current published values. | In W6-01, measure CPU time and rows written for the heaviest flows. In W5-04, add a runbook check and response for quota exhaustion. At W7-01, record whether Free remains acceptable. New N-64: a 5,000-row export completes within the plan's CPU limit. |

### 12.2 Weak coverage: acceptance or runtime check only (no N-, A- or MA- test)

Not counted as gaps. Items marked with an asterisk are security-relevant, and an N-test is recommended for them.
- **TM:** TM-18\* (a hash-match test: the accepted-terms view returns a body whose SHA-256 equals the event's `bodySha256`), TM-22, TM-23 (open: Cloudflare 2FA not verified), TM-24\* (preview host without an Access session → blocked).
- **B/H/M/L:** H4 (blocked by GAP-03), M3, M4, M5, M6, L4, L5.
- **UX:** UX-12, UX-16, UX-17, UX-18.
- **SEC and C:**
  - SEC-03 / C-3 / C-4\*: RT W3-15 is specific. Promote it to an N-id for the red teams.
  - SEC-08 / C-8: RT W2-17.
  - SEC-09 / C-12.
  - SEC-12 / C-9\*: scripted header assertions on every SPA route and API response.
  - SEC-14\*: erased → 410 as an N-id.
  - SEC-15 / C-11.
  - SEC-18 / C-15.
  - SEC-20 / C-18\*: a media route with `auth_time` over its limit → `REAUTH_REQUIRED`.
  - C-6.

### 12.3 Inconsistencies to fix (not gaps)

| # | Where | Inconsistency | Fix |
|---|---|---|---|
| I-01 | 13 §8 AB-12 | Cites "TM-25 account hardening"; 13 §9 defines only TM-01…TM-24 | Read as TM-23 |
| I-02 | 11 §5.3 gate A | "Zero open baseline go-live items" includes C-10, but CSP enforcement lands ≤ 7 days **after** the first deploy (W7-01#3). The gate cannot close C-10 as written. | Gate A requires C-10's report route and Report-Only policy. Enforcement becomes a dated follow-up entry in the release log (checked by N-43 on preview and the SMOKE header check). |
| I-03 | 11 §0.4 | SEC-11 deferral for customers is superseded by the Wave 0 change set | Update in W5-04 (R-08) |
| I-04 | 13 §6 | Row ids C-1…C-9 and A-1…A-10 collide with the baseline C-n and the journey walks A-n | This document prefixes them `13·` |
| I-05 | 11 §0.1 TM-03 row, W0-02 acceptance line 3 | Says W0-02 records the R1 override in `decisions.md`; the orchestrator recorded it (D19(a)) | None needed; noted in the header |
| I-06 | W0-02 acceptance line 1 | "Test id (N-nn or A-n)", but 11 §6.5 walks are unnumbered, and 12 uses A1–A6 for motion checks | Adopt A-1…A-5 (walks) and MA1…MA6 (motion) as defined in §0 |
