# Wave 1 gate review (W1-RV)

Date: 2026-09-30. Scope: units W1-01 to W1-18 (no W1-17 finding, and no W1-15 or W1-17 changes after review). Working tree only; nothing is committed.

The findings come from the review pass. "Not confirmed" means a skeptic showed the working tree already handles the issue. Fix outcomes come from the two fix rounds.

---

## 1. Units

### W1-01: go-live migrations 0008/0009 and dev seed
- **What was built:** 0008 is plan §2.2 byte for byte. 0009 is §2.4 without the two `users` ADD COLUMNs (R-01). The chain 0001 and 0003-0009 applies cleanly. `tests/migrations.test.mjs` re-runs the §2.3 and §2.5 checks.
- **Seed:** `scripts/dev-seed.sql` and `seed-local.mjs` were fixed and hardened (finally-cleanup bug, `--persist-to` as one token, refusals). `tests/dev-seed.test.mjs` reads the seed back through the Worker's journey loader.
- **After the fix rounds:** 0009 gained BEFORE INSERT no-replace guards and AFTER INSERT key-range guards, so the database now has **24 triggers**. It also has a 72 h effective_at bound, an origin-only CSP CHECK, and attribution guards in 0008.

| Criterion | Status |
|---|---|
| §2.2/§2.4 DDL byte-for-byte (changes re-verified) | met (deviations recorded in the verification doc) |
| Fresh D1 applies the chain; 56 + 42 checks re-run | met (trigger count is now 24, not 12) |
| Seed: every journey stage, notice-protected hold, fake customers, marker; no settings or admin | met |
| R-01: no re-added columns; Wave 0 types kept | met |
| Script hard-codes `--local`, refuses `--remote`/`--env`; uid validated | met |
| spawn with an argument array, no shell | met |
| Append-only triggers; production preflight asserts no marker | partial (preflight belongs to W3-19) |
| SB-4, SB-8 | met |

Deviations:
- File renumbering to 0008/0009.
- 0009 leaves out the users ADD COLUMNs; command counts are 30 and 12 (now 24 after the fixes).
- The runtime check needed a scratch config because `dist/` is stale.
- Fix rounds changed the §2.2/§2.4 text: no-replace and key-range triggers, attribution guards, CSP origin CHECK, 72 h effective_at bound. All are recorded in `runs/redo-v2/d1/0008-0009-verification.md`.

### W1-02: auth claims, admin binding, recent-auth guards
- **What was built:** `auth.ts` fails closed on claims. `admin-auth.ts` does a single D1 binding query covering email match, verified email, not erased and `tokens_valid_after <= auth_time`.
- **New `recent-auth.ts`:** the 600 s (now 570 s) guards, the 12 h media guard, and the second-factor guards. `reauthAtFromToken` uses only auth_time. `ADMIN_REQUIRE_MFA` is removed.

| Criterion | Status |
|---|---|
| authTime and secondFactor on AuthenticatedFirebaseUser | met |
| Admin binding: email, 12 h window, tokens_valid_after in one query | met |
| recent-auth guards (RA/CR/M/2F/2S) | met (declared deviation: guard is 570 s, not 600 s, to stay inside the D1 reauth CHECK) |
| reauthAtFromToken is the only reauth_at source | met |
| R-02 revocation by auth_time (GAP-06) | met |
| R-04/R-05 codes; no global MFA switch | met |
| R-06 12 h media reads | met |
| Consolidate Wave 0 helpers | met |
| Claim hardening; no logging | met |
| §6.3 runtime check | met |

Deviations:
- Email mismatch answers 403 FORBIDDEN.
- A revoked admin gets 403 REAUTH_REQUIRED, not 401.
- Only TOTP counts as a second factor.
- `email_verified_at` is required.
- Wave 0 names are re-exported from `auth.ts`. `PRIVATE_MEDIA_MAX_AUTH_AGE_SECONDS` is now the 570 s guard (fail-safe).

### W1-03: wrangler config, env types, private-media gate
- **Config:** account id; production database `sundus-yar-production` with a placeholder id; go-live vars; the seven `RL_*` limiters in every env; a read-only preview; a local-only `env.mediatest` with R2.
- **Gate:** `getMediaBucket` is the single door, with a runtime shape guard that also rejects anything with `fetch`. The word list is extended.

