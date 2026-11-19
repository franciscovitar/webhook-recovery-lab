import { z } from 'zod';

export const sandboxEventSchema = z
  .object({
    event_id: z.uuid(),
    type: z.literal('order.created'),
    occurred_at: z.iso.datetime({ offset: true }),
    data: z
      .object({
        order_id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/),
      })
      .strict(),
  })
  .strict();

export type SandboxEvent = z.infer<typeof sandboxEventSchema>;

export function parseSandboxEvent(rawBody: Buffer): SandboxEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return null;
  }
  const result = sandboxEventSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
