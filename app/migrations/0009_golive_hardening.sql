-- 0009_golive_hardening.sql
-- Plan 11 section 2.4 (drafted there as 0008_golive_hardening.sql; numbered 0009 for the same reason as 0008).
-- Changes from the plan: users.email_verified_at and users.tokens_valid_after are not added here (section 2);
-- the effective_at bound is 72 h instead of 24 h (section 3, GAP-05); blocked_origin is origin-only (section 5);
-- section 7 (no rewrite through INSERT OR REPLACE, and no key outside the table's sequence) is added.
-- Go-live hardening from 10-security-baseline (C-2, C-10, C-14), 13-threat-model (TM-03, TM-07, TM-08, TM-17)
-- and the plan reviews (B1, H3, L2, UX-06). EXPAND ONLY: ADD COLUMN, CREATE TABLE / INDEX / TRIGGER and
-- vocabulary INSERTs. Requires 0008. Instants are 'YYYY-MM-DDTHH:MM:SS.sssZ' (UTC).

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

-- 2. users: a marker for "phone or email changed" that the admin sees next to bookings created before it (TM-08).
--    The plan's other two users columns already exist and are NOT added again: Wave 0's
--    0007_users_email_verified_and_token_revocation.sql added users.email_verified_at (C-2: the Worker writes it
--    only from a verified token; the same ISO-8601 TEXT and CHECK as the plan) and users.tokens_valid_after
--    (C-14 / TM-07: tokens whose auth_time is earlier are refused), which is INTEGER Unix seconds there,
--    compared with the token's auth_time, instead of the plan's ISO-8601 TEXT.
ALTER TABLE users ADD COLUMN contact_changed_at TEXT
  CHECK (contact_changed_at IS NULL OR (length(contact_changed_at) = 24 AND substr(contact_changed_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', contact_changed_at) IS contact_changed_at));

-- 3. Delayed activation (TM-03): a bank or contact revision that replaces an existing one takes effect at
--    effective_at (created_at + 24 h, or + 72 h when the other of the two sections changed in the 30 days
--    before: GAP-05) unless the token carried a second factor. NULL = effective at created_at.
--    Bounded to 72 h so the column cannot hide a far-future revision.
ALTER TABLE settings_revisions ADD COLUMN effective_at TEXT
  CHECK (
    effective_at IS NULL
    OR (
      section IN ('bank', 'contact')
      AND length(effective_at) = 24 AND substr(effective_at, 12, 2) < '24'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', effective_at) IS effective_at
      AND (julianday(effective_at) - julianday(created_at)) * 86400 BETWEEN 0 AND 259200.5
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

-- 5. CSP violation counts (C-10, TM-17): directive and blocked origin only, never a full URL. blocked_origin is
--    either a keyword the report route reduces a non-URL to (inline, eval, data, blob, …: letters and '-' only,
--    so never a host, number or identifier) or a scheme://host[:port] origin with nothing after the authority.
CREATE TABLE csp_report_counts (
  day TEXT NOT NULL CHECK (length(day) = 10 AND date(day) IS day),
  directive TEXT NOT NULL CHECK (length(directive) BETWEEN 3 AND 40 AND directive NOT GLOB '*[^a-z-]*'),
  blocked_origin TEXT NOT NULL
    CHECK (
      length(blocked_origin) BETWEEN 1 AND 120
      AND blocked_origin NOT GLOB '*[^a-z0-9.:/-]*'
      AND (
        (length(blocked_origin) <= 40 AND blocked_origin GLOB '[a-z]*' AND blocked_origin NOT GLOB '*[^a-z-]*')
        OR (
          instr(blocked_origin, '://') > 1
          AND substr(blocked_origin, 1, instr(blocked_origin, '://') - 1) NOT GLOB '*[^a-z]*'
          AND substr(blocked_origin, instr(blocked_origin, '://') + 3) GLOB '[a-z0-9]*'
          AND instr(substr(blocked_origin, instr(blocked_origin, '://') + 3), '/') = 0
        )
      )
    ),
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

-- 7. No rewrite through REPLACE (SB-10, L2, TM-03). INSERT OR REPLACE removes the row that holds the same key
--    without running its DELETE triggers (D1 runs with recursive_triggers off), so the UPDATE and DELETE triggers
--    alone let `INSERT OR REPLACE … (id, …)` overwrite an append-only row in place. An INSERT that names a key
--    that already exists therefore aborts, whatever its conflict clause (OR REPLACE, OR IGNORE, ON CONFLICT);
--    an INSERT that leaves the key to SQLite, as every writer does, is unaffected. The guards cover every unique
--    key of these tables: the INTEGER PRIMARY KEY, and for terms_versions its version, seq and implicit rowid.
--    A UNIQUE index added to one of these tables later must be added to its guard.
--    A BEFORE INSERT trigger reads a key that SQLite has not assigned yet as -1, so the key-exists guards cannot
--    tell it from an explicit -1: a row stored at -1 would make every later INSERT look like a rewrite. A row at
--    the top of the 64-bit range would make every later INSERT fail with SQLITE_FULL. Neither row could be
--    deleted, so one INSERT that names such a key would stop the table for good. The AFTER INSERT guards (fix
--    round 2) see the key the row got and refuse one below 1, or more than 1 000 000 000 above the next lower key.
--    SQLite assigns the largest key used + 1 (the gap left by rows deleted before 0009 is far smaller), so no
--    writer is affected; the lookup is one seek on the primary key.
CREATE TRIGGER trg_settings_revisions_no_replace BEFORE INSERT ON settings_revisions
WHEN EXISTS (SELECT 1 FROM settings_revisions WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_SETTINGS_REVISIONS');
END;

CREATE TRIGGER trg_terms_versions_no_replace BEFORE INSERT ON terms_versions
WHEN EXISTS (SELECT 1 FROM terms_versions WHERE version = NEW.version)
  OR EXISTS (SELECT 1 FROM terms_versions WHERE seq = NEW.seq)
  OR EXISTS (SELECT 1 FROM terms_versions WHERE rowid = NEW.rowid)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_TERMS_VERSIONS');
END;

CREATE TRIGGER trg_admin_audit_log_no_replace BEFORE INSERT ON admin_audit_log
WHEN EXISTS (SELECT 1 FROM admin_audit_log WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_ADMIN_AUDIT_LOG');
END;

CREATE TRIGGER trg_booking_status_history_no_replace BEFORE INSERT ON booking_status_history
WHEN EXISTS (SELECT 1 FROM booking_status_history WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_STATUS_HISTORY');
END;

CREATE TRIGGER trg_booking_events_no_replace BEFORE INSERT ON booking_events
WHEN EXISTS (SELECT 1 FROM booking_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_EVENTS');
END;

CREATE TRIGGER trg_ops_switch_revisions_no_replace BEFORE INSERT ON ops_switch_revisions
WHEN EXISTS (SELECT 1 FROM ops_switch_revisions WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_OPS_SWITCH_REVISIONS');
END;

CREATE TRIGGER trg_settings_revisions_key_range AFTER INSERT ON settings_revisions
WHEN NEW.id < 1
  OR NEW.id > COALESCE((SELECT id FROM settings_revisions WHERE id < NEW.id ORDER BY id DESC LIMIT 1), 0) + 1000000000
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_SETTINGS_REVISIONS');
END;

CREATE TRIGGER trg_terms_versions_key_range AFTER INSERT ON terms_versions
WHEN NEW.rowid < 1
  OR NEW.rowid > COALESCE((SELECT rowid FROM terms_versions WHERE rowid < NEW.rowid ORDER BY rowid DESC LIMIT 1), 0) + 1000000000
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_TERMS_VERSIONS');
END;

CREATE TRIGGER trg_admin_audit_log_key_range AFTER INSERT ON admin_audit_log
WHEN NEW.id < 1
  OR NEW.id > COALESCE((SELECT id FROM admin_audit_log WHERE id < NEW.id ORDER BY id DESC LIMIT 1), 0) + 1000000000
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_ADMIN_AUDIT_LOG');
END;

CREATE TRIGGER trg_booking_status_history_key_range AFTER INSERT ON booking_status_history
WHEN NEW.id < 1
  OR NEW.id > COALESCE((SELECT id FROM booking_status_history WHERE id < NEW.id ORDER BY id DESC LIMIT 1), 0) + 1000000000
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_STATUS_HISTORY');
END;

CREATE TRIGGER trg_booking_events_key_range AFTER INSERT ON booking_events
WHEN NEW.id < 1
  OR NEW.id > COALESCE((SELECT id FROM booking_events WHERE id < NEW.id ORDER BY id DESC LIMIT 1), 0) + 1000000000
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BOOKING_EVENTS');
END;

CREATE TRIGGER trg_ops_switch_revisions_key_range AFTER INSERT ON ops_switch_revisions
WHEN NEW.id < 1
  OR NEW.id > COALESCE((SELECT id FROM ops_switch_revisions WHERE id < NEW.id ORDER BY id DESC LIMIT 1), 0) + 1000000000
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_OPS_SWITCH_REVISIONS');
END;