| Criterion | Status |
|---|---|
| account_id, preview_urls, D1, vars; mediatest with R2 | met (mediatest account_id is now all zeros) |
| RL_* bindings (60 s) | met |
| env.preview: dev Firebase id, read-only | partial (dev project id is a placeholder, D16 blocked) |
| gates.ts single door, blockers, no R2 in the build | met (integration build confirms `r2_buckets: []`) |
| R-04 renames | met |
| TM-10 runtime guard | met |
| Flags fail closed | met |
| Key length not logged | met |
| SB-8, SB-11 | met |

Deviations:
- Extra gate condition `ADMIN_MFA_DISABLED`.
- Capture values are matched as whole tokens.
- Key length is counted in characters.
- The bucket check rejects `fetch`.
- The build was not regenerated during the unit.

### W1-04: route registries, slots, central ownership
- **What was built:** 20 typed empty slot files. `assembleRouteRegistry` with load-time overlap and shadow checks. `owned-booking.ts` `resolveOwnedBooking` (one query bound to `user_id`). The admin namespaces are extended and checked at load. E1 runs over the assembled registries.
- **Tests:** 43 cases, and mutation tests.

| Criterion | Status |
|---|---|
| Typed empty slot arrays | met |
| Dispatcher: verify, then resolve ownership, then an identical 404 | met |
| E1 on assembled registries; namespaces extended | met |
| C-16/TM-06 (SB-20 documented) | met |
| E1 kept; static imports only | met |
| SB-2, SB-11 | met |
| eslint/tsc/runtime | partial (UI half not run; integration covered it) |

Deviations:
- The dispatcher now uses `requireMediaFreshSignIn`.
- Admin 2F for media routes is left to the handlers.
- `request.ts` has no owner; its stale helpers remain (open).
- Tests need the W1-13 harness.

### W1-05: UI registries, slots, panel stylesheets
- **What was built:** 20 null slot files. The `stage-views` and `sections` registries with typed order and group. Two token-only stylesheets meeting UX-12 and UX-13.
- **Fixes during the build:** the disabled-state cascade contrast and the test's token reader. A WCAG 2.4.11 focus guard is present in the current tree.

| Criterion | Status |
|---|---|
| Empty stubs render exactly as today | met |
| Fixed section order; tab group primary/more | met |
| Panel CSS UX-12/UX-13, tokens only | met |
| Lazy-only descriptors | met |
| No inline styles from data | met |
| SB-12 | met |

Deviations:
- summary and actions have no slot.
- `group` is not used until W4-03.
- A duplicate `security` tab id is noted.
- The runtime proof checks for empty registries.

### W1-06: settings contracts, readers, features
- **What was built:** `shared/settings.ts` holds the guards: IBAN mod-97, E.164, text rules equal to the DB CHECKs, and the GAP-03 contract. `shared/deposit.ts` does integer-only deposit maths.
- **Readers:** `settings-read.ts` now follows the plan's plain effective-revision rule. `features.ts` builds the #29 features object.

