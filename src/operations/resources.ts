import { AffectedResource } from '../proposals/proposal-manager.js';

export function extractOperationResources(
  operation: string,
  arguments_: Record<string, unknown>
): AffectedResource[] {
  if (operation === 'sign_out') {
    return [{ kind: 'account', id: 'google', label: 'Connected Google account' }];
  }
  const resources: AffectedResource[] = [];
  const seen = new Set<string>();
  const add = (resource: AffectedResource) => {
    const key = `${resource.kind}:${resource.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      resources.push(resource);
    }
  };
  const sourceId =
    typeof arguments_.spreadsheetId === 'string' ? arguments_.spreadsheetId : undefined;
  if (sourceId) {
    add({ kind: 'spreadsheet', id: sourceId, label: sourceId });
  }
  const destinationId =
    typeof arguments_.destinationSpreadsheetId === 'string'
      ? arguments_.destinationSpreadsheetId
      : undefined;
  if (destinationId) {
    add({ kind: 'spreadsheet', id: destinationId, label: destinationId });
  }
  if (sourceId && typeof arguments_.sheetId === 'number') {
    add({
      kind: 'sheet',
      id: `${sourceId}:${arguments_.sheetId}`,
      label: `Sheet ${arguments_.sheetId}`,
    });
  }
  if (sourceId && Array.isArray(arguments_.sheetIds)) {
    for (const sheetId of arguments_.sheetIds) {
      if (typeof sheetId === 'number') {
        add({ kind: 'sheet', id: `${sourceId}:${sheetId}`, label: `Sheet ${sheetId}` });
      }
    }
  }
  if (sourceId && typeof arguments_.range === 'string') {
    add({ kind: 'range', id: `${sourceId}:${arguments_.range}`, label: arguments_.range });
  }
  if (sourceId && Array.isArray(arguments_.data)) {
    for (const entry of arguments_.data) {
      const range = (entry as { range?: unknown } | null)?.range;
      if (typeof range === 'string') {
        add({ kind: 'range', id: `${sourceId}:${range}`, label: range });
      }
    }
  }
  if (sourceId && typeof arguments_.chartId === 'number') {
    add({
      kind: 'chart',
      id: `${sourceId}:${arguments_.chartId}`,
      label: `Chart ${arguments_.chartId}`,
    });
  }
  if (sourceId && typeof arguments_.tableId === 'string') {
    add({
      kind: 'table',
      id: `${sourceId}:${arguments_.tableId}`,
      label: `Table ${arguments_.tableId}`,
    });
  }
  return resources;
}

export function spreadsheetResourceIds(resources: readonly AffectedResource[]): string[] {
  return resources
    .filter((resource) => resource.kind === 'spreadsheet')
    .map((resource) => resource.id);
}
