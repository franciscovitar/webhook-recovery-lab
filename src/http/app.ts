import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { resolve } from 'node:path';

import { parseSandboxEvent, sandboxEventSchema } from '../core/event.js';
import { type InboxRepository } from '../core/inbox.js';
import type { DeliveryStore } from '../core/delivery.js';
import { sha256Hex, signPayload, verifySignature } from '../core/signature.js';
import type { GuestAdmission, GuestWorkspace } from '../db/postgres-guest-workspaces.js';
import { parseWorkspaceJobState, type PostgresWorkspaceQueries } from '../db/postgres-workspace-queries.js';

const BODY_LIMIT_BYTES = 64 * 1024;

export interface AppOptions {
  repository: InboxRepository;
  signingKeys: ReadonlyMap<string, string>;
  nowMs?: () => number;
  logger?: boolean;
  guestWorkspaces?: {
    create(): Promise<GuestAdmission>;
    findActive(token: unknown): Promise<GuestWorkspace | null>;
    consumeMutation?(workspaceId: string): Promise<boolean>;
  };
  workspaceQueries?: Pick<
    PostgresWorkspaceQueries,
    | 'overview'
    | 'events'
    | 'event'
    | 'duplicateSource'
    | 'recoveryJob'
    | 'deadJobs'
    | 'testEventByRequest'
    | 'deliveries'
    | 'activity'
  >;
  workspaceSigning?: { keyId: string; secret: string };
  deliveryRecovery?: Pick<DeliveryStore, 'replayDead'>;
  receiverRecovery?: {
    ping?(): Promise<void>;
    preparePermanentFailure(deliveryId: string, workspaceId: string): Promise<void>;
    restoreFaultPlan(deliveryId: string, workspaceId: string): Promise<boolean>;
  };
  secureCookies?: boolean;
  allowLegacyIngress?: boolean;
  onAccepted?: () => void;
  dependencies?: Array<{ ping(): Promise<void> }>;
  onWorkspaceSession?: () => Promise<void>;
  webRoot?: string;
  expectedOrigin?: string;
}

const SESSION_COOKIE = 'wrl_demo';
const testEventRequest = z
  .object({
    order_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    request_id: z.uuid(),
    scenario: z.enum(['normal', 'permanent_failure']).default('normal'),
  })
  .strict();
