import type { PostgresGuestWorkspaceStore } from '../db/postgres-guest-workspaces.js';
import type { ReceiverStore } from '../receiver/contracts.js';

/** Best-effort, idempotent cleanup. A failed receiver deletion leaves its durable gateway queue item. */
export class WorkspaceLifecycleRunner {
  constructor(
    private readonly workspaces: Pick<
      PostgresGuestWorkspaceStore,
      'stageExpired' | 'listPendingCleanup' | 'finalizeCleanup' | 'hasDelivery'
    >,
    private readonly receiver: Pick<
      ReceiverStore,
      'purgeWorkspace' | 'listOrphanCandidates' | 'removeOrphanPlan' | 'pruneClosedWorkspaces'
    >,
  ) {}

  async runOnce(): Promise<void> {
    await this.workspaces.stageExpired(10);
    await this.receiver.pruneClosedWorkspaces?.(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const pending = await this.workspaces.listPendingCleanup(20);
    for (const { workspace_id: workspaceId } of pending) {
      try {
        if (!this.receiver.purgeWorkspace) throw new Error('Receiver cleanup is unavailable');
        await this.receiver.purgeWorkspace(workspaceId);
        await this.workspaces.finalizeCleanup(workspaceId);
      } catch {
        // Keep the queue row for the next bounded invocation.
      }
    }
    const stale =
      (await this.receiver.listOrphanCandidates?.(new Date(Date.now() - 60 * 60 * 1000), 20)) ?? [];
    for (const item of stale) {
      try {
        if (!(await this.workspaces.hasDelivery(item.delivery_id))) {
          await this.receiver.removeOrphanPlan?.(item.delivery_id, item.workspace_id);
        }
      } catch {
        // A later startup or mutation retries; stale preparations are never blindly bulk-deleted.
      }
    }
  }
}
