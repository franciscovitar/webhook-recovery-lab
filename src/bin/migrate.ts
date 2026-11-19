import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createPool } from '../db/pool.js';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) throw new Error('DATABASE_URL required for migrations');

const pool = createPool(databaseUrl);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // Serializes concurrent migrations within the same PostgreSQL database.
  await client.query('SELECT pg_advisory_xact_lock(8071133)');
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const version = '0001_initial';
  const existing = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
  if (existing.rows.length === 0) {
    const ddl = await readFile(resolve(process.cwd(), 'migrations', `${version}.sql`), 'utf8');
    await client.query(ddl);
    await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    process.stdout.write(`Applied migration ${version}\n`);
  } else {
    process.stdout.write(`Migration ${version} already applied\n`);
  }

  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
