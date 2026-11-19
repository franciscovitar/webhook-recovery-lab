import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildReceiverApp } from '../../src/receiver/app.js';
import type { ReceiverStore } from '../../src/receiver/contracts.js';

const token = 'local-only-test-transport-shared-token-123456';
const payload = () => ({ delivery_id: randomUUID(), event_id: randomUUID(), order_id: 'ord_synth' });

function store(): ReceiverStore {
  return {
    receive: vi.fn().mockResolvedValue({ code: 200, result: 'accepted', delayAfterCommitMs: 0 }),
    ping: vi.fn().mockResolvedValue(undefined),
  };
}

const apps: ReturnType<typeof buildReceiverApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

function appFor(db = store()) {
  const app = buildReceiverApp({ store: db, sharedToken: token });
  apps.push(app);
  return { app, db };
}

describe('internal mock receiver', () => {
  it('authenticates the transport token before accessing persistence', async () => {
    const { app, db } = appFor();
    const delivery = payload();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/receive',
      payload: delivery,
      headers: { 'x-delivery-id': delivery.delivery_id },
    });
    expect(response.statusCode).toBe(401);
    expect(db.receive).not.toHaveBeenCalled();
  });

  it('requires body and header to agree on a stable delivery ID', async () => {
    const { app, db } = appFor();
    const delivery = payload();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/receive',
      payload: delivery,
      headers: { authorization: `Bearer ${token}`, 'x-delivery-id': randomUUID() },
    });
    expect(response.statusCode).toBe(400);
    expect(db.receive).not.toHaveBeenCalled();
  });

  it('forwards accepted delivery to its separately persisted receiver', async () => {
    const { app, db } = appFor();
    const delivery = payload();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/receive',
      payload: delivery,
      headers: { authorization: `Bearer ${token}`, 'x-delivery-id': delivery.delivery_id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('accepted');
    expect(db.receive).toHaveBeenCalledExactlyOnceWith(delivery);
  });

  it('returns an injected 503 without changing the transport protocol', async () => {
    const db = store();
    vi.mocked(db.receive).mockResolvedValueOnce({
      code: 503,
      result: 'injected_failure',
      delayAfterCommitMs: 0,
    });
    const { app } = appFor(db);
    const delivery = payload();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/receive',
      payload: delivery,
      headers: { authorization: `Bearer ${token}`, 'x-delivery-id': delivery.delivery_id },
    });
    expect(response.statusCode).toBe(503);
  });
});
