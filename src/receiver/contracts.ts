import { z } from 'zod';

export const receiverDeliverySchema = z
  .object({
    delivery_id: z.uuid(),
    workspace_id: z.uuid().nullable().optional(),
    event_id: z.uuid(),
    order_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();

export type ReceiverDelivery = z.infer<typeof receiverDeliverySchema>;

export interface ReceiverResult {
  code: number;
  result: 'accepted' | 'duplicate' | 'injected_failure';
  delayAfterCommitMs: number;
}

export interface ReceiverStore {
  receive(delivery: ReceiverDelivery): Promise<ReceiverResult>;
  ping(): Promise<void>;
  preparePermanentFailure?(deliveryId: string, workspaceId: string): Promise<void>;
  restoreFaultPlan?(deliveryId: string, workspaceId: string): Promise<boolean>;
}
