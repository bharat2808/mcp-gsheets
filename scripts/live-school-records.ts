import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CredentialVault } from '../src/auth/credential-vault.js';
import { KeyringBackend } from '../src/auth/keyring-backend.js';

export const SCHOOL_RECORDS_FLOW = {
  workbookTitle: 'School Records',
  worksheets: [
    { title: 'Students', rowCount: 100, columnCount: 10 },
    { title: 'Exams', rowCount: 100, columnCount: 10 },
    { title: 'Attendance', rowCount: 100, columnCount: 10 },
  ],
  coverage: [
    'selected-folder creation',
    'headers',
    'reviewed rows',
    'formula review',
    'reads and search',
    'safe formatting, chart, and table work',
    'destructive cancel and approve',
    'revisions, audits, and index refresh',
    'workbook disposal',
    'reviewed sign-out',
  ],
} as const;

export type LiveTestConfiguration =
  | { mode: 'dry-run' }
  | { mode: 'live'; dataDirectory: string; folderId: string };

export function resolveLiveTestConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): LiveTestConfiguration {
  if (environment.GSHEETS_LIVE_TEST !== '1') {
    return { mode: 'dry-run' };
  }
  const dataDirectory = environment.GSHEETS_LIVE_DATA_DIR?.trim();
  const folderId = environment.GSHEETS_LIVE_FOLDER_ID?.trim();
  if (!dataDirectory || !folderId) {
    throw new Error('Live mode requires GSHEETS_LIVE_DATA_DIR and GSHEETS_LIVE_FOLDER_ID.');
  }
  return { mode: 'live', dataDirectory, folderId };
}

function text(response: Awaited<ReturnType<Client['callTool']>>): string {
  return response.content
    .flatMap((entry) => (entry.type === 'text' ? [entry.text] : []))
    .join('\n');
}

function json(response: Awaited<ReturnType<Client['callTool']>>): any {
  const structured = response.structuredContent as { data?: unknown } | undefined;
  if (structured?.data !== undefined) {
    return structured.data;
  }
  const output = text(response);
  const start = output.indexOf('{');
  if (start < 0) {
    throw new Error(`Tool response did not contain JSON: ${output}`);
  }
  return JSON.parse(output.slice(start));
}

async function invoke(client: Client, name: string, arguments_: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: arguments_ });
  if (response.isError) {
    throw new Error(`${name} failed: ${text(response)}`);
  }
  return response;
}

async function prepare(client: Client, name: string, arguments_: Record<string, unknown>) {
  const response = await invoke(client, name, arguments_);
  const proposal = json(response);
  const metadata = response._meta as Record<string, unknown> | undefined;
  const confirmationToken = metadata?.['gsheets/confirmationToken'];
  assert.equal(proposal.status, 'pending', `${name} must prepare a reviewed proposal`);
  assert.equal(typeof confirmationToken, 'string', `${name} must return an app token`);
  return { proposal, confirmationToken: String(confirmationToken) };
}

async function approve(client: Client, prepared: Awaited<ReturnType<typeof prepare>>) {
  const response = await invoke(client, 'approve_change', {
    proposalId: prepared.proposal.id,
    confirmationToken: prepared.confirmationToken,
  });
  assert.equal(json(response).status, 'applied');
  return response;
}

async function trashWorkbook(spreadsheetId: string): Promise<void> {
  const tokens = await new CredentialVault(new KeyringBackend()).loadTokens();
  if (!tokens) {
    throw new Error('OAuth tokens disappeared before disposable workbook cleanup');
  }
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}?fields=id%2Ctrashed`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Disposable workbook ${spreadsheetId} cleanup failed with HTTP ${response.status}`
    );
  }
}

