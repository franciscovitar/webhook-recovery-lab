ALTER TABLE replay_audit
  ADD COLUMN workspace_id UUID REFERENCES guest_workspaces(id) ON DELETE CASCADE,
  ADD COLUMN request_id UUID;

CREATE UNIQUE INDEX uq_replay_workspace_request
  ON replay_audit (workspace_id, request_id)
  WHERE workspace_id IS NOT NULL AND request_id IS NOT NULL;
