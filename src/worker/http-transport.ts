import { performance } from 'node:perf_hooks';

import {
  classifyHttpStatus,
  type ClaimedJob,
  type DeliveryOutcome,
  type DeliveryTransport,
} from '../core/delivery.js';

export interface HttpTransportOptions {
  receiverUrl: string;
  sharedToken: string;
  timeoutMs?: number;
}

export class HttpDeliveryTransport implements DeliveryTransport {
  private readonly endpoint: URL;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpTransportOptions) {
    this.endpoint = new URL(options.receiverUrl);
    if (!['http:', 'https:'].includes(this.endpoint.protocol)) {
      throw new Error('RECEIVER_URL must use HTTP(S)');
    }
    this.timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs >= 15_000) {
      throw new Error('Outbound HTTP timeout must be < lease TTL (15 seconds)');
    }
    if (options.sharedToken.length < 32) throw new Error('Receiver token must be >=32 characters');
  }

  async send(job: ClaimedJob): Promise<DeliveryOutcome> {
    const start = performance.now();
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.sharedToken}`,
          'x-delivery-id': job.deliveryId,
        },
        body: JSON.stringify({
          delivery_id: job.deliveryId,
          event_id: job.eventId,
          order_id: job.event.data.order_id,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return classifyHttpStatus(response.status, Math.max(0, Math.floor(performance.now() - start)));
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const timeout = name === 'TimeoutError' || name === 'AbortError';
      return {
        kind: 'retry',
        httpStatus: null,
        errorClass: timeout ? 'network_timeout' : 'network_error',
        latencyMs: Math.max(0, Math.floor(performance.now() - start)),
      };
    }
  }
}
