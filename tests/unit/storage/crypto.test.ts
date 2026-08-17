import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptJson,
  encryptJson,
  hashSearchToken,
  normalizeSearchTerms,
} from '../../../src/storage/crypto.js';

describe('encrypted local storage', () => {
  it('round-trips JSON with authenticated encryption', () => {
    const key = randomBytes(32);
    const encrypted = encryptJson(key, { customer: 'Ravi', amount: 4280 }, 'row:1');

    expect(decryptJson(key, encrypted, 'row:1')).toEqual({ customer: 'Ravi', amount: 4280 });
  });

  it('uses a fresh nonce for repeated values', () => {
    const key = randomBytes(32);
    expect(encryptJson(key, { value: 'same' }, 'row:1')).not.toBe(
      encryptJson(key, { value: 'same' }, 'row:1')
    );
  });

  it('rejects ciphertext used with different associated data', () => {
    const key = randomBytes(32);
    const encrypted = encryptJson(key, { secret: true }, 'row:1');
    expect(() => decryptJson(key, encrypted, 'row:2')).toThrow();
  });
});

describe('blind search tokens', () => {
  it('normalizes words, references, amounts, and dates', () => {
    expect(normalizeSearchTerms([' Ravi Kumar ', 'INV-1842', 4280, '2026-08-05'])).toEqual([
      'ravi',
      'kumar',
      'inv-1842',
      '4280',
      '2026-08-05',
    ]);
  });

  it('creates stable key-dependent token hashes', () => {
    const firstKey = Buffer.alloc(32, 1);
    const secondKey = Buffer.alloc(32, 2);

    expect(hashSearchToken(firstKey, 'RAVI')).toBe(hashSearchToken(firstKey, 'ravi'));
    expect(hashSearchToken(firstKey, 'ravi')).not.toBe(hashSearchToken(secondKey, 'ravi'));
  });
});
