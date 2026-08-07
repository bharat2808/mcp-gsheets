import { OAuthTokenSet } from '../auth/credential-vault.js';
import { google } from 'googleapis';
import { CellValue, IndexedTable } from '../domain/types.js';
import { DriveFileMetadata } from '../drive/catalog.js';
import { parseSheetValues } from '../indexing/sheet-parser.js';
import { OperationPreflight } from '../operations/change-workflow.js';
import { extractOperationResources, spreadsheetResourceIds } from '../operations/resources.js';
import { RowChangeRequest } from '../proposals/proposal-manager.js';
import { SheetsReadGateway } from '../sync/sync-service.js';
import { extractSheetName, parseRange } from '../utils/range-helpers.js';
import { currentGoogleSheetsGatewayPolicy } from '../utils/google-auth.js';

type TokenSaver = (tokens: OAuthTokenSet) => Promise<void>;

export interface GoogleSheetsGatewayPolicy {
  idempotent: boolean;
}

interface GoogleSheetsGatewayOptions {
  sheetsClient?: unknown;
  sleep?: (milliseconds: number) => Promise<void>;
  getSelectedFolderIds?: () => readonly string[];
  isCreatedSpreadsheet?: (spreadsheetId: string) => boolean;
  registerCreatedSpreadsheet?: (spreadsheetId: string) => void | Promise<void>;
  authorizeSpreadsheet?: (spreadsheetId: string) => Promise<void>;
}

export class GoogleSheetsGatewayError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'GoogleSheetsGatewayError';
  }
}

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
  responses?: Array<{ updatedRange?: string }>;
}

export interface CreateSpreadsheetGatewayInput {
  title: string;
  folderId?: string;
  sheets?: Array<{ title?: string; rowCount?: number; columnCount?: number }>;
}

export interface InsertColumnsGatewayInput {
  spreadsheetId: string;
  range: string;
  columns?: number;
  position?: 'BEFORE' | 'AFTER';
  inheritFromBefore?: boolean;
  values?: unknown[][];
  valueInputOption?: 'RAW' | 'USER_ENTERED';
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

function incrementColumn(column: string, offset: number): string {
  let value = 0;
  for (const character of column.toUpperCase()) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  value += offset;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function expandValueRange(range: string, values: unknown[][]): string {
  if (range.includes(':') || values.length === 0) {
    return range;
  }
  const match = /^(.*!)?([A-Z]+)(\d+)$/iu.exec(range);
  if (!match?.[2] || !match[3]) {
    return range;
  }
  const width = Math.max(1, ...values.map((row) => row.length));
  const endColumn = incrementColumn(match[2], width - 1);
  const endRow = Number(match[3]) + values.length - 1;
  return `${match[1] ?? ''}${match[2]}${match[3]}:${endColumn}${endRow}`;
}

function operationRanges(operation: string, arguments_: Record<string, unknown>): string[] {
  if (operation === 'batch_update_values') {
    return Array.isArray(arguments_.data)
      ? arguments_.data.flatMap((entry) => {
          const item = entry as { range?: unknown; values?: unknown };
          return typeof item.range === 'string' && Array.isArray(item.values)
            ? [expandValueRange(item.range, item.values as unknown[][])]
            : [];
        })
      : [];
  }
  if (operation === 'batch_format_cells') {
    return Array.isArray(arguments_.formatRequests)
      ? arguments_.formatRequests.flatMap((entry) => {
          const range = (entry as { range?: unknown }).range;
          return typeof range === 'string' ? [range] : [];
        })
      : [];
  }
  if (operation === 'add_conditional_formatting') {
    return Array.isArray(arguments_.rules)
      ? arguments_.rules.flatMap((entry) => {
          const ranges = (entry as { ranges?: unknown }).ranges;
          return Array.isArray(ranges)
            ? ranges.filter((range): range is string => typeof range === 'string')
            : [];
        })
      : [];
  }
  if (typeof arguments_.range !== 'string') {
    return [];
  }
  return operation === 'update_values' && Array.isArray(arguments_.values)
    ? [expandValueRange(arguments_.range, arguments_.values as unknown[][])]
    : [arguments_.range];
}

function anyPopulated(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(anyPopulated);
  }
  return value !== null && value !== undefined && value !== '';
}

function normalizedValues(values: unknown): unknown[][] {
  if (!Array.isArray(values)) {
    return [];
  }
  const rows = values.map((row) => {
    const cells = Array.isArray(row) ? [...row] : [row];
    while (cells.length > 0 && !anyPopulated(cells.at(-1))) {
      cells.pop();
    }
    return cells.map((cell) => (cell === null || cell === undefined ? '' : cell));
  });
  while (rows.length > 0 && rows.at(-1)?.length === 0) {
    rows.pop();
  }
  return rows;
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length >= expected.length &&
      expected.every((value, index) => partialMatch(actual[index], value))
    );
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') {
      return false;
    }
    return Object.entries(expected).every(([key, value]) =>
      partialMatch((actual as Record<string, unknown>)[key], value)
    );
  }
  return Object.is(actual ?? null, expected ?? null);
}

function toolResponseText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return '';
  }
  const content = (result as { content?: Array<{ text?: unknown }> }).content ?? [];
  return content
    .flatMap((entry) => (typeof entry.text === 'string' ? [entry.text] : []))
    .join('\n');
}

function toolResponseData(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const structured = (result as { structuredContent?: { data?: unknown } }).structuredContent?.data;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  const text = toolResponseText(result);
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.slice(start));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function metadataSheets(metadata: unknown): any[] {
  return (metadata as { sheets?: any[] } | undefined)?.sheets ?? [];
}

function metadataCells(metadata: unknown): any[] {
  return metadataSheets(metadata).flatMap((sheet) =>
    (sheet.data ?? []).flatMap((data: any) =>
      (Array.isArray(data.rowData) ? data.rowData : data.rowData ? [data.rowData] : []).flatMap(
        (row: any) => row.values ?? []
      )
    )
  );
}

function metadataCharts(metadata: unknown): any[] {
  return metadataSheets(metadata).flatMap((sheet) => sheet.charts ?? []);
}

function metadataTables(metadata: unknown): any[] {
  return metadataSheets(metadata).flatMap((sheet) => sheet.tables ?? []);
}

function sheetForArguments(metadata: unknown, arguments_: Record<string, unknown>): any {
  const sheets = metadataSheets(metadata);
  if (typeof arguments_.sheetId === 'number') {
    return sheets.find((sheet) => sheet.properties?.sheetId === arguments_.sheetId);
  }
  if (typeof arguments_.range === 'string') {
    const { sheetName } = extractSheetName(arguments_.range);
    if (sheetName) {
      return sheets.find((sheet) => sheet.properties?.title === sheetName);
    }
  }
  return sheets[0];
}

function exactGridRange(metadata: unknown, a1Range: string): unknown {
  const { sheetName, range } = extractSheetName(a1Range);
  const sheet = sheetName
    ? metadataSheets(metadata).find((candidate) => candidate.properties?.title === sheetName)
    : metadataSheets(metadata)[0];
  const sheetId = sheet?.properties?.sheetId;
  if (typeof sheetId !== 'number') {
    return null;
  }
  return parseRange(range, sheetId);
}

