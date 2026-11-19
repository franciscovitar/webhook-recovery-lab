import 'dotenv/config';

import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { PostgresDeliveryStore } from '../db/postgres-delivery.js';
import { PostgresInboxRepository } from '../db/postgres-inbox.js';
import { createPool } from '../db/pool.js';
import { PostgresReceiverStore } from '../db/postgres-receiver.js';
import { buildApp } from '../http/app.js';
import { buildReceiverApp } from '../receiver/app.js';
import { HttpDeliveryTransport } from '../worker/http-transport.js';
import { WorkerRunner } from '../worker/runner.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--run-id' || !/^[a-z0-9-]{1,40}$/.test(args[1] ?? '')) {
  throw new Error('Usage: npm run demo:scenario -- --run-id <lowercase-letters-digits-hyphens>');
}
const runId = args[1]!;

function requireDisposableDatabase(envName: string, dbName: string): string {
  const value = process.env[envName];
  if (!value) throw new Error(`${envName} must be set`);
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${envName} is not a PostgreSQL URL`);
  }
  if (parsed.pathname !== `/${dbName}` || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`${envName} must point to the local disposable ${dbName} database`);
  }
  return value;
}

const gatewayUrl = requireDisposableDatabase('TEST_DATABASE_URL', 'gateway_test');
const receiverUrl = requireDisposableDatabase('TEST_RECEIVER_DATABASE_URL', 'receiver_test');
const signingSecret = 'only-for-synthetic-demo-events-signing-key-0000001';
const receiverToken = 'only-for-synthetic-demo-receiver-token-00000001';

function stableUuid(name: string): string {
  const hex = createHash('sha256').update(`${runId}:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const eventIds = ['retry', 'crash', 'replay'].map(stableUuid);
const gatewayDb = createPool(gatewayUrl);
const receiverDb = createPool(receiverUrl);
const deliveryStore = new PostgresDeliveryStore(gatewayDb);
const api = buildApp({
  repository: new PostgresInboxRepository(gatewayDb),
  signingKeys: new Map([['sandbox-v1', signingSecret]]),
});
const receiver = buildReceiverApp({
  store: new PostgresReceiverStore(receiverDb),
  sharedToken: receiverToken,
});

async function state(eventId: string): Promise<{
  job_id: string;
  delivery_id: string;
  status: string;
  total_attempts: number;
  replay_generation: number;
}> {
  const result = await gatewayDb.query<{
    job_id: string;
    delivery_id: string;
    status: string;
    total_attempts: number;
    replay_generation: number;
  }>(
    `SELECT j.id job_id, j.delivery_id, j.status, j.total_attempts, j.replay_generation
       FROM inbox_events e JOIN delivery_jobs j ON j.inbox_event_id=e.id
      WHERE e.provider='sandbox' AND e.event_id=$1`,
    [eventId],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function send(baseUrl: string, eventId: string, orderId: string) {
  const payload = JSON.stringify({
    event_id: eventId,
    type: 'order.created',
    occurred_at: '2026-11-19T12:00:00Z',
    data: { order_id: orderId },
  });
  const timestamp = String(Math.trunc(Date.now() / 1000));
  const signature = createHmac('sha256', signingSecret)
    .update(timestamp)
    .update('.')
    .update(payload)
    .digest('hex');
  const response = await fetch(`${baseUrl}/v1/webhooks/sandbox`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wrl-key-id': 'sandbox-v1',
      'x-wrl-timestamp': timestamp,
      'x-wrl-signature': `sha256=${signature}`,
    },
    body: payload,
    signal: AbortSignal.timeout(5_000),
  });
  return { code: response.status, body: (await response.json()) as { status?: string; error?: string } };
}

async function forceDue(jobId: string): Promise<void> {
  await gatewayDb.query(
    `UPDATE delivery_jobs SET next_attempt_at=clock_timestamp()-INTERVAL '1 second'
      WHERE id=$1 AND status='PENDING'`,
    [jobId],
  );
}

async function receiverCounts(deliveryId: string): Promise<{ sends: number; receipts: number }> {
  const [attempts, receipts] = await Promise.all([
    receiverDb.query<{ attempts: number }>(
      'SELECT attempts FROM receiver_attempt_counts WHERE delivery_id=$1',
      [deliveryId],
    ),
    receiverDb.query<{ count: number }>(
      'SELECT COUNT(*)::int count FROM receiver_receipts WHERE delivery_id=$1',
      [deliveryId],
    ),
  ]);
  return { sends: attempts.rows[0]?.attempts ?? 0, receipts: receipts.rows[0]?.count ?? 0 };
}

try {
  // Abort before *any* writes if this run ID already exists, or a live worker
  // could steal our jobs. Test databases only; other rows are never changed.
  const [existing, queued] = await Promise.all([
    gatewayDb.query('SELECT id FROM inbox_events WHERE event_id = ANY($1::uuid[])', [eventIds]),
    gatewayDb.query("SELECT id FROM delivery_jobs WHERE status IN ('PENDING','LEASED')"),
  ]);
  assert.equal(existing.rowCount, 0, 'run-id already used; choose a new --run-id');
  assert.equal(queued.rowCount, 0, 'database contains pending or leased work; use a fresh test DB');

  const receiverAddress = await receiver.listen({ host: '127.0.0.1', port: 0 });
  const apiAddress = await api.listen({ host: '127.0.0.1', port: 0 });
  const transport = new HttpDeliveryTransport({
    receiverUrl: `${receiverAddress}/v1/receive`,
    sharedToken: receiverToken,
  });
  const runner = new WorkerRunner({ store: deliveryStore, transport, random: () => 0 });

  // Real TCP HTTP API -> transactional gateway DB; real TCP HTTP receiver -> independent DB.
  const accepted = await send(apiAddress, eventIds[0]!, 'retry');
  const duplicate = await send(apiAddress, eventIds[0]!, 'retry');
  const conflict = await send(apiAddress, eventIds[0]!, 'tampered');
  assert.deepEqual(
    [accepted.code, accepted.body.status, duplicate.code, duplicate.body.status],
    [202, 'accepted', 202, 'duplicate'],
  );
  assert.deepEqual([conflict.code, conflict.body.error], [409, 'event_identity_conflict']);

  const retryJob = await state(eventIds[0]!);
  await receiverDb.query(
    `INSERT INTO receiver_fault_plans (delivery_id,transient_remaining,transient_status)
     VALUES ($1,2,503)`,
    [retryJob.delivery_id],
  );
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(await runner.runOnce(), true);
    if (attempt < 3) await forceDue(retryJob.job_id);
  }
  assert.equal((await state(eventIds[0]!)).status, 'SUCCEEDED');
  assert.deepEqual(await receiverCounts(retryJob.delivery_id), { sends: 3, receipts: 1 });

  assert.equal((await send(apiAddress, eventIds[1]!, 'crash')).code, 202);
  const crashJob = await state(eventIds[1]!);
  const crashRunner = new WorkerRunner({
    store: deliveryStore,
    transport,
    afterTransport: () => {
      throw new Error('synthetic crash before local ACK');
    },
  });
  await assert.rejects(crashRunner.runOnce(), /synthetic crash before local ACK/);
  await gatewayDb.query(
    `UPDATE delivery_jobs SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE id=$1`,
    [crashJob.job_id],
  );
  assert.equal(await runner.runOnce(), true);
  assert.equal((await state(eventIds[1]!)).status, 'SUCCEEDED');
  assert.deepEqual(await receiverCounts(crashJob.delivery_id), { sends: 2, receipts: 1 });

  assert.equal((await send(apiAddress, eventIds[2]!, 'replay')).code, 202);
  const replayJob = await state(eventIds[2]!);
  await receiverDb.query('INSERT INTO receiver_fault_plans (delivery_id,permanent_status) VALUES ($1,422)', [
    replayJob.delivery_id,
  ]);
  assert.equal(await runner.runOnce(), true);
  assert.equal((await state(eventIds[2]!)).status, 'DEAD');
  assert.equal(await deliveryStore.replayDead(replayJob.job_id, 'synthetic operator repair'), 1);
  await receiverDb.query('UPDATE receiver_fault_plans SET permanent_status=NULL WHERE delivery_id=$1', [
    replayJob.delivery_id,
  ]);
  assert.equal(await runner.runOnce(), true);
  const finalReplay = await state(eventIds[2]!);
  assert.deepEqual(
    [finalReplay.status, finalReplay.replay_generation, finalReplay.total_attempts],
    ['SUCCEEDED', 1, 2],
  );
  assert.deepEqual(await receiverCounts(replayJob.delivery_id), { sends: 2, receipts: 1 });

  console.log('INGRESS accepted=202 duplicate=202 changed-payload=409');
  console.log('RETRY response-codes=503,503,200 sends=3 receipts=1 final=SUCCEEDED');
  console.log('CRASH sends=2 receipts=1 final=SUCCEEDED');
  console.log('DEAD_LETTER initial=DEAD replay-generation=1 final=SUCCEEDED');
  console.log('DEMO PASS: real HTTP + two local test PostgreSQL databases');
} finally {
  await Promise.allSettled([api.close(), receiver.close(), gatewayDb.end(), receiverDb.end()]);
}
