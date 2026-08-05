import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  loadLocalGoogleOAuthClientId,
  resolveGoogleOAuthClientId,
  saveLocalGoogleOAuthClientId,
  validateGoogleOAuthClientId,
} from '../../../src/config/google-oauth-client.js';

const CLIENT_ID = '123456789-example.apps.googleusercontent.com';
const ENV_CLIENT_ID = '987654321-environment.apps.googleusercontent.com';
const PUBLISHER_CLIENT_ID = '555555555-publisher.apps.googleusercontent.com';

const directories: string[] = [];

async function configPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gsheets-oauth-config-'));
  directories.push(directory);
  return join(directory, 'config.json');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('Google OAuth client configuration', () => {
  it('normalizes a valid Google OAuth client ID and rejects malformed values', () => {
    expect(validateGoogleOAuthClientId(`  ${CLIENT_ID}  `)).toBe(CLIENT_ID);
    expect(() => validateGoogleOAuthClientId('not-a-google-client')).toThrow(
      'Google OAuth client ID format'
    );
  });

  it('persists the client ID in a user-only local JSON file without temporary leftovers', async () => {
    const path = await configPath();

    await saveLocalGoogleOAuthClientId(CLIENT_ID, path);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ googleOAuthClientId: CLIENT_ID });
    expect(await loadLocalGoogleOAuthClientId(path)).toBe(CLIENT_ID);
    expect(await readdir(join(path, '..'))).toEqual(['config.json']);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it('returns null when the local configuration file does not exist', async () => {
    expect(await loadLocalGoogleOAuthClientId(await configPath())).toBeNull();
  });

  it('reports malformed local configuration instead of silently ignoring it', async () => {
    const path = await configPath();
    await writeFile(path, '{broken', 'utf8');

    await expect(loadLocalGoogleOAuthClientId(path)).rejects.toThrow(
      'Local GSheets configuration is invalid'
    );
  });

  it('resolves environment, local config, and publisher IDs in that order', async () => {
    const path = await configPath();
    await saveLocalGoogleOAuthClientId(CLIENT_ID, path);

    await expect(
      resolveGoogleOAuthClientId({
        environment: { GSHEETS_GOOGLE_CLIENT_ID: ENV_CLIENT_ID },
        configPath: path,
        publisherClientId: PUBLISHER_CLIENT_ID,
      })
    ).resolves.toEqual({ clientId: ENV_CLIENT_ID, source: 'environment' });

    await expect(
      resolveGoogleOAuthClientId({
        environment: {},
        configPath: path,
        publisherClientId: PUBLISHER_CLIENT_ID,
      })
    ).resolves.toEqual({ clientId: CLIENT_ID, source: 'local_config' });

    await rm(path);
    await expect(
      resolveGoogleOAuthClientId({
        environment: {},
        configPath: path,
        publisherClientId: PUBLISHER_CLIENT_ID,
      })
    ).resolves.toEqual({ clientId: PUBLISHER_CLIENT_ID, source: 'publisher' });
  });
});
