import { createHash } from 'node:crypto';

import { CellValue, IndexedRow } from '../domain/types.js';

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'structural';

export interface SheetSnapshot {
  headers: string[];
  rows: IndexedRow[];
  identifierColumn: string | null;
}

export interface RowChange {
  kind: ChangeKind;
  rows: number[];
}

const IDENTIFIER_HEADER =
  /^(id|.*\bid\b|reference|reference number|ref|invoice|invoice number|email|uuid)$/iu;

function normalizeCell(value: CellValue): CellValue {
  if (typeof value !== 'string') {
    return value;
  }
  return value.normalize('NFKC').trim();
}

export function fingerprintRow(values: Record<string, CellValue>): string {
  const normalized = Object.keys(values)
    .sort((first, second) => first.localeCompare(second))
    .map((key) => [key.normalize('NFKC').trim(), normalizeCell(values[key] ?? null)]);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('base64url');
}

export function detectIdentifierColumn(
  headers: readonly string[],
  rows: readonly IndexedRow[]
): string | null {
  for (const header of headers) {
    if (!IDENTIFIER_HEADER.test(header.trim())) {
      continue;
    }
    const values = rows.map((row) => normalizeCell(row.values[header] ?? null));
    if (values.some((value) => value === null || value === '')) {
      continue;
    }
    if (new Set(values.map(String)).size === values.length) {
      return header;
    }
  }
  return null;
}

export function findDuplicateRow(
  rows: readonly IndexedRow[],
  identifierColumn: string,
  proposedValues: Record<string, CellValue>
): number | null {
  const proposed = normalizeCell(proposedValues[identifierColumn] ?? null);
  if (proposed === null || proposed === '') {
    return null;
  }
  const key = String(proposed).toLocaleLowerCase('en-US');
  return (
    rows.find(
      (row) =>
        String(normalizeCell(row.values[identifierColumn] ?? null)).toLocaleLowerCase('en-US') ===
        key
    )?.rowNumber ?? null
  );
}

function groupChanges(
  changes: Array<{ kind: Exclude<ChangeKind, 'structural'>; row: number }>
): RowChange[] {
  const order: Array<Exclude<ChangeKind, 'structural'>> = ['modified', 'added', 'deleted'];
  return order.flatMap((kind) => {
    const rows = changes
      .filter((change) => change.kind === kind)
      .map((change) => change.row)
      .sort((first, second) => first - second);
    return rows.length > 0 ? [{ kind, rows }] : [];
  });
}

export function compareSheetSnapshots(
  previous: SheetSnapshot,
  current: SheetSnapshot
): RowChange[] {
  if (JSON.stringify(previous.headers) !== JSON.stringify(current.headers)) {
    return [{ kind: 'structural', rows: [] }];
  }

  const identifier =
    previous.identifierColumn && previous.identifierColumn === current.identifierColumn
      ? previous.identifierColumn
      : null;
  const keyFor = (row: IndexedRow): string =>
    identifier ? String(normalizeCell(row.values[identifier] ?? null)) : String(row.rowNumber);
  const previousByKey = new Map(previous.rows.map((row) => [keyFor(row), row]));
  const currentByKey = new Map(current.rows.map((row) => [keyFor(row), row]));
  const changes: Array<{ kind: Exclude<ChangeKind, 'structural'>; row: number }> = [];

  for (const [key, row] of currentByKey) {
    const prior = previousByKey.get(key);
    if (!prior) {
      changes.push({ kind: 'added', row: row.rowNumber });
    } else if (fingerprintRow(prior.values) !== fingerprintRow(row.values)) {
      changes.push({ kind: 'modified', row: row.rowNumber });
    }
  }
  for (const [key, row] of previousByKey) {
    if (!currentByKey.has(key)) {
      changes.push({ kind: 'deleted', row: row.rowNumber });
    }
  }

  return groupChanges(changes);
}
