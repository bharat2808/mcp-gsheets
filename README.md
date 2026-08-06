# GSheets local plugin

GSheets `0.2.0` is a local Codex plugin for finding and safely changing Google Sheets in explicitly selected folders in the authenticated account's owned My Drive. It keeps a local index with encrypted content fields, exposes one normalized MCP operation surface, and routes all Google access through Desktop OAuth.

`0.2.0` is intentionally breaking: operation names no longer carry a product prefix, and no public aliases are provided.

## Build and connect

Requirements: Node.js 22.13 or newer, npm, and a Google Cloud project with the Google Sheets API and Google Drive API enabled.

```bash
npm ci
npm run build
npm run setup
```

Create an OAuth client with application type **Desktop app**. Start the MCP server, call `get_connection_status`, open its loopback-only setup URL, and enter the client ID and secret there. The secret is stored in the operating-system credential vault and never accepted through model-visible tool arguments. Sign in, then select one or more folders from the setup page.

The release requests Google Sheets access plus full `https://www.googleapis.com/auth/drive`. Full Drive access is necessary to discover and operate on pre-existing files selected through the custom folder picker; `drive.file` cannot authorize arbitrary existing spreadsheets. The product boundary remains narrower than the OAuth grant: candidates and persisted selections must be owned by the authenticated account, root-reachable in that account's My Drive, and explicitly selected. Shared Drives and Shared-with-me folder roots are not supported.

Upgrading from `0.1.x` requires one-time Google re-consent. `get_connection_status` reports `reConsentRequired` and the missing scope, and the setup page offers **Reconnect Google**. Existing encrypted catalog data is preserved during re-consent and is cleared only after a different Google account is successfully adopted or reviewed sign-out completes.

## Operation categories

The default surface is `core`. Set `GSHEETS_TOOL_CATEGORIES` to a comma-separated list or `all`; `core` is always included.

| Category | Purpose |
| --- | --- |
| `core` | connection, catalog, indexed search/fetch, refresh, values, and reviewed changes |
| `sheets` | worksheet, row/column, copy, move, and structural operations |
| `formatting` | formats, borders, merges, validation, filters, links, and dates |
| `charts` | create, update, and delete charts |
| `tables` | native Google Sheets tables |
| `analysis` | snapshots and range comparison |
| `account` | reviewed sign-out |

`GSHEETS_READ_ONLY=true` removes all mutations and proposal-management operations from discovery. See [docs/TOOLS.md](docs/TOOLS.md) for the complete current operation list.

## Safety model

- Reads and verified non-lossy creations, insertions, copies, and formats can execute directly.
- Appends, row changes, formulas, populated overwrites, removals, destructive structure changes, chart/table replacement, and sign-out require visual review.
- `edit_change`, `approve_change`, and `cancel_change` are app-only. The confirmation token is delivered only in app metadata.
- Approval rechecks Drive revisions and target state, then applies, verifies, audits, and refreshes through one serialized mutation workflow.
- A write that applied but could not be verified or refreshed is reported as `applied_verification_pending`; overlapping destructive work stays blocked until a successful refresh.
- Sign-out has an exact preview, optionally revokes the Google grant, deletes tokens, and clears account-bound encrypted index data only after approval.

Tokens, the OAuth client secret, and the local data key live in the operating-system credential vault. Indexed cell values, headers, native-table details, selections, account identity, detected changes, audits, and pending-verification records are AES-256-GCM encrypted in SQLite; search uses keyed HMAC blind tokens. Catalog and lookup fields needed for indexing remain plaintext: spreadsheet IDs, names, paths, modification/version/freshness timestamps, sheet IDs/titles/used ranges, row numbers and fingerprints, and blind-token hashes. The data directory is restricted to the current user (`0700`) and SQLite database/WAL/SHM files to `0600` on supported platforms.

## Verify

```bash
npm run check:all
npm run smoke:built
npm run integration:dry
uv run --with pyyaml python /Users/home/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
uv run --with pyyaml python /Users/home/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/gsheets
```

`integration:dry` validates and prints the gated School Records lifecycle without using credentials. For a real acceptance run, use a dedicated Google test account and folder, build first, connect an isolated profile using the same dedicated keyring service shown below through its localhost setup page, and note that the harness clears that service's tokens, client secret, and data key during cleanup. Then run:

```bash
GSHEETS_LIVE_TEST=1 \
GSHEETS_LIVE_DATA_DIR=/absolute/path/to/isolated-profile \
GSHEETS_LIVE_FOLDER_ID=selected-owned-my-drive-folder-id \
GSHEETS_LIVE_CREDENTIAL_SERVICE=gsheets-live-school-records \
npm run integration:live
```

The live harness creates a uniquely marked **School Records** workbook with Students, Exams, and Attendance worksheets; exercises reviewed and direct work, search, audits, cancel/approve, disposal, and reviewed sign-out; and confirms the exact workbook ID was moved to trash in cleanup. If creation applies but its response is lost, cleanup recovery is restricted to an exact-title, owned, recent Drive match and reports candidate IDs instead of guessing. It fails closed if credentials, selection, verification, or cleanup are unavailable. Automated checks do not claim this credentialed command ran.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for data flow and trust boundaries.
