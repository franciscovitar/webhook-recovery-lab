import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { guestSessionLimits, guestTokenDigest, newGuestToken } from '../core/guest-session.js';

export interface GuestWorkspace {
  id: string;
  created_at: Date;
  expires_at: Date;
}

export type GuestAdmission =
  { status: 'created'; workspace: GuestWorkspace; token: string } | { status: 'capacity' };

export interface WorkspaceCleanupItem {
  workspace_id: string;
}

export class PostgresGuestWorkspaceStore {
  constructor(private readonly pool: Pool) {}

  /** Serialize admission globally; take DB time after obtaining the lock. */
  async create(): Promise<GuestAdmission> {
    const token = newGuestToken();
    const digest = guestTokenDigest(token);
    if (!digest) throw new Error('Could not generate guest credential');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query('SELECT pg_advisory_xact_lock(8071135)');
      const admitted = await client.query<GuestWorkspace>(
        `WITH instant AS (SELECT clock_timestamp() AS t)
         INSERT INTO guest_workspaces (id, token_sha256, created_at, expires_at)
         SELECT $1, $2, t, t + ($5::int * interval '1 hour') FROM instant
         WHERE (SELECT count(*) FROM guest_workspaces
                WHERE closed_at IS NULL AND expires_at > t) < $3::int
           AND (SELECT count(*) FROM guest_workspaces
                WHERE created_at > t - interval '1 hour') < $4::int
         RETURNING id, created_at, expires_at`,
        [
          randomUUID(),
          digest,
          guestSessionLimits.active,
          guestSessionLimits.startsPerHour,
          guestSessionLimits.ttlHours,
        ],
      );
      const workspace = admitted.rows[0];
      await client.query('COMMIT');
      return workspace ? { status: 'created', workspace, token } : { status: 'capacity' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findActive(token: unknown): Promise<GuestWorkspace | null> {
    const digest = guestTokenDigest(token);
    if (!digest) return null;
    const result = await this.pool.query<GuestWorkspace>(
      `SELECT id, created_at, expires_at FROM guest_workspaces
       WHERE token_sha256 = $1 AND closed_at IS NULL AND expires_at > clock_timestamp()`,
      [digest],
    );
    return result.rows[0] ?? null;
  }

  /** Close and purge expired spaces in small batches, deferring any live lease. */
  async stageExpired(limit = 10): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM guest_workspaces
          WHERE closed_at IS NULL AND expires_at <= clock_timestamp()
          ORDER BY expires_at, id LIMIT $1`,
        [limit],
      );
      let staged = 0;
      for (const candidate of candidates.rows) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [candidate.id]);
        const current = await client.query<{ id: string }>(
          `SELECT id FROM guest_workspaces w
            WHERE id = $1 AND closed_at IS NULL AND expires_at <= clock_timestamp()
              AND NOT EXISTS (
                SELECT 1 FROM inbox_events e JOIN delivery_jobs j ON j.inbox_event_id = e.id
                 WHERE e.workspace_id = w.id AND j.status = 'LEASED' AND j.lease_until > clock_timestamp()
              ) FOR UPDATE`,
          [candidate.id],
        );
        if (!current.rowCount) continue;
        await client.query(`UPDATE guest_workspaces SET closed_at = clock_timestamp() WHERE id = $1`, [
          candidate.id,
        ]);
        await client.query(
          `INSERT INTO workspace_cleanup_queue (workspace_id) VALUES ($1) ON CONFLICT DO NOTHING`,
          [candidate.id],
        );
        await client.query('DELETE FROM replay_audit WHERE workspace_id = $1', [candidate.id]);
        await client.query(
          `DELETE FROM delivery_attempts a USING delivery_jobs j, inbox_events e
          WHERE a.job_id = j.id AND j.inbox_event_id = e.id AND e.workspace_id = $1`,
          [candidate.id],
        );
        await client.query(
          `DELETE FROM delivery_jobs j USING inbox_events e
          WHERE j.inbox_event_id = e.id AND e.workspace_id = $1`,
          [candidate.id],
        );
        await client.query('DELETE FROM inbox_events WHERE workspace_id = $1', [candidate.id]);
        await client.query(
          'UPDATE workspace_cleanup_queue SET gateway_cleaned_at = clock_timestamp() WHERE workspace_id = $1',
          [candidate.id],
        );
        staged++;
      }
      await client.query('COMMIT');
      return staged;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listPendingCleanup(limit = 20): Promise<WorkspaceCleanupItem[]> {
    const result = await this.pool.query<WorkspaceCleanupItem>(
      `SELECT workspace_id FROM workspace_cleanup_queue WHERE gateway_cleaned_at IS NOT NULL
        ORDER BY queued_at, workspace_id LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  async finalizeCleanup(workspaceId: string): Promise<void> {
    await this.pool.query('DELETE FROM guest_workspaces WHERE id = $1 AND closed_at IS NOT NULL', [
      workspaceId,
    ]);
  }

  async hasDelivery(deliveryId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 FROM delivery_jobs WHERE delivery_id = $1', [deliveryId]);
    return Boolean(result.rowCount);
  }

  /** Atomic per-space hourly budget, also rejects a closed or expired space. */
  async consumeMutation(workspaceId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [workspaceId]);
      const active = await client.query(
        `SELECT 1 FROM guest_workspaces
        WHERE id = $1 AND closed_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
        [workspaceId],
      );
      if (!active.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      const result = await client.query(
        `INSERT INTO workspace_mutation_budgets (workspace_id, window_started_at, mutation_count)
        VALUES ($1, clock_timestamp(), 1)
        ON CONFLICT (workspace_id) DO UPDATE SET
          mutation_count = CASE WHEN workspace_mutation_budgets.window_started_at <= clock_timestamp() - interval '1 hour' THEN 1 ELSE workspace_mutation_budgets.mutation_count + 1 END,
          window_started_at = CASE WHEN workspace_mutation_budgets.window_started_at <= clock_timestamp() - interval '1 hour' THEN clock_timestamp() ELSE workspace_mutation_budgets.window_started_at END
        WHERE workspace_mutation_budgets.window_started_at <= clock_timestamp() - interval '1 hour'
           OR workspace_mutation_budgets.mutation_count < 20 RETURNING workspace_id`,
        [workspaceId],
      );
      await client.query(result.rowCount ? 'COMMIT' : 'ROLLBACK');
      return Boolean(result.rowCount);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