const replayRequest = z.object({ reason: z.string().trim().min(4).max(256), request_id: z.uuid() }).strict();

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const item of header?.split(';') ?? []) {
    const separator = item.indexOf('=');
    if (separator > 0 && item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return undefined;
}

function sameOrigin(request: Pick<FastifyRequest, 'headers' | 'protocol'>, expectedOrigin?: string): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const originUrl = new URL(origin);
    const expected = expectedOrigin ?? `${request.protocol}://${host}`;
    return (
      originUrl.origin === new URL(expected).origin && originUrl.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

function matchesSecret(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const actualBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function asSingleString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function buildApp({
  repository,
  signingKeys,
  nowMs = Date.now,
  logger = false,
  guestWorkspaces,
  workspaceQueries,
  workspaceSigning,
  deliveryRecovery,
  receiverRecovery,
  secureCookies = false,
  allowLegacyIngress = true,
  onAccepted,
  dependencies = [],
  onWorkspaceSession,
  webRoot,
  expectedOrigin,
}: AppOptions): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT_BYTES });
  const internalDispatchSecret = randomBytes(32).toString('base64url');

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await Promise.all([repository.ping(), ...dependencies.map((dependency) => dependency.ping())]);
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

      const internalWorkspace = matchesSecret(
        asSingleString(request.headers['x-wrl-internal-dispatch']),
        internalDispatchSecret,
      )
        ? asSingleString(request.headers['x-wrl-internal-workspace'])
        : undefined;
      if (!allowLegacyIngress && !internalWorkspace) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const internalDispatch = matchesSecret(
        asSingleString(request.headers['x-wrl-internal-dispatch']),
        internalDispatchSecret,
      );
      const internalDelivery = internalDispatch
        ? asSingleString(request.headers['x-wrl-internal-delivery-id'])
        : undefined;
      if (internalDelivery && !/^[0-9a-f-]{36}$/i.test(internalDelivery)) {
        return reply.code(400).send({ error: 'invalid_internal_delivery' });
      }

      try {
        const outcome = await repository.accept({
          provider: 'sandbox',
          ...(internalWorkspace ? { workspaceId: internalWorkspace } : {}),
          ...(internalDelivery ? { deliveryId: internalDelivery } : {}),
          event,
          rawBody,
          payloadSha256: sha256Hex(rawBody),
          signatureVerified: true,
        });
        if (outcome === 'conflict') {
          request.log.warn({ event_id: event.event_id }, 'webhook identity reused with different payload');
          return reply.code(409).send({ error: 'event_identity_conflict' });
        }
        if (outcome === 'capacity') return reply.code(429).send({ error: 'workspace_event_limit' });
        if (outcome === 'expired') return reply.code(401).send({ error: 'workspace_expired' });
        if (outcome === 'accepted') onAccepted?.();
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

  if (guestWorkspaces && workspaceQueries && workspaceSigning) {
    const resolveWorkspace = async (request: FastifyRequest) =>
      guestWorkspaces.findActive(cookieValue(request.headers.cookie, SESSION_COOKIE));
    const setSessionCookie = (reply: FastifyReply, token: string) => {
      reply.header(
        'set-cookie',
        `${SESSION_COOKIE}=${token}; Path=/api/demo; HttpOnly; SameSite=Strict; Max-Age=86400${
          secureCookies ? '; Secure' : ''
        }`,
      );
    };
    const requireMutationOrigin = (request: FastifyRequest) => sameOrigin(request, expectedOrigin);
    const mutationDenied = async (request: FastifyRequest, workspaceId: string) => {
      if (!guestWorkspaces.consumeMutation || (await guestWorkspaces.consumeMutation(workspaceId)))
        return null;
      const active = await resolveWorkspace(request);
      return active
        ? { status: 429, error: 'workspace_mutation_limit' }
        : { status: 401, error: 'workspace_expired' };
    };

    app.post('/api/demo/session', async (request, reply) => {
      if (!requireMutationOrigin(request)) return reply.code(403).send({ error: 'origin_rejected' });
      const current = await resolveWorkspace(request);
      if (current) return { status: 'resumed', expires_at: current.expires_at.toISOString() };
      await onWorkspaceSession?.().catch(() => undefined);
      const admission = await guestWorkspaces.create();
      if (admission.status === 'capacity') return reply.code(429).send({ error: 'workspace_capacity' });
      setSessionCookie(reply, admission.token);
      return reply
        .code(201)
        .send({ status: 'created', expires_at: admission.workspace.expires_at.toISOString() });
    });

    app.post('/api/demo/session/new', async (request, reply) => {
      if (!requireMutationOrigin(request)) return reply.code(403).send({ error: 'origin_rejected' });
      await onWorkspaceSession?.().catch(() => undefined);
      const admission = await guestWorkspaces.create();
      if (admission.status === 'capacity') return reply.code(429).send({ error: 'workspace_capacity' });
      setSessionCookie(reply, admission.token);
      return reply
        .code(201)
        .send({ status: 'created', expires_at: admission.workspace.expires_at.toISOString() });
    });

    app.get('/api/demo/overview', async (request, reply) => {
      const workspace = await resolveWorkspace(request);
      if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
      return workspaceQueries.overview(workspace.id);
    });

    app.get('/api/demo/events', async (request, reply) => {
      const workspace = await resolveWorkspace(request);
      if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
      const query = request.query as Record<string, unknown>;
      const status = query['status'] === undefined ? undefined : parseWorkspaceJobState(query['status']);
      if (query['status'] !== undefined && !status) return reply.code(400).send({ error: 'invalid_status' });
      const search = typeof query['q'] === 'string' ? query['q'].slice(0, 80) : undefined;
      const parseDate = (value: unknown): Date | undefined | null => {
        if (value === undefined) return undefined;
        if (typeof value !== 'string') return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value ? null : parsed;
      };
      const from = parseDate(query['from']);
      const to = parseDate(query['to']);
      if (from === null || to === null || (from && to && from >= to))
        return reply.code(400).send({ error: 'invalid_date_range' });
      const limit = typeof query['limit'] === 'string' ? Number(query['limit']) : 25;
      const offset = typeof query['offset'] === 'string' ? Number(query['offset']) : 0;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 25 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 10_000
      ) {
        return reply.code(400).send({ error: 'invalid_pagination' });
      }
      return workspaceQueries.events(workspace.id, {
        ...(status ? { status } : {}),
        ...(search ? { query: search } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit,
        offset,
      });
    });

    app.get<{ Params: { eventId: string } }>('/api/demo/events/:eventId', async (request, reply) => {
      const workspace = await resolveWorkspace(request);
      if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
      if (!/^[0-9a-f-]{36}$/i.test(request.params.eventId))
        return reply.code(404).send({ error: 'event_not_found' });
      const event = await workspaceQueries.event(workspace.id, request.params.eventId);
      return event ? event : reply.code(404).send({ error: 'event_not_found' });
    });

    app.post<{ Params: { eventId: string } }>(
      '/api/demo/events/:eventId/duplicate',
      async (request, reply) => {
        if (!requireMutationOrigin(request)) return reply.code(403).send({ error: 'origin_rejected' });
        const workspace = await resolveWorkspace(request);
        if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
        if (!/^[0-9a-f-]{36}$/i.test(request.params.eventId))
          return reply.code(404).send({ error: 'event_not_found' });
        const source = await workspaceQueries.duplicateSource(workspace.id, request.params.eventId);
        if (!source?.signature_verified) return reply.code(404).send({ error: 'event_not_repeatable' });
        const denied = await mutationDenied(request, workspace.id);
        if (denied) return reply.code(denied.status).send({ error: denied.error });
        const timestamp = String(Math.trunc(nowMs() / 1000));
        const ingress = await app.inject({
          method: 'POST',
          url: '/v1/webhooks/sandbox',
          payload: source.raw_body,
          headers: {
            'content-type': 'application/json',
            'x-wrl-key-id': workspaceSigning.keyId,
            'x-wrl-timestamp': timestamp,
            'x-wrl-signature': signPayload(source.raw_body, timestamp, workspaceSigning.secret),
            'x-wrl-internal-dispatch': internalDispatchSecret,
            'x-wrl-internal-workspace': workspace.id,
          },
        });
        if (ingress.statusCode !== 202) return reply.code(ingress.statusCode).send(ingress.json());
        return reply
          .code(202)
          .send({ ...(ingress.json() as Record<string, unknown>), signature_accepted: true });
      },
    );

    app.post('/api/demo/test-events', async (request, reply) => {
      if (!requireMutationOrigin(request)) return reply.code(403).send({ error: 'origin_rejected' });
      const workspace = await resolveWorkspace(request);
      if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
      const parsedBody = testEventRequest.safeParse(request.body);
      if (!parsedBody.success) return reply.code(400).send({ error: 'invalid_event' });
      const orderId = parsedBody.data.order_id ?? `ord_${randomUUID().slice(0, 12)}`;
      const previous = await workspaceQueries.testEventByRequest(workspace.id, parsedBody.data.request_id);
      if (previous) {
        if (previous.order_id !== orderId)
          return reply.code(409).send({ error: 'request_identity_conflict' });
        return reply
          .code(202)
          .send({ event_id: previous.event_id, status: 'duplicate', signature_accepted: true });
      }
      const denied = await mutationDenied(request, workspace.id);
      if (denied) return reply.code(denied.status).send({ error: denied.error });
      const event = sandboxEventSchema.safeParse({
        event_id: parsedBody.data.request_id,
        type: 'order.created',
        occurred_at: new Date(nowMs()).toISOString(),
        data: { order_id: orderId },
      });
      if (!event.success) return reply.code(400).send({ error: 'invalid_event' });
      const deliveryId = randomUUID();
      if (parsedBody.data.scenario === 'permanent_failure') {
        try {
          await receiverRecovery?.preparePermanentFailure(deliveryId, workspace.id);
        } catch {
          return reply.code(503).send({ error: 'receiver_unavailable' });
        }
      }
      const rawBody = Buffer.from(JSON.stringify(event.data));
      const timestamp = String(Math.trunc(nowMs() / 1000));
      const signature = signPayload(rawBody, timestamp, workspaceSigning.secret);
      const ingress = await app.inject({
        method: 'POST',
        url: '/v1/webhooks/sandbox',
        payload: rawBody,
        headers: {
          'content-type': 'application/json',
          'x-wrl-key-id': workspaceSigning.keyId,
          'x-wrl-timestamp': timestamp,
          'x-wrl-signature': signature,
          'x-wrl-internal-dispatch': internalDispatchSecret,
          'x-wrl-internal-workspace': workspace.id,
          'x-wrl-internal-delivery-id': deliveryId,
        },
      });
      if (ingress.statusCode !== 202) {
        if (parsedBody.data.scenario === 'permanent_failure') {
          await receiverRecovery?.restoreFaultPlan(deliveryId, workspace.id).catch(() => undefined);
        }
        if (ingress.statusCode === 409) {
          const existing = await workspaceQueries.testEventByRequest(
            workspace.id,
            parsedBody.data.request_id,
          );
          if (existing?.order_id === orderId) {
            return reply
              .code(202)
              .send({ event_id: existing.event_id, status: 'duplicate', signature_accepted: true });
          }
          if (existing) return reply.code(409).send({ error: 'request_identity_conflict' });
        }
        return reply.code(ingress.statusCode).send(ingress.json());
      }
      const accepted = ingress.json() as { event_id: string; status: string };
      return reply.code(202).send({ ...accepted, signature_accepted: true });
    });

    app.get('/api/demo/recovery', async (request, reply) => {
      const workspace = await resolveWorkspace(request);
      if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
      return { dead_jobs: await workspaceQueries.deadJobs(workspace.id) };
    });

    app.get('/api/demo/deliveries', async (request, reply) => {
      const workspace = await resolveWorkspace(request);
      if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
      return { deliveries: await workspaceQueries.deliveries(workspace.id) };
    });

    app.get('/api/demo/endpoints', async (request, reply) => {
      const workspace = await resolveWorkspace(request);
      if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
      try {
        await receiverRecovery?.ping?.();
        return {
          endpoints: [
            {
              id: 'orders',
              name: 'Orders receiver',
              status: 'healthy',
              checked_at: new Date(nowMs()).toISOString(),
            },
          ],
        };
      } catch {
        return {
          endpoints: [
            {
              id: 'orders',
              name: 'Orders receiver',
              status: 'unavailable',
              checked_at: new Date(nowMs()).toISOString(),
            },
          ],
        };
      }
    });

    app.get('/api/demo/activity', async (request, reply) => {
      const workspace = await resolveWorkspace(request);
      if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
      return { activity: await workspaceQueries.activity(workspace.id) };
    });

    if (deliveryRecovery && receiverRecovery) {
      app.post<{ Params: { jobId: string } }>('/api/demo/recovery/:jobId/restore', async (request, reply) => {
        if (!requireMutationOrigin(request)) return reply.code(403).send({ error: 'origin_rejected' });
        const workspace = await resolveWorkspace(request);
        if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
        const job = await workspaceQueries.recoveryJob(workspace.id, request.params.jobId);
        if (!job) return reply.code(404).send({ error: 'recovery_job_not_found' });
        if (job.status !== 'DEAD') return reply.code(409).send({ error: 'job_not_dead' });
        const denied = await mutationDenied(request, workspace.id);
        if (denied) return reply.code(denied.status).send({ error: denied.error });
        const changed = await receiverRecovery.restoreFaultPlan(job.delivery_id, workspace.id);
        return { status: changed ? 'receiver_restored' : 'receiver_already_restored' };
      });

      app.post<{ Params: { jobId: string } }>('/api/demo/recovery/:jobId/replay', async (request, reply) => {
        if (!requireMutationOrigin(request)) return reply.code(403).send({ error: 'origin_rejected' });
        const workspace = await resolveWorkspace(request);
        if (!workspace) return reply.code(401).send({ error: 'workspace_expired' });
        const body = replayRequest.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_replay_request' });
        const job = await workspaceQueries.recoveryJob(workspace.id, request.params.jobId);
        if (!job) return reply.code(404).send({ error: 'recovery_job_not_found' });
        try {
          const generation = await deliveryRecovery.replayDead(
            job.id,
            body.data.reason,
            workspace.id,
            body.data.request_id,
          );
          onAccepted?.();
          const current = await workspaceQueries.recoveryJob(workspace.id, job.id);
          const state = current?.status;
          return {
            status: state === 'SUCCEEDED' ? 'delivered' : state === 'DEAD' ? 'failed' : 'processing',
            replay_generation: generation,
            job_id: job.id,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (message.includes('workspace has expired'))
            return reply.code(401).send({ error: 'workspace_expired' });
          if (message.includes('mutation limit'))
            return reply.code(429).send({ error: 'workspace_mutation_limit' });
          if (message.includes('limit reached'))
            return reply.code(409).send({ error: 'replay_limit_reached' });
          if (message.includes('request ID'))
            return reply.code(409).send({ error: 'request_identity_conflict' });
          return reply.code(409).send({ error: 'job_not_replayable' });
        }
      });
    }
  }

  if (webRoot) {
    app.register(fastifyStatic, { root: resolve(webRoot), prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      const accept = request.headers.accept ?? '';
      if (request.method === 'GET' && accept.includes('text/html')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
