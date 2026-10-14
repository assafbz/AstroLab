import type { DatabaseSync } from "node:sqlite";

import { claimNextRun, currentVaultRevision, finishRun, type SparkRun } from "@astrolab/store";

/**
 * The worker's run loop (`ARCHITECTURE.md` §4; `ADR-0004`). The queue *rows* live in the store
 * (`@astrolab/store`'s `runs.ts`); this module owns the order of operations —
 * **claim → cut → body → currency check → finish**.
 *
 * The **run body is the seam**: W1 ships `stubRunBody`, which reaches no provider, and W2 swaps in
 * the AI-backed engine. Keeping the default AI-free is what makes NFR-A1 hold *by construction* —
 * no vault path can reach the boundary, because the vault never runs a body at all.
 */

/** The vault as one run sees it: the revision it was cut from, and the ideas it covers. */
export interface VaultCut {
  revision: number;
  /**
   * The idea ids the run covers, **ASC** — the deterministic cut, so two runs at one revision hand
   * the body an identical `VaultCut` (issue #26, Done #4).
   */
  ideaIds: string[];
}

export interface RunOutcome {
  /** Candidate `pair_key`s the body produced. W1's stub produces none; W5+ produces real pairs. */
  candidates: string[];
}

export type RunBody = (cut: VaultCut) => Promise<RunOutcome> | RunOutcome;

export interface RunResult {
  run: SparkRun;
  /** `null` only when the body threw. */
  outcome: RunOutcome | null;
  /** `true` when the vault moved past the run's stamp: the outcome is not offered (§4 / I). */
  discarded: boolean;
  error: string | null;
}

/**
 * The cut: idea ids, ASC. Reads the live vault, which is exactly why a run must not be stale — the
 * worker only runs a revision the vault is still on (the store's `claimNextRun` discards the rest).
 */
export function cutVault(db: DatabaseSync, revision: number): VaultCut {
  const ideaIds = (
    db.prepare("SELECT id FROM idea ORDER BY id ASC").all() as Array<{ id: string }>
  ).map((row) => row.id);
  return { revision, ideaIds };
}

/**
 * W1's run body: exercise the lifecycle, reach no provider. It produces no candidates — the axes and
 * adjudication are W4–W7 — and takes no cut, because a stub that read the vault would only pretend to
 * be an engine. W2 replaces this as the worker's default body.
 */
export const stubRunBody: RunBody = () => ({ candidates: [] });

/**
 * One step of the loop: claim the newest pending run, cut the vault at its stamp, run the body,
 * then record the outcome. Returns `null` when nothing is pending.
 *
 * **Failure ⇒ `FAILED`, vault untouched.** A body that throws (a provider timeout, later) fails only
 * its run — that is the E4 path (`FLOW.md` §5.6): spark generation pauses, the vault is unaffected.
 *
 * **Staleness is checked after the body, before it is offered.** If the vault advanced while the body
 * ran, the run still *completed*, so it is `DONE`; its outcome is returned with `discarded: true` and
 * is **never offered** — the mutation that moved the revision already enqueued the run that
 * supersedes it (§4 / I). The disposition is behavioural, not a fifth status; it rides the existing
 * `error` column as an explicitly non-fatal note.
 */
export async function runOnce(
  db: DatabaseSync,
  body: RunBody = stubRunBody,
): Promise<RunResult | null> {
  const run = claimNextRun(db);
  if (run === null) return null;

  let outcome: RunOutcome;
  try {
    outcome = await body(cutVault(db, run.vault_revision));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(db, run.id, "FAILED", error);
    return { run, outcome: null, discarded: false, error };
  }

  const revision = currentVaultRevision(db);
  const discarded = revision !== run.vault_revision;
  finishRun(db, run.id, "DONE", discarded ? `discarded: superseded by revision ${revision}` : null);
  return { run, outcome, discarded, error: null };
}

export interface WorkerOptions {
  /** Idle delay between empty polls. The worker process may wait; tests call `runOnce` directly. */
  idleMs?: number;
  /** Observed instead of thrown, so one bad run cannot kill the loop. */
  onError?: (err: unknown) => void;
}

/**
 * Starts the poll loop: `runOnce` repeatedly, waiting `idleMs` between passes. The timer is
 * `unref`'d, so an idle worker does not hold the process open on its own.
 */
export function startWorker(
  db: DatabaseSync,
  body: RunBody = stubRunBody,
  options: WorkerOptions = {},
): { stop: () => void } {
  const idleMs = options.idleMs ?? 1000;
  let stopped = false;
  let handle: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runOnce(db, body);
      if (result?.error != null) options.onError?.(new Error(result.error));
    } catch (err) {
      // `runOnce` already records a body failure on the run; anything thrown here is the queue
      // itself, which must not take the loop down.
      options.onError?.(err);
    }
    if (!stopped) handle = setTimeout(tick, idleMs).unref();
  };

  handle = setTimeout(tick, 0).unref();
  return {
    stop: () => {
      stopped = true;
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}
