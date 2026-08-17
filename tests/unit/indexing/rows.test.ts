import { describe, expect, it } from 'vitest';

import {
  compareSheetSnapshots,
  detectIdentifierColumn,
  findDuplicateRow,
  fingerprintRow,
} from '../../../src/indexing/rows.js';

describe('row indexing', () => {
  const headers = ['Date', 'Customer', 'Amount', 'Reference'];
  const rows = [
    { rowNumber: 2, values: { Date: '2026-08-05', Customer: 'Ravi', Amount: 4280, Reference: 'INV-1' } },
    { rowNumber: 3, values: { Date: '2026-08-06', Customer: 'Asha', Amount: 1800, Reference: 'INV-2' } },
  ];

  it('prefers a unique reference-like column as the identifier', () => {
    expect(detectIdentifierColumn(headers, rows)).toBe('Reference');
  });

  it('rejects duplicate identifiers', () => {
    const duplicate = rows.map((row) => ({
      ...row,
      values: { ...row.values, Reference: 'INV-1' },
    }));
    expect(detectIdentifierColumn(headers, duplicate)).toBeNull();
  });

  it('finds an existing row with the proposed identifier', () => {
    expect(findDuplicateRow(rows, 'Reference', { Reference: ' INV-2 ' })).toBe(3);
    expect(findDuplicateRow(rows, 'Reference', { Reference: 'INV-9' })).toBeNull();
  });

  it('fingerprints normalized row values deterministically', () => {
    expect(fingerprintRow({ Customer: ' Ravi ', Amount: 4280 })).toBe(
      fingerprintRow({ Amount: 4280, Customer: 'Ravi' })
    );
  });

  it('matches moved rows by identifier and reports their current range', () => {
    const current = [
      { rowNumber: 2, values: rows[1]!.values },
      { rowNumber: 8, values: { ...rows[0]!.values, Amount: 5000 } },
      { rowNumber: 9, values: { Date: '2026-08-07', Customer: 'Leela', Amount: 900, Reference: 'INV-3' } },
    ];
    expect(compareSheetSnapshots({ headers, rows, identifierColumn: 'Reference' }, { headers, rows: current, identifierColumn: 'Reference' })).toEqual([
      { kind: 'modified', rows: [8] },
      { kind: 'added', rows: [9] },
    ]);
  });

  it('reports header changes as structural', () => {
    expect(
      compareSheetSnapshots(
        { headers, rows, identifierColumn: 'Reference' },
        { headers: [...headers, 'Status'], rows, identifierColumn: 'Reference' }
      )
    ).toEqual([{ kind: 'structural', rows: [] }]);
  });
});
