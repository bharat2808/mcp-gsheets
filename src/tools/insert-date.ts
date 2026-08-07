import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getAuthenticatedClient } from '../utils/google-auth.js';
import { handleError } from '../utils/error-handler.js';
import { formatToolResponse } from '../utils/formatters.js';
import { ToolResponse } from '../types/tools.js';
import { extractSheetName, getSheetId, parseRange } from '../utils/range-helpers.js';

const insertDateInputSchema = z.object({
  spreadsheetId: z.string().min(1, 'Spreadsheet ID is required'),
  range: z.string().min(1, 'Range is required'),
  date: z.string().min(1, 'Date is required'),
  format: z.enum(['locale', 'iso', 'us', 'eu']).default('locale'),
  autoDetect: z.boolean().default(true),
  useEUFormat: z.boolean().default(true),
});

export type InsertDateInput = z.infer<typeof insertDateInputSchema>;

export const insertDateTool: Tool = {
  name: 'insert_date',
  description:
    'Insert properly formatted dates in Google Sheets with locale support and automatic detection',
  inputSchema: {
    type: 'object',
    properties: {
      spreadsheetId: {
        type: 'string',
        description: 'The ID of the spreadsheet (found in the URL after /d/)',
      },
      range: {
        type: 'string',
        description: 'The A1 notation range to insert the date (e.g., "Sheet1!A1")',
      },
      date: {
        type: 'string',
        description:
          'Date to insert (supports various formats: YYYY-MM-DD, DD.MM.YYYY, MM/DD/YYYY, or relative dates like "today", "tomorrow")',
      },
      format: {
        type: 'string',
        enum: ['locale', 'iso', 'us', 'eu'],
        description:
          'Date format preference (locale=spreadsheet locale, iso=YYYY-MM-DD, us=MM/DD/YYYY, eu=DD.MM.YYYY)',
        default: 'locale',
      },
      autoDetect: {
        type: 'boolean',
        description: 'Automatically detect and parse date format (default: true)',
        default: true,
      },
      useEUFormat: {
        type: 'boolean',
        description:
          'Use semicolon separator for EU locale sheets (auto-detected from user language/context if not specified)',
        default: true,
      },
    },
    required: ['spreadsheetId', 'range', 'date'],
  },
};

function parseDate(dateInput: string): Date {
  // Handle relative dates
  if (dateInput.toLowerCase() === 'today') {
    return new Date();
  }
  if (dateInput.toLowerCase() === 'tomorrow') {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }
  if (dateInput.toLowerCase() === 'yesterday') {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }

  // Try parsing various formats
  const isoFormat = /^\d{4}-\d{2}-\d{2}$/;
  const euFormat = /^\d{1,2}\.\d{1,2}\.\d{4}$/;
  const usFormat = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

  if (isoFormat.test(dateInput)) {
    return new Date(dateInput + 'T00:00:00');
  }

  if (euFormat.test(dateInput)) {
    const parts = dateInput.split('.');
    const day = parts[0] || '1';
    const month = parts[1] || '1';
    const year = parts[2] || '1970';
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  if (usFormat.test(dateInput)) {
    const parts = dateInput.split('/');
    const month = parts[0] || '1';
    const day = parts[1] || '1';
    const year = parts[2] || '1970';
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  }

  // Try standard Date parsing
  const parsed = new Date(dateInput);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Unable to parse date: ${dateInput}`);
  }
  return parsed;
}

function formatDateForSheets(date: Date, format: string, useEUFormat: boolean): string {
  switch (format) {
    case 'iso':
      return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1)
        .toString()
        .padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;
    case 'us':
      return `${(date.getMonth() + 1).toString()}/${date.getDate().toString()}/${date.getFullYear().toString()}`;
    case 'eu':
      return `${date.getDate().toString()}.${(date.getMonth() + 1).toString()}.${date.getFullYear().toString()}`;
    case 'locale':
    default:
      return useEUFormat
        ? `${date.getDate().toString()}.${(date.getMonth() + 1).toString()}.${date.getFullYear().toString()}`
        : `${(date.getMonth() + 1).toString()}/${date.getDate().toString()}/${date.getFullYear().toString()}`;
  }
}

function dateSerial(date: Date): number {
  return (
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(1899, 11, 30)) /
    86_400_000
  );
}

export async function handleInsertDate(input: any): Promise<ToolResponse> {
  try {
    const validatedInput = insertDateInputSchema.parse(input);
    const sheets = await getAuthenticatedClient();

    // Parse the input date
    const parsedDate = parseDate(validatedInput.date);

    // Format the date according to preference
    const formattedDate = formatDateForSheets(
      parsedDate,
      validatedInput.format,
      validatedInput.useEUFormat
    );

    const { sheetName, range: cleanRange } = extractSheetName(validatedInput.range);
    const sheetId = await getSheetId(sheets, validatedInput.spreadsheetId, sheetName);
    const gridRange = parseRange(cleanRange, sheetId);
    const pattern =
      validatedInput.format === 'iso'
        ? 'yyyy-mm-dd'
        : validatedInput.format === 'us' ||
            (validatedInput.format === 'locale' && !validatedInput.useEUFormat)
          ? 'm/d/yyyy'
          : 'd.m.yyyy';

    // Write a calendar date as a Sheets serial and set its number format atomically.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: validatedInput.spreadsheetId,
      requestBody: {
        requests: [
          {
            updateCells: {
              start: {
                sheetId,
                rowIndex: gridRange.startRowIndex ?? 0,
                columnIndex: gridRange.startColumnIndex ?? 0,
              },
              rows: [
                {
                  values: [
                    {
                      userEnteredValue: { numberValue: dateSerial(parsedDate) },
                      userEnteredFormat: {
                        numberFormat: { type: 'DATE', pattern },
                      },
                    },
                  ],
                },
              ],
              fields: 'userEnteredValue,userEnteredFormat.numberFormat',
            },
          },
        ],
      },
    });

    // Use semicolon for EU format, comma for US format
    const separator = validatedInput.useEUFormat ? ';' : ',';

    return formatToolResponse(`Successfully inserted date in range ${validatedInput.range}`, {
      spreadsheetId: validatedInput.spreadsheetId,
      range: validatedInput.range,
      originalDate: validatedInput.date,
      parsedDate: parsedDate.toISOString(),
      formattedDate,
      format: validatedInput.format,
      separator: separator,
      updatedCells: 1,
    });
  } catch (error) {
    return handleError(error);
  }
}
