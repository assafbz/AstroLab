import { DatabaseSync } from "node:sqlite";

import type {
  SqlRow,
  SqlRunResult,
  SqlStatement,
  SqliteConnection,
  SqlValue,
} from "./connection.js";
import { openStore } from "./store.js";

/**
 * The `node:sqlite` adapter — the port's implementation for **tests and CI only** (invariant 5).
 *
 * `node:sqlite` is built into Node, so the suites need no native module and no build step; the
 * Expo app supplies its own adapter instead (L2). Nothing under `core/src` may import this module:
 * a device bundle that pulled it in would ship a Node built-in that does not exist there.
 * `core/test/boundary-node-adapter.test.ts` reads the source tree and fails if the adapter is imported
 * outside tests (L1's instance of the guard discipline — the claim is checked, not asserted in prose).
 */

export interface NodeConnectionOptions {
  /** `busy_timeout` in ms: how long SQLite waits for a released lock before returning BUSY. */
  busyTimeoutMs?: number;
}

/**
 * Opens `path` (`":memory:"` for a throwaway database) and returns it as the port. `busy_timeout` is
 * set here rather than in `openStore` because it is per-connection and engine-facing; everything the
 * port promises about behaviour is `openStore`'s.
 */
export function openNodeConnection(
  path: string,
  options: NodeConnectionOptions = {},
): SqliteConnection {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError("busyTimeoutMs must be a non-negative integer");
  }

  const db = new DatabaseSync(path);
  // `busy_timeout` first, so it is in effect for everything that follows.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

  return {
    exec: (sql: string): void => db.exec(sql),
    // Prepared per call and released by the connection: v1's call shape, kept so both adapters
    // observe the same statement lifetime (see the port's note).
    prepare: (sql: string): SqlStatement => ({
      run: (...params: SqlValue[]): SqlRunResult => db.prepare(sql).run(...params),
      get: (...params: SqlValue[]): SqlRow | undefined => db.prepare(sql).get(...params),
      all: (...params: SqlValue[]): SqlRow[] => db.prepare(sql).all(...params),
    }),
    close: (): void => db.close(),
  };
}

/**
 * The node-side composition, for tests and CI: the adapter **plus** the store's pragmas — exactly what
 * `app/` does with `openDatabaseSync` + `openStore`. It is one function so no suite has to remember the
 * pair, and it is not exported from the package entry (invariant 5).
 */
export function openNodeStore(
  path = ":memory:",
  options: NodeConnectionOptions = {},
): SqliteConnection {
  const conn = openNodeConnection(path, options);
  openStore(conn);
  return conn;
}
