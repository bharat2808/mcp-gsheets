export type RiskDecision = 'immediate' | 'reviewed';

export interface RiskInspection {
  targetCellsVerifiedEmpty?: boolean;
  targetCellsPopulated?: boolean;
  gridShrinks?: boolean;
  destinationSelected?: boolean;
}

export interface RiskClassificationInput {
  operation: string;
  arguments: Record<string, unknown>;
  inspection: RiskInspection;
}

export interface RiskClassification {
  decision: RiskDecision;
  reasons: string[];
}

const EXPLICIT_REMOVALS = new Set([
  'clear_values',
  'delete_sheet',
  'batch_delete_sheets',
  'delete_rows',
  'delete_columns',
  'delete_chart',
  'delete_table',
  'clear_data_validation',
  'clear_basic_filter',
]);

const KNOWN_IMMEDIATE_OR_CONDITIONAL = new Set([
  'get_connection_status',
  'get_catalog',
  'get_recent_changes',
  'explore_spreadsheet',
  'search',
  'fetch',
  'refresh_index',
  'review_change',
  'check_access',
  'get_metadata',
  'get_sheet_structure',
  'get_sheet_dimensions',
  'get_values',
  'batch_get_values',
  'get_border_map',
  'get_merged_cells',
  'get_sheet_formatting',
  'get_formatting_compact',
  'get_conditional_formatting',
  'get_data_validation',
  'get_basic_filter',
  'get_tables',
  'get_full_sheet_snapshot',
  'compare_ranges',
  'create_spreadsheet',
  'insert_sheet',
  'duplicate_sheet',
  'copy_to',
  'insert_rows',
  'insert_columns',
  'format_cells',
  'batch_format_cells',
  'update_borders',
  'add_conditional_formatting',
  'set_data_validation',
  'set_basic_filter',
  'create_chart',
  'add_table',
  'update_values',
  'batch_update_values',
  'merge_cells',
  'update_sheet_properties',
  'move_spreadsheet',
  'insert_date',
]);

const KNOWN_REVIEWED = new Set([
  'prepare_row_change',
  'append_values',
  'sign_out',
  'unmerge_cells',
  'update_chart',
  'update_table',
  'insert_link',
  ...EXPLICIT_REMOVALS,
]);

function containsFormula(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trimStart().startsWith('=');
  }
  if (Array.isArray(value)) {
    return value.some(containsFormula);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  return Object.values(value).some(containsFormula);
}

export function classifyOperationRisk({
  operation,
  arguments: arguments_,
  inspection,
}: RiskClassificationInput): RiskClassification {
  const reasons: string[] = [];
  const add = (reason: string) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
    }
  };

  if (containsFormula(arguments_)) {
    add('Formula input requires review');
  }
  if (operation === 'insert_link') {
    add('Formula input requires review');
  }

  if (operation === 'prepare_row_change') {
    add('Row changes require review');
  }
  if (operation === 'append_values') {
    add('Appends require review');
  }
  if (EXPLICIT_REMOVALS.has(operation)) {
    add('Explicit removal requires review');
  }
  if (operation === 'sign_out') {
    add('Sign-out requires review');
  }
  if (operation === 'unmerge_cells') {
    add('Unmerge requires review');
  }
  if (operation === 'update_chart') {
    add('Chart replacement requires review');
  }
  if (operation === 'update_table') {
    add('Table replacement requires review');
  }

  if (operation === 'update_values' || operation === 'batch_update_values') {
    if (inspection.targetCellsVerifiedEmpty !== true) {
      add('Populated cells would be overwritten');
    }
  }
  if (operation === 'merge_cells' && inspection.targetCellsPopulated === true) {
    add('Populated cells would be discarded by merge');
  }
  if (operation === 'insert_date' && inspection.targetCellsPopulated === true) {
    add('Populated cells would be overwritten');
  }
  if (operation === 'update_sheet_properties' && inspection.gridShrinks === true) {
    add('Grid shrinkage may discard cells');
  }
  if (operation === 'move_spreadsheet' && inspection.destinationSelected === false) {
    add('Move leaves the selected folders');
  }

  if (
    reasons.length === 0 &&
    !KNOWN_IMMEDIATE_OR_CONDITIONAL.has(operation) &&
    !KNOWN_REVIEWED.has(operation)
  ) {
    add('Unclassified operation requires review');
  }

  return { decision: reasons.length === 0 ? 'immediate' : 'reviewed', reasons };
}

export function isDestructiveOperation(operation: string): boolean {
  return (
    EXPLICIT_REMOVALS.has(operation) ||
    operation === 'sign_out' ||
    operation === 'unmerge_cells' ||
    operation === 'merge_cells' ||
    operation === 'update_chart' ||
    operation === 'update_table' ||
    operation === 'update_sheet_properties' ||
    operation === 'move_spreadsheet'
  );
}
