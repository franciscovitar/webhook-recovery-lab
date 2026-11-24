-- Keep pre-workspace rows addressable while isolating every new guest's event IDs.
ALTER TABLE inbox_events
  ADD COLUMN workspace_id UUID REFERENCES guest_workspaces(id) ON DELETE CASCADE;

ALTER TABLE inbox_events DROP CONSTRAINT uq_inbox_provider_event;

CREATE UNIQUE INDEX uq_inbox_legacy_provider_event
  ON inbox_events (provider, event_id) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX uq_inbox_workspace_provider_event
  ON inbox_events (workspace_id, provider, event_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX ix_inbox_workspace_received
  ON inbox_events (workspace_id, received_at DESC, id) WHERE workspace_id IS NOT NULL;
