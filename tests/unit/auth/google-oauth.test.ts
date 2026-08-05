import { describe, expect, it } from 'vitest';

import {
  GOOGLE_OAUTH_SCOPES,
  buildGoogleAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseOAuthCallback,
  missingGoogleOAuthScopes,
  toStoredTokenSet,
} from '../../../src/auth/google-oauth.js';

describe('Google desktop OAuth', () => {
  it('requires drive.file and reports it as a re-consent gap for legacy tokens', () => {
    expect(GOOGLE_OAUTH_SCOPES).toContain('https://www.googleapis.com/auth/drive.file');
    expect(
      missingGoogleOAuthScopes(
        'https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/spreadsheets'
      )
    ).toEqual(['https://www.googleapis.com/auth/drive.file']);
  });

  it('creates an S256 PKCE pair', () => {
    const pair = createPkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.method).toBe('S256');
  });

  it('requests offline Sheets and Drive metadata access', () => {
    const url = new URL(
      buildGoogleAuthorizationUrl({
        clientId: 'client-id',
        redirectUri: 'http://127.0.0.1:5555/oauth/callback',
        state: 'state-token',
        challenge: 'pkce-challenge',
      })
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(url.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    );
  });

  it('rejects callback state mismatches', () => {
    expect(() =>
      parseOAuthCallback(
        new URL('http://127.0.0.1/oauth/callback?code=code&state=wrong'),
        'expected'
      )
    ).toThrow(/state/i);
  });

  it('requires a refresh token for durable local login', () => {
    expect(() =>
      toStoredTokenSet({
        access_token: 'access',
        expires_in: 3600,
        scope: 'openid email',
        token_type: 'Bearer',
      })
    ).toThrow(/refresh token/i);
  });

  it('exchanges the code with PKCE and the configured client secret', async () => {
    let body = '';
    const fetcher: typeof fetch = async (_input, init) => {
      body = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'openid email',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const tokens = await exchangeAuthorizationCode(
      {
        clientId: 'client-id',
        clientSecret: 'GOCSPX-secret',
        code: 'authorization-code',
        verifier: 'verifier',
        redirectUri: 'http://127.0.0.1:5555/oauth/callback',
      },
      fetcher,
      1_700_000_000_000
    );

    const params = new URLSearchParams(body);
    expect(params.get('code_verifier')).toBe('verifier');
    expect(params.get('client_secret')).toBe('GOCSPX-secret');
    expect(tokens.refreshToken).toBe('refresh');
  });

  it('reports Google OAuth error details without reflecting request credentials', async () => {
    const fetcher: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'client_secret is missing.',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );

    const exchange = exchangeAuthorizationCode(
      {
        clientId: 'client-id',
        clientSecret: 'GOCSPX-secret',
        code: 'authorization-code',
        verifier: 'verifier',
        redirectUri: 'http://127.0.0.1:5555/oauth/callback',
      },
      fetcher
    );

    await expect(exchange).rejects.toThrow(
      'Google OAuth token exchange failed: invalid_client: client_secret is missing.'
    );
    await expect(exchange).rejects.not.toThrow('GOCSPX-secret');
  });
});
