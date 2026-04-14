/**
 * Minimal D1 type shim used by src/share/* modules.
 *
 * The Cloudflare Workers runtime provides full D1 types via
 * `@cloudflare/workers-types`, but those types only exist in the
 * backend tsconfig (tsconfig.functions.json). Code under src/share/ is
 * also compiled by the frontend tsconfig for unit tests, which does not
 * have the Workers types.
 *
 * This shim declares only the subset we actually call. The real
 * D1Database is structurally compatible (a superset), so the shim is
 * accepted everywhere — no ambient globals, no duplicate declarations.
 *
 * If a new call site needs a D1 feature not listed here, add it here
 * rather than re-declaring locally in the consumer module.
 */

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1AllResult<T>>;
}

export interface D1Result {
  success: boolean;
}

export interface D1AllResult<T> {
  results: T[];
  success: boolean;
}
