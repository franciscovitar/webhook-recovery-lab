ALTER TABLE receiver_fault_plans ADD COLUMN workspace_id UUID;
CREATE INDEX ix_receiver_fault_plans_workspace
  ON receiver_fault_plans (workspace_id, delivery_id) WHERE workspace_id IS NOT NULL;
