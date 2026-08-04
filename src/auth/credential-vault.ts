import { randomBytes } from 'node:crypto';

const SERVICE_NAME = 'gsheets';
const DATA_KEY_ACCOUNT = 'local-index-key';
const OAUTH_ACCOUNT = 'google-oauth-token';

export interface CredentialBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  scope: string;
  tokenType: string;
}

function isOAuthTokenSet(value: unknown): value is OAuthTokenSet {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<OAuthTokenSet>;
  return (
    typeof candidate.accessToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.expiryDate === 'number' &&
    typeof candidate.scope === 'string' &&
    typeof candidate.tokenType === 'string'
  );
}

export class CredentialVault {
  readonly #backend: CredentialBackend;

  constructor(backend: CredentialBackend) {
    this.#backend = backend;
  }

  async getOrCreateDataKey(): Promise<Buffer> {
    const stored = await this.#backend.getPassword(SERVICE_NAME, DATA_KEY_ACCOUNT);
    if (stored) {
      const key = Buffer.from(stored, 'base64url');
      if (key.byteLength !== 32) {
        throw new Error('Stored gsheets data key is invalid');
      }
      return key;
    }

    const key = randomBytes(32);
    await this.#backend.setPassword(SERVICE_NAME, DATA_KEY_ACCOUNT, key.toString('base64url'));
    return key;
  }

  async loadTokens(): Promise<OAuthTokenSet | null> {
    const stored = await this.#backend.getPassword(SERVICE_NAME, OAUTH_ACCOUNT);
    if (!stored) {
      return null;
    }
    const parsed: unknown = JSON.parse(stored);
    if (!isOAuthTokenSet(parsed)) {
      throw new Error('Stored Google OAuth token is invalid');
    }
    return parsed;
  }

  async saveTokens(tokens: OAuthTokenSet): Promise<void> {
    await this.#backend.setPassword(SERVICE_NAME, OAUTH_ACCOUNT, JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    await Promise.all([
      this.#backend.deletePassword(SERVICE_NAME, OAUTH_ACCOUNT),
      this.#backend.deletePassword(SERVICE_NAME, DATA_KEY_ACCOUNT),
    ]);
  }
}
