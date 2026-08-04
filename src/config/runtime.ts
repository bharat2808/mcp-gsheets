import { homedir, platform } from 'node:os';
import { posix, win32 } from 'node:path';

export const PUBLISHER_GOOGLE_CLIENT_ID = '';

export function googleClientId(): string {
  return process.env.GSHEETS_GOOGLE_CLIENT_ID?.trim() || PUBLISHER_GOOGLE_CLIENT_ID;
}

export function resolveDataDirectory(
  operatingSystem: NodeJS.Platform,
  environment: Readonly<Record<string, string | undefined>>,
  userHome: string
): string {
  if (environment.GSHEETS_DATA_DIR) {
    return environment.GSHEETS_DATA_DIR;
  }
  if (operatingSystem === 'win32') {
    return win32.join(environment.APPDATA ?? userHome, 'gsheets');
  }
  if (operatingSystem === 'darwin') {
    return posix.join(userHome, 'Library', 'Application Support', 'gsheets');
  }
  return posix.join(
    environment.XDG_DATA_HOME ?? posix.join(userHome, '.local', 'share'),
    'gsheets'
  );
}

export function dataDirectory(): string {
  return resolveDataDirectory(platform(), process.env, homedir());
}
