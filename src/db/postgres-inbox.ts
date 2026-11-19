import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { InboxRepository, IngestDecision, IncomingWebhook } from '../core/inbox.js';

export class PostgresInboxRepository implements InboxRepository {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async accept(incoming: IncomingWebhook): Promise<IngestDecision> {
    const connection = await this.pool.connect();
    let transactionOpen = false;
    try {
      await connection.query('BEGIN');
      transactionOpen = true;

      const inboxId = randomUUID();
      const inserted = await connection.query<{ id: string }>(
        `INSERT INTO inbox_events
           (id, provider, event_id, event_type, occurred_at, payload_sha256, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id`,
        [
          inboxId,
          incoming.provider,
          incoming.event.event_id,
          incoming.event.type,
          incoming.event.occurred_at,
          incoming.payloadSha256,
          incoming.rawBody.toString('utf8'),
        ],
      );

      let outcome: IngestDecision;
      if (inserted.rows.length === 1) {
        await connection.query(
          `INSERT INTO delivery_jobs
             (id, inbox_event_id, delivery_id, status, next_attempt_at)
           VALUES ($1, $2, $3, 'PENDING', clock_timestamp())`,
          [randomUUID(), inboxId, randomUUID()],
        );
        outcome = 'accepted';
      } else {
        // A conflicting INSERT waits for its contender's transaction. Once it
        // resolves, its committed payload hash is the deduplication oracle.
        const existing = await connection.query<{ payload_sha256: string }>(
          `SELECT payload_sha256 FROM inbox_events WHERE provider = $1 AND event_id = $2`,
          [incoming.provider, incoming.event.event_id],
        );
        if (!existing.rows[0]) throw new Error('inbox conflict row was not visible');
        outcome = existing.rows[0].payload_sha256 === incoming.payloadSha256 ? 'duplicate' : 'conflict';
      }

      await connection.query('COMMIT');
      transactionOpen = false;
      return outcome;
    } catch (error) {
      if (transactionOpen) {
        await connection.query('ROLLBACK').catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
