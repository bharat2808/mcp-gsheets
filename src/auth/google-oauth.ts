import { createHash, randomBytes } from 'node:crypto';

import { OAuthTokenSet } from './credential-vault.js';

export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
] as const;

export function missingGoogleOAuthScopes(scope: string): string[] {
  const granted = new Set(scope.split(/\s+/u).filter(Boolean));
  return GOOGLE_OAUTH_SCOPES.filter((required) => !granted.has(required));
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export interface AuthorizationUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}

export interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface AuthorizationCodeExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  redirectUri: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function buildGoogleAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export function parseOAuthCallback(url: URL, expectedState: string): string {
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`Google OAuth failed: ${error}`);
  }
  if (url.searchParams.get('state') !== expectedState) {
    throw new Error('Google OAuth callback state did not match');
  }
  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error('Google OAuth callback did not contain an authorization code');
  }
  return code;
}

export function toStoredTokenSet(response: GoogleTokenResponse, now = Date.now()): OAuthTokenSet {
  if (!response.access_token) {
    throw new Error('Google OAuth did not return an access token');
  }
  if (!response.refresh_token) {
    throw new Error('Google OAuth did not return a refresh token');
  }
  if (!response.expires_in) {
    throw new Error('Google OAuth did not return an expiry');
  }

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiryDate: now + response.expires_in * 1000,
    scope: response.scope ?? GOOGLE_OAUTH_SCOPES.join(' '),
    tokenType: response.token_type ?? 'Bearer',
  };
}

export async function exchangeAuthorizationCode(
  input: AuthorizationCodeExchangeInput,
  fetcher: typeof fetch = fetch,
  now = Date.now()
): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errorBody = (await response.json()) as {
        error?: unknown;
        error_description?: unknown;
      };
      if (typeof errorBody.error === 'string') {
        detail = errorBody.error;
        if (typeof errorBody.error_description === 'string') {
          detail += `: ${errorBody.error_description}`;
        }
      }
    } catch {
      // Keep the status-only fallback for non-JSON provider responses.
    }
    for (const sensitive of [input.clientSecret, input.code, input.verifier]) {
      if (sensitive) {
        detail = detail.replaceAll(sensitive, '[redacted]');
      }
    }
    throw new Error(`Google OAuth token exchange failed: ${detail}`);
  }
  return toStoredTokenSet((await response.json()) as GoogleTokenResponse, now);
}
