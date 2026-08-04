import { OAuthTokenSet } from '../auth/credential-vault.js';
import { CellValue, IndexedTable } from '../domain/types.js';
import { DriveFileMetadata } from '../drive/catalog.js';
import { parseSheetValues } from '../indexing/sheet-parser.js';
import { ProposalGateway, SheetChangeProposal } from '../proposals/proposal-manager.js';
import { SheetsReadGateway } from '../sync/sync-service.js';

type TokenSaver = (tokens: OAuthTokenSet) => Promise<void>;

interface DriveListResponse {
  files?: DriveFileMetadata[];
  nextPageToken?: string;
}

interface SheetProperties {
  sheetId?: number;
  title?: string;
}

interface GridRange {
  startRowIndex?: number;
  endRowIndex?: number;
  startColumnIndex?: number;
  endColumnIndex?: number;
}

interface NativeTable {
  tableId?: string;
  name?: string;
  range?: GridRange;
  columnProperties?: Array<{ columnName?: string }>;
}

interface SpreadsheetMetadata {
  sheets?: Array<{ properties?: SheetProperties; tables?: NativeTable[] }>;
}

interface ValuesResponse {
  values?: unknown[][];
  updatedRange?: string;
  updates?: { updatedRange?: string };
}

function quoteSheetTitle(title: string): string {
  return `'${title.replaceAll("'", "''")}'`;
}

