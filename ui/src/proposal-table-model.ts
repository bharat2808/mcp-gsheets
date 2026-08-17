export interface ProposalValueSection {
  worksheetName: string;
  range: string;
  before: unknown[][] | Record<string, unknown> | null;
  after: unknown[][] | Record<string, unknown>;
}

export interface EditableTableSection {
  worksheetName: string;
  range: string;
  valueShape: 'grid' | 'record';
  columns: string[];
  before: unknown[][];
  after: unknown[][];
}

function columnName(index: number): string {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function rectangular(rows: unknown[][], rowCount: number, columnCount: number): unknown[][] {
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: columnCount }, (_, columnIndex) => rows[rowIndex]?.[columnIndex] ?? '')
  );
}

function tableSection(section: ProposalValueSection): EditableTableSection {
  const recordShape = !Array.isArray(section.after);
  if (recordShape) {
    const before =
      section.before && !Array.isArray(section.before)
        ? (section.before as Record<string, unknown>)
        : {};
    const after = section.after as Record<string, unknown>;
    const columns = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return {
      worksheetName: section.worksheetName,
      range: section.range,
      valueShape: 'record',
      columns,
      before: [columns.map((column) => before[column] ?? '')],
      after: [columns.map((column) => after[column] ?? '')],
    };
  }

  const before = Array.isArray(section.before) ? section.before : [];
  const after = section.after as unknown[][];
  const rowCount = Math.max(before.length, after.length);
  const columnCount = Math.max(
    1,
    ...before.map((row) => row.length),
    ...after.map((row) => row.length)
  );
  return {
    worksheetName: section.worksheetName,
    range: section.range,
    valueShape: 'grid',
    columns: Array.from({ length: columnCount }, (_, index) => columnName(index)),
    before: rectangular(before, rowCount, columnCount),
    after: rectangular(after, rowCount, columnCount),
  };
}

export function proposalTableModel(proposal: {
  operation: string;
  presentation?: { spreadsheetName: string; valueSections: ProposalValueSection[] };
}): EditableTableSection[] {
  return proposal.presentation?.valueSections.map(tableSection) ?? [];
}

export function updateTableCell(
  sections: readonly EditableTableSection[],
  sectionIndex: number,
  rowIndex: number,
  columnIndex: number,
  value: unknown
): EditableTableSection[] {
  return sections.map((section, currentSection) =>
    currentSection !== sectionIndex
      ? section
      : {
          ...section,
          after: section.after.map((row, currentRow) =>
            currentRow !== rowIndex
              ? row
              : row.map((cell, currentColumn) =>
                  currentColumn === columnIndex ? value : cell
                )
          ),
        }
  );
}

export function editableValuesForOperation(
  operation: string,
  sections: readonly EditableTableSection[]
): unknown {
  if (operation === 'batch_update_values') {
    return sections.map((section) => ({ range: section.range, values: section.after }));
  }
  const first = sections[0];
  if (!first) return [];
  if (operation === 'prepare_row_change' || first.valueShape === 'record') {
    return Object.fromEntries(first.columns.map((column, index) => [column, first.after[0]?.[index]]));
  }
  return first.after;
}
