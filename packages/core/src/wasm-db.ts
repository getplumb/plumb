/**
 * SQLite database wrapper using @sqlite.org/sqlite-wasm.
 *
 * Pure WebAssembly implementation — zero native compilation required.
 * Works on all platforms (Windows, macOS, Linux) without node-gyp, MSVC Build Tools, or Python.
 *
 * Exposes a WasmDb-compatible interface so local-store.ts and schema.ts
 * require no changes:
 *   - db.exec(sql: string)
 *   - db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) → rows[]
 *   - db.prepare(sql) → stmt with .bind([...]), .step(), .get(colOrObj), .finalize()
 *   - db.selectValue(sql)
 *   - db.close()
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3-node.mjs';
import type { Database, Statement } from '@sqlite.org/sqlite-wasm';

type ExecOptions = {
  sql: string;
  rowMode?: 'object' | 'array';
  returnValue?: 'resultRows';
};

/**
 * Thin statement wrapper that adapts the sqlite-wasm oo1 Statement API
 * to match the interface expected by local-store.ts and schema.ts.
 */
class CompatStatement {
  readonly #stmt: Statement;

  constructor(stmt: Statement) {
    this.#stmt = stmt;
  }

  bind(params: unknown[]): void {
    this.#stmt.bind(params);
  }

  step(): boolean {
    return this.#stmt.step();
  }

  get(colOrObj: number | Record<string, unknown>): unknown {
    return this.#stmt.get(colOrObj);
  }

  finalize(): void {
    this.#stmt.finalize();
  }
}

/**
 * Thin database wrapper for @sqlite.org/sqlite-wasm oo1 API.
 * Provides a WasmDb-compatible interface for local-store.ts and schema.ts.
 */
class WasmDbImpl {
  readonly #db: Database;

  constructor(db: Database) {
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

    // Object form — run as query and return rows
    return this.#db.exec(sqlOrOpts);
  }

  prepare(sql: string): CompatStatement {
    const stmt = this.#db.prepare(sql);
    return new CompatStatement(stmt);
  }

  /**
   * Execute a single-value query and return the first column of the first row.
   */
  selectValue(sql: string): unknown {
    return this.#db.selectValue(sql);
  }

  close(): void {
    this.#db.close();
  }
}

export type WasmDb = WasmDbImpl;

/**
 * Open a SQLite database file.
 * Creates the file if it doesn't exist.
 * Uses @sqlite.org/sqlite-wasm for pure WASM SQLite (zero native dependencies).
 */
export async function openDb(path: string): Promise<WasmDb> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(path, 'c');
  return new WasmDbImpl(db);
}
