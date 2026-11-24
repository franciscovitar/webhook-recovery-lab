ALTER TABLE inbox_events
  ADD COLUMN raw_body BYTEA,
  ADD COLUMN signature_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE workspace_mutation_budgets (
    workspace_id UUID PRIMARY KEY REFERENCES guest_workspaces(id) ON DELETE CASCADE,
    window_started_at TIMESTAMPTZ NOT NULL,
    mutation_count SMALLINT NOT NULL CHECK (mutation_count BETWEEN 0 AND 20)
);

CREATE TABLE workspace_cleanup_queue (
    workspace_id UUID PRIMARY KEY REFERENCES guest_workspaces(id) ON DELETE CASCADE,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    gateway_cleaned_at TIMESTAMPTZ
);

CREATE INDEX workspace_cleanup_pending_idx
  ON workspace_cleanup_queue (queued_at)
  WHERE gateway_cleaned_at IS NOT NULL;
