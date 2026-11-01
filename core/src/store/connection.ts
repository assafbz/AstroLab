/**
 * The synchronous SQLite port — the one seam between `core/` and whichever engine hosts it
 * (`ARCHITECTURE.md` §1, §2; `docs/adr/0006-local-only-expo-app.md`).
 *
 * Two adapters implement it and nothing else does: `connection.node.ts` (`node:sqlite`, tests and
 * CI) and the Expo app's `expo-sqlite` adapter (`app/`, L2 — invariant 5). Keeping the port here is
 * what lets the store, the vault and the engine suites run in CI on Node while shipping on a phone.
 *
 * ## Synchronous, deliberately (invariant 1)
 *
 * Every method is synchronous, and so are the transaction callbacks built on them. That is what makes
 * *"one process ⇒ writes serialized by construction"* literally true: a synchronous callback cannot
 * interleave with another write. It is the property the v1 store's concurrency suites assert on, and
 * `expo-sqlite` exposes the full sync surface (`execSync` · `prepareSync` · `executeSync` ·
 * `getFirstSync` · `getAllSync` · `closeSync`), verified 2026-10-17 against `58.0.13` and `57.0.4`
 * (`docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md` invariant 1).
 *
 * **One correction to that verification, 2026-11-01 (#186).** It read the *typings*, which show the sync
 * surface **exists** — not that the web worker can **answer inside the busy-wait cap**. It cannot, for the
 * writes: they fsync and lose the ~133 ms race on a cold worker. The sync port is unchanged and still the
 * steady-state API; the **boot path** runs on {@link AsyncSqliteConnection} instead (invariant 1 is
 * amended, not retired — `docs/adr/0007-web-boot-async-channel.md`).
 *
 * ## Pinned by this port, because CI and the device differ here
 *
 * - **A miss is `undefined`, never `null` (invariant 1c).** `node:sqlite`'s `get()` returns `undefined`
 *   for no row; `expo-sqlite`'s `getFirstSync()` is typed `T | null`. The v1 storage code branches on
 *   `=== undefined` (`core/src/store/runs.ts`), so an adapter that passed `null` through would be
 *   **green in CI and wrong on the device**. An adapter whose engine answers `null` must map it with
 *   {@link normalizeMiss}; `connection.test.ts` pins both halves.
 * - **A statement lives for one call.** The port has no `finalize`/`close` on a statement: each method
 *   prepares and releases internally, which is exactly v1's call-site shape (`db.prepare(…).run(…)`).
 *   `expo-sqlite` needs an explicit `finalizeSync()` for that (`node:sqlite`'s handle is released with
 *   the connection) — a per-call release keeps the two adapters observationally identical.
 * - **`run()` reports changes with `lastInsertRowid`.** `node:sqlite` spells it `lastInsertRowid`,
 *   `expo-sqlite` spells it `lastInsertRowId`; the adapter renames, so call sites read one spelling.
 *
 * ## Web (invariant 10)
 *
 * On web `expo-sqlite` implements the sync path with a Worker + `Atomics.wait` on a `SharedArrayBuffer`,
 * so it needs a cross-origin-isolated context, and a sync result over **1 MiB** throws. Nothing here
 * changes that: it is why a sync read must stay row-bounded and why a whole-vault read (the export)
 * pages or goes async (L4).
 */

/** A value SQLite can bind or return. The intersection of `node:sqlite`'s and `expo-sqlite`'s sets. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** One result row, keyed by column name. Callers narrow it to their own shape. */
export type SqlRow = Record<string, SqlValue>;

/** What a write reports back. `changes` is the row count; the id is the last inserted row's. */
export interface SqlRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * A statement handle as the port exposes it: no lifecycle, because each call prepares and releases
 * its own. `get` returns `undefined` on a miss (see the module note — this is the pinned sentinel).
 */
export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

