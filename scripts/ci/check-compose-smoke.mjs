import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

import pg from 'pg';

// This probes only a dedicated CI Compose project using its synthetic local ports.
// Never accept arbitrary hosts, database URLs, or production signing keys.
if (process.env.CI !== 'true' || !/^wrl-ci-[0-9]+-[0-9]+$/.test(process.env.COMPOSE_PROJECT_NAME ?? '')) {
  throw new Error('Compose smoke is restricted to a uniquely named CI project');
}

const signingSecret = 'replace-with-a-long-random-development-secret';
const gateway = new pg.Client({
  connectionString: 'postgres://wrl:wrl_local_only@127.0.0.1:5436/gateway_db',
});
const receiver = new pg.Client({
  connectionString: 'postgres://wrl:wrl_local_only@127.0.0.1:5436/receiver_db',
});

async function waitForReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch('http://127.0.0.1:3000/ready', { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch {
      // Service can be starting; retry within the bounded readiness window.
    }
    await wait(500);
  }
  throw new Error('Compose API did not become ready within 40 seconds');
}

async function postSigned(eventId, orderId) {
  const payload = JSON.stringify({
    event_id: eventId,
    type: 'order.created',
    occurred_at: '2026-11-19T12:00:00Z',
    data: { order_id: orderId },
  });
  const timestamp = String(Math.trunc(Date.now() / 1000));
  const signature = createHmac('sha256', signingSecret)
    .update(timestamp)
    .update('.')
    .update(payload)
    .digest('hex');
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
  return { code: response.status, body: await response.json() };
}

await waitForReady();
await gateway.connect();
await receiver.connect();

try {
  const eventId = randomUUID();
  const first = await postSigned(eventId, 'compose_smoke');
  const duplicate = await postSigned(eventId, 'compose_smoke');
  const conflict = await postSigned(eventId, 'compose_changed');
  assert.deepEqual(
    [first.code, first.body.status, duplicate.code, duplicate.body.status],
    [202, 'accepted', 202, 'duplicate'],
  );
  assert.deepEqual([conflict.code, conflict.body.error], [409, 'event_identity_conflict']);

  const row = await gateway.query(
    `SELECT j.id job_id, j.delivery_id FROM delivery_jobs j
       JOIN inbox_events e ON e.id=j.inbox_event_id WHERE e.event_id=$1`,
    [eventId],
  );
  assert.equal(row.rows.length, 1);
  const { job_id: jobId, delivery_id: deliveryId } = row.rows[0];

  let finalState;
  for (let i = 0; i < 80; i++) {
    const state = await gateway.query('SELECT status,total_attempts FROM delivery_jobs WHERE id=$1', [jobId]);
    if (state.rows[0]?.status === 'SUCCEEDED') {
      finalState = state.rows[0];
      break;
    }
    if (state.rows[0]?.status === 'DEAD') throw new Error('Compose delivery dead-lettered unexpectedly');
    await wait(500);
  }
  assert.ok(finalState, 'Compose worker did not complete delivery within 40 seconds');
  assert.ok(finalState.total_attempts >= 1);

  const [receipts, sends, jobs] = await Promise.all([
    receiver.query('SELECT COUNT(*)::int count FROM receiver_receipts WHERE delivery_id=$1', [deliveryId]),
    receiver.query('SELECT attempts FROM receiver_attempt_counts WHERE delivery_id=$1', [deliveryId]),
    gateway.query(
      'SELECT COUNT(*)::int count FROM delivery_jobs WHERE inbox_event_id IN (SELECT id FROM inbox_events WHERE event_id=$1)',
      [eventId],
    ),
  ]);
  assert.equal(jobs.rows[0]?.count, 1);
  assert.equal(receipts.rows[0]?.count, 1);
  assert.ok(sends.rows[0]?.attempts >= 1);

  console.log('COMPOSE ingress=202 duplicate=202 changed-payload=409');
  console.log('COMPOSE api=ready worker=SUCCEEDED receiver-receipts=1 inbox-jobs=1');
  console.log('COMPOSE PASS: five containers, both PostgreSQL databases, real HTTP delivery');
} finally {
  await Promise.allSettled([gateway.end(), receiver.end()]);
}
