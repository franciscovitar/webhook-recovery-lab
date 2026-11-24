import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Pool } from 'pg';

export const gatewayMigrations = [
  '0001_initial',
  '0002_guest_workspaces',
  '0003_scope_events_to_workspaces',
  '0004_workspace_replay_idempotency',
  '0005_workspace_lifecycle',
] as const;
export const receiverMigrations = [
  '0001_receiver',
  '0002_receiver_workspace_identity',
  '0003_receiver_workspace_fault_plans',
  '0004_receiver_lifecycle',
] as const;

/** Readiness is true only when every migration expected by this binary is recorded. */
export class PostgresMigrationReadiness {
  constructor(
    private readonly pool: Pool,
    private readonly expected: readonly string[],
  ) {}
  async ping(): Promise<void> {
    const result = await this.pool.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(result.rows.map((row) => row.version));
    const missing = this.expected.filter((version) => !applied.has(version));
    if (missing.length) throw new Error(`Database migrations missing: ${missing.join(', ')}`);
  }
}

// Explicit manifests keep the two databases independent.
export async function applyMigrations(
  pool: Pool,
  lockId: number,
  versions: readonly string[],
): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    for (const version of versions) {
      const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (existing.rows.length > 0) continue;
      const ddl = await readFile(resolve(process.cwd(), 'migrations', `${version}.sql`), 'utf8');
      await client.query(ddl);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      applied.push(version);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
