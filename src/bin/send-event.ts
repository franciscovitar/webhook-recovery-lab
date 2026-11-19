import 'dotenv/config';

import { createHmac, randomUUID } from 'node:crypto';

const secret = process.env['WEBHOOK_SIGNING_SECRET'];
const keyId = process.env['WEBHOOK_SIGNING_KEY_ID'];
const baseUrl = process.env['DEMO_BASE_URL'] ?? 'http://127.0.0.1:3000';

if (!secret || secret.length < 32 || !keyId) {
  throw new Error('WEBHOOK_SIGNING_SECRET (>=32 chars) and WEBHOOK_SIGNING_KEY_ID are required');
}
const url = new URL(baseUrl);
if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
  throw new Error('The synthetic event sender only supports loopback HTTP');
}

const eventId = randomUUID();
const payload = JSON.stringify({
  event_id: eventId,
  type: 'order.created',
  occurred_at: new Date().toISOString(),
  data: { order_id: `ord_${eventId.slice(0, 8)}` },
});
const timestamp = String(Math.trunc(Date.now() / 1000));
const signature = createHmac('sha256', secret).update(timestamp).update('.').update(payload).digest('hex');

const response = await fetch(new URL('/v1/webhooks/sandbox', url), {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-wrl-key-id': keyId,
    'x-wrl-timestamp': timestamp,
    'x-wrl-signature': `sha256=${signature}`,
  },
  body: payload,
  signal: AbortSignal.timeout(5_000),
});
const responseBody = await response.text();
process.stdout.write(`${response.status} ${responseBody}\n`);
if (response.status !== 202) process.exitCode = 1;
