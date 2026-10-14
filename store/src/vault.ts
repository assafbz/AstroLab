import type { DatabaseSync } from "node:sqlite";

import { stampAndEnqueue } from "./runs.js";
import { writeTransaction } from "./store.js";

/**
 * The one sanctioned way to write the tables `ARCHITECTURE.md` §4's trigger governs — `idea`,
 * `idea_version`, `provenance_edge`, `decision`. Every candidate-affecting mutation (create /
 * complete / iterate / fork / delete) goes through it, so the stamp + enqueue cannot be *forgotten*
 * at a call site: reaching for `writeTransaction` directly to touch a vault table is the mistake this
 * removes, and `store/test/vault-writes.test.ts` fails the suite if one appears.
 *
 * **Stamps iff the body wrote.** §4's revision is relative and a mutation that changed nothing must
 * not churn it — the idempotent `decision_id` repeat returns the first result having written nothing,
 * *not even a bump* (`docs/API.md` §4.2). `total_changes()` is a connection-level counter, so the
 * delta across the body is exactly "did this mutation write".
 *
 * **The body, the bump and the enqueue commit together or not at all**, so a stamped revision can
 * never exist without its run, nor a run for a revision that never committed.
 *
 * **The body must be synchronous**, and that is enforced at the **type** level: `async () => {}` returns
 * a promise immediately, so the transaction would commit — and the stamp be skipped, its delta still
 * zero — while the body's real writes landed after it, outside the transaction and unstamped. `NotPromise`
 * makes such a body unassignable, so the mistake cannot be written at all. A runtime check stays as a
 * second, best-effort layer for a JS caller or a cast — see below.
 *
 * shortcut: `total_changes()` does not roll back, so a body retried after a `SQLITE_BUSY` rollback can
 * read a non-zero delta from the abandoned attempt and stamp a mutation that committed no rows. That
 * over-stamps — a redundant run at the same revision, and `enqueueRun` is idempotent per revision —
 * but it can never *under*-stamp, which is the direction that loses a run.
 */

/**
 * A body that returns a promise is unassignable, so `vaultMutation(db, async () => …)` is a compile
 * error rather than a silent unstamped write. `T` still infers exactly for a synchronous body.
 */
type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

export function vaultMutation<T>(db: DatabaseSync, body: () => NotPromise<T>): T {
  return writeTransaction(db, () => {
    const before = totalChanges(db);
    const result = body();
    if (isThenable(result)) {
      // Second layer, for a JS caller or a cast the type cannot see — and deliberately not oversold:
      // the throw rolls back the *synchronous prefix*, but a body that suspended on an `await` has a
      // continuation no throw can cancel, so a write after the first `await` can still land unstamped.
      // The type closes that case; this is the loud failure for the callers it cannot reach.
      throw new TypeError(
        "vaultMutation body must be synchronous: an async body resolves after the transaction commits, so its writes would land outside it and go unstamped",
      );
    }
    if (totalChanges(db) > before) stampAndEnqueue(db);
    return result;
  });
}

/** Duck-typed, so a hand-rolled thenable is caught and not only a real `Promise`. */
function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/**
 * Row changes on this connection so far. `changes()` is per-statement; this is the cumulative
 * counter, which is what a before/after delta across the body needs.
 */
function totalChanges(db: DatabaseSync): number {
  const row = db.prepare("SELECT total_changes() AS n").get() as { n: number };
  return row.n;
}
