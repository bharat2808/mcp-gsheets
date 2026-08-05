import { describe, expect, it, vi } from 'vitest';

import { GoogleApiClient } from '../../../src/google/google-api-client.js';

describe('GoogleApiClient', () => {
  it('uses the configured client secret when refreshing an expired token', async () => {
    let refreshBody = '';
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        refreshBody = String(init?.body);
        return new Response(JSON.stringify({ access_token: 'next', expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    };
    const client = new GoogleApiClient(
      {
        accessToken: 'expired',
        refreshToken: 'refresh',
        expiryDate: 0,
        scope: '',
        tokenType: 'Bearer',
      },
      'client-id',
      'GOCSPX-secret',
      vi.fn(),
      fetcher,
      () => 1_700_000_000_000
    );

    await client.listFileGraph();

    expect(new URLSearchParams(refreshBody).get('client_secret')).toBe('GOCSPX-secret');
  });

  it('lists only non-trashed My Drive files and follows pagination', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              { id: 'one', name: 'One', mimeType: 'x', parents: [] },
              {
                id: 'shared',
                name: 'Shared drive file',
                mimeType: 'x',
                parents: [],
                driveId: 'drive-1',
              },
            ],
            nextPageToken: 'next',
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ files: [{ id: 'two', name: 'Two', mimeType: 'x', parents: [] }] }),
          { status: 200 }
        )
      );
    const client = new GoogleApiClient(
      {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiryDate: Date.now() + 600_000,
        scope: '',
        tokenType: 'Bearer',
      },
      'client',
      'GOCSPX-secret',
      vi.fn(),
      fetcher
    );

    const files = await client.listFileGraph();

    expect(files.map((file) => file.id)).toEqual(['one', 'two']);
    const firstUrl = new URL(fetcher.mock.calls[0]?.[0] as string);
    expect(firstUrl.searchParams.get('corpora')).toBe('user');
    expect(firstUrl.searchParams.get('q')).toBe('trashed = false');
  });

  it('uses the append response range and verifies the written row', async () => {
    const metadata = { sheets: [{ properties: { sheetId: 1, title: 'Ledger' }, tables: [] }] };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [
              ['ID', 'Customer'],
              ['A-1', 'Acme'],
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [
              ['ID', 'Customer'],
              ['A-1', 'Acme'],
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ updates: { updatedRange: 'Ledger!A3:B3' } }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [
              ['ID', 'Customer'],
              ['A-1', 'Acme'],
              ['A-2', 'Ravi'],
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [
              ['ID', 'Customer'],
              ['A-1', 'Acme'],
              ['A-2', 'Ravi'],
            ],
          }),
          { status: 200 }
        )
      );
    const client = new GoogleApiClient(
      {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiryDate: Date.now() + 600_000,
        scope: '',
        tokenType: 'Bearer',
      },
      'client',
      'GOCSPX-secret',
      vi.fn(),
      fetcher
    );

    await expect(
      client.apply({
        id: 'proposal',
        spreadsheetId: 'book',
        spreadsheetName: 'Accounts',
        spreadsheetPath: '/Finance/Accounts',
        sheetId: 1,
        sheetTitle: 'Ledger',
        operation: 'append',
        values: { ID: 'A-2', Customer: 'Ravi' },
        baseRevision: '1',
        status: 'pending',
        createdAt: '2026-08-05T00:00:00Z',
        expiresAt: '2026-08-05T00:15:00Z',
        visuallyConfirmed: true,
      })
    ).resolves.toEqual({ updatedRange: 'Ledger!A3:B3', verified: true });
  });

  it('uses raw values for preflight while retaining formatted values for indexing', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ sheets: [{ properties: { sheetId: 1, title: 'Ledger' } }] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [
              ['ID', 'Amount'],
              ['A-1', '₹4,280'],
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            values: [
              ['ID', 'Amount'],
              ['A-1', 4280],
            ],
          }),
          { status: 200 }
        )
      );
    const client = new GoogleApiClient(
      {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiryDate: Date.now() + 600_000,
        scope: '',
        tokenType: 'Bearer',
      },
      'client',
      'GOCSPX-secret',
      vi.fn(),
      fetcher
    );

    await expect(
      client.readRow({
        id: 'proposal',
        spreadsheetId: 'book',
        spreadsheetName: 'Accounts',
        spreadsheetPath: '/Finance/Accounts',
        sheetId: 1,
        sheetTitle: 'Ledger',
        operation: 'update',
        rowNumber: 2,
        values: { Amount: 5000 },
        expectedValues: { Amount: 4280 },
        baseRevision: '1',
        status: 'pending',
        createdAt: '2026-08-05T00:00:00Z',
        expiresAt: '2026-08-05T00:15:00Z',
        visuallyConfirmed: true,
      })
    ).resolves.toEqual({ Amount: 4280 });
  });

  it('updates only proposed cells so untouched formulas are preserved', async () => {
    const metadata = { sheets: [{ properties: { sheetId: 1, title: 'Ledger' } }] };
    const before = {
      values: [
        ['ID', 'Amount', 'Formula'],
        ['A-1', 4280, 8560],
      ],
    };
    const after = {
      values: [
        ['ID', 'Amount', 'Formula'],
        ['A-1', 5000, 10000],
      ],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(before), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(before), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ responses: [{ updatedRange: 'Ledger!B2' }] }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(after), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(after), { status: 200 }));
    const client = new GoogleApiClient(
      {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiryDate: Date.now() + 600_000,
        scope: '',
        tokenType: 'Bearer',
      },
      'client',
      'GOCSPX-secret',
      vi.fn(),
      fetcher
    );

    await client.apply({
      id: 'proposal',
      spreadsheetId: 'book',
      spreadsheetName: 'Accounts',
      spreadsheetPath: '/Finance/Accounts',
      sheetId: 1,
      sheetTitle: 'Ledger',
      operation: 'update',
      rowNumber: 2,
      values: { Amount: 5000 },
      expectedValues: { Amount: 4280 },
      baseRevision: '1',
      status: 'pending',
      createdAt: '2026-08-05T00:00:00Z',
      expiresAt: '2026-08-05T00:15:00Z',
      visuallyConfirmed: true,
    });

    const writeUrl = String(fetcher.mock.calls[3]?.[0]);
    const writeBody = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body));
    expect(writeUrl).toContain('/values:batchUpdate');
    expect(writeBody.data).toEqual([{ range: "'Ledger'!B2", values: [[5000]] }]);
  });
});
