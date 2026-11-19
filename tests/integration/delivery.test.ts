import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type DeliveryOutcome } from '../../src/core/delivery.js';
import { createPool } from '../../src/db/pool.js';
import { PostgresDeliveryStore } from '../../src/db/postgres-delivery.js';
import { PostgresReceiverStore } from '../../src/db/postgres-receiver.js';
import { buildReceiverApp } from '../../src/receiver/app.js';
import { HttpDeliveryTransport } from '../../src/worker/http-transport.js';
import { WorkerRunner } from '../../src/worker/runner.js';
import { requireTestDatabaseUrl } from './test-urls.js';

const primaryUrl = requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test');
const receiverUrl = requireTestDatabaseUrl('TEST_RECEIVER_DATABASE_URL', 'receiver_test');
const db = createPool(primaryUrl);
const receiverDb = createPool(receiverUrl);
const store = new PostgresDeliveryStore(db);
const receiver = buildReceiverApp({
  store: new PostgresReceiverStore(receiverDb),
  sharedToken: 'integration-receiver-local-token-only-00001',
});
const tracked: Array<{ inboxId: string; jobId: string; deliveryId: string }> = [];
let transport: HttpDeliveryTransport;

const success: DeliveryOutcome = { kind: 'success', httpStatus: 200, latencyMs: 1, errorClass: null };

