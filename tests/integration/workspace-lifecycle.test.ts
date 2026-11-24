import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, gatewayMigrations, receiverMigrations } from '../../src/db/migrations.js';
import { PostgresGuestWorkspaceStore } from '../../src/db/postgres-guest-workspaces.js';
import { PostgresInboxRepository } from '../../src/db/postgres-inbox.js';
import { PostgresReceiverStore } from '../../src/db/postgres-receiver.js';
import { createPool } from '../../src/db/pool.js';
import { WorkspaceLifecycleRunner } from '../../src/ops/workspace-lifecycle.js';
import { parseSandboxEvent } from '../../src/core/event.js';
import { sha256Hex } from '../../src/core/signature.js';
import { requireTestDatabaseUrl } from './test-urls.js';

const gateway = createPool(requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test'));
const receiver = createPool(requireTestDatabaseUrl('TEST_RECEIVER_DATABASE_URL', 'receiver_test'));
const workspaces = new PostgresGuestWorkspaceStore(gateway);
const inbox = new PostgresInboxRepository(gateway);
const receiverStore = new PostgresReceiverStore(receiver);

beforeAll(async () => {
  await applyMigrations(gateway, 8071133, gatewayMigrations);
  await applyMigrations(receiver, 8071134, receiverMigrations);
});

beforeEach(async () => {
  await gateway.query('DELETE FROM replay_audit WHERE workspace_id IS NOT NULL');
  await gateway.query(`DELETE FROM delivery_attempts WHERE job_id IN (
    SELECT j.id FROM delivery_jobs j JOIN inbox_events e ON e.id = j.inbox_event_id WHERE e.workspace_id IS NOT NULL)`);
  await gateway.query(`DELETE FROM delivery_jobs WHERE inbox_event_id IN (
    SELECT id FROM inbox_events WHERE workspace_id IS NOT NULL)`);
  await gateway.query('DELETE FROM guest_workspaces');
  await receiver.query('DELETE FROM receiver_fault_plans WHERE workspace_id IS NOT NULL');
  await receiver.query('DELETE FROM receiver_receipts WHERE workspace_id IS NOT NULL');
  await receiver.query('DELETE FROM receiver_attempt_counts WHERE workspace_id IS NOT NULL');
});

afterAll(async () => {
  await gateway.end();
  await receiver.end();
});

describe('guest workspace lifecycle', () => {
  it('keeps receiver delivery identities bound to their originating workspace', async () => {
    const deliveryId = randomUUID();
    const owner = randomUUID();
    const other = randomUUID();
    await receiverStore.preparePermanentFailure(deliveryId, owner);
    await expect(receiverStore.preparePermanentFailure(deliveryId, other)).rejects.toThrow(
      'another workspace',
    );
    const result = await receiverStore.receive({
      delivery_id: deliveryId,
      workspace_id: other,
      event_id: randomUUID(),
      order_id: 'ord_wrong_space',
    });
    expect(result.code).toBe(409);
    expect(
      (
        await receiver.query('SELECT workspace_id FROM receiver_fault_plans WHERE delivery_id = $1', [
          deliveryId,
        ])
      ).rows[0]?.workspace_id,
    ).toBe(owner);
  });

  it('retries receiver cleanup after a partial cross-database failure and removes stale orphan plans', async () => {
    const admission = await workspaces.create();
    if (admission.status !== 'created') throw new Error('Admission failed');
    const deliveryId = randomUUID();
    const event = {
      event_id: randomUUID(),
      type: 'order.created',
      occurred_at: new Date().toISOString(),
      data: { order_id: 'ord_cleanup_cross_db' },
    };
    const rawBody = Buffer.from(JSON.stringify(event));
    const parsed = parseSandboxEvent(rawBody);
    if (!parsed) throw new Error('Invalid event fixture');
    expect(
      await inbox.accept({
        provider: 'sandbox',
        workspaceId: admission.workspace.id,
        deliveryId,
        event: parsed,
        rawBody,
        payloadSha256: sha256Hex(rawBody),
      }),
    ).toBe('accepted');
    await receiverStore.preparePermanentFailure(deliveryId, admission.workspace.id);
    await gateway.query(
      "UPDATE guest_workspaces SET created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1",
      [admission.workspace.id],
    );

    const orphanId = randomUUID();
    const orphanWorkspace = randomUUID();
    await receiverStore.preparePermanentFailure(orphanId, orphanWorkspace);
    await receiver.query(
      "UPDATE receiver_fault_plans SET prepared_at = clock_timestamp() - interval '2 hours' WHERE delivery_id = $1",
      [orphanId],
    );

    let failOnce = true;
    const interrupted = new WorkspaceLifecycleRunner(workspaces, {
      purgeWorkspace: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('temporary receiver outage');
        }
      },
      listOrphanCandidates: (before, limit) => receiverStore.listOrphanCandidates(before, limit),
      removeOrphanPlan: (id, workspaceId) => receiverStore.removeOrphanPlan(id, workspaceId),
    });
    await interrupted.runOnce();
    expect(
      (
        await gateway.query('SELECT 1 FROM workspace_cleanup_queue WHERE workspace_id = $1', [
          admission.workspace.id,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (await receiver.query('SELECT 1 FROM receiver_fault_plans WHERE delivery_id = $1', [deliveryId]))
        .rowCount,
    ).toBe(1);
    expect(
      (await receiver.query('SELECT 1 FROM receiver_fault_plans WHERE delivery_id = $1', [orphanId]))
        .rowCount,
    ).toBe(0);

    await new WorkspaceLifecycleRunner(workspaces, receiverStore).runOnce();
    expect(
      (await gateway.query('SELECT 1 FROM guest_workspaces WHERE id = $1', [admission.workspace.id]))
        .rowCount,
    ).toBe(0);
    expect(
      (await receiver.query('SELECT 1 FROM receiver_fault_plans WHERE delivery_id = $1', [deliveryId]))
        .rowCount,
    ).toBe(0);
    const lateDelivery = await receiverStore.receive({
      delivery_id: deliveryId,
      workspace_id: admission.workspace.id,
      event_id: event.event_id,
      order_id: 'ord_cleanup_cross_db',
    });
    expect(lateDelivery.code).toBe(410);
    expect(
      (await receiver.query('SELECT 1 FROM receiver_attempt_counts WHERE delivery_id = $1', [deliveryId]))
        .rowCount,
    ).toBe(0);
  });
});
