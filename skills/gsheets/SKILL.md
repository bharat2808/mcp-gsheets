---
name: gsheets
description: Search, inspect, refresh, and safely update Google Sheets indexed from user-selected My Drive folders. Use when a request concerns the user's Google Sheets data, spreadsheet rows, recent changes, or an append/update that must be visually confirmed.
---

# GSheets

Use the local encrypted index before asking the user for spreadsheet details.

1. Call `get_connection_status` first when connection or freshness is uncertain. Give the returned local setup URL when Google is not connected or no folders are selected.
2. Use `get_sheets_catalog` to resolve spreadsheet IDs and `explore_spreadsheet` to resolve tab IDs and headers.
3. Use `search` for row discovery and `fetch` for a complete row. `search` intentionally returns citation metadata only; call `fetch` before using row values. Cite the returned Google Sheets URL when discussing a row.
4. Call `refresh_sheets_index` when the user requests current data or the catalog says an entry is stale, pending, or unavailable.
5. Use `get_recent_changes` for changes detected between refresh snapshots and the encrypted history of approved writes. Describe Drive revision checking as file-level detection and the returned row groups as locally computed comparisons.

For writes, only prepare appends or updates with `prepare_sheet_change`. Never claim the proposal changed Google Sheets. Ask the user to review the rendered proposal and approve it there. Approval is executed only by the app after the user checks the confirmation box; never attempt to call app-only approval, edit, or cancel tools yourself.

If preflight rejects a proposal because the revision or target row changed, refresh, show the new values, and prepare a new proposal. Do not work around the guard. Formula entry, deletion, formatting, sheet creation, and structural changes are unsupported.
