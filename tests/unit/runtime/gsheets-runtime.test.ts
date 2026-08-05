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
  deleteError: Error | null = null;

  async getPassword(_service: string, account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async setPassword(_service: string, account: string, password: string): Promise<void> {
    this.values.set(account, password);
  }

  async deletePassword(_service: string, account: string): Promise<boolean> {
    if (this.deleteError) {
      throw this.deleteError;
    }
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('GSheetsRuntime OAuth credential bootstrap', () => {
  it('keeps the prior token and catalog when re-consent omits full Drive scope', async () => {
    const { runtime, directory, vault, getSetupOptions } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    const priorTokens = {
      accessToken: 'prior-access',
      refreshToken: 'prior-refresh',
      expiryDate: 1_900_000_000_000,
      scope:
        'https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets',
      tokenType: 'Bearer',
    };
    await vault.saveTokens(priorTokens);
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.upsertSpreadsheet({
      id: 'preserved-sheet',
      name: 'Preserved',
      path: '/Preserved',
      modifiedTime: '',
      version: '1',
      indexStatus: 'current',
      lastIndexedAt: null,
    });
    index.close();
    await runtime.initialize();

    await expect(
      getSetupOptions()?.onConnected({
        ...priorTokens,
        accessToken: 'bad-reconsent',
        scope: 'https://www.googleapis.com/auth/spreadsheets',
      })
    ).rejects.toThrow('missing required OAuth scopes');

    expect(await vault.loadTokens()).toEqual(priorTokens);
    expect(runtime.catalog().spreadsheets.map((entry) => entry.id)).toEqual(['preserved-sheet']);
    await runtime.close();
  });

  it('keeps the prior token and catalog when re-consent account validation fails', async () => {
    const { runtime, directory, vault, getSetupOptions } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    const priorTokens = {
      accessToken: 'prior-access',
      refreshToken: 'prior-refresh',
      expiryDate: 1_900_000_000_000,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      tokenType: 'Bearer',
    };
    await vault.saveTokens(priorTokens);
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.upsertSpreadsheet({
      id: 'preserved-sheet',
      name: 'Preserved',
      path: '/Preserved',
      modifiedTime: '',
      version: '1',
      indexStatus: 'current',
      lastIndexedAt: null,
    });
    index.close();
    await runtime.initialize();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));

    await expect(
      getSetupOptions()?.onConnected({
        accessToken: 'candidate-access',
        refreshToken: 'candidate-refresh',
        expiryDate: 1_900_000_000_000,
        scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
        tokenType: 'Bearer',
      })
    ).rejects.toThrow(/HTTP 503/u);

    expect(await vault.loadTokens()).toEqual(priorTokens);
    expect(runtime.catalog().spreadsheets.map((entry) => entry.id)).toEqual(['preserved-sheet']);
    vi.unstubAllGlobals();
    await runtime.close();
  });

  it('forces an index refresh after returning a partial spreadsheet creation', async () => {
    const { runtime, directory, vault } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_900_000_000_000,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
      tokenType: 'Bearer',
    });
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.setSelectedFolderIds(['folder-1']);
    index.close();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ user: { permissionId: 'account-1' } }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetcher);
    const refresh = vi.spyOn(runtime, 'refresh').mockResolvedValue({} as any);
    await runtime.initialize();
    fetcher.mockReset();
    fetcher
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'folder-1',
            name: 'Folder',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root-id'],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'root-id',
            name: 'My Drive',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            spreadsheetId: 'created-book',
            properties: { title: 'Created' },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'created-book',
            name: 'Created',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: ['root-id'],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));

    await expect(
      runtime.createSpreadsheet({ title: 'Created', folderId: 'folder-1' })
    ).resolves.toMatchObject({
      spreadsheetId: 'created-book',
      partialCreation: true,
      verificationState: 'applied_verification_pending',
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    await runtime.close();
  });

  it('requires re-consent for full Drive access without deleting the encrypted catalog', async () => {
    const { runtime, directory, vault } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_900_000_000_000,
      scope:
        'https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets',
      tokenType: 'Bearer',
    });
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.setSelectedFolderIds(['selected-folder']);
    index.upsertSpreadsheet({
      id: 'existing-sheet',
      name: 'Existing',
      path: '/Selected/Existing',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '7',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:01:00.000Z',
    });
    index.close();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ files: [] }), { status: 200 }))
    );

    await runtime.initialize();

    expect(runtime.status()).toMatchObject({
      connected: false,
      reConsentRequired: true,
      missingScopes: ['https://www.googleapis.com/auth/drive'],
      selectedFolderCount: 1,
    });
    expect(runtime.catalog().spreadsheets.map((entry) => entry.id)).toEqual(['existing-sheet']);
    expect(await vault.loadTokens()).not.toBeNull();
    vi.unstubAllGlobals();
    await runtime.close();
  });

  it('clears account-specific index state only after detecting a different account', async () => {
    const { runtime, directory, vault } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_900_000_000_000,
      scope: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
      ].join(' '),
      tokenType: 'Bearer',
    });
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.setAccountIdentity('old-account');
    index.setSelectedFolderIds(['selected-folder']);
    index.upsertSpreadsheet({
      id: 'existing-sheet',
      name: 'Existing',
      path: '/Selected/Existing',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '7',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:01:00.000Z',
    });
    index.close();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            user: { permissionId: 'new-account' },
            files: [
              {
                id: 'selected-folder',
                name: 'Selected',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [],
              },
              {
                id: 'existing-sheet',
                name: 'Existing',
                mimeType: 'application/vnd.google-apps.spreadsheet',
                parents: ['selected-folder'],
                version: '7',
              },
            ],
          }),
          { status: 200 }
        )
      )
    );

    await runtime.initialize();

    expect(runtime.status()).toMatchObject({ connected: true, selectedFolderCount: 0 });
    expect(runtime.catalog().spreadsheets).toEqual([]);
    const reopened = new LocalIndex(join(directory, 'index.sqlite'), key);
    reopened.initialize();
    expect(reopened.getAccountIdentity()).toBe('new-account');
    reopened.close();
    vi.unstubAllGlobals();
    await runtime.close();
  });

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

  it('preserves indexed account data when OAuth client credentials are replaced', async () => {
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
    expect(index.getSelectedFolderIds()).toEqual(['old-account-folder']);
    expect(index.getCatalog().map((entry) => entry.id)).toEqual(['old-sheet']);
    expect(await vault.getOrCreateDataKey()).toEqual(key);
    index.close();
    await runtime.close();
  });

  it('executes approved sign-out by removing tokens and account-bound index state', async () => {
    const { runtime, directory, vault } = await createRuntime();
    await runtime.initialize();
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_900_000_000_000,
      scope: 'all',
      tokenType: 'Bearer',
    });
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.setSelectedFolderIds(['folder-1']);
    index.upsertSpreadsheet({
      id: 'book-1',
      name: 'Preserved',
      path: '/Folder/Preserved',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '1',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:01:00.000Z',
    });
    index.recordWriteAudit({
      appliedAt: '2026-08-05T00:02:00.000Z',
      operation: 'update_values',
    });
    index.recordPendingVerification({
      operation: 'update_values',
      recordedAt: '2026-08-05T00:03:00.000Z',
      affectedResourceIds: ['spreadsheet:book-1'],
      error: 'pending',
    });

    await expect(runtime.signOut()).resolves.toEqual({ signedOut: true, grantRevoked: false });

    expect(await vault.loadTokens()).toBeNull();
    expect(index.getSelectedFolderIds()).toEqual([]);
    expect(index.getCatalog()).toEqual([]);
    expect(index.getWriteAudits()).toEqual([]);
    expect(index.getPendingVerifications()).toEqual([]);
    index.close();
    await runtime.close();
  });

  it('keeps account state intact and reports a retryable partial sign-out when token deletion fails', async () => {
    const { runtime, directory, vault, backend } = await createRuntime();
    await runtime.initialize();
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_900_000_000_000,
      scope: 'all',
      tokenType: 'Bearer',
    });
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.setSelectedFolderIds(['folder-1']);
    backend.deleteError = new Error('vault unavailable');

    await expect(runtime.signOut()).rejects.toThrow('vault unavailable');

    expect(await vault.loadTokens()).not.toBeNull();
    expect(index.getSelectedFolderIds()).toEqual(['folder-1']);
    expect(runtime.status().error).toContain('Sign-out incomplete');
    backend.deleteError = null;
    await expect(runtime.signOut()).resolves.toMatchObject({ signedOut: true });
    index.close();
    await runtime.close();
  });

  it('does not disconnect before index clearing succeeds and permits a coherent retry', async () => {
    const { runtime, directory, vault } = await createRuntime();
    await runtime.initialize();
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_900_000_000_000,
      scope: 'all',
      tokenType: 'Bearer',
    });
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.setSelectedFolderIds(['folder-1']);
    vi.spyOn(LocalIndex.prototype, 'clearAccountData').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(runtime.signOut()).rejects.toThrow('database unavailable');

    expect(await vault.loadTokens()).toBeNull();
    expect(index.getSelectedFolderIds()).toEqual(['folder-1']);
    await expect(runtime.signOut()).resolves.toMatchObject({ signedOut: true });
    expect(index.getSelectedFolderIds()).toEqual([]);
    index.close();
    await runtime.close();
  });

  it('preserves the connected session when Google grant revocation fails', async () => {
    const { runtime, directory, vault } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_900_000_000_000,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
      tokenType: 'Bearer',
    });
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('/revoke')) {
        return new Response('{}', { status: 503 });
      }
      return new Response(JSON.stringify({ user: { permissionId: 'account-1' }, files: [] }), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetcher);
    await runtime.initialize();
    expect(runtime.status().connected).toBe(true);

    await expect(runtime.signOut({ revokeGoogleGrant: true })).rejects.toThrow('HTTP 503');

    expect(runtime.status().connected).toBe(true);
    expect(await vault.loadTokens()).not.toBeNull();
    await runtime.close();
  });

  it('finalizes approved sign-out without recreating cleared audit or pending rows', async () => {
    const { runtime, directory, vault } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    await vault.saveTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiryDate: 1_900_000_000_000,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
      tokenType: 'Bearer',
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ user: { permissionId: 'account-1' }, files: [] }), {
            status: 200,
          })
        )
    );
    await runtime.initialize();
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.recordWriteAudit({
      appliedAt: '2026-08-05T00:02:00.000Z',
      operation: 'update_values',
    });

    const proposal = (await runtime.prepareSignOut()) as { id: string };
    const confirmationToken = runtime.confirmationToken(proposal.id);
    await expect(runtime.approve(proposal.id, confirmationToken)).resolves.toMatchObject({
      status: 'applied',
      verificationState: 'verified',
    });

    expect(runtime.status().connected).toBe(false);
    expect(await vault.loadTokens()).toBeNull();
    expect(index.getWriteAudits()).toEqual([]);
    expect(index.getPendingVerifications()).toEqual([]);
    index.close();
    await runtime.close();
  });
});
