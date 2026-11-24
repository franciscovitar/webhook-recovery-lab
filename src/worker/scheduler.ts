import type { DeliveryStore } from '../core/delivery.js';
import { WorkerRunner } from './runner.js';

/** Event-driven drain loop; the timer tracks only durable due/recovery work. */
export class WorkerScheduler {
  private draining = false;
  private requested = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private databaseBackoffMs = 500;

  constructor(
    private readonly runner: WorkerRunner,
    private readonly store: DeliveryStore,
  ) {}

  start(): void {
    this.wake();
  }

  wake(): void {
    if (this.stopped) return;
    this.requested = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.draining) void this.drain();
  }

  stop(): void {
    this.stopped = true;
    this.requested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (this.requested && !this.stopped) {
        this.requested = false;
        try {
          while (!this.stopped && (await this.runner.runOnce())) {
            this.databaseBackoffMs = 500;
          }
          const delay = await this.store.nextWorkDelayMs?.();
          if (this.requested) continue;
          if (delay !== null && delay !== undefined && !this.stopped) {
            this.timer = setTimeout(() => {
              this.timer = undefined;
              this.wake();
            }, delay);
          }
        } catch {
          if (!this.stopped) {
            const delay = this.databaseBackoffMs;
            this.databaseBackoffMs = Math.min(30_000, this.databaseBackoffMs * 2);
            this.timer = setTimeout(() => {
              this.timer = undefined;
              this.wake();
            }, delay);
          }
        }
      }
    } finally {
      this.draining = false;
      if (this.requested && !this.stopped) void this.drain();
    }
  }
}
