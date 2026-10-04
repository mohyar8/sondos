# Migrations 0008 + 0009 and the local seed: verification (W1-01)

Date: 2026-09-29 (first build and fix round 1), 2026-09-30 (fix round 2). Tools: Node 24.16.0 with node:sqlite (SQLite 3.53.0), wrangler
4.124.0 (local D1 through Miniflare). Everything ran in scratch folders outside the repository. Nothing touched a
remote database.

## 1. Files and how they relate to plan 11

| File | SHA-256 | Source |
|---|---|---|
| `app/migrations/0008_golive_admin_settings.sql` | `06bbfb51ff48313c7fc69a27c40ff831a51637b5d95a691f554520860ac215b3` | plan 11 §2.2 (drafted there as `0007_golive_admin_settings.sql`) |
| `app/migrations/0009_golive_hardening.sql` | `a5b7fc1250fcdc26b3a02dd72a80b5facf906bfeebe7f0730cf4516d6eea0d71` | plan 11 §2.4 (drafted there as `0008_golive_hardening.sql`) |
| `app/migrations/0007_users_email_verified_and_token_revocation.sql` | `0f7881175ac73de5213bf9678180129c7b55307bf5edc10138fa547aa838b889` | Wave 0, landed (unchanged) |

Why the numbers moved (amendment R-01): Wave 0 landed `0007_users_email_verified_and_token_revocation.sql`, so the
plan's two files are committed as 0008 and 0009. wrangler applies migrations in file-name order, so 0007 always runs
before them.

Differences from the plan text, checked with `diff` against the `sql` blocks extracted from `11-golive-plan.md`:

- **0008**: the plan's §2.2 block with two changes:
  1. Header: the file name, and three added comment lines on the renumbering and the change below.
  2. **Fix round 1 (review finding "audit attribution columns can be rewritten"):** section 11's comment, and one
     added `WHEN` line in each of two triggers:
     - `trg_booking_status_history_no_update`: `OR (NEW.changed_by IS NOT OLD.changed_by AND NEW.changed_by IS NOT NULL)`
     - `trg_booking_events_redact_only`: `OR (NEW.actor_uid IS NOT OLD.actor_uid AND NEW.actor_uid IS NOT NULL)`
- **0009**: the plan's §2.4 block with these changes:
  1. Header: the file name, three added comment lines, and "Requires 0007" became "Requires 0008".
  2. **The two `ALTER TABLE users ADD COLUMN` statements for `email_verified_at` and `tokens_valid_after` were removed.**
     Wave 0's 0007 already added both. Adding them again would fail with `duplicate column name` and stop the chain.
     The section-2 comment explains this. `contact_changed_at` stays, and is the only `users` column 0009 adds.
  3. **Fix round 1 (GAP-05):** the `effective_at` bound is 72 h (`BETWEEN 0 AND 259200.5`) instead of 24 h.
  4. **Fix round 1 (TM-17):** `csp_report_counts.blocked_origin` is origin-only.
  5. **Fix round 1 (review finding "INSERT OR REPLACE gets past every append-only trigger"):** a new section 7 with six
     `BEFORE INSERT` key-exists guards, `trg_<table>_no_replace`, one for each append-only table. The header names it.
  6. **Fix round 2 (review finding "a single INSERT with an explicit id of -1 permanently blocks every later insert"):**
     section 7 gains six `AFTER INSERT` guards, `trg_<table>_key_range`, one for each append-only table, and a
     paragraph that explains them. The header line now reads "no rewrite through INSERT OR REPLACE, and no key
     outside the table's sequence".

### Fix round 1: the four DDL deviations and why

