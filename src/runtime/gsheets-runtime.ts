import { join } from 'node:path';

import {
  CredentialVault,
  OAuthTokenSet,
  resolveCredentialServiceName,
} from '../auth/credential-vault.js';
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
  AffectedResource,
  ChangeProposal,
  RowChangeOperation,
  RowChangeRequest,
} from '../proposals/proposal-manager.js';
import {
  ChangeWorkflow,
  ChangeWorkflowOutcome,
  ChangeRefreshResult,
  OperationPreflight,
} from '../operations/change-workflow.js';
import { LocalIndex } from '../storage/local-index.js';
import { RefreshResult, SyncService } from '../sync/sync-service.js';
import { runWithGoogleSheetsGateway } from '../utils/google-auth.js';

export interface PrepareChangeInput {
  spreadsheetId: string;
  sheetId: number;
  operation: RowChangeOperation;
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
  #workflow: ChangeWorkflow | null = null;
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
  #lifecycleTail: Promise<void> = Promise.resolve();
  #connectionGeneration = 0;
  #selectedFolderOverride: readonly string[] | null = null;

  constructor(options: GSheetsRuntimeOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#vault =
      options.vault ??
      new CredentialVault(new KeyringBackend(), resolveCredentialServiceName(this.#environment));
    this.#dataDirectory = options.dataDirectory ?? defaultDataDirectory();
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

  async executeRetainedOperation<T>(
    operation: string,
    handler: (input: any) => T | Promise<T>,
    input: any,
    policy: { idempotent: boolean; refreshIndex: boolean }
  ): Promise<T | ChangeProposal | Record<string, unknown>> {
    const execute = async (
      arguments_: Record<string, unknown>,
      context: { approval: 'direct' | 'reviewed' }
    ) => {
      const response = await runWithGoogleSheetsGateway(
        this.#requiredClient(),
        { idempotent: context.approval === 'direct' && policy.idempotent },
        async () => handler(arguments_)
      );
      if (this.#isErrorToolResponse(response)) {
        throw new Error(this.#toolResponseError(response));
      }
      return response;
    };
    if (!policy.refreshIndex) {
      return execute(input, { approval: 'direct' });
    }
    return this.#outcome(
      await this.#requiredWorkflow().execute({ operation, arguments: input, execute })
    ) as T | ChangeProposal | Record<string, unknown>;
  }

  async createSpreadsheet(input: CreateSpreadsheetGatewayInput) {
    return this.#outcome(
      await this.#requiredWorkflow().execute({
        operation: 'create_spreadsheet',
        arguments: input as unknown as Record<string, unknown>,
        execute: (arguments_, context) =>
          this.#withGatewayExecutionPolicy(context, false, () =>
            this.#requiredClient().createSpreadsheet(
              arguments_ as unknown as CreateSpreadsheetGatewayInput,
              this.#requiredIndex().getSelectedFolderIds()
            )
          ),
      })
    );
  }

  async insertColumns(input: InsertColumnsGatewayInput) {
    return this.#outcome(
      await this.#requiredWorkflow().execute({
        operation: 'insert_columns',
        arguments: input as unknown as Record<string, unknown>,
        execute: (arguments_, context) =>
          this.#withGatewayExecutionPolicy(context, false, () =>
            this.#requiredClient().insertColumns(arguments_ as unknown as InsertColumnsGatewayInput)
          ),
      })
    );
  }

  async moveSpreadsheet(input: { spreadsheetId: string; folderId: string }) {
    return this.#outcome(
      await this.#requiredWorkflow().execute({
        operation: 'move_spreadsheet',
        arguments: input,
        execute: (arguments_, context) => {
          const selectedFolderIds = this.#requiredIndex().getSelectedFolderIds();
          const folderId = String(arguments_.folderId);
          return this.#withGatewayExecutionPolicy(context, false, () =>
            this.#requiredClient().moveSpreadsheet(
              String(arguments_.spreadsheetId),
              folderId,
              selectedFolderIds,
              !selectedFolderIds.includes(folderId)
            )
          );
        },
      })
    );
  }

  async setDataValidation(input: Parameters<GoogleSheetsGateway['setDataValidation']>[0]) {
    return this.#executeGatewayMutation('set_data_validation', input, (arguments_) =>
      this.#requiredClient().setDataValidation(arguments_)
    );
  }

  async clearDataValidation(input: Parameters<GoogleSheetsGateway['clearDataValidation']>[0]) {
    return this.#executeGatewayMutation('clear_data_validation', input, (arguments_) =>
      this.#requiredClient().clearDataValidation(arguments_)
    );
  }

  async setBasicFilter(input: Parameters<GoogleSheetsGateway['setBasicFilter']>[0]) {
    return this.#executeGatewayMutation('set_basic_filter', input, (arguments_) =>
      this.#requiredClient().setBasicFilter(arguments_)
    );
  }

  async clearBasicFilter(input: Parameters<GoogleSheetsGateway['clearBasicFilter']>[0]) {
    return this.#executeGatewayMutation('clear_basic_filter', input, (arguments_) =>
      this.#requiredClient().clearBasicFilter(arguments_)
    );
  }

  async signOut(
    options: { revokeGoogleGrant?: boolean } = {}
  ): Promise<{ signedOut: true; grantRevoked: boolean }> {
    return this.#withLifecycle(async () => {
      const priorGeneration = this.#connectionGeneration;
      let tokensDeleted = false;
      try {
        if (options.revokeGoogleGrant === true) {
          await this.#requiredClient().revokeGoogleGrant();
        }
        this.#connectionGeneration += 1;
        await this.#vault.deleteTokens();
        tokensDeleted = true;
        this.#requiredIndex().clearAccountData();
      } catch (error) {
        if (!tokensDeleted) {
          this.#connectionGeneration = priorGeneration;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.#lastError = `Sign-out incomplete: ${message}`;
        throw error;
      }
      this.#disconnect();
      this.#missingScopes = [];
      this.#lastRefresh = null;
      this.#lastError = 'Signed out. Reconnect from the local setup URL.';
      return { signedOut: true, grantRevoked: options.revokeGoogleGrant === true };
    });
  }

  async prepareSignOut(input: { revokeGoogleGrant?: boolean } = {}) {
    const revokeGoogleGrant = input.revokeGoogleGrant ?? false;
    const before = this.#signOutPreviewBefore(revokeGoogleGrant);
    const after = {
      connection: 'signed_out',
      selectedFolderCount: 0,
      indexedSpreadsheetCount: 0,
      approvedWriteCount: 0,
      googleGrant: revokeGoogleGrant ? 'revoked' : 'retained',
    };
    return this.#outcome(
      await this.#requiredWorkflow().execute({
        operation: 'sign_out',
        arguments: { revokeGoogleGrant },
        preflight: {
          affectedResources: [{ kind: 'account', id: 'google', label: 'Connected Google account' }],
          preview: { kind: 'exact', before, after },
          riskInspection: {},
          driveRevisions: {},
          state: before,
        },
        execute: (arguments_) =>
          this.signOut({ revokeGoogleGrant: arguments_.revokeGoogleGrant === true }),
        refresh: false,
        persistOutcome: false,
      })
    );
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

  #toolResponseError(value: unknown): string {
    const content = (value as { content?: Array<{ text?: unknown }> }).content ?? [];
    return (
      content.flatMap((entry) => (typeof entry.text === 'string' ? [entry.text] : [])).join('\n') ||
      'Google operation failed'
    );
  }

  async refresh(): Promise<RefreshResult> {
    return this.#startRefresh(false);
  }

  async prepare(input: PrepareChangeInput): Promise<ChangeProposal> {
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
    const rowRequest: RowChangeRequest = {
      ...input,
      spreadsheetName: details.spreadsheet.name,
      spreadsheetPath: details.spreadsheet.path,
      sheetTitle: sheet.title,
      baseRevision,
      ...(expectedValues ? { expectedValues } : {}),
      ...(displayBeforeValues ? { displayBeforeValues } : {}),
    };
    const arguments_: Record<string, unknown> = structuredClone(input) as unknown as Record<
      string,
      unknown
    >;
    const preflightState = await client.captureRowChangeState({
      spreadsheetId: input.spreadsheetId,
      sheetId: input.sheetId,
      operation: input.operation,
      ...(input.rowNumber ? { rowNumber: input.rowNumber } : {}),
      columns: Object.keys(input.values),
    });
    const resources: AffectedResource[] = [
      {
        kind: 'spreadsheet',
        id: input.spreadsheetId,
        label: details.spreadsheet.name,
      },
      {
        kind: 'sheet',
        id: `${input.spreadsheetId}:${input.sheetId}`,
        label: sheet.title,
      },
    ];
    if (input.rowNumber) {
      resources.push({
        kind: 'range',
        id: `${input.spreadsheetId}:${input.sheetId}:${input.rowNumber}`,
        label: `${sheet.title} row ${input.rowNumber}`,
      });
    }
    const preflight: OperationPreflight = {
      affectedResources: resources,
      preview: {
        kind: 'values',
        before: displayBeforeValues ?? expectedValues ?? null,
        after: input.values,
      },
      riskInspection: {},
      driveRevisions: { [input.spreadsheetId]: baseRevision },
      state: preflightState,
    };
    const outcome = await this.#requiredWorkflow().execute({
      operation: 'prepare_row_change',
      arguments: arguments_,
      preflight,
      execute: async (editedArguments, context) =>
        this.#withGatewayExecutionPolicy(context, false, () =>
          client.applyRow({
            ...rowRequest,
            values: editedArguments.values as Record<string, CellValue>,
          })
        ),
    });
    if (outcome.kind !== 'proposal') {
      throw new Error('Row changes must always produce a reviewed proposal');
    }
    return outcome.proposal;
  }

  review(id: string) {
    return this.#requiredWorkflow().review(id);
  }

  confirmationToken(id: string): string {
    return this.#requiredWorkflow().confirmationToken(id);
  }

  edit(id: string, values: unknown) {
    return this.#requiredWorkflow().edit(id, values);
  }

  async approve(id: string, confirmationToken: string) {
    return this.#requiredWorkflow().approve(id, confirmationToken);
  }

  cancel(id: string) {
    return this.#requiredWorkflow().cancel(id);
  }

  async close(): Promise<void> {
    this.#disconnect();
    this.#setup?.stop();
    this.#index?.close();
  }

  async #connect(tokens: OAuthTokenSet): Promise<void> {
    return this.#withLifecycle(() => this.#connectLocked(tokens));
  }

  async #connectLocked(tokens: OAuthTokenSet): Promise<void> {
    if (!this.#clientId || !this.#clientSecret) {
      throw new Error('Google OAuth client credentials are not configured');
    }
    const missingScopes = missingGoogleOAuthScopes(tokens.scope);
    if (missingScopes.length > 0) {
      throw new Error(`Google token is missing required OAuth scopes: ${missingScopes.join(', ')}`);
    }
    const candidateConnectionGeneration = this.#connectionGeneration + 1;
    let stagedTokens = tokens;
    let tokensCommitted = false;
    let candidateSelectedFolderIds = this.#requiredIndex().getSelectedFolderIds();
    const client = new GoogleSheetsGateway(
      tokens,
      this.#clientId,
      this.#clientSecret,
      async (next) => {
        stagedTokens = next;
        if (tokensCommitted && candidateConnectionGeneration === this.#connectionGeneration) {
          await this.#vault.saveTokens(next);
        }
      },
      fetch,
      Date.now,
      {
        getSelectedFolderIds: () =>
          tokensCommitted
            ? (this.#selectedFolderOverride ?? this.#requiredIndex().getSelectedFolderIds())
            : candidateSelectedFolderIds,
      }
    );
    const accountIdentity = await client.getAccountIdentity();
    const index = this.#requiredIndex();
    const previousIdentity = index.getAccountIdentity();
    const selectedFolderIds = index.getSelectedFolderIds();
    const retainsAccountData = !previousIdentity || previousIdentity === accountIdentity;
    const selectableIds =
      retainsAccountData && selectedFolderIds.length > 0
        ? new Set((await client.listSelectableMyDriveFolders()).map((folder) => folder.id))
        : new Set<string>();
    const retainedFolderIds = selectedFolderIds.filter((folderId) => selectableIds.has(folderId));
    candidateSelectedFolderIds = retainedFolderIds;
    const sync = new SyncService(index, client, client);
    const refreshResult = await sync.refresh(retainedFolderIds);
    const previousTokens = await this.#vault.loadTokens();
    try {
      await this.#vault.saveTokens(stagedTokens);
      index.adoptAccountIdentity(accountIdentity);
      if (retainsAccountData) {
        index.setSelectedFolderIds(retainedFolderIds);
      }
    } catch (error) {
      if (previousTokens) {
        await this.#vault.saveTokens(previousTokens);
      } else {
        await this.#vault.deleteTokens();
      }
      throw error;
    }
    tokensCommitted = true;
    this.#connectionGeneration = candidateConnectionGeneration;
    this.#disconnect();
    this.#missingScopes = [];
    this.#client = client;
    this.#sync = sync;
    this.#workflow = new ChangeWorkflow({
      gateway: {
        inspect: (operation, arguments_) =>
          client.inspectOperation(
            operation,
            arguments_,
            this.#requiredIndex().getSelectedFolderIds()
          ),
        getRevisions: (proposal) =>
          client.getRevisions(
            proposal.affectedResources
              .filter((resource) => resource.kind === 'spreadsheet')
              .map((resource) => resource.id)
          ),
        captureState: (proposal) => {
          if (proposal.operation === 'sign_out') {
            return Promise.resolve(
              this.#signOutPreviewBefore(proposal.arguments.revokeGoogleGrant === true)
            );
          }
          if (proposal.operation === 'prepare_row_change') {
            const arguments_ = proposal.arguments as unknown as PrepareChangeInput;
            const after = proposal.preview.after as Record<string, CellValue>;
            return client.captureRowChangeState({
              spreadsheetId: arguments_.spreadsheetId,
              sheetId: arguments_.sheetId,
              operation: arguments_.operation,
              ...(arguments_.rowNumber ? { rowNumber: arguments_.rowNumber } : {}),
              columns: Object.keys(after),
            });
          }
          return client.captureOperationState(
            proposal.operation,
            proposal.arguments,
            this.#requiredIndex().getSelectedFolderIds()
          );
        },
        verify: (operation, arguments_, result, preflight) => {
          if (operation === 'prepare_row_change') {
            return Promise.resolve(
              Boolean(
                result &&
                typeof result === 'object' &&
                (result as { verified?: unknown }).verified === true
              )
            );
          }
          if (operation === 'move_spreadsheet') {
            return Promise.resolve(
              Boolean(
                result &&
                typeof result === 'object' &&
                (result as { verified?: unknown }).verified === true
              )
            );
          }
          return client.verifyOperation(operation, arguments_, result, preflight);
        },
      },
      auditStore: this.#requiredIndex(),
      refresh: (affectedResources) => this.#refreshAfterWrite(affectedResources),
    });
    this.#applyRefreshResult(refreshResult);
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
    return this.#withLifecycle(() => this.#saveClientCredentialsLocked(credentials));
  }

  async #saveClientCredentialsLocked(credentials: {
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
      this.#connectionGeneration += 1;
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
    return this.#withLifecycle(() => this.#setSelectedFolderIdsLocked(ids));
  }

  async #setSelectedFolderIdsLocked(ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    const client = this.#requiredClient();
    for (const folderId of uniqueIds) {
      await client.validateSelectedMyDriveFolder(folderId, uniqueIds);
    }
    this.#selectedFolderOverride = uniqueIds;
    let refreshResult: RefreshResult;
    try {
      refreshResult = await this.#requiredSync().refresh(uniqueIds);
    } finally {
      this.#selectedFolderOverride = null;
    }
    this.#requiredIndex().setSelectedFolderIds(uniqueIds);
    this.#applyRefreshResult(refreshResult);
  }

  #signOutPreviewBefore(revokeGoogleGrant: boolean) {
    const index = this.#requiredIndex();
    return {
      connection: 'connected',
      selectedFolderCount: index.getSelectedFolderIds().length,
      indexedSpreadsheetCount: index.getCatalog().length,
      approvedWriteCount: index.getWriteAudits().length,
      googleGrant: revokeGoogleGrant ? 'active' : 'retained',
    };
  }

  #disconnect(): void {
    if (this.#poller) {
      clearInterval(this.#poller);
      this.#poller = null;
    }
    this.#client = null;
    this.#sync = null;
    this.#workflow = null;
  }

  #requiredSync(): SyncService {
    if (!this.#sync) {
      throw new Error(this.#lastError ?? 'Connect Google first');
    }
    return this.#sync;
  }

  #withLifecycle<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#lifecycleTail = previous.catch(() => undefined).then(() => gate);
    return previous
      .catch(() => undefined)
      .then(action)
      .finally(release);
  }

  #startRefresh(forceAfterCurrent: boolean): Promise<RefreshResult> {
    if (!forceAfterCurrent && this.#refreshPromise) {
      return this.#refreshPromise;
    }
    const previousRefresh = forceAfterCurrent ? this.#refreshPromise : null;
    const refreshPromise = (async () => {
      if (previousRefresh) {
        await previousRefresh.catch(() => undefined);
      }
      return this.#withLifecycle(async () => {
        try {
          const result = await this.#requiredSync().refresh(
            this.#requiredIndex().getSelectedFolderIds()
          );
          this.#applyRefreshResult(result);
          return result;
        } catch (error) {
          this.#lastError = error instanceof Error ? error.message : String(error);
          throw error;
        }
      });
    })();
    this.#refreshPromise = refreshPromise;
    void refreshPromise
      .finally(() => {
        if (this.#refreshPromise === refreshPromise) {
          this.#refreshPromise = null;
        }
      })
      .catch(() => undefined);
    return refreshPromise;
  }

  async #refreshAfterWrite(
    affectedResources: readonly AffectedResource[]
  ): Promise<ChangeRefreshResult> {
    const result = await this.#startRefresh(true);
    return this.#refreshResultForAffectedResources(result, affectedResources);
  }

  #refreshResultForAffectedResources(
    result: RefreshResult,
    affectedResources: readonly AffectedResource[]
  ): ChangeRefreshResult {
    const bySpreadsheetId = new Map(
      result.resources.map((resource) => [resource.spreadsheetId, resource] as const)
    );
    const refreshedResourceIds: string[] = [];
    const removedResourceIds: string[] = [];
    const failedResourceIds: string[] = [];
    const errors: Record<string, string> = {};
    for (const resource of affectedResources) {
      const resourceId = `${resource.kind}:${resource.id}`;
      const spreadsheetId = this.#spreadsheetIdForResource(resource);
      const outcome = spreadsheetId ? bySpreadsheetId.get(spreadsheetId) : undefined;
      if (!outcome || outcome.status === 'failed') {
        failedResourceIds.push(resourceId);
        errors[resourceId] =
          outcome?.status === 'failed' ? outcome.error : 'Affected spreadsheet was not refreshed';
      } else if (outcome.status === 'removed') {
        removedResourceIds.push(resourceId);
      } else {
        refreshedResourceIds.push(resourceId);
      }
    }
    return { refreshedResourceIds, removedResourceIds, failedResourceIds, errors };
  }

  #spreadsheetIdForResource(resource: AffectedResource): string | null {
    if (resource.kind === 'spreadsheet') {
      return resource.id;
    }
    if (resource.kind === 'account') {
      return null;
    }
    return resource.id.split(':')[0] ?? null;
  }

  #applyRefreshResult(result: RefreshResult): void {
    this.#lastRefresh = result;
    const failed = result.resources.filter((resource) => resource.status === 'failed');
    const successfulSpreadsheetIds = new Set(
      result.resources
        .filter((resource) => resource.status !== 'failed')
        .map((resource) => resource.spreadsheetId)
    );
    const clearIds = this.#requiredIndex()
      .getPendingVerifications()
      .flatMap((pending) => pending.affectedResourceIds)
      .filter((resourceId) => {
        const separator = resourceId.indexOf(':');
        const kind = resourceId.slice(0, separator);
        const id = resourceId.slice(separator + 1);
        const spreadsheetId = kind === 'spreadsheet' ? id : id.split(':')[0];
        return Boolean(spreadsheetId && successfulSpreadsheetIds.has(spreadsheetId));
      });
    if (clearIds.length > 0) {
      this.#requiredIndex().clearPendingVerifications(clearIds);
      this.#workflow?.clearPendingVerificationBlocks(clearIds);
    }
    this.#lastError =
      failed.length > 0
        ? `Index refresh failed for ${failed.map((resource) => resource.spreadsheetId).join(', ')}`
        : null;
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

  #requiredWorkflow(): ChangeWorkflow {
    if (!this.#workflow) {
      throw new Error('Connect Google first');
    }
    return this.#workflow;
  }

  async #executeGatewayMutation<T extends Record<string, unknown>>(
    operation: string,
    input: T,
    execute: (arguments_: T) => Promise<unknown>
  ) {
    return this.#outcome(
      await this.#requiredWorkflow().execute({
        operation,
        arguments: input,
        execute: (arguments_, context) =>
          this.#withGatewayExecutionPolicy(context, true, () => execute(arguments_ as T)),
      })
    );
  }

  #outcome(outcome: ChangeWorkflowOutcome): unknown {
    if (outcome.kind === 'proposal') {
      return outcome.proposal;
    }
    if (outcome.data && typeof outcome.data === 'object' && !Array.isArray(outcome.data)) {
      return {
        ...(outcome.data as Record<string, unknown>),
        verificationState: outcome.verificationState,
        ...(outcome.verificationError ? { verificationError: outcome.verificationError } : {}),
      };
    }
    return outcome;
  }

  #withGatewayExecutionPolicy<T>(
    context: { approval: 'direct' | 'reviewed' },
    directIdempotent: boolean,
    execute: () => Promise<T>
  ): Promise<T> {
    return runWithGoogleSheetsGateway(
      this.#requiredClient(),
      { idempotent: context.approval === 'direct' && directIdempotent },
      execute
    );
  }
}
