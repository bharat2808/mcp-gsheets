import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { GSheetsRuntime } from '../runtime/gsheets-runtime.js';

const UI_URI = 'ui://gsheets/review.html';
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const values = z.record(cellValue);

function result(data: unknown, metadata?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
    ...(metadata ? { _meta: metadata } : {}),
  };
}

interface ToolRegistrar {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    callback: (input: any) => any
  ): unknown;
}

export function createGSheetsServer(runtime: GSheetsRuntime): McpServer {
  const server = new McpServer(
    { name: 'gsheets', version: '0.1.0' },
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    }
  );
  // The SDK's Zod compatibility generics grow exponentially across a larger tool surface.
  // Runtime validation still uses the exact schemas below; this boundary only limits tsc inference.
  const toolServer = server as unknown as ToolRegistrar;

  toolServer.registerTool(
    'get_connection_status',
    {
      title: 'Get Google Sheets connection status',
      description: 'Check Google connection, selected folders, setup URL, and index freshness.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result(runtime.status())
  );

  toolServer.registerTool(
    'get_sheets_catalog',
    {
      title: 'Get Sheets catalog',
      description:
        'List indexed Google Sheets from the selected My Drive folders with freshness state.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => result(runtime.catalog())
  );

  toolServer.registerTool(
    'get_recent_changes',
    {
      title: 'Get recent Sheet changes',
      description:
        'List semantic row and structural changes detected during refreshes plus encrypted approved-write audit history.',
      inputSchema: { limit: z.number().int().min(1).max(500).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) => result(runtime.recentChanges(limit))
  );

  toolServer.registerTool(
    'explore_spreadsheet',
    {
      title: 'Explore spreadsheet',
      description:
        'Show indexed sheet tabs, native tables, headers, used ranges, and row counts for one spreadsheet.',
      inputSchema: { spreadsheetId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ spreadsheetId }) => result(runtime.explore(spreadsheetId))
  );

  toolServer.registerTool(
    'search',
    {
      title: 'Search indexed Sheets',
      description:
        'Search encrypted local Google Sheets row index. All normalized terms must match.',
      inputSchema: { query: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => ({
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            results: runtime.search(query).map(({ id, title, url }) => ({ id, title, url })),
          }),
        },
      ],
    })
  );

  toolServer.registerTool(
    'fetch',
    {
      title: 'Fetch indexed Sheet row',
      description: 'Fetch one complete indexed row by the ID returned from search.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
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
    }
  );

  toolServer.registerTool(
    'refresh_sheets_index',
    {
      title: 'Refresh Sheets index',
      description: 'Synchronize the selected My Drive folders now and report indexed counts.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => result(await runtime.refresh())
  );

  const reviewMeta = {
    ui: { resourceUri: UI_URI, visibility: ['model', 'app'] as Array<'model' | 'app'> },
  };
  toolServer.registerTool(
    'prepare_sheet_change',
    {
      title: 'Prepare Sheet change',
      description: 'Prepare an append or row update proposal. This never writes to Google Sheets.',
      inputSchema: {
        spreadsheetId: z.string().min(1),
        sheetId: z.number().int(),
        operation: z.enum(['append', 'update']),
        rowNumber: z.number().int().min(2).optional(),
        values,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ...reviewMeta, 'ui/resourceUri': UI_URI },
    },
    async (input) => {
      const proposal = await runtime.prepare(input);
      return result(proposal, {
        'gsheets/confirmationToken': runtime.confirmationToken(proposal.id),
      });
    }
  );

  toolServer.registerTool(
    'review_sheet_change',
    {
      title: 'Review Sheet change',
      description: 'Open a pending proposal for visual review. This never writes to Google Sheets.',
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ...reviewMeta, 'ui/resourceUri': UI_URI },
    },
    async ({ proposalId }) => {
      const proposal = runtime.review(proposalId);
      return result(proposal, {
        'gsheets/confirmationToken': runtime.confirmationToken(proposal.id),
      });
    }
  );

  const appOnlyMeta = { ui: { resourceUri: UI_URI, visibility: ['app'] as Array<'app'> } };
  toolServer.registerTool(
    'edit_sheet_proposal',
    {
      title: 'Edit Sheet proposal',
      description: 'Edit pending proposal values from the review app.',
      inputSchema: { proposalId: z.string().uuid(), values },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ...appOnlyMeta, 'ui/resourceUri': UI_URI },
    },
    async ({ proposalId, values: nextValues }) => {
      const proposal = runtime.edit(proposalId, nextValues);
      return result(proposal, {
        'gsheets/confirmationToken': runtime.confirmationToken(proposal.id),
      });
    }
  );

  toolServer.registerTool(
    'approve_sheet_proposal',
    {
      title: 'Approve Sheet proposal',
      description: 'Apply a visually confirmed proposal after revision and row preflight checks.',
      inputSchema: { proposalId: z.string().uuid(), confirmationToken: z.string().min(32) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ...appOnlyMeta, 'ui/resourceUri': UI_URI },
    },
    async ({ proposalId, confirmationToken }) =>
      result(await runtime.approve(proposalId, confirmationToken))
  );

  toolServer.registerTool(
    'cancel_sheet_proposal',
    {
      title: 'Cancel Sheet proposal',
      description: 'Cancel a pending proposal without writing to Google Sheets.',
      inputSchema: { proposalId: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ...appOnlyMeta, 'ui/resourceUri': UI_URI },
    },
    async ({ proposalId }) => result(runtime.cancel(proposalId))
  );

  server.registerResource(
    'GSheets proposal review',
    UI_URI,
    {
      description: 'Visual confirmation interface for exact Google Sheets row changes.',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: { ui: { prefersBorder: true } },
    },
    async () => {
      const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'ui', 'index.html');
      return {
        contents: [
          { uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await readFile(htmlPath, 'utf8') },
        ],
      };
    }
  );

  return server;
}
