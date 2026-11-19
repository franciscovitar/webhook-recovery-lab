import 'dotenv/config';

import { createPool } from '../db/pool.js';
import { readOpsSnapshot } from '../ops/snapshot.js';

if (process.argv.length !== 2) throw new Error('Usage: npm run ops:snapshot');
const gatewayUrl = process.env['DATABASE_URL'];
if (!gatewayUrl) throw new Error('DATABASE_URL required');

const gateway = createPool(gatewayUrl);
const receiverUrl = process.env['RECEIVER_DATABASE_URL'];
const receiver = receiverUrl ? createPool(receiverUrl) : undefined;
try {
  const snapshot = await readOpsSnapshot(gateway, receiver);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} finally {
  await Promise.allSettled([gateway.end(), receiver?.end()]);
}
