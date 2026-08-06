import { DriveFileMetadata, buildSelectedCatalog } from '../drive/catalog.js';
import { IndexedTable } from '../domain/types.js';
import { parseSheetValues } from '../indexing/sheet-parser.js';
import { compareSheetSnapshots } from '../indexing/rows.js';
import { LocalIndex } from '../storage/local-index.js';

export interface DriveCatalogGateway {
  listFileGraph(): Promise<DriveFileMetadata[]>;
}

export interface RemoteSheet {
  sheetId: number;
  title: string;
  values: readonly (readonly unknown[])[];
  rawValues?: readonly (readonly unknown[])[];
  tables?: IndexedTable[];
}

export interface SheetsReadGateway {
  readSpreadsheet(spreadsheetId: string): Promise<{ sheets: RemoteSheet[] }>;
}

export interface RefreshResult {
  spreadsheetsDiscovered: number;
  spreadsheetsIndexed: number;
  sheetsIndexed: number;
  rowsIndexed: number;
  completedAt: string;
  resources: Array<
    | { spreadsheetId: string; status: 'indexed' | 'current' | 'removed' }
    | { spreadsheetId: string; status: 'failed'; error: string }
  >;
}

export class SyncService {
  constructor(
    private readonly index: LocalIndex,
    private readonly drive: DriveCatalogGateway,
    private readonly sheets: SheetsReadGateway,
    private readonly now: () => Date = () => new Date()
  ) {}

  async refresh(selectedFolderIds: readonly string[]): Promise<RefreshResult> {
    const previousSpreadsheetIds = new Set(this.index.getCatalog().map((record) => record.id));
    const catalog = buildSelectedCatalog(await this.drive.listFileGraph(), selectedFolderIds);
    this.index.retainSpreadsheets(catalog.map((record) => record.id));
    let sheetsIndexed = 0;
    let rowsIndexed = 0;
    let spreadsheetsIndexed = 0;
    const resources: RefreshResult['resources'] = [];
    const completedAt = this.now().toISOString();

    for (const spreadsheet of catalog) {
      const previousRecord = this.index.getCatalog().find((record) => record.id === spreadsheet.id);
      if (
        previousRecord?.version === spreadsheet.version &&
        previousRecord.indexStatus === 'current'
      ) {
        this.index.upsertSpreadsheet({
          ...spreadsheet,
          indexStatus: 'current',
          lastIndexedAt: previousRecord.lastIndexedAt,
        });
        resources.push({ spreadsheetId: spreadsheet.id, status: 'current' });
        continue;
      }
      this.index.upsertSpreadsheet(spreadsheet);
      try {
        const previousDetails = this.index.getSpreadsheetDetails(spreadsheet.id);
        const remote = await this.sheets.readSpreadsheet(spreadsheet.id);
        for (const sheet of remote.sheets) {
          const parsed = parseSheetValues(sheet.values);
          const rawParsed = parseSheetValues(sheet.rawValues ?? sheet.values);
          const rows = parsed.rows.map((row) => ({
            ...row,
            rawValues:
              rawParsed.rows.find((rawRow) => rawRow.rowNumber === row.rowNumber)?.values ??
              row.values,
          }));
          const previous = this.index.getSheetSnapshot(spreadsheet.id, sheet.sheetId);
          if (previous) {
            this.index.recordChanges({
              spreadsheetId: spreadsheet.id,
              spreadsheetName: spreadsheet.name,
              sheetId: sheet.sheetId,
              sheetTitle: sheet.title,
              detectedAt: completedAt,
              changes: compareSheetSnapshots(previous, parsed),
            });
          }
          this.index.replaceSheetRows({
            spreadsheetId: spreadsheet.id,
            spreadsheetName: spreadsheet.name,
            sheetId: sheet.sheetId,
            sheetTitle: sheet.title,
            tables: sheet.tables ?? [],
            ...parsed,
            rows,
          });
          sheetsIndexed += 1;
          rowsIndexed += parsed.rows.length;
        }
        const remoteSheetIds = remote.sheets.map((sheet) => sheet.sheetId);
        for (const removed of previousDetails?.sheets.filter(
          (sheet) => !remoteSheetIds.includes(sheet.sheetId)
        ) ?? []) {
          this.index.recordChanges({
            spreadsheetId: spreadsheet.id,
            spreadsheetName: spreadsheet.name,
            sheetId: removed.sheetId,
            sheetTitle: removed.title,
            detectedAt: completedAt,
            changes: [{ kind: 'structural', rows: [] }],
          });
        }
        this.index.retainSheets(spreadsheet.id, remoteSheetIds);
        this.index.upsertSpreadsheet({
          ...spreadsheet,
          indexStatus: 'current',
          lastIndexedAt: completedAt,
        });
        spreadsheetsIndexed += 1;
        resources.push({ spreadsheetId: spreadsheet.id, status: 'indexed' });
      } catch (error) {
        this.index.upsertSpreadsheet({ ...spreadsheet, indexStatus: 'unavailable' });
        resources.push({
          spreadsheetId: spreadsheet.id,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const discoveredIds = new Set(catalog.map((record) => record.id));
    for (const spreadsheetId of previousSpreadsheetIds) {
      if (!discoveredIds.has(spreadsheetId)) {
        resources.push({ spreadsheetId, status: 'removed' });
      }
    }
    resources.sort((first, second) => first.spreadsheetId.localeCompare(second.spreadsheetId));

    return {
      spreadsheetsDiscovered: catalog.length,
      spreadsheetsIndexed,
      sheetsIndexed,
      rowsIndexed,
      completedAt,
      resources,
    };
  }
}