function rangeSize(value: string, dimension: 'ROWS' | 'COLUMNS'): number | null {
  const { range } = extractSheetName(value);
  const match =
    dimension === 'ROWS' ? /^(\d+):(\d+)$/u.exec(range) : /^([A-Z]+):([A-Z]+)$/iu.exec(range);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  if (dimension === 'ROWS') {
    return Number(match[2]) - Number(match[1]) + 1;
  }
  const toIndex = (column: string) =>
    [...column.toUpperCase()].reduce(
      (total, character) => total * 26 + character.charCodeAt(0) - 64,
      0
    );
  return toIndex(match[2]) - toIndex(match[1]) + 1;
}

function appendPreflightEvidence(
  valueRange: { range: string; values: unknown[][] } | undefined
): { range: string; headers: unknown[]; tail: unknown[][]; lastRowNumber: number } | null {
  if (!valueRange) {
    return null;
  }
  const { range } = extractSheetName(valueRange.range);
  const firstRow = /[A-Z]+(\d+)/iu.exec(range)?.[1];
  const startRow = firstRow ? Number(firstRow) : 1;
  return {
    range: valueRange.range,
    headers: valueRange.values[0] ?? [],
    tail: valueRange.values.slice(-3),
    lastRowNumber: Math.max(startRow - 1, startRow + valueRange.values.length - 1),
  };
}

const METADATA_STATE_OPERATIONS = new Set([
  'insert_sheet',
  'duplicate_sheet',
  'delete_sheet',
  'batch_delete_sheets',
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'merge_cells',
  'unmerge_cells',
  'update_sheet_properties',
  'format_cells',
  'batch_format_cells',
  'update_borders',
  'add_conditional_formatting',
  'set_data_validation',
  'clear_data_validation',
  'set_basic_filter',
  'clear_basic_filter',
  'create_chart',
  'update_chart',
  'delete_chart',
  'add_table',
  'update_table',
  'delete_table',
]);

export class GoogleSheetsGateway implements SheetsReadGateway {
  #tokens: OAuthTokenSet;
  readonly #oauthClient: InstanceType<typeof google.auth.OAuth2>;
  readonly #sheetsClient: unknown;

