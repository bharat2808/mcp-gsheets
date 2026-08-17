import { CellValue, IndexedRow } from '../domain/types.js';
import { detectIdentifierColumn } from './rows.js';

export interface ParsedSheetValues {
  headers: string[];
  rows: IndexedRow[];
  usedRange: string;
  identifierColumn: string | null;
}

function columnName(columnIndex: number): string {
  let value = columnIndex + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value) ?? '';
}

function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return stringifyValue(value);
}

function uniqueHeaders(values: readonly unknown[], width: number): string[] {
  const counts = new Map<string, number>();
  return Array.from({ length: width }, (_, columnIndex) => {
    const raw = stringifyValue(values[columnIndex]).normalize('NFKC').trim();
    const base = raw || `Column ${columnName(columnIndex)}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export function parseSheetValues(values: readonly (readonly unknown[])[]): ParsedSheetValues {
  const lastUsedRowIndex = values.reduce(
    (last, row, index) =>
      row.some((value) => value !== '' && value !== null && value !== undefined) ? index : last,
    0
  );
  const relevantRows = values.slice(0, lastUsedRowIndex + 1);
  const width = Math.max(1, ...relevantRows.map((row) => row.length));
  const headers = uniqueHeaders(relevantRows[0] ?? [], width);
  const rows: IndexedRow[] = [];

  for (let index = 1; index < relevantRows.length; index += 1) {
    const source = relevantRows[index] ?? [];
    if (!source.some((value) => value !== '' && value !== null && value !== undefined)) {
      continue;
    }
    const rowValues: Record<string, CellValue> = {};
    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      const header = headers[columnIndex];
      if (header) {
        rowValues[header] = toCellValue(source[columnIndex]);
      }
    }
    rows.push({ rowNumber: index + 1, values: rowValues });
  }

  return {
    headers,
    rows,
    usedRange: `A1:${columnName(width - 1)}${lastUsedRowIndex + 1}`,
    identifierColumn: detectIdentifierColumn(headers, rows),
  };
}
