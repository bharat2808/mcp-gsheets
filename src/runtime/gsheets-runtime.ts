import { join } from 'node:path';

import { CredentialVault, OAuthTokenSet } from '../auth/credential-vault.js';
import { missingGoogleOAuthScopes } from '../auth/google-oauth.js';
import { KeyringBackend } from '../auth/keyring-backend.js';
import {
  OAuthSetupServer,
  OAuthSetupServerHandle,
  SetupServerOptions,
} from '../auth/setup-server.js';
import {
  GoogleOAuthClientIdSource,
  resolveGoogleOAuthClientId,
  saveLocalGoogleOAuthClientId,
  validateGoogleOAuthClientId,
} from '../config/google-oauth-client.js';
import {
  dataDirectory as defaultDataDirectory,
  PUBLISHER_GOOGLE_CLIENT_ID,
} from '../config/runtime.js';
import { CellValue } from '../domain/types.js';
import { buildCatalogTree } from '../drive/catalog.js';
import {
  CreateSpreadsheetGatewayInput,
  GoogleSheetsGateway,
  InsertColumnsGatewayInput,
} from '../google/google-api-client.js';
import { findDuplicateRow } from '../indexing/rows.js';
import {
  ProposalManager,
  SheetChangeProposal,
  SheetChangeOperation,
} from '../proposals/proposal-manager.js';
import { LocalIndex } from '../storage/local-index.js';
import { RefreshResult, SyncService } from '../sync/sync-service.js';
import { runWithGoogleSheetsGateway } from '../utils/google-auth.js';

export interface PrepareChangeInput {
  spreadsheetId: string;
  sheetId: number;
  operation: SheetChangeOperation;
  rowNumber?: number;
  values: Record<string, CellValue>;
}

export interface GSheetsRuntimeOptions {
  vault?: CredentialVault;
  dataDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  publisherClientId?: string;
  setupServerFactory?: (options: SetupServerOptions) => OAuthSetupServerHandle;
}

export class GSheetsRuntime {
  readonly #vault: CredentialVault;
  readonly #dataDirectory: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #publisherClientId: string;
  readonly #setupServerFactory: (options: SetupServerOptions) => OAuthSetupServerHandle;
  #index: LocalIndex | null = null;
  #client: GoogleSheetsGateway | null = null;
  #sync: SyncService | null = null;
  #proposals: ProposalManager | null = null;
  #setup: OAuthSetupServerHandle | null = null;
  #setupUrl: string | null = null;
  #clientId = '';
  #clientSecret = '';
  #clientIdSource: GoogleOAuthClientIdSource = 'missing';
  #poller: NodeJS.Timeout | null = null;
  #lastRefresh: RefreshResult | null = null;
  #lastError: string | null = null;
  #refreshPromise: Promise<RefreshResult> | null = null;
  #missingScopes: string[] = [];

  constructor(options: GSheetsRuntimeOptions = {}) {
    this.#vault = options.vault ?? new CredentialVault(new KeyringBackend());
    this.#dataDirectory = options.dataDirectory ?? defaultDataDirectory();
    this.#environment = options.environment ?? process.env;
    this.#publisherClientId = options.publisherClientId ?? PUBLISHER_GOOGLE_CLIENT_ID;
    this.#setupServerFactory =
      options.setupServerFactory ?? ((setupOptions) => new OAuthSetupServer(setupOptions));
  }

  async initialize(): Promise<void> {
    const key = await this.#vault.getOrCreateDataKey();
    this.#index = new LocalIndex(join(this.#dataDirectory, 'index.sqlite'), key);
    this.#index.initialize();
    const resolved = await resolveGoogleOAuthClientId({
      environment: this.#environment,
      configPath: this.#configPath(),
      publisherClientId: this.#publisherClientId,
    });
    this.#clientId = resolved.clientId;
    this.#clientIdSource = resolved.source;
    this.#clientSecret = (await this.#vault.loadClientSecret()) ?? '';
    await this.#startSetup();
    const tokens = await this.#vault.loadTokens();
    if (this.#clientId && this.#clientSecret && tokens) {
      this.#missingScopes = missingGoogleOAuthScopes(tokens.scope);
      if (this.#missingScopes.length === 0) {
        await this.#connect(tokens);
      } else {
        this.#lastError = 'Google access must be re-consented to enable Drive file operations.';
      }
    } else if (!this.#clientId || !this.#clientSecret) {
      this.#lastError = 'Open the local setup URL to configure Google OAuth credentials.';
    }
  }

