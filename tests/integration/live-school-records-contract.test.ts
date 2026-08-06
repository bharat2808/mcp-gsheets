import { describe, expect, it, vi } from 'vitest';

import {
  SCHOOL_RECORDS_FLOW,
  createDisposableWorkbook,
  createSchoolRecordsRunIdentity,
  resolveLiveTestConfiguration,
  trashWorkbook,
} from '../../scripts/live-school-records.js';

describe('School Records live integration contract', () => {
  it('defaults to a non-secret dry run with the complete disposable workbook lifecycle', () => {
    expect(resolveLiveTestConfiguration({})).toEqual({ mode: 'dry-run' });
    expect(SCHOOL_RECORDS_FLOW.workbookTitle).toBe('School Records');
    expect(SCHOOL_RECORDS_FLOW.worksheets.map((sheet) => sheet.title)).toEqual([
      'Students',
      'Exams',
      'Attendance',
    ]);
    expect(SCHOOL_RECORDS_FLOW.coverage).toEqual([
      'selected-folder creation',
      'headers',
      'reviewed rows',
      'formula review',
      'reads and search',
      'safe formatting, chart, and table work',
      'destructive cancel and approve',
      'revisions, audits, and index refresh',
      'workbook disposal',
      'reviewed sign-out',
    ]);
  });

  it('requires an explicit gate, isolated data directory, and selected folder for live mode', () => {
    expect(() => resolveLiveTestConfiguration({ GSHEETS_LIVE_TEST: '1' })).toThrow(
      'GSHEETS_LIVE_DATA_DIR and GSHEETS_LIVE_FOLDER_ID'
    );
    expect(
      resolveLiveTestConfiguration({
        GSHEETS_LIVE_TEST: '1',
        GSHEETS_LIVE_DATA_DIR: '/tmp/gsheets-live-profile',
        GSHEETS_LIVE_FOLDER_ID: 'selected-folder',
      })
    ).toEqual({
      mode: 'live',
      dataDirectory: '/tmp/gsheets-live-profile',
      folderId: 'selected-folder',
    });
  });

  it('uses a cryptographically unique marker in every disposable workbook title', () => {
    const first = createSchoolRecordsRunIdentity();
    const second = createSchoolRecordsRunIdentity();

    expect(first.title).toMatch(/^School Records \[[0-9a-f-]{36}\]$/u);
    expect(second.title).toMatch(/^School Records \[[0-9a-f-]{36}\]$/u);
    expect(second.marker).not.toBe(first.marker);
  });

  it('recovers the unique owned recent workbook when creation applied but its response was lost', async () => {
    let requestedUrl = '';
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          files: [
            {
              id: 'recovered-sheet',
              name: 'School Records [run-marker]',
              createdTime: '2026-08-06T12:00:01.000Z',
              trashed: false,
              ownedByMe: true,
            },
          ],
        })
      );
    }) as unknown as typeof fetch;

    await expect(
      createDisposableWorkbook({
        identity: {
          marker: 'run-marker',
          title: 'School Records [run-marker]',
          createdAfter: '2026-08-06T12:00:00.000Z',
        },
        create: async () => {
          throw new Error('MCP response stream closed');
        },
        accessToken: 'isolated-token',
        fetcher,
      })
    ).resolves.toBe('recovered-sheet');
    expect(new URL(requestedUrl).searchParams.get('q')).toBe(
      "name = 'School Records [run-marker]' and 'me' in owners and trashed = false and createdTime >= '2026-08-06T12:00:00.000Z'"
    );
  });

  it('rejects cleanup when Drive returns a different file id', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ id: 'different-sheet', trashed: true }))
    ) as unknown as typeof fetch;

    const cleanup = trashWorkbook({
      spreadsheetId: 'expected-sheet',
      accessToken: 'isolated-token',
      fetcher,
    });

    await expect(cleanup).rejects.toThrow('expected-sheet');
    await expect(cleanup).rejects.toThrow('different-sheet');
  });

  it('rejects cleanup when Drive does not confirm trashed true', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ id: 'expected-sheet', trashed: false }))
    ) as unknown as typeof fetch;

    await expect(
      trashWorkbook({
        spreadsheetId: 'expected-sheet',
        accessToken: 'isolated-token',
        fetcher,
      })
    ).rejects.toThrow('trashed=true');
  });

  it('retains the workbook id when Drive returns an invalid cleanup response', async () => {
    const fetcher = vi.fn(async () => new Response('not-json')) as unknown as typeof fetch;

    await expect(
      trashWorkbook({
        spreadsheetId: 'retained-sheet',
        accessToken: 'isolated-token',
        fetcher,
      })
    ).rejects.toThrow(/retained-sheet.*invalid response/iu);
  });

  it('reports every candidate id when response-loss recovery is ambiguous', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            files: [
              {
                id: 'candidate-a',
                name: 'School Records [run-marker]',
                createdTime: '2026-08-06T12:00:01.000Z',
                trashed: false,
                ownedByMe: true,
              },
              {
                id: 'candidate-b',
                name: 'School Records [run-marker]',
                createdTime: '2026-08-06T12:00:02.000Z',
                trashed: false,
                ownedByMe: true,
              },
            ],
          })
        )
    ) as unknown as typeof fetch;

    await expect(
      createDisposableWorkbook({
        identity: {
          marker: 'run-marker',
          title: 'School Records [run-marker]',
          createdAfter: '2026-08-06T12:00:00.000Z',
        },
        create: async () => {
          throw new Error('MCP response stream closed');
        },
        accessToken: 'isolated-token',
        fetcher,
      })
    ).rejects.toThrow(/candidate-a, candidate-b/u);
  });
});
