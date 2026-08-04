import { describe, expect, it } from 'vitest';

import { resolveDataDirectory } from '../../../src/config/runtime.js';

describe('cross-platform data directory', () => {
  it('uses native application-data locations on all desktop operating systems', () => {
    expect(resolveDataDirectory('darwin', {}, '/Users/test')).toBe(
      '/Users/test/Library/Application Support/gsheets'
    );
    expect(
      resolveDataDirectory(
        'win32',
        { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
        'C:\\Users\\test'
      )
    ).toBe('C:\\Users\\test\\AppData\\Roaming\\gsheets');
    expect(resolveDataDirectory('linux', { XDG_DATA_HOME: '/home/test/.data' }, '/home/test')).toBe(
      '/home/test/.data/gsheets'
    );
  });

  it('honors an explicit data directory on every platform', () => {
    expect(
      resolveDataDirectory('win32', { GSHEETS_DATA_DIR: 'D:\\Private\\Sheets' }, 'ignored')
    ).toBe('D:\\Private\\Sheets');
  });
});
