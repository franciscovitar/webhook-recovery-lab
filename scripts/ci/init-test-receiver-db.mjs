import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString || new URL(connectionString).pathname !== '/gateway_test') {
  throw new Error('CI database initialization requires DATABASE_URL pointing to gateway_test');
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = 'receiver_test'");
  if (existing.rows.length > 0) {
    throw new Error('receiver_test already exists; refusing to reuse a potentially dirty CI database');
  }
  await client.query('CREATE DATABASE receiver_test');
  console.log('Created isolated receiver_test database');
} finally {
  await client.end();
}
