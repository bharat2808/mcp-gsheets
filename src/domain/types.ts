export type IndexStatus = 'current' | 'stale' | 'pending' | 'unavailable';

export type CellValue = string | number | boolean | null;

export interface SpreadsheetRecord {
  id: string;
  name: string;
  path: string;
  modifiedTime: string;
  version: string;
  indexStatus: IndexStatus;
  lastIndexedAt: string | null;
}

export interface IndexedRow {
  rowNumber: number;
  values: Record<string, CellValue>;
  rawValues?: Record<string, CellValue>;
}

export interface IndexedTable {
  tableId: string | null;
  name: string | null;
  range: string | null;
  columns: string[];
}

export interface ReplaceSheetRowsInput {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetId: number;
  sheetTitle: string;
  headers: string[];
  usedRange: string;
  identifierColumn: string | null;
  tables?: IndexedTable[];
  rows: IndexedRow[];
}

export interface SearchHit {
  id: string;
  title: string;
  url: string;
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  rowNumber: number;
  values: Record<string, CellValue>;
}

export interface RecentChange {
  spreadsheetId: string;
  spreadsheetName: string;
  sheetId: number;
  sheetTitle: string;
  detectedAt: string;
  changes: Array<{ kind: 'added' | 'modified' | 'deleted' | 'structural'; rows: number[] }>;
}

export interface WriteAudit {
  proposalId: string;
  appliedAt: string;
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  operation: 'append' | 'update';
  rowNumber?: number;
  beforeValues?: Record<string, CellValue>;
  afterValues: Record<string, CellValue>;
  updatedRange: string;
  verified: boolean;
}
