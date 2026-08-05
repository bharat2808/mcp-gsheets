import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredentialBackend, CredentialVault } from '../../../src/auth/credential-vault.js';
import { OAuthSetupServer } from '../../../src/auth/setup-server.js';

class MemoryBackend implements CredentialBackend {
  private readonly values = new Map<string, string>();
  async getPassword(service: string, account: string) { return this.values.get(`${service}:${account}`) ?? null; }
  async setPassword(service: string, account: string, password: string) { this.values.set(`${service}:${account}`, password); }
  async deletePassword(service: string, account: string) { return this.values.delete(`${service}:${account}`); }
}

describe('OAuthSetupServer', () => {
  let server: OAuthSetupServer | null = null;
  afterEach(() => server?.stop());

  it('collects missing OAuth credentials locally with non-cacheable responses', async () => {
    server = new OAuthSetupServer({
      vault: new CredentialVault(new MemoryBackend()),
      getClientCredentials: async () => null,
      saveClientCredentials: vi.fn(),
      getSelectedFolderIds: () => [],
      setSelectedFolderIds: vi.fn(),
      onConnected: vi.fn(),
    });
    const setupUrl = await server.start();

    const home = await fetch(setupUrl);
    const html = await home.text();

    expect(home.headers.get('cache-control')).toBe('no-store');
    expect(home.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('name="clientId"');
    expect(html).toContain('name="clientSecret"');
    expect(html).toContain('type="password"');
  });

  it('saves submitted credentials without reflecting the secret', async () => {
    let credentials: { clientId: string; clientSecret: string } | null = null;
    const saveClientCredentials = vi.fn(async (next) => {
      credentials = next;
    });
    server = new OAuthSetupServer({
      vault: new CredentialVault(new MemoryBackend()),
      getClientCredentials: async () => credentials,
      saveClientCredentials,
      getSelectedFolderIds: () => [],
      setSelectedFolderIds: vi.fn(),
      onConnected: vi.fn(),
    });
    const setupUrl = await server.start();
    const home = await fetch(setupUrl);
    const html = await home.text();
    const formToken = /name="token" value="([^"]+)"/u.exec(html)?.[1];

    const response = await fetch(`${setupUrl}/credentials`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: formToken ?? '',
        clientId: '123456789-desktop.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-secret',
      }),
    });

    expect(saveClientCredentials).toHaveBeenCalledWith({
      clientId: '123456789-desktop.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret',
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(setupUrl);
    expect(await response.text()).not.toContain('GOCSPX-secret');
  });

  it('serves local Google sign-in and creates a PKCE authorization redirect', async () => {
    server = new OAuthSetupServer({
      vault: new CredentialVault(new MemoryBackend()),
      getClientCredentials: async () => ({
        clientId: 'desktop-client.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-secret',
      }),
      saveClientCredentials: vi.fn(),
      getSelectedFolderIds: () => [],
      setSelectedFolderIds: vi.fn(),
      onConnected: vi.fn(),
    });
    const setupUrl = await server.start();

    const home = await fetch(setupUrl);
    expect(await home.text()).toContain('Continue with Google');
    const redirect = await fetch(`${setupUrl}/oauth/start`, { redirect: 'manual' });
    const location = new URL(redirect.headers.get('location') ?? '');
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('redirect_uri')).toBe(`${setupUrl}/oauth/callback`);
  });

  it('rejects folder-selection posts without the local form token', async () => {
    const setSelectedFolderIds = vi.fn();
    server = new OAuthSetupServer({
      vault: new CredentialVault(new MemoryBackend()),
      getClientCredentials: async () => ({
        clientId: 'desktop-client.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-secret',
      }),
      saveClientCredentials: vi.fn(),
      getSelectedFolderIds: () => [],
      setSelectedFolderIds,
      onConnected: vi.fn(),
    });
    const setupUrl = await server.start();

    const response = await fetch(`${setupUrl}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'folder=attacker-controlled',
    });

    expect(response.status).toBe(500);
    expect(setSelectedFolderIds).not.toHaveBeenCalled();
  });
});
