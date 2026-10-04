-- [file] 0007_users_email_verified_and_token_revocation.sql
-- EXPAND ONLY: two nullable ADD COLUMNs on users. Nothing is dropped, renamed or rewritten, and no row
-- changes, so the Worker before this change keeps working with it applied. Apply it BEFORE deploying the
-- Worker that reads these columns. (SQLite has no ADD COLUMN IF NOT EXISTS; wrangler's d1_migrations table
-- is what keeps this file from running twice.)

-- 1. users.email_verified_at (audit SEC-04, SEC-01c). When users.email was last taken from a Firebase ID
--    token with email_verified = true. NULL means the stored address was never proven: an unverified token
--    may create the row at registration but never changes the address afterwards, and a verified caller may
--    reclaim an address held by an unverified, booking-less customer row (worker/users.ts). Existing rows
--    start NULL and are stamped on their owner's next verified request; no backfill guesses at them.
--    Instants use the 0005 format: 'YYYY-MM-DDTHH:MM:SS.sssZ' checked with IS, so a NULL from strftime()
--    never passes.
ALTER TABLE users ADD COLUMN email_verified_at TEXT
  CHECK (
    email_verified_at IS NULL
    OR (length(email_verified_at) = 24 AND substr(email_verified_at, 12, 2) < '24' AND strftime('%Y-%m-%dT%H:%M:%fZ', email_verified_at) IS email_verified_at)
  );

-- 2. users.tokens_valid_after (audit SEC-11). Unix seconds. A Firebase ID token whose sign-in (auth_time)
--    is earlier is refused wherever the users row is loaded (admin guard, profile, bookings, portal); a
--    refreshed token keeps its session's auth_time, so a stolen refresh token cannot mint a token that
--    passes. Set only by the incident runbook (scripts/revoke-sessions.mjs, from D1's clock) after the
--    Firebase password reset; NULL means no revocation was ever recorded.
ALTER TABLE users ADD COLUMN tokens_valid_after INTEGER
  CHECK (
    tokens_valid_after IS NULL
    OR (typeof(tokens_valid_after) = 'integer' AND tokens_valid_after >= 0)
  );
