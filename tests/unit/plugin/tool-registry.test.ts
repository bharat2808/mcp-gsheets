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
    expect(OPERATIONS.every((operation) => TOOL_CATEGORIES.includes(operation.category))).toBe(
      true
    );
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
    const executeRetainedOperation = vi.fn().mockResolvedValue({ content: [] });
    const operation = OPERATIONS.find((candidate) => candidate.name === 'append_values');

    await operation?.handler({ executeRetainedOperation } as any, {
      spreadsheetId: 'book',
      range: 'Sheet1!A:A',
      values: [['new row']],
    });

    expect(executeRetainedOperation).toHaveBeenCalledWith(
      'append_values',
      expect.any(Function),
      expect.objectContaining({ spreadsheetId: 'book' }),
      { idempotent: false, refreshIndex: true }
    );
  });

  it('wraps retained mutation verification state in visible and structured MCP output', async () => {
    const executeRetainedOperation = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Updated 1 cell' }],
      verificationState: 'applied_verification_pending',
      verificationError: 'Index refresh failed for book',
    });
    const operation = OPERATIONS.find((candidate) => candidate.name === 'update_values');

    const response = (await operation!.handler({ executeRetainedOperation } as any, {
      spreadsheetId: 'book',
      range: 'Plan!A1',
      values: [['new']],
    })) as any;

    expect(response.content[0].text).toContain('applied_verification_pending');
    expect(response.content[0].text).toContain('Index refresh failed for book');
    expect(response.structuredContent).toEqual({
      data: expect.objectContaining({
        verificationState: 'applied_verification_pending',
        verificationError: 'Index refresh failed for book',
      }),
    });
  });

  it('opens the same confirmation UI for reviewed batch value edits', async () => {
    const proposal = {
      version: 2,
      id: '11111111-1111-4111-8111-111111111111',
      nonce: 'app-only-secret-token-that-is-long-enough',
      status: 'pending',
      presentation: {
        spreadsheetName: 'School Records',
        valueSections: [
          { worksheetName: 'Students', range: 'Students!A2:B2', before: [], after: [['S001']] },
          { worksheetName: 'Exams', range: 'Exams!A2:B2', before: [], after: [['S001']] },
        ],
      },
    };
    const runtime = {
      executeRetainedOperation: vi.fn().mockResolvedValue(proposal),
      confirmationToken: vi.fn().mockReturnValue(proposal.nonce),
    };
    const operation = OPERATIONS.find((candidate) => candidate.name === 'batch_update_values');

    const response = (await operation!.handler(runtime as any, {
      spreadsheetId: 'book',
      data: [],
    })) as any;

    expect(response.structuredContent.data.presentation.valueSections).toHaveLength(2);
    expect(response._meta).toMatchObject({
      'ui/resourceUri': 'ui://gsheets/review.html',
      'gsheets/confirmationToken': proposal.nonce,
    });
  });

  it('returns terminal proposals to the UI without issuing another token', async () => {
    const proposal = {
      version: 2,
      id: '11111111-1111-4111-8111-111111111111',
      nonce: '',
      status: 'expired',
    };
    const runtime = {
      review: vi.fn().mockReturnValue(proposal),
      confirmationToken: vi.fn(() => {
        throw new Error('must not issue a terminal token');
      }),
    };
    const operation = OPERATIONS.find((candidate) => candidate.name === 'review_change');

    const response = (await operation!.handler(runtime as any, {
      proposalId: proposal.id,
    })) as any;

    expect(response.structuredContent.data).toMatchObject({ status: 'expired' });
    expect(response._meta).toEqual({ 'ui/resourceUri': 'ui://gsheets/review.html' });
    expect(runtime.confirmationToken).not.toHaveBeenCalled();
  });

  it('routes sign-out only to reviewed preparation and defaults grant revocation off', async () => {
    const proposal = { version: 2, id: 'proposal', nonce: 'secret' };
    const runtime = {
      prepareSignOut: vi.fn().mockResolvedValue(proposal),
      confirmationToken: vi.fn().mockReturnValue('secret'),
      signOut: vi.fn(),
    };
    const operation = OPERATIONS.find((candidate) => candidate.name === 'sign_out');

    await operation?.handler(runtime as any, {});

    expect(runtime.prepareSignOut).toHaveBeenCalledWith({});
    expect(runtime.signOut).not.toHaveBeenCalled();
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
      expect(
        OPERATIONS.find((operation) => operation.name === name)?.annotations.idempotentHint
      ).toBeUndefined();
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
    };
    const inputs: Record<string, Record<string, unknown>> = {
      insert_columns: { spreadsheetId: 'book', range: 'Plan!B2' },
      move_spreadsheet: { spreadsheetId: 'book', folderId: 'folder' },
      set_data_validation: { spreadsheetId: 'book', range: 'Plan!A2:A9', rule: {} },
      clear_data_validation: { spreadsheetId: 'book', range: 'Plan!A2:A9' },
      set_basic_filter: { spreadsheetId: 'book', range: 'Plan!A1:D9' },
      clear_basic_filter: { spreadsheetId: 'book', sheetId: 7 },
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
  });

  it('marks parent moves, clears, and future reviewed sign-out as destructive', () => {
    for (const name of [
      'move_spreadsheet',
      'clear_data_validation',
      'clear_basic_filter',
      'sign_out',
    ]) {
      expect(
        OPERATIONS.find((operation) => operation.name === name)?.annotations.destructiveHint
      ).toBe(true);
    }
  });
});
