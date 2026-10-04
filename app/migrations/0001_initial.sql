PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer'
    CHECK (role IN ('customer', 'admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE blocked_dates (
  event_date TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(event_date) = 10
      AND event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(event_date) = event_date
    ),
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
);

CREATE TABLE booking_requests (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  event_date TEXT NOT NULL
    CHECK (
      length(event_date) = 10
      AND event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(event_date) = event_date
    ),
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
    CHECK (
      typeof(estimated_total) = 'integer'
      AND estimated_total >= 0
    ),
  admin_notes TEXT,
  hold_expires_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_booking_requests_blocking_event_date
  ON booking_requests(event_date)
  WHERE status IN (
    'approved_hold',
    'contract_pending',
    'contract_signed',
    'payment_pending',
    'confirmed'
  );

CREATE INDEX idx_booking_requests_user_id
  ON booking_requests(user_id);

CREATE INDEX idx_booking_requests_event_date
  ON booking_requests(event_date);

CREATE INDEX idx_booking_requests_status
  ON booking_requests(status);

CREATE INDEX idx_booking_requests_hold_expires_at
  ON booking_requests(hold_expires_at);

CREATE TABLE booking_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL,
  from_status TEXT
    CHECK (
      from_status IS NULL
      OR from_status IN (
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
  to_status TEXT NOT NULL
    CHECK (
      to_status IN (
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
  changed_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (booking_id)
    REFERENCES booking_requests(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  FOREIGN KEY (changed_by)
    REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE SET NULL
);

CREATE INDEX idx_booking_status_history_booking_id
  ON booking_status_history(booking_id);