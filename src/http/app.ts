import Fastify, { type FastifyInstance } from 'fastify';

import { parseSandboxEvent } from '../core/event.js';
import { type InboxRepository } from '../core/inbox.js';
import { sha256Hex, verifySignature } from '../core/signature.js';

const BODY_LIMIT_BYTES = 64 * 1024;

export interface AppOptions {
  repository: InboxRepository;
  signingKeys: ReadonlyMap<string, string>;
  nowMs?: () => number;
  logger?: boolean;
}

function asSingleString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function buildApp({
  repository,
  signingKeys,
  nowMs = Date.now,
  logger = false,
}: AppOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT_BYTES });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await repository.ping();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ error: 'dependency_unavailable' });
    }
  });

  // Keep the body bytes intact; the signature covers bytes, not parsed JSON.
  app.register(async (webhook) => {
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: BODY_LIMIT_BYTES },
      (_request, body, done) => done(null, body),
    );

    webhook.post('/v1/webhooks/sandbox', async (request, reply) => {
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(400).send({ error: 'invalid_body' });
      }

      const rawBody = request.body;
      const validSignature = verifySignature({
        rawBody,
        headers: {
          keyId: asSingleString(request.headers['x-wrl-key-id']),
          timestamp: asSingleString(request.headers['x-wrl-timestamp']),
          signature: asSingleString(request.headers['x-wrl-signature']),
        },
        keys: signingKeys,
        nowMs: nowMs(),
      });

      if (!validSignature) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }

      const event = parseSandboxEvent(rawBody);
      if (!event) {
        return reply.code(400).send({ error: 'invalid_event' });
      }

      try {
        const outcome = await repository.accept({
          provider: 'sandbox',
          event,
          rawBody,
          payloadSha256: sha256Hex(rawBody),
        });
        if (outcome === 'conflict') {
          request.log.warn({ event_id: event.event_id }, 'webhook identity reused with different payload');
          return reply.code(409).send({ error: 'event_identity_conflict' });
        }
        return reply.code(202).send({ event_id: event.event_id, status: outcome });
      } catch (error) {
        request.log.error(
          { err: error instanceof Error ? error.message : 'unknown' },
          'inbox transaction failed',
        );
        return reply.code(503).send({ error: 'dependency_unavailable' });
      }
    });
  });

  return app;
}
