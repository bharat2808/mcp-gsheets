# Completion audit

| Requirement | Implementation evidence | Verification evidence |
| --- | --- | --- |
| Google Sheets only | Drive MIME filtering in `src/drive/catalog.ts`; no Excel adapter is registered | Drive catalog unit tests |
| Interactive Google sign-in | Loopback OAuth, PKCE, offline tokens, and local setup page in `src/auth/` | OAuth and setup-server unit tests |
| Selected My Drive folders; no shared drives | Encrypted folder selection plus `driveId` exclusion | Drive catalog and Google client unit tests |
| Instant cached catalog | `LocalIndex.getCatalog` and `get_sheets_catalog` | encrypted index and protocol tests |
| Tabs, native tables, headers, used ranges, identifiers, row fingerprints | parser, Google metadata reader, and encrypted SQLite schema | parser, indexing, sync, and storage tests |
| Startup catch-up and five-minute polling | `GSheetsRuntime.initialize` and unref'd poll timer | runtime code review; sync behavior tests |
| Only changed Drive revisions are downloaded and compared | version gate in `SyncService.refresh` | unchanged-revision and deleted-tab sync tests |
| Recent semantic changes | snapshot comparison by unique identifier or row number | row comparison and sync tests |
| Standard `search` and `fetch` | exact one-text-item company-knowledge responses | in-memory MCP protocol test |
| Confirmation-gated append/update only | short-lived proposals, app-only tools, metadata-only nonce, formula and duplicate rejection | proposal and MCP boundary tests |
| Revision/target preflight and post-write verification | `ProposalManager.approve` and `GoogleApiClient.apply` | proposal and append verification tests |
| Encrypted audit history | `write_audits` table and runtime approval recording | storage encryption test |
| Visual Approve/Edit/Cancel UI | single-file React MCP App under `ui/` | Vite production build and tool metadata tests |
| Local cross-platform runtime | Node 22 built-in SQLite, `@napi-rs/keyring`, stdio MCP, OS-specific data directory | macOS tests plus cross-platform package dependencies |
| Codex plugin and skill | `.codex-plugin/plugin.json`, `.mcp.json`, and `skills/gsheets` | official plugin and skill validators |

Automated verification does not substitute for a live Google acceptance test. A publisher-owned Google OAuth Desktop client ID is intentionally absent from source control and must be supplied through `PUBLISHER_GOOGLE_CLIENT_ID` for a release build or `GSHEETS_GOOGLE_CLIENT_ID` during development. Live sign-in, folder selection, reading, and a reversible append/update should be exercised with that client before marketplace release.
