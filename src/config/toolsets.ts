import { OPERATIONS, TOOL_CATEGORIES, ToolCategory } from '../plugin/tool-registry.js';

export { TOOL_CATEGORIES };
export type { ToolCategory };

export interface ToolCategoryConfig {
  enabled: ToolCategory[];
  readOnly: boolean;
  allowed: ReadonlySet<string>;
}

export class ToolCategoryConfigError extends Error {}

function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveToolCategories(env: NodeJS.ProcessEnv = process.env): ToolCategoryConfig {
  const raw = env.GSHEETS_TOOL_CATEGORIES?.trim();
  const readOnly = env.GSHEETS_READ_ONLY?.trim().toLowerCase() === 'true';

  let enabled: ToolCategory[];
  if (!raw) {
    enabled = ['core'];
  } else if (raw.toLowerCase() === 'all') {
    enabled = [...TOOL_CATEGORIES];
  } else {
    const requested = parseList(raw);
    const unknown = requested.filter((name) => !TOOL_CATEGORIES.includes(name as ToolCategory));
    if (unknown.length > 0) {
      throw new ToolCategoryConfigError(
        `Unknown tool categor${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')}. ` +
          `Valid categories: ${TOOL_CATEGORIES.join(', ')}, all.`
      );
    }
    const selected = new Set<ToolCategory>(requested as ToolCategory[]);
    selected.add('core');
    enabled = TOOL_CATEGORIES.filter((category) => selected.has(category));
  }

  const allowed = new Set(
    OPERATIONS.filter(
      (operation) => enabled.includes(operation.category) && (!readOnly || operation.readOnly)
    ).map((operation) => operation.name)
  );

  return { enabled, readOnly, allowed };
}
