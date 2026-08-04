import { describe, expect, it, vi } from 'vitest';

import { GoogleApiClient } from '../../../src/google/google-api-client.js';

describe('GoogleApiClient', () => {
  it('lists only non-trashed My Drive files and follows pagination', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'one', name: 'One', mimeType: 'x', parents: [] }, { id: 'shared', name: 'Shared drive file', mimeType: 'x', parents: [], driveId: 'drive-1' }], nextPageToken: 'next' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: 'two', name: 'Two', mimeType: 'x', parents: [] }] }), { status: 200 }));
    const client = new GoogleApiClient({ accessToken: 'token', refreshToken: 'refresh', expiryDate: Date.now() + 600_000, scope: '', tokenType: 'Bearer' }, 'client', vi.fn(), fetcher);

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ values: [['ID', 'Customer'], ['A-1', 'Acme']] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ updates: { updatedRange: 'Ledger!A3:B3' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(metadata), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ values: [['ID', 'Customer'], ['A-1', 'Acme'], ['A-2', 'Ravi']] }), { status: 200 }));
    const client = new GoogleApiClient({ accessToken: 'token', refreshToken: 'refresh', expiryDate: Date.now() + 600_000, scope: '', tokenType: 'Bearer' }, 'client', vi.fn(), fetcher);

    await expect(client.apply({
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
    })).resolves.toEqual({ updatedRange: 'Ledger!A3:B3', verified: true });
  });
});
