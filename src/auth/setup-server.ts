import { randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:http';

import { CredentialVault, OAuthTokenSet } from './credential-vault.js';
import {
  buildGoogleAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  missingGoogleOAuthScopes,
  parseOAuthCallback,
} from './google-oauth.js';
import { DRIVE_FOLDER_MIME_TYPE } from '../drive/catalog.js';
import { validateGoogleOAuthClientId } from '../config/google-oauth-client.js';
import { GoogleSheetsGateway } from '../google/google-api-client.js';

export interface GoogleOAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface SetupServerOptions {
  vault: CredentialVault;
  getClientCredentials(): Promise<GoogleOAuthClientCredentials | null>;
  saveClientCredentials(credentials: GoogleOAuthClientCredentials): Promise<void>;
  getSelectedFolderIds(): string[];
  setSelectedFolderIds(ids: string[]): void | Promise<void>;
  onConnected(tokens: OAuthTokenSet): Promise<void>;
}

export interface OAuthSetupServerHandle {
  start(): Promise<string>;
  stop(): void;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/gu,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character
  );
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GSheets setup</title><style>body{font:16px system-ui;max-width:760px;margin:48px auto;padding:0 20px;color:#202124}h1{color:#0f9d58}a,button{background:#0f9d58;color:white;border:0;border-radius:8px;padding:10px 16px;text-decoration:none;cursor:pointer}.folder{display:block;padding:10px 0}small{color:#5f6368}</style></head><body>${body}</body></html>`;
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
} as const;

export class OAuthSetupServer implements OAuthSetupServerHandle {
  #server: Server | null = null;
  #setupUrl: string | null = null;
  #state: string | null = null;
  #verifier: string | null = null;
  #oauthCredentials: GoogleOAuthClientCredentials | null = null;
  readonly #formToken = randomBytes(24).toString('base64url');

  constructor(private readonly options: SetupServerOptions) {}

  async start(): Promise<string> {
    if (this.#setupUrl) {
      return this.#setupUrl;
    }
    this.#server = createServer((request, response) => {
      void this.#handle(request.url ?? '/', request.method ?? 'GET', request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once('error', reject);
      this.#server?.listen(0, '127.0.0.1', resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not start the local setup server');
    }
    this.#setupUrl = `http://127.0.0.1:${address.port}`;
    return this.#setupUrl;
  }

  stop(): void {
    this.#server?.close();
    this.#server = null;
    this.#setupUrl = null;
  }

  async #handle(
    rawUrl: string,
    method: string,
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse
  ): Promise<void> {
    try {
      const base = this.#setupUrl ?? 'http://127.0.0.1';
      const url = new URL(rawUrl, base);
      if (url.pathname === '/oauth/start') {
        return await this.#startOAuth(response);
      }
      if (url.pathname === '/oauth/callback') {
        return await this.#finishOAuth(url, response);
      }
      if (url.pathname === '/folders' && method === 'POST') {
        return await this.#saveFolders(request, response);
      }
      if (url.pathname === '/credentials' && method === 'POST') {
        return await this.#saveCredentials(request, response);
      }
      return await this.#home(response);
    } catch (error) {
      response.writeHead(500, HTML_HEADERS);
      response.end(
        page(
          `<h1>Setup error</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`
        )
      );
    }
  }

  async #startOAuth(response: import('node:http').ServerResponse): Promise<void> {
    const credentials = await this.options.getClientCredentials();
    if (!credentials) {
      throw new Error('Google OAuth client credentials are not configured');
    }
    const pair = createPkcePair();
    this.#state = randomBytes(24).toString('base64url');
    this.#verifier = pair.verifier;
    this.#oauthCredentials = credentials;
    const target = buildGoogleAuthorizationUrl({
      clientId: credentials.clientId,
      redirectUri: `${this.#setupUrl}/oauth/callback`,
      state: this.#state,
      challenge: pair.challenge,
    });
    response.writeHead(302, { ...HTML_HEADERS, location: target });
    response.end();
  }

  async #finishOAuth(url: URL, response: import('node:http').ServerResponse): Promise<void> {
    if (!this.#state || !this.#verifier || !this.#oauthCredentials) {
      throw new Error('OAuth setup session is missing');
    }
    const code = parseOAuthCallback(url, this.#state);
    const tokens = await exchangeAuthorizationCode({
      clientId: this.#oauthCredentials.clientId,
      clientSecret: this.#oauthCredentials.clientSecret,
      code,
      verifier: this.#verifier,
      redirectUri: `${this.#setupUrl}/oauth/callback`,
    });
    await this.options.vault.saveTokens(tokens);
    await this.options.onConnected(tokens);
    this.#state = null;
    this.#verifier = null;
    this.#oauthCredentials = null;
    response.writeHead(302, { ...HTML_HEADERS, location: this.#setupUrl ?? '/' });
    response.end();
  }

  async #home(response: import('node:http').ServerResponse): Promise<void> {
    const credentials = await this.options.getClientCredentials();
    const tokens = await this.options.vault.loadTokens();
    let body: string;
    if (!credentials) {
      body = `<h1>Configure Google OAuth</h1><p>Enter the credentials for a Google Desktop OAuth client. The client secret is stored in your operating system credential store.</p><form method="post" action="/credentials"><input type="hidden" name="token" value="${this.#formToken}"><label class="folder">Client ID <input required name="clientId" autocomplete="username"></label><label class="folder">Client secret <input required type="password" name="clientSecret" autocomplete="current-password"></label><button type="submit">Save credentials</button></form>`;
    } else if (!tokens || missingGoogleOAuthScopes(tokens.scope).length > 0) {
      body = tokens
        ? '<h1>Reconnect Google</h1><p>Google needs renewed consent for Drive file operations. Your encrypted local catalog is preserved.</p><p><a href="/oauth/start">Continue with Google</a></p>'
        : '<h1>Connect Google Sheets</h1><p>Sign in with Google, then choose the My Drive folders this plugin may index.</p><p><a href="/oauth/start">Continue with Google</a></p>';
    } else {
      const client = new GoogleSheetsGateway(
        tokens,
        credentials.clientId,
        credentials.clientSecret,
        (next) => this.options.vault.saveTokens(next)
      );
      const folders = (await client.listFileGraph())
        .filter((file) => file.mimeType === DRIVE_FOLDER_MIME_TYPE)
        .sort((first, second) => first.name.localeCompare(second.name));
      const selected = new Set(this.options.getSelectedFolderIds());
      body = `<h1>Choose My Drive folders</h1><p><small>Only Google Sheets beneath these folders are indexed. Shared drives are excluded.</small></p><form method="post" action="/folders"><input type="hidden" name="token" value="${this.#formToken}">${folders.map((folder) => `<label class="folder"><input type="checkbox" name="folder" value="${escapeHtml(folder.id)}" ${selected.has(folder.id) ? 'checked' : ''}> ${escapeHtml(folder.name)}</label>`).join('')}<button type="submit">Save folders</button></form>`;
    }
    response.writeHead(200, HTML_HEADERS);
    response.end(page(body));
  }

  async #saveCredentials(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse
  ): Promise<void> {
    const form = await this.#readForm(request);
    if (form.get('token') !== this.#formToken) {
      throw new Error('Invalid setup form token');
    }
    const clientId = validateGoogleOAuthClientId(form.get('clientId') ?? '');
    const clientSecret = (form.get('clientSecret') ?? '').trim();
    if (!clientSecret) {
      throw new Error('Google OAuth client secret is required');
    }
    await this.options.saveClientCredentials({ clientId, clientSecret });
    this.#state = null;
    this.#verifier = null;
    this.#oauthCredentials = null;
    response.writeHead(303, { ...HTML_HEADERS, location: this.#setupUrl ?? '/' });
    response.end();
  }

  async #saveFolders(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse
  ): Promise<void> {
    const form = await this.#readForm(request);
    if (form.get('token') !== this.#formToken) {
      throw new Error('Invalid setup form token');
    }
    const ids = form.getAll('folder');
    await this.options.setSelectedFolderIds(ids);
    const tokens = await this.options.vault.loadTokens();
    if (tokens) {
      await this.options.onConnected(tokens);
    }
    response.writeHead(200, HTML_HEADERS);
    response.end(
      page(
        '<h1>Connected</h1><p>Your selected Google Sheets are being indexed. You can close this tab.</p>'
      )
    );
  }

  async #readForm(request: import('node:http').IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }
}
