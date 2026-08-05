import { describe, expect, it } from 'vitest';

import {
  TOOL_CATEGORIES,
  resolveToolCategories,
  ToolCategoryConfigError,
} from '../../../src/config/toolsets.js';
import { APP_ONLY_TOOL_NAMES, OPERATIONS, PUBLIC_TOOL_NAMES } from '../../../src/plugin/tool-registry.js';

function operation(name: string) {
  const found = OPERATIONS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

describe('tool category definitions', () => {
  it('covers every registered operation exactly once', () => {
    expect(OPERATIONS.map((operation) => operation.name)).toEqual(PUBLIC_TOOL_NAMES);
    expect(new Set(PUBLIC_TOOL_NAMES).size).toBe(PUBLIC_TOOL_NAMES.length);
  });

  it('gives every operation a schema, annotation, and dispatch entry', () => {
    for (const entry of OPERATIONS) {
      expect(entry.annotations).toBeTypeOf('object');
      expect(entry.handler).toBeTypeOf('function');
    }
  });

  it('keeps core self-sufficient for connection, discovery, and value access', () => {
    for (const name of ['get_connection_status', 'get_catalog', 'get_values', 'update_values']) {
      expect(operation(name).category).toBe('core');
    }
  });
});

describe('resolveToolCategories', () => {
  it('defaults unset and empty configuration to the core category', () => {
    for (const value of [undefined, '', '   ']) {
      const { enabled, allowed } = resolveToolCategories(
        value === undefined ? {} : { GSHEETS_TOOL_CATEGORIES: value }
      );
      expect(enabled).toEqual(['core']);
      expect([...allowed]).toEqual(
        OPERATIONS.filter((operation) => operation.category === 'core').map((operation) => operation.name)
      );
    }
  });

  it('enables requested categories and always includes core', () => {
    const { enabled, allowed } = resolveToolCategories({
      GSHEETS_TOOL_CATEGORIES: 'charts,account',
    });
    expect(enabled).toEqual(['core', 'charts', 'account']);
    expect(allowed.has('get_connection_status')).toBe(true);
    expect(allowed.has('create_chart')).toBe(true);
    expect(allowed.has('sign_out')).toBe(true);
    expect(allowed.has('format_cells')).toBe(false);
  });

  it('enables every category for all', () => {
    const { enabled, allowed } = resolveToolCategories({ GSHEETS_TOOL_CATEGORIES: 'all' });
    expect(enabled).toEqual([...TOOL_CATEGORIES]);
    expect([...allowed]).toEqual([...PUBLIC_TOOL_NAMES]);
  });

  it('keeps core when a single non-core category is requested', () => {
    const { enabled, allowed } = resolveToolCategories({ GSHEETS_TOOL_CATEGORIES: 'charts' });
    expect(enabled).toEqual(['core', 'charts']);
    expect(allowed.has('get_connection_status')).toBe(true);
    expect(allowed.has('create_chart')).toBe(true);
  });

  it('accepts category names with mixed case and spacing', () => {
    expect(
      resolveToolCategories({ GSHEETS_TOOL_CATEGORIES: ' Charts , TABLES ' }).enabled
    ).toEqual(['core', 'charts', 'tables']);
  });

  it('returns categories in declaration order regardless of input order', () => {
    expect(
      resolveToolCategories({ GSHEETS_TOOL_CATEGORIES: 'analysis,charts,core' }).enabled
    ).toEqual(['core', 'charts', 'analysis']);
  });

  it('ignores duplicate category names', () => {
    expect(resolveToolCategories({ GSHEETS_TOOL_CATEGORIES: 'charts,charts' }).enabled).toEqual([
      'core',
      'charts',
    ]);
  });

  it('rejects unknown categories rather than silently omitting them', () => {
    expect(() => resolveToolCategories({ GSHEETS_TOOL_CATEGORIES: 'core,chart' })).toThrow(
      ToolCategoryConfigError
    );
  });

  it('reports every unknown category and the valid category names', () => {
    try {
      resolveToolCategories({ GSHEETS_TOOL_CATEGORIES: 'nope,alsonope' });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('nope, alsonope');
      expect(message).toContain('core, sheets, formatting, charts, tables, analysis, account, all');
    }
  });
});

describe('GSHEETS_READ_ONLY', () => {
  it('excludes every mutation and every proposal-management operation', () => {
    const { readOnly, allowed } = resolveToolCategories({
      GSHEETS_TOOL_CATEGORIES: 'all',
      GSHEETS_READ_ONLY: 'true',
    });
    expect(readOnly).toBe(true);
    for (const operation of OPERATIONS.filter((operation) => !operation.readOnly)) {
      expect(allowed.has(operation.name)).toBe(false);
    }
    for (const operation of APP_ONLY_TOOL_NAMES) {
      expect(allowed.has(operation)).toBe(false);
    }
  });

  it('intersects read-only mode with category filtering', () => {
    const { allowed } = resolveToolCategories({
      GSHEETS_TOOL_CATEGORIES: 'core,charts',
      GSHEETS_READ_ONLY: 'true',
    });
    expect(allowed.has('get_values')).toBe(true);
    expect(allowed.has('update_values')).toBe(false);
    expect(allowed.has('create_chart')).toBe(false);
  });

  it('enables read-only mode only for true, regardless of case', () => {
    for (const value of ['false', '1', 'yes', '']) {
      expect(resolveToolCategories({ GSHEETS_READ_ONLY: value }).readOnly).toBe(false);
    }
    expect(resolveToolCategories({ GSHEETS_READ_ONLY: 'TRUE' }).readOnly).toBe(true);
  });
});

describe('registry annotations', () => {
  it('marks read operations read-only and idempotent', () => {
    expect(operation('get_values').annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
    });
  });

  it('leaves legacy destructive operations at the destructive default', () => {
    const annotations = operation('delete_sheet').annotations;
    expect(annotations.destructiveHint).toBeUndefined();
    expect(annotations.readOnlyHint).toBeUndefined();
  });

  it('marks non-destructive writes explicitly', () => {
    expect(operation('update_values').annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('omits idempotentHint for append', () => {
    expect(operation('append_values').annotations.idempotentHint).toBeUndefined();
    expect(operation('update_values').annotations.idempotentHint).toBe(true);
  });

  it('omits unrelated MCP defaults', () => {
    for (const entry of OPERATIONS) {
      const annotations = entry.annotations;
      expect(annotations.readOnlyHint).not.toBe(false);
      expect(annotations.idempotentHint).not.toBe(false);
      expect(annotations.openWorldHint).not.toBe(true);
    }
  });
});
