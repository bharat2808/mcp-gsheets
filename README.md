# GSheets local Codex plugin

This fork turns `freema/mcp-gsheets` into a focused, local Codex plugin for Google Sheets only. It catalogs Sheets beneath selected My Drive folders, keeps an encrypted row index, reports changes between refreshes, and permits only visually confirmed row appends and updates.

## Current status

The fork is technically suitable as the base: its Google Sheets operations and MCP setup were reusable, while the public 44-tool surface and service-account startup were replaced. The plugin now exposes 9 model tools and 3 app-only confirmation tools.

One publisher input is intentionally not committed: a Google OAuth **Desktop app** client ID. Production builds should set `PUBLISHER_GOOGLE_CLIENT_ID` in `src/config/runtime.ts`. Development can set `GSHEETS_GOOGLE_CLIENT_ID`. A desktop client has no safely keepable client secret; OAuth uses PKCE and a loopback redirect.

## Develop and run

Requirements: Node.js 22.13 or newer and npm.

```bash
npm ci
GSHEETS_GOOGLE_CLIENT_ID="your-desktop-client-id.apps.googleusercontent.com" npm run build
GSHEETS_GOOGLE_CLIENT_ID="your-desktop-client-id.apps.googleusercontent.com" npm start
```

The MCP server runs over stdio. Call `get_connection_status`, open its local setup URL, sign into Google, and select My Drive folders. The setup page never selects shared drives.

The Codex plugin manifest is `.codex-plugin/plugin.json`; `.mcp.json` launches `dist/index.js`. Build before loading this repository as a local plugin.

## Security and behavior

- OAuth scopes: identity, Drive metadata read-only, and Google Sheets.
- Tokens and the local AES key use the operating-system credential vault.
- Cell payloads, headers, selected folder IDs, and change summaries are AES-256-GCM encrypted in SQLite.
- Search uses keyed HMAC blind tokens; plaintext row values are not stored.
- Startup performs catch-up indexing; polling repeats every five minutes while the server is running, and unchanged Drive versions skip content downloads.
- Native table metadata, tab headers, used ranges, row identifiers, and row fingerprints are indexed.
- `search` and `fetch` implement the standard company-knowledge payload contract.
- Writes are proposals that expire after 15 minutes. Approval requires an app-only nonce and checks the Drive file revision and target values immediately before writing.
- Successful writes are re-read for verification and stored in an encrypted audit history.
- Supported writes are row append and row update. Formulas, deletion, formatting, creation, and structural edits are rejected by omission from the tool surface.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data flow and the documented Google Sheets preflight race.

## Verify

```bash
npm run check:all
python3 /Users/home/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
python3 /Users/home/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/gsheets
```

This repository remains MIT licensed. The original implementation and history are retained in the fork.
