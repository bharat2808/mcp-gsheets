# GSheets local Codex plugin

This fork turns `freema/mcp-gsheets` into a focused, local Codex plugin for Google Sheets only. It catalogs Sheets beneath selected My Drive folders, keeps an encrypted row index, reports changes between refreshes, and permits only visually confirmed row appends and updates.

## Current status

The fork is technically suitable as the base: its Google Sheets operations and MCP setup were reusable, while the public 44-tool surface and service-account startup were replaced. The plugin now exposes 9 model tools and 3 app-only confirmation tools.

Google OAuth uses a **Desktop app** client ID and matching client secret. The localhost setup page stores the non-secret ID in the plugin data directory's user-only `config.json` and stores the secret through `@napi-rs/keyring` in the operating-system credential store. OAuth also uses PKCE and a loopback redirect.

## Develop and run

Requirements: Node.js 22.13 or newer and npm.

```bash
npm ci
npm run build
npm start
```

The MCP server runs over stdio. Call `get_connection_status`, open its local setup URL, and enter the ID and secret for a Google OAuth client created with application type **Desktop app**. Then sign into Google and select My Drive folders. The setup page never selects shared drives, and OAuth credentials are never accepted through model-visible MCP tool arguments.

The Codex plugin manifest is `.codex-plugin/plugin.json`; `.mcp.json` launches `dist/index.js`. Build before loading this repository as a local plugin.

### Install from the repo-local marketplace

Build the plugin, add this repository as a local marketplace, and install its entry:

```bash
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add gsheets@gsheets-local
```

Start a new Codex task, ask for the connection status, and open the returned localhost page. The optional `GSHEETS_DATA_DIR` variable overrides the operating-system data directory when an isolated test profile is useful. Client-ID resolution uses the environment override first, then local `config.json`, then the publisher default. The client secret is always read from the operating-system credential store.

## Security and behavior

- OAuth scopes: identity, Drive metadata read-only, and Google Sheets.
- Tokens and the local AES key use the operating-system credential vault.
- A user-supplied OAuth client ID is stored outside the repository with user-only file permissions; its matching secret is stored through `@napi-rs/keyring` and never returned through MCP.
- Replacing locally configured credentials clears OAuth tokens and account-bound indexed data before a different Google account can be connected.
- Cell payloads, headers, selected folder IDs, and change summaries are AES-256-GCM encrypted in SQLite.
- Search uses keyed HMAC blind tokens; plaintext row values are not stored.
- Startup performs catch-up indexing; polling repeats every five minutes while the server is running, and unchanged Drive versions skip content downloads.
- Native table metadata, tab headers, used ranges, row identifiers, row fingerprints, and separate formatted/raw row values are indexed securely.
- `search` and `fetch` implement the standard company-knowledge payload contract.
- Writes are proposals that expire after 15 minutes. Approval requires an app-only nonce and checks the Drive file revision and target values immediately before writing.
- Successful writes are re-read for verification and stored in an encrypted audit history.
- Supported writes are row append and exact-cell row update. Unchanged cells and formulas are preserved; formula generation, deletion, formatting, creation, and structural edits are rejected.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and the documented Google Sheets preflight race.

## Verify

```bash
npm run check:all
python3 /Users/home/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
python3 /Users/home/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/gsheets
```

This repository remains MIT licensed. The original implementation and history are retained in the fork.
