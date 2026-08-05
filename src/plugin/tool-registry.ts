import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { GSheetsRuntime } from '../runtime/gsheets-runtime.js';
import { ChangeProposal, publicChangeProposal } from '../proposals/proposal-manager.js';
import * as legacyTools from '../tools/index.js';

export const TOOL_CATEGORIES = [
  'core',
  'sheets',
  'formatting',
  'charts',
  'tables',
  'analysis',
  'account',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];
export type OperationHandler = (runtime: GSheetsRuntime, input: any) => unknown;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface OperationDefinition {
  name: string;
  title: string;
  description: string;
  category: ToolCategory;
  /** Whether this operation remains callable with GSHEETS_READ_ONLY=true. */
  readOnly: boolean;
  appOnly?: boolean;
  inputSchema?: Record<string, z.ZodTypeAny>;
  annotations: ToolAnnotations;
  meta?: Record<string, unknown>;
  handler: OperationHandler;
}

const UI_URI = 'ui://gsheets/review.html';
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const rowValues = z.record(cellValue);

function result(data: unknown, metadata?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
    ...(metadata ? { _meta: metadata } : {}),
  };
}

function isChangeProposal(value: unknown): value is ChangeProposal {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { version?: unknown }).version === 2 &&
    typeof (value as { nonce?: unknown }).nonce === 'string'
  );
}

function proposalResult(runtime: GSheetsRuntime, proposal: ChangeProposal, includeNonce = true) {
  return result(
    publicChangeProposal(proposal),
    includeNonce
      ? { 'gsheets/confirmationToken': runtime.confirmationToken(proposal.id) }
      : undefined
  );
}

function operationResult(runtime: GSheetsRuntime, value: unknown) {
  return isChangeProposal(value) ? proposalResult(runtime, value) : result(value);
}

function normalizedName(name: string): string {
  return name.startsWith('sheets_') ? name.slice('sheets_'.length) : name;
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return typeof value === 'object' && value !== null && '_def' in value;
}

function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (isZodSchema(schema)) {
    return schema;
  }
  if (!schema || typeof schema !== 'object') {
    return z.any();
  }

  const definition = schema as {
    type?: string;
    enum?: unknown[];
    items?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (definition.enum?.every((value) => typeof value === 'string')) {
    return z.enum(definition.enum as [string, ...string[]]);
  }
  if (definition.type === 'string') {
    return z.string();
  }
  if (definition.type === 'number' || definition.type === 'integer') {
    return z.number();
  }
  if (definition.type === 'boolean') {
    return z.boolean();
  }
  if (definition.type === 'array') {
    return z.array(jsonSchemaToZod(definition.items));
  }
  if (definition.type === 'object' || definition.properties) {
    return z.object(jsonSchemaToZodShape(definition.properties ?? {}, definition.required ?? []));
  }
  return z.any();
}

function jsonSchemaToZodShape(
  properties: Record<string, unknown>,
  required: readonly string[]
): Record<string, z.ZodTypeAny> {
  return Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => {
      const field = jsonSchemaToZod(schema);
      return [name, required.includes(name) ? field : field.optional()];
    })
  );
}

function annotations(options: {
  readOnly?: boolean | undefined;
  destructive?: boolean | undefined;
  idempotent?: boolean | undefined;
  openWorld?: boolean | undefined;
}): ToolAnnotations {
  const value: ToolAnnotations = {};
  if (options.readOnly) {
    value.readOnlyHint = true;
  }
  if (options.destructive !== undefined) {
    value.destructiveHint = options.destructive;
  }
  if (options.idempotent) {
    value.idempotentHint = true;
  }
  if (options.openWorld === false) {
    value.openWorldHint = false;
  }
  return value;
}

