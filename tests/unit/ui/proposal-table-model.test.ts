import { describe, expect, it } from 'vitest';

import {
  editableValuesForOperation,
  proposalTableModel,
  updateTableCell,
} from '../../../ui/src/proposal-table-model.js';

describe('proposal table model', () => {
  const presentation = {
    spreadsheetName: 'School Records',
    valueSections: [
      {
        worksheetName: 'Students',
        range: 'Students!A2:B3',
        before: [['S001', 'Asha'], ['S002']],
        after: [['S001', 'Asha Sharma'], ['S002', 'Ravi']],
      },
      {
        worksheetName: 'Exams',
        range: 'Exams!A2:B2',
        before: [['S001', 88]],
        after: [['S001', 95]],
      },
    ],
  };

  it('creates ordered rectangular worksheet sections', () => {
    expect(proposalTableModel({ operation: 'batch_update_values', presentation })).toEqual([
      {
        worksheetName: 'Students',
        range: 'Students!A2:B3',
        valueShape: 'grid',
        columns: ['A', 'B'],
        before: [['S001', 'Asha'], ['S002', '']],
        after: [['S001', 'Asha Sharma'], ['S002', 'Ravi']],
      },
      {
        worksheetName: 'Exams',
        range: 'Exams!A2:B2',
        valueShape: 'grid',
        columns: ['A', 'B'],
        before: [['S001', 88]],
        after: [['S001', 95]],
      },
    ]);
  });

  it('updates one cell without mutating another batch section', () => {
    const initial = proposalTableModel({ operation: 'batch_update_values', presentation });
    const updated = updateTableCell(initial, 1, 0, 1, '100');

    expect(updated[1]?.after[0]?.[1]).toBe('100');
    expect(updated[0]).toEqual(initial[0]);
    expect(initial[1]?.after[0]?.[1]).toBe(95);
  });

  it('serializes the complete batch in original section order', () => {
    const sections = proposalTableModel({ operation: 'batch_update_values', presentation });

    expect(editableValuesForOperation('batch_update_values', sections)).toEqual([
      {
        range: 'Students!A2:B3',
        values: [['S001', 'Asha Sharma'], ['S002', 'Ravi']],
      },
      { range: 'Exams!A2:B2', values: [['S001', 95]] },
    ]);
  });

  it('round-trips keyed row proposals', () => {
    const sections = proposalTableModel({
      operation: 'prepare_row_change',
      presentation: {
        spreadsheetName: 'School Records',
        valueSections: [
          {
            worksheetName: 'Students',
            range: 'Students!4:4',
            before: { Name: 'Asha', Status: 'Active' },
            after: { Name: 'Asha Sharma', Status: 'Active' },
          },
        ],
      },
    });

    expect(sections[0]).toMatchObject({
      valueShape: 'record',
      columns: ['Name', 'Status'],
      after: [['Asha Sharma', 'Active']],
    });
    expect(editableValuesForOperation('prepare_row_change', sections)).toEqual({
      Name: 'Asha Sharma',
      Status: 'Active',
    });
  });
});
