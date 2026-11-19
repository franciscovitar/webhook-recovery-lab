import { createHmac, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../src/db/pool.js';
import { PostgresInboxRepository } from '../../src/db/postgres-inbox.js';
import { buildApp } from '../../src/http/app.js';
import { requireTestDatabaseUrl } from './test-urls.js';

// This suite NEVER skips. CI must fail if the actual PostgreSQL service is unavailable.
const connectionString = requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test');

const pool = createPool(connectionString);
const repository = new PostgresInboxRepository(pool);
const secret = 'integration-signing-secret-for-only-synthetic-fixtures';
const app = buildApp({ repository, signingKeys: new Map([['sandbox-v1', secret]]) });
const createdEventIds: string[] = [];

beforeAll(async () => {
  await pool.query('SELECT 1');
  const migration = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  expect(migration.rows.map((row) => row.version)).toContain('0001_initial');
});

afterAll(async () => {
  if (createdEventIds.length > 0) {
    await pool.query(
      'DELETE FROM delivery_jobs WHERE inbox_event_id IN (SELECT id FROM inbox_events WHERE event_id = ANY($1::uuid[]))',
      [createdEventIds],
    );
    await pool.query('DELETE FROM inbox_events WHERE event_id = ANY($1::uuid[])', [createdEventIds]);
  }
  await app.close();
  await pool.end();
});

function signed(payload: string) {
  const timestamp = String(Math.trunc(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(timestamp).update('.').update(payload).digest('hex');
  return {
    'content-type': 'application/json',
    'x-wrl-key-id': 'sandbox-v1',
    'x-wrl-timestamp': timestamp,
    'x-wrl-signature': `sha256=${signature}`,
  };
}

function eventPayload(eventId = randomUUID(), orderId = 'ord_test') {
  return JSON.stringify({
    event_id: eventId,
    type: 'order.created',
    occurred_at: '2026-11-19T11:59:00Z',
    data: { order_id: orderId },
  });
}

describe('real PostgreSQL ingress', () => {
  it('persists inbox and exactly one job and handles redelivery', async () => {
    const payload = eventPayload();
    const eventId = JSON.parse(payload).event_id as string;
    createdEventIds.push(eventId);
    const original = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: signed(payload),
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: signed(payload),
    });
    expect(original.statusCode).toBe(202);
    expect(original.json().status).toBe('accepted');
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().status).toBe('duplicate');
    const counts = await pool.query<{ events: string; jobs: string }>(
      `SELECT (SELECT COUNT(*) FROM inbox_events WHERE event_id = $1)::text events,
              (SELECT COUNT(*) FROM delivery_jobs WHERE inbox_event_id IN
                (SELECT id FROM inbox_events WHERE event_id = $1))::text jobs`,
      [eventId],
    );
    expect(counts.rows[0]).toEqual({ events: '1', jobs: '1' });
  });

  it('returns a conflict for changed payload without a second job', async () => {
    const eventId = randomUUID();
    createdEventIds.push(eventId);
    const first = eventPayload(eventId, 'ord_1');
    const second = eventPayload(eventId, 'ord_2');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/webhooks/sandbox',
          payload: first,
          headers: signed(first),
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/webhooks/sandbox',
          payload: second,
          headers: signed(second),
        })
      ).statusCode,
    ).toBe(409);
    const rows = await pool.query<{ order_id: string }>(
      `SELECT payload->'data'->>'order_id' order_id FROM inbox_events WHERE event_id=$1`,
      [eventId],
    );
    expect(rows.rows).toEqual([{ order_id: 'ord_1' }]);
  });

  it('deduplicates 20 concurrent connections by database unique constraint', async () => {
    const payload = eventPayload();
    const eventId = JSON.parse(payload).event_id as string;
    createdEventIds.push(eventId);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({ method: 'POST', url: '/v1/webhooks/sandbox', payload, headers: signed(payload) }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 202)).toHaveLength(20);
    expect(responses.filter((response) => response.json().status === 'accepted')).toHaveLength(1);
    expect(responses.filter((response) => response.json().status === 'duplicate')).toHaveLength(19);
    const count = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text count FROM inbox_events WHERE event_id=$1',
      [eventId],
    );
    expect(count.rows[0]?.count).toBe('1');
  });

  it('rolls back inbox and releases its identity if creating the job fails', async () => {
    const eventId = randomUUID();
    createdEventIds.push(eventId);
    const payload = eventPayload(eventId, 'ord_rollback');
    // The trigger is restricted to this synthetic event and is removed in
    // finally. The test never changes any demo/client database.
    const triggerName = `wrl_test_reject_${eventId.replaceAll('-', '').slice(0, 16)}`;
    await pool.query(
      `CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF EXISTS (SELECT 1 FROM inbox_events
                     WHERE id = NEW.inbox_event_id AND event_id = '${eventId}'::uuid) THEN
           RAISE EXCEPTION 'synthetic job insert rejection';
         END IF;
         RETURN NEW;
       END; $$`,
    );
    try {
      await pool.query(
        `CREATE TRIGGER ${triggerName}_trigger BEFORE INSERT ON delivery_jobs
           FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`,
      );
      const failure = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/sandbox',
        payload,
        headers: signed(payload),
      });
      expect(failure.statusCode).toBe(503);
      const count = await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text count FROM inbox_events WHERE event_id=$1',
        [eventId],
      );
      expect(count.rows[0]?.count).toBe('0');
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${triggerName}_trigger ON delivery_jobs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${triggerName}()`);
    }

    const retried = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: signed(payload),
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().status).toBe('accepted');
    const counts = await pool.query<{ events: string; jobs: string }>(
      `SELECT (SELECT COUNT(*) FROM inbox_events WHERE event_id=$1)::text events,
              (SELECT COUNT(*) FROM delivery_jobs WHERE inbox_event_id IN
                (SELECT id FROM inbox_events WHERE event_id=$1))::text jobs`,
      [eventId],
    );
    expect(counts.rows[0]).toEqual({ events: '1', jobs: '1' });
  });
});
