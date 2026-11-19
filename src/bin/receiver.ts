import 'dotenv/config';

import { createPool } from '../db/pool.js';
import { PostgresReceiverStore } from '../db/postgres-receiver.js';
import { buildReceiverApp } from '../receiver/app.js';

const databaseUrl = process.env['RECEIVER_DATABASE_URL'];
const token = process.env['INTERNAL_DELIVERY_TOKEN'];
const port = Number(process.env['RECEIVER_PORT'] ?? '3001');
if (!databaseUrl || !token) throw new Error('RECEIVER_DATABASE_URL and INTERNAL_DELIVERY_TOKEN required');
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid RECEIVER_PORT');

const pool = createPool(databaseUrl);
const app = buildReceiverApp({ store: new PostgresReceiverStore(pool), sharedToken: token });
const waitForStop = new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});
try {
  await app.listen({ host: '0.0.0.0', port });
  await waitForStop;
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
} finally {
  await app.close();
  await pool.end();
}
