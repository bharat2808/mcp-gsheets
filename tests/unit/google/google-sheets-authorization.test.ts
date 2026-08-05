import { describe, expect, it, vi } from 'vitest';

import { GoogleSheetsGateway } from '../../../src/google/google-api-client.js';
import {
  getAuthenticatedClient,
  runWithGoogleSheetsGateway,
} from '../../../src/utils/google-auth.js';

const TOKENS = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiryDate: 1_900_000_000_000,
  scope:
    'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
  tokenType: 'Bearer',
};

function gatewayOptions(options: Record<string, unknown>) {
  return options as any;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

describe('GoogleSheetsGateway spreadsheet authorization', () => {
  it('authorizes retained operations before invoking the Sheets client', async () => {
    const authorizeSpreadsheet = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({ data: { values: [] } });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      gatewayOptions({
        sheetsClient: { spreadsheets: { values: { get } } },
        authorizeSpreadsheet,
      })
    );

    await runWithGoogleSheetsGateway(gateway, { idempotent: true }, async () =>
      (await getAuthenticatedClient()).spreadsheets.values.get({
        spreadsheetId: 'source-book',
        range: 'Sheet1!A1',
      })
    );

    expect(authorizeSpreadsheet).toHaveBeenCalledWith('source-book');
    expect(authorizeSpreadsheet.mock.invocationCallOrder[0]).toBeLessThan(
      get.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
  });

  it('authorizes both source and destination spreadsheet IDs', async () => {
    const authorizeSpreadsheet = vi.fn().mockResolvedValue(undefined);
    const copyTo = vi.fn().mockResolvedValue({ data: { sheetId: 2 } });
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetch,
      Date.now,
      gatewayOptions({
        sheetsClient: { spreadsheets: { sheets: { copyTo } } },
        authorizeSpreadsheet,
      })
    );

    await runWithGoogleSheetsGateway(gateway, { idempotent: false }, async () =>
      (await getAuthenticatedClient()).spreadsheets.sheets.copyTo({
        spreadsheetId: 'source-book',
        sheetId: 1,
        destinationSpreadsheetId: 'destination-book',
      })
    );

    expect(authorizeSpreadsheet.mock.calls).toEqual([
      ['source-book'],
      ['destination-book'],
    ]);
  });

  it('authorizes new batch handlers and proposal revision reads', async () => {
    const authorizeSpreadsheet = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({
      data: { sheets: [{ properties: { sheetId: 7, title: 'Plan' } }] },
    });
    const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
    const fetcher = vi.fn().mockResolvedValue(json({ version: '9' }));
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      gatewayOptions({
        sheetsClient: { spreadsheets: { get, batchUpdate } },
        authorizeSpreadsheet,
      })
    );

    await gateway.setDataValidation({
      spreadsheetId: 'new-handler-book',
      range: 'Plan!A2:A9',
      rule: { condition: { type: 'NUMBER_GREATER', values: [{ userEnteredValue: '0' }] } },
    });
    await gateway.getRevision('proposal-book');

    expect(authorizeSpreadsheet).toHaveBeenCalledWith('new-handler-book');
    expect(authorizeSpreadsheet).toHaveBeenCalledWith('proposal-book');
  });

  it('allows an owned spreadsheet only when its ancestry reaches a selected My Drive folder', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          id: 'book',
          name: 'Book',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: ['child'],
          ownedByMe: true,
        })
      )
      .mockResolvedValueOnce(
        json({
          id: 'root-id',
          name: 'My Drive',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
          ownedByMe: true,
        })
      )
      .mockResolvedValueOnce(
        json({
          id: 'child',
          name: 'Child',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['selected'],
          ownedByMe: true,
        })
      )
      .mockResolvedValueOnce(
        json({
          id: 'selected',
          name: 'Selected',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root-id'],
          ownedByMe: true,
        })
      );
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      gatewayOptions({ getSelectedFolderIds: () => ['selected'] })
    );

    await expect(gateway.authorizeSpreadsheet('book')).resolves.toBeUndefined();
  });

  it('rejects owned spreadsheets outside every selected folder tree', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          id: 'book',
          name: 'Book',
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: ['other'],
          ownedByMe: true,
        })
      )
      .mockResolvedValueOnce(
        json({
          id: 'root-id',
          name: 'My Drive',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [],
          ownedByMe: true,
        })
      )
      .mockResolvedValueOnce(
        json({
          id: 'other',
          name: 'Other',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root-id'],
          ownedByMe: true,
        })
      );
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      gatewayOptions({ getSelectedFolderIds: () => ['selected'] })
    );

    await expect(gateway.authorizeSpreadsheet('book')).rejects.toThrow(
      'not inside a selected My Drive folder'
    );
  });

  it.each([
    ['Shared-with-me', { ownedByMe: false }],
    ['Shared Drive', { ownedByMe: true, driveId: 'shared-drive-1' }],
  ])('rejects %s spreadsheet resources', async (_label, ownership) => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        id: 'book',
        name: 'Book',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: ['selected'],
        ...ownership,
      })
    );
    const gateway = new GoogleSheetsGateway(
      TOKENS,
      'client-id',
      'client-secret',
      vi.fn(),
      fetcher,
      Date.now,
      gatewayOptions({ getSelectedFolderIds: () => ['selected'] })
    );

    await expect(gateway.authorizeSpreadsheet('book')).rejects.toThrow(/not owned|Shared Drive/u);
  });

  it('rejects driveId-absent Shared-with-me folders as My Drive selections', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        id: 'shared-folder',
        name: 'Shared folder',
        mimeType: 'application/vnd.google-apps.folder',
        parents: [],
        ownedByMe: false,
      })
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
    ).rejects.toThrow('not owned by the authenticated account');
  });
});
