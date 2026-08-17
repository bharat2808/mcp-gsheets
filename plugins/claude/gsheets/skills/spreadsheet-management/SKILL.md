---
name: spreadsheet-management
description: Use for reading, searching, changing, formatting, charting, or managing Google Sheets through the local normalized MCP surface.
---

Call `get_connection_status` first when connection, consent, selected folders, or freshness is uncertain. OAuth credentials are entered only on the localhost setup page. If re-consent is required, explain the full Drive plus Sheets scope migration and the selected owned-My-Drive product boundary.

Use `get_catalog` and `explore_spreadsheet` to resolve IDs and structure, `get_values` or `batch_get_values` for live ranges, and `search` followed by `fetch` for indexed rows. Refresh with `refresh_index` when current indexed data is required.

Common operations:

| Task | Operation |
| --- | --- |
| Read range | `get_values` |
| Read multiple ranges | `batch_get_values` |
| Get workbook info | `get_metadata` |
| Write range | `update_values` |
| Append rows | `append_values` |
| Insert rows | `insert_rows` |
| Format cells | `format_cells` |
| Add borders | `update_borders` |
| Create chart | `create_chart` |
| Add worksheet | `insert_sheet` |

Never claim a pending proposal changed Google Sheets. Ask the user to review it in the app. Do not call app-only proposal actions from the model. Respect stale-state and pending-verification errors; refresh and prepare a new proposal rather than bypassing them.
