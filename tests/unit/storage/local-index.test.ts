import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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
  it('persists the encrypted authenticated account identity', () => {
    const { index, databasePath } = createIndex();

    index.setAccountIdentity('permission-id-1');

    expect(index.getAccountIdentity()).toBe('permission-id-1');
    index.close();
    expect(readFileSync(databasePath).includes(Buffer.from('permission-id-1'))).toBe(false);
  });

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

  it('clears all account-bound data when OAuth credentials are replaced', () => {
    const { index } = createIndex();
    index.upsertSpreadsheet({
      id: 'spreadsheet-1',
      name: 'Accounts',
      path: '/Finance/Accounts',
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '12',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:01:00.000Z',
    });
    index.setSelectedFolderIds(['finance']);
    index.recordChanges({
      spreadsheetId: 'spreadsheet-1',
      spreadsheetName: 'Accounts',
      sheetId: 91,
      sheetTitle: 'Payments',
      detectedAt: '2026-08-05T00:02:00.000Z',
      changes: [{ kind: 'modified', rows: [2] }],
    });
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

    index.clearAccountData();

    expect(index.getCatalog()).toEqual([]);
    expect(index.getSelectedFolderIds()).toEqual([]);
    expect(index.getRecentChanges()).toEqual([]);
    expect(index.getWriteAudits()).toEqual([]);
    index.close();
  });

  it('migrates an existing encrypted database without losing catalog or recent-change history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gsheets-index-migration-'));
    tempDirectories.push(directory);
    const databasePath = join(directory, 'index.sqlite');
    const key = Buffer.alloc(32, 7);
    const legacy = new LocalIndex(databasePath, key);
    legacy.initialize();
    legacy.upsertSpreadsheet({
      id: 'book-1',
      name: 'Accounts',
      path: '/Accounts',
      modifiedTime: '',
      version: '8',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:00:00.000Z',
    });
    legacy.recordChanges({
      spreadsheetId: 'book-1',
      spreadsheetName: 'Accounts',
      sheetId: 1,
      sheetTitle: 'Ledger',
      detectedAt: '2026-08-05T00:02:00.000Z',
      changes: [{ kind: 'modified', rows: [2] }],
    });
    legacy.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec('PRAGMA user_version = 1; DROP TABLE IF EXISTS pending_verifications;');
    raw.close();

    const migrated = new LocalIndex(databasePath, key);
    migrated.initialize();

    expect(migrated.getCatalog().map((record) => record.id)).toEqual(['book-1']);
    expect(migrated.getRecentChanges()).toHaveLength(1);
    expect(migrated.getDatabaseVersion()).toBe(2);
    migrated.close();
  });

  it('persists encrypted pending verification blocks until refresh clears them', () => {
    const { index, databasePath } = createIndex();
    index.recordPendingVerification({
      operation: 'update_values',
      recordedAt: '2026-08-05T00:03:00.000Z',
      affectedResourceIds: ['spreadsheet:book-1', 'range:book-1:Plan!A1'],
      error: 'refresh failed',
    });

    expect(index.hasPendingVerification(['spreadsheet:book-1'])).toBe(true);
    expect(index.hasPendingVerification([])).toBe(true);
    index.clearPendingVerifications(['spreadsheet:book-1']);
    expect(index.hasPendingVerification(['spreadsheet:book-1'])).toBe(false);
    index.close();
    expect(readFileSync(databasePath).includes(Buffer.from('refresh failed'))).toBe(false);
  });

  it('rolls back encrypted audit and pending inserts when encryption fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gsheets-index-bad-key-'));
    tempDirectories.push(directory);
    const databasePath = join(directory, 'index.sqlite');
    const index = new LocalIndex(databasePath, Buffer.alloc(31, 1));
    index.initialize();

    expect(() =>
      index.recordWriteAudit({
        appliedAt: '2026-08-05T00:00:00.000Z',
        operation: 'update_values',
      })
    ).toThrow();
    expect(() =>
      index.recordPendingVerification({
        operation: 'update_values',
        recordedAt: '2026-08-05T00:00:00.000Z',
        affectedResourceIds: ['spreadsheet:book'],
        error: 'verification failed',
      })
    ).toThrow();

    const raw = new DatabaseSync(databasePath);
    expect(raw.prepare('SELECT encrypted_payload FROM write_audits').all()).toEqual([]);
    expect(raw.prepare('SELECT encrypted_payload FROM pending_verifications').all()).toEqual([]);
    raw.close();
    index.close();
  });

  it('decrypts every persisted audit and pending row without placeholder residue', () => {
    const { index, databasePath } = createIndex();
    for (let number = 1; number <= 3; number += 1) {
      index.recordWriteAudit({
        appliedAt: `2026-08-05T00:00:0${number}.000Z`,
        operation: `operation-${number}`,
      });
      index.recordPendingVerification({
        operation: `operation-${number}`,
        recordedAt: `2026-08-05T00:00:0${number}.000Z`,
        affectedResourceIds: [`spreadsheet:book-${number}`],
        error: `error-${number}`,
      });
    }
    expect(index.getWriteAudits()).toHaveLength(3);
    expect(index.getPendingVerifications()).toHaveLength(3);
    index.close();
    const raw = new DatabaseSync(databasePath);
    const payloads = [
      ...raw.prepare('SELECT encrypted_payload FROM write_audits').all(),
      ...raw.prepare('SELECT encrypted_payload FROM pending_verifications').all(),
    ] as Array<{ encrypted_payload: string }>;
    expect(payloads.every((row) => row.encrypted_payload !== 'pending')).toBe(true);
    raw.close();
  });
});
