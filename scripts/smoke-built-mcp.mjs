import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createSmokeChildEnvironment } from './smoke-child-environment.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const categoryNames = {
  core: [
    'get_connection_status',
    'get_catalog',
    'get_recent_changes',
    'explore_spreadsheet',
    'search',
    'fetch',
    'refresh_index',
    'prepare_row_change',
    'review_change',
    'edit_change',
    'approve_change',
    'cancel_change',
    'check_access',
    'get_metadata',
    'get_sheet_structure',
    'get_sheet_dimensions',
    'get_values',
    'batch_get_values',
    'update_values',
    'batch_update_values',
    'append_values',
    'clear_values',
    'create_spreadsheet',
  ],
  sheets: [
    'insert_sheet',
    'delete_sheet',
    'duplicate_sheet',
    'copy_to',
    'update_sheet_properties',
    'batch_delete_sheets',
    'insert_rows',
    'delete_rows',
    'delete_columns',
    'insert_columns',
    'move_spreadsheet',
  ],
  formatting: [
    'format_cells',
    'batch_format_cells',
    'update_borders',
    'get_border_map',
    'merge_cells',
    'unmerge_cells',
    'get_merged_cells',
    'get_sheet_formatting',
    'get_formatting_compact',
    'add_conditional_formatting',
    'get_conditional_formatting',
    'get_data_validation',
    'get_basic_filter',
    'insert_link',
    'insert_date',
    'set_data_validation',
    'clear_data_validation',
    'set_basic_filter',
    'clear_basic_filter',
  ],
  charts: ['create_chart', 'update_chart', 'delete_chart'],
  tables: ['add_table', 'update_table', 'delete_table', 'get_tables'],
  analysis: ['get_full_sheet_snapshot', 'compare_ranges'],
  account: ['sign_out'],
};
const readOnlyNames = [
  'get_connection_status',
  'get_catalog',
  'get_recent_changes',
  'explore_spreadsheet',
  'search',
  'fetch',
  'refresh_index',
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
];
const sorted = (values) => [...values].sort();
const allNames = sorted(Object.values(categoryNames).flat());
const dataDirectories = [];
const credentialServices = [];

function responseData(response) {
  if (response.structuredContent?.data !== undefined) {
    return response.structuredContent.data;
  }
  const output = response.content
    .flatMap((entry) => (entry.type === 'text' ? [entry.text] : []))
    .join('\n');
  const start = output.indexOf('{');
  assert.notEqual(start, -1, `Expected JSON tool output, received: ${output}`);
  return JSON.parse(output.slice(start));
}

async function assertDisconnected(client) {
  const response = await client.callTool({ name: 'get_connection_status', arguments: {} });
  assert.notEqual(response.isError, true, 'Connection status must remain callable in smoke mode');
  assert.equal(
    responseData(response).connected,
    false,
    'Built smoke child unexpectedly observed reusable Google credentials'
  );
}

async function withBuiltClient(environment, run) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'gsheets-built-smoke-'));
  const credentialService = `gsheets-smoke-${randomUUID()}`;
  dataDirectories.push(dataDirectory);
  credentialServices.push(credentialService);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: projectRoot,
    env: createSmokeChildEnvironment(process.env, dataDirectory, credentialService, environment),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'built-artifact-smoke-test', version: '0.2.0' });
  try {
    await client.connect(transport);
    await assertDisconnected(client);
    await run(client);
  } finally {
    await client.close();
  }
}

try {
  await withBuiltClient({}, async (client) => {
    assert.deepEqual(
      sorted((await client.listTools()).tools.map((tool) => tool.name)),
      sorted(categoryNames.core)
    );
  });

  for (const [category, names] of Object.entries(categoryNames)) {
    await withBuiltClient({ GSHEETS_TOOL_CATEGORIES: category }, async (client) => {
      assert.deepEqual(
        sorted((await client.listTools()).tools.map((tool) => tool.name)),
        sorted(new Set([...categoryNames.core, ...names]))
      );
    });
  }

  await withBuiltClient({ GSHEETS_TOOL_CATEGORIES: 'all' }, async (client) => {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(sorted(tools.map((tool) => tool.name)), allNames);
    const invoked = [];
    for (const tool of tools) {
      try {
        await client.callTool({ name: tool.name, arguments: {} });
      } catch (error) {
        assert.ok(error instanceof Error, `Expected ${tool.name} schema rejection to be an Error`);
      }
      invoked.push(tool.name);
    }
    assert.deepEqual(sorted(invoked), allNames);
  });

  await withBuiltClient(
    { GSHEETS_TOOL_CATEGORIES: 'all', GSHEETS_READ_ONLY: 'true' },
    async (client) => {
      assert.deepEqual(
        sorted((await client.listTools()).tools.map((tool) => tool.name)),
        sorted(readOnlyNames)
      );
    }
  );

  console.log(
    `Built MCP validated default, seven categories, all, read-only, and schema invocation for ${allNames.length} operations.`
  );
} finally {
  const { Entry } = await import('@napi-rs/keyring');
  for (const service of credentialServices) {
    for (const account of ['local-index-key', 'google-oauth-token', 'google-oauth-client-secret']) {
      new Entry(service, account).deletePassword();
    }
  }
  await Promise.all(
    dataDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  );
}
