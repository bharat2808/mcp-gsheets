import { describe, expect, it } from 'vitest';

import { extractOperationResources } from '../../../src/operations/resources.js';

describe('extractOperationResources', () => {
  it('tracks copy source and mutated destination spreadsheets', () => {
    expect(
      extractOperationResources('copy_to', {
        spreadsheetId: 'source-book',
        sheetId: 7,
        destinationSpreadsheetId: 'destination-book',
      })
    ).toEqual([
      { kind: 'spreadsheet', id: 'source-book', label: 'source-book' },
      { kind: 'spreadsheet', id: 'destination-book', label: 'destination-book' },
      { kind: 'sheet', id: 'source-book:7', label: 'Sheet 7' },
    ]);
  });

  it('tracks every sheet in a batch deletion', () => {
    expect(
      extractOperationResources('batch_delete_sheets', {
        spreadsheetId: 'book',
        sheetIds: [9, 3, 9],
      })
    ).toEqual([
      { kind: 'spreadsheet', id: 'book', label: 'book' },
      { kind: 'sheet', id: 'book:9', label: 'Sheet 9' },
      { kind: 'sheet', id: 'book:3', label: 'Sheet 3' },
    ]);
  });
});
