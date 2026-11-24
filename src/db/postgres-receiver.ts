import type { Pool } from 'pg';

import type { ReceiverDelivery, ReceiverResult, ReceiverStore } from '../receiver/contracts.js';

interface FaultPlan {
  transient_remaining: number;
  transient_status: number;
  permanent_status: number | null;
  delay_after_commit_ms: number;
}

export class PostgresReceiverStore implements ReceiverStore {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async preparePermanentFailure(deliveryId: string, workspaceId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO receiver_fault_plans (delivery_id, workspace_id, permanent_status)
       VALUES ($1, $2, 422)
       ON CONFLICT (delivery_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
         transient_remaining = 0, permanent_status = 422, delay_after_commit_ms = 0`,
      [deliveryId, workspaceId],
    );
  }

  async restoreFaultPlan(deliveryId: string, workspaceId: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM receiver_fault_plans WHERE delivery_id = $1 AND workspace_id = $2`,
      [deliveryId, workspaceId],
    );
    return result.rowCount === 1;
  }

  async receive(delivery: ReceiverDelivery): Promise<ReceiverResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A single UPSERT row lock serializes concurrent deliveries of the same ID.
      await client.query(
        `INSERT INTO receiver_attempt_counts (delivery_id, attempts)
          VALUES ($1, 1)
          ON CONFLICT (delivery_id) DO UPDATE
          SET attempts = receiver_attempt_counts.attempts + 1,
              last_attempt_at = clock_timestamp()`,
        [delivery.delivery_id],
      );

      const workspaceId = delivery.workspace_id ?? null;
      const previous = await client.query<{
        event_id: string;
        order_id: string;
        workspace_id: string | null;
      }>('SELECT event_id, order_id, workspace_id FROM receiver_receipts WHERE delivery_id = $1', [
        delivery.delivery_id,
      ]);
      if (previous.rows[0]) {
        if (
          previous.rows[0].event_id !== delivery.event_id ||
          previous.rows[0].order_id !== delivery.order_id ||
          previous.rows[0].workspace_id !== workspaceId
        ) {
          await client.query('ROLLBACK');
          return { code: 409, result: 'injected_failure', delayAfterCommitMs: 0 };
        }
        await client.query('COMMIT');
        return { code: 200, result: 'duplicate', delayAfterCommitMs: 0 };
      }

      const configured = await client.query<FaultPlan & { workspace_id: string | null }>(
        'SELECT * FROM receiver_fault_plans WHERE delivery_id = $1 FOR UPDATE',
        [delivery.delivery_id],
      );
      const plan = configured.rows[0];
      if (plan && plan.workspace_id !== workspaceId) {
        await client.query('ROLLBACK');
        return { code: 409, result: 'injected_failure', delayAfterCommitMs: 0 };
      }
      if (plan?.permanent_status) {
        await client.query('COMMIT');
        return { code: plan.permanent_status, result: 'injected_failure', delayAfterCommitMs: 0 };
      }
      if (plan && plan.transient_remaining > 0) {
        await client.query(
          `UPDATE receiver_fault_plans SET transient_remaining = transient_remaining - 1
            WHERE delivery_id = $1`,
          [delivery.delivery_id],
        );
        await client.query('COMMIT');
        return { code: plan.transient_status, result: 'injected_failure', delayAfterCommitMs: 0 };
      }

      await client.query(
        `INSERT INTO receiver_receipts (delivery_id, workspace_id, event_id, order_id)
          VALUES ($1, $2, $3, $4)`,
        [delivery.delivery_id, workspaceId, delivery.event_id, delivery.order_id],
      );
      await client.query('COMMIT');
      return { code: 200, result: 'accepted', delayAfterCommitMs: plan?.delay_after_commit_ms ?? 0 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
