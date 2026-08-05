import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const GOOGLE_CLIENT_ID_PATTERN = /^[a-z0-9_-]+\.apps\.googleusercontent\.com$/u;

interface LocalGSheetsConfig {
  googleOAuthClientId?: unknown;
  [key: string]: unknown;
}

export type GoogleOAuthClientIdSource = 'environment' | 'local_config' | 'publisher' | 'missing';

export interface ResolvedGoogleOAuthClientId {
  clientId: string;
  source: GoogleOAuthClientIdSource;
}

export interface ResolveGoogleOAuthClientIdOptions {
  environment: Readonly<Record<string, string | undefined>>;
  configPath: string;
  publisherClientId: string;
}

export function validateGoogleOAuthClientId(value: string): string {
  const normalized = value.trim();
  if (!GOOGLE_CLIENT_ID_PATTERN.test(normalized)) {
    throw new Error(
      'Google OAuth client ID format must end in .apps.googleusercontent.com; verify in Google Cloud that it is a Desktop app client'
    );
  }
  return normalized;
}

async function readLocalConfig(path: string): Promise<LocalGSheetsConfig | null> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed as LocalGSheetsConfig;
  } catch (error) {
    throw new Error(
      `Local GSheets configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export async function loadLocalGoogleOAuthClientId(path: string): Promise<string | null> {
  const config = await readLocalConfig(path);
  if (config?.googleOAuthClientId === undefined) {
    return null;
  }
  if (typeof config.googleOAuthClientId !== 'string') {
    throw new Error('Local GSheets configuration is invalid: googleOAuthClientId must be a string');
  }
  return validateGoogleOAuthClientId(config.googleOAuthClientId);
}

export async function saveLocalGoogleOAuthClientId(clientId: string, path: string): Promise<void> {
  const normalized = validateGoogleOAuthClientId(clientId);
  const existing = (await readLocalConfig(path)) ?? {};
  const next = `${JSON.stringify({ ...existing, googleOAuthClientId: normalized }, null, 2)}\n`;
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, next, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function resolveGoogleOAuthClientId(
  options: ResolveGoogleOAuthClientIdOptions
): Promise<ResolvedGoogleOAuthClientId> {
  const environmentClientId = options.environment.GSHEETS_GOOGLE_CLIENT_ID?.trim();
  if (environmentClientId) {
    return { clientId: validateGoogleOAuthClientId(environmentClientId), source: 'environment' };
  }

  const localClientId = await loadLocalGoogleOAuthClientId(options.configPath);
  if (localClientId) {
    return { clientId: localClientId, source: 'local_config' };
  }

  const publisherClientId = options.publisherClientId.trim();
  if (publisherClientId) {
    return { clientId: validateGoogleOAuthClientId(publisherClientId), source: 'publisher' };
  }

  return { clientId: '', source: 'missing' };
}
