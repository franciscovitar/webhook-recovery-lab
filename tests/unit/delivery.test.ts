import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  classifyHttpStatus,
  computeRetryDelayMs,
  type ClaimedJob,
  type DeliveryStore,
  type DeliveryTransport,
} from '../../src/core/delivery.js';
import { WorkerRunner } from '../../src/worker/runner.js';

function job(): ClaimedJob {
  return {
    jobId: randomUUID(),
    eventId: randomUUID(),
    deliveryId: randomUUID(),
    leaseToken: randomUUID(),
    attemptSequence: 1,
    attemptsInGeneration: 1,
    replayGeneration: 0,
    event: {
      event_id: randomUUID(),
      type: 'order.created',
      occurred_at: '2026-11-19T12:00:00Z',
      data: { order_id: 'ord_001' },
    },
  };
}

function store(nextJob: ClaimedJob | null): DeliveryStore {
  return {
    claimNext: vi.fn().mockResolvedValueOnce(nextJob),
    finish: vi.fn().mockResolvedValue(true),
    ping: vi.fn().mockResolvedValue(undefined),
    replayDead: vi.fn().mockResolvedValue(1),
  };
}

describe('delivery classification and backoff', () => {
  it('classifies success, retryable and permanent responses', () => {
    expect(classifyHttpStatus(200, 12).kind).toBe('success');
    expect(classifyHttpStatus(204, 12).kind).toBe('success');
    for (const code of [408, 429, 500, 502, 503, 504]) {
      expect(classifyHttpStatus(code, 12).kind).toBe('retry');
    }
    for (const code of [400, 401, 403, 404, 409, 422, 501]) {
      expect(classifyHttpStatus(code, 12).kind).toBe('permanent');
    }
  });

  it('caps delay, injects bounded jitter and rejects invalid attempt numbers', () => {
    expect(computeRetryDelayMs(1, () => 0)).toBe(1_000);
    expect(computeRetryDelayMs(2, () => 0)).toBe(2_000);
    expect(computeRetryDelayMs(3, () => 1)).toBe(5_000);
    expect(computeRetryDelayMs(10, () => 1)).toBe(60_000);
    expect(() => computeRetryDelayMs(0)).toThrow();
  });
});

describe('worker orchestration', () => {
  it('returns false when no work is due', async () => {
    const db = store(null);
    const receiver: DeliveryTransport = { send: vi.fn() };
    const runner = new WorkerRunner({ store: db, transport: receiver });
    expect(await runner.runOnce()).toBe(false);
    expect(receiver.send).not.toHaveBeenCalled();
  });

  it('does not hold the DB claim when delivering and records the result', async () => {
    const j = job();
    const db = store(j);
    const receiver: DeliveryTransport = {
      send: vi.fn().mockResolvedValue({ kind: 'success', httpStatus: 200, latencyMs: 5, errorClass: null }),
    };
    const runner = new WorkerRunner({ store: db, transport: receiver });
    expect(await runner.runOnce()).toBe(true);
    expect(receiver.send).toHaveBeenCalledWith(j);
    expect(db.finish).toHaveBeenCalledExactlyOnceWith(j, expect.objectContaining({ kind: 'success' }), 0);
  });

  it('calculates retry delay using the claimed attempt ordinal', async () => {
    const j = { ...job(), attemptsInGeneration: 3 };
    const db = store(j);
    const receiver: DeliveryTransport = {
      send: vi
        .fn()
        .mockResolvedValue({ kind: 'retry', httpStatus: 503, latencyMs: 4, errorClass: 'transient_http' }),
    };
    const runner = new WorkerRunner({ store: db, transport: receiver, random: () => 0 });
    await runner.runOnce();
    expect(db.finish).toHaveBeenCalledWith(j, expect.objectContaining({ kind: 'retry' }), 4_000);
  });

  it('models a crash after remote success but before local ACK', async () => {
    const j = job();
    const db = store(j);
    const receiver: DeliveryTransport = {
      send: vi.fn().mockResolvedValue({ kind: 'success', httpStatus: 200, latencyMs: 1, errorClass: null }),
    };
    const runner = new WorkerRunner({
      store: db,
      transport: receiver,
      afterTransport: () => {
        throw new Error('simulated hard crash before DB ACK');
      },
    });
    await expect(runner.runOnce()).rejects.toThrow('simulated hard crash');
    expect(receiver.send).toHaveBeenCalledOnce();
    expect(db.finish).not.toHaveBeenCalled();
  });
});