| Change | Plan text | Now | Reason |
|---|---|---|---|
| Attribution columns (0008 §11) | `changed_by` unguarded; `actor_uid` "may still change through the users(id) foreign-key actions" | Both may only become NULL. A direct reassignment aborts (`APPEND_ONLY_BOOKING_STATUS_HISTORY` / `APPEND_ONLY_BOOKING_EVENTS`), including NULL → a user. A `users.id` rename that would cascade into them aborts too. | SB-10: the "who" of the per-booking audit trail could be moved to another admin or customer by a Worker bug or a future helper. Only the `ON DELETE SET NULL` action is needed: `worker/users.ts reclaimUnverifiedEmailStatement` deletes a user row. No code updates `users.id`, which is a Firebase uid. A rename was already impossible for any user referenced by settings, terms or audit rows, because those tables are append-only. The plan's §2.3 summary ("`changed_by → NULL` (FK action path) is allowed") still holds. |
| `effective_at` bound (0009 §3) | ≤ 24 h after `created_at` | ≤ 72 h after `created_at` | Amendment GAP-05 (`11-amendments.json`, W2-01): a bank change saved within 30 days of a contact change, or the reverse, becomes effective after 72 h. With the 24 h CHECK, that insert failed with `SQLITE_CONSTRAINT`. The column stays bounded, the 24 h delay still fits, and the readers (W1-06, `COALESCE(effective_at, created_at)`) need no change. W2-01 writes both delays. **For the orchestrator:** if GAP-05 is restated to keep 24 h, revert this one line and check 2.5-17. |
| `blocked_origin` (0009 §5) | charset `[a-z0-9.:/-]`, so `https://host/path` passed | Either a keyword (`[a-z][a-z-]*`, ≤ 40 characters: `inline`, `eval`, `data`, `blob`, `wasm-eval` …) or `scheme://host[:port]`. The scheme is letters only, the host starts with a letter or digit, and nothing follows the authority. | TM-17 and PDPL minimisation. The table is filled from an unauthenticated endpoint. A stored path could carry booking ids or tokens and would give unbounded distinct keys. The DB now enforces what the plan's #45 says the route does ("reduced to its origin, or to `inline`/`eval`/`data`"). |
| No rewrite through REPLACE (0009 §7) | Only `BEFORE UPDATE` / `BEFORE DELETE` triggers (12 in all) | Six more triggers (18 in all). An `INSERT` that names a key that already exists aborts with the table's `APPEND_ONLY_*` message, whatever its conflict clause: `OR REPLACE`, `REPLACE`, `OR IGNORE`, `ON CONFLICT DO NOTHING / DO UPDATE`, or none. `settings_revisions`, `admin_audit_log`, `booking_status_history`, `booking_events` and `ops_switch_revisions` are checked on `id`, their only unique key. `terms_versions` is checked on `version`, `seq` and its implicit `rowid`. An `INSERT` that leaves the key to SQLite, as every writer does, is unaffected. | SB-10, L2, TM-03. SQLite runs no `DELETE` trigger for a row that `REPLACE` removes while `recursive_triggers` is off. It is off in D1 (read back as 0 on the wrangler D1) and in node:sqlite. So `INSERT OR REPLACE … (id, …)` could rewrite the effective bank row's IBAN in place. That row keeps its `created_at`, so the 24 h delay would not apply. The same statement could rewrite a terms body a customer accepted or re-attribute an audit entry, and it could un-redact an event. The `rowid` guard matters: a new version and seq written on v1's `rowid` would delete v1. The CHECK `version = 'v' \|\| seq` already ties the other two keys, and the guard still refuses each of them before that CHECK runs. |
| Key range (0009 §7, fix round 2) | none | Six more triggers (**24 in all**). `AFTER INSERT` on each append-only table: a new row whose key (`id`; `rowid` for `terms_versions`) is below 1, or more than 1 000 000 000 above the next lower key, aborts with the table's `APPEND_ONLY_*` message, under every conflict clause. The lookup is one `SEARCH … USING INTEGER PRIMARY KEY (rowid<?)` (checked with `EXPLAIN QUERY PLAN`). | SB-10, L2, H3. A `BEFORE INSERT` trigger reads a key that SQLite has not assigned yet as `-1`, so the round-1 key-exists guard could not tell an explicit `-1` from a normal insert. One row written at `-1` (or `0`, or any negative id) was accepted, and every later insert then looked like a rewrite of it and aborted. The row could not be deleted, because of the no-delete trigger. In `booking_status_history` or `booking_events` that stops every approve, confirm, cancel and hold-expiry batch. In `admin_audit_log` it stops every audited admin write. In `ops_switch_revisions` it freezes the H3 kill switch. The `AFTER INSERT` trigger sees the key the row really got. The upper bound closes the same failure at the other end, found while fixing this one: an explicit `id` of 9223372036854775807 on an `AUTOINCREMENT` table makes every later insert fail with `database or disk is full` (`SQLITE_FULL`), reproduced in node:sqlite. A fixed ceiling would only move that poison key to the ceiling, so the bound is relative to the next lower key. SQLite assigns the largest key used + 1. The only possible gap is left by history or event rows deleted before 0009, and it is far below 10^9, so no writer is affected. A refused insert leaves nothing behind: the next normal insert gets the next key. |

