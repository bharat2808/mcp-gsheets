# Operation reference

The default `core` category is always enabled. Additional categories are selected with `GSHEETS_TOOL_CATEGORIES`; `all` enables all 63 operations. `GSHEETS_READ_ONLY=true` retains only operations marked read-only.

## core

`get_connection_status`, `get_catalog`, `get_recent_changes`, `explore_spreadsheet`, `search`, `fetch`, `refresh_index`, `prepare_row_change`, `review_change`, `edit_change` (app-only), `approve_change` (app-only), `cancel_change` (app-only), `check_access`, `get_metadata`, `get_sheet_structure`, `get_sheet_dimensions`, `get_values`, `batch_get_values`, `update_values`, `batch_update_values`, `append_values`, `clear_values`, `create_spreadsheet`.

## sheets

`insert_sheet`, `delete_sheet`, `duplicate_sheet`, `copy_to`, `update_sheet_properties`, `batch_delete_sheets`, `insert_rows`, `delete_rows`, `delete_columns`, `insert_columns`, `move_spreadsheet`.

## formatting

`format_cells`, `batch_format_cells`, `update_borders`, `get_border_map`, `merge_cells`, `unmerge_cells`, `get_merged_cells`, `get_sheet_formatting`, `get_formatting_compact`, `add_conditional_formatting`, `get_conditional_formatting`, `get_data_validation`, `get_basic_filter`, `insert_link`, `insert_date`, `set_data_validation`, `clear_data_validation`, `set_basic_filter`, `clear_basic_filter`.

## charts

`create_chart`, `update_chart`, `delete_chart`.

## tables

`add_table`, `update_table`, `delete_table`, `get_tables`.

## analysis

`get_full_sheet_snapshot`, `compare_ranges`.

## account

`sign_out` prepares an exact reviewed proposal. Only app approval executes it.

Operations that inspect data or metadata are read-only. Creation/insertion/formatting may execute directly after preflight. Appends, formulas, populated overwrites, removals, destructive structure changes, replacements, and sign-out return a proposal when review is required. Always interpret the returned status rather than assuming a mutation applied.