  status() {
    return {
      connected: Boolean(this.#client),
      setupUrl: this.#setupUrl,
      clientIdSource: this.#clientIdSource,
      credentialsConfigured: Boolean(this.#clientId && this.#clientSecret),
      reConsentRequired: this.#missingScopes.length > 0,
      missingScopes: [...this.#missingScopes],
      selectedFolderCount: this.#index?.getSelectedFolderIds().length ?? 0,
      lastRefresh: this.#lastRefresh,
      refreshing: Boolean(this.#refreshPromise),
      error: this.#lastError,
      pollingIntervalMinutes: 5,
    };
  }

  catalog() {
    const spreadsheets = this.#requiredIndex().getCatalog();
    const indexedTimes = spreadsheets.flatMap((record) =>
      record.lastIndexedAt ? [record.lastIndexedAt] : []
    );
    return {
      lastSyncedAt:
        this.#lastRefresh?.completedAt ??
        indexedTimes.sort((first, second) => second.localeCompare(first))[0] ??
        null,
      spreadsheets,
      tree: buildCatalogTree(spreadsheets),
    };
  }

  recentChanges(limit?: number) {
    return {
      detectedChanges: this.#requiredIndex().getRecentChanges(limit),
      approvedWrites: this.#requiredIndex().getWriteAudits(limit),
    };
  }

  explore(spreadsheetId: string) {
    const details = this.#requiredIndex().getSpreadsheetDetails(spreadsheetId);
    if (!details) {
      throw new Error(`Spreadsheet ${spreadsheetId} is not in the selected catalog`);
    }
    return details;
  }

  search(query: string, limit?: number) {
    return this.#requiredIndex().search(query, limit);
  }

  fetch(id: string) {
    const hit = this.#requiredIndex().fetch(id);
    if (!hit) {
      throw new Error(`Indexed row ${id} was not found`);
    }
    return hit;
  }

  async executeLegacyOperation<T>(
    handler: (input: any) => T | Promise<T>,
    input: any,
    policy: { idempotent: boolean; refreshIndex: boolean }
  ): Promise<T> {
    const response = await runWithGoogleSheetsGateway(
      this.#requiredClient(),
      { idempotent: policy.idempotent },
      async () => handler(input)
    );
    if (policy.refreshIndex && !this.#isErrorToolResponse(response)) {
      await this.#refreshAfterMutation();
    }
    return response;
  }

  async createSpreadsheet(input: CreateSpreadsheetGatewayInput) {
    const result = await this.#requiredClient().createSpreadsheet(
      input,
      this.#requiredIndex().getSelectedFolderIds()
    );
    await this.#refreshAfterMutation();
    return result;
  }

  async insertColumns(input: InsertColumnsGatewayInput) {
    const result = await this.#requiredClient().insertColumns(input);
    await this.#refreshAfterMutation();
    return result;
  }

  async moveSpreadsheet(input: { spreadsheetId: string; folderId: string }) {
    const result = await this.#requiredClient().moveSpreadsheet(
      input.spreadsheetId,
      input.folderId,
      this.#requiredIndex().getSelectedFolderIds()
    );
    await this.#refreshAfterMutation();
    return result;
  }

  async setDataValidation(input: Parameters<GoogleSheetsGateway['setDataValidation']>[0]) {
    const result = await this.#requiredClient().setDataValidation(input);
    await this.#refreshAfterMutation();
    return result;
  }

  async clearDataValidation(input: Parameters<GoogleSheetsGateway['clearDataValidation']>[0]) {
    const result = await this.#requiredClient().clearDataValidation(input);
    await this.#refreshAfterMutation();
    return result;
  }

  async setBasicFilter(input: Parameters<GoogleSheetsGateway['setBasicFilter']>[0]) {
    const result = await this.#requiredClient().setBasicFilter(input);
    await this.#refreshAfterMutation();
    return result;
  }

  async clearBasicFilter(input: Parameters<GoogleSheetsGateway['clearBasicFilter']>[0]) {
    const result = await this.#requiredClient().clearBasicFilter(input);
    await this.#refreshAfterMutation();
    return result;
  }

  async signOut(): Promise<{ signedOut: true }> {
    if (this.#refreshPromise) {
      await this.#refreshPromise.catch(() => undefined);
    }
    this.#disconnect();
    await this.#vault.deleteTokens();
    this.#missingScopes = [];
    this.#lastRefresh = null;
    this.#lastError = 'Signed out. Reconnect from the local setup URL.';
    return { signedOut: true };
  }

  #isErrorToolResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || !('content' in value)) {
      return false;
    }
    const content = (value as { content?: Array<{ text?: unknown }> }).content ?? [];
    return content.some(
      (entry) => typeof entry.text === 'string' && entry.text.startsWith('Error:')
    );
  }

  async #refreshAfterMutation(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      this.#lastError = `Google change applied, but index refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async refresh(): Promise<RefreshResult> {
    if (!this.#sync) {
      throw new Error(this.#lastError ?? 'Connect Google first');
    }
    if (this.#refreshPromise) {
      return this.#refreshPromise;
    }
    this.#refreshPromise = this.#sync.refresh(this.#requiredIndex().getSelectedFolderIds());
    try {
      this.#lastRefresh = await this.#refreshPromise;
      this.#lastError = null;
      return this.#lastRefresh;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.#refreshPromise = null;
    }
  }

