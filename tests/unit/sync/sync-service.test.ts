import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { LocalIndex } from '../../../src/storage/local-index.js';
import { SyncService } from '../../../src/sync/sync-service.js';

describe('SyncService', () => {
  it('indexes rows only from spreadsheets beneath selected My Drive folders', async () => {
    const index = new LocalIndex(join(mkdtempSync(join(tmpdir(), 'gsheets-sync-')), 'index.db'), Buffer.alloc(32, 4));
    index.initialize();
    const drive = {
      listFileGraph: async () => [
        { id: 'folder', name: 'Finance', mimeType: 'application/vnd.google-apps.folder', parents: [] },
        { id: 'book', name: 'Accounts', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['folder'], version: '2', modifiedTime: '2026-08-05T00:00:00Z' },
        { id: 'other', name: 'Private', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [], version: '1', modifiedTime: '2026-08-05T00:00:00Z' },
      ],
    };
    const sheets = {
      readSpreadsheet: async () => ({
        sheets: [{
          sheetId: 1,
          title: 'Ledger',
          values: [['ID', 'Customer'], ['A-1', 'Acme']],
          tables: [{ tableId: 'table-1', name: 'Customers', range: 'Ledger!A1:B2', columns: ['ID', 'Customer'] }],
        }],
      }),
    };

    const result = await new SyncService(index, drive, sheets).refresh(['folder']);

    expect(result).toMatchObject({ spreadsheetsIndexed: 1, rowsIndexed: 1 });
    expect(index.search('Acme')).toHaveLength(1);
    expect(index.getCatalog().map((item) => item.id)).toEqual(['book']);
    expect(index.getSpreadsheetDetails('book')?.sheets[0]?.tables).toEqual([
      expect.objectContaining({ name: 'Customers', range: 'Ledger!A1:B2' }),
    ]);
    index.close();
  });

  it('indexes explicitly authorized plugin-created spreadsheets outside selected folders', async () => {
    const index = new LocalIndex(
      join(mkdtempSync(join(tmpdir(), 'gsheets-sync-')), 'index.db'),
      Buffer.alloc(32, 14)
    );
    index.initialize();
    const drive = {
      listFileGraph: async () => [
        { id: 'folder', name: 'Finance', mimeType: 'application/vnd.google-apps.folder', parents: [] },
        { id: 'root-book', name: 'Root book', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [], version: '1', modifiedTime: '2026-08-05T00:00:00Z' },
      ],
    };
    const sheets = {
      readSpreadsheet: async () => ({
        sheets: [{ sheetId: 1, title: 'Sheet1', values: [['Name'], ['Asha']] }],
      }),
    };

    const result = await new SyncService(index, drive, sheets).refresh(['folder'], ['root-book']);

    expect(result).toMatchObject({ spreadsheetsDiscovered: 1, spreadsheetsIndexed: 1 });
    expect(index.search('Asha')).toHaveLength(1);
    expect(index.getCatalog().map((item) => item.id)).toEqual(['root-book']);
    index.close();
  });

  it('skips content downloads when the Drive revision is already current', async () => {
    const index = new LocalIndex(join(mkdtempSync(join(tmpdir(), 'gsheets-sync-')), 'index.db'), Buffer.alloc(32, 5));
    index.initialize();
    const drive = {
      listFileGraph: async () => [
        { id: 'folder', name: 'Finance', mimeType: 'application/vnd.google-apps.folder', parents: [] },
        { id: 'book', name: 'Accounts', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['folder'], version: '2', modifiedTime: '2026-08-05T00:00:00Z' },
      ],
    };
    const readSpreadsheet = vi.fn().mockResolvedValue({
      sheets: [{ sheetId: 1, title: 'Ledger', values: [['ID'], ['A-1']] }],
    });
    const service = new SyncService(index, drive, { readSpreadsheet });

    await service.refresh(['folder']);
    const second = await service.refresh(['folder']);

    expect(readSpreadsheet).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ spreadsheetsDiscovered: 1, spreadsheetsIndexed: 0 });
    index.close();
  });

  it('removes deleted tabs and records a structural change', async () => {
    const index = new LocalIndex(join(mkdtempSync(join(tmpdir(), 'gsheets-sync-')), 'index.db'), Buffer.alloc(32, 6));
    index.initialize();
    let version = '1';
    const drive = {
      listFileGraph: async () => [
        { id: 'folder', name: 'Finance', mimeType: 'application/vnd.google-apps.folder', parents: [] },
        { id: 'book', name: 'Accounts', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['folder'], version, modifiedTime: '2026-08-05T00:00:00Z' },
      ],
    };
    const readSpreadsheet = vi.fn()
      .mockResolvedValueOnce({ sheets: [{ sheetId: 1, title: 'Old tab', values: [['ID'], ['A-1']] }] })
      .mockResolvedValueOnce({ sheets: [] });
    const service = new SyncService(index, drive, { readSpreadsheet });

    await service.refresh(['folder']);
    version = '2';
    await service.refresh(['folder']);

    expect(index.getSpreadsheetDetails('book')?.sheets).toEqual([]);
    expect(index.getRecentChanges()).toEqual([
      expect.objectContaining({ sheetTitle: 'Old tab', changes: [{ kind: 'structural', rows: [] }] }),
    ]);
    index.close();
  });

  it('reports each indexed, failed, and removed spreadsheet without hiding partial failure', async () => {
    const index = new LocalIndex(
      join(mkdtempSync(join(tmpdir(), 'gsheets-sync-')), 'index.db'),
      Buffer.alloc(32, 9)
    );
    index.initialize();
    index.upsertSpreadsheet({
      id: 'removed-book',
      name: 'Removed',
      path: '/Finance/Removed',
      modifiedTime: '2026-08-05T00:00:00Z',
      version: '1',
      indexStatus: 'current',
      lastIndexedAt: '2026-08-05T00:00:00Z',
    });
    const drive = {
      listFileGraph: async () => [
        {
          id: 'folder',
          name: 'Finance',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
        },
        {
          id: 'good-book',
          name: 'Good',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: ['folder'],
          version: '2',
          modifiedTime: '2026-08-05T00:00:00Z',
        },
        {
          id: 'failed-book',
          name: 'Failed',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: ['folder'],
          version: '3',
          modifiedTime: '2026-08-05T00:00:00Z',
        },
      ],
    };
    const sheets = {
      readSpreadsheet: vi.fn(async (spreadsheetId: string) => {
        if (spreadsheetId === 'failed-book') {
          throw new Error('Sheets unavailable');
        }
        return { sheets: [{ sheetId: 1, title: 'Data', values: [['ID'], ['A-1']] }] };
      }),
    };

    const result = await new SyncService(index, drive, sheets).refresh(['folder']);

    expect(result.resources).toEqual([
      { spreadsheetId: 'failed-book', status: 'failed', error: 'Sheets unavailable' },
      { spreadsheetId: 'good-book', status: 'indexed' },
      { spreadsheetId: 'removed-book', status: 'removed' },
    ]);
    expect(result.spreadsheetsIndexed).toBe(1);
    expect(index.getCatalog()).toEqual([
      expect.objectContaining({ id: 'failed-book', indexStatus: 'unavailable' }),
      expect.objectContaining({ id: 'good-book', indexStatus: 'current' }),
    ]);
    index.close();
  });
});
