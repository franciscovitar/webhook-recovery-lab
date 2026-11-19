import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../src/db/pool.js';
import { readOpsSnapshot } from '../../src/ops/snapshot.js';
import { requireTestDatabaseUrl } from './test-urls.js';

const gateway = createPool(requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test'));
const receiver = createPool(requireTestDatabaseUrl('TEST_RECEIVER_DATABASE_URL', 'receiver_test'));
const fixtures: Array<{ inbox: string; job: string; delivery: string }> = [];

beforeAll(async () => {
  await Promise.all([gateway.query('SELECT 1'), receiver.query('SELECT 1')]);
});

afterAll(async () => {
  const jobIds = fixtures.map((row) => row.job);
  const inboxIds = fixtures.map((row) => row.inbox);
  const deliveryIds = fixtures.map((row) => row.delivery);
  if (jobIds.length) {
    await gateway.query('DELETE FROM delivery_attempts WHERE job_id = ANY($1::uuid[])', [jobIds]);
    await gateway.query('DELETE FROM delivery_jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    await gateway.query('DELETE FROM inbox_events WHERE id = ANY($1::uuid[])', [inboxIds]);
    await receiver.query('DELETE FROM receiver_receipts WHERE delivery_id = ANY($1::uuid[])', [deliveryIds]);
    await receiver.query('DELETE FROM receiver_attempt_counts WHERE delivery_id = ANY($1::uuid[])', [
      deliveryIds,
    ]);
  }
  await gateway.end();
  await receiver.end();
});

async function fixture(status: 'PENDING' | 'LEASED' | 'SUCCEEDED' | 'DEAD') {
  const inbox = randomUUID();
  const job = randomUUID();
  const delivery = randomUUID();
  const event = randomUUID();
  const payload = {
    event_id: event,
    type: 'order.created',
    occurred_at: '2026-11-19T12:00:00Z',
    data: { order_id: 'ops_fixture' },
  };
  await gateway.query(
    `INSERT INTO inbox_events (id,provider,event_id,event_type,occurred_at,payload_sha256,payload)
      VALUES ($1,'sandbox',$2,'order.created',$3,$4,$5::jsonb)`,
    [inbox, event, payload.occurred_at, '0'.repeat(64), JSON.stringify(payload)],
  );
  const leased = status === 'LEASED';
  await gateway.query(
    `INSERT INTO delivery_jobs
       (id,inbox_event_id,delivery_id,status,total_attempts,attempts_in_generation,
        next_attempt_at,lease_token,lease_until)
     VALUES ($1,$2,$3,$4,$5,$5,clock_timestamp()-INTERVAL '30 seconds',$6,$7)`,
    [
      job,
      inbox,
      delivery,
      status,
      status === 'SUCCEEDED' ? 1 : 0,
      leased ? randomUUID() : null,
      leased ? new Date(Date.now() - 15_000) : null,
    ],
  );
  fixtures.push({ inbox, job, delivery });
  return { job, delivery };
}

describe('read-only operations snapshot over real PostgreSQL', () => {
  it('reports due backlog, expired lease, outcome totals and independent receiver counts', async () => {
    await fixture('PENDING');
    await fixture('LEASED');
    const succeeded = await fixture('SUCCEEDED');
    await fixture('DEAD');
    await gateway.query(
      `INSERT INTO delivery_attempts
         (id,job_id,attempt_sequence,replay_generation,lease_token,result,
          finished_at,http_status,latency_ms)
       VALUES ($1,$2,1,0,$3,'SUCCEEDED',clock_timestamp(),200,123)`,
      [randomUUID(), succeeded.job, randomUUID()],
    );
    await receiver.query('INSERT INTO receiver_attempt_counts (delivery_id,attempts) VALUES ($1,2)', [
      succeeded.delivery,
    ]);
    await receiver.query('INSERT INTO receiver_receipts (delivery_id,event_id,order_id) VALUES ($1,$2,$3)', [
      succeeded.delivery,
      randomUUID(),
      'ops_fixture',
    ]);

    const before = await gateway.query<{ count: number }>(
      'SELECT COUNT(*)::int count FROM delivery_jobs WHERE id = ANY($1::uuid[])',
      [fixtures.map((row) => row.job)],
    );
    const snapshot = await readOpsSnapshot(gateway, receiver);
    const after = await gateway.query<{ count: number }>(
      'SELECT COUNT(*)::int count FROM delivery_jobs WHERE id = ANY($1::uuid[])',
      [fixtures.map((row) => row.job)],
    );

    expect(before.rows[0]?.count).toBe(4);
    expect(after.rows[0]?.count).toBe(4);
    expect(snapshot.jobs.total).toBeGreaterThanOrEqual(4);
    expect(snapshot.jobs.pending).toBeGreaterThanOrEqual(1);
    expect(snapshot.jobs.due_pending).toBeGreaterThanOrEqual(1);
    expect(snapshot.jobs.expired_leases).toBeGreaterThanOrEqual(1);
    expect(snapshot.jobs.dead).toBeGreaterThanOrEqual(1);
    expect(snapshot.jobs.oldest_due_age_seconds).toBeGreaterThan(0);
    expect(snapshot.last_hour.ingested).toBeGreaterThanOrEqual(4);
    expect(snapshot.last_hour.attempts_succeeded).toBeGreaterThanOrEqual(1);
    expect(snapshot.last_hour.delivery_latency_p50_ms).toBeGreaterThanOrEqual(0);
    expect(snapshot.receiver?.receipts_total).toBeGreaterThanOrEqual(1);
    expect(snapshot.receiver?.deliveries_observed_total).toBeGreaterThanOrEqual(2);
    expect(snapshot.consistency).toBe('separate_read_committed_snapshots');
    expect(new Date(snapshot.collected_at).toISOString()).toBe(snapshot.collected_at);
    expect(JSON.stringify(snapshot)).not.toContain('ops_fixture');
  });

  it('marks receiver statistics unknown instead of zero if its DB was not queried', async () => {
    const snapshot = await readOpsSnapshot(gateway);
    expect(snapshot.receiver).toBeNull();
    expect(snapshot.jobs.total).toBeGreaterThanOrEqual(4);
  });
});
