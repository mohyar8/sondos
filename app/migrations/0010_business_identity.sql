-- 0010_business_identity.sql
-- W1 gate carry-over GAP-03 (decision D19(d)), written by W2-01: storage for the seller identity the e-commerce
-- disclosure names, entered by the owner in the admin settings (PUT /api/admin/settings/identity) and shown on the
-- public page only once filled. EXPAND ONLY: CREATE TABLE and CREATE TRIGGER; nothing is dropped, renamed or
-- rewritten. Requires 0008 (users) and 0009 (its section-7 guard pattern). Instants are 'YYYY-MM-DDTHH:MM:SS.sssZ'.
--
-- The 0008 settings model: one immutable row per save, the current identity is the row with the highest id,
-- created_at is stamped by SQL and reauth_at (the Firebase auth_time of the token that saved it) is required and
-- at most 10 minutes earlier. A new table rather than a fifth settings_revisions section: widening that table's
-- section CHECK would rebuild it. The CHECKs are the shared/settings.ts parseBusinessIdentityInput rules
-- (legal name 2 to 120 code points on one line without control characters; licence number 4 to 32 of
-- [0-9A-Z-] in groups joined by single hyphens with at least one digit; the three VAT statuses). The content
-- rules no CHECK can express are re-run by the reader (readStoredBusinessIdentity), which reads a failing row as
-- not filled. No admin_audit_actions row is added: shared/audit.ts has no builder for it (tests compare the two).
CREATE TABLE business_identity_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legal_name TEXT
    CHECK (legal_name IS NULL OR (length(legal_name) BETWEEN 2 AND 120 AND legal_name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*'))),
  licence_number TEXT
    CHECK (
      licence_number IS NULL
      OR (
        length(licence_number) BETWEEN 4 AND 32
        AND licence_number NOT GLOB '*[^0-9A-Z-]*'
        AND licence_number GLOB '*[0-9]*'
        AND licence_number NOT GLOB '-*'
        AND licence_number NOT GLOB '*-'
        AND instr(licence_number, '--') = 0
      )
    ),
  vat_status TEXT NOT NULL CHECK (vat_status IN ('registered', 'not_registered', 'unknown')),
  created_by TEXT NOT NULL
    REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reauth_at TEXT NOT NULL
    CHECK (length(reauth_at) = 24 AND substr(reauth_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', reauth_at) IS reauth_at),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND substr(created_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK ((julianday(created_at) - julianday(reauth_at)) * 1440 BETWEEN 0 AND 10)
);

-- Append-only, as settings_revisions (0008 section 11, 0009 section 7): no UPDATE, no DELETE, no rewrite through
-- INSERT OR REPLACE (a key that already exists aborts whatever the conflict clause), and no key below 1 or more than
-- 1 000 000 000 above the next lower key (a row at -1 or at the top of the range would stop the table for good).
CREATE TRIGGER trg_business_identity_revisions_no_update BEFORE UPDATE ON business_identity_revisions
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS');
END;

CREATE TRIGGER trg_business_identity_revisions_no_delete BEFORE DELETE ON business_identity_revisions
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS');
END;

CREATE TRIGGER trg_business_identity_revisions_no_replace BEFORE INSERT ON business_identity_revisions
WHEN EXISTS (SELECT 1 FROM business_identity_revisions WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS');
END;

CREATE TRIGGER trg_business_identity_revisions_key_range AFTER INSERT ON business_identity_revisions
WHEN NEW.id < 1
  OR NEW.id > COALESCE((SELECT id FROM business_identity_revisions WHERE id < NEW.id ORDER BY id DESC LIMIT 1), 0) + 1000000000
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY_BUSINESS_IDENTITY_REVISIONS');
END;
