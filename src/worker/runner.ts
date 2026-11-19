import { setTimeout as wait } from 'node:timers/promises';

import {
  computeRetryDelayMs,
  type ClaimedJob,
  type DeliveryOutcome,
  type DeliveryStore,
  type DeliveryTransport,
} from '../core/delivery.js';

export interface WorkerRunnerOptions {
  store: DeliveryStore;
  transport: DeliveryTransport;
  pollIntervalMs?: number;
  random?: () => number;
  /** Test-only crash injector, invoked *after* downstream HTTP but before the DB ACK. */
  afterTransport?: (job: ClaimedJob, outcome: DeliveryOutcome) => Promise<void> | void;
  onResult?: (job: ClaimedJob, outcome: DeliveryOutcome, acknowledged: boolean) => void;
}

export class WorkerRunner {
  private readonly pollIntervalMs: number;
  private readonly random: () => number;

  constructor(private readonly options: WorkerRunnerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.random = options.random ?? Math.random;
  }

  /** Returns false when the DB had no eligible work. */
  async runOnce(): Promise<boolean> {
    const job = await this.options.store.claimNext();
    if (!job) return false;

    const outcome = await this.options.transport.send(job);
    await this.options.afterTransport?.(job, outcome);
    const retryDelayMs =
      outcome.kind === 'retry' ? computeRetryDelayMs(job.attemptsInGeneration, this.random) : 0;
    const acknowledged = await this.options.store.finish(job, outcome, retryDelayMs);
    this.options.onResult?.(job, outcome, acknowledged);
    return true;
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const hadJob = await this.runOnce();
      if (hadJob || signal.aborted) continue;
      try {
        await wait(this.pollIntervalMs, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}
