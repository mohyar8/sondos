-- 0008_golive_admin_settings.sql
-- Plan 11 section 2.2 (drafted there as 0007_golive_admin_settings.sql; numbered 0008 because Wave 0 landed
-- 0007_users_email_verified_and_token_revocation.sql first). The SQL is the plan's, except that the two section-11
-- triggers also refuse a changed_by / actor_uid reassignment (only the ON DELETE SET NULL action may change them).
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
--     redacted_at stamped). The attribution columns (changed_by, actor_uid) may only become NULL, which is
--     the users(id) ON DELETE SET NULL action; reassigning a row to another user aborts, and so does a
--     users.id rename that would cascade into them (a Firebase uid never changes).
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
  OR (NEW.changed_by IS NOT OLD.changed_by AND NEW.changed_by IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_STATUS_HISTORY');
END;

CREATE TRIGGER trg_booking_events_redact_only BEFORE UPDATE ON booking_events
WHEN NEW.id IS NOT OLD.id
  OR NEW.booking_id IS NOT OLD.booking_id
  OR NEW.actor IS NOT OLD.actor
  OR (NEW.actor_uid IS NOT OLD.actor_uid AND NEW.actor_uid IS NOT NULL)
  OR NEW.event IS NOT OLD.event
  OR NEW.subject_id IS NOT OLD.subject_id
  OR NEW.details IS NOT OLD.details
  OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.note IS NOT OLD.note AND NOT (NEW.note IS NULL AND NEW.redacted_at IS NOT NULL))
  OR (NEW.redacted_at IS NOT OLD.redacted_at AND OLD.redacted_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_EVENTS');
END;
