import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { createSmokeChildEnvironment } from '../../scripts/smoke-child-environment.mjs';

const execFileAsync = promisify(execFile);

describe('built MCP smoke child environment', () => {
  it('does not expose parent OAuth, token, or data-directory credentials to the child', async () => {
    const environment = createSmokeChildEnvironment(
      {
        PATH: process.env.PATH,
        GSHEETS_GOOGLE_CLIENT_ID: 'parent-client.apps.googleusercontent.com',
        GSHEETS_GOOGLE_CLIENT_SECRET: 'parent-client-secret',
        GSHEETS_OAUTH_ACCESS_TOKEN: 'parent-access-token',
        GSHEETS_OAUTH_REFRESH_TOKEN: 'parent-refresh-token',
        GSHEETS_DATA_DIR: '/parent/private/profile',
        GOOGLE_APPLICATION_CREDENTIALS: '/parent/google-credentials.json',
      },
      '/tmp/isolated-smoke-profile',
      'gsheets-smoke-4d89',
      { GSHEETS_TOOL_CATEGORIES: 'all' }
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: environment }
    );
    const childEnvironment = JSON.parse(stdout) as Record<string, string>;

    expect(childEnvironment).toMatchObject({
      NODE_ENV: 'test',
      GSHEETS_DATA_DIR: '/tmp/isolated-smoke-profile',
      GSHEETS_TEST_CREDENTIAL_SERVICE: 'gsheets-smoke-4d89',
      GSHEETS_TOOL_CATEGORIES: 'all',
    });
    expect(childEnvironment.GSHEETS_GOOGLE_CLIENT_ID).toBeUndefined();
    expect(childEnvironment.GSHEETS_GOOGLE_CLIENT_SECRET).toBeUndefined();
    expect(childEnvironment.GSHEETS_OAUTH_ACCESS_TOKEN).toBeUndefined();
    expect(childEnvironment.GSHEETS_OAUTH_REFRESH_TOKEN).toBeUndefined();
    expect(childEnvironment.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(Object.values(childEnvironment)).not.toContain('/parent/private/profile');
  });
});
