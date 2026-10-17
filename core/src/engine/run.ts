import type { SqliteConnection } from "../store/connection.js";

import {
  insertOfferedSparks,
  isoTimestamp,
  recordNoise,
  retractOffersOutside,
  type OfferedSpark,
} from "../store/index.js";

import type { RunBody, RunCommit, RunOutcome, VaultCut } from "./queue.js";
import type { Adjudicator, ConfirmedSpark } from "./adjudicate.js";
import { candidateIds, type Gate } from "./gate.js";
import type { Suppression } from "./suppression.js";

/**
 * W8's run surface: the engine's four stages **composed**, and the writes they imply (§3.1, §3.3;
 * `ARCHITECTURE.md` §4; W8 #33).
 *
 * ## The body composes; the commit writes (S2/D7)
 *
 * `createEngineRun` returns two halves rather than one function, because the run lifecycle owns the
 * currency check (`worker/src/queue.ts`'s `runOnce`): the **body** runs `gate.gatedPairs` →
 * `suppression.eligiblePairs` → `adjudicator.adjudicate` and returns *what* must be written — nothing
 * more — and the **commit** performs the writes. That split is what makes a run discarded as stale
 * (§4 / I) write **nothing at all**: the body reached no write, and `runOnce` never calls the commit.
 * A single-function body that wrote at its end would need its own currency check, a second place the
 * same decision could be made and disagree.
 *
 * Each stage already refuses to write for this same reason — `gate.ts` ("Recording an outcome is
 * W7/W8"), `adjudicate.ts` (D1), `suppression.ts` (D7). This module is the one caller, so it is the
 * one place the three writes are ordered.
 *
 * | write | call | what it is |
 * | :-- | :-- | :-- |
 * | offer the confirmed pairs | `insertOfferedSparks` | a gated pair the model confirmed (§3.3 step 3) |
 * | record the rejections | `recordNoise` | a pair the model refused — `NOISE`, not `CLICHE` (§3.5) |
 * | sweep stale live offers | `retractOffersOutside` | an offer whose ideas are no longer candidates (§4) |
 *
 * **Nothing here stamps `vault_meta.revision` or enqueues a run.** The three writes are
 * non-stamping by construction (`core/src/store/sparks.ts`, `core/src/store/suppression.ts`): `spark` and
 * `suppressed_pair` are not among §4's four trigger tables, and a run whose writes stamped would
 * enqueue its own successor forever. Asserted end-to-end in `run.test.ts`, not assumed.
 *
 * ## The sweep reads the same candidate set the gate does (C1's spirit)
 *
 * `retractOffersOutside` gets `candidateIds(db, cut)` — the gate's own §3.5 predicate, read through
 * `gate.ts` so a sweep can never retract an offer whose idea the gate would still consider. It is a
 * separate quantity from `candidates`, which holds **`pair_key`s** (what the run adjudicated); this
 * one holds **idea ids** (who is still in the vault).
 *
 * ## The provider is reached only through the adjudicator
 *
 * The body takes the three stages as constructed dependencies (`worker/src/index.ts` builds them), so
 * this module names no provider and opens no adapter: a provider that cannot be built must fail runs,
 * not the composer. `worker/src/provider/boundary.test.ts` fails the suite if `api/` or `client/`
 * names a symbol here.
 *
 * ## The seam — this is a socket too (D4)
 *
 * It ships **unwired**: nothing composes it until the worker's composition root names it. `queue.ts`'s
 * default body stays `stubRunBody` (it reaches no provider), so no unruled surface reaches `main`.
 */

/** The three stages this run composes — each already constructed, each already refusing to write. */
export interface EngineRunDeps {
  /** W5's gate: the candidate pairs, AI-free over the pairwise scan. */
  gate: Gate;
  /** W7's re-offer rule: the gated pairs minus the settled ones. */
  suppression: Suppression;
  /** W6's adjudicator: one provider call per eligible pair. */
  adjudicator: Adjudicator;
}

/** The two halves a run needs: the composer `runOnce` runs, and the writes it performs when current. */
export interface EngineRun {
  /** Compute the outcome. Reaches the provider (through the adjudicator) and **writes nothing**. */
  body: RunBody;
  /** Perform the run's writes. Called by `runOnce` **only** when the run is current (S2). */
  commit: RunCommit;
}

/**
 * A confirmed pair, as the `spark` row stores it (§2.3). The scores (`domain_distance`,
 * `structural_alignment`) and the shared `mechanism` are **selection-internal** — never surfaced
 * (§3.3 items 2–4) — but they are stored, and the draft already carries the surfaced fields.
 */
function toOfferedSpark(confirmed: ConfirmedSpark): OfferedSpark {
  return {
    idea_a_id: confirmed.aId,
    idea_b_id: confirmed.bId,
    pair_key: confirmed.key,
    direction: confirmed.draft.direction,
    claim: confirmed.draft.claim,
    what_it_takes: confirmed.draft.what_it_takes,
    first_step: confirmed.draft.first_step,
    mechanism: confirmed.draft.mechanism,
    domain_distance: confirmed.distance,
    structural_alignment: confirmed.alignment,
  };
}

export function createEngineRun(db: SqliteConnection, deps: EngineRunDeps): EngineRun {
  const { gate, suppression, adjudicator } = deps;
  return {
    async body(cut: VaultCut): Promise<RunOutcome> {
      const gated = await gate.gatedPairs(cut);
      const eligible = suppression.eligiblePairs(gated);
      // One call per eligible pair; a settled pair never reaches here (0 AI calls, §3.5).
      const adjudication = await adjudicator.adjudicate(eligible);
      return {
        // The pairs this run adjudicated — the candidate set *after* the re-offer filter.
        candidates: eligible.map((pair) => pair.key),
        offers: adjudication.confirmed.map(toOfferedSpark),
        rejected: adjudication.rejected.map((pair) => pair.key),
        candidateIds: candidateIds(db, cut),
      };
    },

    commit(outcome: RunOutcome, cut: VaultCut): void {
      // The body always fills these three; the `??` arms only cover a foreign body handed to this
      // commit, and each names the write's own no-op (no offers, no rejections, a recomputed sweep).
      insertOfferedSparks(db, outcome.offers ?? [], isoTimestamp());
      recordNoise(db, outcome.rejected ?? []);
      retractOffersOutside(db, outcome.candidateIds ?? candidateIds(db, cut));
    },
  };
}
