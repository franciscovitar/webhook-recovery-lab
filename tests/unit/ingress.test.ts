import { createHmac, randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxRepository } from '../../src/core/inbox.js';
import { buildApp } from '../../src/http/app.js';

const nowMs = Date.parse('2026-11-19T12:00:00.000Z');
const secret = 'testing-hmac-secret-for-webhook-recovery-lab';

function eventPayload(eventId = randomUUID()): string {
  return JSON.stringify({
    event_id: eventId,
    type: 'order.created',
    occurred_at: '2026-11-19T11:59:00Z',
    data: { order_id: 'ord_mock_001' },
  });
}

function headers(payload: string, at = String(nowMs / 1000)) {
  return {
    'content-type': 'application/json',
    'x-wrl-key-id': 'sandbox-v1',
    'x-wrl-timestamp': at,
    'x-wrl-signature': `sha256=${createHmac('sha256', secret).update(at).update('.').update(payload).digest('hex')}`,
  };
}

function makeRepository(): InboxRepository {
  return { accept: vi.fn().mockResolvedValue('accepted'), ping: vi.fn().mockResolvedValue(undefined) };
}

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

function appFor(repository = makeRepository()) {
  const app = buildApp({ repository, signingKeys: new Map([['sandbox-v1', secret]]), nowMs: () => nowMs });
  apps.push(app);
  return { app, repository };
}

describe('webhook ingress HTTP contract', () => {
  it('returns 202 only after repository accepts the event', async () => {
    const { app, repository } = appFor();
    const payload = eventPayload();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: headers(payload),
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'accepted', event_id: JSON.parse(payload).event_id });
    expect(repository.accept).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: 'sandbox',
        payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it('differentiates duplicate from identity conflict', async () => {
    const repository = makeRepository();
    vi.mocked(repository.accept).mockResolvedValueOnce('duplicate').mockResolvedValueOnce('conflict');
    const { app } = appFor(repository);
    const payload = eventPayload();
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: headers(payload),
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: headers(payload),
    });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json().status).toBe('duplicate');
    expect(conflict.statusCode).toBe(409);
  });

  it('rejects invalid signatures before touching the repository', async () => {
    const { app, repository } = appFor();
    const payload = eventPayload();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: { ...headers(payload), 'x-wrl-signature': 'sha256=invalid' },
    });
    expect(response.statusCode).toBe(401);
    expect(repository.accept).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and unknown fields after signature verification', async () => {
    const { app, repository } = appFor();
    for (const payload of ['{bad', JSON.stringify({ ...JSON.parse(eventPayload()), extra: true })]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/sandbox',
        payload,
        headers: headers(payload),
      });
      expect(response.statusCode).toBe(400);
    }
    expect(repository.accept).not.toHaveBeenCalled();
  });

  it('does not accept an oversized payload', async () => {
    const { app, repository } = appFor();
    const payload = `${eventPayload()}${' '.repeat(70_000)}`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: headers(payload),
    });
    expect(response.statusCode).toBe(413);
    expect(repository.accept).not.toHaveBeenCalled();
  });

  it('returns 503 if persistence fails; the sender may retry', async () => {
    const repository = makeRepository();
    vi.mocked(repository.accept).mockRejectedValue(new Error('synthetic unavailable'));
    const { app } = appFor(repository);
    const payload = eventPayload();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/sandbox',
      payload,
      headers: headers(payload),
    });
    expect(response.statusCode).toBe(503);
  });

  it('separates liveness from database readiness', async () => {
    const repository = makeRepository();
    const { app } = appFor(repository);
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/ready')).statusCode).toBe(200);
    vi.mocked(repository.ping).mockRejectedValueOnce(new Error('synthetic database unavailable'));
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect((await app.inject('/health')).statusCode).toBe(200);
  });
});
