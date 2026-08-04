import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalIndex } from '../../../src/storage/local-index.js';

const tempDirectories: string[] = [];

function createIndex() {
  const directory = mkdtempSync(join(tmpdir(), 'gsheets-index-'));
  tempDirectories.push(directory);
  const databasePath = join(directory, 'index.sqlite');
  const index = new LocalIndex(databasePath, Buffer.alloc(32, 7));
  index.initialize();
  return { index, databasePath };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
});

describe('LocalIndex', () => {
  it('stores a catalog with explicit freshness state', () => {
    const { index } = createIndex();
    index.upsertSpreadsheet({
      id: 'spreadsheet-1',
      name: 'Accounts',
      path: '/Finance/Accounts',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '12',
      indexStatus: 'pending',
      lastIndexedAt: null,
    });

    expect(index.getCatalog()).toEqual([
      expect.objectContaining({ id: 'spreadsheet-1', name: 'Accounts', indexStatus: 'pending' }),
    ]);
    index.close();
  });

  it('encrypts rows and finds them through blind search tokens', () => {
    const { index, databasePath } = createIndex();
    index.upsertSpreadsheet({
      id: 'spreadsheet-1',
      name: 'Accounts',
      path: '/Finance/Accounts',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '12',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:01:00.000Z',
    });
    index.replaceSheetRows({
      spreadsheetId: 'spreadsheet-1',
      spreadsheetName: 'Accounts',
      sheetId: 91,
      sheetTitle: 'Payments',
      headers: ['Date', 'Customer', 'Amount', 'Reference'],
      usedRange: 'A1:D2',
      identifierColumn: 'Reference',
      rows: [
        {
          rowNumber: 2,
          values: {
            Date: '2026-08-05',
            Customer: 'Ravi Kumar',
            Amount: '₹4,280',
            Reference: 'INV-1842',
          },
          rawValues: {
            Date: '2026-08-05',
            Customer: 'Ravi Kumar',
            Amount: 4280,
            Reference: 'INV-1842',
          },
        },
      ],
    });

    expect(index.search('ravi 4280')).toEqual([
      expect.objectContaining({
        id: 'sheetrow:spreadsheet-1:91:2',
        title: 'Accounts → Payments → row 2',
        values: expect.objectContaining({ Customer: 'Ravi Kumar', Reference: 'INV-1842' }),
      }),
    ]);
    expect(index.getRawRow('spreadsheet-1', 91, 2)).toMatchObject({ Amount: 4280 });
    index.close();

    expect(readFileSync(databasePath).includes(Buffer.from('Ravi Kumar'))).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from('INV-1842'))).toBe(false);
  });

  it('replaces stale sheet rows atomically', () => {
    const { index } = createIndex();
    index.upsertSpreadsheet({
      id: 'spreadsheet-1',
      name: 'Accounts',
      path: '/Accounts',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '1',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:01:00.000Z',
    });
    const base = {
      spreadsheetId: 'spreadsheet-1',
      spreadsheetName: 'Accounts',
      sheetId: 91,
      sheetTitle: 'Payments',
      headers: ['Customer'],
      usedRange: 'A1:A2',
      identifierColumn: null,
    };
    index.replaceSheetRows({ ...base, rows: [{ rowNumber: 2, values: { Customer: 'Ravi' } }] });
    index.replaceSheetRows({ ...base, rows: [{ rowNumber: 2, values: { Customer: 'Asha' } }] });

    expect(index.search('ravi')).toEqual([]);
    expect(index.search('asha')).toHaveLength(1);
    index.close();
  });

  it('persists encrypted folder selection and recent change summaries', () => {
    const { index, databasePath } = createIndex();
    index.setSelectedFolderIds(['finance']);
    index.recordChanges({
      spreadsheetId: 'spreadsheet-1',
      spreadsheetName: 'Accounts',
      sheetId: 91,
      sheetTitle: 'Payments',
      detectedAt: '2026-08-05T00:02:00.000Z',
      changes: [{ kind: 'modified', rows: [2] }],
    });

    expect(index.getSelectedFolderIds()).toEqual(['finance']);
    expect(index.getRecentChanges()).toEqual([
      expect.objectContaining({
        spreadsheetName: 'Accounts',
        changes: [{ kind: 'modified', rows: [2] }],
      }),
    ]);
    index.close();
    expect(readFileSync(databasePath).includes(Buffer.from('finance'))).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from('"rows":[2]'))).toBe(false);
  });

  it('keeps an encrypted audit history for approved writes', () => {
    const { index, databasePath } = createIndex();
    index.recordWriteAudit({
      proposalId: 'proposal-1',
      appliedAt: '2026-08-05T00:03:00.000Z',
      spreadsheetId: 'spreadsheet-1',
      sheetId: 91,
      sheetTitle: 'Payments',
      operation: 'update',
      rowNumber: 2,
      beforeValues: { Status: 'Open' },
      afterValues: { Status: 'Paid' },
      updatedRange: 'Payments!D2',
      verified: true,
    });

    expect(index.getWriteAudits()).toEqual([
      expect.objectContaining({ proposalId: 'proposal-1', verified: true }),
    ]);
    index.close();
    expect(readFileSync(databasePath).includes(Buffer.from('proposal-1'))).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from('Paid'))).toBe(false);
  });
});
