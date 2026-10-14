import type { DatabaseSync } from "node:sqlite";

import { LIVE_STATUS, type RunStatus } from "@astrolab/store";

import { vaultSummary } from "./vault-summary.js";

/**
 * The engine state — `GET /v1/sparks/state` (`docs/API.md` §3.6, §4.10; `FLOW.md` §4.1; W8 #33).
 *
 * **E0–E4, computed in one place.** The ladder's inputs are three local reads and one shared function:
 * the vault's `resolved_domains` (through `vaultSummary`, never re-derived), the vault's idea count,
 * the count of live offers, and the run queue's last/in-flight rows. Nothing here reaches a provider —
 * the state readout must answer while the engine is down (NFR-A1), which is exactly the case it
 * exists to report (`FLOW.md` §5.6 → E4).
 *
 * ## The precedence ladder (C5): `E0 → E4 → E1 → E2 → E3`
 *
 * `FLOW.md` §4.1 pins **E0 dominates all** (with no domain spread there is no spark to compute,
 * review, or await, so E0 shows *regardless of AI state*) and **E4 > E3** (a transient cause with a
 * Retry must not read as Exhausted). C3's ruling puts **E1 above E2** whenever a run is in flight —
 * `API.md` §4.11 gates the client's polling fallback on `state = E1` ("only while `state = E1`"), and
 * `§3.6`'s "the deck can still render offered cards *during a run*" only does work if `state ≠ E2`
 * during a run. `unreviewed` is reported truthfully in **every** state, so the E1/E2 coexistence the
 * contract names is a `state` + `unreviewed` pair, not a lost count.
 *
 * ## E0's two arms, and why the idea count is read here
 *
 * `FLOW.md` §4.1's E0 row is *"fewer than 2 distinct resolved domains **(or < 2 ideas)**"* — two arms
 * that reduce to the same statement, *no pair is possible*: a pair needs two ideas **and** two
 * distinct clusters. The domain arm is `!summary.eligible`, i.e. `resolved_domains < floor` read
 * through `vaultSummary` (`FLOW.md` §7 requires E0 and the S0 gate to read the same quantity; read
 * the shipped predicate, do not recompute the comparison over it). The idea arm is this module's own
 * `COUNT(*) FROM idea` — `VaultSummary` deliberately carries no idea count (`API.md` §6), and the
 * arm counts **every** idea row: excluding `NEEDS_COMPLETION` is candidate *selection*'s rule
 * (`gate.ts`, T27), not E0's.
 *
 * ## The run reads (C2/C4)
 *
 * *In flight* means a run with status `PENDING` **or** `RUNNING` (`API.md` §4.16: enqueueing a run is
 * `→ E1`). E4's signal is the **most recent** run row being `FAILED` **and** nothing in flight: a
 * `DONE` run carries no error, and a `DONE` row whose `error` begins `discarded:` is informational,
 * never Unavailable. `spark_run` has no created-at column and `started_at` is second-resolution
 * (`API.md` §1), so insertion order is the only monotonic sequence — hence `ORDER BY rowid DESC`.
 */

/** `FLOW.md` §4.1's vocabulary, in the contract's spelling (`API.md` §3.6). */
export type EnginePhase = "E0" | "E1" | "E2" | "E3" | "E4";

/** The in-flight run as §3.6 reports it: the `{id, status, vault_revision}` triple, not the row. */
export interface EngineRunRef {
  id: string;
  status: Extract<RunStatus, "PENDING" | "RUNNING">;
  vault_revision: number;
}

/** `docs/API.md` §3.6 — the keys are the contract's, not the module's shorthand. */
export interface EngineState {
  state: EnginePhase;
  unreviewed: number;
  run: EngineRunRef | null;
}

/**
 * E0's second arm (`FLOW.md` §4.1: *"or < 2 ideas"*) — the arithmetic of pairing: one idea cannot
 * form a pair. Not `vault-summary.ts`'s `FLOOR`, which is the **domain** floor; the two coincide at 2
 * for different reasons, so they stay separate constants rather than one borrowed for the other.
 */
export const MIN_IDEAS = 2;

/** §3.6's "in flight" — C2: `PENDING` **or** `RUNNING`, never `PENDING` alone. */
const IN_FLIGHT = "status IN ('PENDING', 'RUNNING')";

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** The newest run, in flight or not, by insertion order — C4's only monotonic sequence. */
function lastRunStatus(db: DatabaseSync): RunStatus | null {
  const row = db.prepare("SELECT status FROM spark_run ORDER BY rowid DESC LIMIT 1").get() as
    { status: RunStatus } | undefined;
  return row?.status ?? null;
}

/**
 * The engine state. A **read**: it writes nothing and moves no revision (`vault-summary.ts`'s
 * posture), which `engine-state.test.ts` asserts rather than assumes.
 */
export function engineState(db: DatabaseSync): EngineState {
  const summary = vaultSummary(db);
  const ideas = count(db, "SELECT COUNT(*) AS n FROM idea");
  // Every live offer counts, resolved sparks do not: `LIVE_STATUS` is exactly the deck's reviewable set
  // — the same predicate `liveOffers` reads and `delete.ts` retracts on, from `store/src/sparks.ts` —
  // and §3.6's `unreviewed` is the count that deck needs.
  const unreviewed = count(db, `SELECT COUNT(*) AS n FROM spark WHERE status = '${LIVE_STATUS}'`);
  const run = db
    .prepare(
      `SELECT id, status, vault_revision FROM spark_run
        WHERE ${IN_FLIGHT} ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as EngineRunRef | undefined;

  // E0 dominates all: either arm is "no pair is possible", so neither the queue nor the deck has
  // anything to do. `run`/`unreviewed` still report truthfully — the state field is what dominates.
  if (!summary.eligible || ideas < MIN_IDEAS) {
    return { state: "E0", unreviewed, run: run ?? null };
  }

  // E4 > E3, and E4 requires *no* run in flight (C4): the last run failed and nothing has replaced it.
  if (run === undefined && lastRunStatus(db) === "FAILED") {
    return { state: "E4", unreviewed, run: null };
  }

  // E1 above E2 (C3) — a run in flight is the state a polling or shimmering client keys on.
  if (run !== undefined) {
    return { state: "E1", unreviewed, run };
  }

  // E2 Ready(n): offers to review, nothing computing.
  if (unreviewed >= 1) {
    return { state: "E2", unreviewed, run: null };
  }

  // E3 Exhausted: at/above the floor (E0 did not fire), nothing left to review, nothing computing.
  return { state: "E3", unreviewed, run: null };
}
