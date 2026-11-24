import type { SandboxEvent } from './event.js';

export type IngestDecision = 'accepted' | 'duplicate' | 'conflict' | 'capacity' | 'expired';

export interface IncomingWebhook {
  provider: 'sandbox';
  /** Omitted only by the legacy local laboratory ingress. */
  workspaceId?: string;
  /** Assigned before receiver scenario preparation so inbox + job commit together. */
  deliveryId?: string;
  event: SandboxEvent;
  rawBody: Buffer;
  payloadSha256: string;
  signatureVerified?: boolean;
}

/** Implementations must commit inbox + job before resolving 'accepted'. */
export interface InboxRepository {
  accept(incoming: IncomingWebhook): Promise<IngestDecision>;
  ping(): Promise<void>;
}
