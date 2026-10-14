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
 * shortcut: `total_changes()` does not roll back, so a body retried after a `SQLITE_BUSY` rollback can
 * read a non-zero delta from the abandoned attempt and stamp a mutation that committed no rows. That
 * over-stamps — a redundant run at the same revision, and `enqueueRun` is idempotent per revision —
 * but it can never *under*-stamp, which is the direction that loses a run.
 */
export function vaultMutation<T>(db: DatabaseSync, body: () => T): T {
  return writeTransaction(db, () => {
    const before = totalChanges(db);
    const result = body();
    if (totalChanges(db) > before) stampAndEnqueue(db);
    return result;
  });
}

/**
 * Row changes on this connection so far. `changes()` is per-statement; this is the cumulative
 * counter, which is what a before/after delta across the body needs.
 */
function totalChanges(db: DatabaseSync): number {
  const row = db.prepare("SELECT total_changes() AS n").get() as { n: number };
  return row.n;
}
