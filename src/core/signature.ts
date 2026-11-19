import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_REGEX = /^sha256=([0-9a-f]{64})$/;
const TIMESTAMP_REGEX = /^[1-9][0-9]{0,11}$/;

export interface WebhookSignatureHeaders {
  keyId?: string | undefined;
  timestamp?: string | undefined;
  signature?: string | undefined;
}

export interface VerifySignatureOptions {
  rawBody: Buffer;
  headers: WebhookSignatureHeaders;
  keys: ReadonlyMap<string, string>;
  nowMs: number;
  toleranceMs?: number;
}

/** Authenticity only. Event identity/deduplication is a separate DB invariant. */
export function verifySignature({
  rawBody,
  headers,
  keys,
  nowMs,
  toleranceMs = 300_000,
}: VerifySignatureOptions): boolean {
  if (!headers.keyId || !headers.timestamp || !headers.signature) return false;
  const key = keys.get(headers.keyId);
  if (!key || !TIMESTAMP_REGEX.test(headers.timestamp)) return false;

  const timestamp = Number(headers.timestamp);
  if (!Number.isSafeInteger(timestamp)) return false;
  if (Math.abs(nowMs - timestamp * 1000) > toleranceMs) return false;

  const match = SIGNATURE_REGEX.exec(headers.signature);
  if (!match?.[1]) return false;

  const provided = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', key).update(headers.timestamp).update('.').update(rawBody).digest();

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