export async function runLiveSchoolRecords(
  configuration: Extract<LiveTestConfiguration, { mode: 'live' }>
) {
  const environment = Object.fromEntries(
    Object.entries({
      ...process.env,
      GSHEETS_DATA_DIR: configuration.dataDirectory,
      GSHEETS_TOOL_CATEGORIES: 'all',
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: process.cwd(),
    env: environment,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'school-records-live-acceptance', version: '0.2.0' });
  let spreadsheetId = '';
  try {
    await client.connect(transport);
    const status = json(await invoke(client, 'get_connection_status', {}));
    assert.equal(status.connected, true, `Connect the isolated profile first: ${status.setupUrl}`);

    const created = json(
      await invoke(client, 'create_spreadsheet', {
        title: SCHOOL_RECORDS_FLOW.workbookTitle,
        folderId: configuration.folderId,
        sheets: SCHOOL_RECORDS_FLOW.worksheets,
      })
    );
    spreadsheetId = created.spreadsheetId;
    assert.equal(typeof spreadsheetId, 'string');

    const metadata = json(await invoke(client, 'get_metadata', { spreadsheetId }));
    const ids = Object.fromEntries(
      metadata.sheets.map((sheet: any) => [sheet.title, sheet.sheetId])
    );
    assert.deepEqual(Object.keys(ids).sort(), ['Attendance', 'Exams', 'Students']);

    await invoke(client, 'update_values', {
      spreadsheetId,
      range: 'Students!A1',
      values: [['Student ID', 'Name', 'Grade']],
      valueInputOption: 'USER_ENTERED',
    });
    await invoke(client, 'update_values', {
      spreadsheetId,
      range: 'Exams!A1',
      values: [['Exam ID', 'Student ID', 'Subject', 'Score', 'Max Score', 'Percentage']],
      valueInputOption: 'USER_ENTERED',
    });
    await invoke(client, 'update_values', {
      spreadsheetId,
      range: 'Attendance!A1',
      values: [['Date', 'Student ID', 'Status']],
      valueInputOption: 'USER_ENTERED',
    });

    await approve(
      client,
      await prepare(client, 'append_values', {
        spreadsheetId,
        range: 'Students!A:C',
        values: [['S-001', 'Asha Rao', '10']],
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      })
    );
    await approve(
      client,
      await prepare(client, 'append_values', {
        spreadsheetId,
        range: 'Exams!A:F',
        values: [['E-001', 'S-001', 'Mathematics', 88, 100, '']],
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      })
    );
    await approve(
      client,
      await prepare(client, 'append_values', {
        spreadsheetId,
        range: 'Attendance!A:C',
        values: [['2026-08-06', 'S-001', 'Present']],
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
      })
    );
    await approve(
      client,
      await prepare(client, 'update_values', {
        spreadsheetId,
        range: 'Exams!F2',
        values: [['=D2/E2']],
        valueInputOption: 'USER_ENTERED',
      })
    );

    const values = json(
      await invoke(client, 'get_values', { spreadsheetId, range: 'Students!A1:C2' })
    );
    assert.equal(values.values[1][1], 'Asha Rao');
    await invoke(client, 'refresh_index', {});
    const search = JSON.parse(text(await invoke(client, 'search', { query: 'Asha' })));
    assert.ok(search.results.length > 0);
    await invoke(client, 'fetch', { id: search.results[0].id });

    await invoke(client, 'format_cells', {
      spreadsheetId,
      range: 'Students!A1:C1',
      format: { textFormat: { bold: true }, backgroundColor: { green: 0.7 } },
    });
    await invoke(client, 'create_chart', {
      spreadsheetId,
      position: {
        overlayPosition: { anchorCell: { sheetId: ids.Exams, rowIndex: 0, columnIndex: 8 } },
      },
      chartType: 'COLUMN',
      title: 'Exam scores',
      domainRange: 'Exams!C2:C2',
      series: [{ sourceRange: 'Exams!D2:D2' }],
    });
    await invoke(client, 'add_table', {
      spreadsheetId,
      sheetName: 'Students',
      range: 'A1:C2',
      name: 'StudentsTable',
      columns: [
        { name: 'Student ID', columnType: 'TEXT' },
        { name: 'Name', columnType: 'TEXT' },
        { name: 'Grade', columnType: 'TEXT' },
      ],
    });

    await invoke(client, 'insert_sheet', { spreadsheetId, title: 'Disposable' });
    const disposable = json(await invoke(client, 'get_metadata', { spreadsheetId })).sheets.find(
      (sheet: any) => sheet.title === 'Disposable'
    );
    const firstDelete = await prepare(client, 'delete_sheet', {
      spreadsheetId,
      sheetId: disposable.sheetId,
    });
    await invoke(client, 'cancel_change', { proposalId: firstDelete.proposal.id });
    await approve(
      client,
      await prepare(client, 'delete_sheet', { spreadsheetId, sheetId: disposable.sheetId })
    );

    await invoke(client, 'refresh_index', {});
    const changes = json(await invoke(client, 'get_recent_changes', { limit: 100 }));
    assert.ok(changes.approvedWrites.length > 0);
    await trashWorkbook(spreadsheetId);
    spreadsheetId = '';
    await approve(client, await prepare(client, 'sign_out', { revokeGoogleGrant: false }));
    console.log('Live School Records acceptance completed and the workbook was moved to trash.');
  } finally {
    await client.close();
    if (spreadsheetId) {
      await trashWorkbook(spreadsheetId);
    }
  }
}

export async function main(): Promise<void> {
  const configuration = resolveLiveTestConfiguration(process.env);
  if (configuration.mode === 'dry-run') {
    console.log('LIVE TEST NOT RUN: set GSHEETS_LIVE_TEST=1 with the documented prerequisites.');
    console.log(JSON.stringify(SCHOOL_RECORDS_FLOW, null, 2));
    return;
  }
  await runLiveSchoolRecords(configuration);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
