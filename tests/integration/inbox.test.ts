import { createHmac, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../src/db/pool.js';
import { PostgresInboxRepository } from '../../src/db/postgres-inbox.js';
import { buildApp } from '../../src/http/app.js';

// This suite NEVER skips. CI must fail if the actual PostgreSQL service is unavailable.
const connectionString = process.env['TEST_DATABASE_URL'];
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL required: integration suite must run against real PostgreSQL');
}

const pool = createPool(connectionString);
const repository = new PostgresInboxRepository(pool);
const secret = 'integration-signing-secret-for-only-synthetic-fixtures';
const app = buildApp({ repository, signingKeys: new Map([['sandbox-v1', secret]]) });

beforeAll(async () => {
  await pool.query('SELECT 1');
  const migration = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
  expect(migration.rows.map((row) => row.version)).toContain('0001_initial');
});

afterAll(async () => {
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
});
