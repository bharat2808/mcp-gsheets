import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ReplaceSheetRowsInput,
  RecentChange,
  SearchHit,
  SpreadsheetRecord,
  WriteAudit,
} from '../domain/types.js';
import { decryptJson, encryptJson, hashSearchToken, normalizeSearchTerms } from './crypto.js';
import { fingerprintRow } from '../indexing/rows.js';

interface SearchDatabaseRow {
  row_id: string;
  spreadsheet_id: string;
  spreadsheet_name: string;
  sheet_id: number;
  sheet_title: string;
  row_number: number;
  payload: string;
}

export class LocalIndex {
  readonly #databasePath: string;
  readonly #key: Buffer;
  #database: DatabaseSync | null = null;

  constructor(databasePath: string, key: Uint8Array) {
    this.#databasePath = databasePath;
    this.#key = Buffer.from(key);
  }

  initialize(): void {
    if (this.#database) {
      return;
    }
    mkdirSync(dirname(this.#databasePath), { recursive: true });
    const database = new DatabaseSync(this.#databasePath);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    database.exec(`
      CREATE TABLE IF NOT EXISTS spreadsheets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        modified_time TEXT NOT NULL,
        version TEXT NOT NULL,
        index_status TEXT NOT NULL CHECK(index_status IN ('current','stale','pending','unavailable')),
        last_indexed_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sheets (
        sheet_key TEXT PRIMARY KEY,
        spreadsheet_id TEXT NOT NULL REFERENCES spreadsheets(id) ON DELETE CASCADE,
        sheet_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        used_range TEXT NOT NULL,
        encrypted_headers TEXT NOT NULL,
        identifier_column TEXT,
        encrypted_tables TEXT,
        UNIQUE(spreadsheet_id, sheet_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rows (
        row_id TEXT PRIMARY KEY,
        sheet_key TEXT NOT NULL REFERENCES sheets(sheet_key) ON DELETE CASCADE,
        row_number INTEGER NOT NULL,
        encrypted_payload TEXT NOT NULL,
        encrypted_raw_payload TEXT,
        fingerprint TEXT NOT NULL,
        UNIQUE(sheet_key, row_number)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS search_tokens (
        token_hash TEXT NOT NULL,
        row_id TEXT NOT NULL REFERENCES rows(row_id) ON DELETE CASCADE,
        PRIMARY KEY(token_hash, row_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS search_tokens_by_row ON search_tokens(row_id);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        encrypted_value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS recent_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        detected_at TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS recent_changes_by_time ON recent_changes(detected_at DESC);
      CREATE TABLE IF NOT EXISTS write_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        applied_at TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS write_audits_by_time ON write_audits(applied_at DESC);
    `);
    const sheetColumns = database.prepare('PRAGMA table_info(sheets)').all() as unknown as Array<{
      name: string;
    }>;
    let requiresReindex = false;
    if (!sheetColumns.some((column) => column.name === 'encrypted_tables')) {
      database.exec('ALTER TABLE sheets ADD COLUMN encrypted_tables TEXT');
      requiresReindex = true;
    }
    const rowColumns = database.prepare('PRAGMA table_info(rows)').all() as unknown as Array<{
      name: string;
    }>;
    if (!rowColumns.some((column) => column.name === 'encrypted_raw_payload')) {
      database.exec('ALTER TABLE rows ADD COLUMN encrypted_raw_payload TEXT');
      requiresReindex = true;
    }
    if (requiresReindex) {
      database.exec("UPDATE spreadsheets SET index_status = 'stale'");
    }
    this.#database = database;
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }

  upsertSpreadsheet(record: SpreadsheetRecord): void {
    this.#db()
      .prepare(
        `INSERT INTO spreadsheets
          (id, name, path, modified_time, version, index_status, last_indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          path = excluded.path,
          modified_time = excluded.modified_time,
          version = excluded.version,
          index_status = excluded.index_status,
          last_indexed_at = excluded.last_indexed_at`
      )
      .run(
        record.id,
        record.name,
        record.path,
        record.modifiedTime,
        record.version,
        record.indexStatus,
        record.lastIndexedAt
      );
  }

  getCatalog(): SpreadsheetRecord[] {
    const rows = this.#db()
      .prepare(
        `SELECT id, name, path, modified_time, version, index_status, last_indexed_at
         FROM spreadsheets ORDER BY path, name`
      )
      .all() as Array<{
      id: string;
      name: string;
      path: string;
      modified_time: string;
      version: string;
      index_status: SpreadsheetRecord['indexStatus'];
      last_indexed_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      modifiedTime: row.modified_time,
      version: row.version,
      indexStatus: row.index_status,
      lastIndexedAt: row.last_indexed_at,
    }));
  }

  retainSpreadsheets(ids: readonly string[]): void {
    if (ids.length === 0) {
      this.#db().prepare('DELETE FROM spreadsheets').run();
      return;
    }
    const placeholders = ids.map(() => '?').join(',');
    this.#db()
      .prepare(`DELETE FROM spreadsheets WHERE id NOT IN (${placeholders})`)
      .run(...ids);
  }

  retainSheets(spreadsheetId: string, sheetIds: readonly number[]): void {
    if (sheetIds.length === 0) {
      this.#db().prepare('DELETE FROM sheets WHERE spreadsheet_id = ?').run(spreadsheetId);
      return;
    }
    const placeholders = sheetIds.map(() => '?').join(',');
    this.#db()
      .prepare(`DELETE FROM sheets WHERE spreadsheet_id = ? AND sheet_id NOT IN (${placeholders})`)
      .run(spreadsheetId, ...sheetIds);
  }

  setSelectedFolderIds(ids: readonly string[]): void {
    this.#db()
      .prepare(
        `INSERT INTO settings (key, encrypted_value) VALUES ('selected-folders', ?)
         ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`
      )
      .run(encryptJson(this.#key, [...new Set(ids)], 'setting:selected-folders'));
  }

  getSelectedFolderIds(): string[] {
    const row = this.#db()
      .prepare("SELECT encrypted_value FROM settings WHERE key = 'selected-folders'")
      .get() as { encrypted_value: string } | undefined;
    return row
      ? decryptJson<string[]>(this.#key, row.encrypted_value, 'setting:selected-folders')
      : [];
  }

  setAccountIdentity(identity: string): void {
    this.#db()
      .prepare(
        `INSERT INTO settings (key, encrypted_value) VALUES ('account-identity', ?)
         ON CONFLICT(key) DO UPDATE SET encrypted_value = excluded.encrypted_value`
      )
      .run(encryptJson(this.#key, identity, 'setting:account-identity'));
  }

  getAccountIdentity(): string | null {
    const row = this.#db()
      .prepare("SELECT encrypted_value FROM settings WHERE key = 'account-identity'")
      .get() as { encrypted_value: string } | undefined;
    return row
      ? decryptJson<string>(this.#key, row.encrypted_value, 'setting:account-identity')
      : null;
  }

  clearAccountData(): void {
    const database = this.#db();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`
        DELETE FROM spreadsheets;
        DELETE FROM settings;
        DELETE FROM recent_changes;
        DELETE FROM write_audits;
      `);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  recordChanges(change: RecentChange): void {
    if (change.changes.length === 0) {
      return;
    }
    const result = this.#db()
      .prepare('INSERT INTO recent_changes (detected_at, encrypted_payload) VALUES (?, ?)')
      .run(change.detectedAt, 'pending');
    const id = Number(result.lastInsertRowid);
    this.#db()
      .prepare('UPDATE recent_changes SET encrypted_payload = ? WHERE id = ?')
      .run(encryptJson(this.#key, change, `change:${id}`), id);
  }

  getRecentChanges(limit = 100): RecentChange[] {
    const rows = this.#db()
      .prepare(
        'SELECT id, encrypted_payload FROM recent_changes ORDER BY detected_at DESC, id DESC LIMIT ?'
      )
      .all(limit) as unknown as Array<{ id: number; encrypted_payload: string }>;
    return rows.map((row) =>
      decryptJson<RecentChange>(this.#key, row.encrypted_payload, `change:${row.id}`)
    );
  }

  recordWriteAudit(audit: WriteAudit): void {
    const result = this.#db()
      .prepare('INSERT INTO write_audits (applied_at, encrypted_payload) VALUES (?, ?)')
      .run(audit.appliedAt, 'pending');
    const id = Number(result.lastInsertRowid);
    this.#db()
      .prepare('UPDATE write_audits SET encrypted_payload = ? WHERE id = ?')
      .run(encryptJson(this.#key, audit, `write-audit:${id}`), id);
  }

  getWriteAudits(limit = 100): WriteAudit[] {
    const rows = this.#db()
      .prepare(
        'SELECT id, encrypted_payload FROM write_audits ORDER BY applied_at DESC, id DESC LIMIT ?'
      )
      .all(limit) as unknown as Array<{ id: number; encrypted_payload: string }>;
    return rows.map((row) =>
      decryptJson<WriteAudit>(this.#key, row.encrypted_payload, `write-audit:${row.id}`)
    );
  }

  getSheetSnapshot(
    spreadsheetId: string,
    sheetId: number
  ): import('../indexing/rows.js').SheetSnapshot | null {
    const sheetKey = `${spreadsheetId}:${sheetId}`;
    const sheet = this.#db()
      .prepare('SELECT encrypted_headers, identifier_column FROM sheets WHERE sheet_key = ?')
      .get(sheetKey) as { encrypted_headers: string; identifier_column: string | null } | undefined;
    if (!sheet) {
      return null;
    }
    const rows = this.#db()
      .prepare(
        'SELECT row_number, row_id, encrypted_payload FROM rows WHERE sheet_key = ? ORDER BY row_number'
      )
      .all(sheetKey) as unknown as Array<{
      row_number: number;
      row_id: string;
      encrypted_payload: string;
    }>;
    return {
      headers: decryptJson<string[]>(this.#key, sheet.encrypted_headers, `headers:${sheetKey}`),
      identifierColumn: sheet.identifier_column,
      rows: rows.map((row) => ({
        rowNumber: row.row_number,
        values: decryptJson<Record<string, import('../domain/types.js').CellValue>>(
          this.#key,
          row.encrypted_payload,
          row.row_id
        ),
      })),
    };
  }

  getSpreadsheetDetails(spreadsheetId: string): {
    spreadsheet: SpreadsheetRecord;
    sheets: Array<{
      sheetId: number;
      title: string;
      usedRange: string;
      headers: string[];
      tables: import('../domain/types.js').IndexedTable[];
      rowCount: number;
    }>;
  } | null {
    const spreadsheet = this.getCatalog().find((entry) => entry.id === spreadsheetId);
    if (!spreadsheet) {
      return null;
    }
    const rows = this.#db()
      .prepare(
        `SELECT s.sheet_key, s.sheet_id, s.title, s.used_range, s.encrypted_headers, s.encrypted_tables, COUNT(r.row_id) AS row_count
         FROM sheets s LEFT JOIN rows r ON r.sheet_key = s.sheet_key
         WHERE s.spreadsheet_id = ? GROUP BY s.sheet_key ORDER BY s.title`
      )
      .all(spreadsheetId) as unknown as Array<{
      sheet_key: string;
      sheet_id: number;
      title: string;
      used_range: string;
      encrypted_headers: string;
      encrypted_tables: string | null;
      row_count: number;
    }>;
    return {
      spreadsheet,
      sheets: rows.map((row) => ({
        sheetId: row.sheet_id,
        title: row.title,
        usedRange: row.used_range,
        headers: decryptJson<string[]>(
          this.#key,
          row.encrypted_headers,
          `headers:${row.sheet_key}`
        ),
        tables: row.encrypted_tables
          ? decryptJson<import('../domain/types.js').IndexedTable[]>(
              this.#key,
              row.encrypted_tables,
              `tables:${row.sheet_key}`
            )
          : [],
        rowCount: row.row_count,
      })),
    };
  }

  fetch(id: string): SearchHit | null {
    if (!id.startsWith('sheetrow:')) {
      return null;
    }
    const parts = id.split(':');
    const spreadsheetId = parts[1];
    const sheetId = Number(parts[2]);
    const rowNumber = Number(parts[3]);
    if (!spreadsheetId || !Number.isInteger(sheetId) || !Number.isInteger(rowNumber)) {
      return null;
    }
    const snapshot = this.getSheetSnapshot(spreadsheetId, sheetId);
    const spreadsheet = this.getCatalog().find((entry) => entry.id === spreadsheetId);
    const details = this.getSpreadsheetDetails(spreadsheetId);
    const sheet = details?.sheets.find((entry) => entry.sheetId === sheetId);
    const row = snapshot?.rows.find((entry) => entry.rowNumber === rowNumber);
    if (!spreadsheet || !sheet || !row) {
      return null;
    }
    return {
      id,
      title: `${spreadsheet.name} → ${sheet.title} → row ${rowNumber}`,
      url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit#gid=${sheetId}&range=${rowNumber}:${rowNumber}`,
      spreadsheetId,
      sheetId,
      sheetTitle: sheet.title,
      rowNumber,
      values: row.values,
    };
  }

  getRawRow(
    spreadsheetId: string,
    sheetId: number,
    rowNumber: number
  ): Record<string, import('../domain/types.js').CellValue> | null {
    const rowId = `sheetrow:${spreadsheetId}:${sheetId}:${rowNumber}`;
    const row = this.#db()
      .prepare('SELECT encrypted_payload, encrypted_raw_payload FROM rows WHERE row_id = ?')
      .get(rowId) as
      | { encrypted_payload: string; encrypted_raw_payload: string | null }
      | undefined;
    if (!row) {
      return null;
    }
    return decryptJson<Record<string, import('../domain/types.js').CellValue>>(
      this.#key,
      row.encrypted_raw_payload ?? row.encrypted_payload,
      row.encrypted_raw_payload ? `${rowId}:raw` : rowId
    );
  }

  replaceSheetRows(input: ReplaceSheetRowsInput): void {
    const database = this.#db();
    const sheetKey = `${input.spreadsheetId}:${input.sheetId}`;
    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(
          `INSERT INTO sheets
            (sheet_key, spreadsheet_id, sheet_id, title, used_range, encrypted_headers, identifier_column, encrypted_tables)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sheet_key) DO UPDATE SET
            title = excluded.title,
            used_range = excluded.used_range,
            encrypted_headers = excluded.encrypted_headers,
            identifier_column = excluded.identifier_column,
            encrypted_tables = excluded.encrypted_tables`
        )
        .run(
          sheetKey,
          input.spreadsheetId,
          input.sheetId,
          input.sheetTitle,
          input.usedRange,
          encryptJson(this.#key, input.headers, `headers:${sheetKey}`),
          input.identifierColumn,
          encryptJson(this.#key, input.tables ?? [], `tables:${sheetKey}`)
        );
      database.prepare('DELETE FROM rows WHERE sheet_key = ?').run(sheetKey);

      const insertRow = database.prepare(
        `INSERT INTO rows (row_id, sheet_key, row_number, encrypted_payload, encrypted_raw_payload, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const insertToken = database.prepare(
        'INSERT OR IGNORE INTO search_tokens (token_hash, row_id) VALUES (?, ?)'
      );
      for (const row of input.rows) {
        const rowId = `sheetrow:${input.spreadsheetId}:${input.sheetId}:${row.rowNumber}`;
        const payload = encryptJson(this.#key, row.values, rowId);
        const rawValues = row.rawValues ?? row.values;
        const rawPayload = encryptJson(this.#key, rawValues, `${rowId}:raw`);
        const fingerprint = fingerprintRow(row.values);
        insertRow.run(rowId, sheetKey, row.rowNumber, payload, rawPayload, fingerprint);
        for (const term of normalizeSearchTerms([
          ...Object.values(row.values),
          ...Object.values(rawValues),
        ])) {
          insertToken.run(hashSearchToken(this.#key, term), rowId);
        }
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  search(query: string, limit = 100): SearchHit[] {
    const terms = normalizeSearchTerms([query]);
    if (terms.length === 0) {
      return [];
    }
    const hashes = terms.map((term) => hashSearchToken(this.#key, term));
    const placeholders = hashes.map(() => '?').join(',');
    const rows = this.#db()
      .prepare(
        `SELECT
          r.row_id,
          s.spreadsheet_id,
          p.name AS spreadsheet_name,
          s.sheet_id,
          s.title AS sheet_title,
          r.row_number,
          r.encrypted_payload AS payload
         FROM rows r
         JOIN sheets s ON s.sheet_key = r.sheet_key
         JOIN spreadsheets p ON p.id = s.spreadsheet_id
         JOIN search_tokens t ON t.row_id = r.row_id
         WHERE t.token_hash IN (${placeholders})
         GROUP BY r.row_id
         HAVING COUNT(DISTINCT t.token_hash) = ?
         ORDER BY p.name, s.title, r.row_number
         LIMIT ?`
      )
      .all(...hashes, hashes.length, limit) as unknown as SearchDatabaseRow[];

    return rows.map((row) => ({
      id: row.row_id,
      title: `${row.spreadsheet_name} → ${row.sheet_title} → row ${row.row_number}`,
      url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(row.spreadsheet_id)}/edit#gid=${row.sheet_id}&range=${row.row_number}:${row.row_number}`,
      spreadsheetId: row.spreadsheet_id,
      sheetId: row.sheet_id,
      sheetTitle: row.sheet_title,
      rowNumber: row.row_number,
      values: decryptJson<Record<string, import('../domain/types.js').CellValue>>(
        this.#key,
        row.payload,
        row.row_id
      ),
    }));
  }

  #db(): DatabaseSync {
    if (!this.#database) {
      throw new Error('LocalIndex.initialize() must be called first');
    }
    return this.#database;
  }
}
