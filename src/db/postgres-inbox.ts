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
      if (incoming.workspaceId) {
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
          incoming.workspaceId,
        ]);
        const active = await connection.query(
          `SELECT 1 FROM guest_workspaces
          WHERE id = $1 AND closed_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
          [incoming.workspaceId],
        );
        if (!active.rowCount) {
          await connection.query('COMMIT');
          return 'expired';
        }
      }
      const parameters = [
        inboxId,
        incoming.provider,
        incoming.event.event_id,
        incoming.event.type,
        incoming.event.occurred_at,
        incoming.payloadSha256,
        incoming.rawBody.toString('utf8'),
      ];
      const inserted = incoming.workspaceId
        ? await (async () => {
            await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [
              incoming.workspaceId,
            ]);
            return connection.query<{ id: string }>(
              `INSERT INTO inbox_events
              (id, workspace_id, provider, event_id, event_type, occurred_at, payload_sha256, payload, raw_body, signature_verified)
             SELECT $1, $8, $2, $3, $4, $5, $6, $7::jsonb, $9, $10
               FROM (SELECT count(*) AS count FROM inbox_events WHERE workspace_id = $8) AS existing
              WHERE existing.count < 10
             ON CONFLICT (workspace_id, provider, event_id) WHERE workspace_id IS NOT NULL DO NOTHING
             RETURNING id`,
              [...parameters, incoming.workspaceId, incoming.rawBody, incoming.signatureVerified ?? false],
            );
          })()
        : await connection.query<{ id: string }>(
            `INSERT INTO inbox_events
               (id, provider, event_id, event_type, occurred_at, payload_sha256, payload, raw_body, signature_verified)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
             ON CONFLICT (provider, event_id) WHERE workspace_id IS NULL DO NOTHING
             RETURNING id`,
            [...parameters, incoming.rawBody, incoming.signatureVerified ?? false],
          );

      let outcome: IngestDecision;
      if (inserted.rows.length === 1) {
        await connection.query(
          `INSERT INTO delivery_jobs
             (id, inbox_event_id, delivery_id, status, next_attempt_at)
           VALUES ($1, $2, $3, 'PENDING', clock_timestamp())`,
          [randomUUID(), inboxId, incoming.deliveryId ?? randomUUID()],
        );
        outcome = 'accepted';
      } else {
        // A conflicting INSERT waits for its contender's transaction. Once it
        // resolves, its committed payload hash is the deduplication oracle.
        const existing = incoming.workspaceId
          ? await connection.query<{ payload_sha256: string }>(
              `SELECT payload_sha256 FROM inbox_events
                WHERE workspace_id = $1 AND provider = $2 AND event_id = $3`,
              [incoming.workspaceId, incoming.provider, incoming.event.event_id],
            )
          : await connection.query<{ payload_sha256: string }>(
              `SELECT payload_sha256 FROM inbox_events
                WHERE workspace_id IS NULL AND provider = $1 AND event_id = $2`,
              [incoming.provider, incoming.event.event_id],
            );
        if (!existing.rows[0]) outcome = 'capacity';
        else outcome = existing.rows[0].payload_sha256 === incoming.payloadSha256 ? 'duplicate' : 'conflict';
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
