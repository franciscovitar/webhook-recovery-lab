import 'dotenv/config';

import { createPool } from '../db/pool.js';

const databaseUrl = process.env['RECEIVER_DATABASE_URL'];
const [deliveryId, option, value, statusFlag, statusValue] = process.argv.slice(2);
if (!databaseUrl || !deliveryId || !option || !value) {
  throw new Error('Usage: receiver:fault-plan -- <delivery-uuid> --transient-fails N [--status 503]');
}

const pool = createPool(databaseUrl);
try {
  if (option === '--transient-fails') {
    const fails = Number(value);
    const status = statusFlag === '--status' ? Number(statusValue) : 503;
    if (
      !Number.isSafeInteger(fails) ||
      fails < 0 ||
      fails > 5 ||
      ![408, 429, 500, 502, 503, 504].includes(status)
    ) {
      throw new Error('Transient plan requires 0..5 failures and a supported retryable status');
    }
    await pool.query(
      `INSERT INTO receiver_fault_plans (delivery_id, transient_remaining, transient_status)
       VALUES ($1, $2, $3)
       ON CONFLICT (delivery_id) DO UPDATE
       SET transient_remaining=EXCLUDED.transient_remaining,
           transient_status=EXCLUDED.transient_status, permanent_status=NULL`,
      [deliveryId, fails, status],
    );
    process.stdout.write(`Fault plan: ${fails} x HTTP ${status} then success\n`);
  } else if (option === '--permanent') {
    const status = Number(value);
    if (![400, 401, 403, 404, 422].includes(status)) throw new Error('Unsupported permanent HTTP status');
    await pool.query(
      `INSERT INTO receiver_fault_plans (delivery_id, permanent_status)
       VALUES ($1, $2)
       ON CONFLICT (delivery_id) DO UPDATE
       SET permanent_status=EXCLUDED.permanent_status, transient_remaining=0`,
      [deliveryId, status],
    );
    process.stdout.write(`Fault plan: permanent HTTP ${status}\n`);
  } else {
    throw new Error('Unsupported fault plan');
  }
} finally {
  await pool.end();
}
