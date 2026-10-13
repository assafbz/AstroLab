import { DatabaseSync } from "node:sqlite";

import { withRetry, type RetryOptions } from "./retry.js";

/**
 * The SQLite store: one file, two writer processes (ARCHITECTURE.md §1, §9; ADR-0001).
 * `node:sqlite` is built in — no native dependency and no build step in CI.
 */

export interface OpenStoreOptions {
  /** `busy_timeout` in ms: how long SQLite waits for a released lock before returning BUSY. */
  busyTimeoutMs?: number;
}

export function openStore(path: string, options: OpenStoreOptions = {}): DatabaseSync {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError("busyTimeoutMs must be a non-negative integer");
  }

  const db = new DatabaseSync(path);
  // `busy_timeout` first, so it is in effect for everything that follows.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  // WAL: readers don't block the writer — the property that makes two writer processes workable.
  // The conversion takes the write lock and SQLite does *not* run the busy handler for a
  // journal-mode change, so a concurrent boot of a fresh file loses it with SQLITE_BUSY instantly,
  // timeout or not. Hence the retry: the loser finds the file already WAL, where this is a no-op.
  withRetry(() => db.exec("PRAGMA journal_mode = WAL"));
  // Per-connection, so it lives here rather than in the migration (docs/SCHEMA.md).
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * One short write transaction, retried on BUSY — the shape every write takes (ARCHITECTURE.md §9).
 * `BEGIN IMMEDIATE` takes the write lock up front, so a collision surfaces before any work is done.
 *
 * A retry re-runs `fn`: the transaction is at-least-once, which is why write paths are keyed
 * idempotently (e.g. `decision_id`) rather than made once-only.
 */
export function writeTransaction<T>(db: DatabaseSync, fn: () => T, options?: RetryOptions): T {
  return withRetry(() => {
    let open = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      open = true;
      const result = fn();
      db.exec("COMMIT");
      open = false;
      return result;
    } catch (err) {
      if (open) db.exec("ROLLBACK");
      throw err;
    }
  }, options);
}
