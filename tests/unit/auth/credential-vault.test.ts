import { describe, expect, it } from 'vitest';

import {
  CredentialBackend,
  CredentialVault,
  OAuthTokenSet,
} from '../../../src/auth/credential-vault.js';

class MemoryBackend implements CredentialBackend {
  readonly values = new Map<string, string>();

  async getPassword(_service: string, account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async setPassword(_service: string, account: string, password: string): Promise<void> {
    this.values.set(account, password);
  }

  async deletePassword(_service: string, account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

describe('CredentialVault', () => {
  it('creates and then reuses a 32-byte data key', async () => {
    const backend = new MemoryBackend();
    const vault = new CredentialVault(backend);

    const first = await vault.getOrCreateDataKey();
    const second = await vault.getOrCreateDataKey();

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    expect(backend.values.size).toBe(1);
  });

  it('round-trips and removes OAuth tokens', async () => {
    const backend = new MemoryBackend();
    const vault = new CredentialVault(backend);
    const tokens: OAuthTokenSet = {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_800_000_000_000,
      scope: 'openid email',
      tokenType: 'Bearer',
    };

    await vault.saveTokens(tokens);
    expect(await vault.loadTokens()).toEqual(tokens);
    await vault.clear();
    expect(await vault.loadTokens()).toBeNull();
  });

  it('stores the OAuth client secret separately and deletes only OAuth tokens', async () => {
    const backend = new MemoryBackend();
    const vault = new CredentialVault(backend);
    const dataKey = await vault.getOrCreateDataKey();
    await vault.saveClientSecret('GOCSPX-secret');
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_800_000_000_000,
      scope: 'openid email',
      tokenType: 'Bearer',
    });

    await vault.deleteTokens();

    expect(await vault.loadTokens()).toBeNull();
    expect(await vault.loadClientSecret()).toBe('GOCSPX-secret');
    expect(await vault.getOrCreateDataKey()).toEqual(dataKey);
  });

  it('deletes the OAuth client secret without clearing the data key', async () => {
    const backend = new MemoryBackend();
    const vault = new CredentialVault(backend);
    const dataKey = await vault.getOrCreateDataKey();
    await vault.saveClientSecret('GOCSPX-secret');

    await vault.deleteClientSecret();

    expect(await vault.loadClientSecret()).toBeNull();
    expect(await vault.getOrCreateDataKey()).toEqual(dataKey);
  });
});
