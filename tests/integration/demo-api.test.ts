import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, gatewayMigrations } from '../../src/db/migrations.js';
import { PostgresGuestWorkspaceStore } from '../../src/db/postgres-guest-workspaces.js';
import { PostgresInboxRepository } from '../../src/db/postgres-inbox.js';
import { PostgresWorkspaceQueries } from '../../src/db/postgres-workspace-queries.js';
import { createPool } from '../../src/db/pool.js';
import { signPayload } from '../../src/core/signature.js';
import { buildApp } from '../../src/http/app.js';
import { requireTestDatabaseUrl } from './test-urls.js';

const pool = createPool(requireTestDatabaseUrl('TEST_DATABASE_URL', 'gateway_test'));
const store = new PostgresGuestWorkspaceStore(pool);
const app = buildApp({
  repository: new PostgresInboxRepository(pool),
  signingKeys: new Map([['demo-v1', 'integration-signing-secret-for-only-synthetic-fixtures']]),
  guestWorkspaces: store,
  workspaceQueries: new PostgresWorkspaceQueries(pool),
  workspaceSigning: {
    keyId: 'demo-v1',
    secret: 'integration-signing-secret-for-only-synthetic-fixtures',
  },
  deliveryRecovery: { replayDead: async () => 1 },
  receiverRecovery: {
    preparePermanentFailure: async () => undefined,
    restoreFaultPlan: async () => true,
  },
  allowLegacyIngress: false,
});

beforeAll(async () => {
  await applyMigrations(pool, 8071133, gatewayMigrations);
});

beforeEach(async () => {
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
  await app.close();
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
  await pool.end();
});

describe('guest workspace API', () => {
  it('creates a cookie session, submits signed ingress and scopes all reads', async () => {
    const origin = { origin: 'http://localhost:3000', host: 'localhost:3000' };
    const created = await app.inject({ method: 'POST', url: '/api/demo/session', headers: origin });
    expect(created.statusCode).toBe(201);
    const cookie = String(created.headers['set-cookie'] ?? '');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const token = cookie.split(';', 1)[0]?.slice('wrl_demo='.length);
    const workspace = await store.findActive(token);
    expect(workspace).not.toBeNull();

    const secondSession = await app.inject({ method: 'POST', url: '/api/demo/session', headers: origin });
    const secondCookie = String(secondSession.headers['set-cookie'] ?? '').split(';', 1)[0] ?? '';
    const sent = await app.inject({
      method: 'POST',
      url: '/api/demo/test-events',
      headers: { ...origin, cookie, 'content-type': 'application/json' },
      payload: {
        order_id: 'ord_guest_scope',
        request_id: 'c7eb5735-cab2-4770-a834-0eb8e0369e78',
        scenario: 'normal',
      },
    });
    expect(sent.statusCode).toBe(202);
    expect(sent.json()).toMatchObject({ status: 'accepted', signature_accepted: true });
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/demo/test-events',
      headers: { ...origin, cookie, 'content-type': 'application/json' },
      payload: {
        order_id: 'ord_guest_scope',
        request_id: 'c7eb5735-cab2-4770-a834-0eb8e0369e78',
        scenario: 'normal',
      },
    });
    expect(repeated.json()).toMatchObject({ status: 'duplicate', event_id: sent.json().event_id });

    const ownEvents = await app.inject({ method: 'GET', url: '/api/demo/events', headers: { cookie } });
    expect(ownEvents.statusCode).toBe(200);
    expect(ownEvents.json().events).toHaveLength(1);
    expect(ownEvents.json().events[0].payload.data.order_id).toBe('ord_guest_scope');
    const detail = await app.inject({
      method: 'GET',
      url: `/api/demo/events/${sent.json().event_id}`,
      headers: { cookie },
    });
    expect(detail.json().signature_verified).toBe(true);
    const duplicated = await app.inject({
      method: 'POST',
      url: `/api/demo/events/${sent.json().event_id}/duplicate`,
      headers: { ...origin, cookie },
    });
    expect(duplicated.statusCode).toBe(202);
    expect(duplicated.json()).toMatchObject({
      event_id: sent.json().event_id,
      status: 'duplicate',
      signature_accepted: true,
    });
    const afterDuplicate = await app.inject({ method: 'GET', url: '/api/demo/events', headers: { cookie } });
    expect(afterDuplicate.json().total).toBe(1);
    const filteredOut = await app.inject({
      method: 'GET',
      url: '/api/demo/events?from=2027-01-01T00:00:00.000Z',
      headers: { cookie },
    });
    expect(filteredOut.json()).toMatchObject({ total: 0, events: [] });
    const badDateRange = await app.inject({
      method: 'GET',
      url: '/api/demo/events?from=2027-01-02T00:00:00.000Z&to=2027-01-01T00:00:00.000Z',
      headers: { cookie },
    });
    expect(badDateRange.statusCode).toBe(400);

    const foreignEvents = await app.inject({
      method: 'GET',
      url: '/api/demo/events',
      headers: { cookie: secondCookie },
    });
    expect(foreignEvents.json().events).toEqual([]);
    const foreignDetail = await app.inject({
      method: 'GET',
      url: `/api/demo/events/${sent.json().event_id}`,
      headers: { cookie: secondCookie },
    });
    expect(foreignDetail.statusCode).toBe(404);
    expect(foreignDetail.json()).toEqual({ error: 'event_not_found' });

    const payload = JSON.stringify({
      event_id: 'c7eb5735-cab2-4770-a834-0eb8e0369e78',
      type: 'order.created',
      occurred_at: '2026-11-24T10:00:00Z',
      data: { order_id: 'ord_public' },
    });
    const timestamp = String(Math.trunc(Date.now() / 1000));
    const rawIngress = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      headers: {
        'content-type': 'application/json',
        'x-wrl-key-id': 'demo-v1',
        'x-wrl-timestamp': timestamp,
        'x-wrl-signature': signPayload(
          Buffer.from(payload),
          timestamp,
          'integration-signing-secret-for-only-synthetic-fixtures',
        ),
      },
      payload,
    });
    expect(rawIngress.statusCode).toBe(404);
    expect(workspace).not.toBeNull();
  });

  it('rejects cross-origin writes before creating an event', async () => {
    const cookieResponse = await app.inject({
      method: 'POST',
      url: '/api/demo/session',
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    const before = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM inbox_events');
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/demo/test-events',
      headers: {
        cookie: cookieResponse.headers['set-cookie'],
        origin: 'https://attacker.invalid',
        host: 'localhost:3000',
      },
      payload: {},
    });
    const after = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM inbox_events');
    expect(rejected.statusCode).toBe(403);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
