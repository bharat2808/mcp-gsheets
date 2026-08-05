import { describe, expect, it, vi } from 'vitest';

import {
  APP_ONLY_TOOL_NAMES,
  MODEL_TOOL_NAMES,
  OPERATIONS,
  PUBLIC_TOOL_NAMES,
  TOOL_CATEGORIES,
} from '../../../src/plugin/tool-registry.js';

describe('gsheets operation registry', () => {
  it('uses normalized public names with no sheets-prefixed aliases', () => {
    expect(PUBLIC_TOOL_NAMES).toContain('get_catalog');
    expect(PUBLIC_TOOL_NAMES).toContain('refresh_index');
    expect(PUBLIC_TOOL_NAMES).toContain('prepare_row_change');
    expect(PUBLIC_TOOL_NAMES.some((name) => name.startsWith('sheets_'))).toBe(false);
    expect(PUBLIC_TOOL_NAMES).not.toContain('get_sheets_catalog');
    expect(PUBLIC_TOOL_NAMES).not.toContain('refresh_sheets_index');
    expect(PUBLIC_TOOL_NAMES).not.toContain('prepare_sheet_change');
  });

  it('declares every category and assigns each operation exactly once', () => {
    expect(TOOL_CATEGORIES).toEqual([
      'core',
      'sheets',
      'formatting',
      'charts',
      'tables',
      'analysis',
      'account',
    ]);
    expect(OPERATIONS.map((operation) => operation.name)).toEqual(PUBLIC_TOOL_NAMES);
    expect(new Set(PUBLIC_TOOL_NAMES).size).toBe(PUBLIC_TOOL_NAMES.length);
    expect(OPERATIONS.every((operation) => TOOL_CATEGORIES.includes(operation.category))).toBe(true);
  });

  it('keeps proposal decisions app-only without removing them from the public registry', () => {
    expect(APP_ONLY_TOOL_NAMES).toEqual(['edit_change', 'approve_change', 'cancel_change']);
    expect(MODEL_TOOL_NAMES).not.toContain('edit_change');
    expect(PUBLIC_TOOL_NAMES).toEqual(expect.arrayContaining(APP_ONLY_TOOL_NAMES));
  });

  it('registers the planned public operations even before their handlers are implemented', () => {
    expect(PUBLIC_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        'insert_columns',
        'set_data_validation',
        'clear_data_validation',
        'set_basic_filter',
        'clear_basic_filter',
        'move_spreadsheet',
        'sign_out',
      ])
    );
  });

  it('routes appends through the gateway without retry permission', async () => {
    const executeLegacyOperation = vi.fn().mockResolvedValue({ content: [] });
    const operation = OPERATIONS.find((candidate) => candidate.name === 'append_values');

    await operation?.handler({ executeLegacyOperation } as any, {
      spreadsheetId: 'book',
      range: 'Sheet1!A:A',
      values: [['new row']],
    });

    expect(executeLegacyOperation).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ spreadsheetId: 'book' }),
      { idempotent: false, refreshIndex: true }
    );
  });

  it('does not classify create-like or structural insert operations as idempotent', () => {
    const neverReplay = [
      'create_spreadsheet',
      'insert_sheet',
      'duplicate_sheet',
      'copy_to',
      'insert_rows',
      'insert_columns',
      'merge_cells',
      'add_conditional_formatting',
      'create_chart',
      'add_table',
    ];

    for (const name of neverReplay) {
      expect(OPERATIONS.find((operation) => operation.name === name)?.annotations.idempotentHint).toBeUndefined();
    }
  });

  it('routes every formerly unavailable operation to its runtime execution primitive', async () => {
    const runtime = {
      insertColumns: vi.fn().mockResolvedValue({ ok: 'insert_columns' }),
      moveSpreadsheet: vi.fn().mockResolvedValue({ ok: 'move_spreadsheet' }),
      setDataValidation: vi.fn().mockResolvedValue({ ok: 'set_data_validation' }),
      clearDataValidation: vi.fn().mockResolvedValue({ ok: 'clear_data_validation' }),
      setBasicFilter: vi.fn().mockResolvedValue({ ok: 'set_basic_filter' }),
      clearBasicFilter: vi.fn().mockResolvedValue({ ok: 'clear_basic_filter' }),
      signOut: vi.fn().mockResolvedValue({ signedOut: true }),
    };
    const inputs: Record<string, Record<string, unknown>> = {
      insert_columns: { spreadsheetId: 'book', range: 'Plan!B2' },
      move_spreadsheet: { spreadsheetId: 'book', folderId: 'folder' },
      set_data_validation: { spreadsheetId: 'book', range: 'Plan!A2:A9', rule: {} },
      clear_data_validation: { spreadsheetId: 'book', range: 'Plan!A2:A9' },
      set_basic_filter: { spreadsheetId: 'book', range: 'Plan!A1:D9' },
      clear_basic_filter: { spreadsheetId: 'book', sheetId: 7 },
      sign_out: {},
    };

    for (const [name, input] of Object.entries(inputs)) {
      const operation = OPERATIONS.find((candidate) => candidate.name === name);
      const response = await operation?.handler(runtime as any, input);
      expect(JSON.stringify(response)).not.toContain('registered but not implemented');
    }

    expect(runtime.insertColumns).toHaveBeenCalled();
    expect(runtime.moveSpreadsheet).toHaveBeenCalled();
    expect(runtime.setDataValidation).toHaveBeenCalled();
    expect(runtime.clearDataValidation).toHaveBeenCalled();
    expect(runtime.setBasicFilter).toHaveBeenCalled();
    expect(runtime.clearBasicFilter).toHaveBeenCalled();
    expect(runtime.signOut).toHaveBeenCalled();
  });
});