**Note for W2-17 (CSP report route).** The upsert now fails on anything that is not an origin or a keyword. The route
must reduce each blocked URI before the write. It must also map anything it cannot reduce (an IPv6 literal, an
unknown scheme with digits) to a keyword such as `other`, or skip it. If it lets the CHECK fail, the request returns
500.

**Note for W1-06 / W2-01.** The comment in `shared/settings.ts` (W1-06) still describes `effective_at` as "created_at + 24 h".
The logic that reads it is unaffected. W2-01 writes `strftime(…, 'now', '+72 hours')` for the GAP-05 case.

**Note for the writers of these six tables (W2 settings, terms and switch routes, W1-09, W1-12).** Never name the
key in an `INSERT`. A duplicate terms version now fails with `APPEND_ONLY_TERMS_VERSIONS`
(`SQLITE_CONSTRAINT_TRIGGER`), not with `UNIQUE constraint failed`, and `ON CONFLICT DO NOTHING` / `INSERT OR IGNORE`
abort as well. So the `POST terms` route must detect a lost race (`409 TERMS_VERSION_CONFLICT`) through a
conditional `INSERT … SELECT … WHERE` that changes 0 rows. It must not catch a UNIQUE error. Every current writer
already leaves `id` to SQLite: `worker/audit/admin-audit.ts`, `worker/bookings.ts`, `worker/admin-workflow.ts`,
`worker/jobs/hold-expiry.ts`, `scripts/lib/wrangler-d1.mjs` and `scripts/dev-seed.sql`.

**Note for the orchestrator (still open after fix round 2).** Two texts outside W1-01's files still say 12 triggers:
the runbook §7.4 expectation ("expect 27 tables, 23 indexes, 12 triggers", plan line 1975) and this unit's acceptance
line in plan §5.6 (line 1182) / `waves/w1.json`. After fix round 2, both should read **24** (27 tables, 23 indexes,
24 triggers). W1-01 does not own the plan. Optionally, the W1-13 SQL gate in `scripts/verify.mjs` (today it refuses `REPLACE` only on
`users`) could also refuse `REPLACE`, and an `INSERT` that names `id`, on these six tables. The database refuses
them either way.

How the guard sees a key that SQLite has not assigned yet: in a `BEFORE INSERT` trigger, `NEW.id` / `NEW.rowid` read
`-1`. This was checked in node:sqlite 3.53 and in wrangler's workerd. In fix round 1 a row written with `-1` explicitly
would have made the guard refuse every later insert into that table. Since fix round 2 the `_key_range` guard refuses
such a row, so no row can hold a key below 1 and the key-exists guard never matches a normal insert.

### Column types: Wave 0 (kept) compared with the plan

| Column | Plan §2.4 | Wave 0's 0007 (kept) | Effect |
|---|---|---|---|
| `users.email_verified_at` | `TEXT`, ISO-8601 CHECK | `TEXT`, the same ISO-8601 CHECK (multi-line layout) | None. The same values pass and fail. |
| `users.tokens_valid_after` | `TEXT`, ISO-8601 instant | `INTEGER` Unix seconds, `typeof = 'integer' AND >= 0` | The admin predicate compares integers: `tokens_valid_after IS NULL OR tokens_valid_after <= :auth_time`, with `auth_time` in seconds, exactly as `worker/users.ts isTokenRevoked` does. `scripts/revoke-sessions.mjs` (W1-12) writes seconds from D1's clock. An ISO string is refused (check 2.5-07). |

## 2. Fresh local D1 with wrangler (0001, 0003–0009)

```
npx wrangler d1 migrations apply DB --local --persist-to <scratch>/d1state
```

Re-run after fix round 1 on a new scratch folder:

