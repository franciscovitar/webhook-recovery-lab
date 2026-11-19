import type { SandboxEvent } from './event.js';

export interface ClaimedJob {
  jobId: string;
  eventId: string;
  deliveryId: string;
  leaseToken: string;
  attemptSequence: number;
  attemptsInGeneration: number;
  replayGeneration: number;
  event: SandboxEvent;
}

export type DeliveryOutcome =
  | { kind: 'success'; httpStatus: number; latencyMs: number; errorClass: null }
  | {
      kind: 'retry';
      httpStatus: number | null;
      latencyMs: number;
      errorClass: 'transient_http' | 'network_timeout' | 'network_error';
    }
  | { kind: 'permanent'; httpStatus: number; latencyMs: number; errorClass: 'permanent_http' };

export interface DeliveryStore {
  claimNext(): Promise<ClaimedJob | null>;
  finish(job: ClaimedJob, outcome: DeliveryOutcome, retryDelayMs: number): Promise<boolean>;
  ping(): Promise<void>;
  replayDead(jobId: string, reason: string): Promise<number>;
}

export interface DeliveryTransport {
  send(job: ClaimedJob): Promise<DeliveryOutcome>;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function classifyHttpStatus(status: number, latencyMs: number): DeliveryOutcome {
  if (status >= 200 && status < 300) {
    return { kind: 'success', httpStatus: status, latencyMs, errorClass: null };
  }
  if (RETRYABLE_STATUS.has(status)) {
    return { kind: 'retry', httpStatus: status, latencyMs, errorClass: 'transient_http' };
  }
  return { kind: 'permanent', httpStatus: status, latencyMs, errorClass: 'permanent_http' };
}

/** A capped, deterministic function when `random` is injected in tests. */
export function computeRetryDelayMs(
  attemptsInGeneration: number,
  random: () => number = Math.random,
  baseMs = 1_000,
  capMs = 60_000,
): number {
  if (!Number.isInteger(attemptsInGeneration) || attemptsInGeneration < 1) {
    throw new Error('attemptsInGeneration must be a positive integer');
  }
  const exponential = Math.min(capMs, baseMs * 2 ** Math.min(30, attemptsInGeneration - 1));
  const jitter = Math.floor(exponential * 0.25 * Math.min(1, Math.max(0, random())));
  return Math.min(capMs, exponential + jitter);
}
