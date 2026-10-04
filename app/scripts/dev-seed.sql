-- scripts/dev-seed.sql
-- LOCAL DEVELOPMENT DATA ONLY (plan 11 section 6.2). Run it through scripts/seed-local.mjs, which checks
-- the tester's Firebase uid, puts it in place of the one uid placeholder in section 1 and runs this file with
-- `wrangler d1 execute DB --local` only. Never run it against a remote database: the release runbook
-- (plan 11 section 7.4) checks that production has no _dev_seed_marker table.
--
-- Needs migrations 0001, 0003-0009. It runs once per database: the first statement creates _dev_seed_marker
-- and fails if the table exists, and wrangler then rolls the whole file back. To seed again, stop the dev
-- server, delete the local state (.wrangler/state, or the --persist-to folder) and migrate first.
--
-- Writes: one booking per journey stage for the tester customer, each on its own event date, including a
-- flow-2 hold past its deadline that a deposit notice for that deadline protects; six fake customers (ids
-- seed-customer-N, @example.test addresses, phone numbers from Ofcom's drama range 07700 900000-900999, so a
-- WhatsApp link opened from the admin never reaches a real person) with bookings over the next two months;
-- 3 blocked dates, 2 delivery areas and 11 handover slots. Beyond the plan's list, it also reaches every
-- admin queue section of plan 11 §3.3 #35 except bank_mismatch (it needs settings) and the /api/bookings/me
-- sub-states awaiting_deposit, deposit_reported and handover_missed.
-- Never writes: settings revisions, bank details, terms versions, kill-switch rows, admin audit rows or an
-- admin. The tester enters the settings through the admin UI after scripts/promote-admin.mjs.
--
-- Times are computed by SQLite from 'now', so the stages are current whenever the seed runs. Event dates are
-- Asia/Riyadh calendar dates, date('now', '+3 hours', ...), and slots start at Riyadh wall-clock hours. Every
-- instant that another row must repeat exactly (the hold deadline a deposit notice quotes, the completion a
-- handover shares) is computed once, in _dev_seed_plan, which is dropped at the end.
--
-- Fixtures, not business facts: the package snapshots are the output of shared/booking.ts
-- validateBookingSelection for four selections of the current catalogue (src/data/packages.ts). No deposit rule
-- exists yet (decisions.md D4), so flow-2 bookings carry a quarter of their estimated total as a placeholder
-- deposit, and both delivery areas have fee 0. Names and free text say they are test data. Bookings that
-- accepted terms name version 'v1', but no terms row is seeded: v1 is whatever the tester publishes first.
-- deposit_rule_revision_id and bank_revision_id stay NULL because no settings exist.
--
-- The tester ends up with 9 open requests, above the cap of 3 in worker/bookings.ts, so she cannot submit a new
-- one: walk a fresh booking end to end with the second tester customer.

