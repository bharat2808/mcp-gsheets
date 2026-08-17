import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('Codex plugin package', () => {
  it('publishes the breaking 0.2.0 package and one Codex plugin cachebuster', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    const manifest = JSON.parse(
      readFileSync(resolve(root, '.codex-plugin/plugin.json'), 'utf8')
    ) as { version: string };

    expect(packageJson.version).toBe('0.2.0');
    expect(manifest.version).toMatch(/^0\.2\.0\+codex\.[^.]+$/u);
  });

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
      mcpServers: Record<
        string,
        { command: string; args: string[]; cwd: string; env_vars: string[] }
      >;
    };

    expect(config.mcpServers.gsheets).toEqual({
      command: 'node',
      args: ['./dist/index.js'],
      cwd: '.',
      env_vars: [
        'GSHEETS_GOOGLE_CLIENT_ID',
        'GSHEETS_DATA_DIR',
        'GSHEETS_TOOL_CATEGORIES',
        'GSHEETS_READ_ONLY',
      ],
    });
  });

  it('ships the Google API client required by retained Desktop OAuth handlers', () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.googleapis).toBe('^171.0.0');
  });
});
