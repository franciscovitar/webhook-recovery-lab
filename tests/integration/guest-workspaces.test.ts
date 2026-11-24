import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { guestTokenDigest, newGuestToken } from '../../src/core/guest-session.js';
import { applyMigrations, gatewayMigrations } from '../../src/db/migrations.js';
import { createPool } from '../../src/db/pool.js';
import { PostgresGuestWorkspaceStore } from '../../src/db/postgres-guest-workspaces.js';
import { PostgresInboxRepository } from '../../src/db/postgres-inbox.js';
import { sha256Hex } from '../../src/core/signature.js';
import { parseSandboxEvent } from '../../src/core/event.js';
import { requireTestDatabaseUrl } from './test-urls.js';

const pool = createPool(requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test'));
const store = new PostgresGuestWorkspaceStore(pool);
const inbox = new PostgresInboxRepository(pool);

beforeAll(async () => {
  await applyMigrations(pool, 8071133, gatewayMigrations);
});
beforeEach(async () => {
  // Only the new table in the explicitly guarded disposable test database.
  await pool.query(
    `DELETE FROM replay_audit r USING delivery_jobs j, inbox_events e
      WHERE r.job_id = j.id AND j.inbox_event_id = e.id AND e.workspace_id IS NOT NULL`,
  );
  await pool.query(
    `DELETE FROM delivery_attempts a USING delivery_jobs j, inbox_events e
      WHERE a.job_id = j.id AND j.inbox_event_id = e.id AND e.workspace_id IS NOT NULL`,
  );
  await pool.query(
    `DELETE FROM delivery_jobs WHERE inbox_event_id IN
       (SELECT id FROM inbox_events WHERE workspace_id IS NOT NULL)`,
  );
  await pool.query('DELETE FROM guest_workspaces');
});
afterAll(async () => {
  await pool.end();
});

describe('guest workspace persistence', () => {
  it('reapplies the migration manifest without changing the existing ledger', async () => {
    expect(await applyMigrations(pool, 8071133, gatewayMigrations)).toEqual([]);
    const result = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
    expect(result.rows.map((row) => row.version)).toEqual(expect.arrayContaining([...gatewayMigrations]));
  });

  it('resolves independent guests without retaining bearer credentials', async () => {
    const first = await store.create();
    const second = await store.create();
    if (first.status !== 'created' || second.status !== 'created') throw new Error('Admission failed');
    expect(first.workspace.id).not.toBe(second.workspace.id);
    expect(await store.findActive(first.token)).toEqual(first.workspace);
    expect(await store.findActive(second.token)).toEqual(second.workspace);
    expect(await store.findActive(newGuestToken())).toBeNull();
    const row = await pool.query<{ token_sha256: string }>(
      'SELECT token_sha256 FROM guest_workspaces WHERE id = $1',
      [first.workspace.id],
    );
    expect(row.rows[0]?.token_sha256).toBe(guestTokenDigest(first.token));
    expect(row.rows[0]?.token_sha256).not.toBe(first.token);
    await pool.query(
      `UPDATE guest_workspaces SET created_at = now() - interval '25 hours',
         expires_at = now() - interval '1 hour' WHERE id = $1`,
      [first.workspace.id],
    );
    expect(await store.findActive(first.token)).toBeNull();
    expect(await store.findActive(second.token)).toEqual(second.workspace);
    await pool.query('UPDATE guest_workspaces SET closed_at = clock_timestamp() WHERE id = $1', [
      second.workspace.id,
    ]);
    expect(await store.findActive(second.token)).toBeNull();
  });

  it('enforces hourly admission under concurrent starts', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => store.create()));
    expect(results.filter((result) => result.status === 'created')).toHaveLength(10);
    expect(results.filter((result) => result.status === 'capacity')).toHaveLength(2);
    const count = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM guest_workspaces');
    expect(count.rows[0]?.count).toBe('10');
  });

  it('enforces the active cap even after the hourly window elapses', async () => {
    await pool.query(
      `INSERT INTO guest_workspaces (id, token_sha256, created_at, expires_at)
       SELECT gen_random_uuid(), lpad(i::text, 64, '0'), now() - interval '2 hours',
              now() + interval '22 hours'
       FROM generate_series(1, 30) i`,
    );
    expect(await store.create()).toEqual({ status: 'capacity' });
  });

  it('allows identical provider event IDs in separate workspaces and scopes dedupe', async () => {
    const first = await store.create();
    const second = await store.create();
    if (first.status !== 'created' || second.status !== 'created') throw new Error('Admission failed');
    const event = {
      event_id: 'f1961c82-e6f2-47d4-9df4-17ab231fd752',
      type: 'order.created',
      occurred_at: '2026-11-24T10:00:00Z',
      data: { order_id: 'ord_isolation' },
    };
    const rawBody = Buffer.from(JSON.stringify(event));
    const parsed = parseSandboxEvent(rawBody);
    if (!parsed) throw new Error('Invalid synthetic event fixture');
    const incoming = {
      provider: 'sandbox' as const,
      event: parsed,
      rawBody,
      payloadSha256: sha256Hex(rawBody),
    };
    expect(await inbox.accept({ ...incoming, workspaceId: first.workspace.id })).toBe('accepted');
    expect(await inbox.accept({ ...incoming, workspaceId: first.workspace.id })).toBe('duplicate');
    expect(await inbox.accept({ ...incoming, workspaceId: second.workspace.id })).toBe('accepted');
    const rows = await pool.query<{ workspace_id: string; count: string }>(
      `SELECT workspace_id::text, count(*)::text AS count FROM inbox_events
        WHERE event_id = $1 GROUP BY workspace_id ORDER BY workspace_id`,
      [event.event_id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.count)).toEqual(['1', '1']);
    await pool.query(
      `DELETE FROM delivery_jobs WHERE inbox_event_id IN
         (SELECT id FROM inbox_events WHERE event_id = $1)`,
      [event.event_id],
    );
    await pool.query('DELETE FROM inbox_events WHERE event_id = $1', [event.event_id]);
  });

  it('caps each workspace at ten persisted events', async () => {
    const admitted = await store.create();
    if (admitted.status !== 'created') throw new Error('Admission failed');
    const outcomes = [];
    for (let index = 0; index < 11; index++) {
      const event = {
        event_id: randomUUID(),
        type: 'order.created',
        occurred_at: '2026-11-24T10:00:00Z',
        data: { order_id: `ord_limit_${index}` },
      };
      const rawBody = Buffer.from(JSON.stringify(event));
      const parsed = parseSandboxEvent(rawBody);
      if (!parsed) throw new Error('Invalid synthetic event fixture');
      outcomes.push(
        await inbox.accept({
          provider: 'sandbox',
          workspaceId: admitted.workspace.id,
          event: parsed,
          rawBody,
          payloadSha256: sha256Hex(rawBody),
        }),
      );
    }
    expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome === 'capacity')).toHaveLength(1);
    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM inbox_events WHERE workspace_id = $1',
      [admitted.workspace.id],
    );
    expect(count.rows[0]?.count).toBe('10');
    await pool.query(
      'DELETE FROM delivery_jobs WHERE inbox_event_id IN (SELECT id FROM inbox_events WHERE workspace_id = $1)',
      [admitted.workspace.id],
    );
    await pool.query('DELETE FROM guest_workspaces WHERE id = $1', [admitted.workspace.id]);
  });
});
