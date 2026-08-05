import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredentialBackend, CredentialVault } from '../../../src/auth/credential-vault.js';
import { SetupServerOptions } from '../../../src/auth/setup-server.js';
import { LocalIndex } from '../../../src/storage/local-index.js';
import { GSheetsRuntime } from '../../../src/runtime/gsheets-runtime.js';

const CLIENT_ID = '123456789-runtime.apps.googleusercontent.com';
const OTHER_CLIENT_ID = '987654321-other.apps.googleusercontent.com';

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

const directories: string[] = [];

async function createRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'gsheets-runtime-'));
  directories.push(directory);
  const backend = new MemoryBackend();
  const vault = new CredentialVault(backend);
  let setupOptions: SetupServerOptions | null = null;
  const stop = vi.fn();
  const runtime = new GSheetsRuntime({
    vault,
    dataDirectory: directory,
    environment: {},
    publisherClientId: '',
    setupServerFactory: (options) => {
      setupOptions = options;
      return {
        start: async () => 'http://127.0.0.1:43123',
        stop,
      };
    },
  });
  return {
    runtime,
    directory,
    backend,
    vault,
    stop,
    getSetupOptions: () => setupOptions,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('GSheetsRuntime OAuth credential bootstrap', () => {
  it('starts localhost setup even when both OAuth credentials are missing', async () => {
    const { runtime, getSetupOptions } = await createRuntime();

    await runtime.initialize();

    expect(getSetupOptions()).not.toBeNull();
    expect(runtime.status()).toMatchObject({
      connected: false,
      setupUrl: 'http://127.0.0.1:43123',
      clientIdSource: 'missing',
      credentialsConfigured: false,
    });
    expect(JSON.stringify(runtime.status())).not.toContain('clientSecret');
    await runtime.close();
  });

  it('persists localhost credentials with the secret only in the credential vault', async () => {
    const { runtime, directory, vault, getSetupOptions } = await createRuntime();
    await runtime.initialize();

    await getSetupOptions()?.saveClientCredentials({
      clientId: CLIENT_ID,
      clientSecret: 'GOCSPX-secret',
    });

    expect(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))).toEqual({
      googleOAuthClientId: CLIENT_ID,
    });
    expect(await vault.loadClientSecret()).toBe('GOCSPX-secret');
    expect(await getSetupOptions()?.getClientCredentials()).toEqual({
      clientId: CLIENT_ID,
      clientSecret: 'GOCSPX-secret',
    });
    expect(runtime.status()).toMatchObject({
      clientIdSource: 'local_config',
      credentialsConfigured: true,
    });
    expect(await readFile(join(directory, 'config.json'), 'utf8')).not.toContain('GOCSPX-secret');
    await runtime.close();
  });

  it('clears tokens and indexed account data when local credentials are replaced', async () => {
    const { runtime, directory, vault, getSetupOptions } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-old');
    await runtime.initialize();
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_800_000_000_000,
      scope: 'openid email',
      tokenType: 'Bearer',
    });
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.setSelectedFolderIds(['old-account-folder']);
    index.upsertSpreadsheet({
      id: 'old-sheet',
      name: 'Old account',
      path: '/Old account',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '1',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:01:00.000Z',
    });

    await getSetupOptions()?.saveClientCredentials({
      clientId: OTHER_CLIENT_ID,
      clientSecret: 'GOCSPX-new',
    });

    expect(await vault.loadTokens()).toBeNull();
    expect(await vault.loadClientSecret()).toBe('GOCSPX-new');
    expect(index.getSelectedFolderIds()).toEqual([]);
    expect(index.getCatalog()).toEqual([]);
    expect(await vault.getOrCreateDataKey()).toEqual(key);
    index.close();
    await runtime.close();
  });
});
