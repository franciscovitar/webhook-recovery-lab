import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, gatewayMigrations, receiverMigrations } from '../../src/db/migrations.js';
import { PostgresDeliveryStore } from '../../src/db/postgres-delivery.js';
import { PostgresGuestWorkspaceStore } from '../../src/db/postgres-guest-workspaces.js';
import { PostgresInboxRepository } from '../../src/db/postgres-inbox.js';
import { PostgresReceiverStore } from '../../src/db/postgres-receiver.js';
import { PostgresWorkspaceQueries } from '../../src/db/postgres-workspace-queries.js';
import { createPool } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';
import { buildReceiverApp } from '../../src/receiver/app.js';
import { HttpDeliveryTransport } from '../../src/worker/http-transport.js';
import { WorkerRunner } from '../../src/worker/runner.js';
import { requireTestDatabaseUrl } from './test-urls.js';

const gatewayPool = createPool(requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test'));
const receiverPool = createPool(requireTestDatabaseUrl('TEST_RECEIVER_DATABASE_URL', 'receiver_test'));
const internalToken = 'integration-workspace-receiver-token-only-00001';
const receiverStore = new PostgresReceiverStore(receiverPool);
const receiver = buildReceiverApp({ store: receiverStore, sharedToken: internalToken });
const deliveryStore = new PostgresDeliveryStore(gatewayPool);
const app = buildApp({
  repository: new PostgresInboxRepository(gatewayPool),
  signingKeys: new Map([['demo-v1', 'integration-workspace-signing-secret-only-0001']]),
  guestWorkspaces: new PostgresGuestWorkspaceStore(gatewayPool),
  workspaceQueries: new PostgresWorkspaceQueries(gatewayPool),
  workspaceSigning: { keyId: 'demo-v1', secret: 'integration-workspace-signing-secret-only-0001' },
  deliveryRecovery: deliveryStore,
  receiverRecovery: receiverStore,
  allowLegacyIngress: false,
});
let runner: WorkerRunner;

beforeAll(async () => {
  await applyMigrations(gatewayPool, 8071133, gatewayMigrations);
  await applyMigrations(receiverPool, 8071134, receiverMigrations);
  const address = await receiver.listen({ host: '127.0.0.1', port: 0 });
  runner = new WorkerRunner({
    store: deliveryStore,
    transport: new HttpDeliveryTransport({
      receiverUrl: `${address}/v1/receive`,
      sharedToken: internalToken,
    }),
    random: () => 0,
  });
});

afterAll(async () => {
  await app.close();
  await receiver.close();
  await gatewayPool.query(
    `DELETE FROM replay_audit WHERE job_id IN
       (SELECT j.id FROM delivery_jobs j JOIN inbox_events e ON e.id = j.inbox_event_id
        WHERE e.event_id = ANY($1::uuid[]))`,
    [[eventId]],
  );
  await gatewayPool.query(
    `DELETE FROM delivery_attempts WHERE job_id IN
       (SELECT j.id FROM delivery_jobs j JOIN inbox_events e ON e.id = j.inbox_event_id
        WHERE e.event_id = ANY($1::uuid[]))`,
    [[eventId]],
  );
  await gatewayPool.query(
    `DELETE FROM delivery_jobs WHERE inbox_event_id IN
       (SELECT id FROM inbox_events WHERE event_id = ANY($1::uuid[]))`,
    [[eventId]],
  );
  await gatewayPool.query('DELETE FROM guest_workspaces WHERE id = $1', [workspaceId]);
  await receiverPool.query('DELETE FROM receiver_fault_plans WHERE delivery_id = $1', [deliveryId]);
  await receiverPool.query('DELETE FROM receiver_receipts WHERE delivery_id = $1', [deliveryId]);
  await receiverPool.query('DELETE FROM receiver_attempt_counts WHERE delivery_id = $1', [deliveryId]);
  await gatewayPool.end();
  await receiverPool.end();
});

let eventId: string = randomUUID();
let workspaceId: string = randomUUID();
let deliveryId: string = randomUUID();

describe('isolated receiver recovery', () => {
  it('restores the fixed receiver and replays a persisted dead job exactly once', async () => {
    const origin = { origin: 'http://localhost:3000', host: 'localhost:3000' };
    const started = await app.inject({ method: 'POST', url: '/api/demo/session', headers: origin });
    const cookie = String(started.headers['set-cookie'] ?? '');
    const tokenValue = cookie.split(';', 1)[0]?.slice('wrl_demo='.length);
    const workspace = await new PostgresGuestWorkspaceStore(gatewayPool).findActive(tokenValue);
    if (!workspace) throw new Error('Guest workspace did not persist');
    workspaceId = workspace.id;

    const requestId = randomUUID();
    eventId = requestId;
    const sent = await app.inject({
      method: 'POST',
      url: '/api/demo/test-events',
      headers: { ...origin, cookie, 'content-type': 'application/json' },
      payload: { request_id: requestId, order_id: 'ord_recover_me', scenario: 'permanent_failure' },
    });
    expect(sent.statusCode).toBe(202);
    const created = await gatewayPool.query<{ id: string; delivery_id: string }>(
      `SELECT j.id, j.delivery_id FROM delivery_jobs j
         JOIN inbox_events e ON e.id = j.inbox_event_id
        WHERE e.workspace_id = $1 AND e.event_id = $2`,
      [workspaceId, eventId],
    );
    const jobId = created.rows[0]?.id;
    deliveryId = created.rows[0]?.delivery_id ?? deliveryId;
    expect(jobId).toBeTruthy();

    expect(await runner.runOnce()).toBe(true);
    expect(
      (await gatewayPool.query('SELECT status FROM delivery_jobs WHERE id = $1', [jobId])).rows[0]?.status,
    ).toBe('DEAD');
    expect(
      (
        await receiverPool.query('SELECT permanent_status FROM receiver_fault_plans WHERE delivery_id = $1', [
          deliveryId,
        ])
      ).rows[0]?.permanent_status,
    ).toBe(422);

    const recovery = await app.inject({ method: 'GET', url: '/api/demo/recovery', headers: { cookie } });
    expect(recovery.json().dead_jobs).toHaveLength(1);
    const restored = await app.inject({
      method: 'POST',
      url: `/api/demo/recovery/${jobId}/restore`,
      headers: { ...origin, cookie },
    });
    expect(restored.json()).toEqual({ status: 'receiver_restored' });

    const replayRequestId = randomUUID();
    const replayed = await app.inject({
      method: 'POST',
      url: `/api/demo/recovery/${jobId}/replay`,
      headers: { ...origin, cookie, 'content-type': 'application/json' },
      payload: { reason: 'Receiver restored for recovery test', request_id: replayRequestId },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({ status: 'processing', replay_generation: 1 });

    expect(await runner.runOnce()).toBe(true);
    expect(
      (await gatewayPool.query('SELECT status FROM delivery_jobs WHERE id = $1', [jobId])).rows[0]?.status,
    ).toBe('SUCCEEDED');
    const receipts = await receiverPool.query<{ workspace_id: string; delivery_id: string }>(
      `SELECT workspace_id::text, delivery_id::text
         FROM receiver_receipts WHERE delivery_id = $1`,
      [deliveryId],
    );
    expect(receipts.rows).toEqual([{ workspace_id: workspaceId, delivery_id: deliveryId }]);

    const repeatedReplay = await app.inject({
      method: 'POST',
      url: `/api/demo/recovery/${jobId}/replay`,
      headers: { ...origin, cookie, 'content-type': 'application/json' },
      payload: { reason: 'Receiver restored for recovery test', request_id: replayRequestId },
    });
    expect(repeatedReplay.json()).toMatchObject({ status: 'delivered', replay_generation: 1 });
  });
});
