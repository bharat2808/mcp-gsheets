import { describe, expect, it, vi } from 'vitest';
import { google } from 'googleapis';

import { GoogleSheetsGateway } from '../../../src/google/google-api-client.js';
import {
  getAuthenticatedClient,
  runWithGoogleSheetsGateway,
} from '../../../src/utils/google-auth.js';

const TOKENS = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiryDate: 1_800_000_000_000,
  scope: 'https://www.googleapis.com/auth/spreadsheets',
  tokenType: 'Bearer',
};

describe('GoogleSheetsGateway retained-handler context', () => {
  function verificationFixture(options: {
    metadata?: Record<string, unknown>;
    values?: unknown[][];
    version?: string;
  }) {
    const get = vi.fn().mockResolvedValue({ data: options.metadata ?? { sheets: [] } });
    const batchGet = vi.fn().mockResolvedValue({
      data: { valueRanges: [{ range: 'Plan!A2:B2', values: options.values ?? [] }] },
    });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ version: options.version ?? '7' }), { status: 200 })
        ),
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, values: { batchGet } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );
    return { gateway, get, batchGet };
  }

  function verificationPreflight(metadataState: unknown = { sheets: [] }) {
    return {
      affectedResources: [{ kind: 'spreadsheet' as const, id: 'book', label: 'book' }],
      preview: { kind: 'exact' as const, before: metadataState, after: null },
      riskInspection: {},
      driveRevisions: { book: '7' },
      state: { valueRanges: [], metadataState, driveRevisions: { book: '7' } },
    };
  }

  it('expands flexible value ranges and verifies every target cell was empty before direct write', async () => {
    const batchGet = vi.fn().mockResolvedValue({
      data: { valueRanges: [{ range: 'Plan!A2:B3', values: [] }] },
    });
    const get = vi.fn().mockResolvedValue({
      data: { properties: { title: 'Plan book' }, sheets: [{ properties: { title: 'Plan' } }] },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ version: '7' }), { status: 200 }));
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, values: { batchGet } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    const preflight = await gateway.inspectOperation(
      'update_values',
      {
        spreadsheetId: 'book',
        range: 'Plan!A2',
        values: [
          ['a', 'b'],
          ['c', 'd'],
        ],
      },
      []
    );

    expect(batchGet).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: 'book', ranges: ['Plan!A2:B3'] }),
      { retry: false }
    );
    expect(preflight.riskInspection.targetCellsVerifiedEmpty).toBe(true);
    expect(preflight.preview).toMatchObject({ kind: 'values', before: [] });
  });

  it('describes spreadsheet and worksheet table sections for batch value review', async () => {
    const batchGet = vi.fn().mockResolvedValue({
      data: {
        valueRanges: [
          { range: 'Students!A2:B2', values: [['S001', 'Asha']] },
          { range: 'Exams!A2:B2', values: [['S001', 88]] },
        ],
      },
    });
    const get = vi.fn().mockResolvedValue({
      data: {
        properties: { title: 'School Records' },
        sheets: [
          { properties: { sheetId: 1, title: 'Students' } },
          { properties: { sheetId: 2, title: 'Exams' } },
        ],
      },
    });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '7' }), { status: 200 })),
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, values: { batchGet } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    const preflight = await gateway.inspectOperation(
      'batch_update_values',
      {
        spreadsheetId: 'book',
        data: [
          { range: 'Students!A2:B2', values: [['S001', 'Asha Sharma']] },
          { range: 'Exams!A2:B2', values: [['S001', 95]] },
        ],
      },
      []
    );

    expect(preflight.presentation).toEqual({
      spreadsheetName: 'School Records',
      valueSections: [
        {
          worksheetName: 'Students',
          range: 'Students!A2:B2',
          before: [['S001', 'Asha']],
          after: [['S001', 'Asha Sharma']],
        },
        {
          worksheetName: 'Exams',
          range: 'Exams!A2:B2',
          before: [['S001', 88]],
          after: [['S001', 95]],
        },
      ],
    });
  });

  it('verifies USER_ENTERED batch values after Google coerces scalar types', async () => {
    const batchGet = vi.fn().mockResolvedValue({
      data: {
        valueRanges: [
          {
            range: 'Exams!A1:B3',
            values: [
              ['Student ID', 'Score'],
              ['S001', 95],
              ['S002', 88],
            ],
          },
        ],
      },
    });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      vi.fn(),
      Date.now,
      {
        sheetsClient: { spreadsheets: { values: { batchGet } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );
    const arguments_ = {
      spreadsheetId: 'book',
      data: [
        {
          range: 'Exams!A1:B3',
          values: [
            ['Student ID', 'Score'],
            ['S001', '95'],
            ['S002', '88'],
          ],
        },
      ],
    };

    await expect(
      gateway.verifyOperation(
        'batch_update_values',
        arguments_,
        {},
        {
          affectedResources: [],
          preview: { kind: 'values', before: [], after: [] },
          riskInspection: {},
          driveRevisions: {},
          state: {},
        }
      )
    ).resolves.toBe(true);
  });

  it('preflights both copy spreadsheets and verifies the copied sheet in the destination', async () => {
    const versions = new Map([
      ['source-book', '4'],
      ['destination-book', '8'],
    ]);
    const fetcher = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      const spreadsheetId = url.includes('source-book') ? 'source-book' : 'destination-book';
      return new Response(JSON.stringify({ version: versions.get(spreadsheetId) }), {
        status: 200,
      });
    });
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        data: { sheets: [{ properties: { sheetId: 1, title: 'Existing' } }] },
      })
      .mockResolvedValueOnce({
        data: {
          sheets: [
            { properties: { sheetId: 1, title: 'Existing' } },
            { properties: { sheetId: 2, title: 'Copied sheet' } },
          ],
        },
      });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      {
        sheetsClient: { spreadsheets: { get } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    const arguments_ = {
      spreadsheetId: 'source-book',
      sheetId: 7,
      destinationSpreadsheetId: 'destination-book',
    };
    const preflight = await gateway.inspectOperation('copy_to', arguments_, []);

    expect(preflight.affectedResources).toEqual([
      { kind: 'spreadsheet', id: 'source-book', label: 'source-book' },
      { kind: 'spreadsheet', id: 'destination-book', label: 'destination-book' },
      { kind: 'sheet', id: 'source-book:7', label: 'Sheet 7' },
    ]);
    expect(preflight.driveRevisions).toEqual({
      'source-book': '4',
      'destination-book': '8',
    });
    expect(preflight.state).toMatchObject({
      destinationMetadataState: {
        sheets: [{ properties: { sheetId: 1, title: 'Existing' } }],
      },
    });

    versions.set('destination-book', '9');
    await expect(gateway.verifyOperation('copy_to', arguments_, {}, preflight)).resolves.toBe(true);
    expect(get).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ spreadsheetId: 'destination-book' }),
      { retry: false }
    );
  });

  it('verifies an inserted worksheet from its requested post-state even when revision is unchanged', async () => {
    const { gateway, get } = verificationFixture({
      metadata: {
        sheets: [
          { properties: { sheetId: 1, title: 'Existing' } },
          {
            properties: {
              sheetId: 2,
              title: 'Created',
              index: 1,
              gridProperties: { rowCount: 25, columnCount: 6 },
            },
          },
        ],
      },
    });

    await expect(
      gateway.verifyOperation(
        'insert_sheet',
        { spreadsheetId: 'book', title: 'Created', index: 1, rowCount: 25, columnCount: 6 },
        {},
        verificationPreflight({ sheets: [{ properties: { sheetId: 1, title: 'Existing' } }] })
      )
    ).resolves.toBe(true);
    expect(get).toHaveBeenCalled();
  });

  it('verifies a created spreadsheet by reading its requested title and initial sheets', async () => {
    const { gateway } = verificationFixture({
      metadata: {
        properties: { title: 'School Records' },
        sheets: [
          {
            properties: {
              title: 'Students',
              gridProperties: { rowCount: 100, columnCount: 10 },
            },
          },
        ],
      },
    });

    await expect(
      gateway.verifyOperation(
        'create_spreadsheet',
        {
          title: 'School Records',
          sheets: [{ title: 'Students', rowCount: 100, columnCount: 10 }],
        },
        { spreadsheetId: 'created-book' },
        verificationPreflight()
      )
    ).resolves.toBe(true);
  });

  it('rejects a create response when the requested spreadsheet post-state is absent', async () => {
    const { gateway } = verificationFixture({
      metadata: { properties: { title: 'Concurrent book' }, sheets: [] },
    });

    await expect(
      gateway.verifyOperation(
        'create_spreadsheet',
        { title: 'School Records' },
        { spreadsheetId: 'created-book' },
        verificationPreflight()
      )
    ).resolves.toBe(false);
  });

  it('rejects a concurrent wrong structural change even when the Drive revision advanced', async () => {
    const { gateway } = verificationFixture({
      version: '8',
      metadata: {
        sheets: [
          { properties: { sheetId: 1, title: 'Existing' } },
          { properties: { sheetId: 2, title: 'Wrong sheet' } },
        ],
      },
    });

    await expect(
      gateway.verifyOperation(
        'insert_sheet',
        { spreadsheetId: 'book', title: 'Created' },
        {},
        verificationPreflight({ sheets: [{ properties: { sheetId: 1, title: 'Existing' } }] })
      )
    ).resolves.toBe(false);
  });

  it('rejects a structural delete when the target was already absent before the call', async () => {
    const { gateway } = verificationFixture({
      metadata: { sheets: [{ properties: { sheetId: 1, title: 'Existing' } }] },
    });

    await expect(
      gateway.verifyOperation(
        'delete_sheet',
        { spreadsheetId: 'book', sheetId: 99 },
        {},
        verificationPreflight({ sheets: [{ properties: { sheetId: 1, title: 'Existing' } }] })
      )
    ).resolves.toBe(false);
  });

  it('rejects partially applied formatting instead of accepting any revision change', async () => {
    const { gateway } = verificationFixture({
      version: '8',
      metadata: {
        sheets: [
          {
            properties: { sheetId: 1, title: 'Plan' },
            data: [
              {
                rowData: {
                  values: [
                    { userEnteredFormat: { textFormat: { bold: true } } },
                    { userEnteredFormat: { textFormat: { bold: false } } },
                  ],
                },
              },
            ],
          },
        ],
      },
    });

    await expect(
      gateway.verifyOperation(
        'format_cells',
        { spreadsheetId: 'book', range: 'Plan!A1:B1', format: { textFormat: { bold: true } } },
        {},
        verificationPreflight()
      )
    ).resolves.toBe(false);
  });

  it('accepts Google color responses that omit zero-valued channels', async () => {
    const { gateway } = verificationFixture({
      metadata: {
        sheets: [
          {
            properties: { sheetId: 1, title: 'Plan' },
            data: [
              {
                rowData: {
                  values: [{ userEnteredFormat: { backgroundColor: { red: 1 } } }],
                },
              },
            ],
          },
        ],
      },
    });

    await expect(
      gateway.verifyOperation(
        'format_cells',
        {
          spreadsheetId: 'book',
          range: 'Plan!A1',
          format: { backgroundColor: { red: 1, green: 0, blue: 0 } },
        },
        {},
        verificationPreflight()
      )
    ).resolves.toBe(true);
  });

  it('rejects a chart update whose requested chart post-state is absent', async () => {
    const { gateway } = verificationFixture({
      version: '8',
      metadata: {
        sheets: [
          {
            properties: { sheetId: 1, title: 'Plan' },
            charts: [{ chartId: 44, spec: { title: 'Concurrent title' } }],
          },
        ],
      },
    });

    await expect(
      gateway.verifyOperation(
        'update_chart',
        { spreadsheetId: 'book', chartId: 44, title: 'Requested title' },
        {},
        verificationPreflight()
      )
    ).resolves.toBe(false);
  });

  it('verifies a table update by table fields without requiring a revision delta', async () => {
    const { gateway } = verificationFixture({
      metadata: {
        sheets: [
          {
            properties: { sheetId: 1, title: 'Plan' },
            tables: [{ tableId: 'table-1', name: 'Requested name' }],
          },
        ],
      },
    });

    await expect(
      gateway.verifyOperation(
        'update_table',
        {
          spreadsheetId: 'book',
          tableId: 'table-1',
          fields: 'name',
          name: 'Requested name',
        },
        {},
        verificationPreflight()
      )
    ).resolves.toBe(true);
  });

  it('verifies validation and rejects a partially applied basic filter', async () => {
    const validation = verificationFixture({
      metadata: {
        sheets: [
          {
            properties: { sheetId: 1, title: 'Plan' },
            data: [
              {
                rowData: {
                  values: [
                    {
                      dataValidation: {
                        condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Yes' }] },
                        strict: true,
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    await expect(
      validation.gateway.verifyOperation(
        'set_data_validation',
        {
          spreadsheetId: 'book',
          range: 'Plan!A2',
          rule: {
            condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Yes' }] },
            strict: true,
          },
        },
        {},
        verificationPreflight()
      )
    ).resolves.toBe(true);

    const filter = verificationFixture({
      version: '8',
      metadata: {
        sheets: [
          {
            properties: { sheetId: 1, title: 'Plan' },
            basicFilter: { criteria: { 0: { hiddenValues: ['wrong'] } } },
          },
        ],
      },
    });
    await expect(
      filter.gateway.verifyOperation(
        'set_basic_filter',
        {
          spreadsheetId: 'book',
          range: 'Plan!A1:B9',
          criteria: { 0: { hiddenValues: ['requested'] } },
        },
        {},
        verificationPreflight()
      )
    ).resolves.toBe(false);
  });

  it('verifies append values only from the returned appended range and exact values', async () => {
    const { gateway, batchGet } = verificationFixture({ values: [['S-001', 'Asha']] });

    await expect(
      gateway.verifyOperation(
        'append_values',
        {
          spreadsheetId: 'book',
          range: 'Plan!A:B',
          values: [['S-001', 'Asha']],
        },
        { content: [{ type: 'text', text: 'Successfully appended 2 cells to range: Plan!A2:B2' }] },
        verificationPreflight()
      )
    ).resolves.toBe(true);
    expect(batchGet).toHaveBeenCalledWith(expect.objectContaining({ ranges: ['Plan!A2:B2'] }), {
      retry: false,
    });
  });

  it('retains only headers and the relevant tail as append preflight evidence', async () => {
    const rows = [
      ['Student ID', 'Name'],
      ...Array.from({ length: 20 }, (_, index) => [`S-${index + 1}`, `Student ${index + 1}`]),
    ];
    const batchGet = vi.fn().mockResolvedValue({
      data: { valueRanges: [{ range: 'Plan!A:B', values: rows }] },
    });
    const get = vi.fn().mockResolvedValue({
      data: { properties: { title: 'Plan book' }, sheets: [{ properties: { title: 'Plan' } }] },
    });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '7' }))),
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, values: { batchGet } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    const preflight = await gateway.inspectOperation(
      'append_values',
      { spreadsheetId: 'book', range: 'Plan!A:B', values: [['S-21', 'Student 21']] },
      []
    );

    expect(preflight.state).toMatchObject({
      appendEvidence: {
        range: 'Plan!A:B',
        headers: ['Student ID', 'Name'],
        tail: rows.slice(-3),
        lastRowNumber: 21,
      },
    });
    expect(preflight.state).not.toHaveProperty('valueRanges');
    expect(preflight.preview.before).toEqual({
      range: 'Plan!A:B',
      headers: ['Student ID', 'Name'],
      tail: rows.slice(-3),
      lastRowNumber: 21,
    });
  });

  it('previews the exact worksheet names removed by a batch deletion', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        sheets: [
          { properties: { sheetId: 11, title: 'Students' } },
          { properties: { sheetId: 22, title: 'Exams' } },
          { properties: { sheetId: 33, title: 'Attendance' } },
        ],
      },
    });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: '9' }), { status: 200 })),
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, values: { batchGet: vi.fn() } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    const preflight = await gateway.inspectOperation(
      'batch_delete_sheets',
      { spreadsheetId: 'school-records', sheetIds: [33, 22] },
      []
    );

    expect(preflight.preview).toEqual({
      kind: 'exact',
      before: {
        worksheets: [
          { sheetId: 33, title: 'Attendance' },
          { sheetId: 22, title: 'Exams' },
        ],
      },
      after: { deletedSheetIds: [33, 22] },
    });
  });

  it('constructs retained clients with the Desktop OAuth credential', () => {
    const sheetsClient = { spreadsheets: {} };
    const sheets = vi.spyOn(google, 'sheets').mockReturnValue(sheetsClient as any);
    const gateway = new GoogleSheetsGateway(TOKENS, 'client-id', 'client-secret', vi.fn());

    const client = gateway.getSheetsClient({ idempotent: true });

    expect(client.spreadsheets).toBeDefined();
    expect(sheets).toHaveBeenCalledWith({
      version: 'v4',
      auth: expect.any(google.auth.OAuth2),
    });
    sheets.mockRestore();
  });

  it('exposes the real googleapis resource tree without proxy invariant errors', () => {
    const gateway = new GoogleSheetsGateway(TOKENS, 'client-id', 'client-secret', vi.fn());

    expect(() => gateway.getSheetsClient({ idempotent: true }).spreadsheets.values).not.toThrow();
  });

  it('supplies the Desktop OAuth Sheets client to retained handlers', async () => {
    const get = vi.fn().mockResolvedValue({ data: { spreadsheetId: 'book' } });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      { sheetsClient: { spreadsheets: { get } } as any, authorizeSpreadsheet: async () => {} }
    );

    const response = await runWithGoogleSheetsGateway(gateway, { idempotent: true }, async () =>
      (await getAuthenticatedClient()).spreadsheets.get({ spreadsheetId: 'book' })
    );

    expect(response.data).toEqual({ spreadsheetId: 'book' });
  });

  it('retries an idempotent request after 429 and 5xx responses', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce({ code: 429, message: 'quota' })
      .mockRejectedValueOnce({ response: { status: 503 }, message: 'unavailable' })
      .mockResolvedValue({ data: { spreadsheetId: 'book' } });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      {
        sheetsClient: { spreadsheets: { get } } as any,
        sleep,
        authorizeSpreadsheet: async () => {},
      }
    );

    const response = await runWithGoogleSheetsGateway(gateway, { idempotent: true }, async () =>
      (await getAuthenticatedClient()).spreadsheets.get({ spreadsheetId: 'book' })
    );

    expect(response.data).toEqual({ spreadsheetId: 'book' });
    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('disables googleapis built-in retry for non-idempotent requests', async () => {
    const append = vi.fn().mockRejectedValue({ code: 503, message: 'unavailable' });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      {
        sheetsClient: { spreadsheets: { values: { append } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    await expect(
      runWithGoogleSheetsGateway(gateway, { idempotent: false }, async () =>
        (await getAuthenticatedClient()).spreadsheets.values.append({ spreadsheetId: 'book' })
      )
    ).rejects.toMatchObject({ code: 503 });

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith({ spreadsheetId: 'book' }, { retry: false });
  });

  it.each(['value', 'chart', 'table', 'grid'])(
    'forces reviewed %s application writes to one attempt even when the handler requests retries',
    async (family) => {
      const write = vi.fn().mockRejectedValue({ code: 503, message: 'unavailable' });
      const sheetsClient =
        family === 'value'
          ? { spreadsheets: { values: { update: write } } }
          : { spreadsheets: { batchUpdate: write } };
      const gateway = new GoogleSheetsGateway(
        TOKENS,
        'client-id',
        'client-secret',
        vi.fn(),
        fetch,
        Date.now,
        { sheetsClient, authorizeSpreadsheet: async () => {}, sleep: vi.fn() }
      );

      await expect(
        runWithGoogleSheetsGateway(gateway, { idempotent: false }, async () => {
          const client = gateway.getSheetsClient({ idempotent: true });
          return family === 'value'
            ? client.spreadsheets.values.update({ spreadsheetId: 'book' })
            : client.spreadsheets.batchUpdate({ spreadsheetId: 'book' });
        })
      ).rejects.toMatchObject({ code: 503 });
      expect(write).toHaveBeenCalledOnce();
    }
  );

  it('reads the stable Drive account identity used to protect indexed state', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ user: { permissionId: 'account-permission-1' } }), {
        status: 200,
      })
    );
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      { getSelectedFolderIds: () => ['folder-1'] }
    );

    await expect(gateway.getAccountIdentity()).resolves.toBe('account-permission-1');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      '/drive/v3/about?fields=user%28permissionId%29'
    );
  });

  it('rejects folder targets outside the selected My Drive folders before making a request', async () => {
    const fetcher = vi.fn();
    const gateway = new GoogleSheetsGateway(TOKENS, 'client-id', 'client-secret', vi.fn(), fetcher);

    await expect(
      gateway.validateSelectedMyDriveFolder('unselected-folder', ['selected-folder'])
    ).rejects.toThrow('not one of the selected My Drive folders');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects selected folder targets that belong to a Shared Drive', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'shared-folder',
          name: 'Shared',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
          driveId: 'shared-drive-1',
        }),
        { status: 200 }
      )
    );
    const gateway = new GoogleSheetsGateway(TOKENS, 'client-id', 'client-secret', vi.fn(), fetcher);

    await expect(
      gateway.validateSelectedMyDriveFolder('shared-folder', ['shared-folder'])
    ).rejects.toThrow('Shared Drive folders are not supported');
  });

  it('creates all requested worksheets, moves the workbook, and verifies My Drive placement', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'folder-1',
            name: 'Finance',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root-id'],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'root-id',
            name: 'My Drive',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            spreadsheetId: 'book-1',
            spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/book-1/edit',
            properties: { title: 'Quarterly plan' },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'book-1',
            name: 'Quarterly plan',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: ['root'],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'book-1', parents: ['folder-1'] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'book-1',
            name: 'Quarterly plan',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: ['folder-1'],
          }),
          { status: 200 }
        )
      );
    const gateway = new GoogleSheetsGateway(TOKENS, 'client-id', 'client-secret', vi.fn(), fetcher);

    const result = await gateway.createSpreadsheet(
      {
        title: 'Quarterly plan',
        folderId: 'folder-1',
        sheets: [
          { title: 'Summary', rowCount: 50, columnCount: 8 },
          { title: 'Forecast', rowCount: 200, columnCount: 12 },
        ],
      },
      ['folder-1']
    );

    expect(result).toMatchObject({ spreadsheetId: 'book-1', folderId: 'folder-1' });
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({
      properties: { title: 'Quarterly plan' },
      sheets: [
        {
          properties: {
            title: 'Summary',
            gridProperties: { rowCount: 50, columnCount: 8 },
          },
        },
        {
          properties: {
            title: 'Forecast',
            gridProperties: { rowCount: 200, columnCount: 12 },
          },
        },
      ],
    });
    const moveUrl = new URL(String(fetcher.mock.calls[4]?.[0]));
    expect(moveUrl.searchParams.get('addParents')).toBe('folder-1');
    expect(moveUrl.searchParams.get('removeParents')).toBe('root');
    expect(fetcher.mock.calls[5]?.[1]?.method).toBeUndefined();
  });

  it('returns the created spreadsheet ID when folder placement cannot be completed', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'folder-1',
            name: 'Finance',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root-id'],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'root-id',
            name: 'My Drive',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            spreadsheetId: 'created-book',
            properties: { title: 'Created once' },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'created-book',
            name: 'Created once',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: ['root-id'],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const gateway = new GoogleSheetsGateway(TOKENS, 'client-id', 'client-secret', vi.fn(), fetcher);

    await expect(
      gateway.createSpreadsheet({ title: 'Created once', folderId: 'folder-1' }, ['folder-1'])
    ).resolves.toMatchObject({
      spreadsheetId: 'created-book',
      partialCreation: true,
      placement: { status: 'unverified', error: expect.stringContaining('HTTP 503') },
    });

    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === 'PATCH')).toHaveLength(1);
  });

  it('registers a root-created spreadsheet before returning it', async () => {
    const registerCreatedSpreadsheet = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ spreadsheetId: 'root-book', properties: { title: 'Root book' } }),
          { status: 200 }
        )
      );
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      { registerCreatedSpreadsheet }
    );

    await expect(gateway.createSpreadsheet({ title: 'Root book' }, [])).resolves.toMatchObject({
      spreadsheetId: 'root-book',
    });
    expect(registerCreatedSpreadsheet).toHaveBeenCalledWith('root-book');
  });

  it('retries idempotent gateway reads but does not replay spreadsheet creation', async () => {
    const readFetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const readGateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      readFetcher,
      Date.now,
      { sleep }
    );

    await expect(readGateway.listFileGraph()).resolves.toEqual([]);
    expect(readFetcher).toHaveBeenCalledTimes(2);

    const createFetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    const createGateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      createFetcher,
      Date.now,
      { sleep }
    );
    await expect(createGateway.createSpreadsheet({ title: 'Once' }, [])).rejects.toMatchObject({
      code: 503,
    });
    expect(createFetcher).toHaveBeenCalledTimes(1);
  });

  it('does not replay the parent PATCH when moving a spreadsheet returns 503', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'folder-1',
            name: 'Finance',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root-id'],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'root-id',
            name: 'My Drive',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'book',
            name: 'Book',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: ['root-id'],
            ownedByMe: true,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const sleep = vi.fn();
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      { sleep, authorizeSpreadsheet: async () => {} }
    );

    await expect(gateway.moveSpreadsheet('book', 'folder-1', ['folder-1'])).rejects.toMatchObject({
      code: 503,
    });

    const patchCalls = fetcher.mock.calls.filter((call) => call[1]?.method === 'PATCH');
    expect(patchCalls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects moving a Shared Drive spreadsheet', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'shared-book',
          name: 'Shared workbook',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: ['shared-root'],
          driveId: 'shared-drive-1',
        }),
        { status: 200 }
      )
    );
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      { getSelectedFolderIds: () => ['folder-1'] }
    );

    await expect(gateway.moveSpreadsheet('shared-book', 'folder-1', ['folder-1'])).rejects.toThrow(
      'Shared Drive spreadsheets are not supported'
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('inserts columns relative to an anchor and writes optional values into them', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 7, title: 'Plan' } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [{}] } });
    const update = vi.fn().mockResolvedValue({ data: { updatedRange: 'Plan!C2:D3' } });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, batchUpdate, values: { update } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    const result = await gateway.insertColumns({
      spreadsheetId: 'book',
      range: 'Plan!B2',
      columns: 2,
      position: 'AFTER',
      inheritFromBefore: true,
      values: [
        ['Q1', 'Q2'],
        [10, 20],
      ],
      valueInputOption: 'USER_ENTERED',
    });

    expect(batchUpdate).toHaveBeenCalledWith(
      {
        spreadsheetId: 'book',
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: { sheetId: 7, dimension: 'COLUMNS', startIndex: 2, endIndex: 4 },
                inheritFromBefore: true,
              },
            },
            {
              pasteData: {
                coordinate: { sheetId: 7, rowIndex: 1, columnIndex: 2 },
                data: '"Q1","Q2"\r\n"10","20"',
                type: 'PASTE_NORMAL',
                delimiter: ',',
              },
            },
          ],
        },
      },
      { retry: false }
    );
    expect(update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ insertedColumns: 2, updatedRange: "'Plan'!C2:D3" });
  });

  it('preserves USER_ENTERED parsing and robust CSV cells in the atomic batch', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 7, title: 'Plan' } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [{}, {}] } });
    const update = vi.fn();
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, batchUpdate, values: { update } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    await gateway.insertColumns({
      spreadsheetId: 'book',
      range: 'Plan!A1',
      columns: 7,
      values: [
        ['001', true, '08/05/2026', '=SUM(1,2)', 'comma,value', 'quote"value', 'line1\nline2'],
      ],
      valueInputOption: 'USER_ENTERED',
    });

    expect(batchUpdate).toHaveBeenCalledOnce();
    expect(batchUpdate.mock.calls[0]?.[0].requestBody.requests[1]).toEqual({
      pasteData: {
        coordinate: { sheetId: 7, rowIndex: 0, columnIndex: 0 },
        data: '"001","TRUE","08/05/2026","=SUM(1,2)","comma,value","quote""value","line1\nline2"',
        type: 'PASTE_NORMAL',
        delimiter: ',',
      },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps RAW values exact inside the same atomic batch', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 7, title: 'Plan' } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [{}, {}] } });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, batchUpdate } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    await gateway.insertColumns({
      spreadsheetId: 'book',
      range: 'Plan!A1',
      columns: 4,
      values: [['001', true, '08/05/2026', '=1+1']],
      valueInputOption: 'RAW',
    });

    expect(batchUpdate).toHaveBeenCalledOnce();
    expect(batchUpdate.mock.calls[0]?.[0].requestBody.requests[1]).toEqual({
      updateCells: {
        start: { sheetId: 7, rowIndex: 0, columnIndex: 0 },
        rows: [
          {
            values: [
              { userEnteredValue: { stringValue: '001' } },
              { userEnteredValue: { boolValue: true } },
              { userEnteredValue: { stringValue: '08/05/2026' } },
              { userEnteredValue: { stringValue: '=1+1' } },
            ],
          },
        ],
        fields: 'userEnteredValue',
      },
    });
  });

  it('validates insert-column values before mutating the sheet', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 7, title: 'Plan' } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, batchUpdate, values: { update: vi.fn() } } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );

    await expect(
      gateway.insertColumns({
        spreadsheetId: 'book',
        range: 'Plan!B2',
        columns: 1,
        values: [['too', 'wide']],
      })
    ).rejects.toThrow('more columns than were inserted');
    expect(batchUpdate).not.toHaveBeenCalled();
  });

  it('uses Sheets batch requests for validation and basic-filter mutations', async () => {
    const get = vi.fn().mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 7, title: 'Plan' } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: { replies: [{}] } });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      {
        sheetsClient: { spreadsheets: { get, batchUpdate } } as any,
        authorizeSpreadsheet: async () => {},
      }
    );
    const rule = {
      condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Open' }] },
      strict: true,
      showCustomUi: true,
    };

    await gateway.setDataValidation({
      spreadsheetId: 'book',
      range: 'Plan!B2:B20',
      rule,
      filteredRowsIncluded: true,
    });
    await gateway.clearDataValidation({ spreadsheetId: 'book', range: 'Plan!C2:C20' });
    await gateway.setBasicFilter({
      spreadsheetId: 'book',
      range: 'Plan!A1:D20',
      sortSpecs: [{ dimensionIndex: 1, sortOrder: 'ASCENDING' }],
    });
    await gateway.clearBasicFilter({ spreadsheetId: 'book', sheetId: 7 });

    expect(batchUpdate.mock.calls.map((call) => call[0].requestBody.requests[0])).toEqual([
      {
        setDataValidation: {
          range: {
            sheetId: 7,
            startRowIndex: 1,
            endRowIndex: 20,
            startColumnIndex: 1,
            endColumnIndex: 2,
          },
          rule,
          filteredRowsIncluded: true,
        },
      },
      {
        setDataValidation: {
          range: {
            sheetId: 7,
            startRowIndex: 1,
            endRowIndex: 20,
            startColumnIndex: 2,
            endColumnIndex: 3,
          },
        },
      },
      {
        setBasicFilter: {
          filter: {
            range: {
              sheetId: 7,
              startRowIndex: 0,
              endRowIndex: 20,
              startColumnIndex: 0,
              endColumnIndex: 4,
            },
            sortSpecs: [{ dimensionIndex: 1, sortOrder: 'ASCENDING' }],
          },
        },
      },
      { clearBasicFilter: { sheetId: 7 } },
    ]);
  });
});
