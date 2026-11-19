CREATE TABLE receiver_attempt_counts (
  delivery_id UUID PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE receiver_receipts (
  delivery_id UUID PRIMARY KEY,
  event_id UUID NOT NULL,
  order_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the synthetic test harness writes fault plans, never public HTTP requests.
CREATE TABLE receiver_fault_plans (
  delivery_id UUID PRIMARY KEY,
  transient_remaining INTEGER NOT NULL DEFAULT 0 CHECK (transient_remaining >= 0),
  transient_status INTEGER NOT NULL DEFAULT 503
    CHECK (transient_status IN (408, 429, 500, 502, 503, 504)),
  permanent_status INTEGER CHECK (permanent_status IN (400, 401, 403, 404, 422)),
  delay_after_commit_ms INTEGER NOT NULL DEFAULT 0
    CHECK (delay_after_commit_ms BETWEEN 0 AND 5000)
);