| Migration | wrangler "commands executed" |
|---|---|
| 0001 / 0003 / 0004 / 0005 / 0006 / 0007 | 12 / 12 / 2 / 32 / 3 / 3 |
| **0008_golive_admin_settings.sql** | **30** (the plan's §2.3 reports 30 for this file; `BEGIN … END` trigger bodies split correctly) |
| **0009_golive_hardening.sql** | **24** (the plan's §2.5 reported 14: the 2 removed `ALTER`s take 2 away, and the 12 section-7 triggers add 12; re-run in fix round 2) |

These counts include wrangler's own `d1_migrations` insert for each file. All 8 files show ✅, and a second
`apply` prints "No migrations to apply".

`sqlite_master` read back through `wrangler d1 execute --local`, with `sqlite_*`, `d1_migrations` and `_cf_METADATA`
excluded:

- **27 application tables, 23 indexes and 24 triggers** (fix round 2; 18 in fix round 1), and 8 rows in `d1_migrations`. `PRAGMA recursive_triggers`
  returns 0.
- New triggers: `trg_settings_revisions_no_update/_no_delete/_no_replace`,
  `trg_terms_versions_no_update/_no_delete/_no_replace`, `trg_admin_audit_log_no_update/_no_delete/_no_replace`,
  `trg_booking_status_history_no_update/_no_delete/_no_replace`,
  `trg_booking_events_redact_only/_no_delete/_no_replace`, `trg_ops_switch_revisions_no_update/_no_delete/_no_replace`,
  and, since fix round 2, `trg_<table>_key_range` for each of the six tables.

Fix-round-2 probes on a new scratch D1 after the seed (§4). Each failed with `SQLITE_CONSTRAINT_TRIGGER` and the
table's `APPEND_ONLY_*` message:

- `INSERT INTO booking_status_history (id, …) SELECT -1, … WHERE id = 1`.
- `INSERT OR IGNORE INTO booking_events (id, …) SELECT 0, … WHERE id = 1`.
- `INSERT INTO booking_events (id, …) SELECT 9223372036854775807, … WHERE id = 1`.

A normal `booking_events` insert afterwards succeeded. Read back: the lowest history and event ids were 1, and the
event ids were 1–3 with no gap.

Section-7 probes, run on a new scratch D1 after the seed (§4) plus one bank revision, one audit row, one switch row
and terms v1. Each statement failed with `SQLITE_CONSTRAINT_TRIGGER` and the table's `APPEND_ONLY_*` message:

- `INSERT OR REPLACE INTO settings_revisions (id, …) SELECT id, …, 'SA9999999999999999999999', … WHERE id = 1`.
- `REPLACE INTO admin_audit_log (id, …)` with another action.
- `INSERT OR REPLACE INTO booking_status_history (id, …)` with another transition and note.
- `INSERT OR REPLACE INTO booking_events SELECT * … WHERE id = 1`.
- `INSERT OR REPLACE INTO ops_switch_revisions (id, …)` flipping `off` to `on`.
- `INSERT INTO booking_status_history SELECT * … ON CONFLICT DO UPDATE SET note = 'y'`.
- `INSERT OR REPLACE INTO booking_requests SELECT * …` for a booking with history. The cascade meets the no-delete
  trigger.
- `REPLACE INTO terms_versions` of v1 with an added clause, and `INSERT OR REPLACE INTO terms_versions (rowid, …)`
  writing v2 on v1's rowid.

Read back afterwards: the IBAN, the audit action, the history row, the switch state and v1 were unchanged. A normal
audit insert and the normal `INSERT … SELECT` publish of v2 (rowid 2) both succeeded.

Earlier probes on the seeded wrangler D1 (§4). Each statement failed and changed nothing:

- `UPDATE booking_status_history SET changed_by = 'seed-customer-1' WHERE id = 1` →
  `APPEND_ONLY_BOOKING_STATUS_HISTORY` (`SQLITE_CONSTRAINT_TRIGGER`).
- `UPDATE booking_status_history SET changed_by = '<tester>' WHERE changed_by IS NULL` → the same.
- `INSERT INTO csp_report_counts … 'https://evil.example/exfil/5eedb00c-…'` and `… 'evil.example/p'` →
  `CHECK constraint failed` (`SQLITE_CONSTRAINT_CHECK`). `csp_report_counts` stayed empty.
- First build: a three-statement batch whose third statement updates `settings_revisions` failed with
  `APPEND_ONLY_SETTINGS_REVISIONS`, and the whole batch rolled back.

The default local state folder of the repository (`app/.wrangler/state`) has no `d1_migrations` row for 0008 or 0009.
No local database holds the pre-fix files, so no local reset is needed.

## 3. The §2.3 and §2.5 checks, re-run in the repository

`app/tests/migrations.test.mjs` uses node:test, node:sqlite and node:assert only. It applies the repository's real
files in wrangler's order, with foreign keys on.

- **§2.3, 56 checks** against 0008 on the full chain. The first check also asserts the intermediate state after 0008:
  25 tables, 22 indexes and 8 triggers.
- **§2.5, 42 checks** against 0009: 27 tables, 23 indexes and 24 triggers. This set includes the R-01 check that the
  Wave 0 columns exist exactly once with their 0007 types.
- **Section 7, 8 tests** (fix round 1, a separate suite outside the plan's 42 checks):
  - `recursive_triggers` is 0.
  - For each of the six tables: the attack rewrites from the review finding abort, and so does a copy of the row
    under every conflict clause (`INSERT OR REPLACE`, `REPLACE`, `INSERT OR IGNORE`, plain `INSERT`,
    `ON CONFLICT DO NOTHING`, `ON CONFLICT DO UPDATE`). The table's rows, rowids included, stay identical. A normal
    insert then appends. The attack rewrites are: another IBAN on the effective bank row; a changed terms body; each
    terms key alone; v2 on v1's rowid; another audit action; another transition with a note; an un-redacted and
    re-attributed event; and the switch flipped to `on`.
  - `INSERT OR REPLACE` of a booking with history, and of one with events only, aborts through the cascade.
- **Section 7 key range, 6 tests** (fix round 2), one per append-only table. A copy of the row under an explicit key of
  `-1`, `0`, 9223372036854775807 or the last key + 1 000 000 001 aborts under a plain `INSERT`, `INSERT OR IGNORE`,
  `INSERT OR REPLACE` and `ON CONFLICT DO NOTHING`. For `terms_versions` the explicit key is the `rowid`, with the next
  version and seq. The rows stay identical. A normal insert then gets key 2, an explicit jump of exactly 10^9 is
  accepted, and the next normal insert gets the key after it.
- **11 runtime statements prepare**, and 2 statements are executed: `LIKE … ESCAPE '\'` treats `%` as a literal, and a
  capacity-1 slot accepts exactly one handover while another customer's uid inserts 0 rows (the IDOR predicate).
- A guard asserts that the lists hold exactly 56 and 42 checks.
- Result: **127/127 pass** (121 in fix round 1).

Fix round 1 changed six checks, and fix round 2 changed 2.5-01 again. The counts stay at 56 and 42.

| Check | Now asserts |
|---|---|
| 2.5-01 | 24 triggers, and the four per table listed by name (fix round 2; 18 and three per table in fix round 1). |
| 2.3-51 | `changed_by` and `actor_uid` become NULL when the user row is deleted. Reassigning either to another user aborts: from a user, from NULL (the studio), and through a `users.id` rename. |
| 2.3-52 | Also: rewriting `actor`/`actor_uid` to an admin aborts. |
| 2.5-17 | 72 h 1 s and 30 days are refused. 24 h and 72 h are accepted, on both bank and contact. |
| 2.5-28 | The data keyword is stored as `data` (the plan's #45 wording), not `data:`. |
| 2.5-29 | Refused: a path, a trailing `/`, a host without a scheme, a bare identifier, an empty host or scheme, a scheme with digits, a query, a fragment, credentials, upper case and over-long values. Accepted: an origin with and without a port, and the keywords `inline`, `eval`, `data`, `blob`, `wasm-eval`. |

To show that the checks catch a missing control, the migrations were copied to a scratch folder and edited one control
at a time. The failures seen:

| Control removed or loosened | Check(s) that failed |
|---|---|
| `ux_users_single_admin` removed | 2.3-01, 2.3-06, 2.3-07, 2.5-01 |
| Re-auth window 10 → 11 min (0008) | 2.3-28, 2.3-42, 2.3-56, 2.5-11 |
| Re-auth window 10 → 11 min (0009, switch) | 2.5-23 |
| `trg_booking_events_no_delete` removed | 2.5-01, 2.5-33, 2.5-34 |
| IBAN body charset check removed | 2.3-18 |
| Switch "on" without re-auth allowed | 2.5-22 |
| Un-redaction allowed | 2.3-53 |
| Status-history trigger narrowed | 2.3-50 |
| CSP directive charset widened | 2.5-30 |
| `deposit_rule_revision_id` flow-2 check removed | 2.3-47 |
| Fix round 1: `changed_by` guard line removed, or its `IS NOT NULL` part dropped | 2.3-51 |
| Fix round 1: `actor_uid` guard line removed | 2.3-51 |
| Fix round 1: `blocked_origin` "no `/` after the authority" removed | 2.5-29 |
| Fix round 1: `blocked_origin` keyword branch widened to digits and dots | 2.5-29 |
| Fix round 1: `effective_at` bound back to 24 h, or widened to 30 days | 2.5-17 |
| Fix round 1: section 7 removed | 2.5-01 and all six per-table section-7 tests. In each, the first attack rewrite reported "Missing expected exception", so without the guards it succeeds. |
| Fix round 1: any one `trg_<table>_no_replace` removed (six edits) | 2.5-01 and that table's section-7 test |
| Fix round 1: the terms guard's `rowid`, `seq` or `version` term removed (three edits) | the `terms_versions` section-7 test |
| Fix round 2: the six `_key_range` guards removed | 2.5-01 and all six key-range tests (127 → 120 pass). Without them, the explicit `-1` is accepted. |
| `trg_booking_status_history_no_delete` or `trg_booking_events_no_delete` removed | 2.5-01, 2.5-32 or 2.5-33, 2.5-34 and the section-7 booking REPLACE test |

Boundary: the stale re-auth checks use 10 min 1 s, following N-10. An 11-minute probe did not catch a window widened
to 11 minutes because of the floating-point `julianday` arithmetic.

Both test files pass under the W1-13 harness command, 154/154 (fix round 2; 148 in fix round 1):

```
node --import ./tests/setup/no-network.mjs --import ./tests/setup/resolve-ts.mjs --test tests/migrations.test.mjs tests/dev-seed.test.mjs
```

The whole suite (`tests/*.test.mjs`), re-run after section 7: 744 of 749 pass. That includes every suite that applies
the migrations with node:sqlite: `admin-audit`, `settings-read`, `settings-contracts`, `recent-auth`,
`promote-admin`, `dev-seed` and `portal-routes`. It also includes
`rate-limit.test.mjs`, which upserts origins into `csp_report_counts`. The 5 failures are all in
`verify-gates.test.mjs` (waiver, manifest and hooks gates of W1-13). They report `engines.node is not ">=24.2.0"` from
the `package.json` that W1-13 is editing at the same time, and none of them opens a database. `dev-seed.test.mjs` imports
TypeScript modules, so it needs `resolve-ts.mjs`. `migrations.test.mjs` uses Node built-ins only.

## 4. The local seed (`scripts/dev-seed.sql` + `scripts/seed-local.mjs`)

`app/tests/dev-seed.test.mjs` applies the seed with node:sqlite in one transaction, as wrangler runs a file. It reads
the tester's bookings back through the Worker's own `loadCustomerBookingRecords` and `deriveJourneyStage`. Results:

- **One booking per journey stage.** All 15 stages are reached, plus the sub-states `receipt_rejected`,
  `awaiting_previews` and `handover_missed`, 2 terminal legacy rows, 1 `legacy_status` row and 1 terminal flow-2 row.
- **Every admin queue section of plan 11 §3.3 #35 except `bank_mismatch`** (fix round 1). Each section is encoded
  as the plan words it, and the test asserts both the exact booking ids and the non-empty sections in the fixed
  order: `decide_now` 04, 05 · `holds_expiring` 02 · `deposit_notices` 03, 04 · `requests_over_sla` 01 ·
  `events_today_tomorrow` 35 (with `startTime`/`venueArea`) · `handovers_today_tomorrow` 17, 18, 31 ·
  `terms_pending` 02, 05 · `receipts_pending` 07 · `events_soon_without_details` 36 · `awaiting_production` 13 ·
  `selection_overdue` 34 · `ready_without_handover` 16 · `handover_no_show` 33 · `feedback_due` 20, 21.
  `bank_mismatch` needs a bank revision, and the seed must write none (§6.2, W1-01). It appears once the tester
  saves bank details twice after a booking accepted terms.
- **`/api/bookings/me` sub-states (plan #1, W2-16)** (fix round 1). `awaiting_deposit` is booking 32: flow 2, terms
  accepted, no notice, hold running. `deposit_reported` is 03 and 04. `handover_missed` is 33 (a `no_show` on a slot
  that ended two days ago).
- **Distinct dates.** 36 bookings on 36 distinct dates, and no blocked date on a booking date.
- **Holds.** One overdue flow-2 hold is protected by a `deposit_notice_sent` for its current deadline. One overdue
  hold has no notice.
- **Fake customers.** 6 of them: `seed-customer-1…6`, `@example.test`, Ofcom drama-range phone numbers. Exactly one
  (`seed-customer-3`) has `contact_changed_at` after her booking. 7 of their bookings are in the next two months, and
  one is today.
- **Nothing sensitive.** No settings, terms, kill-switch, audit or CSP rows. No admin. No `bank_revision_id` or
  `deposit_rule_revision_id`.
- **Package snapshots** equal `validateBookingSelection` output for four catalogue selections, so no price is
  invented.
- **Handovers.** Slot capacities hold. The delivery handover snapshots its area's name, id and fee.
- **Tester row.** An existing tester row is left unchanged. When she has no row, an unproven placeholder
  (`seed-tester@example.test`, `email_verified_at` NULL) is created, and her first verified sign-in replaces it.
- **Runs once.** A second run fails on `_dev_seed_marker` and changes nothing.
- **Marker CHECK.** It refuses an admin's uid, an erased row's uid, `seed-uid` and a 129-character uid, and the whole
  file rolls back each time.
- **Script refusals.** `seed-local.mjs` exits with code 2 before wrangler starts, and its state folder stays empty,
  for each of these: `--remote`, `--env preview`, `--env=production`, `--preview`, an unknown option, a positional
  argument, a missing uid, a uid with a quote, a dash or 129 characters, a repeated uid, `--persist-to -e`, and
  `CLOUDFLARE_ENV` set to `production` or `preview`.
- **Script shape.** A source check confirms `spawnSync(process.execPath, args, …)` with no shell, a hard-coded
  `--local`, and no `--remote` or `--env` literal.
- Result: **27/27 pass**.

Additions beyond the plan's §6.2 list (fix round 1). The list does not name these states, but §6.3 has W2-10 and W2-16
check them on the seed, and no later unit owns the seed. So the seed adds five bookings and one slot, each on its own
date clear of the blocked dates at +7, +21 and +30:

| Booking | Owner | Event | State |
|---|---|---|---|
| 32 | tester | +76 d | flow-2 `approved_hold`, terms accepted 12 h ago, no notice, 28 h left → `awaiting_deposit` |
| 33 | tester | −60 d | confirmed, gallery locked, album ready, pickup `no_show` on a new slot two days ago → `handover_no_show`, stage 12 `handover_missed` |
| 34 | tester | −25 d | confirmed, gallery `open` with a deadline 4 days past and nothing submitted → `selection_overdue` (media environment) |
| 35 | seed-customer-6 | today | confirmed with event details (21:00, الرياض) → `events_today_tomorrow`, «اليوم» summary |
| 36 | seed-customer-4 | +2 d | confirmed without event details → `events_soon_without_details` |

The totals are 11 handover slots (the plan says 10), 27 tester bookings and 9 fake-customer bookings. The tester now
has 9 open requests, still above the cap of 3.

Edits to a scratch copy each failed the matching case:

- No deposit notices.
- The marker CHECK removed.
- The today handover moved to tomorrow.
- The `CLOUDFLARE_ENV` check removed.
- The uid pattern removed.
- Fix round 1:
  - The `no_show` handover removed (stages, queue and sub-state cases).
  - Booking 32 without terms (queue and sub-state cases).
  - The today event moved to +3 (queue and fake-customer cases).
  - Booking 36 given event details.
  - The overdue gallery's deadline moved into the future.

Real run with wrangler, on the scratch D1 from §2, repeated in fix round 1:

- `node scripts/seed-local.mjs --customer-uid TesterUid0001 --persist-to <scratch>/d1state` printed "Seeded: 27
  bookings for the tester, 6 fake customers with 9 bookings, 11 handover slots, 2 delivery areas. No settings, terms,
  switch, audit or admin rows were written." It exited with 0, and the temporary SQL folder was gone afterwards.
- A second run printed "Refused: this local database was already seeded (_dev_seed_marker exists)." and exited with 1.
  `--remote` exited with 2 before wrangler started.
- Read-back counts:
  - 1 marker row; 36 bookings on 36 dates.
  - 7 users and 0 admins.
  - 0 settings, terms, switch or audit rows.
  - 3 blocked dates, 11 slots, 2 areas and 7 handovers.
  - 12 galleries, 2 receipts and 5 event profiles.
  - 95 status-history rows and 2 events.
- Queue states in the wrangler D1: `events_today_tomorrow` 1, `events_soon_without_details` 1, `no_show` 1,
  `selection_overdue` 1 and `awaiting_deposit` 1. Before fix round 1, each of these was 0.
- **Rollback of the seed file** (first build). On another scratch D1 with an admin row, `wrangler d1 execute --local
  --file` with the seed rendered for the admin's uid failed with `CHECK constraint failed: customer_row_ok = 1`.
  Afterwards `_dev_seed_marker` and `_dev_seed_plan` did not exist and there were 0 bookings, so the whole file
  rolled back.
- Refusals through the CLI (first build): `--remote`, `--env preview`, `Tester'Uid`, `--persist-to -e`, a doubled
  uid and `CLOUDFLARE_ENV=production` each exited with 2.

API against the seeded D1, from the working-tree Worker (`worker/index.ts`) on port 5300 (fix round 1):

- `GET /api/health` returned 200.
- `GET /api/availability?from=<Riyadh today>&to=<+92 d>` returned 200 with 18 `unavailable` dates and 3 `pending`
  dates, which matches the seed. The 18 are 3 blocked dates and 15 blocking bookings: 10 of the tester's and 5 of
  the fake customers', including today's event and the one at +2.
- `/api/bookings/me`, `/api/profile`, `/api/admin/bookings` and `/api/admin/queue` returned 401, both without a
  token and with a garbage bearer token.
- The server was stopped afterwards, and port 5300 was free.
- Repeated after section 7 was added: a fresh scratch D1 with all 8 files, the seed (the same "Seeded: …" line and
  exit code 0), then the Worker on port 5300. The results were the same: health 200, 18 `unavailable` and 3 `pending`
  dates, and 401 on all four authenticated routes, with and without a garbage token. The server was stopped
  afterwards, including its workerd child, and port 5300 was free. The seed writes history and events without naming
  `id`, so the guards leave it unaffected.
- Fix round 2: a fresh scratch D1 with all 8 files (24 triggers), the seed (the same "Seeded: …" line), the probes in
  §2, then `npx wrangler dev --port 5300 --persist-to <scratch>`. Health returned 200, and availability returned 18
  `unavailable` and 3 `pending` dates, as before. This plain command serves the last build (see the note below).
  Fix round 2 changed only the schema, and the seeded D1 file was the one under test. The server and its workerd
  child were stopped, and port 5300 was free.

Note for the integration reviewer: plain `npx wrangler dev` in `app/` follows `.wrangler/deploy/config.json` to the
built `dist/sundus_yar_website/wrangler.json`, so it serves the last build, not the working tree. `--config
wrangler.jsonc` fails because its `assets` block has no `directory` (the Vite plugin supplies it). The check above
therefore used a scratch config with:

- `main` = `app/worker/index.ts`;
- the same vars and D1 id;
- an empty assets folder.

The local D1 file is the same in every case, because the D1 id is the same. `npm run build` refreshes `dist`.

## 5. Preconditions and production

- 0008 fails loudly, by design, on a database that already has two `role='admin'` rows. A fresh production D1
  (decision D19c) has none.
- 0009 has no precondition beyond 0008. Its section-7 guards read only the table they guard, so they apply cleanly to
  tables that already hold rows.
- Neither file has been applied to any remote database. Production starts empty (D19c), so the fix-round edits to
  0008 and 0009 are safe. Once either file is applied remotely, any further change must be a new migration.
- The seed never runs remotely: `seed-local.mjs` hard-codes `--local` and refuses remote targets.
- The production check that `_dev_seed_marker` is absent is the runbook §7.4 query:
  `wrangler d1 execute sundus-yar-production --remote --command "SELECT name FROM sqlite_master WHERE name = '_dev_seed_marker'"`
  must return no rows. The automated release preflight that asserts this belongs to W3-19
  (`scripts/release-preflight.mjs`), which did not exist in wave 1.
