import { describe, expect, it } from 'vitest';

import { classifyOperationRisk } from '../../../src/risk/risk-classifier.js';

describe('classifyOperationRisk', () => {
  it.each([
    ['get_values', {}, {}],
    ['create_spreadsheet', { title: 'Plan' }, {}],
    ['insert_rows', { spreadsheetId: 'book', range: 'Plan!2:2' }, {}],
    ['duplicate_sheet', { spreadsheetId: 'book', sheetId: 7 }, {}],
    ['format_cells', { spreadsheetId: 'book', range: 'Plan!A1' }, {}],
  ])(
    'executes verified non-lossy %s operations immediately',
    (operation, arguments_, inspection) => {
      expect(classifyOperationRisk({ operation, arguments: arguments_, inspection })).toEqual({
        decision: 'immediate',
        reasons: [],
      });
    }
  );

  it.each([
    [
      'prepare_row_change',
      { operation: 'append', values: { Name: 'Asha' } },
      'Row changes require review',
    ],
    [
      'append_values',
      { spreadsheetId: 'book', range: 'Plan!A:A', values: [['Asha']] },
      'Appends require review',
    ],
    [
      'delete_rows',
      { spreadsheetId: 'book', range: 'Plan!2:2' },
      'Explicit removal requires review',
    ],
    ['unmerge_cells', { spreadsheetId: 'book', range: 'Plan!A1:B2' }, 'Unmerge requires review'],
    ['update_chart', { spreadsheetId: 'book', chartId: 3 }, 'Chart replacement requires review'],
    ['update_table', { spreadsheetId: 'book', tableId: 't1' }, 'Table replacement requires review'],
    ['sign_out', {}, 'Sign-out requires review'],
  ])('reviews %s with a concrete reason', (operation, arguments_, reason) => {
    expect(classifyOperationRisk({ operation, arguments: arguments_, inspection: {} })).toEqual({
      decision: 'reviewed',
      reasons: expect.arrayContaining([reason]),
    });
  });

  it('reviews formulas even inside otherwise non-lossy insertions', () => {
    expect(
      classifyOperationRisk({
        operation: 'insert_columns',
        arguments: { spreadsheetId: 'book', range: 'Plan!B2', values: [['=SUM(A:A)']] },
        inspection: {},
      })
    ).toEqual({ decision: 'reviewed', reasons: ['Formula input requires review'] });
  });

  it('fails closed when a future mutation has no risk policy', () => {
    expect(
      classifyOperationRisk({ operation: 'future_mutation', arguments: {}, inspection: {} })
    ).toEqual({
      decision: 'reviewed',
      reasons: ['Unclassified operation requires review'],
    });
  });

  it('allows value updates only when every target cell was verified empty', () => {
    const empty = classifyOperationRisk({
      operation: 'batch_update_values',
      arguments: { spreadsheetId: 'book', data: [{ range: 'Plan!A2:B2', values: [['a', 'b']] }] },
      inspection: { targetCellsVerifiedEmpty: true },
    });
    const populated = classifyOperationRisk({
      operation: 'update_values',
      arguments: { spreadsheetId: 'book', range: 'Plan!A2', values: [['replacement']] },
      inspection: { targetCellsVerifiedEmpty: false },
    });

    expect(empty).toEqual({ decision: 'immediate', reasons: [] });
    expect(populated).toEqual({
      decision: 'reviewed',
      reasons: ['Populated cells would be overwritten'],
    });
  });

  it('reviews conditional-loss operations only when the inspected condition is present', () => {
    expect(
      classifyOperationRisk({
        operation: 'merge_cells',
        arguments: {},
        inspection: { targetCellsPopulated: true },
      }).decision
    ).toBe('reviewed');
    expect(
      classifyOperationRisk({
        operation: 'merge_cells',
        arguments: {},
        inspection: { targetCellsPopulated: false },
      }).decision
    ).toBe('immediate');
    expect(
      classifyOperationRisk({
        operation: 'update_sheet_properties',
        arguments: {},
        inspection: { gridShrinks: true },
      }).decision
    ).toBe('reviewed');
    expect(
      classifyOperationRisk({
        operation: 'move_spreadsheet',
        arguments: {},
        inspection: { destinationSelected: false },
      }).decision
    ).toBe('reviewed');
    expect(
      classifyOperationRisk({
        operation: 'insert_date',
        arguments: {},
        inspection: { targetCellsPopulated: true },
      }).decision
    ).toBe('reviewed');
  });
});
