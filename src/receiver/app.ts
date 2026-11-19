import { timingSafeEqual } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import Fastify, { type FastifyInstance } from 'fastify';

import { receiverDeliverySchema, type ReceiverStore } from './contracts.js';

export interface ReceiverAppOptions {
  store: ReceiverStore;
  sharedToken: string;
}

function isAuthorized(value: string | undefined, token: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const received = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function buildReceiverApp({ store, sharedToken }: ReceiverAppOptions): FastifyInstance {
  if (sharedToken.length < 32) throw new Error('shared token must be >=32 chars');
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await store.ping();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ error: 'dependency_unavailable' });
    }
  });

  app.post('/v1/receive', async (request, reply) => {
    if (!isAuthorized(request.headers.authorization, sharedToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = receiverDeliverySchema.safeParse(request.body);
    if (!parsed.success || request.headers['x-delivery-id'] !== parsed.data.delivery_id) {
      return reply.code(400).send({ error: 'invalid_delivery' });
    }

    try {
      const outcome = await store.receive(parsed.data);
      // Delay comes AFTER commit to recreate a lost/late HTTP ACK safely.
      if (outcome.delayAfterCommitMs > 0) await wait(outcome.delayAfterCommitMs);
      return reply.code(outcome.code).send({ status: outcome.result });
    } catch {
      return reply.code(503).send({ error: 'dependency_unavailable' });
    }
  });

  return app;
}
