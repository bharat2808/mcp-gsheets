import { join } from 'node:path';

import { CredentialVault, OAuthTokenSet } from '../auth/credential-vault.js';
import { KeyringBackend } from '../auth/keyring-backend.js';
import { OAuthSetupServer } from '../auth/setup-server.js';
import { dataDirectory, googleClientId } from '../config/runtime.js';
import { CellValue } from '../domain/types.js';
import { buildCatalogTree } from '../drive/catalog.js';
import { GoogleApiClient } from '../google/google-api-client.js';
import { findDuplicateRow } from '../indexing/rows.js';
import {
  ProposalManager,
  SheetChangeProposal,
  SheetChangeOperation,
} from '../proposals/proposal-manager.js';
import { LocalIndex } from '../storage/local-index.js';
import { RefreshResult, SyncService } from '../sync/sync-service.js';

export interface PrepareChangeInput {
  spreadsheetId: string;
  sheetId: number;
  operation: SheetChangeOperation;
  rowNumber?: number;
  values: Record<string, CellValue>;
}

export class GSheetsRuntime {
  readonly #vault = new CredentialVault(new KeyringBackend());
  #index: LocalIndex | null = null;
  #client: GoogleApiClient | null = null;
  #sync: SyncService | null = null;
  #proposals: ProposalManager | null = null;
  #setup: OAuthSetupServer | null = null;
  #setupUrl: string | null = null;
  #poller: NodeJS.Timeout | null = null;
  #lastRefresh: RefreshResult | null = null;
  #lastError: string | null = null;
  #refreshPromise: Promise<RefreshResult> | null = null;

  async initialize(): Promise<void> {
    const key = await this.#vault.getOrCreateDataKey();
    this.#index = new LocalIndex(join(dataDirectory(), 'index.sqlite'), key);
    this.#index.initialize();
    const clientId = googleClientId();
    if (!clientId) {
      this.#lastError =
        'This build is missing the publisher Google OAuth desktop client ID. Set GSHEETS_GOOGLE_CLIENT_ID for development.';
      return;
    }
    this.#setup = new OAuthSetupServer({
      clientId,
      vault: this.#vault,
      getSelectedFolderIds: () => this.#requiredIndex().getSelectedFolderIds(),
      setSelectedFolderIds: (ids) => this.#requiredIndex().setSelectedFolderIds(ids),
      onConnected: (tokens) => this.#connect(tokens),
    });
    this.#setupUrl = await this.#setup.start();
    const tokens = await this.#vault.loadTokens();
    if (tokens) {
      await this.#connect(tokens);
    }
  }

  status() {
    return {
      connected: Boolean(this.#client),
      setupUrl: this.#setupUrl,
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
    if (this.#poller) {
      clearInterval(this.#poller);
    }
    this.#setup?.stop();
    this.#index?.close();
  }

  async #connect(tokens: OAuthTokenSet): Promise<void> {
    const clientId = googleClientId();
    this.#client = new GoogleApiClient(tokens, clientId, (next) => this.#vault.saveTokens(next));
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

  #requiredIndex(): LocalIndex {
    if (!this.#index) {
      throw new Error('GSheets runtime is not initialized');
    }
    return this.#index;
  }

  #requiredClient(): GoogleApiClient {
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
