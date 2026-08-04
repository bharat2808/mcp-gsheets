import { randomBytes } from 'node:crypto';
import { createServer, Server } from 'node:http';

import { CredentialVault, OAuthTokenSet } from './credential-vault.js';
import {
  buildGoogleAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  parseOAuthCallback,
} from './google-oauth.js';
import { DRIVE_FOLDER_MIME_TYPE } from '../drive/catalog.js';
import { GoogleApiClient } from '../google/google-api-client.js';

interface SetupServerOptions {
  clientId: string;
  vault: CredentialVault;
  getSelectedFolderIds(): string[];
  setSelectedFolderIds(ids: string[]): void;
  onConnected(tokens: OAuthTokenSet): Promise<void>;
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

export class OAuthSetupServer {
  #server: Server | null = null;
  #setupUrl: string | null = null;
  #state: string | null = null;
  #verifier: string | null = null;
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
        return this.#startOAuth(response);
      }
      if (url.pathname === '/oauth/callback') {
        return await this.#finishOAuth(url, response);
      }
      if (url.pathname === '/folders' && method === 'POST') {
        return await this.#saveFolders(request, response);
      }
      return await this.#home(response);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        page(
          `<h1>Setup error</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`
        )
      );
    }
  }

  #startOAuth(response: import('node:http').ServerResponse): void {
    const pair = createPkcePair();
    this.#state = randomBytes(24).toString('base64url');
    this.#verifier = pair.verifier;
    const target = buildGoogleAuthorizationUrl({
      clientId: this.options.clientId,
      redirectUri: `${this.#setupUrl}/oauth/callback`,
      state: this.#state,
      challenge: pair.challenge,
    });
    response.writeHead(302, { location: target });
    response.end();
  }

  async #finishOAuth(url: URL, response: import('node:http').ServerResponse): Promise<void> {
    if (!this.#state || !this.#verifier) {
      throw new Error('OAuth setup session is missing');
    }
    const code = parseOAuthCallback(url, this.#state);
    const tokens = await exchangeAuthorizationCode({
      clientId: this.options.clientId,
      code,
      verifier: this.#verifier,
      redirectUri: `${this.#setupUrl}/oauth/callback`,
    });
    await this.options.vault.saveTokens(tokens);
    await this.options.onConnected(tokens);
    this.#state = null;
    this.#verifier = null;
    response.writeHead(302, { location: this.#setupUrl ?? '/' });
    response.end();
  }

  async #home(response: import('node:http').ServerResponse): Promise<void> {
    const tokens = await this.options.vault.loadTokens();
    let body: string;
    if (!tokens) {
      body =
        '<h1>Connect Google Sheets</h1><p>Sign in with Google, then choose the My Drive folders this plugin may index.</p><p><a href="/oauth/start">Continue with Google</a></p>';
    } else {
      const client = new GoogleApiClient(tokens, this.options.clientId, (next) =>
        this.options.vault.saveTokens(next)
      );
      const folders = (await client.listFileGraph())
        .filter((file) => file.mimeType === DRIVE_FOLDER_MIME_TYPE)
        .sort((first, second) => first.name.localeCompare(second.name));
      const selected = new Set(this.options.getSelectedFolderIds());
      body = `<h1>Choose My Drive folders</h1><p><small>Only Google Sheets beneath these folders are indexed. Shared drives are excluded.</small></p><form method="post" action="/folders"><input type="hidden" name="token" value="${this.#formToken}">${folders.map((folder) => `<label class="folder"><input type="checkbox" name="folder" value="${escapeHtml(folder.id)}" ${selected.has(folder.id) ? 'checked' : ''}> ${escapeHtml(folder.name)}</label>`).join('')}<button type="submit">Save folders</button></form>`;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page(body));
  }

  async #saveFolders(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    if (form.get('token') !== this.#formToken) {
      throw new Error('Invalid setup form token');
    }
    const ids = form.getAll('folder');
    this.options.setSelectedFolderIds(ids);
    const tokens = await this.options.vault.loadTokens();
    if (tokens) {
      await this.options.onConnected(tokens);
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      page(
        '<h1>Connected</h1><p>Your selected Google Sheets are being indexed. You can close this tab.</p>'
      )
    );
  }
}