function columnName(index: number): string {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function formatTable(table: NativeTable, sheetTitle: string): IndexedTable {
  const range = table.range;
  const hasRange =
    range?.startRowIndex !== undefined &&
    range.endRowIndex !== undefined &&
    range.startColumnIndex !== undefined &&
    range.endColumnIndex !== undefined;
  return {
    tableId: table.tableId ?? null,
    name: table.name ?? null,
    range: hasRange
      ? `${sheetTitle}!${columnName(range.startColumnIndex ?? 0)}${(range.startRowIndex ?? 0) + 1}:${columnName((range.endColumnIndex ?? 1) - 1)}${range.endRowIndex ?? 1}`
      : null,
    columns: (table.columnProperties ?? []).flatMap((column) =>
      column.columnName ? [column.columnName] : []
    ),
  };
}

export class GoogleApiClient implements SheetsReadGateway, ProposalGateway {
  #tokens: OAuthTokenSet;

  constructor(
    tokens: OAuthTokenSet,
    private readonly clientId: string,
    private readonly saveTokens: TokenSaver,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    this.#tokens = tokens;
  }

  async listFileGraph(): Promise<DriveFileMetadata[]> {
    const files: DriveFileMetadata[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('corpora', 'user');
      url.searchParams.set('spaces', 'drive');
      url.searchParams.set('q', 'trashed = false');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set(
        'fields',
        'nextPageToken,files(id,name,mimeType,parents,modifiedTime,version,driveId)'
      );
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }
      const page = await this.#json<DriveListResponse>(url);
      files.push(
        ...(page.files ?? [])
          .filter((file) => !file.driveId)
          .map((file) => ({ ...file, parents: file.parents ?? [] }))
      );
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async readSpreadsheet(spreadsheetId: string): Promise<{
    sheets: Array<{ sheetId: number; title: string; values: unknown[][]; tables: IndexedTable[] }>;
  }> {
    const metadata = await this.#json<SpreadsheetMetadata>(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title),tables(tableId,name,range,columnProperties))`
    );
    const sheets = [];
    for (const entry of metadata.sheets ?? []) {
      const sheetId = entry.properties?.sheetId;
      const title = entry.properties?.title;
      if (sheetId === undefined || !title) {
        continue;
      }
      const range = encodeURIComponent(quoteSheetTitle(title));
      const response = await this.#json<ValuesResponse>(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}`
      );
      sheets.push({
        sheetId,
        title,
        values: response.values ?? [],
        tables: (entry.tables ?? []).map((table) => formatTable(table, title)),
      });
    }
    return { sheets };
  }

  async getRevision(spreadsheetId: string): Promise<string> {
    const response = await this.#json<{ version?: string }>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=version`
    );
    if (!response.version) {
      throw new Error('Google Drive did not return a file revision');
    }
    return response.version;
  }

  async readRow(proposal: SheetChangeProposal): Promise<Record<string, CellValue>> {
    if (!proposal.rowNumber) {
      throw new Error('An update proposal requires a row number');
    }
    const sheet = await this.#findSheet(proposal);
    const parsed = parseSheetValues(sheet.values);
    const row = parsed.rows.find((candidate) => candidate.rowNumber === proposal.rowNumber);
    if (!row) {
      throw new Error(`Row ${proposal.rowNumber} no longer exists`);
    }
    const keys = Object.keys(proposal.expectedValues ?? row.values);
    return Object.fromEntries(keys.map((key) => [key, row.values[key] ?? null]));
  }

  async apply(proposal: SheetChangeProposal): Promise<{ updatedRange: string; verified: boolean }> {
    const sheet = await this.#findSheet(proposal);
    const parsed = parseSheetValues(sheet.values);
    const unknown = Object.keys(proposal.values).filter(
      (header) => !parsed.headers.includes(header)
    );
    if (unknown.length > 0) {
      throw new Error(`Unknown columns: ${unknown.join(', ')}`);
    }

    let rowValues: Record<string, CellValue>;
    let method: 'POST' | 'PUT';
    let url: URL;
    if (proposal.operation === 'append') {
      rowValues = proposal.values;
      method = 'POST';
      url = new URL(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(proposal.spreadsheetId)}/values/${encodeURIComponent(quoteSheetTitle(proposal.sheetTitle))}:append`
      );
      url.searchParams.set('insertDataOption', 'INSERT_ROWS');
    } else {
      const existing = parsed.rows.find((row) => row.rowNumber === proposal.rowNumber);
      if (!existing || !proposal.rowNumber) {
        throw new Error('The target row no longer exists');
      }
      rowValues = { ...existing.values, ...proposal.values };
      method = 'PUT';
      const range = `${quoteSheetTitle(proposal.sheetTitle)}!A${proposal.rowNumber}:${this.#columnName(parsed.headers.length - 1)}${proposal.rowNumber}`;
      url = new URL(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(proposal.spreadsheetId)}/values/${encodeURIComponent(range)}`
      );
    }
    url.searchParams.set('valueInputOption', 'RAW');
    const response = await this.#json<ValuesResponse>(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [parsed.headers.map((header) => rowValues[header] ?? null)] }),
    });
    const updatedRange = response.updatedRange ?? response.updates?.updatedRange;
    if (!updatedRange) {
      throw new Error('Google Sheets did not confirm the updated range');
    }
    const writtenRow = proposal.rowNumber ?? this.#lastRowNumber(updatedRange);
    const verifiedValues = await this.readRow({
      ...proposal,
      operation: 'update',
      rowNumber: writtenRow,
      expectedValues: proposal.values,
    });
    if (JSON.stringify(verifiedValues) !== JSON.stringify(proposal.values)) {
      return { updatedRange, verified: false };
    }
    return { updatedRange, verified: true };
  }

  async #findSheet(proposal: Pick<SheetChangeProposal, 'spreadsheetId' | 'sheetId'>) {
    const spreadsheet = await this.readSpreadsheet(proposal.spreadsheetId);
    const sheet = spreadsheet.sheets.find((entry) => entry.sheetId === proposal.sheetId);
    if (!sheet) {
      throw new Error(`Sheet ${proposal.sheetId} no longer exists`);
    }
    return sheet;
  }

  async #json<T>(input: string | URL, init: RequestInit = {}): Promise<T> {
    await this.#refreshIfNeeded();
    const response = await this.fetcher(input, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.#tokens.accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Google API request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async #refreshIfNeeded(): Promise<void> {
    if (this.#tokens.expiryDate > this.now() + 60_000) {
      return;
    }
    const response = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        refresh_token: this.#tokens.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!response.ok) {
      throw new Error(`Google OAuth refresh failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (!body.access_token || !body.expires_in) {
      throw new Error('Google OAuth refresh returned an invalid token');
    }
    this.#tokens = {
      ...this.#tokens,
      accessToken: body.access_token,
      expiryDate: this.now() + body.expires_in * 1000,
      scope: body.scope ?? this.#tokens.scope,
      tokenType: body.token_type ?? this.#tokens.tokenType,
    };
    await this.saveTokens(this.#tokens);
  }

  #columnName(index: number): string {
    let value = index + 1;
    let result = '';
    while (value > 0) {
      value -= 1;
      result = String.fromCharCode(65 + (value % 26)) + result;
      value = Math.floor(value / 26);
    }
    return result;
  }

  #lastRowNumber(range: string): number {
    const match = /(?:^|!)[A-Z]+(\d+)(?::[A-Z]+(\d+))?$/iu.exec(range);
    const row = Number(match?.[2] ?? match?.[1]);
    if (!Number.isInteger(row) || row < 2) {
      throw new Error(`Google Sheets returned an invalid updated range: ${range}`);
    }
    return row;
  }
}
