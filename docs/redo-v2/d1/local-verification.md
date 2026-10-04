# D1 migration repair — local verification (W3-1 prep)

Date: 2026-09-24 · wrangler 4.124.0 (installed in app/) · local D1 (miniflare), throw-away copies outside the repo
(scratchpad `d1verify/{old,fixed}` with a minimal wrangler.jsonc). Plan under test: 06-data-model.md §2.2 —
delete `0002_create_booking_schema.sql` from the working tree, touch nothing else.

| # | Scenario (06-data-model §2.6) | Observed | Verdict |
|---|---|---|---|
| 1 | Old chain (0001–0004) on a fresh DB | 0001 ✅, 0002 ❌ `table users already exists at offset 13: SQLITE_ERROR`, 0003/0004 not run | Reproduces inspection defect HIGH #1; per-file atomicity confirmed |
| 2 | Fixed chain (0001, 0003, 0004) on a fresh DB | 0001 ✅, 0003 ✅, 0004 ✅ | PASS |
| 3 | S1 — DB from #1 (0001 recorded, 0002 failed), then 0002 removed | 0003 ✅, 0004 ✅ | PASS |
| 4 | S2 — fixed DB with a `0002_create_booking_schema.sql` row inserted into `d1_migrations` (production that "applied everything") | `migrations list` → "No migrations to apply!" | PASS — wrangler ignores a recorded name without a file |
| 5 | `0005_portal_schema.sql` (06-data-model §3.6, 427 lines) applied on top of #2 and on top of #3 | 0005 ✅ on both; 23 tables in sqlite_master | PASS |

Also verified earlier with node:sqlite 3.53.0: all 141 write/read statements in 06-data-model.md prepare against the
0001+0003+0004+0005 schema.

**Still owner-gated (production):** this machine is not logged in to Cloudflare (`wrangler whoami` → not
authenticated). The owner runs `npx wrangler login` and the read-only state commands in 06-data-model.md §2.3, then
the decision table §2.4 picks S0/S1/S2/S2b/S3/S4. No remote write happens without the owner's approval and a recorded
Time Travel bookmark.

## Applied to the repository (2026-09-24)
`migrations/0002_create_booking_schema.sql` deleted (06-data-model §2.2). SHA-256 of 0001 and 0002 were identical (59de3f57d58207949622cdfa9234c4f5a772c6632d919af421b226b2c0fd5788)
the bytes remain in git history at d6b7cb2. No other migration touched.