  async prepare(input: PrepareChangeInput): Promise<SheetChangeProposal> {
    const client = this.#requiredClient();
    let details = this.explore(input.spreadsheetId);
    const baseRevision = await client.getRevision(input.spreadsheetId);
    if (
      details.spreadsheet.version !== baseRevision ||
      details.spreadsheet.indexStatus !== 'current'
    ) {
      await this.refresh();
      details = this.explore(input.spreadsheetId);
      if (
        details.spreadsheet.version !== baseRevision ||
        details.spreadsheet.indexStatus !== 'current'
      ) {
        throw new Error('The local index is stale; refresh before preparing this change');
      }
    }
    const sheet = details.sheets.find((entry) => entry.sheetId === input.sheetId);
    if (!sheet) {
      throw new Error(`Sheet ${input.sheetId} is not indexed`);
    }
    const unknownColumns = Object.keys(input.values).filter(
      (column) => !sheet.headers.includes(column)
    );
    if (unknownColumns.length > 0) {
      throw new Error(`Unknown columns: ${unknownColumns.join(', ')}`);
    }
    let expectedValues: Record<string, CellValue> | undefined;
    let displayBeforeValues: Record<string, CellValue> | undefined;
    if (input.operation === 'update') {
      if (!input.rowNumber) {
        throw new Error('An update requires rowNumber');
      }
      const row = this.#requiredIndex().getRawRow(
        input.spreadsheetId,
        input.sheetId,
        input.rowNumber
      );
      if (!row) {
        throw new Error(`Row ${input.rowNumber} is not indexed`);
      }
      const displayRow = this.fetch(
        `sheetrow:${input.spreadsheetId}:${input.sheetId}:${input.rowNumber}`
      );
      expectedValues = Object.fromEntries(
        Object.keys(input.values).map((key) => [key, row[key] ?? null])
      );
      displayBeforeValues = Object.fromEntries(
        Object.keys(input.values).map((key) => [key, displayRow.values[key] ?? null])
      );
    } else {
      const snapshot = this.#requiredIndex().getSheetSnapshot(input.spreadsheetId, input.sheetId);
      if (snapshot?.identifierColumn) {
        const duplicateRow = findDuplicateRow(
          snapshot.rows,
          snapshot.identifierColumn,
          input.values
        );
        if (duplicateRow) {
          throw new Error(
            `A row with the same ${snapshot.identifierColumn} already exists at row ${duplicateRow}`
          );
        }
      }
    }
    return this.#requiredProposals().prepare({
      ...input,
      spreadsheetName: details.spreadsheet.name,
      spreadsheetPath: details.spreadsheet.path,
      sheetTitle: sheet.title,
      baseRevision,
      ...(expectedValues ? { expectedValues } : {}),
      ...(displayBeforeValues ? { displayBeforeValues } : {}),
    });
  }

  review(id: string) {
    return this.#requiredProposals().review(id);
  }

  confirmationToken(id: string): string {
    return this.#requiredProposals().confirmationToken(id);
  }

  edit(id: string, values: Record<string, CellValue>) {
    return this.#requiredProposals().edit(id, values);
  }

  async approve(id: string, confirmationToken: string) {
    const manager = this.#requiredProposals();
    manager.recordVisualConfirmation(id, confirmationToken);
    const proposal = await manager.approve(id);
    this.#requiredIndex().recordWriteAudit({
      proposalId: proposal.id,
      appliedAt: new Date().toISOString(),
      spreadsheetId: proposal.spreadsheetId,
      sheetId: proposal.sheetId,
      sheetTitle: proposal.sheetTitle,
      operation: proposal.operation,
      ...(proposal.rowNumber ? { rowNumber: proposal.rowNumber } : {}),
      ...(proposal.expectedValues ? { beforeValues: proposal.expectedValues } : {}),
      afterValues: proposal.values,
      updatedRange: proposal.result?.updatedRange ?? 'unknown',
      verified: proposal.result?.verified === true,
    });
    try {
      await this.refresh();
    } catch (error) {
      this.#lastError = `Write applied, but index refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return proposal;
  }

  cancel(id: string) {
    return this.#requiredProposals().cancel(id);
  }

  async close(): Promise<void> {
    this.#disconnect();
    this.#setup?.stop();
    this.#index?.close();
  }

  async #connect(tokens: OAuthTokenSet): Promise<void> {
    if (!this.#clientId || !this.#clientSecret) {
      throw new Error('Google OAuth client credentials are not configured');
    }
    this.#missingScopes = missingGoogleOAuthScopes(tokens.scope);
    if (this.#missingScopes.length > 0) {
      this.#disconnect();
      this.#lastError = 'Google access must be re-consented to enable Drive file operations.';
      return;
    }
    const client = new GoogleSheetsGateway(tokens, this.#clientId, this.#clientSecret, (next) =>
      this.#vault.saveTokens(next)
    );
    const accountIdentity = await client.getAccountIdentity();
    const previousIdentity = this.#requiredIndex().getAccountIdentity();
    if (previousIdentity && previousIdentity !== accountIdentity) {
      this.#requiredIndex().clearAccountData();
    }
    this.#requiredIndex().setAccountIdentity(accountIdentity);
    this.#client = client;
    this.#sync = new SyncService(this.#requiredIndex(), this.#client, this.#client);
    this.#proposals = new ProposalManager(this.#client);
    try {
      await this.refresh();
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
    }
    if (!this.#poller) {
      this.#poller = setInterval(
        () =>
          void this.refresh().catch((error: unknown) => {
            this.#lastError = error instanceof Error ? error.message : String(error);
          }),
        5 * 60 * 1000
      );
      this.#poller.unref();
    }
  }

  async #startSetup(): Promise<void> {
    const setup = this.#setupServerFactory({
      vault: this.#vault,
      getClientCredentials: async () =>
        this.#clientId && this.#clientSecret
          ? { clientId: this.#clientId, clientSecret: this.#clientSecret }
          : null,
      saveClientCredentials: (credentials) => this.#saveClientCredentials(credentials),
      getSelectedFolderIds: () => this.#requiredIndex().getSelectedFolderIds(),
      setSelectedFolderIds: (ids) => this.#setSelectedFolderIds(ids),
      onConnected: (tokens) => this.#connect(tokens),
    });
    try {
      const setupUrl = await setup.start();
      this.#setup = setup;
      this.#setupUrl = setupUrl;
    } catch (error) {
      setup.stop();
      throw error;
    }
  }

  async #saveClientCredentials(credentials: {
    clientId: string;
    clientSecret: string;
  }): Promise<void> {
    const clientId = validateGoogleOAuthClientId(credentials.clientId);
    const clientSecret = credentials.clientSecret.trim();
    if (!clientSecret) {
      throw new Error('Google OAuth client secret is required');
    }
    if (
      (this.#clientIdSource === 'environment' || this.#clientIdSource === 'publisher') &&
      clientId !== this.#clientId
    ) {
      throw new Error(
        `Google OAuth client ID is managed by ${this.#clientIdSource} and cannot be replaced here`
      );
    }

    const previousClientId = this.#clientId;
    const previousClientSecret = this.#clientSecret;
    const previousSource = this.#clientIdSource;
    const replacement =
      Boolean(previousClientId || previousClientSecret) &&
      (clientId !== previousClientId || clientSecret !== previousClientSecret);

    try {
      await this.#vault.saveClientSecret(clientSecret);
      if (previousSource !== 'environment' && previousSource !== 'publisher') {
        await saveLocalGoogleOAuthClientId(clientId, this.#configPath());
      }
    } catch (error) {
      if (previousClientSecret) {
        await this.#vault.saveClientSecret(previousClientSecret);
      } else {
        await this.#vault.deleteClientSecret();
      }
      if (previousSource === 'local_config' && previousClientId) {
        await saveLocalGoogleOAuthClientId(previousClientId, this.#configPath());
      }
      throw error;
    }

    if (replacement) {
      if (this.#refreshPromise) {
        await this.#refreshPromise.catch(() => undefined);
      }
      this.#disconnect();
      await this.#vault.deleteTokens();
      this.#lastRefresh = null;
    }

    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#clientIdSource =
      previousSource === 'environment' || previousSource === 'publisher'
        ? previousSource
        : 'local_config';
    this.#lastError = null;
  }

  async #setSelectedFolderIds(ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    const client = this.#requiredClient();
    for (const folderId of uniqueIds) {
      await client.validateSelectedMyDriveFolder(folderId, uniqueIds);
    }
    this.#requiredIndex().setSelectedFolderIds(uniqueIds);
  }

  #disconnect(): void {
    if (this.#poller) {
      clearInterval(this.#poller);
      this.#poller = null;
    }
    this.#client = null;
    this.#sync = null;
    this.#proposals = null;
  }

  #configPath(): string {
    return join(this.#dataDirectory, 'config.json');
  }

  #requiredIndex(): LocalIndex {
    if (!this.#index) {
      throw new Error('GSheets runtime is not initialized');
    }
    return this.#index;
  }

  #requiredClient(): GoogleSheetsGateway {
    if (!this.#client) {
      throw new Error('Connect Google first');
    }
    return this.#client;
  }

  #requiredProposals(): ProposalManager {
    if (!this.#proposals) {
      throw new Error('Connect Google first');
    }
    return this.#proposals;
  }
}
