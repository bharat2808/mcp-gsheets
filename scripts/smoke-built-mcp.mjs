import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: projectRoot,
  stderr: 'pipe',
});
const client = new Client({ name: 'built-artifact-smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'approve_sheet_proposal',
    'cancel_sheet_proposal',
    'edit_sheet_proposal',
    'explore_spreadsheet',
    'fetch',
    'get_connection_status',
    'get_recent_changes',
    'get_sheets_catalog',
    'prepare_sheet_change',
    'refresh_sheets_index',
    'review_sheet_change',
    'search',
  ]);
  await client.callTool({ name: 'get_connection_status', arguments: {} });
  console.log('Built MCP artifact initialized and exposed the curated tool surface.');
} finally {
  await client.close();
}