-- 1. The marker (release preflight: must never exist remotely). Its CHECKs repeat the script's uid rule and
--    refuse a uid whose users row is an admin or erased.
CREATE TABLE _dev_seed_marker (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  customer_uid TEXT NOT NULL
    CHECK (length(customer_uid) BETWEEN 1 AND 128 AND customer_uid NOT GLOB '*[^A-Za-z0-9]*'),
  customer_row_ok INTEGER NOT NULL CHECK (customer_row_ok = 1),
  seeded_at TEXT NOT NULL
    CHECK (length(seeded_at) = 24 AND substr(seeded_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', seeded_at) IS seeded_at)
);

INSERT INTO _dev_seed_marker (id, customer_uid, customer_row_ok, seeded_at)
SELECT
  1,
  given.uid,
  NOT EXISTS (
    SELECT 1 FROM users WHERE users.id = given.uid AND (users.role <> 'customer' OR users.erased_at IS NOT NULL)
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT '{{CUSTOMER_UID}}' AS uid) AS given;

-- 2. Customers. The tester's row is created only when she has not signed in yet. Its placeholder address is
--    unproven (email_verified_at NULL), so her first verified sign-in replaces it with her own (worker/users.ts).
INSERT INTO users (id, email, email_verified_at, first_name, last_name, phone, role, created_at, updated_at)
SELECT
  marker.customer_uid, 'seed-tester@example.test', NULL, 'عروس', 'تجريبية', '+447700900000', 'customer',
  datetime('now', '-200 days'), datetime('now', '-200 days')
FROM _dev_seed_marker AS marker
WHERE marker.id = 1
  AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = marker.customer_uid);

-- The fake customers cannot sign in. seed-customer-3 changed her contact details after her booking (TM-08).
WITH customer (id, first_name, phone, created_days, contact_changed_days) AS (VALUES
  ('seed-customer-1', 'نورة', '+447700900001', -1, NULL),
  ('seed-customer-2', 'ريم', '+447700900002', -2, NULL),
  ('seed-customer-3', 'سارة', '+447700900003', -21, -1),
  ('seed-customer-4', 'لمى', '+447700900004', -26, NULL),
  ('seed-customer-5', 'هيا', '+447700900005', -5, NULL),
  ('seed-customer-6', 'جود', '+447700900006', -110, NULL)
)
INSERT INTO users (
  id, email, email_verified_at, first_name, last_name, phone, role, created_at, updated_at, contact_changed_at
)
SELECT
  customer.id,
  customer.id || '@example.test',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', customer.created_days || ' days'),
  customer.first_name,
  'تجريبية',
  customer.phone,
  'customer',
  datetime('now', customer.created_days || ' days'),
  datetime('now', COALESCE(customer.contact_changed_days, customer.created_days) || ' days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', customer.contact_changed_days || ' days')
FROM customer;

-- 3. The plan: one row per booking with every instant computed once. Offsets are hours from now (negative =
--    past), event_day is days from today in Riyadh, completed_day is the Riyadh day of a completed handover
--    (at 17:30, half an hour into its 17:00 slot). closed_at is the time of the last transition that
--    confirmed_at does not cover (receipt upload, expiry, cancellation, rejection, contract sent).
CREATE TABLE _dev_seed_plan (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  event_date TEXT NOT NULL,
  status TEXT NOT NULL,
  flow_version INTEGER NOT NULL,
  package_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  hold_expires_at TEXT,
  terms_accepted_at TEXT,
  deposit_notice_at TEXT,
  confirmed_at TEXT,
  closed_at TEXT,
  completed_at TEXT
);

WITH
  snapshot (package, json) AS (VALUES
    ('four_hours_album', '{"schemaVersion":1,"package":{"id":"four-hours","name":"4 ساعات","basePrice":3000},"coverage":{"id":"four-hours","label":"4 ساعات","durationHours":4,"price":3000},"noCostOptions":{"photoCount":{"value":45,"label":"45 صورة"},"miniAlbumIncluded":true,"includedAlbumBox":{"id":"normal","label":"بوكس الألبوم العادي"}},"album":{"id":"medium","name":"الألبوم الوسط","dimensions":"30 × 45 سم","photoCount":45,"pageCount":15,"price":800,"includesMiniAlbum":true,"box":{"id":"normal","name":"بوكس الألبوم العادي","price":0}},"extras":[],"calculation":{"coverage":3000,"album":800,"albumBoxUpgrade":0,"individualPrints":0,"magazines":0,"woodenEnlargements":0,"coverageAddons":0},"estimatedTotal":3800}'),
    ('two_hours', '{"schemaVersion":1,"package":{"id":"two-hours","name":"ساعتان","basePrice":1450},"coverage":{"id":"two-hours","label":"ساعتان","durationHours":2,"price":1450},"noCostOptions":{"photoCount":null,"miniAlbumIncluded":false,"includedAlbumBox":null},"album":null,"extras":[],"calculation":{"coverage":1450,"album":0,"albumBoxUpgrade":0,"individualPrints":0,"magazines":0,"woodenEnlargements":0,"coverageAddons":0},"estimatedTotal":1450}'),
    ('six_hours_album_prints', '{"schemaVersion":1,"package":{"id":"six-hours","name":"6 ساعات","basePrice":4500},"coverage":{"id":"six-hours","label":"6 ساعات","durationHours":6,"price":4500},"noCostOptions":{"photoCount":{"value":60,"label":"60 صورة"},"miniAlbumIncluded":true,"includedAlbumBox":null},"album":{"id":"large","name":"الألبوم الكبير","dimensions":"30 × 60 سم","photoCount":60,"pageCount":20,"price":1050,"includesMiniAlbum":true,"box":{"id":"vip","name":"ترقية البوكس إلى VIP","price":200}},"extras":[{"kind":"individual_print","id":"a5","name":"صور فردية مقاس A5","quantity":10,"unitPrice":16,"subtotal":160},{"kind":"individual_print","id":"a4","name":"صور فردية مقاس A4","quantity":2,"unitPrice":20,"subtotal":40}],"calculation":{"coverage":4500,"album":1050,"albumBoxUpgrade":200,"individualPrints":200,"magazines":0,"woodenEnlargements":0,"coverageAddons":0},"estimatedTotal":5950}'),
    ('eight_hours_album_enlargement', '{"schemaVersion":1,"package":{"id":"eight-hours","name":"8 ساعات","basePrice":6100},"coverage":{"id":"eight-hours","label":"8 ساعات","durationHours":8,"price":6100},"noCostOptions":{"photoCount":{"value":80,"label":"80 صورة"},"miniAlbumIncluded":true,"includedAlbumBox":{"id":"normal","label":"بوكس الألبوم العادي"}},"album":{"id":"large","name":"الألبوم الكبير","dimensions":"30 × 60 سم","photoCount":80,"pageCount":20,"price":1050,"includesMiniAlbum":true,"box":{"id":"normal","name":"بوكس الألبوم العادي","price":0}},"extras":[{"kind":"wooden_enlargement","id":"wooden-30x40","name":"مكبّرة خشبية","dimensions":"30 × 40 سم","quantity":1,"unitPrice":80,"subtotal":80}],"calculation":{"coverage":6100,"album":1050,"albumBoxUpgrade":0,"individualPrints":0,"magazines":0,"woodenEnlargements":80,"coverageAddons":0},"estimatedTotal":7230}')
  ),
  step (
    id, owner, event_day, status, flow_version, package,
    created_h, approved_h, hold_h, terms_h, notice_h, confirmed_h, closed_h, completed_day
  ) AS (VALUES
    -- Tester, stage 1: waiting for review for 30 h (past the 24 h response target).
    ('5eedb00c-0000-4000-8000-000000000001', 'tester', 60, 'pending_review', 1, 'four_hours_album',
      -30, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    -- Stage 2, flow 2, terms not accepted yet, hold ends in 20 h.
    ('5eedb00c-0000-4000-8000-000000000002', 'tester', 62, 'approved_hold', 2, 'two_hours',
      -50, -28, 20, NULL, NULL, NULL, NULL, NULL),
    -- Stage 2, terms accepted and a deposit notice sent for the current deadline (30 h left).
    ('5eedb00c-0000-4000-8000-000000000003', 'tester', 64, 'approved_hold', 2, 'six_hours_album_prints',
      -60, -18, 30, -10, -6, NULL, NULL, NULL),
    -- Stage 2, deadline passed 3 h ago but a notice for that deadline protects it (decide now, never auto-expire).
    ('5eedb00c-0000-4000-8000-000000000004', 'tester', 66, 'approved_hold', 2, 'four_hours_album',
      -100, -51, -3, -40, -20, NULL, NULL, NULL),
    -- Stage 2, deadline passed 2 h ago, no notice (expirable only when automatic expiry is on).
    ('5eedb00c-0000-4000-8000-000000000005', 'tester', 68, 'approved_hold', 2, 'eight_hours_album_enlargement',
      -90, -50, -2, NULL, NULL, NULL, NULL, NULL),
    -- Flow-2 hold that expired, its date still free (reinstate_hold).
    ('5eedb00c-0000-4000-8000-000000000006', 'tester', 70, 'expired', 2, 'two_hours',
      -200, -150, -102, NULL, NULL, NULL, -102, NULL),
    -- Stage 4: receipt uploaded 5 h ago, pending review (media environment).
    ('5eedb00c-0000-4000-8000-000000000007', 'tester', 72, 'payment_pending', 2, 'four_hours_album',
      -80, -40, 8, -30, NULL, NULL, -5, NULL),
    -- Stage 3: receipt uploaded 20 h ago and rejected 18 h ago, hold still running (media environment).
    ('5eedb00c-0000-4000-8000-000000000008', 'tester', 74, 'payment_pending', 2, 'six_hours_album_prints',
      -50, -26, 22, -24, NULL, NULL, -20, NULL),
    -- Stage 5: confirmed, event in 10 days, no event details yet.
    ('5eedb00c-0000-4000-8000-000000000009', 'tester', 10, 'confirmed', 2, 'two_hours',
      -30 * 24, -29 * 24, -29 * 24 + 48, -29 * 24 + 6, NULL, -29 * 24 + 24, NULL, NULL),
    -- Stage 6: confirmed, event in 5 days, event details saved and publishing consent granted.
    ('5eedb00c-0000-4000-8000-000000000010', 'tester', 5, 'confirmed', 2, 'four_hours_album',
      -40 * 24, -39 * 24, -39 * 24 + 48, -39 * 24 + 6, NULL, -39 * 24 + 24, NULL, NULL),
    -- Stage 6 after the event (3 days ago): waiting for previews.
    ('5eedb00c-0000-4000-8000-000000000011', 'tester', -3, 'confirmed', 2, 'six_hours_album_prints',
      -63 * 24, -62 * 24, -62 * 24 + 48, -62 * 24 + 6, NULL, -62 * 24 + 24, NULL, NULL),
    -- Stage 7: gallery open (media environment).
    ('5eedb00c-0000-4000-8000-000000000012', 'tester', -10, 'confirmed', 2, 'four_hours_album',
      -70 * 24, -69 * 24, -69 * 24 + 48, -69 * 24 + 6, NULL, -69 * 24 + 24, NULL, NULL),
    -- Stage 8: selection submitted, gallery locked (media environment).
    ('5eedb00c-0000-4000-8000-000000000013', 'tester', -20, 'confirmed', 2, 'six_hours_album_prints',
      -80 * 24, -79 * 24, -79 * 24 + 48, -79 * 24 + 6, NULL, -79 * 24 + 24, NULL, NULL),
    -- Stage 9: album in design.
    ('5eedb00c-0000-4000-8000-000000000014', 'tester', -30, 'confirmed', 2, 'eight_hours_album_enlargement',
      -90 * 24, -89 * 24, -89 * 24 + 48, -89 * 24 + 6, NULL, -89 * 24 + 24, NULL, NULL),
    -- Stage 10: album printing.
    ('5eedb00c-0000-4000-8000-000000000015', 'tester', -40, 'confirmed', 2, 'four_hours_album',
      -100 * 24, -99 * 24, -99 * 24 + 48, -99 * 24 + 6, NULL, -99 * 24 + 24, NULL, NULL),
    -- Stage 11: album ready, no handover booked.
    ('5eedb00c-0000-4000-8000-000000000016', 'tester', -50, 'confirmed', 2, 'six_hours_album_prints',
      -110 * 24, -109 * 24, -109 * 24 + 48, -109 * 24 + 6, NULL, -109 * 24 + 24, NULL, NULL),
    -- Stage 12: pickup booked for tomorrow.
    ('5eedb00c-0000-4000-8000-000000000017', 'tester', -55, 'confirmed', 2, 'four_hours_album',
      -115 * 24, -114 * 24, -114 * 24 + 48, -114 * 24 + 6, NULL, -114 * 24 + 24, NULL, NULL),
    -- Stage 13: pickup today.
    ('5eedb00c-0000-4000-8000-000000000018', 'tester', -58, 'confirmed', 2, 'eight_hours_album_enlargement',
      -118 * 24, -117 * 24, -117 * 24 + 48, -117 * 24 + 6, NULL, -117 * 24 + 24, NULL, NULL),
    -- Stage 14: completed 5 days ago, feedback given.
    ('5eedb00c-0000-4000-8000-000000000019', 'tester', -70, 'confirmed', 2, 'six_hours_album_prints',
      -130 * 24, -129 * 24, -129 * 24 + 48, -129 * 24 + 6, NULL, -129 * 24 + 24, NULL, -5),
    -- Stage 14: completed 6 days ago, no feedback yet.
    ('5eedb00c-0000-4000-8000-000000000020', 'tester', -75, 'confirmed', 2, 'four_hours_album',
      -135 * 24, -134 * 24, -134 * 24 + 48, -134 * 24 + 6, NULL, -134 * 24 + 24, NULL, -6),
    -- Stage 15: completed without a gallery (privacy clean-up).
    ('5eedb00c-0000-4000-8000-000000000021', 'tester', -90, 'confirmed', 2, 'eight_hours_album_enlargement',
      -150 * 24, -149 * 24, -149 * 24 + 48, -149 * 24 + 6, NULL, -149 * 24 + 24, NULL, -40),
    -- Legacy flow 1 (no journey stage). Its approval set a 24 h hold that no job ever expires; the contract
    -- and expiry steps keep it, a cancellation clears it (worker/admin-workflow.ts).
    ('5eedb00c-0000-4000-8000-000000000022', 'tester', 80, 'contract_pending', 1, 'two_hours',
      -10 * 24, -9 * 24, -8 * 24, NULL, NULL, NULL, -8 * 24 - 2, NULL),
    ('5eedb00c-0000-4000-8000-000000000023', 'tester', 85, 'expired', 1, 'four_hours_album',
      -20 * 24, -19 * 24, -18 * 24, NULL, NULL, NULL, -17 * 24, NULL),
    ('5eedb00c-0000-4000-8000-000000000024', 'tester', 90, 'cancelled', 1, 'two_hours',
      -15 * 24, -14 * 24, NULL, NULL, NULL, NULL, -12 * 24, NULL),
    -- Fake customers, event dates over the next two months.
    ('5eedb00c-0000-4000-8000-000000000025', 'seed-customer-1', 15, 'pending_review', 1, 'four_hours_album',
      -5, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    ('5eedb00c-0000-4000-8000-000000000026', 'seed-customer-2', 18, 'approved_hold', 2, 'six_hours_album_prints',
      -30, -8, 40, NULL, NULL, NULL, NULL, NULL),
    ('5eedb00c-0000-4000-8000-000000000027', 'seed-customer-3', 25, 'confirmed', 2, 'two_hours',
      -20 * 24, -19 * 24, -19 * 24 + 48, -19 * 24 + 6, NULL, -19 * 24 + 24, NULL, NULL),
    ('5eedb00c-0000-4000-8000-000000000028', 'seed-customer-4', 35, 'confirmed', 2, 'eight_hours_album_enlargement',
      -25 * 24, -24 * 24, -24 * 24 + 48, -24 * 24 + 6, NULL, -24 * 24 + 24, NULL, NULL),
    ('5eedb00c-0000-4000-8000-000000000029', 'seed-customer-5', 40, 'rejected', 1, 'two_hours',
      -3 * 24, NULL, NULL, NULL, NULL, NULL, -2 * 24, NULL),
    ('5eedb00c-0000-4000-8000-000000000030', 'seed-customer-5', 45, 'pending_review', 1, 'four_hours_album',
      -1, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
    -- Past event, album ready, delivery booked for tomorrow.
    ('5eedb00c-0000-4000-8000-000000000031', 'seed-customer-6', -45, 'confirmed', 2, 'six_hours_album_prints',
      -105 * 24, -104 * 24, -104 * 24 + 48, -104 * 24 + 6, NULL, -104 * 24 + 24, NULL, NULL),
    -- States the admin queue (plan 11 §3.3 #35) and /api/bookings/me (#1) name that the rows above do not reach.
    -- Tester, stage 2 awaiting_deposit: terms accepted 12 h ago, no notice yet, 28 h left on the hold.
    ('5eedb00c-0000-4000-8000-000000000032', 'tester', 76, 'approved_hold', 2, 'six_hours_album_prints',
      -40, -20, 28, -12, NULL, NULL, NULL, NULL),
    -- Tester, stage 12 handover_missed: album ready, pickup two days ago marked no_show (queue handover_no_show).
    ('5eedb00c-0000-4000-8000-000000000033', 'tester', -60, 'confirmed', 2, 'four_hours_album',
      -120 * 24, -119 * 24, -119 * 24 + 48, -119 * 24 + 6, NULL, -119 * 24 + 24, NULL, NULL),
    -- Tester, stage 7 past the selection deadline, nothing submitted (queue selection_overdue, media environment).
    ('5eedb00c-0000-4000-8000-000000000034', 'tester', -25, 'confirmed', 2, 'eight_hours_album_enlargement',
      -85 * 24, -84 * 24, -84 * 24 + 48, -84 * 24 + 6, NULL, -84 * 24 + 24, NULL, NULL),
    -- Event today with details saved (queue events_today_tomorrow, the «اليوم» summary).
    ('5eedb00c-0000-4000-8000-000000000035', 'seed-customer-6', 0, 'confirmed', 2, 'eight_hours_album_enlargement',
      -50 * 24, -49 * 24, -49 * 24 + 48, -49 * 24 + 6, NULL, -49 * 24 + 24, NULL, NULL),
    -- Event in 2 days without details (queue events_soon_without_details).
    ('5eedb00c-0000-4000-8000-000000000036', 'seed-customer-4', 2, 'confirmed', 2, 'four_hours_album',
      -22 * 24, -21 * 24, -21 * 24 + 48, -21 * 24 + 6, NULL, -21 * 24 + 24, NULL, NULL)
  )
INSERT INTO _dev_seed_plan (
  id, user_id, event_date, status, flow_version, package_snapshot, created_at, approved_at, hold_expires_at,
  terms_accepted_at, deposit_notice_at, confirmed_at, closed_at, completed_at
)
SELECT
  step.id,
  CASE step.owner WHEN 'tester' THEN (SELECT customer_uid FROM _dev_seed_marker WHERE id = 1) ELSE step.owner END,
  date('now', '+3 hours', step.event_day || ' days'),
  step.status,
  step.flow_version,
  snapshot.json,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', step.created_h || ' hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', step.approved_h || ' hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', step.hold_h || ' hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', step.terms_h || ' hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', step.notice_h || ' hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', step.confirmed_h || ' hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', step.closed_h || ' hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', date('now', '+3 hours', step.completed_day || ' days'), '+14 hours', '+30 minutes')
FROM step
INNER JOIN snapshot ON snapshot.package = step.package;

-- 4. Bookings. Flow 2 carries the placeholder deposit; a confirmed flow-2 booking records it as received.
INSERT INTO booking_requests (
  id, user_id, event_date, status, package_snapshot, estimated_total, hold_expires_at, confirmed_at,
  created_at, updated_at, flow_version, deposit_amount, terms_version, terms_accepted_at, completed_at,
  deposit_received_amount, deposit_received_at
)
SELECT
  plan.id,
  plan.user_id,
  plan.event_date,
  plan.status,
  plan.package_snapshot,
  json_extract(plan.package_snapshot, '$.estimatedTotal'),
  plan.hold_expires_at,
  plan.confirmed_at,
  plan.created_at,
  COALESCE(plan.completed_at, plan.confirmed_at, plan.closed_at, plan.deposit_notice_at, plan.terms_accepted_at, plan.approved_at, plan.created_at),
  plan.flow_version,
  CASE WHEN plan.flow_version = 2 THEN json_extract(plan.package_snapshot, '$.estimatedTotal') / 4 END,
  CASE WHEN plan.terms_accepted_at IS NOT NULL THEN 'v1' END,
  plan.terms_accepted_at,
  plan.completed_at,
  CASE WHEN plan.flow_version = 2 AND plan.confirmed_at IS NOT NULL THEN json_extract(plan.package_snapshot, '$.estimatedTotal') / 4 END,
  CASE WHEN plan.flow_version = 2 THEN plan.confirmed_at END
FROM _dev_seed_plan AS plan;

-- 5. Status history, as the Worker writes it: the request by the customer, every later step by the studio
--    (changed_by NULL: the seed has no admin), the receipt upload by the customer.
INSERT INTO booking_status_history (booking_id, from_status, to_status, changed_by, note, created_at)
SELECT id, NULL, 'pending_review', user_id, NULL, created_at FROM _dev_seed_plan
UNION ALL
SELECT id, 'pending_review', 'approved_hold', NULL, NULL, approved_at FROM _dev_seed_plan WHERE approved_at IS NOT NULL
UNION ALL
SELECT id, 'pending_review', 'rejected', NULL, NULL, closed_at FROM _dev_seed_plan WHERE status = 'rejected'
UNION ALL
SELECT id, 'approved_hold', status, CASE WHEN status = 'payment_pending' THEN user_id END, NULL, closed_at
FROM _dev_seed_plan WHERE status IN ('payment_pending', 'expired', 'cancelled', 'contract_pending')
UNION ALL
SELECT id, 'approved_hold', 'confirmed', NULL, NULL, confirmed_at FROM _dev_seed_plan WHERE confirmed_at IS NOT NULL;

-- 6. Deposit notices, each quoting the deadline it was sent for (the notice-protected hold predicate).
INSERT INTO booking_events (booking_id, actor, actor_uid, event, subject_id, details, note, created_at)
SELECT id, 'customer', NULL, 'deposit_notice_sent', NULL, json_object('holdExpiresAt', hold_expires_at), NULL, deposit_notice_at
FROM _dev_seed_plan
WHERE deposit_notice_at IS NOT NULL;

-- 7. Receipts (media environment). No file is stored: object_key and content_sha256 stay NULL.
WITH receipt (id, booking_id, status, reviewed_h, rejection_reason) AS (VALUES
  ('5eed0ec0-0000-4000-8000-000000000001', '5eedb00c-0000-4000-8000-000000000007', 'pending', NULL, NULL),
  ('5eed0ec0-0000-4000-8000-000000000002', '5eedb00c-0000-4000-8000-000000000008', 'rejected', -18,
    'بيانات تجريبية: صورة الإيصال غير واضحة، أرسلي صورة أوضح.')
)
INSERT INTO booking_receipts (
  id, booking_id, attempt_no, object_key, status, reviewed_by, reviewed_at, rejection_reason, purged_at,
  created_at, updated_at
)
SELECT
  receipt.id,
  receipt.booking_id,
  1,
  NULL,
  receipt.status,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', receipt.reviewed_h || ' hours'),
  receipt.rejection_reason,
  NULL,
  plan.closed_at,
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', receipt.reviewed_h || ' hours'), plan.closed_at)
FROM receipt
INNER JOIN _dev_seed_plan AS plan ON plan.id = receipt.booking_id;

-- 8. Event details (stage 6) and a granted publishing consent.
WITH profile (booking_id, venue_name, event_start_time, special_requests, created_days) AS (VALUES
  ('5eedb00c-0000-4000-8000-000000000010', 'قاعة تجريبية', '20:00', 'بيانات تجريبية: تصوير لحظة دخول العروس.', -2),
  ('5eedb00c-0000-4000-8000-000000000011', 'قاعة تجريبية', '21:00', NULL, -8),
  ('5eedb00c-0000-4000-8000-000000000012', 'قاعة تجريبية', '19:30', NULL, -15),
  ('5eedb00c-0000-4000-8000-000000000028', 'قاعة تجريبية', '20:30', NULL, -3),
  ('5eedb00c-0000-4000-8000-000000000035', 'قاعة تجريبية', '21:00', NULL, -6)
)
INSERT INTO event_profiles (
  booking_id, venue_name, venue_area, event_start_time, special_requests, created_at, updated_at, text_purged_at
)
SELECT
  profile.booking_id,
  profile.venue_name,
  'الرياض',
  profile.event_start_time,
  profile.special_requests,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', profile.created_days || ' days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', profile.created_days || ' days'),
  NULL
FROM profile;

INSERT INTO booking_consents (booking_id, purpose, granted, text_version, created_at, updated_at)
VALUES (
  '5eedb00c-0000-4000-8000-000000000010', 'publish_photos', 1, 'v1',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')
);

-- 9. Galleries (media environment), no photos: the quota is the package's photo count.
WITH gallery (id, booking_id, status, opened_days, deadline_days, submitted_days) AS (VALUES
  ('5eed9a11-0000-4000-8000-000000000001', '5eedb00c-0000-4000-8000-000000000012', 'open', -2, 12, NULL),
  ('5eed9a11-0000-4000-8000-000000000002', '5eedb00c-0000-4000-8000-000000000013', 'locked', -18, -4, -9),
  ('5eed9a11-0000-4000-8000-000000000003', '5eedb00c-0000-4000-8000-000000000014', 'locked', -28, -14, -20),
  ('5eed9a11-0000-4000-8000-000000000004', '5eedb00c-0000-4000-8000-000000000015', 'locked', -38, -24, -30),
  ('5eed9a11-0000-4000-8000-000000000005', '5eedb00c-0000-4000-8000-000000000016', 'locked', -48, -34, -40),
  ('5eed9a11-0000-4000-8000-000000000006', '5eedb00c-0000-4000-8000-000000000017', 'locked', -53, -39, -45),
  ('5eed9a11-0000-4000-8000-000000000007', '5eedb00c-0000-4000-8000-000000000018', 'locked', -56, -42, -48),
  ('5eed9a11-0000-4000-8000-000000000008', '5eedb00c-0000-4000-8000-000000000019', 'locked', -68, -54, -60),
  ('5eed9a11-0000-4000-8000-000000000009', '5eedb00c-0000-4000-8000-000000000020', 'locked', -73, -59, -65),
  ('5eed9a11-0000-4000-8000-000000000010', '5eedb00c-0000-4000-8000-000000000031', 'locked', -43, -29, -35),
  ('5eed9a11-0000-4000-8000-000000000011', '5eedb00c-0000-4000-8000-000000000033', 'locked', -58, -44, -50),
  ('5eed9a11-0000-4000-8000-000000000012', '5eedb00c-0000-4000-8000-000000000034', 'open', -18, -4, NULL)
)
INSERT INTO galleries (
  id, booking_id, status, quota, quota_source, opened_at, selection_deadline, submitted_at, purged_at,
  created_at, updated_at
)
SELECT
  gallery.id,
  gallery.booking_id,
  gallery.status,
  json_extract(plan.package_snapshot, '$.noCostOptions.photoCount.value'),
  'package',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', gallery.opened_days || ' days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', gallery.deadline_days || ' days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', gallery.submitted_days || ' days'),
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', gallery.opened_days || ' days', '-1 hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', COALESCE(gallery.submitted_days, gallery.opened_days) || ' days')
FROM gallery
INNER JOIN _dev_seed_plan AS plan ON plan.id = gallery.booking_id;

-- 10. Album production.
WITH album (booking_id, stage, created_days, updated_days) AS (VALUES
  ('5eedb00c-0000-4000-8000-000000000014', 'design', -15, -15),
  ('5eedb00c-0000-4000-8000-000000000015', 'printing', -25, -10),
  ('5eedb00c-0000-4000-8000-000000000016', 'ready', -35, -2),
  ('5eedb00c-0000-4000-8000-000000000017', 'ready', -40, -6),
  ('5eedb00c-0000-4000-8000-000000000018', 'ready', -42, -8),
  ('5eedb00c-0000-4000-8000-000000000019', 'ready', -55, -20),
  ('5eedb00c-0000-4000-8000-000000000020', 'ready', -60, -25),
  ('5eedb00c-0000-4000-8000-000000000021', 'ready', -80, -50),
  ('5eedb00c-0000-4000-8000-000000000031', 'ready', -30, -3),
  ('5eedb00c-0000-4000-8000-000000000033', 'ready', -45, -8)
)
INSERT INTO album_production (booking_id, stage, created_at, updated_at)
SELECT
  album.booking_id,
  album.stage,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', album.created_days || ' days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', album.updated_days || ' days')
FROM album;

-- 11. Handover slots: 11 one-hour slots at Riyadh wall-clock hours (UTC+3), four of them in the past.
WITH slot (id, day, riyadh_hour, method, capacity) AS (VALUES
  ('5eed5107-0000-4000-8000-000000000011', -2, 17, 'pickup', 1),
  ('5eed5107-0000-4000-8000-000000000001', -5, 17, 'pickup', 1),
  ('5eed5107-0000-4000-8000-000000000002', -6, 17, 'pickup', 1),
  ('5eed5107-0000-4000-8000-000000000003', -40, 17, 'pickup', 1),
  ('5eed5107-0000-4000-8000-000000000004', 0, 17, 'both', 2),
  ('5eed5107-0000-4000-8000-000000000005', 1, 17, 'pickup', 1),
  ('5eed5107-0000-4000-8000-000000000006', 1, 19, 'delivery', 1),
  ('5eed5107-0000-4000-8000-000000000007', 2, 17, 'both', 2),
  ('5eed5107-0000-4000-8000-000000000008', 3, 17, 'pickup', 1),
  ('5eed5107-0000-4000-8000-000000000009', 4, 18, 'delivery', 1),
  ('5eed5107-0000-4000-8000-000000000010', 5, 17, 'both', 3)
)
INSERT INTO handover_slots (id, starts_at, ends_at, method, capacity, is_active, created_at, updated_at)
SELECT
  slot.id,
  strftime('%Y-%m-%dT%H:%M:%fZ', date('now', '+3 hours', slot.day || ' days'), (slot.riyadh_hour - 3) || ' hours'),
  strftime('%Y-%m-%dT%H:%M:%fZ', date('now', '+3 hours', slot.day || ' days'), (slot.riyadh_hour - 2) || ' hours'),
  slot.method,
  slot.capacity,
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days')
FROM slot;

-- 12. Delivery areas (fee 0: a placeholder until the owner sets her own).
INSERT INTO delivery_areas (id, name, fee, is_active, sort_order, created_at, updated_at)
VALUES
  ('5eedaea0-0000-4000-8000-000000000001', 'منطقة تجريبية (أ)', 0, 1, 1,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days')),
  ('5eedaea0-0000-4000-8000-000000000002', 'منطقة تجريبية (ب)', 0, 1, 2,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 days'));

-- 13. Handovers. A completed one shares the booking's completed_at; a no-show was marked an hour after its
--     slot ended; a delivery snapshots its area (name as delivery_city, id and fee), as the handover route does.
WITH handover (booking_id, slot_id, method, status, created_days, delivery_area_id) AS (VALUES
  ('5eedb00c-0000-4000-8000-000000000033', '5eed5107-0000-4000-8000-000000000011', 'pickup', 'no_show', -6, NULL),
  ('5eedb00c-0000-4000-8000-000000000017', '5eed5107-0000-4000-8000-000000000005', 'pickup', 'scheduled', -3, NULL),
  ('5eedb00c-0000-4000-8000-000000000018', '5eed5107-0000-4000-8000-000000000004', 'pickup', 'scheduled', -4, NULL),
  ('5eedb00c-0000-4000-8000-000000000019', '5eed5107-0000-4000-8000-000000000001', 'pickup', 'completed', -12, NULL),
  ('5eedb00c-0000-4000-8000-000000000020', '5eed5107-0000-4000-8000-000000000002', 'pickup', 'completed', -14, NULL),
  ('5eedb00c-0000-4000-8000-000000000021', '5eed5107-0000-4000-8000-000000000003', 'pickup', 'completed', -45, NULL),
  ('5eedb00c-0000-4000-8000-000000000031', '5eed5107-0000-4000-8000-000000000006', 'delivery', 'scheduled', -1,
    '5eedaea0-0000-4000-8000-000000000001')
)
INSERT INTO handovers (
  booking_id, slot_id, method, delivery_city, delivery_district, delivery_street, delivery_landmark, status,
  created_at, updated_at, completed_at, address_purged_at, delivery_area_id, delivery_fee
)
SELECT
  handover.booking_id,
  handover.slot_id,
  handover.method,
  area.name,
  CASE WHEN handover.method = 'delivery' THEN 'حي تجريبي' END,
  CASE WHEN handover.method = 'delivery' THEN 'شارع تجريبي' END,
  NULL,
  handover.status,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', handover.created_days || ' days'),
  COALESCE(
    plan.completed_at,
    CASE WHEN handover.status = 'no_show' THEN strftime('%Y-%m-%dT%H:%M:%fZ', slot.ends_at, '+1 hours') END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', handover.created_days || ' days')
  ),
  plan.completed_at,
  NULL,
  area.id,
  area.fee
FROM handover
INNER JOIN _dev_seed_plan AS plan ON plan.id = handover.booking_id
INNER JOIN handover_slots AS slot ON slot.id = handover.slot_id
LEFT JOIN delivery_areas AS area ON area.id = handover.delivery_area_id;

-- 14. Private feedback, a day after completion (never published).
INSERT INTO feedback (booking_id, rating, comment, created_at, updated_at)
SELECT
  plan.id,
  5,
  'بيانات تجريبية: ملاحظة من بيئة التطوير المحلية.',
  strftime('%Y-%m-%dT%H:%M:%fZ', plan.completed_at, '+1 days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', plan.completed_at, '+1 days')
FROM _dev_seed_plan AS plan
WHERE plan.id = '5eedb00c-0000-4000-8000-000000000019';

-- 15. Blocked dates (none on a seeded event date).
INSERT INTO blocked_dates (event_date, reason, created_by, created_at)
VALUES
  (date('now', '+3 hours', '7 days'), 'تاريخ مغلق (بيانات تجريبية)', NULL, datetime('now', '-7 days')),
  (date('now', '+3 hours', '21 days'), 'تاريخ مغلق (بيانات تجريبية)', NULL, datetime('now', '-7 days')),
  (date('now', '+3 hours', '30 days'), 'تاريخ مغلق (بيانات تجريبية)', NULL, datetime('now', '-7 days'));

DROP TABLE _dev_seed_plan;
