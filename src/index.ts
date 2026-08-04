#!/usr/bin/env node

if (process.env.NODE_ENV === 'development') {
  try {
    const { config } = await import('dotenv');
    config();
    console.error('Loaded .env file for development');
  } catch (error) {
    console.error('Failed to load .env file:', error);
  }
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { GSheetsRuntime } from './runtime/gsheets-runtime.js';
import { createGSheetsServer } from './server/create-server.js';

const runtime = new GSheetsRuntime();

async function main(): Promise<void> {
  await runtime.initialize();
  const server = createGSheetsServer(runtime);
  await server.connect(new StdioServerTransport());
  console.error('GSheets local plugin running on stdio');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void runtime.close().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error('Fatal error:', error);
  void runtime.close().finally(() => process.exit(1));
});
