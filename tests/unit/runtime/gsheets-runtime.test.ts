import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredentialBackend, CredentialVault } from '../../../src/auth/credential-vault.js';
import { SetupServerOptions } from '../../../src/auth/setup-server.js';
import { GoogleSheetsGateway } from '../../../src/google/google-api-client.js';
import { LocalIndex } from '../../../src/storage/local-index.js';
import { GSheetsRuntime } from '../../../src/runtime/gsheets-runtime.js';
import { SyncService } from '../../../src/sync/sync-service.js';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function refreshResult(completedAt: string) {
  return {
    spreadsheetsDiscovered: 0,
    spreadsheetsIndexed: 0,
    sheetsIndexed: 0,
    rowsIndexed: 0,
    completedAt,
    resources: [],
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) await Promise.resolve();
}

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
  it('does not expose or persist a candidate connection before its first refresh completes', async () => {
    const { runtime, directory, vault, getSetupOptions } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    await runtime.initialize();
    vi.spyOn(GoogleSheetsGateway.prototype, 'getAccountIdentity').mockResolvedValue('account-1');
    const firstRefresh = deferred<ReturnType<typeof refreshResult>>();
    const refresh = vi.spyOn(SyncService.prototype, 'refresh').mockReturnValue(firstRefresh.promise);
    const candidateTokens = {
      accessToken: 'candidate-access',
      refreshToken: 'candidate-refresh',
      expiryDate: 1_900_000_000_000,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
      tokenType: 'Bearer',
    };

    const connecting = getSetupOptions()!.onConnected(candidateTokens);
    await waitUntil(() => refresh.mock.calls.length === 1);

    expect(runtime.status().connected).toBe(false);
    expect(await vault.loadTokens()).toBeNull();
    firstRefresh.resolve(refreshResult('2026-08-06T00:00:00.000Z'));
    await connecting;
    expect(runtime.status()).toMatchObject({ connected: true, refreshing: false });
    expect(await vault.loadTokens()).toEqual(candidateTokens);
    await runtime.close();
  });

  it('refreshes a new folder selection before exposing the committed selection', async () => {
    const { runtime, directory, vault, getSetupOptions } = await createRuntime();
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
    vi.spyOn(GoogleSheetsGateway.prototype, 'getAccountIdentity').mockResolvedValue('account-1');
    vi.spyOn(GoogleSheetsGateway.prototype, 'validateSelectedMyDriveFolder').mockResolvedValue();
    const selectionRefresh = deferred<ReturnType<typeof refreshResult>>();
    const refresh = vi
      .spyOn(SyncService.prototype, 'refresh')
      .mockResolvedValueOnce(refreshResult('2026-08-06T00:00:00.000Z'))
      .mockReturnValueOnce(selectionRefresh.promise);
    await runtime.initialize();

    const selecting = getSetupOptions()!.setSelectedFolderIds(['new-folder']);
    await waitUntil(() => refresh.mock.calls.length >= 2 || runtime.status().selectedFolderCount > 0);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1]?.[0]).toEqual(['new-folder']);
    expect(runtime.status().selectedFolderCount).toBe(0);
    selectionRefresh.resolve(refreshResult('2026-08-06T00:01:00.000Z'));
    await selecting;
    expect(runtime.status().selectedFolderCount).toBe(1);
    await runtime.close();
  });

  it('starts a distinct post-write refresh after an older refresh finishes', async () => {
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
    vi.spyOn(GoogleSheetsGateway.prototype, 'getAccountIdentity').mockResolvedValue('account-1');
    vi.spyOn(GoogleSheetsGateway.prototype, 'inspectOperation').mockResolvedValue({
      affectedResources: [{ kind: 'spreadsheet', id: 'book', label: 'book' }],
      preview: { kind: 'values', before: [], after: [['new']] },
      riskInspection: { targetCellsVerifiedEmpty: true },
      driveRevisions: { book: '1' },
      state: {},
    });
    const verification = deferred<boolean>();
    const verifyOperation = vi
      .spyOn(GoogleSheetsGateway.prototype, 'verifyOperation')
      .mockReturnValue(verification.promise);
    const oldRefresh = deferred<ReturnType<typeof refreshResult>>();
    const refresh = vi
      .spyOn(SyncService.prototype, 'refresh')
      .mockResolvedValueOnce(refreshResult('2026-08-06T00:00:00.000Z'))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValueOnce({
        ...refreshResult('2026-08-06T00:02:00.000Z'),
        resources: [{ spreadsheetId: 'book', status: 'indexed' as const }],
      });
    await runtime.initialize();

    const manualRefresh = runtime.refresh();
    await waitUntil(() => refresh.mock.calls.length === 2);
    const execute = vi.fn().mockResolvedValue({ updatedRange: 'Plan!A1' });
    const mutation = runtime.executeRetainedOperation(
      'update_values',
      execute,
      { spreadsheetId: 'book', range: 'Plan!A1', values: [['new']] },
      { idempotent: true, refreshIndex: true }
    );
    await waitUntil(() => execute.mock.calls.length === 1);
    await waitUntil(() => verifyOperation.mock.calls.length === 1);
    verification.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    oldRefresh.resolve(refreshResult('2026-08-06T00:01:00.000Z'));
    await Promise.all([manualRefresh, mutation]);

    expect(refresh).toHaveBeenCalledTimes(3);
    await runtime.close();
  });

  it('clears pending verification only for spreadsheets confirmed by refresh', async () => {
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
    vi.spyOn(GoogleSheetsGateway.prototype, 'getAccountIdentity').mockResolvedValue('account-1');
    vi.spyOn(SyncService.prototype, 'refresh')
      .mockResolvedValueOnce(refreshResult('2026-08-06T00:00:00.000Z'))
      .mockResolvedValueOnce({
        ...refreshResult('2026-08-06T00:01:00.000Z'),
        resources: [
          { spreadsheetId: 'book-1', status: 'current' as const },
          { spreadsheetId: 'book-2', status: 'failed' as const, error: 'unavailable' },
        ],
      });
    await runtime.initialize();
    const index = new LocalIndex(
      join(directory, 'index.sqlite'),
      await vault.getOrCreateDataKey()
    );
    index.initialize();
    index.recordPendingVerification({
      operation: 'batch_update_values',
      recordedAt: '2026-08-06T00:00:30.000Z',
      affectedResourceIds: ['spreadsheet:book-1', 'spreadsheet:book-2'],
      error: 'partial verification',
    });

    await runtime.refresh();

    expect(index.getPendingVerifications()).toEqual([
      expect.objectContaining({ affectedResourceIds: ['spreadsheet:book-2'] }),
    ]);
    index.close();
    await runtime.close();
  });

  it('removes persisted folder selections that are not owned and root-reachable before refresh', async () => {
    const { runtime, directory, vault, getSetupOptions } = await createRuntime();
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
    index.setSelectedFolderIds(['owned-folder', 'shared-with-me']);
    index.close();
    vi.stubGlobal('fetch', async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('/about')) {
        return new Response(JSON.stringify({ user: { permissionId: 'account-1' } }));
      }
      if (url.includes('/files/root')) {
        return new Response(
          JSON.stringify({
            id: 'root-id',
            name: 'My Drive',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [],
            ownedByMe: true,
          })
        );
      }
      return new Response(
        JSON.stringify({
          files: [
            {
              id: 'owned-folder',
              name: 'Owned',
              mimeType: 'application/vnd.google-apps.folder',
              parents: ['root-id'],
              ownedByMe: true,
            },
            {
              id: 'shared-with-me',
              name: 'Shared',
              mimeType: 'application/vnd.google-apps.folder',
              parents: ['root-id'],
              ownedByMe: false,
            },
          ],
        })
      );
    });

    await runtime.initialize();

    expect(getSetupOptions()?.getSelectedFolderIds()).toEqual(['owned-folder']);
    expect(runtime.status().selectedFolderCount).toBe(1);
    await runtime.close();
  });

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
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('/about')) {
        return new Response(JSON.stringify({ user: { permissionId: 'account-1' } }), {
          status: 200,
        });
      }
      if (url.includes('/files/root')) {
        return new Response(
          JSON.stringify({
            id: 'root-id',
            name: 'My Drive',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [],
            ownedByMe: true,
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          files: [
            {
              id: 'folder-1',
              name: 'Folder',
              mimeType: 'application/vnd.google-apps.folder',
              parents: ['root-id'],
              ownedByMe: true,
            },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const refresh = vi
      .spyOn(SyncService.prototype, 'refresh')
      .mockResolvedValue(refreshResult('2026-08-06T00:00:00.000Z'));
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
      vi.fn().mockImplementation(
        async () =>
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

  it('does not let an older token-refresh callback recreate credentials after sign-out', async () => {
    const { runtime, directory, vault } = await createRuntime();
    await writeFile(
      join(directory, 'config.json'),
      JSON.stringify({ googleOAuthClientId: CLIENT_ID }),
      { mode: 0o600 }
    );
    await vault.saveClientSecret('GOCSPX-secret');
    await vault.saveTokens({
      accessToken: 'expired-access',
      refreshToken: 'refresh',
      expiryDate: 0,
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
      tokenType: 'Bearer',
    });
    let client: GoogleSheetsGateway | null = null;
    vi.spyOn(GoogleSheetsGateway.prototype, 'getAccountIdentity').mockImplementation(function () {
      client = this;
      return Promise.resolve('account-1');
    });
    vi.spyOn(GoogleSheetsGateway.prototype, 'authorizeSpreadsheet').mockResolvedValue();
    vi.spyOn(SyncService.prototype, 'refresh').mockResolvedValue(
      refreshResult('2026-08-06T00:00:00.000Z')
    );
    const tokenResponse = deferred<Response>();
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      if (String(input).includes('/token')) return tokenResponse.promise;
      return new Response(JSON.stringify({ version: '8' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetcher);
    await runtime.initialize();

    const revision = client!.getRevision('book');
    await waitUntil(() => fetcher.mock.calls.some(([input]) => String(input).includes('/token')));
    await runtime.signOut();
    tokenResponse.resolve(
      new Response(
        JSON.stringify({ access_token: 'late-access', expires_in: 3600, token_type: 'Bearer' }),
        { status: 200 }
      )
    );

    await expect(revision).resolves.toBe('8');
    expect(await vault.loadTokens()).toBeNull();
    expect(runtime.status().connected).toBe(false);
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
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ user: { permissionId: 'account-1' }, files: [] }), {
            status: 200,
          })
      )
    );
    await runtime.initialize();
    const key = await vault.getOrCreateDataKey();
    const index = new LocalIndex(join(directory, 'index.sqlite'), key);
    index.initialize();
    index.setSelectedFolderIds(['school-folder']);
    index.upsertSpreadsheet({
      id: 'school-records',
      name: 'School Records',
      path: '/School/School Records',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '1',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:01:00.000Z',
    });
    index.recordWriteAudit({
      appliedAt: '2026-08-05T00:02:00.000Z',
      operation: 'update_values',
    });

    const proposal = (await runtime.prepareSignOut()) as {
      id: string;
      preview: { kind: string; before: unknown; after: unknown };
    };
    expect(proposal.preview).toEqual({
      kind: 'exact',
      before: {
        connection: 'connected',
        selectedFolderCount: 1,
        indexedSpreadsheetCount: 1,
        approvedWriteCount: 1,
        googleGrant: 'retained',
      },
      after: {
        connection: 'signed_out',
        selectedFolderCount: 0,
        indexedSpreadsheetCount: 0,
        approvedWriteCount: 0,
        googleGrant: 'retained',
      },
    });
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
