import 'dotenv/config';

import { buildReceiverApp } from '../receiver/app.js';
import { PostgresReceiverStore } from '../db/postgres-receiver.js';
import { PostgresWorkspaceQueries } from '../db/postgres-workspace-queries.js';
import { PostgresGuestWorkspaceStore } from '../db/postgres-guest-workspaces.js';
import { PostgresInboxRepository } from '../db/postgres-inbox.js';
import { PostgresDeliveryStore } from '../db/postgres-delivery.js';
import { createPool } from '../db/pool.js';
import { buildApp } from '../http/app.js';
import { HttpDeliveryTransport } from '../worker/http-transport.js';
import { WorkerRunner } from '../worker/runner.js';
import { WorkerScheduler } from '../worker/scheduler.js';
import { gatewayMigrations, receiverMigrations, PostgresMigrationReadiness } from '../db/migrations.js';
import { WorkspaceLifecycleRunner } from '../ops/workspace-lifecycle.js';

const databaseUrl = process.env['DATABASE_URL'];
const receiverDatabaseUrl = process.env['RECEIVER_DATABASE_URL'];
const signingKeyId = process.env['WEBHOOK_SIGNING_KEY_ID'];
const signingSecret = process.env['WEBHOOK_SIGNING_SECRET'];
const internalToken = process.env['INTERNAL_DELIVERY_TOKEN'];
const port = Number(process.env['PORT'] ?? '3000');
const receiverPort = Number(process.env['RECEIVER_PORT'] ?? '3001');
const publicDemo = process.env['WRL_PUBLIC_DEMO'] === 'true';

if (!databaseUrl || !receiverDatabaseUrl || !signingKeyId || !signingSecret || !internalToken) {
  throw new Error(
    'DATABASE_URL, RECEIVER_DATABASE_URL, WEBHOOK_SIGNING_KEY_ID, WEBHOOK_SIGNING_SECRET and INTERNAL_DELIVERY_TOKEN are required',
  );
}
if (signingSecret.length < 32 || internalToken.length < 32) {
  throw new Error('Signing and internal delivery secrets must be at least 32 characters');
}
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535)
  throw new Error('PORT must be a valid TCP port');
if (!Number.isSafeInteger(receiverPort) || receiverPort <= 0 || receiverPort > 65535) {
  throw new Error('RECEIVER_PORT must be a valid TCP port');
}
if (publicDemo && process.env['PUBLIC_BASE_URL']?.startsWith('https://') !== true) {
  throw new Error('WRL_PUBLIC_DEMO requires an HTTPS PUBLIC_BASE_URL');
}

// Reserve four connections in total; receiver traffic never shares the gateway pool.
const gatewayPool = createPool(databaseUrl, 3);
const receiverPool = createPool(receiverDatabaseUrl, 1);
const inbox = new PostgresInboxRepository(gatewayPool);
const deliveryStore = new PostgresDeliveryStore(gatewayPool);
const receiverStore = new PostgresReceiverStore(receiverPool);
const workspaceStore = new PostgresGuestWorkspaceStore(gatewayPool);
const lifecycle = new WorkspaceLifecycleRunner(workspaceStore, receiverStore);
const readiness = [
  new PostgresMigrationReadiness(gatewayPool, gatewayMigrations),
  new PostgresMigrationReadiness(receiverPool, receiverMigrations),
];
const receiver = buildReceiverApp({ store: receiverStore, sharedToken: internalToken });
const worker = new WorkerRunner({
  store: deliveryStore,
  transport: new HttpDeliveryTransport({
    receiverUrl: `http://127.0.0.1:${receiverPort}/v1/receive`,
    sharedToken: internalToken,
  }),
  onResult: (job, outcome, acknowledged) => {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'worker',
        job_id: job.jobId,
        event_id: job.eventId,
        workspace_id: job.workspaceId,
        delivery_id: job.deliveryId,
        attempt: job.attemptSequence,
        replay_generation: job.replayGeneration,
        result: outcome.kind,
        http_status: outcome.httpStatus,
        error_class: outcome.errorClass,
        elapsed_ms: outcome.latencyMs,
        acknowledged,
      })}\n`,
    );
  },
});
const scheduler = new WorkerScheduler(worker, deliveryStore);
const app = buildApp({
  repository: inbox,
  signingKeys: new Map([[signingKeyId, signingSecret]]),
  guestWorkspaces: workspaceStore,
  workspaceQueries: new PostgresWorkspaceQueries(gatewayPool),
  workspaceSigning: { keyId: signingKeyId, secret: signingSecret },
  deliveryRecovery: deliveryStore,
  receiverRecovery: receiverStore,
  secureCookies: publicDemo,
  allowLegacyIngress: !publicDemo,
  onAccepted: () => scheduler.wake(),
  dependencies: [receiverStore, ...readiness],
  onWorkspaceSession: () => lifecycle.runOnce(),
  ...(publicDemo ? { expectedOrigin: new URL(process.env['PUBLIC_BASE_URL']!).origin } : {}),
  webRoot: new URL('../../dist/public', import.meta.url).pathname,
  logger: true,
});

let closing: Promise<void> | undefined;
const close = (): Promise<void> => {
  if (closing) return closing;
  closing = (async () => {
    scheduler.stop();
    await app.close().catch(() => undefined);
    await receiver.close().catch(() => undefined);
    await Promise.all([gatewayPool.end(), receiverPool.end()]);
  })();
  return closing;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

try {
  await lifecycle
    .runOnce()
    .catch((error: unknown) => app.log.warn({ err: error }, 'workspace cleanup deferred'));
  await receiver.listen({ host: '127.0.0.1', port: receiverPort });
  await app.listen({ host: '0.0.0.0', port });
  scheduler.start();
} catch (error) {
  app.log.error(error);
  await close();
  process.exitCode = 1;
}