function legacyOperation(
  category: ToolCategory,
  tool: Tool,
  handler: (input: any) => unknown,
  options: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean } = {}
): OperationDefinition {
  const inputSchema = tool.inputSchema as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: normalizedName(tool.name),
    title: tool.name,
    description: tool.description ?? tool.name,
    category,
    readOnly: options.readOnly === true,
    inputSchema: jsonSchemaToZodShape(inputSchema.properties ?? {}, inputSchema.required ?? []),
    annotations: annotations({
      readOnly: options.readOnly,
      destructive: options.destructive,
      idempotent: options.idempotent,
    }),
    handler: async (runtime, input) => {
      const output = await runtime.executeLegacyOperation(
        normalizedName(tool.name),
        handler,
        input,
        {
          idempotent: options.idempotent === true,
          refreshIndex: options.readOnly !== true,
        }
      );
      return isChangeProposal(output) ? proposalResult(runtime, output) : output;
    },
  };
}

const reviewMeta = {
  ui: { resourceUri: UI_URI, visibility: ['model', 'app'] as Array<'model' | 'app'> },
};
const appOnlyMeta = { ui: { resourceUri: UI_URI, visibility: ['app'] as Array<'app'> } };

export const OPERATIONS: readonly OperationDefinition[] = [
  {
    name: 'get_connection_status',
    title: 'Get Google Sheets connection status',
    description: 'Check Google connection, selected folders, setup URL, and index freshness.',
    category: 'core',
    readOnly: true,
    annotations: annotations({ readOnly: true, openWorld: false }),
    handler: (runtime) => result(runtime.status()),
  },
  {
    name: 'get_catalog',
    title: 'Get Sheets catalog',
    description:
      'List indexed Google Sheets from the selected My Drive folders with freshness state.',
    category: 'core',
    readOnly: true,
    annotations: annotations({ readOnly: true, openWorld: false }),
    handler: (runtime) => result(runtime.catalog()),
  },
  {
    name: 'get_recent_changes',
    title: 'Get recent Sheet changes',
    description:
      'List semantic row and structural changes detected during refreshes plus encrypted approved-write audit history.',
    category: 'core',
    readOnly: true,
    inputSchema: { limit: z.number().int().min(1).max(500).optional() },
    annotations: annotations({ readOnly: true, openWorld: false }),
    handler: (runtime, { limit }) => result(runtime.recentChanges(limit)),
  },
  {
    name: 'explore_spreadsheet',
    title: 'Explore spreadsheet',
    description:
      'Show indexed sheet tabs, native tables, headers, used ranges, and row counts for one spreadsheet.',
    category: 'core',
    readOnly: true,
    inputSchema: { spreadsheetId: z.string().min(1) },
    annotations: annotations({ readOnly: true, openWorld: false }),
    handler: (runtime, { spreadsheetId }) => result(runtime.explore(spreadsheetId)),
  },
  {
    name: 'search',
    title: 'Search indexed Sheets',
    description: 'Search encrypted local Google Sheets row index. All normalized terms must match.',
    category: 'core',
    readOnly: true,
    inputSchema: { query: z.string().min(1) },
    annotations: annotations({ readOnly: true, openWorld: false }),
    handler: (runtime, { query }) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            results: runtime.search(query).map(({ id, title, url }) => ({ id, title, url })),
          }),
        },
      ],
    }),
  },
  {
    name: 'fetch',
    title: 'Fetch indexed Sheet row',
    description: 'Fetch one complete indexed row by the ID returned from search.',
    category: 'core',
    readOnly: true,
    inputSchema: { id: z.string().min(1) },
    annotations: annotations({ readOnly: true, openWorld: false }),
    handler: (runtime, { id }) => {
      const hit = runtime.fetch(id);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: hit.id,
              title: hit.title,
              text: JSON.stringify(hit.values),
              url: hit.url,
              metadata: {
                spreadsheetId: hit.spreadsheetId,
                sheetId: hit.sheetId,
                sheetTitle: hit.sheetTitle,
                rowNumber: hit.rowNumber,
              },
            }),
          },
        ],
      };
    },
  },
  {
    name: 'refresh_index',
    title: 'Refresh Sheets index',
    description: 'Synchronize the selected My Drive folders now and report indexed counts.',
    category: 'core',
    readOnly: true,
    annotations: annotations({ readOnly: true }),
    handler: async (runtime) => result(await runtime.refresh()),
  },
  {
    name: 'prepare_row_change',
    title: 'Prepare Sheet change',
    description: 'Prepare an append or row update proposal. This never writes to Google Sheets.',
    category: 'core',
    readOnly: false,
    inputSchema: {
      spreadsheetId: z.string().min(1),
      sheetId: z.number().int(),
      operation: z.enum(['append', 'update']),
      rowNumber: z.number().int().min(2).optional(),
      values: rowValues,
    },
    annotations: annotations({ readOnly: true, openWorld: false }),
    meta: { ...reviewMeta, 'ui/resourceUri': UI_URI },
    handler: async (runtime, input) => {
      const proposal = await runtime.prepare(input);
      return proposalResult(runtime, proposal);
    },
  },
  {
    name: 'review_change',
    title: 'Review Sheet change',
    description: 'Open a pending proposal for visual review. This never writes to Google Sheets.',
    category: 'core',
    readOnly: false,
    inputSchema: { proposalId: z.string().uuid() },
    annotations: annotations({ readOnly: true, openWorld: false }),
    meta: { ...reviewMeta, 'ui/resourceUri': UI_URI },
    handler: (runtime, { proposalId }) => {
      const proposal = runtime.review(proposalId);
      return proposalResult(runtime, proposal);
    },
  },
  {
    name: 'edit_change',
    title: 'Edit Sheet proposal',
    description: 'Edit pending proposal values from the review app.',
    category: 'core',
    readOnly: false,
    appOnly: true,
    inputSchema: { proposalId: z.string().uuid(), values: z.any() },
    annotations: annotations({ readOnly: true, openWorld: false }),
    meta: { ...appOnlyMeta, 'ui/resourceUri': UI_URI },
    handler: (runtime, { proposalId, values }) => {
      const proposal = runtime.edit(proposalId, values);
      return proposalResult(runtime, proposal);
    },
  },
  {
    name: 'approve_change',
    title: 'Approve Sheet proposal',
    description: 'Apply a visually confirmed proposal after revision and row preflight checks.',
    category: 'core',
    readOnly: false,
    appOnly: true,
    inputSchema: { proposalId: z.string().uuid(), confirmationToken: z.string().min(32) },
    annotations: annotations({ destructive: true, openWorld: true }),
    meta: { ...appOnlyMeta, 'ui/resourceUri': UI_URI },
    handler: async (runtime, { proposalId, confirmationToken }) =>
      result(publicChangeProposal(await runtime.approve(proposalId, confirmationToken))),
  },
  {
    name: 'cancel_change',
    title: 'Cancel Sheet proposal',
    description: 'Cancel a pending proposal without writing to Google Sheets.',
    category: 'core',
    readOnly: false,
    appOnly: true,
    inputSchema: { proposalId: z.string().uuid() },
    annotations: annotations({ readOnly: true, openWorld: false }),
    meta: { ...appOnlyMeta, 'ui/resourceUri': UI_URI },
    handler: (runtime, { proposalId }) => result(publicChangeProposal(runtime.cancel(proposalId))),
  },

  legacyOperation('core', legacyTools.checkAccessTool, legacyTools.handleCheckAccess, {
    readOnly: true,
    idempotent: true,
  }),
  legacyOperation('core', legacyTools.getMetadataTool, legacyTools.handleGetMetadata, {
    readOnly: true,
    idempotent: true,
  }),
  legacyOperation('core', legacyTools.getSheetStructureTool, legacyTools.handleGetSheetStructure, {
    readOnly: true,
    idempotent: true,
  }),
  legacyOperation(
    'core',
    legacyTools.getSheetDimensionsTool,
    legacyTools.handleGetSheetDimensions,
    {
      readOnly: true,
      idempotent: true,
    }
  ),
  legacyOperation('core', legacyTools.getValuesTool, legacyTools.handleGetValues, {
    readOnly: true,
    idempotent: true,
  }),
  legacyOperation('core', legacyTools.batchGetValuesTool, legacyTools.handleBatchGetValues, {
    readOnly: true,
    idempotent: true,
  }),
  legacyOperation('core', legacyTools.updateValuesTool, legacyTools.handleUpdateValues, {
    destructive: false,
    idempotent: true,
  }),
  legacyOperation('core', legacyTools.batchUpdateValuesTool, legacyTools.handleBatchUpdateValues, {
    destructive: false,
    idempotent: true,
  }),
  legacyOperation('core', legacyTools.appendValuesTool, legacyTools.handleAppendValues, {
    destructive: false,
  }),
  legacyOperation('core', legacyTools.clearValuesTool, legacyTools.handleClearValues),
  {
    name: 'create_spreadsheet',
    title: legacyTools.createSpreadsheetTool.name,
    description: legacyTools.createSpreadsheetTool.description ?? 'Create a spreadsheet.',
    category: 'core',
    readOnly: false,
    inputSchema: {
      title: z.string().min(1),
      folderId: z.string().min(1).optional(),
      sheets: z
        .array(
          z.object({
            title: z.string().min(1).optional(),
            rowCount: z.number().int().positive().optional(),
            columnCount: z.number().int().positive().optional(),
          })
        )
        .optional(),
    },
    annotations: annotations({ destructive: false }),
    handler: async (runtime, input) =>
      operationResult(runtime, await runtime.createSpreadsheet(input)),
  },

  legacyOperation('sheets', legacyTools.insertSheetTool, legacyTools.handleInsertSheet, {
    destructive: false,
  }),
  legacyOperation('sheets', legacyTools.deleteSheetTool, legacyTools.handleDeleteSheet),
  legacyOperation('sheets', legacyTools.duplicateSheetTool, legacyTools.handleDuplicateSheet, {
    destructive: false,
  }),
  legacyOperation('sheets', legacyTools.copyToTool, legacyTools.handleCopyTo, {
    destructive: false,
  }),
  legacyOperation(
    'sheets',
    legacyTools.updateSheetPropertiesTool,
    legacyTools.handleUpdateSheetProperties,
    { destructive: false, idempotent: true }
  ),
  legacyOperation('sheets', legacyTools.batchDeleteSheetsTool, legacyTools.handleBatchDeleteSheets),
  legacyOperation('sheets', legacyTools.insertRowsTool, legacyTools.handleInsertRows, {
    destructive: false,
  }),
  legacyOperation('sheets', legacyTools.deleteRowsTool, legacyTools.handleDeleteRows),
  legacyOperation('sheets', legacyTools.deleteColumnsTool, legacyTools.handleDeleteColumns),
  {
    name: 'insert_columns',
    title: 'Insert columns',
    description: 'Insert columns at a specific position.',
    category: 'sheets',
    readOnly: false,
    inputSchema: {
      spreadsheetId: z.string().min(1),
      range: z.string().min(1),
      columns: z.number().int().positive().optional(),
      position: z.enum(['BEFORE', 'AFTER']).optional(),
      inheritFromBefore: z.boolean().optional(),
      values: z.array(z.array(z.any())).optional(),
      valueInputOption: z.enum(['RAW', 'USER_ENTERED']).optional(),
    },
    annotations: annotations({ destructive: false, openWorld: false }),
    handler: async (runtime, input) => operationResult(runtime, await runtime.insertColumns(input)),
  },
  {
    name: 'move_spreadsheet',
    title: 'Move spreadsheet',
    description: 'Move a spreadsheet to a selected My Drive folder.',
    category: 'sheets',
    readOnly: false,
    inputSchema: { spreadsheetId: z.string().min(1), folderId: z.string().min(1) },
    annotations: annotations({ destructive: true, openWorld: false }),
    handler: async (runtime, input) =>
      operationResult(runtime, await runtime.moveSpreadsheet(input)),
  },

  legacyOperation('formatting', legacyTools.formatCellsTool, legacyTools.formatCellsHandler, {
    destructive: false,
    idempotent: true,
  }),
  legacyOperation(
    'formatting',
    legacyTools.batchFormatCellsTool,
    legacyTools.handleBatchFormatCells,
    {
      destructive: false,
      idempotent: true,
    }
  ),
  legacyOperation('formatting', legacyTools.updateBordersTool, legacyTools.updateBordersHandler, {
    destructive: false,
    idempotent: true,
  }),
  legacyOperation('formatting', legacyTools.getBorderMapTool, legacyTools.handleGetBorderMap, {
    readOnly: true,
    idempotent: true,
  }),
  legacyOperation('formatting', legacyTools.mergeCellsTool, legacyTools.mergeCellsHandler, {
    destructive: false,
  }),
  legacyOperation('formatting', legacyTools.unmergeCellsTool, legacyTools.unmergeCellsHandler),
  legacyOperation('formatting', legacyTools.getMergedCellsTool, legacyTools.handleGetMergedCells, {
    readOnly: true,
    idempotent: true,
  }),
  legacyOperation(
    'formatting',
    legacyTools.getSheetFormattingTool,
    legacyTools.handleGetSheetFormatting,
    {
      readOnly: true,
      idempotent: true,
    }
  ),
  legacyOperation(
    'formatting',
    legacyTools.getFormattingCompactTool,
    legacyTools.handleGetFormattingCompact,
    { readOnly: true, idempotent: true }
  ),
  legacyOperation(
    'formatting',
    legacyTools.addConditionalFormattingTool,
    legacyTools.addConditionalFormattingHandler,
    { destructive: false }
  ),
  legacyOperation(
    'formatting',
    legacyTools.getConditionalFormattingDataTool,
    legacyTools.handleGetConditionalFormattingData,
    { readOnly: true, idempotent: true }
  ),
  legacyOperation(
    'formatting',
    legacyTools.getDataValidationTool,
    legacyTools.handleGetDataValidation,
    {
      readOnly: true,
      idempotent: true,
    }
  ),
  legacyOperation('formatting', legacyTools.getBasicFilterTool, legacyTools.handleGetBasicFilter, {
    readOnly: true,
    idempotent: true,
  }),
  legacyOperation('formatting', legacyTools.insertLinkTool, legacyTools.handleInsertLink, {
    destructive: false,
    idempotent: true,
  }),
  legacyOperation('formatting', legacyTools.insertDateTool, legacyTools.handleInsertDate, {
    destructive: false,
    idempotent: true,
  }),
  {
    name: 'set_data_validation',
    title: 'Set data validation',
    description: 'Set data validation rules for a range.',
    category: 'formatting',
    readOnly: false,
    inputSchema: {
      spreadsheetId: z.string().min(1),
      range: z.string().min(1),
      rule: z.record(z.any()),
      filteredRowsIncluded: z.boolean().optional(),
    },
    annotations: annotations({ destructive: false, idempotent: true, openWorld: false }),
    handler: async (runtime, input) =>
      operationResult(runtime, await runtime.setDataValidation(input)),
  },
  {
    name: 'clear_data_validation',
    title: 'Clear data validation',
    description: 'Clear data validation rules from a range.',
    category: 'formatting',
    readOnly: false,
    inputSchema: { spreadsheetId: z.string().min(1), range: z.string().min(1) },
    annotations: annotations({ destructive: true, openWorld: false }),
    handler: async (runtime, input) =>
      operationResult(runtime, await runtime.clearDataValidation(input)),
  },
  {
    name: 'set_basic_filter',
    title: 'Set basic filter',
    description: 'Set a basic filter for a sheet.',
    category: 'formatting',
    readOnly: false,
    inputSchema: {
      spreadsheetId: z.string().min(1),
      range: z.string().min(1),
      sortSpecs: z.array(z.any()).optional(),
      filterSpecs: z.array(z.any()).optional(),
      criteria: z.record(z.any()).optional(),
    },
    annotations: annotations({ destructive: false, idempotent: true, openWorld: false }),
    handler: async (runtime, input) =>
      operationResult(runtime, await runtime.setBasicFilter(input)),
  },
  {
    name: 'clear_basic_filter',
    title: 'Clear basic filter',
    description: 'Clear the basic filter from a sheet.',
    category: 'formatting',
    readOnly: false,
    inputSchema: { spreadsheetId: z.string().min(1), sheetId: z.number().int() },
    annotations: annotations({ destructive: true, openWorld: false }),
    handler: async (runtime, input) =>
      operationResult(runtime, await runtime.clearBasicFilter(input)),
  },

  legacyOperation('charts', legacyTools.createChartTool, legacyTools.handleCreateChart, {
    destructive: false,
  }),
  legacyOperation('charts', legacyTools.updateChartTool, legacyTools.handleUpdateChart, {
    destructive: false,
    idempotent: true,
  }),
  legacyOperation('charts', legacyTools.deleteChartTool, legacyTools.handleDeleteChart),

  legacyOperation('tables', legacyTools.addTableTool, legacyTools.addTableHandler, {
    destructive: false,
  }),
  legacyOperation('tables', legacyTools.updateTableTool, legacyTools.updateTableHandler, {
    destructive: false,
    idempotent: true,
  }),
  legacyOperation('tables', legacyTools.deleteTableTool, legacyTools.deleteTableHandler),
  legacyOperation('tables', legacyTools.getTablesTool, legacyTools.getTablesHandler, {
    readOnly: true,
    idempotent: true,
  }),

  legacyOperation(
    'analysis',
    legacyTools.getFullSheetSnapshotTool,
    legacyTools.handleGetFullSheetSnapshot,
    { readOnly: true, idempotent: true }
  ),
  legacyOperation('analysis', legacyTools.compareRangesTool, legacyTools.handleCompareRanges, {
    readOnly: true,
    idempotent: true,
  }),

  {
    name: 'sign_out',
    title: 'Sign out',
    description: 'Sign out the connected Google account.',
    category: 'account',
    readOnly: false,
    annotations: annotations({ destructive: true, idempotent: true, openWorld: false }),
    inputSchema: { revokeGoogleGrant: z.boolean().optional() },
    meta: { ...reviewMeta, 'ui/resourceUri': UI_URI },
    handler: async (runtime, input) =>
      operationResult(runtime, await runtime.prepareSignOut(input)),
  },
];

const duplicateNames = OPERATIONS.filter(
  (operation, index) =>
    OPERATIONS.findIndex((candidate) => candidate.name === operation.name) !== index
).map((operation) => operation.name);

if (duplicateNames.length > 0) {
  throw new Error(`Duplicate operation names: ${duplicateNames.join(', ')}`);
}

export const PUBLIC_TOOL_NAMES = OPERATIONS.map((operation) => operation.name);
export const APP_ONLY_TOOL_NAMES = OPERATIONS.filter((operation) => operation.appOnly).map(
  (operation) => operation.name
);
export const MODEL_TOOL_NAMES = OPERATIONS.filter((operation) => !operation.appOnly).map(
  (operation) => operation.name
);

export type PublicToolName = (typeof PUBLIC_TOOL_NAMES)[number];
export type AppOnlyToolName = (typeof APP_ONLY_TOOL_NAMES)[number];
export type ModelToolName = (typeof MODEL_TOOL_NAMES)[number];
