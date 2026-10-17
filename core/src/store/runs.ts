import { randomUUID } from "node:crypto";
import type { SqliteConnection } from "./connection.js";

import { isoTimestamp } from "./iso.js";
import { writeTransaction } from "./store.js";

/**
 * The run queue, as SQL over `spark_run` + `vault_meta` (`ARCHITECTURE.md` §4; `ADR-0004`).
 *
 * ADR-0004's queue is *"a `spark_run` table plus a worker loop — no external broker"*: a
 * candidate-affecting vault mutation bumps `vault_meta.revision` and enqueues a run carrying that
 * stamp, inside its own transaction, and the worker claims it later. Both processes import this
 * module, so the API's enqueue and the worker's claim are one implementation, not two.
 */

/** `spark_run.status` — exactly the four values the schema's CHECK allows (`docs/SCHEMA.md` §1). */
export type RunStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

export interface SparkRun {
  id: string;
  vault_revision: number;
  status: RunStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

const COLUMNS = "id, vault_revision, status, started_at, finished_at, error";

/** ARCHITECTURE.md §4 — the stamped revision a run is cut from. */
export function currentVaultRevision(db: SqliteConnection): number {
  const row = db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as
    { revision: number } | undefined;
  // `0002_seed_vault_meta` makes the singleton exist; a miss means the vault has no counter at all,
  // which must fail loudly rather than stamp nothing (the guard `capture.ts` used to carry).
  if (row === undefined) throw new Error("vault_meta singleton is missing");
  return row.revision;
}

/**
 * The §4 trigger as one call: bump `vault_meta.revision` (relative, monotonic) and enqueue a run
 * carrying the new stamp. **Both must ride the caller's transaction** — the vault mutation's — so a
 * candidate-affecting write can never go unstamped and the mutation still returns immediately
 * (NFR-P1: it never waits on the engine).
 */
export function stampAndEnqueue(db: SqliteConnection): SparkRun {
  const bumped = db.prepare("UPDATE vault_meta SET revision = revision + 1 WHERE id = 1").run();
  if (Number(bumped.changes) !== 1) throw new Error("vault_meta singleton is missing");
  return enqueueRun(db, currentVaultRevision(db));
}

/**
 * Enqueues a `PENDING` run at `revision`. Supersession (§4 / I) is enforced **here**, not by
 * queueing behind: a `PENDING` run whose stamp is behind is deleted, so the queue holds at most one
 * run — the newest. **Idempotent per revision**: an enqueue at a stamp that is already pending adds
 * no row and returns the existing one, so a retried mutation cannot fan out into two runs.
 *
 * A `RUNNING` row is never touched: it is a live run in another process's hands, and its result is
 * discarded on completion if the vault has moved past it.
 */
export function enqueueRun(db: SqliteConnection, revision: number): SparkRun {
  db.prepare("DELETE FROM spark_run WHERE status = 'PENDING' AND vault_revision < ?").run(revision);

  const existing = db
    .prepare(`SELECT ${COLUMNS} FROM spark_run WHERE status = 'PENDING' AND vault_revision = ?`)
    .get(revision) as SparkRun | undefined;
  if (existing !== undefined) return existing;

  const run: SparkRun = {
    id: randomUUID(),
    vault_revision: revision,
    status: "PENDING",
    started_at: null,
    finished_at: null,
    error: null,
  };
  db.prepare(
    `INSERT INTO spark_run (id, vault_revision, status, started_at, finished_at, error)
     VALUES (?, ?, 'PENDING', NULL, NULL, NULL)`,
  ).run(run.id, revision);
  return run;
}

/**
 * Claims the newest `PENDING` run for the worker: discards a run whose stamp is behind the vault
 * (never ran, produced nothing — so nothing is lost), then marks the survivor `RUNNING`.
 *
 * One transaction, because the discard-and-claim is the unit other writers serialize against: the
 * `BEGIN IMMEDIATE` in `writeTransaction` is what stops two workers claiming one run.
 */
export function claimNextRun(db: SqliteConnection): SparkRun | null {
  return writeTransaction(db, () => {
    const revision = currentVaultRevision(db);
    // Sweep the queue of stale work first (§4 / I — discarded, not queued). `enqueueRun` already
    // supersedes, so a behind-stamp PENDING row here is a crash artifact; clearing it keeps the
    // queue's meaning ("the newest outstanding revision") true even after a rough restart.
    db.prepare("DELETE FROM spark_run WHERE status = 'PENDING' AND vault_revision < ?").run(
      revision,
    );

    const head = db
      .prepare(
        `SELECT ${COLUMNS} FROM spark_run WHERE status = 'PENDING' ORDER BY vault_revision DESC LIMIT 1`,
      )
      .get() as SparkRun | undefined;
    if (head === undefined) return null;

    const started_at = isoTimestamp();
    db.prepare("UPDATE spark_run SET status = 'RUNNING', started_at = ? WHERE id = ?").run(
      started_at,
      head.id,
    );
    return { ...head, status: "RUNNING", started_at };
  });
}

/**
 * Records a run's terminal state. Guarded on `RUNNING` and loud on a miss: finishing a run that is
 * not running means the claim/finish pair is out of order, which must fail rather than wedge a row.
 */
export function finishRun(
  db: SqliteConnection,
  id: string,
  status: "DONE" | "FAILED",
  error: string | null = null,
): void {
  writeTransaction(db, () => {
    const result = db
      .prepare(
        "UPDATE spark_run SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'RUNNING'",
      )
      .run(status, isoTimestamp(), error, id);
    if (Number(result.changes) !== 1) {
      throw new Error(`run ${id} is not RUNNING; nothing to finish`);
    }
  });
}

/**
 * ADR-0004 — *"the queue is not durable across a process crash mid-run … a restart simply
 * re-enqueues"*: a `RUNNING` row left by a dead process is returned to `PENDING`. Safe to call at
 * every boot. The stamp is kept, so a run left behind a vault that has since moved is discarded by
 * the next `claimNextRun`, and a mutation enqueued in the meantime still supersedes it.
 *
 * **Assumes one worker** (the MVP runs one). Two workers racing a boot would both re-enqueue.
 */
export function requeueOrphanedRuns(db: SqliteConnection): number {
  return writeTransaction(db, () => {
    const result = db
      .prepare(
        "UPDATE spark_run SET status = 'PENDING', started_at = NULL WHERE status = 'RUNNING'",
      )
      .run();
    return Number(result.changes);
  });
}
