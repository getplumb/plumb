/**
 * SQLite database wrapper using better-sqlite3.
 *
 * Replaces the previous @sqlite.org/sqlite-wasm implementation which cannot
 * open real filesystem paths (paths outside /tmp) in a Node.js/Emscripten environment.
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
 * Thin statement wrapper that adapts better-sqlite3's synchronous API
 * to match the wasm oo1 Statement interface expected by local-store.ts and schema.ts.
 *
 * The wasm oo1 API is cursor-based: bind() → step() → get() → finalize().
 * better-sqlite3 is all-at-once: prepare() → .all() or .run().
 *
 * We lazily detect on first step() whether this is a SELECT (has columns) or
 * DML (INSERT/UPDATE/DELETE, no result set) and route accordingly.
 */
class CompatStatement {
  readonly #stmt: Database.Statement;
  #params: unknown[] = [];
  #rows: Record<string, unknown>[] | null = null;
  #rowIndex = 0;
  #isDml = false;

  constructor(stmt: Database.Statement) {
    this.#stmt = stmt;
  }

  bind(params: unknown[]): void {
    this.#params = params;
  }

  step(): boolean {
    if (this.#rows === null && !this.#isDml) {
      // First call — determine if this is DML or SELECT
      if (this.#stmt.reader) {
        // SELECT — get all rows up front
        this.#rows = this.#stmt.all(...this.#params) as Record<string, unknown>[];
        this.#rowIndex = 0;
      } else {
        // DML (INSERT/UPDATE/DELETE) — run it once
        this.#stmt.run(...this.#params);
        this.#isDml = true;
        return false; // No rows to iterate
      }
    }
    if (this.#rows !== null && this.#rowIndex < this.#rows.length) {
      this.#rowIndex++;
      return true;
    }
    return false;
  }

  get(colOrObj: number | Record<string, unknown>): unknown {
    if (!this.#rows || this.#rowIndex === 0) return undefined;
    const row = this.#rows[this.#rowIndex - 1] ?? {};
    if (typeof colOrObj === 'number') {
      return Object.values(row)[colOrObj];
    }
    // Object form — populate the passed object with row values
    for (const [key, val] of Object.entries(row)) {
      colOrObj[key] = val;
    }
    return colOrObj;
  }

  finalize(): void {
    // better-sqlite3 statements don't need explicit finalization
  }
}

/**
 * Thin database wrapper for better-sqlite3.
 * Provides a WasmDb-compatible interface for local-store.ts and schema.ts.
 */
class WasmDbImpl {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  /**
   * Execute SQL.
   * - exec(sql: string) — plain execution, no return value
   * - exec({ sql, returnValue: 'resultRows', rowMode: 'object' }) — returns array of row objects
   */
  exec(sqlOrOpts: string | ExecOptions): unknown[] | void {
    if (typeof sqlOrOpts === 'string') {
      this.#db.exec(sqlOrOpts);
      return;
    }
    // Object form — run as query and return row objects
    const stmt = this.#db.prepare(sqlOrOpts.sql);
    return stmt.all() as unknown[];
  }

  prepare(sql: string): CompatStatement {
    const stmt = this.#db.prepare(sql);
    return new CompatStatement(stmt);
  }

  /**
   * Execute a single-value query and return the first column of the first row.
   */
  selectValue(sql: string): unknown {
    const stmt = this.#db.prepare(sql);
    const row = stmt.get() as Record<string, unknown> | undefined;
    if (row === undefined || row === null) return undefined;
    return Object.values(row)[0];
  }

  close(): void {
    this.#db.close();
  }
}

export type WasmDb = WasmDbImpl;

/**
 * Open a SQLite database file using better-sqlite3.
 * Creates the file if it doesn't exist.
 * Uses native SQLite bindings (better-sqlite3) for real filesystem access.
 */
export async function openDb(path: string): Promise<WasmDb> {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  return new WasmDbImpl(db);
}
