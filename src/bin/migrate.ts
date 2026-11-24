import 'dotenv/config';

import { applyMigrations, gatewayMigrations } from '../db/migrations.js';
import { createPool } from '../db/pool.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL required for migrations');

const pool = createPool(databaseUrl);
try {
  const applied = await applyMigrations(pool, 8071133, gatewayMigrations);
  for (const version of gatewayMigrations) {
    process.stdout.write(
      applied.includes(version)
        ? `Applied migration ${version}\n`
        : `Migration ${version} already applied\n`,
    );
  }
} finally {
  await pool.end();
}
