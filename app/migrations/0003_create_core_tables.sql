PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer', 'admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blocked_dates (
  event_date TEXT PRIMARY KEY
    CHECK (length(event_date) = 10),
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS booking_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_date TEXT NOT NULL
    CHECK (length(event_date) = 10),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (
      status IN (
        'pending_review',
        'approved_hold',
        'contract_pending',
        'contract_signed',
        'payment_pending',
        'confirmed',
        'rejected',
        'cancelled',
        'expired'
      )
    ),
  package_snapshot TEXT NOT NULL
    CHECK (json_valid(package_snapshot)),
  estimated_total INTEGER NOT NULL
    CHECK (estimated_total >= 0),
  admin_notes TEXT,
  hold_expires_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS booking_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id)
    REFERENCES booking_requests(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_booking_requests_user_id
  ON booking_requests(user_id);

CREATE INDEX IF NOT EXISTS idx_booking_requests_event_date
  ON booking_requests(event_date);

CREATE INDEX IF NOT EXISTS idx_booking_requests_status
  ON booking_requests(status);

CREATE INDEX IF NOT EXISTS idx_booking_requests_hold_expires_at
  ON booking_requests(hold_expires_at);

CREATE INDEX IF NOT EXISTS idx_booking_status_history_booking_id
  ON booking_status_history(booking_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_requests_blocking_event_date
  ON booking_requests(event_date)
  WHERE status IN (
    'approved_hold',
    'contract_pending',
    'contract_signed',
    'payment_pending',
    'confirmed'
  );