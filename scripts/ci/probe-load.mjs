import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as wait } from 'node:timers/promises';

import pg from 'pg';

// Functional, bounded CI probe; not a benchmark or an SLO measurement.
if (process.env.CI !== 'true' || !/^wrl-ci-[0-9]+-[0-9]+$/.test(process.env.COMPOSE_PROJECT_NAME ?? '')) {
  throw new Error('Load probe is restricted to a uniquely named CI Compose project');
}

const TOTAL = 40;
const CONCURRENCY = 8;
const signingSecret = 'replace-with-a-long-random-development-secret';
const gateway = new pg.Client({
  connectionString: 'postgres://wrl:wrl_local_only@127.0.0.1:5436/gateway_db',
});
const receiver = new pg.Client({
  connectionString: 'postgres://wrl:wrl_local_only@127.0.0.1:5436/receiver_db',
});

function percentile(numbers, fraction) {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

async function sendSynthetic(i, eventId) {
  const payload = JSON.stringify({
    event_id: eventId,
    type: 'order.created',
    occurred_at: '2026-11-19T12:00:00Z',
    data: { order_id: `load_${i}` },
  });
  const timestamp = String(Math.trunc(Date.now() / 1000));
  const signature = createHmac('sha256', signingSecret)
    .update(timestamp)
    .update('.')
    .update(payload)
    .digest('hex');
  const start = performance.now();
  const response = await fetch('http://127.0.0.1:3000/v1/webhooks/sandbox', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wrl-key-id': 'sandbox-v1',
      'x-wrl-timestamp': timestamp,
      'x-wrl-signature': `sha256=${signature}`,
    },
    body: payload,
    signal: AbortSignal.timeout(5000),
  });
  const elapsed = performance.now() - start;
  const json = await response.json();
  assert.equal(response.status, 202, `Ingress failed for synthetic event ${i}`);
  assert.equal(json.status, 'accepted');
  return elapsed;
}

await gateway.connect();
await receiver.connect();

try {
  const eventIds = Array.from({ length: TOTAL }, () => randomUUID());
  const durations = new Array(TOTAL);
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < TOTAL) {
        const i = next++;
        durations[i] = await sendSynthetic(i, eventIds[i]);
      }
    }),
  );
  const elapsedMs = performance.now() - started;

  let jobRows = [];
  for (let poll = 0; poll < 120; poll++) {
    const rows = await gateway.query(
      `SELECT j.status, j.delivery_id FROM inbox_events e
         JOIN delivery_jobs j ON j.inbox_event_id=e.id
        WHERE e.event_id = ANY($1::uuid[])`,
      [eventIds],
    );
    jobRows = rows.rows;
    if (jobRows.some((job) => job.status === 'DEAD')) throw new Error('A load-probe delivery dead-lettered');
    if (jobRows.length === TOTAL && jobRows.every((job) => job.status === 'SUCCEEDED')) break;
    await wait(500);
  }
  assert.equal(jobRows.length, TOTAL, 'Not all 40 synthetic events produced a job');
  assert.ok(
    jobRows.every((job) => job.status === 'SUCCEEDED'),
    'Worker did not drain the bounded backlog',
  );

  const receipts = await receiver.query(
    'SELECT COUNT(*)::int count FROM receiver_receipts WHERE delivery_id = ANY($1::uuid[])',
    [jobRows.map((job) => job.delivery_id)],
  );
  assert.equal(receipts.rows[0]?.count, TOTAL, 'Exactly one receipt per event was expected');

  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const ingressRate = TOTAL / (elapsedMs / 1000);
  console.log(
    `LOAD_PROBE events=${TOTAL} concurrency=${CONCURRENCY} accepted=${TOTAL} jobs=${TOTAL} receipts=${TOTAL}`,
  );
  console.log(
    `LOAD_PROBE ingress_p50_ms=${p50.toFixed(1)} ingress_p95_ms=${p95.toFixed(1)} ingress_rps=${ingressRate.toFixed(1)}`,
  );
  console.log('LOAD_PROBE PASS: bounded functional check; latency is observational, not an SLO');
} finally {
  await Promise.allSettled([gateway.end(), receiver.end()]);
}
