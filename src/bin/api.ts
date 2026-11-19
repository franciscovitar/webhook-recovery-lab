import 'dotenv/config';

import { buildApp } from '../http/app.js';
import { createPool } from '../db/pool.js';
import { PostgresInboxRepository } from '../db/postgres-inbox.js';

const databaseUrl = process.env['DATABASE_URL'];
const signingKeyId = process.env['WEBHOOK_SIGNING_KEY_ID'];
const signingSecret = process.env['WEBHOOK_SIGNING_SECRET'];
const port = Number(process.env['PORT'] ?? '3000');

if (!databaseUrl || !signingKeyId || !signingSecret || signingSecret.length < 32) {
  throw new Error('DATABASE_URL and a named signing secret (>=32 chars) are required');
}
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const pool = createPool(databaseUrl);
const app = buildApp({
  repository: new PostgresInboxRepository(pool),
  signingKeys: new Map([[signingKeyId, signingSecret]]),
  logger: true,
});

const close = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

try {
  await app.listen({ host: '0.0.0.0', port });
} catch (error) {
  app.log.error(error);
  await close();
  process.exitCode = 1;
}