| Criterion | Status |
|---|---|
| Typed guards; integer computeDeposit | met |
| Effective/pending revision (§2.5) | met (reverted to the plan's definition) |
| features.ts exports for wave 2 | met |
| Every SQL string prepared against 0008/0009 | met |
| GAP-03 business-identity fields | **partial: contract and guards only; no storage** |

Deviations:
- Read models use revisionId, savedAt and activeFrom.
- Two extra wave-2 helpers.
- Stored text is re-checked on read.
- `whatsappNumberChangedAt` now follows §3.3 #1 (null for the first revision).
- GAP-03 storage is missing.

### W1-07: API client v2 and the single message table
- **What was built:** `request`, `postJson`, `requestBlob` and `upload` (XHR, redirect refused). Same-origin path guard. Token only in the header. One-shot retry on REAUTH_REQUIRED.
- **Also:** a single `server-error-messages.ts` table; the admin parser skips unknown actions. The hunk the unit had added to `src/api/bookings.ts` (no owner) was reverted.

| Criterion | Status |
|---|---|
| requestBlob, upload, postJson, keepalive | met |
| REAUTH/SECOND_FACTOR/RATE_LIMITED messages | met |
| Unknown allowedActions ignored (L1) | met |
| Existing callers unchanged | met (after the bookings.ts revert) |
| R-05 retry, codes, one table | met |
| Same-origin, no token in URL, no logging | met |
| §6.3 runtime | partial (the real dialog needs W2-01 and Firebase) |

Deviations:
- The SECOND_FACTOR copy adds a how-to.
- 401 REAUTH_REQUIRED is still retried.
- The client does not sign the user out.
- The detail view is rebuilt from known fields.
- Catches are narrowed.
- The PAYLOAD_TOO_LARGE copy is now neutral for files.

### W1-08: re-auth dialog, retry hook, idle sign-out
- **What was built:** `reauthenticateWithPassword` in the single provider. `ReauthDialog` (focus-trapped, Escape and backdrop cancel, «التحقق صالح حتى» from the 570 s guard). `useReauthRetry` retries once.
- **Idle sign-out:** `startIdleSignOut`, tied to the session that went idle and restarted on sign-in.

| Criterion | Status |
|---|---|
| Password re-check in the provider; accessible dialog | met |
| Username field, valid-until line, one retry | met |
| startIdleSignOut; displayName; MFA challenge | partial (TOTP step kept in the dialog; W4-03 mounts the timer) |
| R-07 one re-auth dialog | met |
| Password only in component state | met |
| One listener, one provider | met |
| SB-12, SB-14, SB-18 | met |

Deviations:
- TOTP code step kept.
- `ReauthenticationHost` kept as a thin mount.
- The AuthDialog re-auth view is dead code (W5-01).
- Cancel and continue are split.
- 6 files (R-07).
- Idle sign-out does not survive a page reload (open).

### W1-09: admin audit writer
- **What was built:** `shared/audit.ts` holds the vocabulary, per-action allowlist builders, a placement map and a 2,000-char cap. The `admin-audit.ts` writer uses `auditStatement` and `auditAfterWrite`, with changes() guards and SQL-stamped created_at.
- **Tests:** the suite now has 23/23 passing.

| Criterion | Status |
|---|---|
| Typed action union; statement for the caller's batch | met |
| created_at from SQL (M1) | met |
| Allowlist builders | met |
| Details ≤ 2,000 before the DB | met |
| No PII by type | met |
| SB-10 | met |
| SB-13 | met |
| §6.3 runtime | partial (routes belong to W2-01/W2-12) |

Deviations:
- `auditAfterWrite` added with explicit revision targets.
- No Worker builders for the promote/demote script actions.
- A probe worker was used for the runtime check.

### W1-10: shared text rules and Riyadh timing
- **What was built:** `normalizeFreeText` (NFC, invisible and format characters refused, visible-count minimum, Zalgo guard). `findPaymentInstructionLike`, the TM-04 tripwire, now joins digit groups across any non-letter separator, reads dingbat digits, spaced, bracketed and spelled-out domains, and IPv4. `normalizePersonName` allows ZWNJ between Arabic letters (N-41).
- **Timing:** Riyadh timing helpers and constants.

| Criterion | Status |
|---|---|
| normalizeFreeText rules | met |
| findPaymentInstructionLike (N-33) | met |
| timing.ts + 21:00-24:00 boundary | met |
| R-07 single home; thin re-exports | met |
| Pure functions | met |
| Every handler calls it; "today" never from SQL | partial (handlers are wave 2+) |
| TM-12, TM-04, M2 | met |

Deviations:
- Names are refused rather than trimmed.
- The detector goes beyond the plan's patterns.
- Word-less number lists are now refused, an accepted false positive.

### W1-11: WhatsApp link builder
- **What was built:** `toWaMeDigits` for typed input, and a strict `fromE164Digits` for stored digits. `buildWhatsAppUrlFor` returns ok/issue/reason. `isolateLtr`, a 1500 code-point cap, and a compiled fallback number. It now imports `./ascii-digits` (no same-wave dependency).

| Criterion | Status |
|---|---|
| New functions; existing exports unchanged | met |
| Message cap; compiled fallback and number-change check | met |
| Links for each input form; disabled button with a reason | met |
| Number regex; encodeURIComponent only | met |
| TM-19 wa.me gate | partial (BookingActions is waived, W2-02) |
| SB-6, SB-12 | met |

Deviations:
- Only three digit scripts are accepted.
- Stricter rule for 966 numbers.
- The legacy builder drops over-cap text.
- Additive helpers.

### W1-12: single admin script
- **What was built:** `promote-admin.mjs` covers promote, `--replace`, `--demote` and the re-run that ends sessions. Typed confirmation, one batch with a changes()-guarded audit row, a Time Travel bookmark for `--remote`, and read-back verification.
- **Also:** `grant-admin.mjs` is deleted. `revoke-sessions.mjs` is customer-only. The scripts write only `admin_promoted`/`admin_demoted`.

| Criterion | Status |
|---|---|
| CLI; N-31 usage error | met |
| Guarded UPDATE changes exactly one row; shown before confirm | met |
| Audit in the same batch; bookmark; exactly one admin | met (remote not exercised) |
| R-03 single admin script | met (revoke-sessions is now customer-only) |
| Only validated uid/email templated | met |
| spawn with an argument array; explicit target | met |
| No API writes users.role | met |
| SB-4, SB-10 | met |

Deviations:
- `MAX()` stamp.
- Stricter UPDATE.
- `--database` must match wrangler.jsonc.
- Remote path not run.
- Missing flags print the exact replacement flags.

### W1-13: test harness, verify, git hooks
- **What was built:** `npm test` with the resolve-ts and no-network hooks. `verify.mjs` runs AST gates (console, MEDIUM, wa.me, storage, HTML sinks, users.role, manifest, hooks), then lint, tsc, both builds and tests.
- **Hooks and record:** pre-push, pre-merge-commit and a new pre-commit hook. A record with a content fingerprint and `--check-record`.
- **Hardening from the fix rounds:** Node ≥24.2 fails closed; strict release mode with no waivers, which applies automatically on a release checkout.

| Criterion | Status |
|---|---|
| npm test harness, no dependency | met |
| verify = lint + tsc + builds + tests + gates | met |
| Hooks block release merges; verify recorded | met (activation needs `hooks:install` by the owner) |
| No network in tests; shell false | met |
| No new dependency | met (only an `engines` field added) |
| SB-7, SB-19 | met |

Deviations:
- 11 baseline waivers, each with `removeBy` and refused at release.
- Extra gates.
- Gate scope excludes `scripts/`.
- resolve-ts covers extensionless imports.
- New `.githooks/pre-commit` and a test fixture outside the listed files (ownership open).

### W1-14: bounded bodies, HSTS, plan error codes
- **What was built:** `readBoundedJson` checks Content-Length and then counts streamed bytes. Profile, bookings and blocked-dates use it (413). `jsonResponse` always sets HSTS, nosniff and no-store.
- **Limits:** 429 RATE_LIMITED through the RL_* bindings. Profile names now use the shared `normalizePersonName`.
- **Wire codes:** the open-request cap is back to Wave 0's `TOO_MANY_OPEN_REQUESTS` until W2-16 updates the client. The horizon stays `BOOKING_TOO_FAR_AHEAD`.

| Criterion | Status |
|---|---|
| readBoundedJson adopted; 413 (SEC-05) | met |
| HSTS; behaviour otherwise identical | met |
| R-05 plan codes | partial (OPEN_REQUEST_LIMIT handed to W2-16; 413/429/RL_* done) |
| C-5, C-9 | met |
| No body echo | met |
| SB-3, SB-9 | met |

Deviations:
- The `readJsonBody` alias is kept.
- The earlier DATE_BEYOND_HORIZON claim was wrong; that rename is W3-15.
- The runtime check ran in Miniflare.

### W1-15: burst limiter and limits table
- **What was built:** `limitBurst` fails open (`RL_BINDING_MISSING`/`RL_UNAVAILABLE`) and never logs the key. There is a typed action-to-binding map and a CF-Connecting-IP key (/64 for IPv6).
- **Also:** 429 with Retry-After. `shared/limits.ts` holds the §3.1 table, windowed caps and `windowStart`. Comments now say the cap still sends TOO_MANY_OPEN_REQUESTS until W2-16.

| Criterion | Status |
|---|---|
| limitBurst; fail-open code | met |
| §3.1 table + SQL caps; 429 Retry-After | met |
| R-04/R-07 RL_* names; OPEN_REQUEST_LIMIT | partial (helper exists, wired by W2-16) |
| Keys never logged | met |
| SQL caps are the hard bound | met |

Deviations:
- Probe worker used for the runtime check.
- RATE_LIMITED wording now matches the plan.
- Hourly cap wiring is W3-15.

### W1-16: design switch foundation (MOT-01)
- **What was built:** `VITE_SITE_DESIGN` is read only in `vite.config.ts` from an allowlist (unset or empty means classic; an invalid value fails the build). One `@site-design` alias; `assetsInlineLimit: 0` (TM-14).
- **Boot files:** classic boot is empty; cinematic sets `data-design`.

| Criterion | Status |
|---|---|
| Unset/empty builds classic | met |
| Invalid value fails the build | met |
| Cinematic attribute; vite dev in both designs | met |
| assetsInlineLimit 0 | met |
| Classic DOM identical to design-classic-v1 | met |
| Classic CSS identical to design-classic-v1 | partial (two El Messiri fonts are emitted files, not data: URIs; bytes identical) |
| A1 static | met |
| Flag allowlist; alias limited | met |
| Flag not in client code | met |
| SC-0 | met |

Deviation: the CSS parity delta is caused by TM-14 and is documented in `vite.config.ts`. The plan amendment is open.

### W1-17: intro logo rasters (MOT-03)
- **What was built:** `make-brand-assets.mjs` intro pass writes `logo-ink-448.webp` (21,966 B) and `logo-ink-672.webp` (37,378 B), with exact ink RGB and alpha cleanup. It has an output-path guard and a metadata chunk allowlist.
- **Also:** `brandIntroLogo` typed with `as const satisfies`.

| Criterion | Status |
|---|---|
| Existing brand files byte-identical | met |
| Size budgets | met |
| Visual check at 200% | met |
| Typed brandIntroLogo | met |
| A1 static | partial (full build left to the integration step, which passed) |
| Runtime on 5316 | met |
| Writes only inside the brand folder | met |
| No EXIF/XMP | met |
| SC-0 | met |

Deviation: two extra processing steps for the intro rasters to meet the budgets. No findings.

### W1-18: route readiness (MOT-05, M5)
- **What was built:** `whenReady()` never rejects. `loadedModule()` is now set only when `whenReady()` succeeds, per spec §6.1. `routeReady(path)`: `/` and `/admin` resolve at once. Nothing calls these yet.

| Criterion | Status |
|---|---|
| whenReady semantics | met |
| loadedModule synchronous once loaded | met |
| routeReady per path | met |
| Scratch check offline / no unhandled rejection | met |
| Classic and cinematic unchanged | met |
| A1 static | partial (integration build passed) |
| A2 classic parity | partial (integration parity check passed) |
| No new rejection paths; SC-0 | met |

Deviations: `preload` is moved into a named function. A browser retry-in-place was not possible (HMR reload); a test covers it.

---

## 2. Findings

Verdict is "confirmed" or "not confirmed" (a skeptic showed the working tree already handles it). The outcome is what the fix rounds did.

| # | Unit | Sev | Finding | Verdict | Outcome |
|---|---|---|---|---|---|
| 1 | W1-01 | MEDIUM | INSERT OR REPLACE bypasses the append-only triggers | confirmed | fixed (BEFORE INSERT no-replace guards) |
| 2 | W1-01 | LOW | changed_by / actor_uid can be reassigned | confirmed | fixed |
| 3 | W1-01 | LOW | CSP blocked_origin accepts a path | confirmed | fixed (origin-only CHECK) |
| 4 | W1-01 | MEDIUM | Seed misses awaiting_deposit and queue sections | not confirmed | n/a (already seeded, 27/27 tests) |
| 5 | W1-01 | LOW | GAP-05 72 h cannot be stored (24 h cap) | confirmed | fixed (bound raised to 72 h) |
| 6 | W1-01 | — (fix round 2) | Explicit id -1 or the 64-bit maximum permanently blocks inserts | found in fix | fixed (AFTER INSERT key-range guards) |
| 7 | W1-02 | LOW | Deprecated re-export made requireRecentAuthentication a 12 h guard | confirmed | fixed (now 570 s) |
| 8 | W1-02 | LOW | Guard is 570 s, not the 600 s in the acceptance; dialog promised 10 min | confirmed | fixed (declared deviation; SPA aligned) |
| 9 | W1-03 | LOW | Acronym split missed RECEIPTs/PDFs and similar | confirmed | fixed |
| 10 | W1-03 | LOW | mediatest R2 bucket auto-provisioned on deploy | confirmed | fixed (all-zero account_id) |
| 11 | W1-03 | LOW | ADMIN_MFA_DISABLED contradicts plan §6.1 | confirmed | **open** (plan/decision edit) |
| 12 | W1-04 | LOW | request.ts stale guard documents the wrong window | confirmed | **open** (no owner; mitigated) |
| 13 | W1-04 | LOW | request.ts duplicate ownership helpers | confirmed | **open** (same as 12) |
| 14 | W1-05 | MEDIUM | Sticky bar hides keyboard focus (WCAG 2.4.11) | not confirmed | n/a (guard present, tested) |
| 15 | W1-06 | MEDIUM | Licence-number rule anchored to the whole value | not confirmed | n/a (already unanchored) |
| 16 | W1-06 | MEDIUM | Effective-revision rule differs from the plan | not confirmed | n/a (reverted to the plan) |
| 17 | W1-06 | MEDIUM | GAP-03 fields have no storage or migration owner | confirmed | **open** |
| 18 | W1-06 | LOW | whatsappNumberChangedAt set for the first revision | confirmed | fixed |
| 19 | W1-07 | LOW | Unowned src/api/bookings.ts edit; report stale | confirmed | fixed (hunk reverted) |
| 20 | W1-07 | MEDIUM | Same, as an ownership violation | not confirmed | n/a (already reverted) |
| 21 | W1-07 | LOW | 413 upload shows text-form wording | confirmed | fixed (neutral copy + test) |
| 22 | W1-08 | LOW | AuthContext duplicate REAUTH_REQUIRED wording | confirmed | fixed |
| 23 | W1-08 | MEDIUM | No cancel after the password is accepted | not confirmed | n/a (split cancel/continue) |
| 24 | W1-08 | LOW | Idle timer kills a later session in another tab | confirmed | fixed |
| 25 | W1-08 | LOW | Valid-until promises 10 min vs 9.5 | confirmed | fixed |
| 26 | W1-08 | LOW | Idle period restarts on page load | confirmed | **open** (owner decision) |
| 27 | W1-08 | MEDIUM | Idle timer repeated sign-out (duplicate) | not confirmed | n/a |
| 28 | W1-08 | MEDIUM | Focus trap leaks from the dialog container | not confirmed | n/a |
| 29 | W1-08 | LOW | Escape/backdrop after success sends the action | confirmed | fixed |
| 30 | W1-08 | LOW | Valid-until 30 s overstated (duplicate) | confirmed | fixed |
| 31 | W1-09 | MEDIUM | Own test suite fails 2/21 | not confirmed | n/a (23/23 pass) |
| 32 | W1-09 | HIGH | Same, placement rule untested | not confirmed | n/a (placement test exists) |
| 33 | W1-10 | HIGH | TM-04 detector bypassed by U+2800 and other separators | confirmed | fixed |
| 34 | W1-10 | LOW | Invisible-only values accepted as non-empty | confirmed | fixed |
| 35 | W1-10 | MEDIUM | Separator and dingbat-digit bypass | confirmed | fixed |
| 36 | W1-10 | LOW | Zalgo rule bypassed with ZWJ/ZWNJ | confirmed | fixed |
| 37 | W1-10 | LOW | Person-name rule refuses ZWNJ (N-41) | confirmed | fixed (Worker aligned by W1-14 in round 2) |
| 38 | W1-10 | LOW | Bare IPv4 URL passes | confirmed | fixed |
| 39 | W1-10 | — (fix round 2) | Arabic-spelled domain («دوت كوم») passes | found in fix | fixed |
| 40 | W1-11 | LOW | Stored 9-digit numbers become Saudi | confirmed | fixed (`fromE164Digits`) |
| 41 | W1-11 | LOW | Undeclared dependency on W1-10 | confirmed | fixed (`./ascii-digits`) |
| 42 | W1-12 | LOW | Script admin_sessions_revoked rows break the contract | confirmed | fixed (script-only actions) |
| 43 | W1-12 | LOW | README runbook points at the deleted script | confirmed | **open** (README unowned; script now prints the fix) |
| 44 | W1-12 | LOW | R-03: revoke-sessions touches the admin row | confirmed | fixed (customer-only) |
| 45 | W1-12 | LOW | Script rows vs shared/audit.ts contract (duplicate) | confirmed | fixed |
| 46 | W1-13 | MEDIUM | verify is a no-op without import.meta.main | confirmed | fixed (fail closed, engines ≥24.2) |
| 47 | W1-13 | MEDIUM | Console gate accepts `${error}` | confirmed | fixed (plus alias handling in round 2) |
| 48 | W1-13 | MEDIUM | Release merge completes unverified via `git commit` | confirmed | fixed (pre-commit hook) |
| 49 | W1-13 | LOW | users-role gate misses INDEXED BY / dynamic tables | confirmed | fixed |
| 50 | W1-13 | LOW | Record has no content fingerprint | confirmed | fixed |
| 51 | W1-13 | MEDIUM | import.meta.main (duplicate) | confirmed | fixed |
| 52 | W1-13 | MEDIUM | Waivers never expire and apply at release | confirmed | fixed (strict release; auto on a release checkout) |
| 53 | W1-13 | LOW | Console gate passes tokens/emails | confirmed | fixed |
| 54 | W1-13 | LOW | String-keyed eval/Function/cookie missed | confirmed | fixed |
| 55 | W1-13 | LOW | Release merge bypass (duplicate) | confirmed | fixed |
| 56 | W1-14 | MEDIUM | OPEN_REQUEST_LIMIT shows the generic error in the booking form | confirmed | fixed (wire code reverted to TOO_MANY_OPEN_REQUESTS; rename handed to W2-16) |
| 57 | W1-14 | LOW | Report claimed DATE_BEYOND_HORIZON landed | confirmed | fixed (report corrected) |
| 58 | W1-14 | MEDIUM | OPEN_REQUEST_LIMIT (duplicate) | confirmed | fixed |
| 59 | W1-14 | LOW | False report claims (duplicate) | confirmed | fixed |
| 60 | W1-14 | — (fix round 2) | PUT /api/profile refuses ZWNJ the form accepts | found in fix | fixed (shared normalizePersonName) |
| 61 | W1-15 | — (fix round 2) | Comments claim OPEN_REQUEST_LIMIT is live | found in fix | fixed (comments only) |
| 62 | W1-16 | LOW | TM-14 breaks the CSS-hash parity gate vs design-classic-v1 | confirmed | **open** (plan amendment) |
| 63 | W1-18 | MEDIUM | loadedModule set by the render path (remount) | not confirmed | n/a (set only by whenReady) |
| 64 | none | MEDIUM | SPA booking client maps OPEN_REQUEST_LIMIT to MALFORMED_RESPONSE | confirmed | fixed (via W1-14 revert) |
| 65 | none | LOW | README docs: deleted script, removed var, old D1 name | confirmed | **open** |

Counts: 1 HIGH confirmed and fixed. 1 HIGH, 8 MEDIUM not confirmed (8 MEDIUM rows: 4, 14-16, 20, 23, 27-28, 31, 63 minus the HIGH at 32). 10 MEDIUM confirmed; 9 fixed, 1 open. The rest are LOW. The rows marked "found in fix" were raised during the fix rounds.

Open items that came up during fixing, all LOW and all owned by the orchestrator:
- The trigger count text says 12; the database now has 24.
- `.githooks/pre-commit` ownership is not recorded.
- Release precondition text still says plain `npm run verify`.

---

## 3. Integration checks

All checks were run from `app/`. No repo file changed: `git status` was identical before and after.

| Check | Result |
|---|---|
| npm ci | skipped (node_modules present) |
| npm run lint | 0 problems |
| tsc -b | 0 errors |
| npm run build | OK. dist wrangler.json has `r2_buckets: []`, RL_* limiters, go-live vars, placeholder D1; no data:image in dist/client |
| npm test | 732 pass, 0 fail (114 suites) |
| npm run verify | PASS (full); 9 baseline waivers, all in unowned files |
| Migrations on a fresh D1 | 0001, 0003-0009 applied: 27 tables, 23 indexes, 12 triggers (before the fix rounds; now 24 per W1-01's re-run) |
| seed-local.mjs | seeds; second run refused; bad uid and `--remote` refused |
| promote-admin.mjs --local | SQL printed, typed confirmation, exactly one admin plus an admin_promoted row; usage errors work |
| wrangler dev :5390 | health 200. availability 400/200 as expected. All new admin namespaces return 401 with Bearer, HSTS, nosniff, no-store. Customer slots 404, /api/media 503 |
| wrangler dev body-crash | Pre-existing wrangler 4.124 Windows proxy issue; reproduced on HEAD b6fff2e. Not a W1 regression |
| Authenticated Miniflare smoke | 41/41. Checks: 413 declared and chunked; 400/415/429; customer on admin gets 403; stale admin 403; GAP-06 403; email mismatch 403; revoked customer 401; admin 404s; only JWKS fetched |
| vite dev :5391 UI | 5 routes × 2 widths × 2 designs: 0 console errors, 0 failed requests, no horizontal overflow, rtl/ar, data-design only in cinematic |
| Classic parity vs HEAD | index.html identical; all 7 CSS chunks identical after font normalisation |
| Grep over 29,478 added lines | no any, ts-ignore, eslint-disable, assertions, innerHTML, eval; console only in scripts; catches narrowed |
| Dependencies | lockfile unchanged; no new dependency |
| Ownership | every changed file owned (tests required by acceptance); grant-admin.mjs deleted per R-03; hooks LF |
| Brand rasters | 21.9 KB and 37.4 KB (budgets 25 KB and 40 KB) |

Note: the integration run came before the fix rounds. The fix builders re-ran their own suites: npm test 777/777 after W1-10 and W1-13, and the unit-level lint and tsc checks are clean. The integration sweep has not been re-run on the post-fix tree.

---

## 4. Still open

| Sev | Unit | Item | Owner of the fix |
|---|---|---|---|
| **MEDIUM** | W1-06 | GAP-03 business-identity fields have no storage and no migration owner. The proposed 0010 must also carry the 0009-style key-range guard | orchestrator: assign migration (W2-01 or new unit); restate the acceptance as contract only |
| LOW | W1-01 | Runbook §7.4, plan line 1182 and waves/w1.json still say 12 triggers (now 24) | orchestrator |
| LOW | W1-03 | Plan §6.1 still offers ADMIN_MEDIA_MFA=off; no decision recorded | orchestrator (decisions.md, plan §6.1, W11/W12, W13-02/W5-05) |
| LOW | W1-04 | worker/portal/request.ts stale helpers and docs (no owner) | orchestrator: assign before wave 2 |
| LOW | W1-08 | Idle sign-out restarts on reload; threat-model residual not recorded | owner decision (SB-12 exception or session persistence) plus threat-model note |
| LOW | W1-12 / none | README runbook, grant-admin, ADMIN_REQUIRE_MFA, old D1 name | W5-04 or an interim amendment |
| LOW | W1-13 | .githooks/pre-commit and test fixture ownership not recorded | orchestrator (waves/w1.json) |
| LOW | W1-13 | Plan release precondition should be `npm run verify -- --release`; W3-19 needs `--check-record --release` | orchestrator |
| LOW | W1-16 | TM-14 CSS parity amendment for W1-16 and W2-21 not recorded | orchestrator |

Hand-offs that are not findings: OPEN_REQUEST_LIMIT rename (W2-16, client and Worker together); DATE_BEYOND_HORIZON (W3-15); owner decision on the PackageConfigurator localStorage draft (waived until release, where it is refused); outbox.ts owner.

GATE: OPEN
- MEDIUM: W1-06 GAP-03 business-identity fields have no storage and no migration owner.
