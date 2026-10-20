import { openDatabaseSync } from "expo-sqlite";

import {
  normalizeMiss,
  type SqliteConnection,
  type SqlRow,
  type SqlRunResult,
  type SqlStatement,
  type SqlValue,
} from "@astrolab/core";

/**
 * The `expo-sqlite` adapter — `app/`'s implementation of the synchronous SQLite port
 * (`core/src/store/connection.ts`) and the **only** module under `app/` that imports `expo-sqlite`
 * (plan invariant 5). The device bundle must not contain `node:sqlite`, and by symmetry the app is the
 * only place `expo-sqlite` may appear.
 *
 * ## What the port pins, and the mapping that keeps it honest
 *
 * The port is deliberately synchronous (invariant 1) because one process serialises writes by
 * construction. `expo-sqlite` exposes the full sync surface, but spells two things differently from
 * `node:sqlite`, and both differences are *green in CI and wrong on the device* if unmapped:
 *
 * - **A miss is `undefined`, never `null` (invariant 1c).** `getFirstSync()` is typed `T | null`; the
 *   port's sentinel is `undefined`, which is what v1 code branches on (`core/src/store/runs.ts`). Every
 *   `get()` routes through {@link normalizeMiss}.
 * - **`run()` reports `lastInsertRowid`, and the engine spells it `lastInsertRowId`.** The adapter
 *   renames, so call sites read one spelling (`connection.ts`, *Pinned by this port*).
 *
 * And one lifetime rule: **a statement lives for one call.** The port exposes no `finalize` on a
 * statement, so each method prepares its own handle and releases it in a `finally` — no statement
 * cache, which keeps the two adapters observationally identical.
 */

/** The values this adapter binds. A subset of the port's {@link SqlValue} that `expo-sqlite` accepts. */
type ExpoBindValue = null | number | string | Uint8Array;

/** The slice of `expo-sqlite`'s statement result the adapter reads. */
interface ExpoResult<T> {
  readonly changes: number;
  readonly lastInsertRowId: number;
  getFirstSync(): T | null;
  getAllSync(): T[];
}

/**
 * The slice of `expo-sqlite`'s statement this adapter uses. Structural (not the package type) so the
 * adapter's mapping can be exercised with a plain stub under vitest — the package itself is a native
 * module and cannot load in CI (`expoConnection.test.ts`).
 */
export interface ExpoStatement {
  executeSync<T = SqlRow>(...params: ExpoBindValue[]): ExpoResult<T>;
  finalizeSync(): void;
}

/**
 * The slice of `expo-sqlite`'s database this adapter uses — structurally `SQLiteDatabase`. Typed by
 * hand so the adapter is testable without the native module and so a future `expo-sqlite` method
 * cannot widen the surface this file depends on.
 */
export interface ExpoDatabase {
  execSync(sql: string): void;
  prepareSync(sql: string): ExpoStatement;
  closeSync(): void;
}

/**
 * Wraps an open `expo-sqlite` database as the port. Split from {@link openDatabase} so the mapping is
 * testable, and so `app/` has exactly one place that knows the two spellings differ.
 */
export function createExpoConnection(db: ExpoDatabase): SqliteConnection {
  return {
    exec: (sql: string): void => db.execSync(sql),
    prepare: (sql: string): SqlStatement => ({
      run: (...params: SqlValue[]): SqlRunResult => {
        const stmt = db.prepareSync(sql);
        try {
          const result = stmt.executeSync(...(params as ExpoBindValue[]));
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowId };
        } finally {
          stmt.finalizeSync();
        }
      },
      get: (...params: SqlValue[]): SqlRow | undefined => {
        const stmt = db.prepareSync(sql);
        try {
          return normalizeMiss(stmt.executeSync(...(params as ExpoBindValue[])).getFirstSync());
        } finally {
          stmt.finalizeSync();
        }
      },
      all: (...params: SqlValue[]): SqlRow[] => {
        const stmt = db.prepareSync(sql);
        try {
          return stmt.executeSync(...(params as ExpoBindValue[])).getAllSync();
        } finally {
          stmt.finalizeSync();
        }
      },
    }),
    close: (): void => db.closeSync(),
  };
}

/**
 * Opens the app's on-device database and returns it as the port. The file lives in the app sandbox
 * (`expo-sqlite`'s default `documentDirectory`); the path is a name, not a route, and the pragmas are
 * `core`'s (`openStore`), never this module's.
 */
export function openDatabase(name = "astrolab.db"): SqliteConnection {
  return createExpoConnection(openDatabaseSync(name) as unknown as ExpoDatabase);
}