/** One open SQLite database. `openStore` applies the pragmas; the adapter owns the file and the engine. */
export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/**
 * The **async** sibling of {@link SqliteConnection} — the channel the boot path runs on (#186).
 *
 * Invariant 1's synchronous port is what makes *"one process ⇒ writes serialized by construction"* true,
 * and it is untouched: every steady-state read and every `vaultMutation` still goes through
 * {@link SqliteConnection}. What it could not do is *survive a cold web load*. `expo-sqlite`'s web
 * target answers a sync call inside a main-thread busy-wait with a hard **~133 ms** budget
 * (`web/WorkerChannel.ts` `invokeWorkerSync`: `1_000_000` `Atomics.pause` iterations). Reads answer in
 * 0–5 ms and clear it; the **writes** — the WAL conversion, DDL, `COMMIT`, `ROLLBACK` — fsync and
 * routinely exceed it, so a cold boot's writes lost the race (measured: 18 red / 19 loads). The async
 * path posts the same message with `isSync: false` and awaits a `Deferred` — no busy-wait, no cap — so
 * moving the **boot writes** there removes the hazard rather than winning the race.
 *
 * **Scope, stated so it is not read wider than it is.** This is a *boot-scoped* channel, not a
 * port-wide async rewrite (invariant 1 is amended, not retired): the sync port stays the steady-state
 * API, and only `openStoreAsync` · `migrateAsync` · `seedDomainTaxonomyAsync` are written against this
 * one. A read that must go async for a *different* reason — the web 1 MiB sync result cap (invariant 10)
 * — is L4's business, not this port's.
 *
 * **The call shape differs from the sync port on purpose.** The sync port exposes a `prepare` that
 * returns a one-call statement handle, because `node:sqlite` and `expo-sqlite` both do. On the async
 * channel the handle is *itself* an `await`, and a `prepareSync` for a write statement would post a
 * sync `prepare` carrying write SQL — exactly the thing this port exists to keep off the capped channel
 * (#186 gate 2). So there is no statement object here: each call names its own SQL, and the adapter
 * prepares, executes and releases it. The miss sentinel is the same `undefined` (invariant 1c).
 */
export interface AsyncSqliteConnection {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>;
  get(sql: string, params?: readonly SqlValue[]): Promise<SqlRow | undefined>;
  all(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  close(): Promise<void>;
}

/**
 * Presents a **synchronous** connection as the async port: each method runs the sync call and wraps the
 * result in a resolved promise.
 *
 * It is the bridge for two cases where the engine is synchronous but the *boot path* still has to be the
 * async one — `node:sqlite` in tests and CI, and a device engine whose only async story is this port.
 * It is deliberately **not** how the web app runs: there the async plane posts `isSync: false` messages
 * to the worker (that is the entire point), and the app adapter implements the port directly.
 *
 * It invokes the sync calls in order, so the resulting `Promise` chain is a faithful,
 * promise-shaped view of the same statements — which is what makes the parity suite meaningful: sync and
 * async boot run *the same rules* against *the same engine* and must land on the same database.
 */
export function asAsyncConnection(conn: SqliteConnection): AsyncSqliteConnection {
  return {
    exec: (sql: string): Promise<void> => Promise.resolve(conn.exec(sql)),
    run: (sql: string, params: readonly SqlValue[] = []): Promise<SqlRunResult> =>
      Promise.resolve(conn.prepare(sql).run(...params)),
    get: (sql: string, params: readonly SqlValue[] = []): Promise<SqlRow | undefined> =>
      Promise.resolve(conn.prepare(sql).get(...params)),
    all: (sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> =>
      Promise.resolve(conn.prepare(sql).all(...params)),
    close: (): Promise<void> => Promise.resolve(conn.close()),
  };
}

/**
 * Maps an engine's `null` miss onto the port's `undefined` (invariant 1c).
 *
 * Every adapter whose engine answers `null` — `expo-sqlite`'s `getFirstSync()` is the one — routes its
 * `get()` through this, so the sentinel never reaches v1 code that branches on `undefined`.
 */
export function normalizeMiss(row: SqlRow | null): SqlRow | undefined {
  return row === null ? undefined : row;
}
