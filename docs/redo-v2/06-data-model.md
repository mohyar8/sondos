# 06 — Data model, migrations and PDPL retention

Run 1 of 8 (`redo-v2-spec`) · 2026-09-23 · Role: database architect · Design only. Nothing was applied anywhere.

| | |
|---|---|
| Inputs | `decisions.md` (D1–D8), `00-inspection-report.md`, `01-product-spec.md`, `05-adr-architecture.md` (§2.1–§2.8), `08-copy-ar.md` §5–§9, and the code in `app/` at baseline `d6b7cb2`. Where they disagree, the code wins. |
| Binding decisions honoured | D2 (reuse statuses, add `flow_version`), D3 (pickup and delivery), ADR-001 (one Worker, D1, private R2, cron, derived journey stages). Prices, the booking-creation contract and the auth model are unchanged. Every schema change is additive. |
| Escalations | **compliance-officer**: every retention period and legal basis in §6 (the compliance review failed, so §11 raises the PDPL questions). **security-auditor**: isolation is enforced in the application layer, not the database (§6.8). **devops-engineer**: runs every production command that writes (§2.5, §8). |
| Test status | Every SQL block in this file was run against an in-memory SQLite 3.53 (Node 24 `node:sqlite`) using the real `0001`/`0003`/`0004` files. Results are in §9. That is not D1. §2.6 lists the local D1 checks W3-1 must still run. |

---

## 0. Summary

1. **The migration defect has one safe fix for every state: take `0002_create_booking_schema.sql` out of `app/migrations/` without editing it.** Its bytes are identical to `0001` (same SHA-256). Wrangler decides what to run by file name only, and it ignores a recorded name that has no file. After the removal, a fresh database applies `0001 → 0003 → 0004`. A production database that applied only `0001` picks up `0003` (a no-op) and `0004`. One that recorded everything has nothing to do. A hand-made database needs one guarded bookkeeping `INSERT`, run by a human (§2.5). No migration file that may be recorded anywhere is ever edited.
2. **The owner runs read-only commands first (§2.3)**, then follows the decision table (§2.4). Warning: `wrangler d1 migrations list` is *not* read-only when `d1_migrations` does not exist yet, because it creates that table. It is only used after the check shows the table exists.
3. **One additive migration, `0005_portal_schema.sql` (§3.6).** It adds 5 columns to `booking_requests`, 1 to `users` and 16 tables: 13 feature tables, 2 vocabulary tables and 1 R2 object register. The old Worker keeps working with it applied. The schema contains no secrets.
4. **Double-submits cannot succeed.** Every customer write is one conditional statement or one D1 batch. Each has a `changes()`-guarded `NOT NULL` insert, a primary key, or a partial unique index behind it (§4.1).
5. **R2 deletion is tracked structurally.** Every object has a row in `media_objects`, written in the same batch as its business row. That row survives deletion of the booking (`ON DELETE SET NULL`), so an object can never be orphaned without a record. A daily job deletes objects by policy, by hard ceiling, or when detached (§6.3).
6. **A real defect found while testing:** the existing house-style CHECK `date(event_date) = event_date` accepts `2026-13-45`. `date()` returns NULL, and SQLite treats a NULL CHECK as passing. The new tables use `strftime(...) IS col` instead. The legacy columns are left alone, because the app validates dates in code and a rebuild is not justified (§1, U-19).

---

## 1. Inputs and verified facts (the code is the source of truth)

| Fact | Evidence |
|---|---|
| `0001_initial.sql` and `0002_create_booking_schema.sql` are byte-identical: SHA-256 `59de3f57d58207949622cdfa9234c4f5a772c6632d919af421b226b2c0fd5788`, CRLF line endings, plain `CREATE TABLE`. | `sha256sum`, `cmp` run in this session |
| `0003` recreates the same four tables with `IF NOT EXISTS`, but with weaker constraints: `blocked_dates` and `booking_requests` only check `length(event_date) = 10`, `estimated_total` has no `typeof` check, `booking_status_history` has no status CHECKs and no `changed_by` foreign key, and `blocked_dates.created_by` has no foreign key. Its six index names equal `0001`'s. | `0003_create_core_tables.sql:15-21, 23-54, 56-67, 69-92` |
| `0004` adds the partial unique index `idx_booking_requests_user_event_date_open`. It fails if duplicate open requests exist. | `0004_prevent_duplicate_booking_requests.sql:1-10` |
| No `migrations_dir` or `migrations_table` is configured, so wrangler uses `app/migrations/` and `d1_migrations`. | `wrangler.jsonc:13-19` |
| `booking_requests` and `booking_status_history` timestamps are written by code as `toISOString()`. `users` and `blocked_dates` use SQLite's `CURRENT_TIMESTAMP` format (`YYYY-MM-DD HH:MM:SS`). **Legacy timestamps come in two formats**, so comparisons against them must use `datetime()`, as the existing list query already does. | `bookings.ts:488,565`, `admin-workflow.ts:479`, `profile.ts:305-323`, `admin.ts:835-856`, `admin.ts:368` |
| The atomic guard pattern already in use: a conditional `UPDATE`, then `INSERT … to_status = CASE WHEN changes() = 1 THEN … END`. A NULL violates `NOT NULL` and the whole batch rolls back. | `admin-workflow.ts:483-585` |
| Phone numbers are normalised to E.164 when written: Saudi forms become `+9665XXXXXXXX`, and other E.164 numbers are accepted. There is no database CHECK, and none can be added without a rebuild. | `profile.ts:93-131` |
| The package snapshot holds only catalogue choices and prices, no personal data. `album.photoCount` is 30, 45, 60 or 80, and `album` is `null` for coverage-only bookings. | `shared/booking.ts:122-131, 656-700` |
| **Legacy CHECK hole:** `date(event_date) = event_date` passes for `2026-13-45`, `2026-00-10` and `9999-99-99`. Only `2026-02-30` is rejected. | reproduced in memory against `0001` (§9) |
| No national ID or Iqama, date of birth, or card data is collected anywhere. None is added. | whole `app/` |

---

## 2. The duplicate-migration fix (D8)

### 2.1 How wrangler decides what to run (the facts the fix relies on)
- `migrations apply` lists the `*.sql` files in the migrations directory. It subtracts the names recorded in `d1_migrations` and runs the rest in name order. **It tracks names only**: no checksum, and no check for recorded names that have no file.
- Each file runs together with the `INSERT` of its own name. Cloudflare documents that a migration that errors is rolled back and earlier successful migrations stay applied, and that the run stops there.
- `migrations list` first runs `CREATE TABLE IF NOT EXISTS d1_migrations(…)`, so it writes if the table is missing.
- These behaviours come from wrangler's documentation and source. §2.6 makes W3-1 confirm them on the installed wrangler 4.124.0 locally before anyone touches production.

### 2.2 The fix (the same repository change in every state)
**Delete `app/migrations/0002_create_booking_schema.sql` from the working tree in one commit. Do not edit its content first, and do not touch `0001`, `0003` or `0004`.** The bytes stay in git history (`d6b7cb2`) and are proven identical to `0001` by the hash in §1. W3-1 records the hash and the reason in `runs/redo-v2/d1/`.

Why this is safe in every state:
- **Fresh database.** The chain becomes `0001 → 0003 → 0004`. `0003` is a no-op on `0001`'s tables, because it uses `IF NOT EXISTS` and the same index names. This was verified in memory.
- **`0001` recorded, `0002` failed.** `0002` was rolled back and never recorded, so removing it changes nothing in the database. `0003` and `0004` then apply.
- **Everything recorded.** The `0002` row stays in `d1_migrations` and wrangler ignores it. Its content equals `0001`, so the schema that fresh environments build still matches production.
- **Hand-made database.** Removing `0002` is necessary but not enough. `0001` would still fail on the existing tables, so a one-row bookkeeping baseline is recorded first (§2.5).

Rejected alternatives:
| Alternative | Rejected because |
|---|---|
| Rewrite `0002` as a no-op or with `IF NOT EXISTS` | It edits a migration that production may have recorded (the "applied everything" state). That breaks the rule and makes the file lie about what ran. |
| Point `migrations_dir`/`migrations_table` at a new chain with an idempotent squashed baseline | It works, but it changes `d1_databases` in `wrangler.jsonc` (spec §9 keeps that entry untouched), splits history across two directories, and relies on `IF NOT EXISTS`, which silently hides schema drift. |
| Keep `0002` and "fake-apply" it on every fresh database | Every developer, CI and new environment would need a manual two-pass bootstrap. Defect HIGH #1 would stay open. |
| A new migration that inserts `0002`'s name into `d1_migrations` | Wrangler computes the pending list before it runs anything, so `0002` still runs in the same pass and fails. It also writes into wrangler's own bookkeeping from inside a migration. |

### 2.3 Read-only state check: the owner runs these first, in this order
Run them from `C:\Users\azooz\Desktop\sundus-yar\app` in Git Bash or PowerShell 7. None of them contains `$` or `%`, so neither shell expands anything. If `whoami` shows no login, `npx wrangler login` writes only a local credential. Keep the outputs in `runs/redo-v2/d1/` (W3-1). The queries return counts, booking ids and dates only, never names, emails, phone numbers or uids.

```bash
npx wrangler --version
npx wrangler whoami
npx wrangler d1 list
npx wrangler d1 info sundus-yar-bookings
npx wrangler d1 time-travel info sundus-yar-bookings
npx wrangler d1 execute sundus-yar-bookings --remote --json --command "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY tbl_name, type, name"
npx wrangler d1 execute sundus-yar-bookings --remote --json --command "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'blocked_dates', 'booking_requests', 'booking_status_history')) AS core_tables, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations') AS has_d1_migrations, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'ux_booking_requests_blocking_event_date') AS has_blocking_index, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_booking_requests_user_event_date_open') AS has_0004_index, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'booking_requests' AND instr(sql, 'GLOB') > 0) AS variant_a_bookings, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'booking_status_history' AND instr(sql, 'REFERENCES users') > 0) AS variant_a_history, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'booking_requests' AND instr(sql, 'flow_version') > 0) AS has_flow_version, (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('event_kinds', 'notification_kinds', 'booking_events', 'notification_log', 'job_runs', 'media_objects', 'booking_receipts', 'event_profiles', 'booking_consents', 'galleries', 'gallery_photos', 'gallery_selections', 'album_production', 'handover_slots', 'handovers', 'feedback')) AS portal_tables"
npx wrangler d1 execute sundus-yar-bookings --remote --json --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
npx wrangler d1 execute sundus-yar-bookings --remote --json --command "SELECT event_date, COUNT(*) AS open_rows, group_concat(id) AS booking_ids FROM booking_requests WHERE status IN ('pending_review', 'approved_hold', 'contract_pending', 'contract_signed', 'payment_pending', 'confirmed') GROUP BY user_id, event_date HAVING COUNT(*) > 1"
npx wrangler d1 execute sundus-yar-bookings --remote --json --command "SELECT event_date, COUNT(*) AS blocking_rows, group_concat(id) AS booking_ids FROM booking_requests WHERE status IN ('approved_hold', 'contract_pending', 'contract_signed', 'payment_pending', 'confirmed') GROUP BY event_date HAVING COUNT(*) > 1"
npx wrangler d1 execute sundus-yar-bookings --remote --json --command "SELECT status, COUNT(*) AS n, SUM(created_at NOT LIKE '____-__-__T__:__:__.___Z') AS non_iso_created, SUM(hold_expires_at IS NOT NULL AND hold_expires_at NOT LIKE '____-__-__T__:__:__.___Z') AS non_iso_hold FROM booking_requests GROUP BY status"
```
Notes:
- Commands 1–5 are Cloudflare account and API reads. `time-travel info` prints the current **bookmark**: write it down, because it is the restore point for every later write.
- Command 7 returns the **state vector** that §2.4 uses.
- Run command 8 only if `has_d1_migrations = 1`. Otherwise it fails with `no such table`, which is harmless and is itself the answer.
- Commands 9–10 are the duplicate checks for `0004` and for the blocking index.
- Command 11 shows the status mix and any non-ISO timestamps in production.
- Optional, and only if `has_d1_migrations = 1`: `npx wrangler d1 migrations list sundus-yar-bookings --remote`. It shows the same information as command 8.
- Do not use `wrangler d1 export` for this check. It is not needed, it writes a local file containing personal data, and Cloudflare notes that an export can hold up other queries while it runs.

### 2.4 Decision table
`R` = the set of names in `d1_migrations`. "Variant A" = `variant_a_bookings = 1 AND variant_a_history = 1` (built by 0001/0002). "Variant B" = both 0 (built by 0003). Every production write below is run by devops-engineer after the owner approves it, with the bookmark from command 5 recorded first.

| # | Observed state | Action (after merging §2.2) |
|---|---|---|
| P0 | `d1 list` shows no database `6fda2ba7-508d-4972-93b6-5735e1fa7da4`, or `whoami` shows another account | **Stop.** Fix the account or config first. Never "create a new DB" to get past this. |
| S0 | `core_tables = 0`, `portal_tables = 0`, `d1_migrations` missing or empty | Empty database (the live API cannot have worked). `migrations apply --remote` runs `0001, 0003, 0004`. No manual SQL. |
| S1 | `core_tables = 4`, variant A, `R = {0001}`, `has_0004_index = 0` | The documented failure. Command 9 must return no rows. If it returns some, the admin cancels the extra open request(s) in the admin UI (a normal status change, no DDL) and re-runs command 9. Then `migrations apply --remote` runs `0003` (a no-op) and `0004`. |
| S2 | `R ⊇ {0001, 0002, 0003, 0004}`, `has_0004_index = 1` | Nothing to repair. The `0002` row stays forever: never delete bookkeeping rows. The next apply runs only `0005` once it is merged. |
| S2b | `R` contains `0001` but not all of `0003`/`0004` | As S1. Apply picks up exactly the unrecorded files, and both are idempotent. Command 9 must be empty first. |
| S3 | `core_tables = 4`, and `d1_migrations` is missing or lacks `0001_initial.sql` (hand-made, either variant) | Commands 9 **and** 10 must be empty, because `0003` creates the blocking unique index if it is missing. Then the §2.5 baseline (B1, B2), then `migrations apply --remote`, which runs `0003` and `0004`. |
| S4 | Variant B, in any bookkeeping state | Handle it by bookkeeping, as S1, S2 or S3. Also record the drift in `runs/redo-v2/d1/`: weaker CHECKs, and no foreign key on `blocked_dates.created_by` or `booking_status_history.changed_by`. **No rebuild.** The §6.5 erasure SQL nulls those columns explicitly, so it behaves the same on both variants (U-19). |
| S5 | `core_tables` is 1–3, or a core table lacks a column the code uses, or `R` holds a name not in the repository | **Stop.** Do not apply anything. Escalate to devops-engineer and the owner for a manual reconciliation plan. |
| S6 | `portal_tables > 0`, or `has_flow_version = 1`, while `0005_portal_schema.sql` is not in `R` | **Stop.** Someone applied a draft. Compare it with §3.6 and never apply `0005` on top of it. |
| any | the `non_iso_*` counts from command 11 are > 0 | No action. Record them. All retention and SLA SQL in this document wraps legacy columns in `datetime()`. |

### 2.5 Bookkeeping baseline for hand-made databases (S3 only, run by a human)
- **B1.** Let wrangler create its own bookkeeping table with its own DDL: `npx wrangler d1 migrations list sundus-yar-bookings --remote`. In this state that is its only write. If a wrangler version does not create the table, B2 fails with `no such table` and changes nothing. Then use the DDL in the comment below.
- **B2.** Record `0001` as applied, but only if the four core tables exist:

```sql
-- [baseline] mark_0001_applied
-- Run once with: npx wrangler d1 execute sundus-yar-bookings --remote --command "<this statement>"
-- Fallback only if B1 created nothing (same shape wrangler uses):
--   CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)
INSERT INTO d1_migrations (name)
SELECT '0001_initial.sql'
WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0001_initial.sql')
  AND (
    SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'table' AND name IN ('users', 'blocked_dates', 'booking_requests', 'booking_status_history')
  ) = 4;
```

