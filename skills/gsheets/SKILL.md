---
name: gsheets
description: Search, inspect, refresh, and safely update Google Sheets indexed from user-selected owned My Drive folders. Use when a request concerns the user's Google Sheets data, spreadsheet rows, recent changes, formatting, charts, tables, or a change that may require visual review.
---

# GSheets

1. Call `get_connection_status` when connection, consent, folder selection, or freshness is uncertain. Share its localhost setup URL when needed. The user enters Desktop OAuth credentials only on that page; never request a client secret in chat.
2. If `reConsentRequired` is true, explain that `0.2.0` needs one-time consent for full Drive plus Sheets access. The encrypted catalog is preserved. The operational boundary remains selected folders owned by the authenticated account and root-reachable in My Drive; Shared Drives and Shared-with-me roots are excluded.
3. Use `get_catalog` and `explore_spreadsheet` to resolve spreadsheet, worksheet, table, and header details. Use `refresh_index` when current data is required.
4. Use `search` for indexed discovery and `fetch` for the complete row. Cite the returned Google Sheets URL when discussing a row.
5. Use `get_recent_changes` for detected revisions and encrypted approved-write audits.

The default `core` category covers indexed and value workflows. Operations from `sheets`, `formatting`, `charts`, `tables`, `analysis`, or `account` may be unavailable unless configured. Never invent an alias for an unavailable operation.

Treat a returned pending proposal as a preview, not a completed write. Ask the user to review it in the rendered app. Never call app-only `edit_change`, `approve_change`, or `cancel_change` from the model. Direct results are safe only after the tool reports success. If the result is `applied_verification_pending`, explain that Google may have changed but verification or refresh is incomplete and do not start overlapping destructive work.

Appends, row changes, formulas, populated overwrites, removals, destructive structure changes, chart/table replacements, and sign-out require visual review. Exact structural proposals are not editable. If preflight reports changed revisions or target state, refresh and prepare a new proposal; never work around the guard.
