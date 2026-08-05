import { describe, expect, it } from 'vitest';

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
});
