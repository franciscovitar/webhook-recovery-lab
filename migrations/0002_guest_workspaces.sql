-- Additive foundation only. Legacy inbox and receiver contracts stay unchanged.
CREATE TABLE guest_workspaces (
    id UUID PRIMARY KEY,
    token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    closed_at TIMESTAMPTZ,
    CHECK (expires_at > created_at),
    CHECK (closed_at IS NULL OR closed_at >= created_at)
);
CREATE INDEX guest_workspaces_created_idx ON guest_workspaces (created_at);
CREATE INDEX guest_workspaces_active_expiry_idx ON guest_workspaces (expires_at)
    WHERE closed_at IS NULL;
