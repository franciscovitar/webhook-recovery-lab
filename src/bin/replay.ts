import 'dotenv/config';

import { createPool } from '../db/pool.js';
import { PostgresDeliveryStore } from '../db/postgres-delivery.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL required');

const [jobId, option, ...reasonWords] = process.argv.slice(2);
if (!jobId || option !== '--reason' || reasonWords.length === 0) {
  throw new Error('Usage: npm run jobs:replay -- <job-uuid> --reason <operator reason>');
}
const reason = reasonWords.join(' ');
const pool = createPool(databaseUrl);
try {
  const generation = await new PostgresDeliveryStore(pool).replayDead(jobId, reason);
  process.stdout.write(`Job requeued in replay generation ${generation}\n`);
} finally {
  await pool.end();
}
