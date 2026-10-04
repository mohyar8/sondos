CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_requests_user_event_date_open
ON booking_requests (user_id, event_date)
WHERE status IN (
  'pending_review',
  'approved_hold',
  'contract_pending',
  'contract_signed',
  'payment_pending',
  'confirmed'
);