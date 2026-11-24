-- Receiver and gateway stay in separate logical databases; identity is carried
-- only over the authenticated, fixed internal delivery contract.
ALTER TABLE receiver_receipts ADD COLUMN workspace_id UUID;
CREATE INDEX ix_receiver_receipts_workspace
  ON receiver_receipts (workspace_id, created_at DESC) WHERE workspace_id IS NOT NULL;
