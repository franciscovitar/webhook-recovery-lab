import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { guestTokenDigest, newGuestToken } from '../../src/core/guest-session.js';

describe('guest credentials', () => {
  it('generates independent canonical 256-bit credentials and stores only their digest', () => {
    const tokens = Array.from({ length: 100 }, () => newGuestToken());
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(guestTokenDigest(token)).toBe(
        createHash('sha256').update(Buffer.from(token, 'base64url')).digest('hex'),
      );
    }
  });

  it('rejects malformed and noncanonical credentials', () => {
    const zero = Buffer.alloc(32).toString('base64url');
    expect(guestTokenDigest(zero)).toMatch(/^[0-9a-f]{64}$/);
    for (const invalid of [undefined, null, 1, '', zero + '=', zero.slice(0, -1) + 'B', ' ' + zero]) {
      expect(guestTokenDigest(invalid)).toBeNull();
    }
  });
});
