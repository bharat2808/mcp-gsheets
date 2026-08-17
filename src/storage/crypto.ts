import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;

function assertKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) {
    throw new Error('Encryption keys must be exactly 32 bytes');
  }
  return Buffer.from(key);
}

export function encryptJson(key: Uint8Array, value: unknown, associatedData: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, assertKey(key), nonce);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    nonce.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptJson<T = unknown>(
  key: Uint8Array,
  encoded: string,
  associatedData: string
): T {
  const [version, nonceValue, tagValue, ciphertextValue] = encoded.split('.');
  if (version !== 'v1' || !nonceValue || !tagValue || ciphertextValue === undefined) {
    throw new Error('Unsupported encrypted payload');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    assertKey(key),
    Buffer.from(nonceValue, 'base64url')
  );
  decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString('utf8')) as T;
}

function normalizeTerm(value: string): string[] {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .split(/\s+/u)
    .map((term) => term.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ''))
    .filter(Boolean);
}

function stringifySearchValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value) ?? '';
}

export function normalizeSearchTerms(values: readonly unknown[]): string[] {
  const terms = values.flatMap((value) => {
    if (value === null || value === undefined || value === '') {
      return [];
    }
    return normalizeTerm(stringifySearchValue(value));
  });
  return [...new Set(terms)];
}

export function hashSearchToken(key: Uint8Array, token: string): string {
  const [normalized = ''] = normalizeTerm(token);
  return createHmac('sha256', assertKey(key)).update(normalized).digest('base64url');
}
