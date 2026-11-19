import 'dotenv/config';

import { createPool } from '../db/pool.js';
import { PostgresDeliveryStore } from '../db/postgres-delivery.js';
import { HttpDeliveryTransport } from '../worker/http-transport.js';
import { WorkerRunner } from '../worker/runner.js';

const databaseUrl = process.env['DATABASE_URL'];
const receiverUrl = process.env['RECEIVER_URL'];
const token = process.env['INTERNAL_DELIVERY_TOKEN'];
if (!databaseUrl || !receiverUrl || !token) {
  throw new Error('DATABASE_URL, RECEIVER_URL and INTERNAL_DELIVERY_TOKEN required');
}

const pool = createPool(databaseUrl);
const runner = new WorkerRunner({
  store: new PostgresDeliveryStore(pool),
  transport: new HttpDeliveryTransport({ receiverUrl, sharedToken: token }),
  onResult: (job, outcome, acknowledged) => {
    // Stable fields for correlation, never raw payload or signing secrets.
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        service: 'worker',
        level: 'info',
        job_id: job.jobId,
        event_id: job.eventId,
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
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  await runner.runUntilStopped(controller.signal);
} catch (error) {
  process.stderr.write(`worker terminated: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
