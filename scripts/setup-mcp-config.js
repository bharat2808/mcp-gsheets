#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const server = resolve(projectRoot, 'dist/index.js');

if (!existsSync(server)) {
  console.error('Build the plugin first with: npm run build');
  process.exitCode = 1;
} else {
  console.log('Desktop OAuth setup');
  console.log('1. Enable the Google Sheets API and Google Drive API in a Google Cloud project.');
  console.log('2. Create an OAuth client with application type Desktop app.');
  console.log('3. Add the MCP configuration below and start the server.');
  console.log('4. Call get_connection_status and open its localhost setup URL.');
  console.log(
    '5. Enter the client ID and secret on that page, consent, and select owned My Drive folders.'
  );
  console.log('');
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          gsheets: {
            command: process.execPath,
            args: [server],
            env: {
              GSHEETS_TOOL_CATEGORIES: 'core',
            },
          },
        },
      },
      null,
      2
    )
  );
  console.log('');
  console.log(
    'This release requests full Drive plus Sheets access. Existing 0.1.x users reconnect once.'
  );
  console.log('OAuth secrets and tokens are never placed in this MCP configuration.');
}
