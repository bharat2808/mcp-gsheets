import { randomBytes } from 'node:crypto';

const DEFAULT_SERVICE_NAME = 'gsheets';
const DATA_KEY_ACCOUNT = 'local-index-key';
const OAUTH_ACCOUNT = 'google-oauth-token';
const OAUTH_CLIENT_SECRET_ACCOUNT = 'google-oauth-client-secret';

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

export function resolveCredentialServiceName(
  environment: Readonly<Record<string, string | undefined>>
): string {
  if (environment.NODE_ENV !== 'test') {
    return DEFAULT_SERVICE_NAME;
  }
  const serviceName = environment.GSHEETS_TEST_CREDENTIAL_SERVICE?.trim();
  return serviceName || DEFAULT_SERVICE_NAME;
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
  readonly #serviceName: string;

  constructor(backend: CredentialBackend, serviceName = DEFAULT_SERVICE_NAME) {
    this.#backend = backend;
    this.#serviceName = serviceName;
  }

  async getOrCreateDataKey(): Promise<Buffer> {
    const stored = await this.#backend.getPassword(this.#serviceName, DATA_KEY_ACCOUNT);
    if (stored) {
      const key = Buffer.from(stored, 'base64url');
      if (key.byteLength !== 32) {
        throw new Error('Stored gsheets data key is invalid');
      }
      return key;
    }

    const key = randomBytes(32);
    await this.#backend.setPassword(this.#serviceName, DATA_KEY_ACCOUNT, key.toString('base64url'));
    return key;
  }

  async loadTokens(): Promise<OAuthTokenSet | null> {
    const stored = await this.#backend.getPassword(this.#serviceName, OAUTH_ACCOUNT);
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
    await this.#backend.setPassword(this.#serviceName, OAUTH_ACCOUNT, JSON.stringify(tokens));
  }

  async deleteTokens(): Promise<boolean> {
    return this.#backend.deletePassword(this.#serviceName, OAUTH_ACCOUNT);
  }

  async loadClientSecret(): Promise<string | null> {
    return this.#backend.getPassword(this.#serviceName, OAUTH_CLIENT_SECRET_ACCOUNT);
  }

  async saveClientSecret(secret: string): Promise<void> {
    await this.#backend.setPassword(this.#serviceName, OAUTH_CLIENT_SECRET_ACCOUNT, secret);
  }

  async deleteClientSecret(): Promise<boolean> {
    return this.#backend.deletePassword(this.#serviceName, OAUTH_CLIENT_SECRET_ACCOUNT);
  }

  async clear(): Promise<void> {
    await Promise.all([
      this.#backend.deletePassword(this.#serviceName, OAUTH_ACCOUNT),
      this.#backend.deletePassword(this.#serviceName, OAUTH_CLIENT_SECRET_ACCOUNT),
      this.#backend.deletePassword(this.#serviceName, DATA_KEY_ACCOUNT),
    ]);
  }
}
