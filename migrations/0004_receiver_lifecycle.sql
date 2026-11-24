ALTER TABLE receiver_attempt_counts ADD COLUMN workspace_id UUID;
UPDATE receiver_attempt_counts attempts
   SET workspace_id = receipts.workspace_id
  FROM receiver_receipts receipts
 WHERE receipts.delivery_id = attempts.delivery_id AND receipts.workspace_id IS NOT NULL;
ALTER TABLE receiver_fault_plans
  ADD COLUMN prepared_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

CREATE TABLE receiver_closed_workspaces (
    workspace_id UUID PRIMARY KEY,
    closed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX ix_receiver_fault_plans_prepared
  ON receiver_fault_plans (prepared_at, delivery_id)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX ix_receiver_attempt_counts_workspace
  ON receiver_attempt_counts (workspace_id, last_attempt_at)
  WHERE workspace_id IS NOT NULL;