```sql
-- [baseline] undo_mark_0001
-- Rollback for B2. Valid only while nothing after 0001 has been applied.
DELETE FROM d1_migrations
WHERE name = '0001_initial.sql'
  AND NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name > '0001_initial.sql');
```

### 2.6 Local verification matrix (W3-1, local D1 only, before any remote step)
Each row uses its own throw-away `--persist-to` directory under `app/.wrangler/verify-*`. That directory must be git-ignored first (defect #10).

| Scenario | Local commands | Expected |
|---|---|---|
| Fresh DB, old chain | `git stash` the removal; `d1 migrations apply sundus-yar-bookings --local --persist-to .wrangler/verify-old` | `0001` ✅, `0002` ❌ and the run stops. `d1_migrations` holds only `0001`, which confirms per-file atomicity. |
| Fresh DB, fixed chain | removal applied; `… apply --local --persist-to .wrangler/verify-fresh` | `0001`, `0003`, `0004` ✅ |
| S1 then fix | continue in `verify-old` after the removal: `… apply --local --persist-to .wrangler/verify-old` | `0003`, `0004` ✅ |
| S2 | in `verify-fresh`: `d1 execute … --local --persist-to .wrangler/verify-fresh --command "INSERT INTO d1_migrations (name) VALUES ('0002_create_booking_schema.sql')"`, then `… migrations list --local …` | "No migrations to apply". This confirms wrangler ignores a recorded name that has no file. |
| S3 variant B | `d1 execute … --local --persist-to .wrangler/verify-hand --file migrations/0003_create_core_tables.sql`; `… apply` (`0001` ❌); B1 + B2 locally; `… apply` | `0003`, `0004` ✅ after the baseline |
| 0005 | add `0005` from §3.6 to each directory above; `… apply` | ✅ on variants A and B. Then run §9's scenarios with `wrangler d1 execute --local`. |

---

## 3. Schema: `0005_portal_schema.sql`

### 3.1 Conventions (apply to every new column)
- **Primary keys.**
  - Entities whose id appears in an R2 key or a URL (`galleries`, `gallery_photos`, `booking_receipts`, `handover_slots`) use a surrogate `TEXT` UUID v4 from `crypto.randomUUID()`: random, not enumerable, no personal data. This matches `booking_requests.id`.
  - Tables in a 1:1 relation with a booking use `booking_id` as a natural primary key (`event_profiles`, `album_production`, `handovers`, `feedback`), so a second row is impossible.
  - Append-only logs use `INTEGER PRIMARY KEY AUTOINCREMENT` (`booking_events`), like `booking_status_history`, so ids are monotonic for audit ordering.
  - Natural keys where the key *is* the identity: `notification_log.dedupe_key` (the idempotency key), `media_objects.object_key`, `job_runs.job`, and vocabulary codes.
- **Instants** are `TEXT` `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC). The check is `length(x) = 24 AND substr(x, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', x) IS x`. `IS` makes a NULL from `strftime()` fail. The hour guard exists because SQLite echoes `24:00` back unchanged. Plain string comparison is valid between new columns because they all have the same fixed format. No `DEFAULT CURRENT_TIMESTAMP` (ADR §2.1 timestamp invariant).
- **Calendar dates** (`event_date`, the legacy column) stay `YYYY-MM-DD` in Asia/Riyadh. The new tables hold no calendar dates. A handover's Riyadh day is derived from `starts_at` with `Intl` (ADR §2.2), so no stored `slot_date` can drift from it. **Hijri is never stored.** It is display only, via `Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura')`.
- **Vocabularies.**
  - Closed state machines use inline CHECKs, in the house style: statuses, stages, methods.
  - Open vocabularies that will grow are lookup tables with a foreign key (`event_kinds`, `notification_kinds`). Adding a kind is then an additive `INSERT` migration, never a table rebuild.
- **Booleans** are `INTEGER CHECK (x IN (0, 1))`. **Integers** are also checked with `typeof(x) = 'integer'`, in the house style.
- **R2 keys are derived from ids, and the database enforces this.** For example, `booking_receipts.object_key = 'r/' || booking_id || '/' || id`. No name, filename or phone number can ever enter a key.
- **GLOB patterns are ≤ 21 bytes** (the D1 limit is 50). The longest existing one, the date pattern, is 42.
- **Migration style.** `0005` uses plain `CREATE TABLE`/`CREATE INDEX`, not `IF NOT EXISTS`. The file applies atomically, so any unexpected pre-existing object makes it fail loudly instead of drifting silently.

### 3.2 Tables at a glance
| Table | PK strategy | Purpose | Personal data |
|---|---|---|---|
| `booking_requests` (+5 cols) | existing UUID | `flow_version`, `deposit_amount`, `terms_version`, `terms_accepted_at`, `completed_at` (D2). Terms acceptance is 1:1 and set once, so it is two columns, not a table. | existing |
| `users` (+1 col) | existing Firebase uid | `erased_at` marks the DSR pseudonymisation (§6.5) | existing |
| `event_kinds` | natural code | vocabulary for `booking_events.event` | no |
| `notification_kinds` | natural code | vocabulary for `notification_log.kind` | no |
| `booking_events` | autoincrement | audit of every event that is not a status change, with the actor. It is also the batch guard for actions that leave the status unchanged (ADR §2.1). | admin uid, free-text note |
| `notification_log` | natural `dedupe_key` | idempotent email outbox. Recipient and payload are NULLed when the row finishes, and a CHECK enforces it. | email and rendered text until terminal |
| `job_runs` | natural job name | cron heartbeat | no |
| `media_objects` | natural `object_key` | **register of every R2 object** and its deletion lifecycle | links a booking to receipt images and photos |
| `booking_receipts` | UUID | one row per upload attempt: pending, verified, rejected or void | rejection reason; image in R2 |
| `event_profiles` | `booking_id` | pre-event questionnaire | venue, time, requests |
| `booking_consents` | (`booking_id`, `purpose`) | explicit consents. No row means NO (default NO by construction). | consent state |
| `galleries` | UUID | one private gallery per booking, with a quota snapshot | no (the photos are in R2) |
| `gallery_photos` | UUID | one row per preview/thumbnail pair | camera filename; images in R2 |
| `gallery_selections` | (`gallery_id`, `photo_id`) | her favourites and final picks | her choices |
| `album_production` | `booking_id` | stage: design → printing → ready | no |
| `handover_slots` | UUID | admin-defined pickup and delivery windows with a capacity | no |
| `handovers` | `booking_id` | her slot, method, and delivery address | home address |
| `feedback` | `booking_id` | private rating and comment (D7) | opinion |

### 3.3 Foreign keys and `ON DELETE`
| Child → parent | ON DELETE | Why |
|---|---|---|
| every `booking_id` in `booking_events`, `notification_log`, `booking_receipts`, `event_profiles`, `booking_consents`, `galleries`, `album_production`, `handovers`, `feedback` → `booking_requests` | CASCADE | The booking owns them. A full erasure (§6.5) removes everything in one statement. |
| `media_objects.booking_id` → `booking_requests` | **SET NULL** | The register must outlive the booking so its objects can still be deleted. A NULL `booking_id` means "detached, purge now". |
| `booking_receipts.object_key`, `gallery_photos.preview_key`, `gallery_photos.thumb_key` → `media_objects` | SET NULL | Register rows are pruned 30 days after the object is deleted, and the business row keeps `purged_at`. |
| `gallery_photos.gallery_id` → `galleries` | CASCADE | Photos belong to a gallery. |
| (`gallery_selections.gallery_id`, `photo_id`) → `gallery_photos(gallery_id, id)` | CASCADE | A composite key makes a selection row pointing at another gallery's photo impossible. |
| `handovers.slot_id` → `handover_slots` | **RESTRICT** | A slot with bookings can only be deactivated, never deleted (ADR §2.5). |
| `booking_events.actor_uid`, `booking_receipts.reviewed_by` → `users` | SET NULL | Keep the audit if an admin account ever disappears. |
| `booking_events.event` → `event_kinds`, `notification_log.kind` → `notification_kinds` | RESTRICT | A kind that is in use can never be removed. |
| existing `booking_requests.user_id` → `users` | RESTRICT (unchanged) | This is why erasure deletes or pseudonymises the bookings first (§6.5). |

`ON UPDATE CASCADE` follows `0001`'s house style. Ids are immutable, so it never fires.

### 3.4 Denormalisations (each one written down, with its write-side risk)
| Where | Reason | Write-side risk, and how it is contained |
|---|---|---|
| `gallery_selections.gallery_id` (derivable from `photo_id`) | The quota predicate runs on every selection (the hot path, up to 50 per request). With the column, the count is a partial-index count and needs no join. | Drift between the selection and the photo's gallery is **impossible**: the composite foreign key to `gallery_photos(gallery_id, id)` blocks it. |
| `booking_receipts.object_key`, `gallery_photos.{preview,thumb}_key` (derivable from ids) | The register's identity must be the key, and the business row must reference the register. | **Impossible to drift**: a CHECK pins each key to its ids. |
| `media_objects.booking_id` (derivable through business rows) | It must survive cascades so a detached object can still be found and deleted. | It is written once at insert and never updated, except by the database's own `SET NULL`. |
| `galleries.quota` (derivable from `package_snapshot`) | Snapshot rule: the quota never changes after the gallery is created (ADR §2.4), even if the catalogue changes. | It is set once. `quota_source = 'package'` forces 30, 45, 60 or 80. |
| `booking_requests.completed_at` next to `handovers.completed_at` | Two different facts: "the whole booking is finished" (the retention anchor, which also covers bookings with no handover) and "the album was handed over". In the default flow they are stamped in the same batch. | Retention reads **only** `booking_requests.completed_at`. The handover column is operational history. |

### 3.5 Deviations from the ADR §2.8 sketch (each justified)
1. **No `idx_booking_requests_flow_status_hold`.** The existing `idx_booking_requests_status` already narrows to at most about 31 blocking rows a month (one blocking booking per date), and a composite index would add a write to every booking update.
2. **`handover_slots.slot_date` is dropped.** It is derived from `starts_at`, and storing it would put a time-zone rule into a CHECK.
3. **`handovers.delivery_address` becomes four columns**, matching the form in `08-copy-ar.md` §6.3: city, district, street and building, and an optional landmark. Each has its own limit and a required-set CHECK.
4. **Consent moves from `event_profiles` to `booking_consents`.** It has its own lifecycle: it can be withdrawn after the questionnaire text is purged, and toggling it must not count as "questionnaire saved" for journey stage 6. Default NO comes from the absence of a row, and new purposes are possible.
5. **`media_objects` is added** so R2 deletion is tracked even after a booking is deleted (§6.3).
6. **Receipts:**
   - `uploaded_by` is dropped: the uploader is always the booking owner, and the SQL enforces that through `user_id`.
   - `content_type`/`byte_size` move to the register.
   - `attempt_no` is added, for ordering, "latest receipt", and a cap of 10 attempts.
   - Status `void` is added, for a pending receipt on a cancelled booking.
7. **Lookup tables replace free-text kinds.** They are strict, and they grow by `INSERT`.
8. **`notification_log`:**
   - `booking_id` gets a cascading foreign key.
   - The rule "terminal ⇒ recipient and payload are NULL" is a CHECK, not a convention.
   - `updated_at` and `last_error_code` are added.
9. **`job_runs.last_ok_at`** is added. The "stale cron" warning needs the last *successful* run, which an error run would otherwise overwrite.
10. **`booking_requests.flow_version` CHECK:** a flow-2 hold must carry a valid ISO deadline. **`deposit_amount` CHECK:** flow 2 requires a deposit, and it must be ≤ `estimated_total`.
11. **Journey completion signal:** stages 14–15 should key on `booking_requests.completed_at`, not on "handover completed" (W3-5 note). Otherwise a booking with nothing physical to hand over can never complete.

### 3.6 The DDL
```sql
-- [file] 0005_portal_schema.sql
-- Sundus Yar client portal schema (ADR-001 section 2.8, final DDL from runs/redo-v2/06-data-model.md).
-- EXPAND ONLY: ADD COLUMN, CREATE TABLE, CREATE INDEX and seed INSERTs. Nothing is dropped, renamed or rewritten.
-- Instants are TEXT 'YYYY-MM-DDTHH:MM:SS.sssZ' (UTC) checked with IS, so a NULL from strftime() never passes.
-- Ids are lowercase UUIDs from crypto.randomUUID(). The legacy Worker keeps working with this schema applied.

-- 1. booking_requests (D2). The defaults keep every existing row on the legacy flow 1.
ALTER TABLE booking_requests ADD COLUMN flow_version INTEGER NOT NULL DEFAULT 1
  CHECK (
    flow_version IN (1, 2)
    AND (
      flow_version = 1
      OR status NOT IN ('approved_hold', 'payment_pending')
      OR (
        hold_expires_at IS NOT NULL
        AND length(hold_expires_at) = 24
        AND substr(hold_expires_at, 12, 2) < '24'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', hold_expires_at) IS hold_expires_at
      )
    )
  );

ALTER TABLE booking_requests ADD COLUMN deposit_amount INTEGER
  CHECK (
    (deposit_amount IS NULL AND flow_version = 1)
    OR (typeof(deposit_amount) = 'integer' AND deposit_amount BETWEEN 0 AND estimated_total)
  );

ALTER TABLE booking_requests ADD COLUMN terms_version TEXT
  CHECK (
    terms_version IS NULL
    OR (length(terms_version) BETWEEN 1 AND 32 AND terms_version NOT GLOB '*[^0-9A-Za-z._-]*')
  );

ALTER TABLE booking_requests ADD COLUMN terms_accepted_at TEXT
  CHECK (
    terms_accepted_at IS NULL
    OR (
      terms_version IS NOT NULL
      AND length(terms_accepted_at) = 24
      AND substr(terms_accepted_at, 12, 2) < '24'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', terms_accepted_at) IS terms_accepted_at
    )
  );

ALTER TABLE booking_requests ADD COLUMN completed_at TEXT
  CHECK (
    completed_at IS NULL
    OR (length(completed_at) = 24 AND substr(completed_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS completed_at)
  );

-- 2. users: marker for the DSR pseudonymisation path.
ALTER TABLE users ADD COLUMN erased_at TEXT
  CHECK (
    erased_at IS NULL
    OR (length(erased_at) = 24 AND substr(erased_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', erased_at) IS erased_at)
  );

-- 3. Vocabularies. Adding a kind later is an INSERT-only migration.
CREATE TABLE event_kinds (
  kind TEXT PRIMARY KEY NOT NULL
    CHECK (length(kind) BETWEEN 3 AND 40 AND kind NOT GLOB '*[^a-z_]*')
);

INSERT INTO event_kinds (kind) VALUES
  ('receipt_submitted'), ('receipt_resubmitted'), ('receipt_rejected'), ('hold_extended'),
  ('consent_granted'), ('consent_withdrawn'),
  ('gallery_created'), ('gallery_opened'), ('gallery_deadline_extended'), ('gallery_submitted'),
  ('gallery_reopened'), ('gallery_purged'), ('album_stage_changed'),
  ('handover_booked'), ('handover_rescheduled'), ('handover_completed'), ('handover_no_show'),
  ('handover_cancelled'), ('booking_completed'), ('personal_data_erased');

CREATE TABLE notification_kinds (
  kind TEXT PRIMARY KEY NOT NULL
    CHECK (length(kind) BETWEEN 3 AND 40 AND kind NOT GLOB '*[^a-z0-9_]*')
);

INSERT INTO notification_kinds (kind) VALUES
  ('hold_reminder_24h'), ('hold_reminder_6h'), ('hold_expired'), ('hold_extended'),
  ('receipt_submitted_admin'), ('receipt_rejected'),
  ('event_reminder_7d'), ('event_reminder_1d'),
  ('gallery_opened'), ('selection_reminder_7d'), ('selection_reminder_2d'), ('selection_overdue'),
  ('album_ready'), ('handover_reminder_1d'), ('feedback_request'), ('preview_deletion_notice');

-- 4. Audit of events that do not change booking_requests.status (also the batch guard for them).
CREATE TABLE booking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (actor IN ('customer', 'admin', 'system')),
  actor_uid TEXT
    REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  event TEXT NOT NULL
    REFERENCES event_kinds(kind) ON UPDATE RESTRICT ON DELETE RESTRICT,
  subject_id TEXT
    CHECK (
      subject_id IS NULL
      OR (length(subject_id) = 36 AND subject_id NOT GLOB '*[^0-9a-f-]*' AND substr(subject_id, 9, 1) = '-' AND substr(subject_id, 14, 1) = '-' AND substr(subject_id, 19, 1) = '-' AND substr(subject_id, 24, 1) = '-')
    ),
  details TEXT
    CHECK (details IS NULL OR (length(details) <= 1000 AND json_valid(details) AND json_type(details) = 'object')),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  redacted_at TEXT
    CHECK (
      redacted_at IS NULL
      OR (length(redacted_at) = 24 AND substr(redacted_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', redacted_at) IS redacted_at AND note IS NULL)
    ),
  CHECK (actor = 'admin' OR actor_uid IS NULL)
);

CREATE INDEX idx_booking_events_booking ON booking_events(booking_id, id);

-- 5. Email outbox (ADR section 2.2). Terminal rows keep no recipient and no payload.
CREATE TABLE notification_log (
  dedupe_key TEXT PRIMARY KEY NOT NULL
    CHECK (length(dedupe_key) BETWEEN 5 AND 200 AND dedupe_key NOT GLOB '*[^0-9A-Za-z:._-]*'),
  booking_id TEXT NOT NULL
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  kind TEXT NOT NULL
    REFERENCES notification_kinds(kind) ON UPDATE RESTRICT ON DELETE RESTRICT,
  recipient TEXT
    CHECK (recipient IS NULL OR (length(recipient) BETWEEN 3 AND 254 AND instr(recipient, '@') > 1)),
  payload TEXT
    CHECK (payload IS NULL OR (length(payload) <= 100000 AND json_valid(payload))),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 3),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  claimed_at TEXT
    CHECK (claimed_at IS NULL OR (length(claimed_at) = 24 AND substr(claimed_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', claimed_at) IS claimed_at)),
  finished_at TEXT
    CHECK (finished_at IS NULL OR (length(finished_at) = 24 AND substr(finished_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', finished_at) IS finished_at)),
  provider_message_id TEXT
    CHECK (provider_message_id IS NULL OR (length(provider_message_id) BETWEEN 1 AND 128 AND provider_message_id NOT GLOB '*[^0-9A-Za-z._-]*')),
  last_error_code TEXT
    CHECK (last_error_code IS NULL OR (length(last_error_code) BETWEEN 1 AND 64 AND last_error_code NOT GLOB '*[^A-Z0-9_]*')),
  CHECK (substr(dedupe_key, 1, length(kind) + 1) = kind || ':'),
  CHECK (
    (status IN ('pending', 'sending') AND recipient IS NOT NULL AND payload IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('sent', 'skipped', 'failed', 'superseded') AND recipient IS NULL AND payload IS NULL AND finished_at IS NOT NULL)
  ),
  CHECK (status <> 'sending' OR claimed_at IS NOT NULL)
);

CREATE INDEX idx_notification_log_status_created ON notification_log(status, created_at);

-- 6. Cron heartbeat.
CREATE TABLE job_runs (
  job TEXT PRIMARY KEY NOT NULL
    CHECK (length(job) BETWEEN 3 AND 40 AND job NOT GLOB '*[^a-z-]*'),
  last_started_at TEXT
    CHECK (last_started_at IS NULL OR (length(last_started_at) = 24 AND substr(last_started_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', last_started_at) IS last_started_at)),
  last_finished_at TEXT
    CHECK (last_finished_at IS NULL OR (length(last_finished_at) = 24 AND substr(last_finished_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', last_finished_at) IS last_finished_at)),
  last_ok_at TEXT
    CHECK (last_ok_at IS NULL OR (length(last_ok_at) = 24 AND substr(last_ok_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', last_ok_at) IS last_ok_at)),
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('ok', 'error')),
  last_error_code TEXT
    CHECK (last_error_code IS NULL OR (length(last_error_code) BETWEEN 1 AND 64 AND last_error_code NOT GLOB '*[^A-Z0-9_]*'))
);

-- 7. Register of every R2 object and its deletion lifecycle (section 6.3).
CREATE TABLE media_objects (
  object_key TEXT PRIMARY KEY NOT NULL
    CHECK (
      object_key NOT GLOB '*[^0-9a-fgprt/-]*'
      AND (
        (substr(object_key, 1, 2) = 'r/' AND length(object_key) = 75)
        OR (substr(object_key, 1, 2) = 'g/' AND length(object_key) = 77)
      )
    ),
  booking_id TEXT
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'gallery_preview', 'gallery_thumb')),
  content_type TEXT NOT NULL
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  byte_size INTEGER NOT NULL
    CHECK (typeof(byte_size) = 'integer' AND byte_size BETWEEN 1 AND 5242880),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at TEXT NOT NULL
    CHECK (length(expires_at) = 24 AND substr(expires_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at AND expires_at > created_at),
  purge_reason TEXT
    CHECK (purge_reason IS NULL OR purge_reason IN ('retention_policy', 'ceiling', 'detached', 'admin_removed', 'upload_aborted', 'erasure_request')),
  purge_claim TEXT
    CHECK (
      purge_claim IS NULL
      OR (length(purge_claim) = 36 AND purge_claim NOT GLOB '*[^0-9a-f-]*' AND substr(purge_claim, 9, 1) = '-' AND substr(purge_claim, 14, 1) = '-' AND substr(purge_claim, 19, 1) = '-' AND substr(purge_claim, 24, 1) = '-')
    ),
  purge_claimed_at TEXT
    CHECK (purge_claimed_at IS NULL OR (length(purge_claimed_at) = 24 AND substr(purge_claimed_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', purge_claimed_at) IS purge_claimed_at)),
  deleted_at TEXT
    CHECK (deleted_at IS NULL OR (length(deleted_at) = 24 AND substr(deleted_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) IS deleted_at)),
  CHECK (
    (kind = 'receipt' AND substr(object_key, 1, 2) = 'r/')
    OR (kind = 'gallery_preview' AND substr(object_key, 1, 2) = 'g/' AND substr(object_key, -2) = '/p')
    OR (kind = 'gallery_thumb' AND substr(object_key, 1, 2) = 'g/' AND substr(object_key, -2) = '/t')
  ),
  CHECK (kind = 'receipt' OR content_type IN ('image/jpeg', 'image/webp')),
  CHECK (kind <> 'gallery_preview' OR byte_size <= 1572864),
  CHECK (kind <> 'gallery_thumb' OR byte_size <= 262144),
  CHECK ((purge_claim IS NULL) = (purge_claimed_at IS NULL)),
  CHECK (purge_claim IS NULL OR purge_reason IS NOT NULL),
  CHECK (deleted_at IS NULL OR purge_reason IS NOT NULL)
);

CREATE INDEX idx_media_objects_booking ON media_objects(booking_id);

-- 8. Deposit receipts (D2): one row per upload attempt, at most one pending per booking.
CREATE TABLE booking_receipts (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  booking_id TEXT NOT NULL
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL
    CHECK (typeof(attempt_no) = 'integer' AND attempt_no BETWEEN 1 AND 10),
  object_key TEXT UNIQUE
    REFERENCES media_objects(object_key) ON UPDATE CASCADE ON DELETE SET NULL
    CHECK (object_key IS NULL OR object_key = 'r/' || booking_id || '/' || id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'rejected', 'void')),
  reviewed_by TEXT
    REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  reviewed_at TEXT
    CHECK (reviewed_at IS NULL OR (length(reviewed_at) = 24 AND substr(reviewed_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at) IS reviewed_at AND reviewed_at >= created_at)),
  rejection_reason TEXT
    CHECK (rejection_reason IS NULL OR (status = 'rejected' AND length(rejection_reason) BETWEEN 1 AND 500)),
  purged_at TEXT
    CHECK (purged_at IS NULL OR (length(purged_at) = 24 AND substr(purged_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', purged_at) IS purged_at AND status <> 'pending')),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  UNIQUE (booking_id, attempt_no),
  CHECK ((status = 'pending') = (reviewed_at IS NULL))
);

CREATE UNIQUE INDEX ux_booking_receipts_one_pending ON booking_receipts(booking_id) WHERE status = 'pending';

-- 9. Pre-event questionnaire. Text is purged on schedule; the row stays as the stage-6 marker.
CREATE TABLE event_profiles (
  booking_id TEXT PRIMARY KEY NOT NULL
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  venue_name TEXT CHECK (venue_name IS NULL OR length(venue_name) BETWEEN 1 AND 120),
  venue_area TEXT CHECK (venue_area IS NULL OR length(venue_area) BETWEEN 1 AND 120),
  event_start_time TEXT
    CHECK (event_start_time IS NULL OR (length(event_start_time) = 5 AND event_start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND event_start_time <= '23:59')),
  special_requests TEXT CHECK (special_requests IS NULL OR length(special_requests) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  text_purged_at TEXT
    CHECK (text_purged_at IS NULL OR (length(text_purged_at) = 24 AND substr(text_purged_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', text_purged_at) IS text_purged_at)),
  CHECK (text_purged_at IS NULL OR (venue_name IS NULL AND venue_area IS NULL AND event_start_time IS NULL AND special_requests IS NULL))
);

-- 10. Explicit consents. No row means NO (default NO by construction).
CREATE TABLE booking_consents (
  booking_id TEXT NOT NULL
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('publish_photos', 'publish_testimonial')),
  granted INTEGER NOT NULL CHECK (granted IN (0, 1)),
  text_version TEXT NOT NULL
    CHECK (length(text_version) BETWEEN 1 AND 32 AND text_version NOT GLOB '*[^0-9A-Za-z._-]*'),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (booking_id, purpose)
);

-- 11. Private gallery, one per booking.
CREATE TABLE galleries (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  booking_id TEXT NOT NULL UNIQUE
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'locked', 'purged')),
  quota INTEGER NOT NULL CHECK (typeof(quota) = 'integer' AND quota BETWEEN 1 AND 500),
  quota_source TEXT NOT NULL CHECK (quota_source IN ('package', 'coverage_default', 'admin')),
  opened_at TEXT
    CHECK (opened_at IS NULL OR (length(opened_at) = 24 AND substr(opened_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', opened_at) IS opened_at)),
  selection_deadline TEXT
    CHECK (
      selection_deadline IS NULL
      OR (length(selection_deadline) = 24 AND substr(selection_deadline, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', selection_deadline) IS selection_deadline AND opened_at IS NOT NULL AND selection_deadline > opened_at)
    ),
  submitted_at TEXT
    CHECK (submitted_at IS NULL OR (length(submitted_at) = 24 AND substr(submitted_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', submitted_at) IS submitted_at)),
  purged_at TEXT
    CHECK (purged_at IS NULL OR (length(purged_at) = 24 AND substr(purged_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', purged_at) IS purged_at)),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (quota_source <> 'package' OR quota IN (30, 45, 60, 80)),
  CHECK (status <> 'open' OR (opened_at IS NOT NULL AND selection_deadline IS NOT NULL AND submitted_at IS NULL)),
  CHECK (status <> 'locked' OR submitted_at IS NOT NULL),
  CHECK ((status = 'purged') = (purged_at IS NOT NULL))
);

CREATE INDEX idx_galleries_open_deadline ON galleries(selection_deadline) WHERE status = 'open';

CREATE TABLE gallery_photos (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  gallery_id TEXT NOT NULL
    REFERENCES galleries(id) ON UPDATE CASCADE ON DELETE CASCADE,
  original_filename TEXT NOT NULL
    CHECK (
      length(original_filename) BETWEEN 1 AND 200
      AND instr(original_filename, '/') = 0
      AND instr(original_filename, char(92)) = 0
      AND original_filename NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    ),
  preview_key TEXT UNIQUE
    REFERENCES media_objects(object_key) ON UPDATE CASCADE ON DELETE SET NULL
    CHECK (preview_key IS NULL OR preview_key = 'g/' || gallery_id || '/' || id || '/p'),
  thumb_key TEXT UNIQUE
    REFERENCES media_objects(object_key) ON UPDATE CASCADE ON DELETE SET NULL
    CHECK (thumb_key IS NULL OR thumb_key = 'g/' || gallery_id || '/' || id || '/t'),
  width INTEGER NOT NULL CHECK (typeof(width) = 'integer' AND width BETWEEN 1 AND 4096),
  height INTEGER NOT NULL CHECK (typeof(height) = 'integer' AND height BETWEEN 1 AND 4096),
  sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order BETWEEN 0 AND 9999),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  UNIQUE (gallery_id, original_filename),
  UNIQUE (gallery_id, id)
);

CREATE TABLE gallery_selections (
  gallery_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  is_selected INTEGER NOT NULL DEFAULT 0 CHECK (is_selected IN (0, 1)),
  is_favourite INTEGER NOT NULL DEFAULT 0 CHECK (is_favourite IN (0, 1)),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  PRIMARY KEY (gallery_id, photo_id),
  FOREIGN KEY (gallery_id, photo_id)
    REFERENCES gallery_photos(gallery_id, id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX idx_gallery_selections_selected ON gallery_selections(gallery_id) WHERE is_selected = 1;

-- 12. Album production.
CREATE TABLE album_production (
  booking_id TEXT PRIMARY KEY NOT NULL
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('design', 'printing', 'ready')),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at)
);

-- 13. Handover (D3): admin-defined slots and her booked slot.
CREATE TABLE handover_slots (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  starts_at TEXT NOT NULL
    CHECK (length(starts_at) = 24 AND substr(starts_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', starts_at) IS starts_at),
  ends_at TEXT NOT NULL
    CHECK (
      length(ends_at) = 24 AND substr(ends_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', ends_at) IS ends_at
      AND ends_at > starts_at
      AND (julianday(ends_at) - julianday(starts_at)) * 24 <= 12
    ),
  method TEXT NOT NULL CHECK (method IN ('pickup', 'delivery', 'both')),
  capacity INTEGER NOT NULL DEFAULT 1 CHECK (typeof(capacity) = 'integer' AND capacity BETWEEN 1 AND 20),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  UNIQUE (starts_at, method)
);

CREATE TABLE handovers (
  booking_id TEXT PRIMARY KEY NOT NULL
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  slot_id TEXT NOT NULL
    REFERENCES handover_slots(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('pickup', 'delivery')),
  delivery_city TEXT CHECK (delivery_city IS NULL OR length(delivery_city) BETWEEN 1 AND 60),
  delivery_district TEXT CHECK (delivery_district IS NULL OR length(delivery_district) BETWEEN 1 AND 80),
  delivery_street TEXT CHECK (delivery_street IS NULL OR length(delivery_street) BETWEEN 1 AND 160),
  delivery_landmark TEXT CHECK (delivery_landmark IS NULL OR length(delivery_landmark) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'no_show', 'cancelled')),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  completed_at TEXT
    CHECK (completed_at IS NULL OR (length(completed_at) = 24 AND substr(completed_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS completed_at)),
  address_purged_at TEXT
    CHECK (address_purged_at IS NULL OR (length(address_purged_at) = 24 AND substr(address_purged_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', address_purged_at) IS address_purged_at)),
  CHECK (method = 'delivery' OR (delivery_city IS NULL AND delivery_district IS NULL AND delivery_street IS NULL AND delivery_landmark IS NULL)),
  CHECK (method = 'pickup' OR address_purged_at IS NOT NULL OR (delivery_city IS NOT NULL AND delivery_district IS NOT NULL AND delivery_street IS NOT NULL)),
  CHECK (address_purged_at IS NULL OR (delivery_city IS NULL AND delivery_district IS NULL AND delivery_street IS NULL AND delivery_landmark IS NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX idx_handovers_slot_scheduled ON handovers(slot_id) WHERE status = 'scheduled';

-- 14. Private feedback (D7: never auto-published).
CREATE TABLE feedback (
  booking_id TEXT PRIMARY KEY NOT NULL
    REFERENCES booking_requests(id) ON UPDATE CASCADE ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (typeof(rating) = 'integer' AND rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND substr(updated_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at)
);
```

### 3.7 Relationship sketch
```
users 1───* booking_requests 1───* booking_status_history            (existing)
                   │
                   ├──* booking_events      *──1 event_kinds
                   ├──* notification_log    *──1 notification_kinds
                   ├──* booking_receipts    ──1 media_objects  (r/<bookingId>/<receiptId>)
                   ├──1 event_profiles
                   ├──* booking_consents    (one row per purpose; none = NO)
                   ├──1 galleries 1──* gallery_photos ──2 media_objects (g/<galleryId>/<photoId>/p|t)
                   │                        1──0..1 gallery_selections
                   ├──1 album_production
                   ├──1 handovers           *──1 handover_slots (RESTRICT)
                   ├──1 feedback
                   └──* media_objects       (SET NULL: the register outlives the booking)
job_runs (standalone heartbeat)
```

---

## 4. Write paths: atomic batches and the double-submit rules

### 4.0 Binding rules for every block below
- D1 supports only `?NNN` and `?` parameters, never named ones. The blocks number their parameters, and **each statement binds `params.slice(0, highestIndexItUses)`**, so the parameter list of one batch can be shared across its statements.
- Every multi-statement block runs as **one `env.DB.batch([...])`**, which is one transaction. `changes()` in a statement reads the statement just before it in the same batch. That is the existing pattern at `admin-workflow.ts:539-577`.
- The Worker binds `now = new Date().toISOString()`, and every other instant is computed from it in `shared/timing.ts`. Riyadh calendar dates come from `Intl` (ADR §2.2). Never use SQLite `'now'`.
- Every free-text input is normalised in the Worker before binding: `trim()`, `normalize('NFC')`, C0/C1 control characters rejected (line breaks allowed only in `special_requests`, `comment`, `rejection_reason` and notes), and length counted in **code points** (`[...s].length`), which is what SQLite's `length()` counts.
- When a batch fails, the Worker re-reads the state and maps it to a fixed error code, mirroring `resolveTransitionFailure` (`admin-workflow.ts:390-430`). An R2 object put before a failed batch is deleted straight away. If that delete also fails, the weekly orphan sweep removes it (§6.3).

### 4.1 Double-submit matrix
| Action | What makes a second submit harmless |
|---|---|
| Terms + first receipt (customer) | The `UPDATE` requires `status = 'approved_hold' AND hold_expires_at > now`. The second call changes 0 rows, the history `to_status` becomes NULL, and the batch rolls back. The client treats `RECEIPT_ALREADY_PENDING` as success (ADR). |
| Receipt re-upload | The latest receipt must be `rejected`, and the event guard enforces it. The partial unique index `ux_booking_receipts_one_pending` and `UNIQUE (booking_id, attempt_no)` back it up. |
| Reject receipt / extend hold (admin) | Optimistic: the request carries the `hold_expires_at` the admin saw. After the first success the value has changed, so a second click changes 0 rows and the event guard aborts. |
| Confirm payment | A status predicate plus the existing history guard. |
| Consent toggle | Primary key (`booking_id`, `purpose`) with an upsert. An event is written only when the value actually changes. |
| Questionnaire save | Primary key `booking_id`, upsert. The operation is naturally idempotent. |
| Gallery create | `galleries.booking_id UNIQUE`, and `ON CONFLICT DO NOTHING` trips the event guard. |
| Photo upload (resume or retry) | `UNIQUE (gallery_id, original_filename)`. A repeated name changes 0 rows and the Worker deletes the two new R2 objects. |
| Select / favourite | Idempotent "set" operations on primary key (`gallery_id`, `photo_id`). The quota is checked inside the same statement. |
| Submit selection | `status = 'open'` plus "count = quota" in the `UPDATE`. The second call changes 0 rows and returns `GALLERY_LOCKED`, which the client treats as success. |
| Album stage | Forward-only predicate `stage = ?from`. The "album ready" email key ends in `:once`. |
| Handover booking | Primary key `booking_id`. Capacity is counted inside the insert. |
| Feedback | Primary key `booking_id`. |
| Admin slot creation | `UNIQUE (starts_at, method)`. |
| Every email | Primary key `dedupe_key` is also Resend's `Idempotency-Key`. |

### 4.2 Receipts and holds (W4-2, W4-3)
```sql
-- [batch] receipt_submit
-- First submission: flow 2, approved_hold, before the deadline.
-- ?1 booking id | ?2 caller uid | ?3 now | ?4 TERMS_VERSION | ?5 new receipt id | ?6 sniffed content type
-- ?7 byte size | ?8 register ceiling (now + RECEIPT_CEILING_DAYS) | ?9 admin recipient | ?10 rendered admin email (JSON)
UPDATE booking_requests
SET status = 'payment_pending', terms_version = ?4, terms_accepted_at = ?3, updated_at = ?3
WHERE id = ?1 AND user_id = ?2 AND flow_version = 2 AND status = 'approved_hold' AND hold_expires_at > ?3;
INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
VALUES (?1, 'approved_hold', CASE WHEN changes() = 1 THEN 'payment_pending' END, ?2, NULL, ?3);
INSERT INTO media_objects (object_key, booking_id, kind, content_type, byte_size, created_at, expires_at)
VALUES ('r/' || ?1 || '/' || ?5, ?1, 'receipt', ?6, ?7, ?3, ?8);
INSERT INTO booking_receipts (id, booking_id, attempt_no, object_key, status, created_at, updated_at)
SELECT ?5, ?1, COALESCE(MAX(attempt_no), 0) + 1, 'r/' || ?1 || '/' || ?5, 'pending', ?3, ?3
FROM booking_receipts
WHERE booking_id = ?1;
INSERT INTO booking_events (booking_id, actor, event, subject_id, created_at)
VALUES (?1, 'customer', 'receipt_submitted', ?5, ?3);
UPDATE notification_log
SET status = 'superseded', recipient = NULL, payload = NULL, finished_at = ?3, updated_at = ?3
WHERE booking_id = ?1 AND status = 'pending' AND kind IN ('hold_reminder_24h', 'hold_reminder_6h');
INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, attempts, created_at, updated_at)
VALUES ('receipt_submitted_admin:' || ?1 || ':' || ?5, ?1, 'receipt_submitted_admin', ?9, ?10, 'pending', 0, ?3, ?3);
```

```sql
-- [batch] receipt_resubmit
-- Re-upload after a rejection. The status stays payment_pending; the guard is booking_events.event NOT NULL.
-- Same parameters as receipt_submit (?4 is unused here).
UPDATE booking_requests
SET updated_at = ?3
WHERE id = ?1 AND user_id = ?2 AND flow_version = 2 AND status = 'payment_pending' AND hold_expires_at > ?3
  AND (SELECT r.status FROM booking_receipts AS r WHERE r.booking_id = booking_requests.id ORDER BY r.attempt_no DESC LIMIT 1) = 'rejected';
INSERT INTO booking_events (booking_id, actor, event, subject_id, created_at)
VALUES (?1, 'customer', CASE WHEN changes() = 1 THEN 'receipt_resubmitted' END, ?5, ?3);
INSERT INTO media_objects (object_key, booking_id, kind, content_type, byte_size, created_at, expires_at)
VALUES ('r/' || ?1 || '/' || ?5, ?1, 'receipt', ?6, ?7, ?3, ?8);
INSERT INTO booking_receipts (id, booking_id, attempt_no, object_key, status, created_at, updated_at)
SELECT ?5, ?1, COALESCE(MAX(attempt_no), 0) + 1, 'r/' || ?1 || '/' || ?5, 'pending', ?3, ?3
FROM booking_receipts
WHERE booking_id = ?1;
INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, attempts, created_at, updated_at)
VALUES ('receipt_submitted_admin:' || ?1 || ':' || ?5, ?1, 'receipt_submitted_admin', ?9, ?10, 'pending', 0, ?3, ?3);
```

```sql
-- [batch] receipt_reject
-- Admin action reject_receipt (reason required). The hold becomes max(seen hold, now) + extension.
-- ?1 booking id | ?2 admin uid | ?3 now | ?4 receipt id | ?5 hold_expires_at the admin saw | ?6 new hold
-- ?7 reason (1..500 code points) | ?8 customer email | ?9 rendered email (JSON)
UPDATE booking_requests
SET hold_expires_at = ?6, updated_at = ?3
WHERE id = ?1 AND flow_version = 2 AND status = 'payment_pending' AND hold_expires_at = ?5 AND ?6 > ?3
  AND EXISTS (SELECT 1 FROM booking_receipts WHERE id = ?4 AND booking_id = ?1 AND status = 'pending');
UPDATE booking_receipts
SET status = 'rejected', reviewed_by = ?2, reviewed_at = ?3, rejection_reason = ?7, updated_at = ?3
WHERE id = ?4 AND booking_id = ?1 AND status = 'pending'
  AND EXISTS (SELECT 1 FROM booking_requests WHERE id = ?1 AND status = 'payment_pending' AND hold_expires_at = ?6);
INSERT INTO booking_events (booking_id, actor, actor_uid, event, subject_id, details, created_at)
VALUES (?1, 'admin', ?2, CASE WHEN changes() = 1 THEN 'receipt_rejected' END, ?4, json_object('holdExpiresAt', ?6), ?3);
UPDATE notification_log
SET status = 'superseded', recipient = NULL, payload = NULL, finished_at = ?3, updated_at = ?3
WHERE booking_id = ?1 AND status = 'pending' AND kind IN ('hold_reminder_24h', 'hold_reminder_6h');
INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, attempts, created_at, updated_at)
VALUES ('receipt_rejected:' || ?1 || ':' || ?4, ?1, 'receipt_rejected', ?8, ?9, 'pending', 0, ?3, ?3);
```

```sql
-- [batch] hold_extend
-- Admin action extend_hold: approved_hold, or payment_pending whose latest receipt is rejected.
-- ?1 booking id | ?2 admin uid | ?3 now | ?4 hold the admin saw | ?5 new hold | ?6 optional note | ?7 customer email | ?8 rendered email
UPDATE booking_requests
SET hold_expires_at = ?5, updated_at = ?3
WHERE id = ?1 AND flow_version = 2 AND hold_expires_at = ?4 AND ?5 > ?4 AND ?5 > ?3
  AND (
    status = 'approved_hold'
    OR (
      status = 'payment_pending'
      AND (SELECT r.status FROM booking_receipts AS r WHERE r.booking_id = booking_requests.id ORDER BY r.attempt_no DESC LIMIT 1) = 'rejected'
    )
  );
INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, note, created_at)
VALUES (?1, 'admin', ?2, CASE WHEN changes() = 1 THEN 'hold_extended' END, json_object('from', ?4, 'to', ?5), ?6, ?3);
UPDATE notification_log
SET status = 'superseded', recipient = NULL, payload = NULL, finished_at = ?3, updated_at = ?3
WHERE booking_id = ?1 AND status = 'pending' AND kind IN ('hold_reminder_24h', 'hold_reminder_6h');
INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, attempts, created_at, updated_at)
VALUES ('hold_extended:' || ?1 || ':' || ?5, ?1, 'hold_extended', ?7, ?8, 'pending', 0, ?3, ?3);
```

```sql
-- [batch] payment_confirm_flow2
-- confirm_payment on a flow-2 booking with a pending receipt. The existing status email path is unchanged.
-- ?1 booking id | ?2 admin uid | ?3 now | ?4 optional note
UPDATE booking_requests
SET status = 'confirmed', confirmed_at = ?3, updated_at = ?3
WHERE id = ?1 AND flow_version = 2 AND status = 'payment_pending'
  AND EXISTS (SELECT 1 FROM booking_receipts WHERE booking_id = ?1 AND status = 'pending');
INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
VALUES (?1, 'payment_pending', CASE WHEN changes() = 1 THEN 'confirmed' END, ?2, ?4, ?3);
UPDATE booking_receipts
SET status = 'verified', reviewed_by = ?2, reviewed_at = ?3, updated_at = ?3
WHERE booking_id = ?1 AND status = 'pending';
UPDATE notification_log
SET status = 'superseded', recipient = NULL, payload = NULL, finished_at = ?3, updated_at = ?3
WHERE booking_id = ?1 AND status = 'pending' AND kind IN ('hold_reminder_24h', 'hold_reminder_6h');
```

```sql
-- [batch] cancel_side_effects
-- Appended after the existing cancel UPDATE + history guard (any flow). Each statement re-checks 'cancelled'.
-- ?1 booking id | ?2 admin uid | ?3 now
UPDATE booking_receipts
SET status = 'void', reviewed_by = ?2, reviewed_at = ?3, updated_at = ?3
WHERE booking_id = ?1 AND status = 'pending'
  AND EXISTS (SELECT 1 FROM booking_requests WHERE id = ?1 AND status = 'cancelled');
UPDATE handovers
SET status = 'cancelled', updated_at = ?3
WHERE booking_id = ?1 AND status = 'scheduled'
  AND EXISTS (SELECT 1 FROM booking_requests WHERE id = ?1 AND status = 'cancelled');
INSERT INTO booking_events (booking_id, actor, actor_uid, event, created_at)
SELECT ?1, 'admin', ?2, 'handover_cancelled', ?3
WHERE changes() = 1;
UPDATE notification_log
SET status = 'superseded', recipient = NULL, payload = NULL, finished_at = ?3, updated_at = ?3
WHERE booking_id = ?1 AND status = 'pending'
  AND EXISTS (SELECT 1 FROM booking_requests WHERE id = ?1 AND status = 'cancelled');
```

```sql
-- [batch] hold_expiry
-- Cron */15 (bounded) and the targeted sweep that approve runs first (?3 = that event_date; NULL for cron).
-- Flow-1 rows are never selected. A payment_pending hold whose latest receipt is pending never expires.
-- ?1 now | ?2 max rows (50 on Workers Paid, 20 on Free) | ?3 event_date filter or NULL
INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
SELECT b.id, b.status, 'expired', NULL, NULL, ?1
FROM booking_requests AS b
WHERE b.id IN (
  SELECT c.id FROM booking_requests AS c
  WHERE c.flow_version = 2 AND c.hold_expires_at <= ?1 AND (?3 IS NULL OR c.event_date = ?3)
    AND (
      c.status = 'approved_hold'
      OR (
        c.status = 'payment_pending'
        AND (SELECT r.status FROM booking_receipts AS r WHERE r.booking_id = c.id ORDER BY r.attempt_no DESC LIMIT 1) = 'rejected'
      )
    )
  ORDER BY c.hold_expires_at, c.id
  LIMIT ?2
);
UPDATE booking_requests
SET status = 'expired', updated_at = ?1
WHERE id IN (
  SELECT c.id FROM booking_requests AS c
  WHERE c.flow_version = 2 AND c.hold_expires_at <= ?1 AND (?3 IS NULL OR c.event_date = ?3)
    AND (
      c.status = 'approved_hold'
      OR (
        c.status = 'payment_pending'
        AND (SELECT r.status FROM booking_receipts AS r WHERE r.booking_id = c.id ORDER BY r.attempt_no DESC LIMIT 1) = 'rejected'
      )
    )
  ORDER BY c.hold_expires_at, c.id
  LIMIT ?2
);
UPDATE notification_log
SET status = 'superseded', recipient = NULL, payload = NULL, finished_at = ?1, updated_at = ?1
WHERE status = 'pending' AND kind IN ('hold_reminder_24h', 'hold_reminder_6h')
  AND booking_id IN (SELECT id FROM booking_requests WHERE status = 'expired' AND updated_at = ?1);
```

```sql
-- [batch] hold_expiry_notice
-- One statement per expired booking, appended to the same hold_expiry batch (emails rendered beforehand).
-- ?1 now | ?2 booking id | ?3 its hold_expires_at (anchor) | ?4 recipient | ?5 rendered email
INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, attempts, created_at, updated_at)
SELECT 'hold_expired:' || ?2 || ':' || ?3, b.id, 'hold_expired', ?4, ?5, 'pending', 0, ?1, ?1
FROM booking_requests AS b
WHERE b.id = ?2 AND b.status = 'expired' AND b.updated_at = ?1
ON CONFLICT (dedupe_key) DO NOTHING;
```

Approve on flow 2 (W4-2) keeps the existing guarded `UPDATE` (`admin-workflow.ts:483-538`). It additionally sets `flow_version = 2`, `deposit_amount = <snapshot from shared/deposit.ts>` and `hold_expires_at = now + 48 h`, but only when `ONLINE_CONFIRMATION` is `on` and D4 is decided. The `deposit_amount` CHECK makes a flow-2 approval without a deposit impossible. Beforehand it runs `hold_expiry` with `?3` = that event date.

### 4.3 Pre-event (W5-1)
```sql
-- [batch] consent_set
-- Default NO = no row. Granting needs a confirmed booking; withdrawing is always allowed (see U-6).
-- ?1 granted (0|1) | ?2 now | ?3 booking id | ?4 caller uid | ?5 purpose | ?6 consent text version
INSERT INTO booking_events (booking_id, actor, event, details, created_at)
SELECT b.id, 'customer', CASE WHEN ?1 = 1 THEN 'consent_granted' ELSE 'consent_withdrawn' END,
       json_object('purpose', ?5, 'textVersion', ?6), ?2
FROM booking_requests AS b
WHERE b.id = ?3 AND b.user_id = ?4 AND (b.status = 'confirmed' OR ?1 = 0)
  AND COALESCE((SELECT c.granted FROM booking_consents AS c WHERE c.booking_id = b.id AND c.purpose = ?5), 0) <> ?1;
INSERT INTO booking_consents (booking_id, purpose, granted, text_version, created_at, updated_at)
SELECT b.id, ?5, ?1, ?6, ?2, ?2
FROM booking_requests AS b
WHERE b.id = ?3 AND b.user_id = ?4 AND (b.status = 'confirmed' OR ?1 = 0)
ON CONFLICT (booking_id, purpose) DO UPDATE SET
  granted = excluded.granted, text_version = excluded.text_version, updated_at = excluded.updated_at
WHERE booking_consents.granted <> excluded.granted OR booking_consents.text_version <> excluded.text_version;
```

```sql
-- [query] event_profile_upsert
-- Editable until the event date (Riyadh). 0 changes = not hers / not confirmed / event passed / text purged.
-- ?1 booking id | ?2 caller uid | ?3 now | ?4 today (Riyadh YYYY-MM-DD) | ?5 venue_name | ?6 venue_area
-- ?7 event_start_time HH:MM | ?8 special_requests
INSERT INTO event_profiles (booking_id, venue_name, venue_area, event_start_time, special_requests, created_at, updated_at)
SELECT b.id, ?5, ?6, ?7, ?8, ?3, ?3
FROM booking_requests AS b
WHERE b.id = ?1 AND b.user_id = ?2 AND b.status = 'confirmed' AND b.event_date >= ?4
ON CONFLICT (booking_id) DO UPDATE SET
  venue_name = excluded.venue_name, venue_area = excluded.venue_area,
  event_start_time = excluded.event_start_time, special_requests = excluded.special_requests,
  updated_at = excluded.updated_at
WHERE event_profiles.text_purged_at IS NULL;
```

### 4.4 Gallery and selection (W6-1)
The quota is computed in the Worker with the existing type guard (`isBookingPackageSnapshot`):
- `album.photoCount` (30, 45, 60 or 80), with source `package`;
- otherwise the coverage-only default of 30 (U-15), with source `coverage_default`;
- otherwise a quota the admin enters, with source `admin`.
```sql
-- [batch] gallery_create
-- ?1 gallery id | ?2 booking id | ?3 now | ?4 quota | ?5 quota source | ?6 today (Riyadh) | ?7 admin uid
INSERT INTO galleries (id, booking_id, status, quota, quota_source, created_at, updated_at)
SELECT ?1, b.id, 'draft', ?4, ?5, ?3, ?3
FROM booking_requests AS b
WHERE b.id = ?2 AND b.status = 'confirmed' AND b.event_date <= ?6
ON CONFLICT (booking_id) DO NOTHING;
INSERT INTO booking_events (booking_id, actor, actor_uid, event, subject_id, created_at)
VALUES (?2, 'admin', ?7, CASE WHEN changes() = 1 THEN 'gallery_created' END, ?1, ?3);
```

```sql
-- [batch] gallery_photo_add
-- Both R2 objects are put first. 0 changes on all three statements = duplicate filename: delete the two new objects.
-- ?1 photo id | ?2 gallery id | ?3 now | ?4 register ceiling (now + GALLERY_CEILING_DAYS) | ?5 original filename (NFC)
-- ?6 preview content type | ?7 preview bytes | ?8 thumb content type | ?9 thumb bytes | ?10 width | ?11 height | ?12 sort order
INSERT INTO media_objects (object_key, booking_id, kind, content_type, byte_size, created_at, expires_at)
SELECT 'g/' || g.id || '/' || ?1 || '/p', g.booking_id, 'gallery_preview', ?6, ?7, ?3, ?4
FROM galleries AS g
WHERE g.id = ?2 AND g.status IN ('draft', 'open')
  AND NOT EXISTS (SELECT 1 FROM gallery_photos AS p WHERE p.gallery_id = g.id AND p.original_filename = ?5)
  AND (SELECT COUNT(*) FROM gallery_photos AS p WHERE p.gallery_id = g.id) < 1000;
INSERT INTO media_objects (object_key, booking_id, kind, content_type, byte_size, created_at, expires_at)
SELECT 'g/' || g.id || '/' || ?1 || '/t', g.booking_id, 'gallery_thumb', ?8, ?9, ?3, ?4
FROM galleries AS g
WHERE g.id = ?2 AND g.status IN ('draft', 'open')
  AND NOT EXISTS (SELECT 1 FROM gallery_photos AS p WHERE p.gallery_id = g.id AND p.original_filename = ?5)
  AND (SELECT COUNT(*) FROM gallery_photos AS p WHERE p.gallery_id = g.id) < 1000;
INSERT INTO gallery_photos (id, gallery_id, original_filename, preview_key, thumb_key, width, height, sort_order, created_at, updated_at)
SELECT ?1, g.id, ?5, 'g/' || g.id || '/' || ?1 || '/p', 'g/' || g.id || '/' || ?1 || '/t', ?10, ?11, ?12, ?3, ?3
FROM galleries AS g
WHERE g.id = ?2 AND g.status IN ('draft', 'open')
  AND NOT EXISTS (SELECT 1 FROM gallery_photos AS p WHERE p.gallery_id = g.id AND p.original_filename = ?5)
  AND (SELECT COUNT(*) FROM gallery_photos AS p WHERE p.gallery_id = g.id) < 1000;
```

```sql
-- [batch] gallery_photo_remove
-- Draft galleries only (ADR 2.4). Then run media_purge_keys / media_purge_finish for claim ?4.
-- ?1 photo id | ?2 gallery id | ?3 now | ?4 new purge claim id (UUID)
UPDATE media_objects
SET purge_reason = 'admin_removed', purge_claim = ?4, purge_claimed_at = ?3
WHERE deleted_at IS NULL AND purge_claim IS NULL
  AND object_key IN (
    SELECT p.preview_key FROM gallery_photos AS p WHERE p.id = ?1 AND p.gallery_id = ?2
    UNION ALL
    SELECT p.thumb_key FROM gallery_photos AS p WHERE p.id = ?1 AND p.gallery_id = ?2
  )
  AND EXISTS (SELECT 1 FROM galleries WHERE id = ?2 AND status = 'draft');
DELETE FROM gallery_photos
WHERE id = ?1 AND gallery_id = ?2
  AND EXISTS (SELECT 1 FROM galleries WHERE id = ?2 AND status = 'draft');
```

```sql
-- [batch] gallery_open
-- Needs at least `quota` photos, otherwise "exactly the quota" (GAL-07) would be impossible.
-- ?1 gallery id | ?2 booking id | ?3 now | ?4 selection deadline | ?5 admin uid | ?6 customer email | ?7 rendered email
UPDATE galleries
SET status = 'open', opened_at = ?3, selection_deadline = ?4, updated_at = ?3
WHERE id = ?1 AND booking_id = ?2 AND status = 'draft' AND ?4 > ?3
  AND EXISTS (SELECT 1 FROM booking_requests WHERE id = ?2 AND status = 'confirmed')
  AND (SELECT COUNT(*) FROM gallery_photos WHERE gallery_id = galleries.id) >= quota;
INSERT INTO booking_events (booking_id, actor, actor_uid, event, subject_id, created_at)
VALUES (?2, 'admin', ?5, CASE WHEN changes() = 1 THEN 'gallery_opened' END, ?1, ?3);
INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, attempts, created_at, updated_at)
VALUES ('gallery_opened:' || ?2 || ':' || ?1, ?2, 'gallery_opened', ?6, ?7, 'pending', 0, ?3, ?3)
ON CONFLICT (dedupe_key) DO NOTHING;
```

```sql
-- [batch] gallery_extend_deadline
-- ?1 gallery id | ?2 booking id | ?3 now | ?4 deadline the admin saw | ?5 new deadline | ?6 admin uid
UPDATE galleries
SET selection_deadline = ?5, updated_at = ?3
WHERE id = ?1 AND booking_id = ?2 AND status = 'open' AND selection_deadline = ?4 AND ?5 > ?4 AND ?5 > ?3;
INSERT INTO booking_events (booking_id, actor, actor_uid, event, subject_id, details, created_at)
VALUES (?2, 'admin', ?6, CASE WHEN changes() = 1 THEN 'gallery_deadline_extended' END, ?1, json_object('from', ?4, 'to', ?5), ?3);
UPDATE notification_log
SET status = 'superseded', recipient = NULL, payload = NULL, finished_at = ?3, updated_at = ?3
WHERE booking_id = ?2 AND status = 'pending' AND kind IN ('selection_reminder_7d', 'selection_reminder_2d', 'selection_overdue');
```

```sql
-- [query] selection_select
-- One statement per op; D1 runs it atomically, so two tabs can never exceed the quota.
-- ?1 now | ?2 photo id | ?3 gallery id | ?4 booking id | ?5 caller uid
INSERT INTO gallery_selections (gallery_id, photo_id, is_selected, is_favourite, created_at, updated_at)
SELECT g.id, p.id, 1, 0, ?1, ?1
FROM galleries AS g
JOIN booking_requests AS b ON b.id = g.booking_id
JOIN gallery_photos AS p ON p.gallery_id = g.id AND p.id = ?2
WHERE g.id = ?3 AND b.id = ?4 AND b.user_id = ?5 AND b.status = 'confirmed' AND g.status = 'open'
  AND (SELECT COUNT(*) FROM gallery_selections AS s WHERE s.gallery_id = g.id AND s.is_selected = 1) < g.quota
ON CONFLICT (gallery_id, photo_id) DO UPDATE SET is_selected = 1, updated_at = excluded.updated_at
WHERE gallery_selections.is_selected = 0;
```

```sql
-- [query] selection_deselect
-- ?1 now | ?2 photo id | ?3 gallery id | ?4 booking id | ?5 caller uid
UPDATE gallery_selections
SET is_selected = 0, updated_at = ?1
WHERE gallery_id = ?3 AND photo_id = ?2 AND is_selected = 1
  AND EXISTS (
    SELECT 1 FROM galleries AS g JOIN booking_requests AS b ON b.id = g.booking_id
    WHERE g.id = ?3 AND g.status = 'open' AND b.id = ?4 AND b.user_id = ?5 AND b.status = 'confirmed'
  );
```

```sql
-- [query] selection_favourite
-- Favourites have no limit (08-copy-ar.md 5.1). ?1 now | ?2 photo id | ?3 gallery id | ?4 booking id | ?5 caller uid | ?6 value 0|1
INSERT INTO gallery_selections (gallery_id, photo_id, is_selected, is_favourite, created_at, updated_at)
SELECT g.id, p.id, 0, ?6, ?1, ?1
FROM galleries AS g
JOIN booking_requests AS b ON b.id = g.booking_id
JOIN gallery_photos AS p ON p.gallery_id = g.id AND p.id = ?2
WHERE g.id = ?3 AND b.id = ?4 AND b.user_id = ?5 AND b.status = 'confirmed' AND g.status = 'open'
ON CONFLICT (gallery_id, photo_id) DO UPDATE SET is_favourite = excluded.is_favourite, updated_at = excluded.updated_at
WHERE gallery_selections.is_favourite <> excluded.is_favourite;
```

```sql
-- [query] selection_counts
-- Authoritative counters returned after every op batch. ?1 gallery id
SELECT COALESCE(SUM(is_selected), 0) AS selected, COALESCE(SUM(is_favourite), 0) AS favourites
FROM gallery_selections
WHERE gallery_id = ?1;
```

```sql
-- [batch] gallery_submit
-- Exactly the quota (GAL-07). ?1 gallery id | ?2 booking id | ?3 caller uid | ?4 now
UPDATE galleries
SET status = 'locked', submitted_at = ?4, updated_at = ?4
WHERE id = ?1 AND booking_id = ?2 AND status = 'open'
  AND EXISTS (SELECT 1 FROM booking_requests WHERE id = ?2 AND user_id = ?3 AND status = 'confirmed')
  AND (SELECT COUNT(*) FROM gallery_selections WHERE gallery_id = galleries.id AND is_selected = 1) = quota;
INSERT INTO booking_events (booking_id, actor, event, subject_id, created_at)
VALUES (?2, 'customer', CASE WHEN changes() = 1 THEN 'gallery_submitted' END, ?1, ?4);
UPDATE notification_log
SET status = 'superseded', recipient = NULL, payload = NULL, finished_at = ?4, updated_at = ?4
WHERE booking_id = ?2 AND status = 'pending' AND kind IN ('selection_reminder_7d', 'selection_reminder_2d', 'selection_overdue');
```

```sql
-- [query] gallery_export
-- Admin only; filenames are never logged or put in URLs. ?1 gallery id
SELECT p.original_filename
FROM gallery_selections AS s
JOIN gallery_photos AS p ON p.gallery_id = s.gallery_id AND p.id = s.photo_id
WHERE s.gallery_id = ?1 AND s.is_selected = 1
ORDER BY p.sort_order, p.original_filename;
```
Reopening a locked gallery (GAL-11, LATER) is `UPDATE galleries SET status = 'open', submitted_at = NULL, selection_deadline = ?new … WHERE status = 'locked' AND NOT EXISTS (album_production row)`, followed by a `gallery_reopened` event with a required note. The CHECKs already allow it.

### 4.5 Album, handover, completion, feedback (W7-1, W8-1)
```sql
-- [batch] album_start
-- Allowed when the gallery is locked, purged or absent. ?1 booking id | ?2 admin uid | ?3 now
INSERT INTO album_production (booking_id, stage, created_at, updated_at)
SELECT b.id, 'design', ?3, ?3
FROM booking_requests AS b
WHERE b.id = ?1 AND b.status = 'confirmed'
  AND NOT EXISTS (SELECT 1 FROM galleries AS g WHERE g.booking_id = b.id AND g.status IN ('draft', 'open'))
ON CONFLICT (booking_id) DO NOTHING;
INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, created_at)
VALUES (?1, 'admin', ?2, CASE WHEN changes() = 1 THEN 'album_stage_changed' END, json_object('to', 'design'), ?3);
```

```sql
-- [batch] album_advance
-- Forward only. ?1 booking id | ?2 admin uid | ?3 now | ?4 current stage | ?5 next stage
-- ?6 customer email | ?7 rendered 'album ready' email (only used when ?5 = 'ready')
UPDATE album_production
SET stage = ?5, updated_at = ?3
WHERE booking_id = ?1 AND stage = ?4
  AND ((?4 = 'design' AND ?5 = 'printing') OR (?4 = 'printing' AND ?5 = 'ready'));
INSERT INTO booking_events (booking_id, actor, actor_uid, event, details, created_at)
VALUES (?1, 'admin', ?2, CASE WHEN changes() = 1 THEN 'album_stage_changed' END, json_object('from', ?4, 'to', ?5), ?3);
INSERT INTO notification_log (dedupe_key, booking_id, kind, recipient, payload, status, attempts, created_at, updated_at)
SELECT 'album_ready:' || ?1 || ':once', ?1, 'album_ready', ?6, ?7, 'pending', 0, ?3, ?3
WHERE ?5 = 'ready'
ON CONFLICT (dedupe_key) DO NOTHING;
```

```sql
-- [batch] handover_book
-- Capacity is enforced for any value inside the single INSERT; failure maps to SLOT_FULL.
-- ?1 booking id | ?2 caller uid | ?3 now | ?4 slot id | ?5 method | ?6 city | ?7 district | ?8 street and building | ?9 landmark
INSERT INTO handovers (booking_id, slot_id, method, delivery_city, delivery_district, delivery_street, delivery_landmark, status, created_at, updated_at)
SELECT b.id, s.id, ?5, ?6, ?7, ?8, ?9, 'scheduled', ?3, ?3
FROM booking_requests AS b
JOIN album_production AS a ON a.booking_id = b.id AND a.stage = 'ready'
JOIN handover_slots AS s ON s.id = ?4 AND s.is_active = 1 AND s.starts_at > ?3 AND s.method IN (?5, 'both')
WHERE b.id = ?1 AND b.user_id = ?2 AND b.status = 'confirmed'
  AND (SELECT COUNT(*) FROM handovers AS h WHERE h.slot_id = s.id AND h.status = 'scheduled') < s.capacity
ON CONFLICT (booking_id) DO NOTHING;
INSERT INTO booking_events (booking_id, actor, event, subject_id, created_at)
VALUES (?1, 'customer', CASE WHEN changes() = 1 THEN 'handover_booked' END, ?4, ?3);
```

```sql
-- [batch] handover_complete
-- Starts the retention clock (booking_requests.completed_at). ?1 booking id | ?2 admin uid | ?3 now
UPDATE handovers
SET status = 'completed', completed_at = ?3, updated_at = ?3
WHERE booking_id = ?1 AND status = 'scheduled';
INSERT INTO booking_events (booking_id, actor, actor_uid, event, created_at)
VALUES (?1, 'admin', ?2, CASE WHEN changes() = 1 THEN 'handover_completed' END, ?3);
UPDATE booking_requests
SET completed_at = ?3, updated_at = ?3
WHERE id = ?1 AND status = 'confirmed' AND completed_at IS NULL;
```

```sql
-- [batch] booking_complete
-- For a confirmed booking with nothing to hand over. ?1 booking id | ?2 admin uid | ?3 now | ?4 today (Riyadh)
UPDATE booking_requests
SET completed_at = ?3, updated_at = ?3
WHERE id = ?1 AND status = 'confirmed' AND completed_at IS NULL AND event_date <= ?4
  AND NOT EXISTS (SELECT 1 FROM handovers WHERE booking_id = ?1 AND status = 'scheduled');
INSERT INTO booking_events (booking_id, actor, actor_uid, event, created_at)
VALUES (?1, 'admin', ?2, CASE WHEN changes() = 1 THEN 'booking_completed' END, ?3);
```

```sql
-- [query] feedback_submit
-- One per booking (PK); 0 changes on a repeat = FEEDBACK_ALREADY_SUBMITTED.
-- ?1 booking id | ?2 caller uid | ?3 rating 1..5 | ?4 comment or NULL | ?5 now
INSERT INTO feedback (booking_id, rating, comment, created_at, updated_at)
SELECT b.id, ?3, ?4, ?5, ?5
FROM booking_requests AS b
WHERE b.id = ?1 AND b.user_id = ?2 AND b.completed_at IS NOT NULL
ON CONFLICT (booking_id) DO NOTHING;
```

### 4.6 Outbox drain (W3-3)
Dedupe keys follow `<kind>:<entityId>:<anchor>`, and the anchor is the deadline itself:
- `hold_reminder_24h`, `hold_reminder_6h` and `hold_expired` are anchored on `hold_expires_at`;
- `event_reminder_*` on `event_date`;
- `selection_*` on `selection_deadline`;
- `handover_reminder_1d` on the slot's `starts_at`;
- `feedback_request` on `completed_at`;
- `album_ready` on `:once`;
- `receipt_*` on the receipt id.

The longest key is about 90 characters, within Resend's 256 (`email.ts:9`).
```sql
-- [batch] outbox_claim
-- ?1 now | ?2 max rows (40) | ?3 stale-claim cutoff (now - 30 min) | ?4 idempotency horizon (now - 24 h, Resend's window)
UPDATE notification_log
SET status = 'failed', recipient = NULL, payload = NULL, finished_at = ?1, updated_at = ?1, last_error_code = 'GAVE_UP'
WHERE (status = 'pending' AND (attempts >= 3 OR created_at <= ?4))
   OR (status = 'sending' AND claimed_at <= ?3 AND (attempts >= 3 OR created_at <= ?4));
UPDATE notification_log
SET status = 'sending', claimed_at = ?1, attempts = attempts + 1, updated_at = ?1
WHERE dedupe_key IN (
  SELECT dedupe_key FROM notification_log
  WHERE status = 'pending' OR (status = 'sending' AND claimed_at <= ?3)
  ORDER BY created_at
  LIMIT ?2
);
SELECT dedupe_key, recipient, payload FROM notification_log WHERE status = 'sending' AND claimed_at = ?1 ORDER BY created_at;
```

```sql
-- [query] outbox_finish
-- One statement per claimed row. ?1 dedupe key | ?2 now | ?3 outcome: 'sent' | 'retry' | 'skipped' | 'failed'
-- ?4 provider message id or NULL | ?5 fixed error code or NULL
UPDATE notification_log
SET status = CASE WHEN ?3 = 'retry' AND attempts < 3 THEN 'pending' WHEN ?3 = 'retry' THEN 'failed' ELSE ?3 END,
    recipient = CASE WHEN ?3 = 'retry' AND attempts < 3 THEN recipient END,
    payload = CASE WHEN ?3 = 'retry' AND attempts < 3 THEN payload END,
    finished_at = CASE WHEN ?3 = 'retry' AND attempts < 3 THEN NULL ELSE ?2 END,
    provider_message_id = ?4, last_error_code = ?5, updated_at = ?2
WHERE dedupe_key = ?1 AND status = 'sending';
```

---

## 5. Query patterns and indexes

### 5.1 Index list: every index and the named query it serves
| Index | Serves |
|---|---|
| `ux_booking_receipts_one_pending` (partial unique on `booking_id WHERE status = 'pending'`) | **Correctness:** at most one pending receipt. It also scans only pending rows for `queue_receipts_waiting`. |
| `UNIQUE (booking_id, attempt_no)` on receipts | "Latest receipt" in `receipt_resubmit`, `hold_extend`, `hold_expiry`, `journey_loader`, the `MAX(attempt_no)` in inserts, and foreign-key child lookups on booking deletion |
| `UNIQUE (object_key)` on receipts; `UNIQUE (preview_key)`, `UNIQUE (thumb_key)` on photos | 1:1 object integrity, and the `SET NULL` child lookup when `retention_prune` deletes register rows |
| `idx_booking_events_booking (booking_id, id)` | The admin timeline (`WHERE booking_id = ? ORDER BY id`), and the cascade on booking deletion |
| `idx_notification_log_status_created (status, created_at)` | `outbox_claim` every 15 minutes (`status = 'pending' ORDER BY created_at`), the stale `sending` reclaim, `queue_email_problems` |
| `galleries UNIQUE (booking_id)` | 1:1 rule, `gallery_create` conflict target, the `journey_loader` join |
| `idx_galleries_open_deadline` (partial, `status = 'open'`) | `due_selection_reminders` every 15 minutes and `queue_selections_overdue`, which read only open galleries instead of every historical one |
| `gallery_photos UNIQUE (gallery_id, original_filename)` | Idempotent upload and resume, listing a gallery's photos (leading column), the cascade from `galleries` |
| `gallery_photos UNIQUE (gallery_id, id)` | Required parent key for the composite foreign key from `gallery_selections` |
| `gallery_selections` PK (`gallery_id`, `photo_id`) | Upsert conflict target, the cascade from photos |
| `idx_gallery_selections_selected` (partial, `is_selected = 1`) | The quota count in `selection_select` and `gallery_submit`, the hot path. It counts at most the quota's rows instead of every row in the gallery. |
| `handover_slots UNIQUE (starts_at, method)` | Double-submit of "add slot". Its leading column serves the range scans in the slot picker, `queue_handovers_soon` and `due_handover_reminders`. |
| `idx_handovers_slot_scheduled` (partial, `status = 'scheduled'`) | The capacity count in `handover_book`, and the join in the handover queue and reminders |
| `idx_media_objects_booking (booking_id)` | The `ON DELETE SET NULL` action on booking deletion, the DSR access and erasure lookups, `retention_generic_claim` for detached rows |
| existing `idx_booking_requests_user_id` | `journey_loader` (`WHERE user_id = ?`) |
| existing `idx_booking_requests_status` | `hold_expiry`, `due_hold_reminders`, `queue_requests_past_sla`, `queue_holds_expiring` |
| existing `idx_booking_requests_event_date` | `due_event_reminders`, the targeted sweep in approve |

### 5.2 Indexes deliberately not added
- The ADR's `(flow_version, status, hold_expires_at)`: see §3.5 item 1.
- `notification_log(booking_id)`: only needed by a rare booking deletion and by the admin detail view, which scans a few thousand rows at most.
- `media_objects(purge_claim)` and `(expires_at)`: the daily job scans a table that is at most about 100k rows. **Add a partial index on `expires_at WHERE deleted_at IS NULL` only if the register exceeds about 1M rows.**
- `booking_requests(completed_at)`: `due_feedback_requests` scans at most a few thousand rows 48 times a day.
- `gallery_photos(gallery_id, sort_order)`: sorting at most 1,000 rows in memory is cheaper than maintaining the index.

### 5.3 Read queries
```sql
-- [query] journey_loader
-- Everything deriveJourneyStage (shared/journey.ts) needs, in one round trip. ?1 caller uid | ?2 max rows (50)
SELECT
  b.id, b.event_date, b.status, b.flow_version, b.hold_expires_at, b.deposit_amount,
  b.confirmed_at, b.completed_at, b.created_at, b.updated_at, b.package_snapshot, b.estimated_total,
  lr.status AS latest_receipt_status, lr.rejection_reason AS latest_receipt_rejection_reason,
  (ep.booking_id IS NOT NULL) AS has_event_profile,
  g.id AS gallery_id, g.status AS gallery_status, g.selection_deadline, g.purged_at AS gallery_purged_at,
  ap.stage AS album_stage,
  h.status AS handover_status, h.method AS handover_method, s.starts_at AS handover_starts_at, s.ends_at AS handover_ends_at,
  (fb.booking_id IS NOT NULL) AS has_feedback
FROM booking_requests AS b
LEFT JOIN booking_receipts AS lr
  ON lr.booking_id = b.id
 AND lr.attempt_no = (SELECT MAX(r.attempt_no) FROM booking_receipts AS r WHERE r.booking_id = b.id)
LEFT JOIN event_profiles AS ep ON ep.booking_id = b.id
LEFT JOIN galleries AS g ON g.booking_id = b.id
LEFT JOIN album_production AS ap ON ap.booking_id = b.id
LEFT JOIN handovers AS h ON h.booking_id = b.id
LEFT JOIN handover_slots AS s ON s.id = h.slot_id
LEFT JOIN feedback AS fb ON fb.booking_id = b.id
WHERE b.user_id = ?1
ORDER BY datetime(b.created_at) DESC, b.created_at DESC, b.id DESC
LIMIT ?2;
```

```sql
-- [query] queue_requests_past_sla
-- ?1 now - 24 h (legacy column: compare through datetime())
SELECT id, event_date, created_at
FROM booking_requests
WHERE status = 'pending_review' AND datetime(created_at) <= datetime(?1)
ORDER BY datetime(created_at);
```

```sql
-- [query] queue_receipts_waiting
SELECT r.booking_id, r.id AS receipt_id, r.attempt_no, r.created_at
FROM booking_receipts AS r
JOIN booking_requests AS b ON b.id = r.booking_id
WHERE r.status = 'pending' AND b.status = 'payment_pending'
ORDER BY r.created_at;
```

```sql
-- [query] queue_holds_expiring
-- Customers who still owe a receipt, deadline within 24 h. ?1 now | ?2 now + 24 h
SELECT b.id, b.event_date, b.status, b.hold_expires_at
FROM booking_requests AS b
WHERE b.flow_version = 2 AND b.hold_expires_at > ?1 AND b.hold_expires_at <= ?2
  AND (
    b.status = 'approved_hold'
    OR (
      b.status = 'payment_pending'
      AND (SELECT r.status FROM booking_receipts AS r WHERE r.booking_id = b.id ORDER BY r.attempt_no DESC LIMIT 1) = 'rejected'
    )
  )
ORDER BY b.hold_expires_at;
```

```sql
-- [query] queue_selections_overdue
-- ?1 now
SELECT id, booking_id, selection_deadline
FROM galleries
WHERE status = 'open' AND selection_deadline <= ?1
ORDER BY selection_deadline;
```

```sql
-- [query] queue_handovers_soon
-- ?1 start of today in Riyadh as a UTC instant | ?2 start of the day after tomorrow in Riyadh as a UTC instant
SELECT h.booking_id, h.method, s.starts_at, s.ends_at
FROM handover_slots AS s
JOIN handovers AS h ON h.slot_id = s.id AND h.status = 'scheduled'
WHERE s.starts_at >= ?1 AND s.starts_at < ?2
ORDER BY s.starts_at;
```

```sql
-- [query] queue_email_problems
-- ?1 now - 7 days
SELECT kind, status, COUNT(*) AS n
FROM notification_log
WHERE status IN ('skipped', 'failed') AND created_at >= ?1
GROUP BY kind, status;
```

```sql
-- [query] due_event_reminders
-- ?1 Riyadh today + 7 days | ?2 Riyadh today + 1 day (YYYY-MM-DD)
SELECT id, event_date FROM booking_requests WHERE status = 'confirmed' AND event_date IN (?1, ?2);
```

```sql
-- [query] due_selection_reminders
-- ?1 now + 7 days
SELECT id, booking_id, selection_deadline FROM galleries WHERE status = 'open' AND selection_deadline <= ?1;
```

```sql
-- [query] due_feedback_requests
-- ?1 now - 2 days | ?2 now - 9 days (late sends inside the window are still relevant, older ones are superseded)
SELECT b.id, b.completed_at
FROM booking_requests AS b
WHERE b.completed_at IS NOT NULL AND b.completed_at <= ?1 AND b.completed_at > ?2
  AND NOT EXISTS (SELECT 1 FROM feedback AS f WHERE f.booking_id = b.id);
```
The cron heartbeat is read with `SELECT job, last_ok_at, last_status, last_error_code FROM job_runs`, which is a primary-key scan over a handful of rows. Hold reminders reuse the `queue_holds_expiring` predicate. The job picks the 24 h or 6 h reminder from the time left and inserts it with `ON CONFLICT (dedupe_key) DO NOTHING`.

---

## 6. PDPL: retention, deletion and R2 tracking

> None of the periods or legal bases below is a legal conclusion. They are **proposed defaults** in the absence of a compliance review. Verify the current PDPL, its Implementing Regulations and the SDAIA transfer rules with a licensed advisor, then change the constants in `shared/retention.ts` (W8-2). The schema does not depend on any specific number.

### 6.1 Inventory and minimisation
- **Collected, and why it is needed:**
  - Name, email and phone, to contact her.
  - Event date and package, which make up the contract.
  - Deposit receipt, the proof of payment.
  - Venue, start time and requests, to cover the day.
  - Delivery address, only if she chooses delivery.
  - Her photo selections, to design the album.
  - Feedback, which is voluntary.
- **Deliberately not collected:** national ID or Iqama, date of birth, the groom's or guests' names, IP addresses, user agents, geolocation, bank account numbers typed into a form (only the receipt image, which is deleted on schedule), card data, original photos, EXIF/GPS (stripped by browser re-encoding, ADR §2.3), and face data.
- **Special-category risk:**
  - Photos of the bride and guests, possibly including children.
  - Financial receipts.
  - Free text that could reveal health information.

  All three are raised as U-4 and U-5. The questionnaire UI should say «لا حاجة لذكر أي معلومات صحية أو شخصية حساسة هنا».

### 6.2 Retention table
| Table | Personal-data columns | Proposed legal basis (verify) | Proposed max retention | Deletion mechanism |
|---|---|---|---|---|
| `users` | `id` (Firebase uid), `email`, `first_name`, `last_name`, `phone` | Necessary for the booking agreement she requests | Without bookings: 12 months after the last profile update. With bookings: the booking-record period (U-3). | `retention_prune` hard-deletes profiles with no bookings. The DSR procedure (§6.5) deletes or pseudonymises. The Firebase account is deleted by the owner in the console. |
| `booking_requests` | `user_id` (with the date), `admin_notes` (free text) | Agreement; bookkeeping duty if it applies (U-3) | Row: **the period is to be set by the accountant or compliance. No automatic deletion until then.** `admin_notes`: NULL 90 days after completion or a terminal status. | `retention_text_purges` (notes); §6.5 erasure |
| `booking_status_history` (existing) | `changed_by`, `note` | Agreement / audit | Same as its booking | Cascade. `note` is NULLed on pseudonymisation. |
| `blocked_dates` (existing) | `created_by` (admin uid), `reason` (free text) | Legitimate interest (scheduling) | 12 months after the date | `retention_prune` |
| `booking_events` | `actor_uid` (admin), `note`, and the link to her booking | Legitimate interest (audit); proof of consent | Same as its booking | Cascade. `note` is NULLed and `redacted_at` set on pseudonymisation. |
| `notification_log` | `recipient`, `payload` | Agreement (service messages) | Recipient and payload are NULL once sending ends (**enforced by a CHECK**). Rows are deleted after 180 days. | `outbox_finish`, `retention_prune` |
| `media_objects` + R2 `r/` | the receipt image (financial data) | Agreement; bookkeeping duty if it applies (U-3) | Image: 90 days after `event_date` (verified); 30 days after rejection or void; 30 days after the booking becomes cancelled, expired or rejected; **hard ceiling 730 days**. R2 lifecycle backstop: 740 days on `r/`. | `retention_receipt_claim` → `media_purge_*` |
| `booking_receipts` | `rejection_reason` | Agreement | NULLed when the image is purged. The row is kept with the booking (status and dates only). | `media_purge_finish` |
| `media_objects` + R2 `g/` | previews and thumbnails (bride and guests) | The bride's agreement; guests: U-5 | 30 days after completion (D5); 30 days after a terminal status; **hard ceiling 180 days after upload**. R2 lifecycle backstop: 190 days on `g/`. | `retention_gallery_*` → `media_purge_*` |
| `gallery_photos`, `gallery_selections` | `original_filename`, her selections | Agreement | Deleted when the gallery is purged | `retention_gallery_purge` (cascade) |
| `event_profiles` | `venue_name`, `venue_area`, `event_start_time`, `special_requests` | Agreement | NULL 90 days after `event_date`, or 30 days after a terminal status. The row stays as a marker. | `retention_text_purges` |
| `booking_consents` | granted, version, time | Consent: explicit and revocable. The row is the proof. | Same as its booking (U-3) | Cascade |
| `handovers` | `delivery_city`, `delivery_district`, `delivery_street`, `delivery_landmark` | Agreement | NULL 30 days after completion, no-show or cancellation | `retention_text_purges` |
| `feedback` | `rating`, `comment` | Consent (voluntary) | 12 months after submission | `retention_prune` |
| `galleries`, `album_production`, `handover_slots`, `job_runs`, vocabularies, `d1_migrations` | none | — | Kept with the booking or indefinitely. Slots in the past with no handover can be pruned after 90 days. | cascade / housekeeping |

**Outside D1, and to be disclosed in the privacy notice (U-13):**
- D1 Time Travel keeps prior states for 7 days on Free and 30 days on Paid, so a deleted row is only truly gone after that.
- R2 has no object versioning, so a delete is final.
- Resend and Firebase keep their own records in the US (ADR §2.7).
- Any `wrangler d1 export` file is personal data and must be deleted after use.

### 6.3 How R2 objects are tracked for deletion (`media_objects`)
1. **Upload.**
   - The Worker checks the magic bytes and puts the object under a key derived from ids.
   - The register row is inserted **in the same batch** as its business row, with `expires_at` = the hard ceiling.
   - If the batch fails, the Worker deletes the object at once.
   - If the Worker dies between the put and the batch, the object has no register row. The weekly orphan sweep catches it: it lists `r/` and `g/`, and deletes keys older than 24 h that are not in `media_objects`, looked up in chunks of ≤ 100 keys to respect D1's parameter limit.
2. **Policy.** The daily job **computes** what is due from the business tables (§6.4), so a policy change applies retroactively. It never depends on some earlier action having remembered to schedule the deletion.
3. **Claim → delete → stamp.**
   - Due objects are claimed with a claim UUID.
   - Their keys are read (≤ 1,000, the R2 `delete()` limit) and deleted with one `MEDIA.delete(keys)` call.
   - They are stamped `deleted_at`. The receipt rows are stamped `purged_at` in the same batch.
   - A claim left behind by a crash is re-claimed after 1 hour. Deleting a key that no longer exists is a no-op, so every step can be repeated safely.
4. **Booking deletion.** `ON DELETE SET NULL` detaches the register rows, and the next run purges them with reason `detached`. **No path can delete a booking and lose track of its objects.**
5. **Prune.** Register rows are deleted 30 days after `deleted_at`. The business rows keep `purged_at` or `galleries.status = 'purged'` as the lasting proof, and the customer view reads it to show «حُذفت معاينات صوركِ تلقائيًا في {التاريخ} حفاظًا على خصوصيتكِ.» (ADR W8-2).

### 6.4 Retention job SQL (W8-2, daily at `0 0` UTC, bounded, resumable)
Run in this order: `retention_gallery_candidates` → `retention_gallery_purge` for each candidate → `retention_receipt_claim` → `retention_generic_claim` → `media_purge_keys` / R2 delete / `media_purge_finish` for each claim → `retention_text_purges` → `retention_prune`.
```sql
-- [query] retention_gallery_candidates
-- ?1 completed-before (now - 30 d) | ?2 terminal-before (now - 30 d) | ?3 now | ?4 max galleries per run (5)
SELECT g.id AS gallery_id, g.booking_id
FROM galleries AS g
JOIN booking_requests AS b ON b.id = g.booking_id
WHERE g.status <> 'purged'
  AND (
    (b.completed_at IS NOT NULL AND b.completed_at <= ?1)
    OR (
      b.status IN ('cancelled', 'expired', 'rejected')
      AND (SELECT MAX(datetime(h.created_at)) FROM booking_status_history AS h WHERE h.booking_id = b.id) <= datetime(?2)
    )
    OR EXISTS (
      SELECT 1 FROM gallery_photos AS p JOIN media_objects AS m ON m.object_key = p.preview_key
      WHERE p.gallery_id = g.id AND m.expires_at <= ?3
    )
  )
ORDER BY g.created_at
LIMIT ?4;
```

```sql
-- [batch] retention_gallery_purge
-- One batch per gallery. ?1 gallery id | ?2 now | ?3 purge claim id
UPDATE media_objects
SET purge_reason = 'retention_policy', purge_claim = ?3, purge_claimed_at = ?2
WHERE deleted_at IS NULL AND purge_claim IS NULL
  AND object_key IN (
    SELECT p.preview_key FROM gallery_photos AS p WHERE p.gallery_id = ?1 AND p.preview_key IS NOT NULL
    UNION ALL
    SELECT p.thumb_key FROM gallery_photos AS p WHERE p.gallery_id = ?1 AND p.thumb_key IS NOT NULL
  );
DELETE FROM gallery_photos WHERE gallery_id = ?1;
UPDATE galleries SET status = 'purged', purged_at = ?2, updated_at = ?2 WHERE id = ?1 AND status <> 'purged';
INSERT INTO booking_events (booking_id, actor, event, subject_id, created_at)
SELECT g.booking_id, 'system', CASE WHEN changes() = 1 THEN 'gallery_purged' END, g.id, ?2
FROM galleries AS g
WHERE g.id = ?1;
```

```sql
-- [query] retention_receipt_claim
-- ?1 now | ?2 purge claim id | ?3 event-date cutoff (Riyadh today - 90 d, YYYY-MM-DD)
-- ?4 reviewed-before (now - 30 d) | ?5 terminal-before (now - 30 d) | ?6 max rows (500)
UPDATE media_objects
SET purge_reason = 'retention_policy', purge_claim = ?2, purge_claimed_at = ?1
WHERE object_key IN (
  SELECT r.object_key
  FROM booking_receipts AS r
  JOIN booking_requests AS b ON b.id = r.booking_id
  JOIN media_objects AS m ON m.object_key = r.object_key
  WHERE r.purged_at IS NULL AND m.deleted_at IS NULL AND m.purge_claim IS NULL
    AND (
      (r.status = 'verified' AND b.status = 'confirmed' AND b.event_date <= ?3)
      OR (r.status IN ('rejected', 'void') AND r.reviewed_at <= ?4)
      OR (
        b.status IN ('cancelled', 'expired', 'rejected')
        AND (SELECT MAX(datetime(h.created_at)) FROM booking_status_history AS h WHERE h.booking_id = b.id) <= datetime(?5)
      )
    )
  LIMIT ?6
);
```

```sql
-- [query] retention_generic_claim
-- Hard ceiling, detached objects (booking deleted) and stale claims. ?1 now | ?2 purge claim id | ?3 stale cutoff (now - 1 h) | ?4 max rows (1000)
UPDATE media_objects
SET purge_reason = COALESCE(purge_reason, CASE WHEN booking_id IS NULL THEN 'detached' ELSE 'ceiling' END),
    purge_claim = ?2, purge_claimed_at = ?1
WHERE object_key IN (
  SELECT m.object_key FROM media_objects AS m
  WHERE m.deleted_at IS NULL
    AND (
      (m.purge_claim IS NULL AND (m.expires_at <= ?1 OR m.booking_id IS NULL))
      OR (m.purge_claim IS NOT NULL AND m.purge_claimed_at <= ?3)
    )
  LIMIT ?4
);
```

```sql
-- [query] media_purge_keys
-- Keys for one MEDIA.delete(keys) call (R2 allows up to 1000). ?1 purge claim id
SELECT object_key FROM media_objects WHERE purge_claim = ?1 AND deleted_at IS NULL LIMIT 1000;
```

```sql
-- [batch] media_purge_finish
-- Only after MEDIA.delete(keys) resolved. ?1 purge claim id | ?2 now
UPDATE booking_receipts
SET purged_at = ?2, rejection_reason = NULL, updated_at = ?2
WHERE purged_at IS NULL AND status <> 'pending'
  AND object_key IN (SELECT object_key FROM media_objects WHERE purge_claim = ?1 AND deleted_at IS NULL);
UPDATE media_objects SET deleted_at = ?2 WHERE purge_claim = ?1 AND deleted_at IS NULL;
```

```sql
-- [batch] retention_text_purges
-- ?1 now | ?2 event-date cutoff for questionnaire text (Riyadh today - 90 d) | ?3 terminal-before (now - 30 d)
-- ?4 address cutoff (now - 30 d) | ?5 admin-notes cutoff (now - 90 d)
UPDATE event_profiles
SET venue_name = NULL, venue_area = NULL, event_start_time = NULL, special_requests = NULL,
    text_purged_at = ?1, updated_at = ?1
WHERE text_purged_at IS NULL
  AND booking_id IN (
    SELECT b.id FROM booking_requests AS b
    WHERE b.event_date <= ?2
       OR (
         b.status IN ('cancelled', 'expired', 'rejected')
         AND (SELECT MAX(datetime(h.created_at)) FROM booking_status_history AS h WHERE h.booking_id = b.id) <= datetime(?3)
       )
  );
UPDATE handovers
SET delivery_city = NULL, delivery_district = NULL, delivery_street = NULL, delivery_landmark = NULL,
    address_purged_at = ?1, updated_at = ?1
WHERE address_purged_at IS NULL AND method = 'delivery'
  AND ((status = 'completed' AND completed_at <= ?4) OR (status IN ('cancelled', 'no_show') AND updated_at <= ?4));
UPDATE booking_requests
SET admin_notes = NULL, updated_at = ?1
WHERE admin_notes IS NOT NULL
  AND (
    (completed_at IS NOT NULL AND completed_at <= ?5)
    OR (
      status IN ('cancelled', 'expired', 'rejected')
      AND (SELECT MAX(datetime(h.created_at)) FROM booking_status_history AS h WHERE h.booking_id = booking_requests.id) <= datetime(?5)
    )
  );
```

```sql
-- [batch] retention_prune
-- ?1 feedback-before (now - 365 d) | ?2 outbox-before (now - 180 d) | ?3 register-before (now - 30 d)
-- ?4 blocked-dates cutoff (Riyadh today - 365 d) | ?5 profile-before (now - 365 d) | ?6 slot-before (now - 90 d)
DELETE FROM feedback WHERE created_at <= ?1;
DELETE FROM notification_log WHERE created_at <= ?2 AND status NOT IN ('pending', 'sending');
DELETE FROM media_objects WHERE deleted_at IS NOT NULL AND deleted_at <= ?3;
DELETE FROM blocked_dates WHERE event_date < ?4;
DELETE FROM users
WHERE role = 'customer' AND erased_at IS NULL
  AND datetime(updated_at) <= datetime(?5)
  AND NOT EXISTS (SELECT 1 FROM booking_requests AS b WHERE b.user_id = users.id);
DELETE FROM handover_slots
WHERE ends_at <= ?6 AND NOT EXISTS (SELECT 1 FROM handovers AS h WHERE h.slot_id = handover_slots.id);
```

### 6.5 Data-subject requests (no self-service; the owner approves, devops-engineer runs)
- **Access.** Run read-only `SELECT`s filtered by her uid: her profile, bookings, questionnaire, consents, handover, feedback, and receipt and gallery status. Deliver images through short-lived signed links.
- **Erasure, when no retention duty applies** to her bookings (compliance or the accountant confirms):

```sql
-- [dsr] erase_customer_full
-- Children cascade; media_objects rows detach (SET NULL) and the next retention_generic_claim purges the R2 objects.
-- Then delete her Firebase account in the console. ?1 customer uid
DELETE FROM booking_requests WHERE user_id = ?1;
DELETE FROM users WHERE id = ?1 AND role = 'customer';
```
- **Pseudonymisation, when booking records must be kept.** Free text and media go, the financial facts stay, and the identity is replaced:

```sql
-- [dsr] pseudonymise_customer
-- ?1 customer uid | ?2 now | ?3 purge claim id | ?4 admin uid. Works on schema variants A and B (nulls columns explicitly).
UPDATE media_objects
SET purge_reason = 'erasure_request', purge_claim = ?3, purge_claimed_at = ?2
WHERE deleted_at IS NULL AND purge_claim IS NULL
  AND booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
DELETE FROM gallery_photos
WHERE gallery_id IN (SELECT g.id FROM galleries AS g JOIN booking_requests AS b ON b.id = g.booking_id WHERE b.user_id = ?1);
UPDATE galleries
SET status = 'purged', purged_at = COALESCE(purged_at, ?2), updated_at = ?2
WHERE status <> 'purged' AND booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
UPDATE event_profiles
SET venue_name = NULL, venue_area = NULL, event_start_time = NULL, special_requests = NULL,
    text_purged_at = COALESCE(text_purged_at, ?2), updated_at = ?2
WHERE booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
UPDATE handovers
SET delivery_city = NULL, delivery_district = NULL, delivery_street = NULL, delivery_landmark = NULL,
    address_purged_at = COALESCE(address_purged_at, ?2), updated_at = ?2
WHERE booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
DELETE FROM feedback WHERE booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
DELETE FROM notification_log WHERE booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
UPDATE booking_receipts
SET rejection_reason = NULL, updated_at = ?2
WHERE rejection_reason IS NOT NULL AND booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
UPDATE booking_events
SET note = NULL, redacted_at = ?2
WHERE note IS NOT NULL AND booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
UPDATE booking_status_history
SET note = NULL
WHERE note IS NOT NULL AND booking_id IN (SELECT id FROM booking_requests WHERE user_id = ?1);
UPDATE booking_requests SET admin_notes = NULL, updated_at = ?2 WHERE user_id = ?1;
UPDATE users
SET email = 'erased+' || id || '@erased.invalid', first_name = '-', last_name = '-', phone = '-',
    erased_at = ?2, updated_at = ?2
WHERE id = ?1 AND role = 'customer';
INSERT INTO booking_events (booking_id, actor, actor_uid, event, created_at)
SELECT b.id, 'admin', ?4, 'personal_data_erased', ?2 FROM booking_requests AS b WHERE b.user_id = ?1;
```
After that, run `media_purge_keys` / `media_purge_finish` for claim `?3`, and delete her Firebase account. The Firebase uid stays on the retained rows as a pseudonymous key; whether that is enough is U-14. Consents stay as proof.

### 6.6 What never goes into D1
- Secrets: `RESEND_API_KEY`, `MEDIA_SIGNING_KEY`, `DEPOSIT_*`.
- Signed media URLs, Firebase ID or refresh tokens.
- IP addresses, user agents.
- Original filenames inside keys.
- Bank account numbers typed as text.
- Card data.

`notification_log.payload` holds only what the customer is shown, never a token or a signed URL, because emails deep-link to `/my-bookings`, which requires sign-in. Logs follow the fixed-code pattern (`bookings.ts:433`).

### 6.7 Arabic text, phone numbers and dates
- **Collation (a platform deviation).**
  - D1 cannot load ICU, and SQLite core has no Arabic collation. So nothing in this design sorts, groups or compares Arabic text in SQL: every lookup is by id or date.
  - Lists that need Arabic ordering sort in the Worker or SPA with `Intl.Collator('ar')`.
  - Text is stored as UTF-8 and NFC-normalised when written (§4.0).
- **Bilingual search: no column needs it now**, because the UI is Arabic-only (spec §11). If admin search by customer name is added later, use an FTS5 table fed with text normalised in the Worker: tashkeel and tatweel removed, alef forms unified. Don't use LIKE.
- **Phone numbers** stay E.164, normalised when written (`profile.ts:93-131`). No new phone column is added: delivery uses her profile phone.
- **National ID**: not collected, and must not be added.
- **Times**: UTC instants, Riyadh calendar dates, `HH:MM` Riyadh times of day. Hijri is display only.

### 6.8 Isolation statement (for the security-auditor)
This is a single-business system, not multi-tenant. **Isolation between customers is enforced only in the application layer.** Every customer statement above binds the caller's uid and filters on `booking_requests.user_id` **inside the same SQL statement** (never in an earlier read). The media Worker mints signed URLs only after that check. D1 has no row-level security. This is a launch risk that security-auditor must review in W4-5 and W6-4. The proposed review aid: every customer-facing SQL constant lives in `worker/portal/*.ts` with a `?2`/`?4`/`?5` "caller uid" parameter, and can be found with a grep.

---

## 7. D1 and R2 limits to respect
Values are from Cloudflare's published limits as best known today. **Verify them on the D1 and R2 limits pages before Run 3.**

| Limit | Value | Where it bites here | How the design respects it |
|---|---|---|---|
| Bound parameters per statement | 100 | Bulk deletes, orphan checks | Claim-token pattern (3 statements per 1,000 keys). Orphan lookups in chunks of ≤ 100. The largest statement binds 12. |
| LIKE/GLOB pattern length | 50 bytes | CHECK constraints | The longest new pattern is 21 bytes. ISO instants are checked with `strftime`, not a 90-byte GLOB. |
| Queries per Worker invocation | 50 (Free) / 1,000 (Paid) | Selection batches, cron ticks | Treat every statement in a batch as one query (verify). With Workers Paid (U-16) the ADR caps hold: selection ops ≤ 50 per request, expiry ≤ 50 per tick. On Free: ≤ 20 of each. |
| Statement length | 100 KB | Migration 0005 | The largest statement is under 5 KB. The file applies atomically. |
| Row / string size | 2 MB | Outbox payload | `payload` ≤ 100,000 characters by CHECK |
| Query duration | 30 s | Retention, erasure | Bounded batches (5 galleries, 500–1,000 keys). Every predicate is indexed or runs on a small table. |
| Database size | 500 MB (Free) / 10 GB (Paid) | — | Metadata only. Binaries live in R2 (ADR §3). |
| Rows read / written | Free 5M read and 100k written per day; Paid 25B read and 50M written per month | Uploading 400 photos is about 3,000 row writes including indexes | Well inside both tiers |
| Time Travel | 7 days (Free) / 30 days (Paid) | Deleted data lingers | Disclosed (U-13). Also the rollback of last resort (§8). |
| Single writer per database | writes are serialised | Capacity and quota predicates | These rely on it, as the existing booking insert does. Keep D1 read replication **off**, or read with the primary session. |
| R2 `delete()` | up to 1,000 keys per call | Purge | `media_purge_keys` has `LIMIT 1000` |
| R2 `list()` | 1,000 per page | Orphan sweep | Paged |
| R2 versioning | none | — | A delete is final. The register row keeps the proof. |
| D1 features | no ICU or extensions; FTS5 and JSON available; foreign keys always enforced | — | §6.7. Foreign-key cascades are designed in (§3.3). |

---

## 8. Migration plan (expand → verify → no contract step needed)
Every step is additive. No old structure is replaced, so no dual-write or contract phase is needed. Legacy statuses and columns stay: they are still in use (D2).

| # | Step | Who | Rollback (tested in §9 where it is SQL) |
|---|---|---|---|
| 0 | Run the read-only state check (§2.3), record the Time Travel bookmark, classify the state (§2.4) | owner | none needed |
| 1 | Git-ignore `.wrangler/`, `.dev.vars*` and `.env*` (defect #10). Commit the removal of `0002` (§2.2). Run the local matrix (§2.6). | W3-1 | `git revert` restores the file. It never reached any database. |
| 2 | S3 only: baseline B1 and B2 (§2.5) | devops-engineer, owner approves | `[baseline] undo_mark_0001` |
| 3 | `npx wrangler d1 migrations apply sundus-yar-bookings --remote` applies `0003`/`0004` (S1, S2b, S3) | devops-engineer | `0003` is a no-op. `0004` is a constraint-only index: drop it (`DROP INDEX IF EXISTS idx_booking_requests_user_event_date_open`) with a forward migration if ever needed, or Time Travel back to the bookmark. |
| 4 | Merge `0005` (§3.6) after it passes the local matrix. Take a new bookmark. Apply it remotely **while the old Worker is live**. It is compatible: new columns have defaults or are nullable, and new tables are unused. | W3-2 → devops-engineer | `0006_revert_0005_portal_schema.sql` below. It is valid only before any portal data exists, and it refuses otherwise. After that point, fix forward only, or Time Travel as a last resort, which loses every later write. |
| 5 | Deploy the Worker code that reads and writes the new structures, with `ONLINE_CONFIRMATION = "off"` and features dark | W3-3… | `wrangler rollback`. The schema stays because it is backward compatible. |
| 6 | Turn features on in order (Runs 4–8 go-live gates, ADR §4.5) | owner | switch off (new approvals return to flow 1) |
| 7 | Future contract step: **none planned.** Retiring `contract_pending`/`contract_signed` would need a rebuild of `booking_requests` and `booking_status_history`, which would be its own expand-contract project once no row uses them. | — | — |

```sql
-- [file] 0006_revert_0005_portal_schema.sql
-- DESTRUCTIVE. Human-run only (devops-engineer, owner approval, fresh bookmark first). Never run by an agent.
-- Valid only while the portal has never been used. Apply as a forward migration so D1 runs it atomically.
-- Guard: if any portal data exists, this INSERT hits NOT NULL on booking_status_history and the whole file rolls back.
INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
SELECT NULL, NULL, NULL, NULL, 'rollback-guard', NULL
WHERE EXISTS (SELECT 1 FROM booking_events)
   OR EXISTS (SELECT 1 FROM notification_log)
   OR EXISTS (SELECT 1 FROM media_objects)
   OR EXISTS (SELECT 1 FROM booking_receipts)
   OR EXISTS (SELECT 1 FROM event_profiles)
   OR EXISTS (SELECT 1 FROM booking_consents)
   OR EXISTS (SELECT 1 FROM galleries)
   OR EXISTS (SELECT 1 FROM album_production)
   OR EXISTS (SELECT 1 FROM handover_slots)
   OR EXISTS (SELECT 1 FROM handovers)
   OR EXISTS (SELECT 1 FROM feedback)
   OR EXISTS (SELECT 1 FROM users WHERE erased_at IS NOT NULL)
   OR EXISTS (
     SELECT 1 FROM booking_requests
     WHERE flow_version <> 1 OR deposit_amount IS NOT NULL OR terms_version IS NOT NULL
        OR terms_accepted_at IS NOT NULL OR completed_at IS NOT NULL
   );
DROP TABLE feedback;
DROP TABLE handovers;
DROP TABLE handover_slots;
DROP TABLE album_production;
DROP TABLE gallery_selections;
DROP TABLE gallery_photos;
DROP TABLE galleries;
DROP TABLE booking_consents;
DROP TABLE event_profiles;
DROP TABLE booking_receipts;
DROP TABLE media_objects;
DROP TABLE job_runs;
DROP TABLE notification_log;
DROP TABLE booking_events;
DROP TABLE notification_kinds;
DROP TABLE event_kinds;
ALTER TABLE users DROP COLUMN erased_at;
ALTER TABLE booking_requests DROP COLUMN completed_at;
ALTER TABLE booking_requests DROP COLUMN terms_accepted_at;
ALTER TABLE booking_requests DROP COLUMN terms_version;
ALTER TABLE booking_requests DROP COLUMN deposit_amount;
ALTER TABLE booking_requests DROP COLUMN flow_version;
```
The column drop order matters: a column named in another column's CHECK must go after that column (`deposit_amount` before `flow_version`, `terms_accepted_at` before `terms_version`). Its indexes go with the tables. Once reverted, `0005` must never be re-applied: re-expanding needs a new `0007`.

---

## 9. Verification performed in this run (in-memory SQLite 3.53, Node 24 `node:sqlite`)
Method: the SQL blocks were read **from this file** and run against the real `app/migrations/0001`, `0003` and `0004` files, with batches wrapped in `BEGIN`/`COMMIT` to emulate `DB.batch`. Nothing touched D1, R2 or any file other than this one.

RESULTS_PLACEHOLDER

**Still to verify on D1 itself (W3-1/W3-2, local first):**
- the §2.6 matrix;
- that `ALTER TABLE … ADD COLUMN` with cross-column CHECKs and `DROP COLUMN` behave identically on D1's SQLite version;
- `changes()` inside `INSERT … SELECT … WHERE changes() = 1` in a D1 batch;
- the per-invocation query counting for batches (§7).

---

## 10. New error outcomes for the Worker (proposed Arabic, feminine singular; the copywriter may refine)
| Code | When | Message |
|---|---|---|
| `RECEIPT_ATTEMPTS_EXHAUSTED` | `attempt_no` would exceed 10 | «تعذّر رفع إيصال جديد لهذا الحجز. تواصلي معنا عبر واتساب لنساعدكِ في إكماله.» |
| `FEEDBACK_ALREADY_SUBMITTED` | `feedback_submit` changed 0 rows because a row exists | «شكرًا لكِ، وصلنا رأيكِ مسبقًا.» |
| `EVENT_PROFILE_CLOSED` | `event_profile_upsert` changed 0 rows after the event date | «انتهت فترة تعديل تفاصيل يومكِ. تواصلي معنا عبر واتساب إن احتجتِ إلى أي تعديل.» |
| `HOLD_EXPIRED`, `RECEIPT_ALREADY_PENDING`, `SLOT_FULL`, quota reached, `GALLERY_LOCKED` | — | Existing copy in ADR §2.1 and `08-copy-ar.md` §5–§6 |

---

## 11. Unresolved (owner or compliance), each with a proposed default
- **U-1 D8 production state.** Default: run §2.3, follow §2.4. Any production write needs owner approval, a recorded bookmark and devops-engineer to run it.
- **U-2 PDPL residency and cross-border transfer (ADR U1).** D1 already stores its data abroad. Default: the R2 bucket is not created, and flow 2 and galleries stay off until compliance answers.
- **U-3 Retention period for booking and financial records** (booking rows, users with bookings, verified receipts; bookkeeping or ZATCA duties). Default: no automatic deletion of booking rows until it is set. Receipt images are deleted 90 days after the event, with a 730-day ceiling. If a statutory period applies, raise `RECEIPT_CEILING_DAYS` and the `r/` lifecycle rule, and update `media_objects.expires_at` for receipts.
- **U-4 Sensitive-data classification** of bride and guest photos, receipts, and free-text requests. Default: treat them as high-risk: private, short retention, never published without consent, and a UI hint not to write health details.
- **U-5 Guests and children in previews: lawful basis.** Default: only the bride and the admin can see them, they are deleted 30 days after completion, and publishing requires the bride's consent.
- **U-6 When consent can be withdrawn.** The spec says "before the event", while PDPL generally allows withdrawal at any time (verify). Default: withdrawal allowed at any time, granting only while the booking is confirmed. The DB and SQL already do this.
- **U-7 Consent scope.** Default: one purpose, `publish_photos`, covering the website and social media. `publish_testimonial` is reserved for D7 reuse with explicit consent.
- **U-8 Feedback retention.** Default: 12 months.
- **U-9 Customer profiles with no bookings.** Default: deleted 12 months after the last update.
- **U-10 `admin_notes` purge.** Default: 90 days after completion or a terminal status.
- **U-11 `blocked_dates` purge.** Default: 12 months after the date.
- **U-12 Data-subject request handling:**
  - who runs it;
  - the statutory response time (verify);
  - identity verification.

  Default: the owner approves, devops-engineer runs the §6.5 SQL, and the Firebase account is deleted in the console. There is no self-service.
- **U-13 Privacy-notice disclosures:** D1 Time Travel (7/30 days), Resend and Firebase storage in the US, R2 deletion being final. Default: disclose all of them.
- **U-14 Is pseudonymisation adequate?** The Firebase uid stays on retained rows. Default: acceptable pending compliance.
- **U-15 Bookings without an album.** Do album production and handover apply to them? Default: yes, the same pipeline covers any physical deliverables, and the selection quota is 30 (ADR U11).
- **U-16 Workers plan (ADR U3).** Default: Paid. On Free, cap selection ops and expiry rows at 20 per invocation.
- **U-17 Receipt attempt cap.** Default: 10 per booking, then WhatsApp (PAY-09).
- **U-18 Gallery hard ceiling vs slow album production.** Default: 180 days after upload (R2 lifecycle 190).
- **U-19 Legacy CHECK hole and variant-B drift.** Default: no table rebuild. App-layer date validation stays (`bookings.ts:113-138`, `index.ts:31-62`). Revisit only as its own expand-contract project.

## 12. Handoffs
- **compliance-officer:** §6.2 periods and legal bases, and U-2 to U-14.
- **security-auditor:** §6.8 app-layer isolation, `media_objects` purge correctness, signed-URL minting only after the `user_id` predicate (W4-5, W6-4).
- **devops-engineer:** §2.3 (the owner may run it alone), §2.5, and §8 steps 2–4 against production. These are never run by an agent.
- **backend-engineer (W3-1…W8-3):** the §4 blocks are the contract for each handler, and the §2.6 matrix comes before any remote step.
