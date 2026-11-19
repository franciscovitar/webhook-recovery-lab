import type { Pool } from 'pg';

export interface QueueSnapshot {
  jobs: {
    total: number;
    pending: number;
    leased: number;
    succeeded: number;
    dead: number;
    due_pending: number;
    expired_leases: number;
    oldest_due_age_seconds: number | null;
  };
  last_hour: {
    ingested: number;
    attempts_started: number;
    attempts_succeeded: number;
    attempts_retried: number;
    attempts_dead: number;
    attempts_abandoned: number;
    delivery_latency_p50_ms: number | null;
    delivery_latency_p95_ms: number | null;
  };
  receiver: {
    receipts_total: number;
    receipts_last_hour: number;
    deliveries_observed_total: number;
  } | null;
  collected_at: string;
  consistency: 'separate_read_committed_snapshots';
}

interface GatewayRow {
  jobs: QueueSnapshot['jobs'];
  last_hour: QueueSnapshot['last_hour'];
}

/** Read-only, fixed-cardinality diagnostics. No event payloads, secrets or customer IDs. */
export async function readOpsSnapshot(gateway: Pool, receiver?: Pool): Promise<QueueSnapshot> {
  const gatewayData = await gateway.query<GatewayRow>(
    `WITH job_counts AS (
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE status='LEASED')::int AS leased,
              COUNT(*) FILTER (WHERE status='SUCCEEDED')::int AS succeeded,
              COUNT(*) FILTER (WHERE status='DEAD')::int AS dead,
              COUNT(*) FILTER (WHERE status='PENDING' AND next_attempt_at <= statement_timestamp())::int AS due_pending,
              COUNT(*) FILTER (WHERE status='LEASED' AND lease_until <= statement_timestamp())::int AS expired_leases,
              EXTRACT(EPOCH FROM (statement_timestamp() - MIN(next_attempt_at)
                FILTER (WHERE status='PENDING' AND next_attempt_at <= statement_timestamp())))::float8
                AS oldest_due_age_seconds
         FROM delivery_jobs
     ), recent_ingress AS (
       SELECT COUNT(*)::int AS ingested FROM inbox_events
        WHERE received_at >= statement_timestamp() - INTERVAL '1 hour'
     ), recent_attempts AS (
       SELECT COUNT(*)::int AS attempts_started,
              COUNT(*) FILTER (WHERE result='SUCCEEDED')::int AS attempts_succeeded,
              COUNT(*) FILTER (WHERE result='RETRY')::int AS attempts_retried,
              COUNT(*) FILTER (WHERE result='DEAD')::int AS attempts_dead,
              COUNT(*) FILTER (WHERE result='ABANDONED')::int AS attempts_abandoned,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
                FILTER (WHERE result='SUCCEEDED') AS delivery_latency_p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
                FILTER (WHERE result='SUCCEEDED') AS delivery_latency_p95_ms
         FROM delivery_attempts
        WHERE started_at >= statement_timestamp() - INTERVAL '1 hour'
     )
     SELECT row_to_json(j) AS jobs,
            (row_to_json(a)::jsonb || row_to_json(i)::jsonb)::json AS last_hour
       FROM job_counts j CROSS JOIN recent_attempts a CROSS JOIN recent_ingress i`,
  );
  const row = gatewayData.rows[0];
  if (!row) throw new Error('operations snapshot query returned no row');

  let receiverCounts: QueueSnapshot['receiver'] = null;
  if (receiver) {
    const result = await receiver.query<NonNullable<QueueSnapshot['receiver']>>(
      `SELECT
         (SELECT COUNT(*)::int FROM receiver_receipts) AS receipts_total,
         (SELECT COUNT(*)::int FROM receiver_receipts
           WHERE created_at >= statement_timestamp() - INTERVAL '1 hour') AS receipts_last_hour,
         (SELECT COALESCE(SUM(attempts),0)::int FROM receiver_attempt_counts) AS deliveries_observed_total`,
    );
    receiverCounts = result.rows[0] ?? null;
  }

  return {
    jobs: row.jobs,
    last_hour: row.last_hour,
    receiver: receiverCounts,
    collected_at: new Date().toISOString(),
    consistency: 'separate_read_committed_snapshots',
  };
}
