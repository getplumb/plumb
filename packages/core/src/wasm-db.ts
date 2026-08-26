/**
 * SQLite database wrapper built on Node's built-in `node:sqlite`.
 *
 * History: this was @sqlite.org/sqlite-wasm (could not open real filesystem
 * paths), then better-sqlite3 (native, needed a compiler or a matching
 * prebuild), and is now the runtime's own SQLite.
 *
 * The reason for the last move is distribution, not performance. Plumb ships as
 * a Claude Code plugin that installs itself on whatever machine the user has,
 * and a native module turns "install the plugin" into "have a working C++
 * toolchain". Measured on a clean install, better-sqlite3 compiled from source
 * — 26 MB and a node-gyp build — because the pinned ^9.4.3 has no prebuild for
 * Node 22. `node:sqlite` needs neither, and the retrieval service has been
 * reading this same database through it in production for weeks.
 *
 * Requires Node >=22.5, which is already the floor for every package here.
 *
 * Exposes the same WasmDb-compatible interface as before, so local-store.ts and
 * schema.ts require no changes:
 *   - db.exec(sql: string)
 *   - db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' }) → rows[]
 *   - db.prepare(sql) → stmt with .bind([...]), .step(), .get(colOrObj), .finalize()
 *   - db.selectValue(sql)
 *   - db.close()
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

type ExecOptions = {
  sql: string;
  rowMode?: 'object' | 'array';
  returnValue?: 'resultRows';
};

/**
 * node:sqlite returns rows as null-prototype objects. Callers written against
 * better-sqlite3 may reasonably expect ordinary objects — `hasOwnProperty`,
 * instanceof, spread into a class — so normalise once at the boundary rather
 * than leaving a subtle difference for someone to trip over later.
 */
const plain = (row: Record<string, unknown>): Record<string, unknown> => ({ ...row });

/**
 * Thin statement wrapper adapting the all-at-once API to the cursor-based wasm
 * oo1 Statement interface expected by local-store.ts and schema.ts:
 * bind() → step() → get() → finalize().
 *
 * Unlike the better-sqlite3 version this needs no SELECT-versus-DML detection.
 * `StatementSync.all()` executes the statement either way, returning rows for a
 * query and an empty array for a write, so one path covers both.
 */
class CompatStatement {
  readonly #stmt: StatementSync;
  #params: unknown[] = [];
  #rows: Record<string, unknown>[] | null = null;
  #rowIndex = 0;

  constructor(stmt: StatementSync) {
    this.#stmt = stmt;
  }

  bind(params: unknown[]): void {
    this.#params = params;
  }

  step(): boolean {
    if (this.#rows === null) {
      this.#rows = (this.#stmt.all(...(this.#params as never[])) as Record<string, unknown>[]).map(plain);
      this.#rowIndex = 0;
    }
    if (this.#rowIndex < this.#rows.length) {
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
    // node:sqlite statements are finalized when they go out of scope.
  }
}

/**
 * Thin database wrapper providing a WasmDb-compatible interface.
 */
class WasmDbImpl {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
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
    const rows = this.#db.prepare(sqlOrOpts.sql).all() as Record<string, unknown>[];
    return rows.map(plain);
  }

  prepare(sql: string): CompatStatement {
    return new CompatStatement(this.#db.prepare(sql));
  }

  /**
   * Execute a single-value query and return the first column of the first row.
   */
  selectValue(sql: string): unknown {
    const row = this.#db.prepare(sql).get() as Record<string, unknown> | undefined;
    if (row === undefined || row === null) return undefined;
    return Object.values(row)[0];
  }

  close(): void {
    this.#db.close();
  }
}

export type WasmDb = WasmDbImpl;

/**
 * Open a SQLite database file, creating it if it does not exist.
 */
export async function openDb(path: string): Promise<WasmDb> {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  // Retry for up to 5s on SQLITE_BUSY instead of throwing immediately.
  // WAL mode allows concurrent readers but only one writer at a time — without
  // a busy timeout, two writers colliding (e.g. embed drain + ingest hook)
  // immediately throw "database is locked". 5s covers any realistic write burst.
  db.exec('PRAGMA busy_timeout = 5000');
  return new WasmDbImpl(db);
}
