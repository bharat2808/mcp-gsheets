import { describe, expect, it } from 'vitest';

import { buildSelectedCatalog, DriveFileMetadata } from '../../../src/drive/catalog.js';

describe('buildSelectedCatalog', () => {
  const files: DriveFileMetadata[] = [
    { id: 'root', name: 'Finance', mimeType: 'application/vnd.google-apps.folder', parents: [] },
    { id: 'child', name: 'FY26', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    {
      id: 'sheet-1',
      name: 'Accounts',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: ['child'],
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '12',
    },
    {
      id: 'sheet-outside',
      name: 'Personal',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [],
      modifiedTime: '2026-08-05T00:00:00.000Z',
      version: '2',
    },
  ];

  it('returns Sheets beneath selected folders with stable paths', () => {
    expect(buildSelectedCatalog(files, ['root'])).toEqual([
      expect.objectContaining({ id: 'sheet-1', path: '/Finance/FY26/Accounts' }),
    ]);
  });

  it('excludes Sheets outside the selected folder graph', () => {
    expect(buildSelectedCatalog(files, ['root']).map((file) => file.id)).not.toContain(
      'sheet-outside'
    );
  });
});
