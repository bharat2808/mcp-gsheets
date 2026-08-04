import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Codex plugin package', () => {
  it('declares the gsheets plugin and bundled MCP server', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, '.codex-plugin/plugin.json'), 'utf8')
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      name: 'gsheets',
      mcpServers: './.mcp.json',
      skills: './skills/',
    });
  });

  it('launches the bundled server from the plugin root', () => {
    const config = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd: string }>;
    };

    expect(config.mcpServers.gsheets).toEqual({
      command: 'node',
      args: ['./dist/index.js'],
      cwd: '.',
    });
  });
});
