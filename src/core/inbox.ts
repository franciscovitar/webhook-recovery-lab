import type { SandboxEvent } from './event.js';

export type IngestDecision = 'accepted' | 'duplicate' | 'conflict';

export interface IncomingWebhook {
  provider: 'sandbox';
  event: SandboxEvent;
  rawBody: Buffer;
  payloadSha256: string;
}

/** Implementations must commit inbox + job before resolving 'accepted'. */
export interface InboxRepository {
  accept(incoming: IncomingWebhook): Promise<IngestDecision>;
  ping(): Promise<void>;
}
