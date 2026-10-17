import type { SqliteConnection } from "../store/connection.js";

import {
  claimNextRun,
  currentVaultRevision,
  finishRun,
  type OfferedSpark,
  type SparkRun,
} from "../store/index.js";

/**
 * One run's lifecycle (`ARCHITECTURE.md` §4; `ADR-0004`). The queue *rows* live in the store
 * (`core/src/store/runs.ts`); this module owns the order of operations —
 * **claim → cut → body → currency check → finish**.
 *
 * **There is no loop here any more.** v1's `startWorker` polled on a timer; the rebuild's driver runs
 * on the app's **foreground** lifecycle and calls `runOnce` once per wake (`app/src/engine/
 * runScheduler.ts`, L3 · #166) — polling is banned by the harness (`AGENTS.md`, *Harness overrides*
 * 1), and a phone that polls in the background is a battery complaint. A kill mid-run is recovered by
 * the boot's `requeueOrphanedRuns` (`core/src/boot.ts`), so the resume path is the *row*, not a timer.
 *
 * The **run body is the seam**: `stubRunBody` reaches no provider, and `engineFromProvider` swaps in
 * the AI-backed engine. Keeping the default AI-free is what makes NFR-A1 hold *by construction* — no
 * vault path can reach the boundary, because the vault never runs a body at all.
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
  /**
   * W8: the pairs the model confirmed, already shaped as `spark` rows — the commit offers these
   * (`insertOfferedSparks`). Absent for W1's stub, which reaches no provider and writes nothing.
   */
  offers?: OfferedSpark[];
  /** W8: the `pair_key`s the model rejected — the commit records them as `NOISE` (`recordNoise`). */
  rejected?: string[];
  /**
   * W8: the sweep's inside set — the idea ids that are **still candidates** at the cut (§3.5:
   * `ACTIVE` carrying ≥ 1 domain tag). The commit retracts a live offer outside it
   * (`retractOffersOutside`). Not the same list as `candidates`, which holds `pair_key`s.
   */
  candidateIds?: string[];
}

export type RunBody = (cut: VaultCut) => Promise<RunOutcome> | RunOutcome;

/**
 * W8 (S2 / D7): what a run writes once it is known to be **current**. `runOnce` invokes it only when
 * the vault has not moved past the run's stamp, so the discard path writes nothing (§4 / I) — the
 * placement is the guarantee, not a check inside the commit.
 *
 * The body returns *what* to write; this closure owns *how*. Splitting them is what keeps the
 * currency decision **single**: the body cannot write behind `runOnce`'s back, and the discard path
 * needs no compensating delete.
 */
export type RunCommit = (outcome: RunOutcome, cut: VaultCut) => void;

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
 *
 * shortcut: `ORDER BY id ASC` is **belt-and-braces, not the thing proven** — `SELECT id FROM idea`
 * already walks the covering `sqlite_autoindex_idea_1`, so an unordered read returns the same ids, and a
 * test that seeds out of order cannot distinguish the clause from its absence (W1's `queue.test.ts` said
 * otherwise; corrected 2026-10-14). Upgrade if the cut ever reads a non-covering row, or the table drops
 * the id index — then the clause is load-bearing and worth its own mutation-checked test.
 */
export function cutVault(db: SqliteConnection, revision: number): VaultCut {
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
 *
 * **A current run's outcome is written by `commit`, and only then (W8, S2).** The body computes what
 * must be written and writes nothing; `runOnce` calls `commit(outcome, cut)` **between** the currency
 * check and `finishRun`, so a run that went stale mid-body writes nothing at all — no offer, no
 * suppression, no sweep. A commit that throws propagates: the run is left `RUNNING`, and the boot
 * requeue re-runs it (ADR-0004), which is safe because every run write is idempotent (the offer
 * insert is guarded, the noise insert is `DO NOTHING`).
 */
export async function runOnce(
  db: SqliteConnection,
  body: RunBody = stubRunBody,
  commit?: RunCommit,
): Promise<RunResult | null> {
  const run = claimNextRun(db);
  if (run === null) return null;

  const cut = cutVault(db, run.vault_revision);
  let outcome: RunOutcome;
  try {
    outcome = await body(cut);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    finishRun(db, run.id, "FAILED", error);
    return { run, outcome: null, discarded: false, error };
  }

  const revision = currentVaultRevision(db);
  const discarded = revision !== run.vault_revision;
  // The load-bearing placement (S2/D7): only a still-current run's outcome is written. A stale run
  // offers nothing, suppresses nothing and sweeps nothing — the mutation that moved the revision
  // already enqueued the run that will.
  if (!discarded && commit !== undefined) commit(outcome, cut);
  finishRun(db, run.id, "DONE", discarded ? `discarded: superseded by revision ${revision}` : null);
  return { run, outcome, discarded, error: null };
}
