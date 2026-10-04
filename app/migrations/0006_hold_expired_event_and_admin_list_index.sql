-- [file] 0006_hold_expired_event_and_admin_list_index.sql
-- EXPAND ONLY. Safe on every database that has 0005 applied; both statements are idempotent.

-- 1. worker/jobs/hold-expiry.ts writes a booking_events row (actor 'system') with kind
--    'hold_expired' when it expires a flow-2 hold. 0005 did not seed that kind, so until now the
--    job skipped the event row (the status-history row was always written).
INSERT INTO event_kinds (kind)
SELECT 'hold_expired'
WHERE NOT EXISTS (SELECT 1 FROM event_kinds WHERE kind = 'hold_expired');

-- 2. GET /api/admin/bookings now pages with a keyset cursor: ORDER BY created_at DESC, id DESC and
--    a seek on (created_at, id). created_at is an ISO-8601 string, so it sorts chronologically.
CREATE INDEX IF NOT EXISTS idx_booking_requests_created_id
  ON booking_requests (created_at, id);
