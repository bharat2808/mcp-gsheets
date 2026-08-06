import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { resolveToolCategories } from '../config/toolsets.js';
import { OPERATIONS } from '../plugin/tool-registry.js';
import { GSheetsRuntime } from '../runtime/gsheets-runtime.js';

const UI_URI = 'ui://gsheets/review.html';
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

interface ToolRegistrar {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    callback: (input: any) => unknown
  ): unknown;
}

export function createGSheetsServer(
  runtime: GSheetsRuntime,
  environment: NodeJS.ProcessEnv = process.env
): McpServer {
  const server = new McpServer(
    { name: 'gsheets', version: '0.2.0' },
    {
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    }
  );
  const toolServer = server as unknown as ToolRegistrar;
  const { allowed } = resolveToolCategories(environment);

  for (const operation of OPERATIONS) {
    if (!allowed.has(operation.name)) {
      continue;
    }
    toolServer.registerTool(
      operation.name,
      {
        title: operation.title,
        description: operation.description,
        ...(operation.inputSchema ? { inputSchema: operation.inputSchema } : {}),
        annotations: operation.annotations,
        ...(operation.meta ? { _meta: operation.meta } : {}),
      },
      (input) => operation.handler(runtime, input)
    );
  }

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
