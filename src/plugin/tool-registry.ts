export const MODEL_TOOL_NAMES = [
  'get_connection_status',
  'get_sheets_catalog',
  'get_recent_changes',
  'explore_spreadsheet',
  'search',
  'fetch',
  'refresh_sheets_index',
  'prepare_sheet_change',
  'review_sheet_change',
] as const;

export const APP_ONLY_TOOL_NAMES = [
  'edit_sheet_proposal',
  'approve_sheet_proposal',
  'cancel_sheet_proposal',
] as const;

export const PUBLIC_TOOL_NAMES = [...MODEL_TOOL_NAMES, ...APP_ONLY_TOOL_NAMES] as const;

export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];
export type AppOnlyToolName = (typeof APP_ONLY_TOOL_NAMES)[number];
export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];
