import type { SqliteConnection } from "./connection.js";

import { withRetry, type RetryOptions } from "./retry.js";

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
  withRetry(() => conn.exec("PRAGMA journal_mode = WAL"));
  conn.exec("PRAGMA foreign_keys = ON");
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
