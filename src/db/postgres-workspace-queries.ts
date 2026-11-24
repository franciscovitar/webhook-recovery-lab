import type { Pool } from 'pg';

export type WorkspaceJobState = 'PENDING' | 'LEASED' | 'SUCCEEDED' | 'DEAD';

export interface WorkspaceEventRow {
  id: string;
  event_id: string;
  event_type: string;
  occurred_at: Date;
  received_at: Date;
  payload: { data: { order_id: string } };
  job_id: string;
  delivery_id: string;
  status: WorkspaceJobState;
  total_attempts: number;
  attempts_in_generation: number;
  replay_generation: number;
  next_attempt_at: Date;
  last_error_class: string | null;
}

export interface WorkspaceEventFilter {
  status?: WorkspaceJobState;
  query?: string;
  limit: number;
  offset: number;
  from?: Date;
  to?: Date;
}

const statusValues = new Set<WorkspaceJobState>(['PENDING', 'LEASED', 'SUCCEEDED', 'DEAD']);

export function parseWorkspaceJobState(value: unknown): WorkspaceJobState | undefined {
  return typeof value === 'string' && statusValues.has(value as WorkspaceJobState)
    ? (value as WorkspaceJobState)
    : undefined;
}

export class PostgresWorkspaceQueries {
  constructor(private readonly pool: Pool) {}

  async overview(workspaceId: string) {
    const result = await this.pool.query<{
      received: string;
      delivered: string;
      pending: string;
      failed: string;
    }>(
      `SELECT count(*)::text AS received,
              count(*) FILTER (WHERE j.status = 'SUCCEEDED')::text AS delivered,
              count(*) FILTER (WHERE j.status IN ('PENDING', 'LEASED'))::text AS pending,
              count(*) FILTER (WHERE j.status = 'DEAD')::text AS failed
         FROM inbox_events e JOIN delivery_jobs j ON j.inbox_event_id = e.id
        WHERE e.workspace_id = $1`,
      [workspaceId],
    );
    const counts = result.rows[0];
    if (!counts) throw new Error('workspace overview query returned no aggregate row');
    return {
      received: Number(counts.received),
      delivered: Number(counts.delivered),
      pending: Number(counts.pending),
      failed: Number(counts.failed),
    };
  }

  async events(workspaceId: string, filter: WorkspaceEventFilter) {
    const values: unknown[] = [workspaceId];
    const conditions = ['e.workspace_id = $1'];
    if (filter.status) {
      values.push(filter.status);
      conditions.push(`j.status = $${values.length}`);
    }
    if (filter.query?.trim()) {
      values.push(`%${filter.query.trim()}%`);
      conditions.push(
        `(e.event_id::text ILIKE $${values.length} OR e.payload->'data'->>'order_id' ILIKE $${values.length})`,
      );
    }
    if (filter.from) {
      values.push(filter.from);
      conditions.push(`e.received_at >= $${values.length}`);
    }
    if (filter.to) {
      values.push(filter.to);
      conditions.push(`e.received_at < $${values.length}`);
    }
    const where = conditions.join(' AND ');
    const total = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM inbox_events e
         JOIN delivery_jobs j ON j.inbox_event_id = e.id WHERE ${where}`,
      values,
    );
    values.push(filter.limit, filter.offset);
    const rows = await this.pool.query<WorkspaceEventRow>(
      `SELECT e.id, e.event_id, e.event_type, e.occurred_at, e.received_at, e.payload,
              j.id AS job_id, j.delivery_id, j.status, j.total_attempts,
              j.attempts_in_generation, j.replay_generation, j.next_attempt_at,
              j.last_error_class
         FROM inbox_events e JOIN delivery_jobs j ON j.inbox_event_id = e.id
        WHERE ${where}
        ORDER BY e.received_at DESC, e.id DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return { total: Number(total.rows[0]?.count ?? '0'), events: rows.rows };
  }

