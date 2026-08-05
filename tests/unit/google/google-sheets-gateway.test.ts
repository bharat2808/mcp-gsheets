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
  it('constructs retained clients with the Desktop OAuth credential', () => {
    const sheetsClient = { spreadsheets: {} };
    const sheets = vi.spyOn(google, 'sheets').mockReturnValue(sheetsClient as any);
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn()
    );

    const client = gateway.getSheetsClient({ idempotent: true });

    expect(client.spreadsheets).toBeDefined();
    expect(sheets).toHaveBeenCalledWith({
      version: 'v4',
      auth: expect.any(google.auth.OAuth2),
    });
    sheets.mockRestore();
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
      { sheetsClient: { spreadsheets: { get } } as any }
    );

    const response = await runWithGoogleSheetsGateway(
      gateway,
      { idempotent: true },
      async () => (await getAuthenticatedClient()).spreadsheets.get({ spreadsheetId: 'book' })
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
      { sheetsClient: { spreadsheets: { get } } as any, sleep }
    );

    const response = await runWithGoogleSheetsGateway(
      gateway,
      { idempotent: true },
      async () => (await getAuthenticatedClient()).spreadsheets.get({ spreadsheetId: 'book' })
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
      { sheetsClient: { spreadsheets: { values: { append } } } as any }
    );

    await expect(
      runWithGoogleSheetsGateway(gateway, { idempotent: false }, async () =>
        (await getAuthenticatedClient()).spreadsheets.values.append({ spreadsheetId: 'book' })
      )
    ).rejects.toMatchObject({ code: 503 });

    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith({ spreadsheetId: 'book' }, { retry: false });
  });

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
      fetcher
    );

    await expect(gateway.getAccountIdentity()).resolves.toBe('account-permission-1');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/drive/v3/about?fields=user%28permissionId%29');
  });

  it('rejects folder targets outside the selected My Drive folders before making a request', async () => {
    const fetcher = vi.fn();
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher
    );

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
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher
    );

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
            parents: ['root'],
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
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher
    );

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
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
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
    const moveUrl = new URL(String(fetcher.mock.calls[3]?.[0]));
    expect(moveUrl.searchParams.get('addParents')).toBe('folder-1');
    expect(moveUrl.searchParams.get('removeParents')).toBe('root');
    expect(fetcher.mock.calls[4]?.[1]?.method).toBeUndefined();
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

  it('rejects moving a Shared Drive spreadsheet', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'folder-1',
            name: 'Finance',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root'],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
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
      fetcher
    );

    await expect(
      gateway.moveSpreadsheet('shared-book', 'folder-1', ['folder-1'])
    ).rejects.toThrow('Shared Drive spreadsheets are not supported');
    expect(fetcher).toHaveBeenCalledTimes(2);
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
      { sheetsClient: { spreadsheets: { get, batchUpdate, values: { update } } } as any }
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
          ],
        },
      },
      { retry: false }
    );
    expect(update).toHaveBeenCalledWith(
      {
        spreadsheetId: 'book',
        range: "'Plan'!C2:D3",
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Q1', 'Q2'], [10, 20]] },
      },
      { retry: false }
    );
    expect(result).toMatchObject({ insertedColumns: 2, updatedRange: "'Plan'!C2:D3" });
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
      { sheetsClient: { spreadsheets: { get, batchUpdate, values: { update: vi.fn() } } } as any }
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
      { sheetsClient: { spreadsheets: { get, batchUpdate } } as any }
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
