import pg from 'pg';

export function createPool(connectionString: string, max = 10): pg.Pool {
  if (!Number.isSafeInteger(max) || max < 1 || max > 10) throw new Error('Pool max must be in 1..10');
  return new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
  });
}
