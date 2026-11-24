import 'dotenv/config';

import { applyMigrations, receiverMigrations } from '../db/migrations.js';
import { createPool } from '../db/pool.js';

const databaseUrl = process.env['RECEIVER_DATABASE_URL'];
if (!databaseUrl) throw new Error('RECEIVER_DATABASE_URL required for receiver migrations');

const pool = createPool(databaseUrl);
try {
  const applied = await applyMigrations(pool, 8071134, receiverMigrations);
  for (const version of applied) {
    process.stdout.write(`Applied receiver migration ${version}\n`);
  }
} finally {
  await pool.end();
}
