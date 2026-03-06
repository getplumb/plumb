/**
 * Type definitions for @sqlite.org/sqlite-wasm
 * The official package does not ship with TypeScript types.
 */

declare module '@sqlite.org/sqlite-wasm' {
  export interface Sqlite3Static {
    oo1: {
      DB: new (path: string, mode?: string) => Database;
    };
  }

  export interface Database {
    exec(sql: string): void;
    exec(options: ExecOptions): any;
    prepare(sql: string): Statement;
    selectValue(sql: string): unknown;
    changes(): number;
    close(): void;
  }

  export interface ExecOptions {
    sql: string;
    rowMode?: 'array' | 'object';
    returnValue?: 'resultRows' | 'saveSql';
  }

  export interface Statement {
    bind(values: unknown[]): void;
    step(): boolean;
    get(mode?: number | {}): any;
    finalize(): void;
  }

  export default function sqlite3InitModule(): Promise<Sqlite3Static>;
}

declare module '@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3-node.mjs' {
  export * from '@sqlite.org/sqlite-wasm';
  export { default } from '@sqlite.org/sqlite-wasm';
}
