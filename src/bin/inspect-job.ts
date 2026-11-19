import 'dotenv/config';

import { createPool } from '../db/pool.js';

const databaseUrl = process.env['DATABASE_URL'];
const eventId = process.argv[2];
if (!databaseUrl || !eventId) throw new Error('Usage: npm run jobs:inspect -- <event-uuid>');

const pool = createPool(databaseUrl);
try {
  const job = await pool.query(
    `SELECT e.event_id, j.id job_id, j.delivery_id, j.status, j.total_attempts,
            j.attempts_in_generation, j.replay_generation, j.next_attempt_at,
            j.lease_until, j.last_error_class
       FROM inbox_events e JOIN delivery_jobs j ON j.inbox_event_id=e.id
      WHERE e.event_id=$1`,
    [eventId],
  );
  if (!job.rows[0]) {
    process.stderr.write('No event found\n');
    process.exitCode = 1;
  } else {
    const attempts = await pool.query(
      `SELECT attempt_sequence, replay_generation, result, http_status,
              latency_ms, error_class, started_at, finished_at
         FROM delivery_attempts WHERE job_id=$1 ORDER BY attempt_sequence`,
      [job.rows[0].job_id],
    );
    process.stdout.write(`${JSON.stringify({ job: job.rows[0], attempts: attempts.rows }, null, 2)}\n`);
  }
} finally {
  await pool.end();
}
