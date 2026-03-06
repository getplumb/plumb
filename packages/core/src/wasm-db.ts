/**
 * SQLite database wrapper using better-sqlite3.
 *
 * Replaces the previous @sqlite.org/sqlite-wasm implementation which cannot
 * open real filesystem paths in a Node.js environment.
 *
 * Exposes a WasmDb-compatible interface so local-store.ts and schema.ts
 * require no changes:
 *   - db.exec(sql: string)
 *   - db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) → rows[]
 *   - db.prepare(sql) → stmt with .bind([...]), .step(), .get(colOrObj), .finalize()
 *   - db.selectValue(sql)
 *   - db.close()
 */

import Database from 'better-sqlite3';

type ExecOptions = {
  sql: string;
  rowMode?: 'object' | 'array';
  returnValue?: 'resultRows';
};

/**
 * Thin statement wrapper that adapts better-sqlite3's API to the wasm oo1 style
 * used throughout local-store.ts, fact-search.ts, and raw-log-search.ts.
 */
class CompatStatement {
  readonly #stmt: Database.Statement;
  #params: unknown[] = [];
  #rows: unknown[][] | null = null;
  #rowIndex = 0;
  #columnNames: string[] = [];

  constructor(stmt: Database.Statement) {
    this.#stmt = stmt;
  }

  bind(params: unknown[]): void {
    this.#params = params;
  }

  /**
   * Execute the statement. For SELECT statements, caches all rows for get().
   * For write statements (INSERT/UPDATE/DELETE/PRAGMA writes), runs immediately.
   */
  step(): boolean {
    if (this.#stmt.reader) {
      // SELECT — cache all rows on first call
      if (this.#rows === null) {
        const raw = this.#stmt.raw(true).all(...this.#params) as unknown[][];
        this.#rows = raw;
        this.#rowIndex = 0;
        this.#columnNames = this.#stmt.columns().map((c) => c.name);
      }
      if (this.#rowIndex < this.#rows.length) {
        this.#rowIndex++;
        return true;
      }
      return false;
    } else {
      // Write statement
      this.#stmt.run(...this.#params);
      return false;
    }
  }

  /**
   * Get a value from the current row.
   * - get(colIndex: number) → scalar at that column index
   * - get({}) → plain object with column names as keys
   */
  get(colOrObj: number | Record<string, unknown>): unknown {
    if (this.#rows === null || this.#rowIndex === 0) return null;
    const row = this.#rows[this.#rowIndex - 1];
    if (row === undefined) return null;

    if (typeof colOrObj === 'number') {
      return row[colOrObj];
    }
    // Object form — zip column names with row values
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < this.#columnNames.length; i++) {
      obj[this.#columnNames[i]!] = row[i];
    }
    return obj;
  }

  finalize(): void {
    // better-sqlite3 statements don't need explicit finalization
    this.#rows = null;
    this.#rowIndex = 0;
    this.#params = [];
  }
}

/**
 * Thin database wrapper adapting better-sqlite3 to the wasm oo1 API surface
 * used by local-store.ts and schema.ts.
 */
class CompatDb {
  readonly #db: Database.Database;

  constructor(path: string) {
    this.#db = new Database(path);
  }

  /**
   * Execute SQL.
   * - exec(sql: string) — plain execution, no return value
   * - exec({ sql, returnValue: 'resultRows' }) — returns array of row objects
   */
  exec(sqlOrOpts: string | ExecOptions): unknown[] | void {
    if (typeof sqlOrOpts === 'string') {
      this.#db.exec(sqlOrOpts);
      return;
    }

    // Object form — run as query and return rows
    const { sql } = sqlOrOpts;
    const rows = this.#db.prepare(sql).all() as unknown[];
    return rows;
  }

  prepare(sql: string): CompatStatement {
    const stmt = this.#db.prepare(sql);
    return new CompatStatement(stmt);
  }

  /**
   * Execute a single-value query and return the first column of the first row.
   */
  selectValue(sql: string): unknown {
    const row = this.#db.prepare(sql).raw(true).get() as unknown[] | undefined;
    return row ? row[0] : null;
  }

  close(): void {
    this.#db.close();
  }
}

export type WasmDb = CompatDb;

/**
 * Open a SQLite database file.
 * Creates the file if it doesn't exist.
 * Returns a promise for API compatibility with the previous wasm implementation.
 */
export async function openDb(path: string): Promise<WasmDb> {
  return new CompatDb(path);
}
