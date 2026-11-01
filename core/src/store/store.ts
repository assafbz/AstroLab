import type { AsyncSqliteConnection, SqliteConnection } from "./connection.js";

import {
  withRetry,
  withRetryAsync,
  type AsyncRetryOptions,
  type RetryOptions,
} from "./retry.js";

/** The two pragmas, named once so the sync and async openers cannot drift apart. */
const JOURNAL_MODE_WAL = "PRAGMA journal_mode = WAL";
const FOREIGN_KEYS_ON = "PRAGMA foreign_keys = ON";

/**
 * Opening the store: the pragmas the schema and every write depend on (`ARCHITECTURE.md` §2, §9;
 * `ADR-0001` as amended by `ADR-0006`).
 *
 * It takes an **open connection**, not a path. Which engine holds that connection is the adapter's
 * business — `node:sqlite` in tests and CI, `expo-sqlite` on the device (plan invariant 5) — and this
 * function is the one place the two meet, so the pragmas cannot drift between them.
 */

/**
 * Applies the store's pragmas to `conn`. Idempotent, so a caller may run it on an already-open file.
 *
 * - **`journal_mode = WAL`**: readers do not block the writer, which is what keeps a long read (the
 *   deck) off a write's path. The conversion itself takes the write lock, and SQLite does not run the
 *   busy handler for a journal-mode change — hence the bounded retry. It is a **guard now, not a
 *   load-bearing step**: with one in-process writer (ADR-0006 amending ADR-0001 — the two-writer
 *   posture retired with the API + worker split) the conversion has no competitor, and a second
 *   connection to the same file is a mistake we want loud (`core/test/boot.test.ts`).
 * - **`foreign_keys = ON`**: per-connection, so it lives here rather than in the migration
 *   (`docs/SCHEMA.md`).
 */
export function openStore(conn: SqliteConnection): void {
  withRetry(() => conn.exec(JOURNAL_MODE_WAL));
  conn.exec(FOREIGN_KEYS_ON);
}

/**
 * {@link openStore} on the async channel (#186) — the same two pragmas, in the same order, against the
 * same statements (the strings are shared constants above, so a change lands on both channels or
 * neither). `journal_mode = WAL` is a **write** (it takes the write lock and fsyncs), which is why the
 * boot path cannot leave it on the capped sync channel; `foreign_keys` is per-connection and cheap, but
 * it belongs with the pragma it is paired with rather than on a second channel.
 */
export async function openStoreAsync(conn: AsyncSqliteConnection): Promise<void> {
  await withRetryAsync(() => conn.exec(JOURNAL_MODE_WAL));
  await conn.exec(FOREIGN_KEYS_ON);
}

/**
 * One short write transaction — the shape every write takes (`ARCHITECTURE.md` §9).
 * `BEGIN IMMEDIATE` takes the write lock up front, so a collision surfaces before any work is done.
 *
 * The retry re-runs `fn`, which makes the transaction at-least-once — the reason write paths are
 * keyed idempotently (e.g. `decision_id`) rather than made once-only. With a single in-process writer
 * the retry is a guard against a second connection, not a routine cost (see `openStore`).
 */
export function writeTransaction<T>(
  conn: SqliteConnection,
  fn: () => T,
  options?: RetryOptions,
): T {
  return withRetry(() => {
    let open = false;
    try {
      conn.exec("BEGIN IMMEDIATE");
      open = true;
      const result = fn();
      conn.exec("COMMIT");
      open = false;
      return result;
    } catch (err) {
      if (open) conn.exec("ROLLBACK");
      throw err;
    }
  }, options);
}

/**
 * {@link writeTransaction} on the async channel (#186): **the same body** — `BEGIN IMMEDIATE`, run,
 * `COMMIT`, `ROLLBACK`-if-open — awaited at each step. `IMMEDIATE` takes the write lock up front so a
 * collision surfaces before any work, and the `catch` rolls back only a transaction that actually
 * opened, which is what keeps a *failed rollback* from masking the original error.
 *
 * Kept off the package surface for the same reason as its sync twin: with it unexported, `vaultMutation`
 * stays the only transaction primitive a caller outside the store can reach. This one is not reachable
 * by `app/` either — the boot rules call it in-module.
 */
export async function writeTransactionAsync<T>(
  conn: AsyncSqliteConnection,
  fn: () => Promise<T>,
  options?: AsyncRetryOptions,
): Promise<T> {
  return withRetryAsync(async () => {
    let open = false;
    try {
      await conn.exec("BEGIN IMMEDIATE");
      open = true;
      const result = await fn();
      await conn.exec("COMMIT");
      open = false;
      return result;
    } catch (err) {
      if (open) await conn.exec("ROLLBACK");
      throw err;
    }
  }, options);
}
