# Google Sheets plugin

This companion package uses the same `0.2.0` local MCP server and normalized operations as the Codex plugin.

Build the repository, configure the server command to run `dist/index.js`, then call `get_connection_status`. Open its localhost setup URL and enter credentials for a Google OAuth **Desktop app**. Enable both the Google Sheets API and Google Drive API in the Cloud project. Do not put OAuth secrets in the MCP configuration or environment.

The account grants full Drive plus Sheets access, with an in-product boundary of explicitly selected folders owned by the authenticated account and root-reachable in My Drive. Shared Drives and Shared-with-me roots are excluded. Existing `0.1.x` connections require one-time re-consent.

Use `GSHEETS_TOOL_CATEGORIES=all` when the companion commands need formatting, chart, table, worksheet, analysis, and account operations. The default is `core`; `GSHEETS_READ_ONLY=true` disables mutations.

Reads and verified non-lossy work may complete immediately. Appends, formulas, populated overwrites, removals, destructive structure changes, replacements, and sign-out return a visual-review proposal. Never describe a proposal as applied. Approval, editing, and cancellation are app-only.

Commands:

- `/sheets:read` reads a range with `get_values`.
- `/sheets:write` requests `update_values` and reports whether it applied or needs review.
- `/sheets:format` requests `format_cells` after inspecting the target.

The `data-analyst` companion agent can read, analyze, format, chart, and prepare reviewed changes.
