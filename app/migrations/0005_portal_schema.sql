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