  async event(workspaceId: string, eventId: string) {
    const result = await this.pool.query<WorkspaceEventRow>(
      `SELECT e.id, e.event_id, e.event_type, e.occurred_at, e.received_at, e.payload, e.signature_verified,
              j.id AS job_id, j.delivery_id, j.status, j.total_attempts,
              j.attempts_in_generation, j.replay_generation, j.next_attempt_at,
              j.last_error_class
         FROM inbox_events e JOIN delivery_jobs j ON j.inbox_event_id = e.id
        WHERE e.workspace_id = $1 AND e.event_id = $2`,
      [workspaceId, eventId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const attempts = await this.pool.query<{
      attempt_sequence: number;
      replay_generation: number;
      started_at: Date;
      finished_at: Date | null;
      result: string;
      http_status: number | null;
      latency_ms: number | null;
      error_class: string | null;
    }>(
      `SELECT a.attempt_sequence, a.replay_generation, a.started_at, a.finished_at,
              a.result, a.http_status, a.latency_ms, a.error_class
         FROM delivery_attempts a WHERE a.job_id = $1
        ORDER BY a.attempt_sequence DESC LIMIT 25`,
      [row.job_id],
    );
    return { ...row, attempts: attempts.rows };
  }

  async duplicateSource(
    workspaceId: string,
    eventId: string,
  ): Promise<{ raw_body: Buffer; signature_verified: boolean } | null> {
    const result = await this.pool.query<{ raw_body: Buffer | null; signature_verified: boolean }>(
      `SELECT raw_body, signature_verified FROM inbox_events WHERE workspace_id = $1 AND event_id = $2`,
      [workspaceId, eventId],
    );
    const row = result.rows[0];
    return row?.raw_body ? { raw_body: row.raw_body, signature_verified: row.signature_verified } : null;
  }

  async recoveryJob(workspaceId: string, jobId: string) {
    const result = await this.pool.query<{
      id: string;
      delivery_id: string;
      status: WorkspaceJobState;
      last_error_class: string | null;
      total_attempts: number;
      replay_generation: number;
      event_id: string;
      order_id: string;
    }>(
      `SELECT j.id, j.delivery_id, j.status, j.last_error_class, j.total_attempts,
              j.replay_generation, e.event_id, e.payload->'data'->>'order_id' AS order_id
         FROM delivery_jobs j JOIN inbox_events e ON e.id = j.inbox_event_id
        WHERE e.workspace_id = $1 AND j.id = $2`,
      [workspaceId, jobId],
    );
    return result.rows[0] ?? null;
  }

  async deadJobs(workspaceId: string) {
    const result = await this.pool.query(
      `SELECT j.id, j.delivery_id, e.event_id, e.payload->'data'->>'order_id' AS order_id,
              j.last_error_class, j.total_attempts, j.replay_generation, j.updated_at
         FROM delivery_jobs j JOIN inbox_events e ON e.id = j.inbox_event_id
        WHERE e.workspace_id = $1 AND j.status = 'DEAD'
        ORDER BY j.updated_at DESC, j.id LIMIT 25`,
      [workspaceId],
    );
    return result.rows;
  }

  async testEventByRequest(workspaceId: string, eventId: string) {
    const result = await this.pool.query<{ event_id: string; order_id: string }>(
      `SELECT e.event_id::text, e.payload->'data'->>'order_id' AS order_id
         FROM inbox_events e WHERE e.workspace_id = $1 AND e.event_id = $2`,
      [workspaceId, eventId],
    );
    return result.rows[0] ?? null;
  }

  async deliveries(workspaceId: string) {
    const result = await this.pool.query(
      `SELECT j.id AS job_id, j.delivery_id, e.event_id, e.payload->'data'->>'order_id' AS order_id,
              j.status, j.total_attempts, j.replay_generation, j.next_attempt_at,
              a.http_status AS latest_http_status, a.latency_ms AS latest_latency_ms,
              a.result AS latest_attempt_result, a.error_class AS latest_error_class
         FROM delivery_jobs j JOIN inbox_events e ON e.id = j.inbox_event_id
         LEFT JOIN LATERAL (
           SELECT http_status, latency_ms, result, error_class
             FROM delivery_attempts WHERE job_id = j.id
            ORDER BY attempt_sequence DESC LIMIT 1
         ) a ON TRUE
        WHERE e.workspace_id = $1
        ORDER BY j.updated_at DESC, j.id DESC LIMIT 25`,
      [workspaceId],
    );
    return result.rows;
  }

  async activity(workspaceId: string) {
    const result = await this.pool.query(
      `SELECT action, happened_at, event_id, order_id, job_id, detail, http_status, latency_ms
         FROM (
           SELECT 'event_received'::text AS action, e.received_at AS happened_at,
                  e.event_id, e.payload->'data'->>'order_id' AS order_id,
                  j.id AS job_id, e.event_type AS detail, NULL::int AS http_status,
                  NULL::int AS latency_ms
             FROM inbox_events e JOIN delivery_jobs j ON j.inbox_event_id = e.id
            WHERE e.workspace_id = $1
           UNION ALL
           SELECT 'delivery_attempt'::text, a.started_at, e.event_id,
                  e.payload->'data'->>'order_id', j.id,
                  a.result || COALESCE(' · ' || a.error_class, ''), a.http_status, a.latency_ms
             FROM delivery_attempts a JOIN delivery_jobs j ON j.id = a.job_id
             JOIN inbox_events e ON e.id = j.inbox_event_id
            WHERE e.workspace_id = $1
           UNION ALL
           SELECT 'replay_requested'::text, r.requested_at, e.event_id,
                  e.payload->'data'->>'order_id', j.id,
                  'generation ' || r.new_generation::text, NULL::int, NULL::int
             FROM replay_audit r JOIN delivery_jobs j ON j.id = r.job_id
             JOIN inbox_events e ON e.id = j.inbox_event_id
            WHERE e.workspace_id = $1
         ) activity
        ORDER BY happened_at DESC, event_id DESC LIMIT 50`,
      [workspaceId],
    );
    return result.rows;
  }
}
