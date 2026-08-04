import { describe, expect, it } from 'vitest';

import {
  buildGoogleAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseOAuthCallback,
  toStoredTokenSet,
} from '../../../src/auth/google-oauth.js';

describe('Google desktop OAuth', () => {
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

  it('exchanges the code with PKCE and no embedded client secret', async () => {
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
        code: 'authorization-code',
        verifier: 'verifier',
        redirectUri: 'http://127.0.0.1:5555/oauth/callback',
      },
      fetcher,
      1_700_000_000_000
    );

    const params = new URLSearchParams(body);
    expect(params.get('code_verifier')).toBe('verifier');
    expect(params.has('client_secret')).toBe(false);
    expect(tokens.refreshToken).toBe('refresh');
  });
});
