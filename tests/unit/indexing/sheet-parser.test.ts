import { describe, expect, it } from 'vitest';

import { parseSheetValues } from '../../../src/indexing/sheet-parser.js';

describe('parseSheetValues', () => {
  it('maps a header row and skips empty data rows', () => {
    expect(
      parseSheetValues([
        ['Date', 'Customer', 'Amount'],
        ['2026-08-05', 'Ravi', 4280],
        [],
        ['2026-08-06', 'Asha', 1800],
      ])
    ).toEqual({
      headers: ['Date', 'Customer', 'Amount'],
      rows: [
        { rowNumber: 2, values: { Date: '2026-08-05', Customer: 'Ravi', Amount: 4280 } },
        { rowNumber: 4, values: { Date: '2026-08-06', Customer: 'Asha', Amount: 1800 } },
      ],
      usedRange: 'A1:C4',
      identifierColumn: null,
    });
  });

  it('makes blank and duplicate headers stable and unique', () => {
    expect(parseSheetValues([['Name', '', 'Name'], ['Ravi', 'x', 'Alias']]).headers).toEqual([
      'Name',
      'Column B',
      'Name (2)',
    ]);
  });
});
