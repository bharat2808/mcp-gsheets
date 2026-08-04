import { describe, expect, it } from 'vitest';

import {
  APP_ONLY_TOOL_NAMES,
  MODEL_TOOL_NAMES,
  PUBLIC_TOOL_NAMES,
} from '../../../src/plugin/tool-registry.js';

describe('gsheets tool registry', () => {
  it('exposes only the curated model tool surface', () => {
    expect(MODEL_TOOL_NAMES).toEqual([
      'get_connection_status',
      'get_sheets_catalog',
      'get_recent_changes',
      'explore_spreadsheet',
      'search',
      'fetch',
      'refresh_sheets_index',
      'prepare_sheet_change',
      'review_sheet_change',
    ]);
    expect(MODEL_TOOL_NAMES.some((name) => name.startsWith('sheets_'))).toBe(false);
  });

  it('keeps proposal decisions app-only', () => {
    expect(APP_ONLY_TOOL_NAMES).toEqual([
      'edit_sheet_proposal',
      'approve_sheet_proposal',
      'cancel_sheet_proposal',
    ]);
  });

  it('does not register duplicate tool names', () => {
    expect(new Set(PUBLIC_TOOL_NAMES).size).toBe(PUBLIC_TOOL_NAMES.length);
  });
});
