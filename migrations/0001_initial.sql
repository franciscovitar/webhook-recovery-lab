CREATE TABLE inbox_events (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'sandbox'),
  event_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'order.created'),
  occurred_at TIMESTAMPTZ NOT NULL,
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inbox_provider_event UNIQUE (provider, event_id)
);

CREATE TABLE delivery_jobs (
  id UUID PRIMARY KEY,
  inbox_event_id UUID NOT NULL REFERENCES inbox_events(id) ON DELETE RESTRICT,
  delivery_id UUID NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  total_attempts INTEGER NOT NULL DEFAULT 0,
  attempts_in_generation INTEGER NOT NULL DEFAULT 0,
  replay_generation INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_error_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_job_inbox UNIQUE (inbox_event_id),
  CONSTRAINT ck_job_status CHECK (status IN ('PENDING', 'LEASED', 'SUCCEEDED', 'DEAD')),
  CONSTRAINT ck_job_counters CHECK (
    total_attempts >= 0 AND attempts_in_generation >= 0
    AND replay_generation >= 0 AND total_attempts >= attempts_in_generation
  ),
  CONSTRAINT ck_job_lease_consistent CHECK (
    (status = 'LEASED' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'LEASED' AND lease_token IS NULL AND lease_until IS NULL)
  )
);

CREATE INDEX ix_jobs_pending_due
  ON delivery_jobs (next_attempt_at, id) WHERE status = 'PENDING';
CREATE INDEX ix_jobs_expired_leases
  ON delivery_jobs (lease_until, id) WHERE status = 'LEASED';

CREATE TABLE delivery_attempts (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
  replay_generation INTEGER NOT NULL CHECK (replay_generation >= 0),
  lease_token UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  result TEXT NOT NULL,
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  latency_ms INTEGER CHECK (latency_ms >= 0),
  error_class TEXT,
  CONSTRAINT uq_attempt_sequence UNIQUE (job_id, attempt_sequence),
  CONSTRAINT ck_attempt_result CHECK (
    result IN ('STARTED', 'SUCCEEDED', 'RETRY', 'DEAD', 'ABANDONED', 'STALE_ACK')
  ),
  CONSTRAINT ck_attempt_finished CHECK (
    (result = 'STARTED' AND finished_at IS NULL)
    OR (result <> 'STARTED' AND finished_at IS NOT NULL)
  )
);

CREATE TABLE replay_audit (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES delivery_jobs(id) ON DELETE RESTRICT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 4 AND 256),
  previous_total_attempts INTEGER NOT NULL CHECK (previous_total_attempts >= 0),
  new_generation INTEGER NOT NULL CHECK (new_generation > 0),
  CONSTRAINT uq_replay_generation UNIQUE (job_id, new_generation)
);
