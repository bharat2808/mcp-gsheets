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
    'append_values',
    'approve_change',
    'batch_get_values',
    'batch_update_values',
    'cancel_change',
    'check_access',
    'clear_values',
    'create_spreadsheet',
    'edit_change',
    'explore_spreadsheet',
    'fetch',
    'get_catalog',
    'get_connection_status',
    'get_metadata',
    'get_recent_changes',
    'get_sheet_dimensions',
    'get_sheet_structure',
    'get_values',
    'prepare_row_change',
    'refresh_index',
    'review_change',
    'search',
    'update_values',
  ]);
  assert.equal(names.some((name) => name.startsWith('sheets_')), false);
  await client.callTool({ name: 'get_connection_status', arguments: {} });
  console.log('Built MCP artifact initialized and exposed the normalized default core surface.');
} finally {
  await client.close();
}