  constructor(
    tokens: OAuthTokenSet,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly saveTokens: TokenSaver,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly options: GoogleSheetsGatewayOptions = {}
  ) {
    this.#tokens = tokens;
    this.#oauthClient = new google.auth.OAuth2(clientId, clientSecret);
    this.#oauthClient.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiryDate,
      scope: tokens.scope,
      token_type: tokens.tokenType,
    });
    this.#sheetsClient =
      options.sheetsClient ?? google.sheets({ version: 'v4', auth: this.#oauthClient });
  }

  getSheetsClient(policy: GoogleSheetsGatewayPolicy): any {
    const enforced = currentGoogleSheetsGatewayPolicy(this);
    return this.#wrapApi(this.#sheetsClient, {
      idempotent: policy.idempotent && enforced?.idempotent !== false,
    });
  }

  #wrapApi(value: unknown, policy: GoogleSheetsGatewayPolicy): any {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return value;
    }
    // googleapis exposes the top-level `spreadsheets` resource as a
    // non-configurable, read-only data property. A Proxy cannot return a
    // wrapped value for that property without violating the ECMAScript Proxy
    // invariants, so materialize a configurable facade for such objects first.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.values(descriptors).some(
        (descriptor) =>
          descriptor.configurable === false &&
          'value' in descriptor &&
          descriptor.writable === false
      )
    ) {
      const facade = Object.create(Object.getPrototypeOf(value));
      for (const property of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (!descriptor) {
          continue;
        }
        if ('value' in descriptor) {
          Object.defineProperty(facade, property, {
            ...descriptor,
            configurable: true,
            writable: true,
            value: this.#wrapApi(descriptor.value, policy),
          });
        } else {
          Object.defineProperty(facade, property, {
            ...descriptor,
            configurable: true,
            get: () => this.#wrapApi(Reflect.get(value, property), policy),
          });
        }
      }
      return facade;
    }
    return new Proxy(value, {
      get: (target, property) => {
        const member = Reflect.get(target, property);
        if (typeof member === 'function') {
          return async (...args: unknown[]) => {
            for (const spreadsheetId of this.#spreadsheetIds(args[0])) {
              await this.authorizeSpreadsheet(spreadsheetId);
            }
            const requestArgs = [...args];
            const options = requestArgs[1];
            requestArgs[1] =
              options && typeof options === 'object'
                ? { ...(options as Record<string, unknown>), retry: false }
                : { retry: false };
            return this.#request(
              () => Promise.resolve(Reflect.apply(member, target, requestArgs)),
              policy.idempotent
            );
          };
        }
        return this.#wrapApi(member, policy);
      },
    });
  }

  #spreadsheetIds(value: unknown): string[] {
    const ids = new Set<string>();
    const visit = (candidate: unknown): void => {
      if (!candidate || typeof candidate !== 'object') {
        return;
      }
      for (const [key, nested] of Object.entries(candidate)) {
        if (/spreadsheetid$/iu.test(key) && typeof nested === 'string') {
          ids.add(nested);
        } else {
          visit(nested);
        }
      }
    };
    visit(value);
    return [...ids];
  }

  async #request<T>(operation: () => Promise<T>, idempotent: boolean): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#refreshIfNeeded();
        return await operation();
      } catch (error) {
        const status = this.#status(error);
        if (
          !idempotent ||
          !status ||
          ![429, 500, 502, 503, 504].includes(status) ||
          attempt === 2
        ) {
          throw this.#normalize(error, status);
        }
        await (
          this.options.sleep ??
          ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
        )(250 * 2 ** attempt);
      }
    }
    throw new Error('Google API retry loop exhausted');
  }

  #status(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') {
      return undefined;
    }
    const candidate = error as { code?: unknown; response?: { status?: unknown } };
    const status = candidate.response?.status ?? candidate.code;
    return typeof status === 'number' ? status : undefined;
  }

  #normalize(error: unknown, code = this.#status(error)): GoogleSheetsGatewayError {
    if (error instanceof GoogleSheetsGatewayError) {
      return error;
    }
    const candidate = error as {
      message?: unknown;
      response?: { data?: { error?: { message?: unknown } } };
    };
    const providerMessage = candidate.response?.data?.error?.message;
    const message =
      typeof providerMessage === 'string'
        ? providerMessage
        : typeof candidate.message === 'string'
          ? candidate.message
          : 'Google API request failed';
    return new GoogleSheetsGatewayError(message, code, candidate.response?.data);
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
        'nextPageToken,files(id,name,mimeType,parents,modifiedTime,version,driveId,ownedByMe)'
      );
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }
      const page = await this.#json<DriveListResponse>(url);
      files.push(
        ...(page.files ?? [])
          .filter((file) => !file.driveId)
          .map((file) => ({
            ...file,
            parents: file.parents ?? [],
            ...(file.version !== undefined ? { version: String(file.version) } : {}),
          }))
      );
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async listSelectableMyDriveFolders(): Promise<DriveFileMetadata[]> {
    const [files, root] = await Promise.all([this.listFileGraph(), this.#rootFolder()]);
    const folders = new Map(
      files
        .filter(
          (file) =>
            file.mimeType === 'application/vnd.google-apps.folder' &&
            file.ownedByMe === true &&
            !file.driveId
        )
        .map((file) => [file.id, file])
    );
    const reachesRoot = (folder: DriveFileMetadata): boolean => {
      const pending = [...folder.parents];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const parentId = pending.shift();
        if (!parentId || visited.has(parentId)) {
          continue;
        }
        if (parentId === root.id) {
          return true;
        }
        visited.add(parentId);
        const parent = folders.get(parentId);
        if (parent) {
          pending.push(...parent.parents);
        }
      }
      return false;
    };
    return [...folders.values()].filter(reachesRoot);
  }

  async getAccountIdentity(): Promise<string> {
    const response = await this.#json<{ user?: { permissionId?: string } }>(
      'https://www.googleapis.com/drive/v3/about?fields=user%28permissionId%29'
    );
    const identity = response.user?.permissionId;
    if (!identity) {
      throw new Error('Google Drive did not return the authenticated account identity');
    }
    return identity;
  }

  async validateSelectedMyDriveFolder(
    folderId: string,
    selectedFolderIds: readonly string[]
  ): Promise<DriveFileMetadata> {
    if (!selectedFolderIds.includes(folderId)) {
      throw new Error(`Folder ${folderId} is not one of the selected My Drive folders`);
    }
    return this.validateMyDriveFolder(folderId);
  }

  async validateMyDriveFolder(folderId: string): Promise<DriveFileMetadata> {
    const folder = await this.#json<DriveFileMetadata & { trashed?: boolean }>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id%2Cname%2CmimeType%2Cparents%2CdriveId%2CownedByMe%2Ctrashed`
    );
    if (folder.driveId) {
      throw new Error('Shared Drive folders are not supported');
    }
    if (folder.mimeType !== 'application/vnd.google-apps.folder' || folder.trashed) {
      throw new Error(`Folder ${folderId} is not an accessible My Drive folder`);
    }
    if (folder.ownedByMe !== true) {
      throw new Error(`Folder ${folderId} is not owned by the authenticated account`);
    }
    const root = await this.#rootFolder();
    if (!(await this.#ancestryReachesRoot(folder.parents ?? [], root.id))) {
      throw new Error(`Folder ${folderId} is not inside the authenticated My Drive`);
    }
    return { ...folder, parents: folder.parents ?? [] };
  }

  async authorizeSpreadsheet(spreadsheetId: string): Promise<void> {
    if (this.options.authorizeSpreadsheet) {
      await this.options.authorizeSpreadsheet(spreadsheetId);
      return;
    }
    if (this.options.isCreatedSpreadsheet?.(spreadsheetId)) {
      return;
    }
    const selectedFolderIds = this.options.getSelectedFolderIds?.() ?? [];
    if (selectedFolderIds.length === 0) {
      throw new Error('No My Drive folders are selected');
    }
    const spreadsheet = await this.#driveFile(spreadsheetId);
    if (spreadsheet.driveId) {
      throw new Error('Shared Drive spreadsheets are not supported');
    }
    if (spreadsheet.ownedByMe !== true) {
      throw new Error(`Spreadsheet ${spreadsheetId} is not owned by the authenticated account`);
    }
    if (spreadsheet.mimeType !== 'application/vnd.google-apps.spreadsheet') {
      throw new Error(`File ${spreadsheetId} is not a Google Sheets spreadsheet`);
    }
    const root = await this.#rootFolder();
    if (!(await this.#ancestryReachesSelection(spreadsheet.parents, selectedFolderIds, root.id))) {
      throw new Error(`Spreadsheet ${spreadsheetId} is not inside a selected My Drive folder`);
    }
  }

  async createSpreadsheet(
    input: CreateSpreadsheetGatewayInput,
    selectedFolderIds: readonly string[]
  ): Promise<{
    spreadsheetId: string;
    spreadsheetUrl?: string;
    title: string;
    folderId?: string;
    partialCreation?: true;
    placement?: { status: 'unverified'; error: string };
  }> {
    if (input.folderId) {
      await this.validateSelectedMyDriveFolder(input.folderId, selectedFolderIds);
    }
    const requestBody: Record<string, unknown> = { properties: { title: input.title } };
    if (input.sheets?.length) {
      requestBody.sheets = input.sheets.map((sheet, index) => ({
        properties: {
          title: sheet.title || `Sheet${index + 1}`,
          gridProperties: {
            rowCount: sheet.rowCount ?? 1000,
            columnCount: sheet.columnCount ?? 26,
          },
        },
      }));
    }
    const created = await this.#json<{
      spreadsheetId?: string;
      spreadsheetUrl?: string;
      properties?: { title?: string };
    }>('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (!created.spreadsheetId) {
      throw new Error('Google Sheets did not return the created spreadsheet ID');
    }
    await this.options.registerCreatedSpreadsheet?.(created.spreadsheetId);
    if (input.folderId) {
      try {
        await this.#moveSpreadsheetToFolder(created.spreadsheetId, input.folderId);
      } catch (error) {
        return {
          spreadsheetId: created.spreadsheetId,
          ...(created.spreadsheetUrl ? { spreadsheetUrl: created.spreadsheetUrl } : {}),
          title: created.properties?.title ?? input.title,
          folderId: input.folderId,
          partialCreation: true,
          placement: {
            status: 'unverified',
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    return {
      spreadsheetId: created.spreadsheetId,
      ...(created.spreadsheetUrl ? { spreadsheetUrl: created.spreadsheetUrl } : {}),
      title: created.properties?.title ?? input.title,
      ...(input.folderId ? { folderId: input.folderId } : {}),
    };
  }

  async moveSpreadsheet(
    spreadsheetId: string,
    folderId: string,
    selectedFolderIds: readonly string[],
    allowOutsideSelection = false
  ): Promise<{ spreadsheetId: string; folderId: string; verified: true }> {
    await this.authorizeSpreadsheet(spreadsheetId);
    if (allowOutsideSelection) {
      await this.validateMyDriveFolder(folderId);
    } else {
      await this.validateSelectedMyDriveFolder(folderId, selectedFolderIds);
    }
    await this.#moveSpreadsheetToFolder(spreadsheetId, folderId);
    return { spreadsheetId, folderId, verified: true };
  }

  async insertColumns(input: InsertColumnsGatewayInput): Promise<{
    spreadsheetId: string;
    insertedColumns: number;
    updatedRange?: string;
  }> {
    const columns = input.columns ?? 1;
    if (!Number.isInteger(columns) || columns < 1) {
      throw new Error('columns must be a positive integer');
    }
    const valueWidth = input.values?.length
      ? Math.max(...input.values.map((row) => row.length))
      : 0;
    if (valueWidth > columns) {
      throw new Error('values contain more columns than were inserted');
    }
    if (input.values?.length && valueWidth === 0) {
      throw new Error('values rows must not all be empty');
    }
    const parts = input.range.split('!');
    const sheetName = parts.length > 1 ? parts[0]?.replace(/^['"]|['"]$/gu, '') : undefined;
    const anchor = parts.length > 1 ? parts[1] : parts[0];
    const match = /^([A-Z]+)(\d+)$/iu.exec(anchor ?? '');
    if (!match?.[1] || !match[2]) {
      throw new Error('Column insertion range must be an anchor cell such as Sheet1!B2');
    }
    const sheets = this.getSheetsClient({ idempotent: false });
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId: input.spreadsheetId,
      fields: 'sheets.properties',
    });
    const entries = metadata.data.sheets ?? [];
    const sheet = sheetName
      ? entries.find((entry: any) => entry.properties?.title === sheetName)
      : entries[0];
    const sheetId = sheet?.properties?.sheetId;
    const resolvedTitle = sheet?.properties?.title;
    if (sheetId === undefined || !resolvedTitle) {
      throw new Error(
        sheetName ? `Sheet "${sheetName}" not found` : 'No sheets found in spreadsheet'
      );
    }
    const anchorColumn = this.#columnIndex(match[1].toUpperCase());
    const startIndex = (input.position ?? 'BEFORE') === 'AFTER' ? anchorColumn + 1 : anchorColumn;
    const startRow = Number(match[2]);
    const updatedRange = input.values?.length
      ? `${quoteSheetTitle(resolvedTitle)}!${columnName(startIndex)}${startRow}:${columnName(startIndex + valueWidth - 1)}${startRow + input.values.length - 1}`
      : undefined;
    const requests: Array<Record<string, unknown>> = [
      {
        insertDimension: {
          range: {
            sheetId,
            dimension: 'COLUMNS',
            startIndex,
            endIndex: startIndex + columns,
          },
          inheritFromBefore: input.inheritFromBefore ?? false,
        },
      },
    ];
    if (input.values?.length) {
      const coordinate = { sheetId, rowIndex: startRow - 1, columnIndex: startIndex };
      if ((input.valueInputOption ?? 'USER_ENTERED') === 'USER_ENTERED') {
        requests.push({
          pasteData: {
            coordinate,
            data: this.#serializeCsv(input.values),
            type: 'PASTE_NORMAL',
            delimiter: ',',
          },
        });
      } else {
        requests.push({
          updateCells: {
            start: coordinate,
            rows: input.values.map((row) => ({
              values: row.map((value) => ({ ...this.#cellData(value) })),
            })),
            fields: 'userEnteredValue',
          },
        });
      }
    }
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: input.spreadsheetId,
      requestBody: { requests },
    });
    return {
      spreadsheetId: input.spreadsheetId,
      insertedColumns: columns,
      ...(updatedRange ? { updatedRange } : {}),
    };
  }

  async setDataValidation(input: {
    spreadsheetId: string;
    range: string;
    rule: Record<string, unknown>;
    filteredRowsIncluded?: boolean;
  }): Promise<{ spreadsheetId: string; range: string }> {
    const sheets = this.getSheetsClient({ idempotent: true });
    const range = await this.#resolveGridRange(sheets, input.spreadsheetId, input.range);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: input.spreadsheetId,
      requestBody: {
        requests: [
          {
            setDataValidation: {
              range,
              rule: input.rule,
              ...(input.filteredRowsIncluded !== undefined
                ? { filteredRowsIncluded: input.filteredRowsIncluded }
                : {}),
            },
          },
        ],
      },
    });
    return { spreadsheetId: input.spreadsheetId, range: input.range };
  }

  async clearDataValidation(input: {
    spreadsheetId: string;
    range: string;
  }): Promise<{ spreadsheetId: string; range: string }> {
    const sheets = this.getSheetsClient({ idempotent: false });
    const range = await this.#resolveGridRange(sheets, input.spreadsheetId, input.range);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: input.spreadsheetId,
      requestBody: { requests: [{ setDataValidation: { range } }] },
    });
    return { spreadsheetId: input.spreadsheetId, range: input.range };
  }

  async setBasicFilter(input: {
    spreadsheetId: string;
    range: string;
    sortSpecs?: unknown[];
    filterSpecs?: unknown[];
    criteria?: Record<string, unknown>;
  }): Promise<{ spreadsheetId: string; range: string }> {
    const sheets = this.getSheetsClient({ idempotent: true });
    const range = await this.#resolveGridRange(sheets, input.spreadsheetId, input.range);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: input.spreadsheetId,
      requestBody: {
        requests: [
          {
            setBasicFilter: {
              filter: {
                range,
                ...(input.sortSpecs ? { sortSpecs: input.sortSpecs } : {}),
                ...(input.filterSpecs ? { filterSpecs: input.filterSpecs } : {}),
                ...(input.criteria ? { criteria: input.criteria } : {}),
              },
            },
          },
        ],
      },
    });
    return { spreadsheetId: input.spreadsheetId, range: input.range };
  }

  async clearBasicFilter(input: {
    spreadsheetId: string;
    sheetId: number;
  }): Promise<{ spreadsheetId: string; sheetId: number }> {
    const sheets = this.getSheetsClient({ idempotent: false });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: input.spreadsheetId,
      requestBody: { requests: [{ clearBasicFilter: { sheetId: input.sheetId } }] },
    });
    return input;
  }

  async #resolveGridRange(sheets: any, spreadsheetId: string, a1Range: string) {
    const { sheetName } = extractSheetName(a1Range);
    const metadata = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties',
    });
    const entries = metadata.data.sheets ?? [];
    const sheet = sheetName
      ? entries.find((entry: any) => entry.properties?.title === sheetName)
      : entries[0];
    const sheetId = sheet?.properties?.sheetId;
    if (sheetId === undefined) {
      throw new Error(
        sheetName ? `Sheet "${sheetName}" not found` : 'No sheets found in spreadsheet'
      );
    }
    return parseRange(a1Range, sheetId);
  }

  #columnIndex(value: string): number {
    let result = 0;
    for (const character of value) {
      result = result * 26 + character.charCodeAt(0) - 64;
    }
    return result - 1;
  }

  #cellData(value: unknown) {
    if (value === null || value === undefined) {
      return {};
    }
    if (typeof value === 'boolean') {
      return { userEnteredValue: { boolValue: value } };
    }
    if (typeof value === 'number') {
      return { userEnteredValue: { numberValue: value } };
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return { userEnteredValue: { stringValue: text } };
  }

  #serializeCsv(values: readonly (readonly unknown[])[]): string {
    return values
      .map((row) =>
        row.map((value) => `"${this.#pasteText(value).replaceAll('"', '""')}"`).join(',')
      )
      .join('\r\n');
  }

  #pasteText(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE';
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`Unsupported USER_ENTERED cell value type: ${typeof value}`);
    }
    return serialized;
  }

  async #moveSpreadsheetToFolder(spreadsheetId: string, folderId: string): Promise<void> {
    const file = await this.#driveFile(spreadsheetId);
    if (file.driveId) {
      throw new Error('Shared Drive spreadsheets are not supported');
    }
    if (file.mimeType !== 'application/vnd.google-apps.spreadsheet') {
      throw new Error(`File ${spreadsheetId} is not a Google Sheets spreadsheet`);
    }
    const url = new URL(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}`
    );
    url.searchParams.set('addParents', folderId);
    const parentsToRemove = file.parents.filter((parent) => parent !== folderId);
    if (parentsToRemove.length) {
      url.searchParams.set('removeParents', parentsToRemove.join(','));
    }
    url.searchParams.set('fields', 'id,parents,driveId');
    await this.#json(url, { method: 'PATCH' }, false);
    const verified = await this.#driveFile(spreadsheetId);
    if (verified.driveId || !verified.parents.includes(folderId)) {
      throw new Error(`Google Drive did not verify placement in folder ${folderId}`);
    }
  }

  async #driveFile(fileId: string): Promise<DriveFileMetadata & { trashed?: boolean }> {
    const file = await this.#json<DriveFileMetadata & { trashed?: boolean }>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id%2Cname%2CmimeType%2Cparents%2CdriveId%2CownedByMe%2Ctrashed`
    );
    return { ...file, parents: file.parents ?? [] };
  }

  async #rootFolder(): Promise<DriveFileMetadata> {
    const root = await this.#driveFile('root');
    if (
      root.driveId ||
      root.ownedByMe !== true ||
      root.mimeType !== 'application/vnd.google-apps.folder'
    ) {
      throw new Error('Google Drive did not return the authenticated My Drive root');
    }
    return root;
  }

  async #ancestryReachesRoot(parentIds: readonly string[], rootId: string): Promise<boolean> {
    const pending = [...parentIds];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const parentId = pending.shift();
      if (!parentId || visited.has(parentId)) {
        continue;
      }
      if (parentId === rootId) {
        return true;
      }
      visited.add(parentId);
      const parent = await this.#driveFile(parentId);
      if (
        parent.driveId ||
        parent.ownedByMe !== true ||
        parent.mimeType !== 'application/vnd.google-apps.folder'
      ) {
        continue;
      }
      pending.push(...parent.parents);
    }
    return false;
  }

  async #ancestryReachesSelection(
    parentIds: readonly string[],
    selectedFolderIds: readonly string[],
    rootId: string
  ): Promise<boolean> {
    const selected = new Set(selectedFolderIds);
    const pending = parentIds.map((id) => ({ id, selectedReached: selected.has(id) }));
    const visited = new Set<string>();
    while (pending.length > 0) {
      const candidate = pending.shift();
      if (!candidate) {
        continue;
      }
      const visitKey = `${candidate.id}:${candidate.selectedReached}`;
      if (visited.has(visitKey)) {
        continue;
      }
      if (candidate.id === rootId) {
        return candidate.selectedReached;
      }
      visited.add(visitKey);
      const parent = await this.#driveFile(candidate.id);
      if (
        parent.driveId ||
        parent.ownedByMe !== true ||
        parent.mimeType !== 'application/vnd.google-apps.folder'
      ) {
        continue;
      }
      const selectedReached = candidate.selectedReached || selected.has(parent.id);
      pending.push(...parent.parents.map((id) => ({ id, selectedReached })));
    }
    return false;
  }

  async readSpreadsheet(spreadsheetId: string): Promise<{
    sheets: Array<{
      sheetId: number;
      title: string;
      values: unknown[][];
      rawValues: unknown[][];
      tables: IndexedTable[];
    }>;
  }> {
    await this.authorizeSpreadsheet(spreadsheetId);
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
      const rawResponse = await this.#json<ValuesResponse>(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
      );
      sheets.push({
        sheetId,
        title,
        values: response.values ?? [],
        rawValues: rawResponse.values ?? response.values ?? [],
        tables: (entry.tables ?? []).map((table) => formatTable(table, title)),
      });
    }
    return { sheets };
  }

  async getRevision(spreadsheetId: string): Promise<string> {
    await this.authorizeSpreadsheet(spreadsheetId);
    const response = await this.#json<{ version?: string }>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=version`
    );
    if (!response.version) {
      throw new Error('Google Drive did not return a file revision');
    }
    return String(response.version);
  }

  async getRevisions(spreadsheetIds: readonly string[]): Promise<Record<string, string>> {
    return Object.fromEntries(
      await Promise.all(
        [...new Set(spreadsheetIds)].map(async (id) => [id, await this.getRevision(id)] as const)
      )
    );
  }

  async readValueRanges(
    spreadsheetId: string,
    ranges: readonly string[]
  ): Promise<Array<{ range: string; values: unknown[][] }>> {
    if (ranges.length === 0) {
      return [];
    }
    const sheets = this.getSheetsClient({ idempotent: true });
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: [...ranges],
      valueRenderOption: 'FORMULA',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const returned = response.data.valueRanges ?? [];
    return ranges.map((range, index) => ({
      range,
      values: returned[index]?.values ?? [],
    }));
  }

  async inspectOperation(
    operation: string,
    arguments_: Record<string, unknown>,
    selectedFolderIds: readonly string[]
  ): Promise<OperationPreflight> {
    const spreadsheetId =
      typeof arguments_.spreadsheetId === 'string' ? arguments_.spreadsheetId : undefined;
    const ranges = operationRanges(operation, arguments_);
    const valueRanges = spreadsheetId ? await this.readValueRanges(spreadsheetId, ranges) : [];
    const resourceArguments =
      operation === 'update_values'
        ? { ...arguments_, range: ranges[0] ?? arguments_.range }
        : operation === 'batch_update_values' && Array.isArray(arguments_.data)
          ? {
              ...arguments_,
              data: arguments_.data.map((entry, index) => ({
                ...(entry as Record<string, unknown>),
                range: ranges[index] ?? (entry as { range?: unknown }).range,
              })),
            }
          : arguments_;
    const affectedResources = extractOperationResources(operation, resourceArguments);
    const driveRevisions = await this.getRevisions(spreadsheetResourceIds(affectedResources));

    let gridShrinks = false;
    let metadataState: unknown;
    if (METADATA_STATE_OPERATIONS.has(operation) && spreadsheetId) {
      metadataState = await this.#readVerificationMetadata(spreadsheetId, ranges);
    }
    const destinationMetadataState =
      operation === 'copy_to' && typeof arguments_.destinationSpreadsheetId === 'string'
        ? await this.#readVerificationMetadata(arguments_.destinationSpreadsheetId)
        : undefined;
    if (operation === 'update_sheet_properties' && spreadsheetId) {
      const metadata = metadataState as { sheets?: any[] } | undefined;
      const sheet = (metadata?.sheets ?? []).find(
        (entry: any) => entry.properties?.sheetId === arguments_.sheetId
      );
      const current = sheet?.properties?.gridProperties ?? {};
      const next = (arguments_.gridProperties ?? {}) as {
        rowCount?: number;
        columnCount?: number;
      };
      gridShrinks =
        (next.rowCount !== undefined && next.rowCount < (current.rowCount ?? 0)) ||
        (next.columnCount !== undefined && next.columnCount < (current.columnCount ?? 0));
    }
    if (operation === 'move_spreadsheet' && spreadsheetId) {
      metadataState = await this.#driveFile(spreadsheetId);
    }

    const valueOperation = [
      'update_values',
      'batch_update_values',
      'append_values',
      'prepare_row_change',
    ].includes(operation);
    const appendEvidence =
      operation === 'append_values' ? appendPreflightEvidence(valueRanges[0]) : null;
    let before: unknown = valueOperation
      ? operation === 'append_values'
        ? appendEvidence
        : operation === 'batch_update_values'
          ? valueRanges.map((entry) => ({ range: entry.range, values: entry.values }))
          : (valueRanges[0]?.values ?? null)
      : { ranges: valueRanges, metadata: metadataState ?? null };
    let after: unknown =
      operation === 'batch_update_values' ? arguments_.data : (arguments_.values ?? arguments_);
    if (operation === 'batch_delete_sheets') {
      const requestedIds = Array.isArray(arguments_.sheetIds)
        ? arguments_.sheetIds.filter((sheetId): sheetId is number => typeof sheetId === 'number')
        : [];
      const sheets = (metadataState as { sheets?: Array<{ properties?: any }> } | undefined)
        ?.sheets;
      const byId = new Map(
        (sheets ?? []).flatMap((sheet) => {
          const sheetId = sheet.properties?.sheetId;
          const title = sheet.properties?.title;
          return typeof sheetId === 'number' && typeof title === 'string'
            ? [[sheetId, { sheetId, title }] as const]
            : [];
        })
      );
      before = { worksheets: requestedIds.flatMap((sheetId) => byId.get(sheetId) ?? []) };
      after = { deletedSheetIds: requestedIds };
    }
    return {
      affectedResources,
      preview: { kind: valueOperation ? 'values' : 'exact', before, after },
      riskInspection: {
        targetCellsVerifiedEmpty:
          ranges.length > 0 && valueRanges.every((entry) => !anyPopulated(entry.values)),
        targetCellsPopulated: valueRanges.some((entry) => anyPopulated(entry.values)),
        gridShrinks,
        ...(operation === 'move_spreadsheet'
          ? {
              destinationSelected:
                typeof arguments_.folderId === 'string' &&
                selectedFolderIds.includes(arguments_.folderId),
            }
          : {}),
      },
      driveRevisions,
      state:
        operation === 'append_values'
          ? { appendEvidence, metadataState, destinationMetadataState, driveRevisions }
          : { valueRanges, metadataState, destinationMetadataState, driveRevisions },
    };
  }

  async captureOperationState(
    operation: string,
    arguments_: Record<string, unknown>,
    selectedFolderIds: readonly string[]
  ): Promise<unknown> {
    return (await this.inspectOperation(operation, arguments_, selectedFolderIds)).state;
  }

  async verifyOperation(
    operation: string,
    arguments_: Record<string, unknown>,
    result: unknown,
    preflight: OperationPreflight
  ): Promise<boolean> {
    if (operation === 'create_spreadsheet') {
      const createdSpreadsheetId =
        result && typeof result === 'object'
          ? (result as { spreadsheetId?: unknown }).spreadsheetId
          : undefined;
      if (typeof createdSpreadsheetId !== 'string') {
        return false;
      }
      const post = await this.#readVerificationMetadata(createdSpreadsheetId);
      const requestedSheets = Array.isArray(arguments_.sheets) ? arguments_.sheets : [];
      const sheetsMatch = requestedSheets.every((requested) => {
        const expected = requested as {
          title?: unknown;
          rowCount?: unknown;
          columnCount?: unknown;
        };
        const actual = metadataSheets(post).find(
          (sheet) => sheet.properties?.title === expected.title
        );
        return Boolean(
          actual &&
          (expected.rowCount === undefined ||
            actual.properties?.gridProperties?.rowCount === expected.rowCount) &&
          (expected.columnCount === undefined ||
            actual.properties?.gridProperties?.columnCount === expected.columnCount)
        );
      });
      if (
        (post as { properties?: { title?: unknown } } | undefined)?.properties?.title !==
          arguments_.title ||
        !sheetsMatch
      ) {
        return false;
      }
      if (typeof arguments_.folderId === 'string') {
        const file = await this.#driveFile(createdSpreadsheetId);
        return file.parents.includes(arguments_.folderId);
      }
      return true;
    }
    const spreadsheetId =
      typeof arguments_.spreadsheetId === 'string' ? arguments_.spreadsheetId : undefined;
    if (!spreadsheetId) {
      return operation === 'sign_out';
    }

    if (operation === 'copy_to') {
      const destinationSpreadsheetId =
        typeof arguments_.destinationSpreadsheetId === 'string'
          ? arguments_.destinationSpreadsheetId
          : undefined;
      if (!destinationSpreadsheetId) {
        return false;
      }
      const post = await this.#readVerificationMetadata(destinationSpreadsheetId);
      const before = (preflight.state as { destinationMetadataState?: unknown } | undefined)
        ?.destinationMetadataState;
      return metadataSheets(post).length === metadataSheets(before).length + 1;
    }

    if (operation === 'update_values' || operation === 'batch_update_values') {
      const ranges = operationRanges(operation, arguments_);
      const actual = await this.readValueRanges(spreadsheetId, ranges);
      const expected =
        operation === 'update_values'
          ? [arguments_.values]
          : ((arguments_.data as Array<{ values?: unknown[][] }> | undefined) ?? []).map(
              (entry) => entry.values ?? []
            );
      return (
        JSON.stringify(actual.map((entry) => normalizedValues(entry.values))) ===
        JSON.stringify(expected.map((values) => normalizedValues(values)))
      );
    }
    if (operation === 'append_values') {
      const updatedRange = /range:\s*([^\n]+)$/iu.exec(toolResponseText(result))?.[1]?.trim();
      if (!updatedRange) {
        return false;
      }
      const [actual] = await this.readValueRanges(spreadsheetId, [updatedRange]);
      return (
        JSON.stringify(normalizedValues(actual?.values ?? [])) ===
        JSON.stringify(normalizedValues(arguments_.values))
      );
    }
    if (operation === 'clear_values') {
      const actual = await this.readValueRanges(
        spreadsheetId,
        operationRanges(operation, arguments_)
      );
      return actual.every((entry) => normalizedValues(entry.values).length === 0);
    }
    if (operation === 'insert_link') {
      const separator = arguments_.useEUFormat === false ? ',' : ';';
      if (typeof arguments_.url !== 'string') {
        return false;
      }
      const url = arguments_.url;
      const label = typeof arguments_.text === 'string' ? arguments_.text : url;
      const actual = await this.readValueRanges(
        spreadsheetId,
        operationRanges(operation, arguments_)
      );
      return partialMatch(actual[0]?.values, [[`=HYPERLINK("${url}"${separator}"${label}")`]]);
    }
    if (operation === 'insert_date') {
      const expected = toolResponseData(result)?.formattedDate;
      if (typeof expected !== 'string') {
        return false;
      }
      const actual = await this.readValueRanges(
        spreadsheetId,
        operationRanges(operation, arguments_)
      );
      return partialMatch(actual[0]?.values, [[expected]]);
    }

    const post = await this.#readVerificationMetadata(
      spreadsheetId,
      operationRanges(operation, arguments_)
    );
    const before = (preflight.state as { metadataState?: unknown } | undefined)?.metadataState;
    const postSheets = metadataSheets(post);
    const beforeSheets = metadataSheets(before);
    if (operation === 'insert_sheet') {
      const created = postSheets.find((sheet) => sheet.properties?.title === arguments_.title);
      const wasAbsent = !beforeSheets.some((sheet) => sheet.properties?.title === arguments_.title);
      return Boolean(
        wasAbsent &&
        created &&
        (arguments_.index === undefined || created.properties?.index === arguments_.index) &&
        (arguments_.rowCount === undefined ||
          created.properties?.gridProperties?.rowCount === arguments_.rowCount) &&
        (arguments_.columnCount === undefined ||
          created.properties?.gridProperties?.columnCount === arguments_.columnCount)
      );
    }
    if (operation === 'duplicate_sheet') {
      const grew = postSheets.length === beforeSheets.length + 1;
      return (
        grew &&
        (typeof arguments_.newSheetName !== 'string' ||
          postSheets.some((sheet) => sheet.properties?.title === arguments_.newSheetName))
      );
    }
    if (operation === 'delete_sheet') {
      return (
        beforeSheets.some((sheet) => sheet.properties?.sheetId === arguments_.sheetId) &&
        !postSheets.some((sheet) => sheet.properties?.sheetId === arguments_.sheetId)
      );
    }
    if (operation === 'batch_delete_sheets') {
      const deleted = new Set(Array.isArray(arguments_.sheetIds) ? arguments_.sheetIds : []);
      return (
        deleted.size > 0 &&
        [...deleted].every((sheetId) =>
          beforeSheets.some((sheet) => sheet.properties?.sheetId === sheetId)
        ) &&
        postSheets.every((sheet) => !deleted.has(sheet.properties?.sheetId))
      );
    }
    if (operation === 'update_sheet_properties') {
      const sheet = postSheets.find((entry) => entry.properties?.sheetId === arguments_.sheetId);
      return Boolean(
        sheet &&
        partialMatch(sheet.properties, {
          ...(arguments_.title !== undefined ? { title: arguments_.title } : {}),
          ...(arguments_.gridProperties !== undefined
            ? { gridProperties: arguments_.gridProperties }
            : {}),
          ...(arguments_.tabColor !== undefined ? { tabColor: arguments_.tabColor } : {}),
        })
      );
    }
    if (['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns'].includes(operation)) {
      const beforeSheet = sheetForArguments(before, arguments_);
      const postSheet = sheetForArguments(post, arguments_);
      if (!beforeSheet || !postSheet) {
        return false;
      }
      const rows = operation.endsWith('rows');
      const property = rows ? 'rowCount' : 'columnCount';
      const dimension = rows ? 'ROWS' : 'COLUMNS';
      const count = operation.startsWith('insert')
        ? Number(arguments_[rows ? 'rows' : 'columns'] ?? 1)
        : typeof arguments_.range === 'string'
          ? rangeSize(arguments_.range, dimension)
          : null;
      if (!count) {
        return false;
      }
      const expectedDelta = operation.startsWith('insert') ? count : -count;
      return (
        Number(postSheet.properties?.gridProperties?.[property]) ===
        Number(beforeSheet.properties?.gridProperties?.[property]) + expectedDelta
      );
    }
    if (operation === 'merge_cells' || operation === 'unmerge_cells') {
      const range =
        typeof arguments_.range === 'string' ? exactGridRange(post, arguments_.range) : null;
      if (!range) {
        return false;
      }
      const merged = postSheets.some((sheet) =>
        (sheet.merges ?? []).some((candidate: unknown) => partialMatch(candidate, range))
      );
      if (operation === 'merge_cells') {
        return merged;
      }
      const beforeRange =
        typeof arguments_.range === 'string' ? exactGridRange(before, arguments_.range) : null;
      const wasMerged = beforeSheets.some((sheet) =>
        (sheet.merges ?? []).some((candidate: unknown) => partialMatch(candidate, beforeRange))
      );
      return wasMerged && !merged;
    }
    if (operation === 'format_cells') {
      const cells = metadataCells(post);
      return (
        cells.length > 0 &&
        cells.every((cell) => partialMatch(cell.userEnteredFormat, arguments_.format))
      );
    }
    if (operation === 'batch_format_cells') {
      const formats = Array.isArray(arguments_.formatRequests)
        ? arguments_.formatRequests.map((entry) => (entry as { format?: unknown }).format)
        : [];
      const cells = metadataCells(post);
      return (
        formats.length > 0 &&
        formats.every((format) =>
          cells.some((cell) => partialMatch(cell.userEnteredFormat, format))
        )
      );
    }
    if (operation === 'update_borders') {
      const requested = Object.entries((arguments_.borders ?? {}) as Record<string, unknown>);
      const cells = metadataCells(post);
      return requested.every(([side, border]) =>
        cells.some((cell) => partialMatch(cell.userEnteredFormat?.borders?.[side], border))
      );
    }
    if (operation === 'set_data_validation' || operation === 'clear_data_validation') {
      const cells = metadataCells(post);
      const beforeCells = metadataCells(before);
      return (
        cells.length > 0 &&
        (operation !== 'clear_data_validation' ||
          beforeCells.some(
            (cell) => cell.dataValidation !== null && cell.dataValidation !== undefined
          )) &&
        cells.every((cell) =>
          operation === 'clear_data_validation'
            ? cell.dataValidation === null || cell.dataValidation === undefined
            : partialMatch(cell.dataValidation, arguments_.rule)
        )
      );
    }
    if (operation === 'set_basic_filter' || operation === 'clear_basic_filter') {
      const sheet = sheetForArguments(post, arguments_);
      if (!sheet) {
        return false;
      }
      if (operation === 'clear_basic_filter') {
        const beforeSheet = sheetForArguments(before, arguments_);
        return (
          beforeSheet?.basicFilter !== null &&
          beforeSheet?.basicFilter !== undefined &&
          (sheet.basicFilter === null || sheet.basicFilter === undefined)
        );
      }
      const range =
        typeof arguments_.range === 'string' ? exactGridRange(post, arguments_.range) : null;
      return partialMatch(sheet.basicFilter, {
        ...(range ? { range } : {}),
        ...(arguments_.sortSpecs ? { sortSpecs: arguments_.sortSpecs } : {}),
        ...(arguments_.filterSpecs ? { filterSpecs: arguments_.filterSpecs } : {}),
        ...(arguments_.criteria ? { criteria: arguments_.criteria } : {}),
      });
    }
    if (operation === 'add_conditional_formatting') {
      const beforeCount = beforeSheets.reduce(
        (total, sheet) => total + (sheet.conditionalFormats?.length ?? 0),
        0
      );
      const postRules = postSheets.flatMap((sheet) => sheet.conditionalFormats ?? []);
      const requested = Array.isArray(arguments_.rules) ? arguments_.rules : [];
      const expectedRules = requested.map((rule) => {
        const requestedRule = rule as { ranges?: unknown } & Record<string, unknown>;
        const requestedRanges = Array.isArray(requestedRule.ranges)
          ? requestedRule.ranges.flatMap((range) =>
              typeof range === 'string' ? [exactGridRange(post, range)] : []
            )
          : [];
        return { ...requestedRule, ranges: requestedRanges };
      });
      return (
        postRules.length === beforeCount + requested.length &&
        expectedRules.every((rule) => postRules.some((postRule) => partialMatch(postRule, rule)))
      );
    }
    if (operation === 'create_chart') {
      const charts = metadataCharts(post);
      return (
        charts.length === metadataCharts(before).length + 1 &&
        charts.some((chart) =>
          partialMatch(chart.spec, {
            ...(arguments_.title ? { title: arguments_.title } : {}),
            ...(arguments_.chartType ? { basicChart: { chartType: arguments_.chartType } } : {}),
          })
        )
      );
    }
    if (operation === 'update_chart') {
      const chart = metadataCharts(post).find((entry) => entry.chartId === arguments_.chartId);
      return Boolean(
        chart &&
        partialMatch(chart.spec, {
          ...(arguments_.title !== undefined ? { title: arguments_.title } : {}),
          ...(arguments_.subtitle !== undefined ? { subtitle: arguments_.subtitle } : {}),
          ...(arguments_.chartType !== undefined
            ? { basicChart: { chartType: arguments_.chartType } }
            : {}),
        })
      );
    }
    if (operation === 'delete_chart') {
      return (
        metadataCharts(before).some((chart) => chart.chartId === arguments_.chartId) &&
        !metadataCharts(post).some((chart) => chart.chartId === arguments_.chartId)
      );
    }
    if (operation === 'add_table') {
      const table = metadataTables(post).find((entry) => entry.name === arguments_.name);
      return Boolean(
        metadataTables(post).length === metadataTables(before).length + 1 &&
        table &&
        (!Array.isArray(arguments_.columns) ||
          partialMatch(
            table.columnProperties?.map((column: any) => ({ name: column.columnName })),
            arguments_.columns.map((column: any) => ({ name: column.name }))
          ))
      );
    }
    if (operation === 'update_table') {
      const table = metadataTables(post).find((entry) => entry.tableId === arguments_.tableId);
      return Boolean(
        table &&
        partialMatch(table, {
          ...(arguments_.name !== undefined ? { name: arguments_.name } : {}),
          ...(Array.isArray(arguments_.columns)
            ? {
                columnProperties: arguments_.columns.map((column: any) => ({
                  columnName: column.name,
                })),
              }
            : {}),
        })
      );
    }
    if (operation === 'delete_table') {
      return (
        metadataTables(before).some((table) => table.tableId === arguments_.tableId) &&
        !metadataTables(post).some((table) => table.tableId === arguments_.tableId)
      );
    }
    return false;
  }

  async #readVerificationMetadata(
    spreadsheetId: string,
    ranges: readonly string[] = []
  ): Promise<unknown> {
    const sheets = this.getSheetsClient({ idempotent: true });
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: ranges.length > 0,
      ...(ranges.length > 0 ? { ranges: [...ranges] } : {}),
    });
    return response.data;
  }

  async revokeGoogleGrant(): Promise<void> {
    const response = await this.fetcher('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: this.#tokens.refreshToken || this.#tokens.accessToken }),
    });
    if (!response.ok) {
      throw new Error(`Google OAuth grant revocation failed with HTTP ${response.status}`);
    }
  }

  async readRow(proposal: RowChangeRequest): Promise<Record<string, CellValue>> {
    if (!proposal.rowNumber) {
      throw new Error('An update proposal requires a row number');
    }
    const sheet = await this.#findSheet(proposal);
    const parsed = parseSheetValues(sheet.rawValues);
    const row = parsed.rows.find((candidate) => candidate.rowNumber === proposal.rowNumber);
    if (!row) {
      throw new Error(`Row ${proposal.rowNumber} no longer exists`);
    }
    const keys = Object.keys(proposal.expectedValues ?? row.values);
    return Object.fromEntries(keys.map((key) => [key, row.values[key] ?? null]));
  }

  async captureRowChangeState(input: {
    spreadsheetId: string;
    sheetId: number;
    operation: 'append' | 'update';
    rowNumber?: number;
    columns?: readonly string[];
  }): Promise<unknown> {
    const spreadsheet = await this.readSpreadsheet(input.spreadsheetId);
    const sheet = spreadsheet.sheets.find((entry) => entry.sheetId === input.sheetId);
    if (!sheet) {
      throw new Error(`Sheet ${input.sheetId} no longer exists`);
    }
    const parsed = parseSheetValues(sheet.rawValues);
    if (input.operation === 'append') {
      return {
        headers: parsed.headers,
        lastRowNumber: parsed.rows.at(-1)?.rowNumber ?? 1,
      };
    }
    const row = parsed.rows.find((candidate) => candidate.rowNumber === input.rowNumber);
    if (!row) {
      throw new Error(`Row ${input.rowNumber} no longer exists`);
    }
    const columns = input.columns ?? Object.keys(row.values);
    return Object.fromEntries(columns.map((column) => [column, row.values[column] ?? null]));
  }

  async applyRow(proposal: RowChangeRequest): Promise<{ updatedRange: string; verified: boolean }> {
    await this.authorizeSpreadsheet(proposal.spreadsheetId);
    const sheet = await this.#findSheet(proposal);
    const parsed = parseSheetValues(sheet.rawValues);
    const unknown = Object.keys(proposal.values).filter(
      (header) => !parsed.headers.includes(header)
    );
    if (unknown.length > 0) {
      throw new Error(`Unknown columns: ${unknown.join(', ')}`);
    }

    let response: ValuesResponse;
    if (proposal.operation === 'append') {
      const url = new URL(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(proposal.spreadsheetId)}/values/${encodeURIComponent(quoteSheetTitle(proposal.sheetTitle))}:append`
      );
      url.searchParams.set('insertDataOption', 'INSERT_ROWS');
      url.searchParams.set('valueInputOption', 'RAW');
      response = await this.#json<ValuesResponse>(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          values: [parsed.headers.map((header) => proposal.values[header] ?? null)],
        }),
      });
    } else {
      const existing = parsed.rows.find((row) => row.rowNumber === proposal.rowNumber);
      if (!existing || !proposal.rowNumber) {
        throw new Error('The target row no longer exists');
      }
      const url = new URL(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(proposal.spreadsheetId)}/values:batchUpdate`
      );
      const data = Object.entries(proposal.values).map(([header, value]) => {
        const columnIndex = parsed.headers.indexOf(header);
        return {
          range: `${quoteSheetTitle(proposal.sheetTitle)}!${columnName(columnIndex)}${proposal.rowNumber}`,
          values: [[value]],
        };
      });
      response = await this.#json<ValuesResponse>(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      });
    }
    const updatedRange =
      response.updatedRange ??
      response.updates?.updatedRange ??
      response.responses
        ?.flatMap((entry) => (entry.updatedRange ? [entry.updatedRange] : []))
        .join(', ');
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

  async #findSheet(proposal: Pick<RowChangeRequest, 'spreadsheetId' | 'sheetId'>) {
    const spreadsheet = await this.readSpreadsheet(proposal.spreadsheetId);
    const sheet = spreadsheet.sheets.find((entry) => entry.sheetId === proposal.sheetId);
    if (!sheet) {
      throw new Error(`Sheet ${proposal.sheetId} no longer exists`);
    }
    return sheet;
  }

  async #json<T>(
    input: string | URL,
    init: RequestInit = {},
    idempotent = !init.method || init.method === 'GET'
  ): Promise<T> {
    return this.#request(async () => {
      const response = await this.fetcher(input, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${this.#tokens.accessToken}` },
      });
      if (!response.ok) {
        let details: unknown;
        try {
          details = await response.json();
        } catch {
          details = undefined;
        }
        const providerMessage = (details as { error?: { message?: unknown } } | undefined)?.error
          ?.message;
        throw new GoogleSheetsGatewayError(
          typeof providerMessage === 'string'
            ? providerMessage
            : `Google API request failed with HTTP ${response.status}`,
          response.status,
          details
        );
      }
      return (await response.json()) as T;
    }, idempotent);
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
        client_secret: this.clientSecret,
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
    this.#oauthClient.setCredentials({
      access_token: this.#tokens.accessToken,
      refresh_token: this.#tokens.refreshToken,
      expiry_date: this.#tokens.expiryDate,
      scope: this.#tokens.scope,
      token_type: this.#tokens.tokenType,
    });
    await this.saveTokens(this.#tokens);
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
