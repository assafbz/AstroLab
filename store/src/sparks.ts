import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withRetry } from "./retry.js";

/**
 * `spark`'s engine-side writes, as SQL over one table (`ARCHITECTURE.md` §2.3, §3.5, §4; W8 #33).
 *
 * | write | caller | how |
 * | :-- | :-- | :-- |
 * | an `OFFERED` spark | the engine — a gated pair the model confirmed (§3.3 step 3) | `insertOfferedSparks`, standalone |
 * | the sweep | the engine — a live offer whose ideas are no longer candidates (V5 `#16` ⑤) | `retractOffersOutside`, standalone |
 *
 * The API **resolves** sparks (`POST /v1/sparks/{id}/decision`, `DELETE /v1/ideas/{id}`); the worker
 * **creates** them — the split `api/src/delete.ts` records. `spark` is **not** one of §4's four
 * trigger tables (`idea` / `idea_version` / `provenance_edge` / `decision`), so neither write here
 * stamps `vault_meta.revision` nor enqueues a run: a run that stamped would enqueue its own successor,
 * forever. Asserted in `sparks.test.ts`, not assumed.
 *
 * The **rule** that decides *which* pairs may be offered (settled ⇒ not re-offered) is the engine's
 * (`worker/src/engine/suppression.ts`), because the engine is the only reader — the caller passes only
 * pairs that cleared it. This module writes what it is given.
 *
 * ## No stamping, and no `vaultMutation`
 *
 * Same posture and same reason as `suppression.ts` / `mechanism.ts`: derived engine state, written
 * directly with `withRetry`, never through the vault trigger.
 */

/** One confirmed pair, shaped as `spark` stores it. The caller owns the pairing; this is the row. */
export interface OfferedSpark {
  idea_a_id: string;
  idea_b_id: string;
  /** `[aId, bId].sort().join("|")` — W5's canonical key, so the deck and the re-offer rule agree. */
  pair_key: string;
  direction: string;
  claim: string;
  what_it_takes: string | null;
  first_step: string | null;
  /** The shared mechanism, already serialised — internal, never surfaced (`ARCHITECTURE.md` §3.3 item 3). */
  mechanism: string | null;
  /** Selection-internal scores: stored, never a response. */
  domain_distance: number | null;
  structural_alignment: number | null;
}

/**
 * Offer these pairs. **A repeat is a no-op**: the insert is guarded on a live row for the same
 * `pair_key`, so a crash-requeue re-running a claim (`ADR-0004`) offers nothing new rather than
 * throwing on `ux_spark_live` — the index forbids a second `OFFERED` row per pair.
 *
 * @returns the rows actually written.
 */
export function insertOfferedSparks(
  db: DatabaseSync,
  sparks: readonly OfferedSpark[],
  createdAt: string,
): number {
  if (sparks.length === 0) return 0;
  const insert = db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, what_it_takes,
       first_step, mechanism, domain_distance, structural_alignment, status, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OFFERED', ?
     WHERE NOT EXISTS (SELECT 1 FROM spark WHERE pair_key = ? AND status = 'OFFERED')`,
  );
  let written = 0;
  for (const spark of sparks) {
    // Per row, each with its own bounded retry: the rows are independent and a prefix is a legal
    // state, so a `SQLITE_BUSY` mid-call need not replay the whole list (`recordNoise`'s posture).
    written += Number(
      withRetry(() =>
        insert.run(
          randomUUID(),
          spark.idea_a_id,
          spark.idea_b_id,
          spark.pair_key,
          spark.direction,
          spark.claim,
          spark.what_it_takes,
          spark.first_step,
          spark.mechanism,
          spark.domain_distance,
          spark.structural_alignment,
          createdAt,
          spark.pair_key,
        ),
      ).changes,
    );
  }
  return written;
}

/**
 * The sweep: a **live** offer whose ideas are no longer both candidates is retracted (`ARCHITECTURE.md`
 * §4's recompute; V5 `#16` ⑤).
 *
 * `candidateIds` is the cut's eligible set — `ACTIVE` ideas carrying at least one domain tag
 * (`worker/src/engine/gate.ts`). A live offer is *not* history: it is a promise made from the vault's
 * current state, and the state has changed. A **resolved** spark is history and keeps its pair, so the
 * `status = 'OFFERED'` filter confines this exactly as `api/src/delete.ts`'s retraction does.
 *
 * An empty candidate set means nothing is offerable, so every live offer is outside it.
 *
 * @returns the rows removed.
 */
export function retractOffersOutside(db: DatabaseSync, candidateIds: readonly string[]): number {
  if (candidateIds.length === 0) {
    return Number(db.prepare("DELETE FROM spark WHERE status = 'OFFERED'").run().changes);
  }
  const placeholders = candidateIds.map(() => "?").join(", ");
  return Number(
    db
      .prepare(
        `DELETE FROM spark
          WHERE status = 'OFFERED'
            AND (idea_a_id NOT IN (${placeholders}) OR idea_b_id NOT IN (${placeholders}))`,
      )
      .run(...candidateIds, ...candidateIds).changes,
  );
}
