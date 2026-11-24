import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { ClaimedJob, DeliveryOutcome, DeliveryStore } from '../core/delivery.js';
import { sandboxEventSchema } from '../core/event.js';

const LEASE_MS = 15_000;
const MAX_ATTEMPTS_PER_GENERATION = 5;

interface CandidateRow {
  id: string;
  status: 'PENDING' | 'LEASED';
  lease_token: string | null;
  total_attempts: number;
  attempts_in_generation: number;
  replay_generation: number;
  delivery_id: string;
  workspace_id: string | null;
  event_id: string;
  payload: unknown;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}

export class PostgresDeliveryStore implements DeliveryStore {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async nextWorkDelayMs(): Promise<number | null> {
    const result = await this.pool.query<{ delay_ms: number | null }>(
      `SELECT GREATEST(0, floor(EXTRACT(EPOCH FROM (min(due_at) - clock_timestamp())) * 1000))::int AS delay_ms
         FROM (
           SELECT next_attempt_at AS due_at FROM delivery_jobs WHERE status = 'PENDING'
           UNION ALL
           SELECT lease_until AS due_at FROM delivery_jobs WHERE status = 'LEASED'
         ) due`,
    );
    return result.rows[0]?.delay_ms ?? null;
  }

  /** One short transaction claims a due/expired job; HTTP happens after COMMIT. */
  async claimNext(): Promise<ClaimedJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query<CandidateRow>(
        `SELECT j.id, j.status, j.lease_token, j.total_attempts,
                j.attempts_in_generation, j.replay_generation, j.delivery_id, e.workspace_id,
                e.event_id, e.payload
           FROM delivery_jobs j JOIN inbox_events e ON e.id = j.inbox_event_id
          WHERE (j.status = 'PENDING' AND j.next_attempt_at <= clock_timestamp())
             OR (j.status = 'LEASED' AND j.lease_until <= clock_timestamp())
          ORDER BY COALESCE(j.lease_until, j.next_attempt_at), j.id
          LIMIT 1
          FOR UPDATE OF j SKIP LOCKED`,
      );
      const row = candidates.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }

      if (row.status === 'LEASED' && row.lease_token) {
        await client.query(
          `UPDATE delivery_attempts
              SET result = 'ABANDONED', finished_at = clock_timestamp(), error_class = 'lease_expired'
            WHERE job_id = $1 AND lease_token = $2 AND result = 'STARTED'`,
          [row.id, row.lease_token],
        );
      }

      if (row.attempts_in_generation >= MAX_ATTEMPTS_PER_GENERATION) {
        await client.query(
          `UPDATE delivery_jobs SET status = 'DEAD', lease_token = NULL,
                  lease_until = NULL, last_error_class = 'retry_budget_exhausted',
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [row.id],
        );
        await client.query('COMMIT');
        return null;
      }

      const leaseToken = randomUUID();
      const attemptSequence = row.total_attempts + 1;
      const attemptsInGeneration = row.attempts_in_generation + 1;
      await client.query(
        `UPDATE delivery_jobs
            SET status = 'LEASED', lease_token = $2,
                lease_until = clock_timestamp() + ($3::int * INTERVAL '1 millisecond'),
                total_attempts = $4, attempts_in_generation = $5,
                updated_at = clock_timestamp()
          WHERE id = $1`,
        [row.id, leaseToken, LEASE_MS, attemptSequence, attemptsInGeneration],
      );
      await client.query(
        `INSERT INTO delivery_attempts
           (id, job_id, attempt_sequence, replay_generation, lease_token, result)
         VALUES ($1, $2, $3, $4, $5, 'STARTED')`,
        [randomUUID(), row.id, attemptSequence, row.replay_generation, leaseToken],
      );
      await client.query('COMMIT');

      return {
        jobId: row.id,
        ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
        deliveryId: row.delivery_id,
        eventId: row.event_id,
        leaseToken,
        attemptSequence,
        attemptsInGeneration,
        replayGeneration: row.replay_generation,
        event: sandboxEventSchema.parse(row.payload),
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Fencing token prevents a stale worker from overwriting the current owner. */
  async finish(job: ClaimedJob, outcome: DeliveryOutcome, retryDelayMs: number): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{
        status: string;
        lease_token: string | null;
        attempts_in_generation: number;
      }>('SELECT status, lease_token, attempts_in_generation FROM delivery_jobs WHERE id = $1 FOR UPDATE', [
        job.jobId,
      ]);
      const current = selected.rows[0];
      if (!current || current.status !== 'LEASED' || current.lease_token !== job.leaseToken) {
        await client.query('COMMIT');
        return false;
      }

      const hasBudget = current.attempts_in_generation < MAX_ATTEMPTS_PER_GENERATION;
      const newStatus =
        outcome.kind === 'success' ? 'SUCCEEDED' : outcome.kind === 'retry' && hasBudget ? 'PENDING' : 'DEAD';
      const attemptResult =
        newStatus === 'SUCCEEDED' ? 'SUCCEEDED' : newStatus === 'PENDING' ? 'RETRY' : 'DEAD';

      await client.query(
        `UPDATE delivery_jobs
            SET status = $2, lease_token = NULL, lease_until = NULL,
                next_attempt_at = CASE WHEN $2 = 'PENDING'
                  THEN clock_timestamp() + ($3::int * INTERVAL '1 millisecond')
                  ELSE next_attempt_at END,
                last_error_class = $4, updated_at = clock_timestamp()
          WHERE id = $1 AND lease_token = $5`,
        [job.jobId, newStatus, retryDelayMs, outcome.errorClass, job.leaseToken],
      );
      const updated = await client.query(
        `UPDATE delivery_attempts
            SET result = $4, finished_at = clock_timestamp(), http_status = $5,
                latency_ms = $6, error_class = $7
          WHERE job_id = $1 AND attempt_sequence = $2 AND lease_token = $3 AND result = 'STARTED'`,
        [
          job.jobId,
          job.attemptSequence,
          job.leaseToken,
          attemptResult,
          outcome.httpStatus,
          outcome.latencyMs,
          outcome.errorClass,
        ],
      );
      if (updated.rowCount !== 1) throw new Error('active attempt update invariant violated');
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Explicit operator action; historical attempts remain intact. */
  async replayDead(jobId: string, reason: string, workspaceId?: string, requestId?: string): Promise<number> {
    if (reason.trim().length < 4 || reason.length > 256) {
      throw new Error('replay reason must contain 4..256 characters');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (workspaceId && requestId) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          `${workspaceId}:${requestId}`,
        ]);
        const priorAction = await client.query<{ job_id: string; new_generation: number }>(
          `SELECT job_id, new_generation FROM replay_audit
            WHERE workspace_id = $1 AND request_id = $2`,
          [workspaceId, requestId],
        );
        if (priorAction.rows[0]) {
          if (priorAction.rows[0].job_id !== jobId) {
            await client.query('ROLLBACK');
            throw new Error('replay request ID was already used for another job');
          }
          await client.query('COMMIT');
          return priorAction.rows[0].new_generation;
        }
      }
      const selected = await client.query<{
        status: string;
        replay_generation: number;
        total_attempts: number;
      }>(
        `SELECT j.status, j.replay_generation, j.total_attempts
           FROM delivery_jobs j JOIN inbox_events e ON e.id = j.inbox_event_id
          WHERE j.id = $1 AND ($2::uuid IS NULL OR e.workspace_id = $2)
          FOR UPDATE OF j`,
        [jobId, workspaceId ?? null],
      );
      if (!selected.rows[0] || selected.rows[0].status !== 'DEAD') {
        await client.query('ROLLBACK');
        throw new Error('Only existing DEAD jobs can be manually replayed');
      }
      const nextGeneration = selected.rows[0].replay_generation + 1;
      if (nextGeneration > 2) {
        await client.query('ROLLBACK');
        throw new Error('manual replay limit reached');
      }
      await client.query(
        `UPDATE delivery_jobs SET status = 'PENDING', attempts_in_generation = 0,
                replay_generation = $2, next_attempt_at = clock_timestamp(),
                last_error_class = NULL, updated_at = clock_timestamp()
          WHERE id = $1`,
        [jobId, nextGeneration],
      );
      await client.query(
        `INSERT INTO replay_audit
           (id, job_id, workspace_id, request_id, reason, previous_total_attempts, new_generation)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          jobId,
          workspaceId ?? null,
          requestId ?? null,
          reason.trim(),
          selected.rows[0].total_attempts,
          nextGeneration,
        ],
      );
      await client.query('COMMIT');
      return nextGeneration;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
