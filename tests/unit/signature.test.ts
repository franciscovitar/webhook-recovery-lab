import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { sha256Hex, verifySignature } from '../../src/core/signature.js';

const keys = new Map([['sandbox-v1', 'a-local-synthetic-test-secret-00000000']]);
const nowMs = Date.parse('2026-11-19T12:00:00.000Z');
const body = Buffer.from('{"event_id":"synthetic"}');
const timestamp = String(Math.trunc(nowMs / 1000));

function signature(rawBody = body, at = timestamp): string {
  return `sha256=${createHmac('sha256', keys.get('sandbox-v1')!)
    .update(at)
    .update('.')
    .update(rawBody)
    .digest('hex')}`;
}

describe('webhook signature (raw body)', () => {
  it('accepts the original bytes with known key and fresh timestamp', () => {
    expect(
      verifySignature({
        rawBody: body,
        keys,
        nowMs,
        headers: { keyId: 'sandbox-v1', timestamp, signature: signature() },
      }),
    ).toBe(true);
  });

  it('rejects tampering, key substitution and malformed signatures', () => {
    const headers = { keyId: 'sandbox-v1', timestamp, signature: signature() };
    expect(verifySignature({ rawBody: Buffer.from('changed'), keys, nowMs, headers })).toBe(false);
    expect(verifySignature({ rawBody: body, keys, nowMs, headers: { ...headers, keyId: 'unknown' } })).toBe(
      false,
    );
    expect(
      verifySignature({ rawBody: body, keys, nowMs, headers: { ...headers, signature: 'sha256=ab' } }),
    ).toBe(false);
    expect(
      verifySignature({ rawBody: body, keys, nowMs, headers: { ...headers, signature: 'md5=ab' } }),
    ).toBe(false);
  });

  it('rejects stale/future requests and nonsensical timestamps', () => {
    for (const invalid of ['0', '-1', 'abc', '9999999999999', '1.4']) {
      expect(
        verifySignature({
          rawBody: body,
          keys,
          nowMs,
          headers: { keyId: 'sandbox-v1', timestamp: invalid, signature: signature(body, invalid) },
        }),
      ).toBe(false);
    }
    expect(
      verifySignature({
        rawBody: body,
        keys,
        nowMs: nowMs + 301_000,
        headers: { keyId: 'sandbox-v1', timestamp, signature: signature() },
      }),
    ).toBe(false);
    expect(
      verifySignature({
        rawBody: body,
        keys,
        nowMs: nowMs - 301_000,
        headers: { keyId: 'sandbox-v1', timestamp, signature: signature() },
      }),
    ).toBe(false);
  });

  it('hashes exact bytes, including whitespace', () => {
    expect(sha256Hex(Buffer.from('a'))).not.toBe(sha256Hex(Buffer.from('a ')));
  });
});
