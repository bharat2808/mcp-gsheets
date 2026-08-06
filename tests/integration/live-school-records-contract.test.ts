import { describe, expect, it } from 'vitest';

import {
  SCHOOL_RECORDS_FLOW,
  resolveLiveTestConfiguration,
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
});