beforeAll(async () => {
  const versions = await Promise.all([
    db.query<{ version: string }>('SELECT version FROM schema_migrations'),
    receiverDb.query<{ version: string }>('SELECT version FROM schema_migrations'),
  ]);
  expect(versions[0].rows.map((r) => r.version)).toContain('0001_initial');
  expect(versions[1].rows.map((r) => r.version)).toContain('0001_receiver');

  const queue = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text count FROM delivery_jobs WHERE status IN ('PENDING','LEASED')`,
  );
  expect(queue.rows[0]?.count).toBe('0');

  const address = await receiver.listen({ host: '127.0.0.1', port: 0 });
  transport = new HttpDeliveryTransport({
    receiverUrl: `${address}/v1/receive`,
    sharedToken: 'integration-receiver-local-token-only-00001',
  });
});

afterAll(async () => {
  const jobIds = tracked.map((row) => row.jobId);
  const inboxIds = tracked.map((row) => row.inboxId);
  const deliveryIds = tracked.map((row) => row.deliveryId);
  if (jobIds.length) {
    await db.query('DELETE FROM replay_audit WHERE job_id = ANY($1::uuid[])', [jobIds]);
    await db.query('DELETE FROM delivery_attempts WHERE job_id = ANY($1::uuid[])', [jobIds]);
    await db.query('DELETE FROM delivery_jobs WHERE id = ANY($1::uuid[])', [jobIds]);
    await db.query('DELETE FROM inbox_events WHERE id = ANY($1::uuid[])', [inboxIds]);
    await receiverDb.query('DELETE FROM receiver_fault_plans WHERE delivery_id = ANY($1::uuid[])', [
      deliveryIds,
    ]);
    await receiverDb.query('DELETE FROM receiver_receipts WHERE delivery_id = ANY($1::uuid[])', [
      deliveryIds,
    ]);
    await receiverDb.query('DELETE FROM receiver_attempt_counts WHERE delivery_id = ANY($1::uuid[])', [
      deliveryIds,
    ]);
  }
  await receiver.close();
  await db.end();
  await receiverDb.end();
});

async function createJob(orderId: string) {
  const inboxId = randomUUID();
  const jobId = randomUUID();
  const eventId = randomUUID();
  const deliveryId = randomUUID();
  const payload = {
    event_id: eventId,
    type: 'order.created',
    occurred_at: '2026-11-19T12:00:00Z',
    data: { order_id: orderId },
  };
  await db.query(
    `INSERT INTO inbox_events (id,provider,event_id,event_type,occurred_at,payload_sha256,payload)
      VALUES ($1,'sandbox',$2,'order.created',$3,$4,$5::jsonb)`,
    [inboxId, eventId, payload.occurred_at, '0'.repeat(64), JSON.stringify(payload)],
  );
  await db.query(
    `INSERT INTO delivery_jobs (id,inbox_event_id,delivery_id,status,next_attempt_at)
      VALUES ($1,$2,$3,'PENDING',clock_timestamp())`,
    [jobId, inboxId, deliveryId],
  );
  tracked.push({ inboxId, jobId, deliveryId });
  return { inboxId, jobId, eventId, deliveryId };
}

async function forceJobDue(jobId: string): Promise<void> {
  await db.query(
    `UPDATE delivery_jobs SET next_attempt_at=clock_timestamp() - INTERVAL '1 second' WHERE id=$1 AND status='PENDING'`,
    [jobId],
  );
}

describe('worker recovery using two real PostgreSQL databases', () => {
  it('claims a job only once across multiple competing workers', async () => {
    const created = await createJob('ord_claim');
    const claims = await Promise.all(Array.from({ length: 6 }, () => store.claimNext()));
    const successful = claims.filter((job) => job !== null);
    expect(successful).toHaveLength(1);
    expect(successful[0]?.jobId).toBe(created.jobId);
    expect(await store.finish(successful[0]!, success, 0)).toBe(true);
    expect(
      (await db.query('SELECT status FROM delivery_jobs WHERE id=$1', [created.jobId])).rows[0]?.status,
    ).toBe('SUCCEEDED');
  });

  it('retries 503 twice, then records one durable receipt and three attempts', async () => {
    const created = await createJob('ord_retry');
    await receiverDb.query(
      `INSERT INTO receiver_fault_plans (delivery_id, transient_remaining, transient_status) VALUES ($1,2,503)`,
      [created.deliveryId],
    );
    const runner = new WorkerRunner({ store, transport, random: () => 0 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await runner.runOnce()).toBe(true);
      if (attempt < 3) await forceJobDue(created.jobId);
    }
    const job = await db.query<{ status: string; total_attempts: number }>(
      'SELECT status,total_attempts FROM delivery_jobs WHERE id=$1',
      [created.jobId],
    );
    expect(job.rows[0]).toEqual({ status: 'SUCCEEDED', total_attempts: 3 });
    const receipts = await receiverDb.query<{ count: string }>(
      'SELECT COUNT(*)::text count FROM receiver_receipts WHERE delivery_id=$1',
      [created.deliveryId],
    );
    expect(receipts.rows[0]?.count).toBe('1');
    const attempts = await db.query<{ result: string }>(
      'SELECT result FROM delivery_attempts WHERE job_id=$1 ORDER BY attempt_sequence',
      [created.jobId],
    );
    expect(attempts.rows.map((r) => r.result)).toEqual(['RETRY', 'RETRY', 'SUCCEEDED']);
  });

  it('recovers after receiver success but before ACK: two sends, one effect', async () => {
    const created = await createJob('ord_crash');
    const first = new WorkerRunner({
      store,
      transport,
      afterTransport: () => {
        throw new Error('injected crash before ACK');
      },
    });
    await expect(first.runOnce()).rejects.toThrow('injected crash before ACK');
    expect(
      (await db.query('SELECT status FROM delivery_jobs WHERE id=$1', [created.jobId])).rows[0]?.status,
    ).toBe('LEASED');
    await db.query(
      `UPDATE delivery_jobs SET lease_until=clock_timestamp() - INTERVAL '1 second' WHERE id=$1`,
      [created.jobId],
    );

    const second = new WorkerRunner({ store, transport });
    expect(await second.runOnce()).toBe(true);

    const counters = await receiverDb.query<{ attempts: number }>(
      'SELECT attempts FROM receiver_attempt_counts WHERE delivery_id=$1',
      [created.deliveryId],
    );
    const receipts = await receiverDb.query<{ count: string }>(
      'SELECT COUNT(*)::text count FROM receiver_receipts WHERE delivery_id=$1',
      [created.deliveryId],
    );
    expect(counters.rows[0]?.attempts).toBe(2);
    expect(receipts.rows[0]?.count).toBe('1');
    const history = await db.query<{ result: string }>(
      'SELECT result FROM delivery_attempts WHERE job_id=$1 ORDER BY attempt_sequence',
      [created.jobId],
    );
    expect(history.rows.map((r) => r.result)).toEqual(['ABANDONED', 'SUCCEEDED']);
  });

  it('rejects a stale worker ACK after the lease was reclaimed', async () => {
    const created = await createJob('ord_fenced');
    const old = await store.claimNext();
    expect(old?.jobId).toBe(created.jobId);
    await db.query(
      `UPDATE delivery_jobs SET lease_until=clock_timestamp() - INTERVAL '1 second' WHERE id=$1`,
      [created.jobId],
    );
    const replacement = await store.claimNext();
    expect(replacement?.leaseToken).not.toBe(old?.leaseToken);
    expect(await store.finish(old!, success, 0)).toBe(false);
    const current = await db.query<{ lease_token: string }>(
      'SELECT lease_token FROM delivery_jobs WHERE id=$1',
      [created.jobId],
    );
    expect(current.rows[0]?.lease_token).toBe(replacement?.leaseToken);
    expect(await store.finish(replacement!, success, 0)).toBe(true);
  });

  it('dead-letters a 422 then allows audited replay without resetting historical attempt sequence', async () => {
    const created = await createJob('ord_dead');
    await receiverDb.query(
      'INSERT INTO receiver_fault_plans (delivery_id,permanent_status) VALUES ($1,422)',
      [created.deliveryId],
    );
    const runner = new WorkerRunner({ store, transport });
    expect(await runner.runOnce()).toBe(true);
    expect(
      (await db.query('SELECT status FROM delivery_jobs WHERE id=$1', [created.jobId])).rows[0]?.status,
    ).toBe('DEAD');
    await expect(store.replayDead(created.jobId, 'operator reviewed synthetic failure')).resolves.toBe(1);
    await receiverDb.query('UPDATE receiver_fault_plans SET permanent_status=NULL WHERE delivery_id=$1', [
      created.deliveryId,
    ]);
    expect(await runner.runOnce()).toBe(true);

    const job = await db.query<{ status: string; total_attempts: number; replay_generation: number }>(
      'SELECT status,total_attempts,replay_generation FROM delivery_jobs WHERE id=$1',
      [created.jobId],
    );
    expect(job.rows[0]).toEqual({ status: 'SUCCEEDED', total_attempts: 2, replay_generation: 1 });
    const attempts = await db.query<{ attempt_sequence: number; replay_generation: number }>(
      'SELECT attempt_sequence,replay_generation FROM delivery_attempts WHERE job_id=$1 ORDER BY attempt_sequence',
      [created.jobId],
    );
    expect(attempts.rows).toEqual([
      { attempt_sequence: 1, replay_generation: 0 },
      { attempt_sequence: 2, replay_generation: 1 },
    ]);
    expect(
      await store
        .replayDead(created.jobId, 'not allowed after success')
        .catch((e: unknown) => (e instanceof Error ? e.message : '')),
    ).toContain('Only existing DEAD');
  });
});
