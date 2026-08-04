import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const PUBLISHER_GOOGLE_CLIENT_ID = '';

export function googleClientId(): string {
  return process.env.GSHEETS_GOOGLE_CLIENT_ID?.trim() || PUBLISHER_GOOGLE_CLIENT_ID;
}

export function dataDirectory(): string {
  if (process.env.GSHEETS_DATA_DIR) {
    return process.env.GSHEETS_DATA_DIR;
  }
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? homedir(), 'gsheets');
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'gsheets');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'gsheets');
}
