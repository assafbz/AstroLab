import { openDatabaseAsync } from "expo-sqlite";

import {
  normalizeMiss,
  type AsyncSqliteConnection,
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

/** The slice of `expo-sqlite`'s async statement the async plane uses (structurally, as above). */
export interface ExpoAsyncStatement {
  executeAsync<T = SqlRow>(...params: ExpoBindValue[]): Promise<{
    readonly changes: number;
    readonly lastInsertRowId: number;
    getFirstAsync(): Promise<T | null>;
    getAllAsync(): Promise<T[]>;
  }>;
  finalizeAsync(): Promise<void>;
}

/** The async slice of `expo-sqlite`'s database — the same handle, the non-busy-waiting half. */
export interface ExpoAsyncDatabase {
  execAsync(sql: string): Promise<void>;
  prepareAsync(sql: string): Promise<ExpoAsyncStatement>;
  closeAsync(): Promise<void>;
}

/**
 * Wraps an open `expo-sqlite` database as the **async** port (`AsyncSqliteConnection`, #186) — the
 * channel the boot path runs on. The same mappings as {@link createExpoConnection} (the `undefined` miss
 * sentinel, the `lastInsertRowid` spelling) and the same **one-call statement lifetime**, but every call
 * is a `…Async` one, so nothing here posts an `isSync` message to the worker.
 *
 * That last point is the whole of #186: `prepareSync` on a **write** statement posts a sync `prepare`
 * carrying write SQL, which the cold worker cannot answer inside its ~133 ms budget. `prepareAsync`
 * posts `isSync: false` and awaits a `Deferred` — no busy-wait, no cap — so the boot writes land.
 */
export function createExpoAsyncConnection(db: ExpoAsyncDatabase): AsyncSqliteConnection {
  return {
    exec: (sql: string): Promise<void> => db.execAsync(sql),
    run: async (sql: string, params: readonly SqlValue[] = []): Promise<SqlRunResult> => {
      const stmt = await db.prepareAsync(sql);
      try {
        const result = await stmt.executeAsync(...(params as ExpoBindValue[]));
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowId };
      } finally {
        await stmt.finalizeAsync();
      }
    },
    get: async (sql: string, params: readonly SqlValue[] = []): Promise<SqlRow | undefined> => {
      const stmt = await db.prepareAsync(sql);
      try {
        const result = await stmt.executeAsync(...(params as ExpoBindValue[]));
        return normalizeMiss(await result.getFirstAsync());
      } finally {
        await stmt.finalizeAsync();
      }
    },
    all: async (sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> => {
      const stmt = await db.prepareAsync(sql);
      try {
        const result = await stmt.executeAsync(...(params as ExpoBindValue[]));
        return await result.getAllAsync();
      } finally {
        await stmt.finalizeAsync();
      }
    },
    close: (): Promise<void> => db.closeAsync(),
  };
}

/** The two planes over one open handle: the sync port for the steady state, the async one for boot. */
export interface OpenedVault {
  /** The synchronous port (`SqliteConnection`) — every steady-state read and write. */
  conn: SqliteConnection;
  /** The async port (`AsyncSqliteConnection`) — the boot path, and only the boot path (#186). */
  async: AsyncSqliteConnection;
}

/**
 * Opens the app's on-device database and returns **both planes over the one handle**. The file lives in
 * the app sandbox (`expo-sqlite`'s default `documentDirectory`); the path is a name, not a route, and the
 * pragmas are `core`'s (`openStore`/`openStoreAsync`), never this module's.
 *
 * **The open is async, and on web that is load-bearing (#186).** `expo-sqlite`'s web target runs SQLite in
 * a worker that boots lazily, and the *sync* opener's first call asks that cold worker to answer inside a
 * main-thread busy-wait (`expo-sqlite/web/WorkerChannel.ts` `invokeWorkerSync`) — measured at ~133 ms of
 * budget against a worker that needs ~200 ms to exist, so the first sync open threw `Sync operation
 * timeout` on every cold load. Awaiting the async opener starts the worker and lets the main thread yield
 * while it loads. It is one handle, not a warm-up beside it: the async handle is a `SQLiteDatabase`, which
 * carries both the async methods (`execAsync` · `prepareAsync` · `closeAsync`) and the sync ones
 * (`execSync` · `prepareSync` · `closeSync`).
 *
 * The two planes are returned together because they are the *same* database: the boot writes run on the
 * async plane, the steady-state reads on the sync one. Splitting them across two opens would be two
 * connections to one file — the mistake `core/test/boot.test.ts` fails on.
 */
export async function openDatabase(name = "astrolab.db"): Promise<OpenedVault> {
  const db = (await openDatabaseAsync(name)) as unknown as ExpoDatabase & ExpoAsyncDatabase;
  return { conn: createExpoConnection(db), async: createExpoAsyncConnection(db) };
}
