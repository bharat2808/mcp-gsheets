import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_ONLY_TOOL_NAMES, OPERATIONS, PUBLIC_TOOL_NAMES } from '../../../src/plugin/tool-registry.js';
import { GSheetsRuntime } from '../../../src/runtime/gsheets-runtime.js';
import { createGSheetsServer } from '../../../src/server/create-server.js';

describe('public MCP tool surface', () => {
  const server = createGSheetsServer(new GSheetsRuntime());
  const client = new Client({ name: 'test', version: '1' });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it('defaults discovery to normalized core tools and marks approval controls app-only', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const response = await client.listTools();

    const coreNames = OPERATIONS.filter((operation) => operation.category === 'core').map(
      (operation) => operation.name
    );
    expect(response.tools.map((tool) => tool.name).sort()).toEqual(coreNames.sort());
    for (const name of APP_ONLY_TOOL_NAMES) {
      const tool = response.tools.find((candidate) => candidate.name === name);
      expect(tool?._meta?.ui).toMatchObject({ visibility: ['app'] });
    }
  });

  it('discovers every normalized public operation when all categories are enabled', async () => {
    const server = createGSheetsServer(new GSheetsRuntime(), {
      GSHEETS_TOOL_CATEGORIES: 'all',
    });
    const categoryClient = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), categoryClient.connect(clientTransport)]);

    try {
      const response = await categoryClient.listTools();
      expect(response.tools.map((tool) => tool.name).sort()).toEqual([...PUBLIC_TOOL_NAMES].sort());
      expect(response.tools.every((tool) => !tool.name.startsWith('sheets_'))).toBe(true);
    } finally {
      await categoryClient.close();
      await server.close();
    }
  });

  it('registers future operations with an explicit unavailable result', async () => {
    const server = createGSheetsServer(new GSheetsRuntime(), {
      GSHEETS_TOOL_CATEGORIES: 'account',
    });
    const categoryClient = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), categoryClient.connect(clientTransport)]);

    try {
      const response = await categoryClient.callTool({ name: 'sign_out', arguments: {} });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.content)).toContain('sign_out is registered but not implemented yet');
    } finally {
      await categoryClient.close();
      await server.close();
    }
  });
});

describe('standard search and fetch protocol', () => {
  it('returns the canonical company-knowledge payload shapes', async () => {
    const runtime = {
      search: () => [
        {
          id: 'sheetrow:book:1:2',
          title: 'Accounts → Ledger → row 2',
          url: 'https://docs.google.com/spreadsheets/d/book/edit#gid=1&range=2:2',
          values: { Customer: 'Acme' },
        },
      ],
      fetch: () => ({
        id: 'sheetrow:book:1:2',
        title: 'Accounts → Ledger → row 2',
        url: 'https://docs.google.com/spreadsheets/d/book/edit#gid=1&range=2:2',
        spreadsheetId: 'book',
        sheetId: 1,
        sheetTitle: 'Ledger',
        rowNumber: 2,
        values: { Customer: 'Acme' },
      }),
    } as unknown as GSheetsRuntime;
    const server = createGSheetsServer(runtime);
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      const searchTool = listed.tools.find((tool) => tool.name === 'search');
      expect(searchTool?.inputSchema).toMatchObject({
        properties: { query: expect.any(Object) },
        required: ['query'],
      });
      expect(Object.keys(searchTool?.inputSchema.properties ?? {})).toEqual(['query']);

      const search = await client.callTool({ name: 'search', arguments: { query: 'Acme' } });
      expect(search.content).toHaveLength(1);
      expect(JSON.parse((search.content[0] as { text: string }).text)).toEqual({
        results: [expect.objectContaining({ id: 'sheetrow:book:1:2', title: expect.any(String), url: expect.any(String) })],
      });

      const fetched = await client.callTool({ name: 'fetch', arguments: { id: 'sheetrow:book:1:2' } });
      expect(fetched.content).toHaveLength(1);
      expect(JSON.parse((fetched.content[0] as { text: string }).text)).toMatchObject({
        id: 'sheetrow:book:1:2',
        title: expect.any(String),
        text: '{"Customer":"Acme"}',
        url: expect.any(String),
        metadata: { spreadsheetId: 'book', sheetId: 1, rowNumber: 2 },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('local OAuth client configuration boundary', () => {
  it('keeps OAuth credential entry out of the model-visible tool surface', async () => {
    const runtime = {} as GSheetsRuntime;
    const server = createGSheetsServer(runtime);
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      expect(
        listed.tools.find((candidate) => candidate.name === 'configure_google_oauth_client')
      ).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('app-only confirmation boundary', () => {
  it('keeps the approval token out of model-visible content and requires it on approval', async () => {
    const proposal = {
      id: '11111111-1111-4111-8111-111111111111',
      spreadsheetId: 'book',
      spreadsheetName: 'Accounts',
      spreadsheetPath: '/Finance/Accounts',
      sheetId: 1,
      sheetTitle: 'Ledger',
      operation: 'append' as const,
      values: { ID: 'A-2' },
      baseRevision: '2',
      status: 'pending' as const,
      createdAt: '2026-08-05T00:00:00Z',
      expiresAt: '2026-08-05T00:15:00Z',
      visuallyConfirmed: false,
    };
    const approve = vi.fn().mockResolvedValue({ ...proposal, status: 'applied' });
    const runtime = {
      prepare: vi.fn().mockResolvedValue(proposal),
      confirmationToken: () => 'app-only-secret-token-that-is-long-enough',
      approve,
    } as unknown as GSheetsRuntime;
    const server = createGSheetsServer(runtime);
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const prepared = await client.callTool({
        name: 'prepare_row_change',
        arguments: { spreadsheetId: 'book', sheetId: 1, operation: 'append', values: { ID: 'A-2' } },
      });
      expect(JSON.stringify(prepared.content)).not.toContain('app-only-secret-token');
      expect(prepared._meta).toMatchObject({
        'gsheets/confirmationToken': 'app-only-secret-token-that-is-long-enough',
      });

      await client.callTool({
        name: 'approve_change',
        arguments: {
          proposalId: proposal.id,
          confirmationToken: 'app-only-secret-token-that-is-long-enough',
        },
      });
      expect(approve).toHaveBeenCalledWith(
        proposal.id,
        'app-only-secret-token-that-is-long-enough'
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
