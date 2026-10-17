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
 * the reason no async variant exists — `expo-sqlite` exposes the full sync surface
 * (`execSync` · `prepareSync` · `executeSync` · `getFirstSync` · `getAllSync` · `closeSync`), verified
 * 2026-10-17 against `58.0.13` and `57.0.4` (`docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md`
 * invariant 1).
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
 * Maps an engine's `null` miss onto the port's `undefined` (invariant 1c).
 *
 * Every adapter whose engine answers `null` — `expo-sqlite`'s `getFirstSync()` is the one — routes its
 * `get()` through this, so the sentinel never reaches v1 code that branches on `undefined`.
 */
export function normalizeMiss(row: SqlRow | null): SqlRow | undefined {
  return row === null ? undefined : row;
}
