import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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
export function currentVaultRevision(db: DatabaseSync): number {
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
export function stampAndEnqueue(db: DatabaseSync): SparkRun {
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
export function enqueueRun(db: DatabaseSync, revision: number): SparkRun {
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
