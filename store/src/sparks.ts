import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withRetry } from "./retry.js";

/**
 * `spark`'s engine-side writes, as SQL over one table (`ARCHITECTURE.md` §2.3, §3.5, §4; W8 #33).
 *
 * | operation | caller | how |
 * | :-- | :-- | :-- |
 * | an `OFFERED` spark | the engine — a gated pair the model confirmed (§3.3 step 3) | `insertOfferedSparks`, standalone |
 * | the sweep | the engine — a live offer whose ideas are no longer candidates (V5 `#16` ⑤) | `retractOffersOutside`, standalone |
 * | the deck read | the API — `GET /v1/sparks?state=offered` (K1 `#35`, §4.9) | `liveOffers`, standalone |
 *
 * ## One live-offer predicate, one constant
 *
 * "A live offer" is `spark.status = LIVE_STATUS` and nothing else. That predicate is executable in
 * six places — the insert guard, both sweep branches, the API's delete-retraction
 * (`api/src/delete.ts`), the `unreviewed` count (`api/src/engine-state.ts`), and `liveOffers` — so it
 * lives here as one exported constant rather than as six literal copies that drift. The two DDL
 * copies (`migrations.ts`) stay literal: DDL cannot take a TS const, and the shipped SQL is what
 * `store/test/schema.test.ts` asserts.
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

/**
 * The live-offer status — `spark.status = LIVE_STATUS` **is** "a live offer" (V5 `#16`, K1 `#35`).
 *
 * Exported so the predicate has exactly one definition (the six executable sites in the module doc);
 * the DDL and `ux_spark_live` restate it as SQL, which is the DB-level guarantee and stays literal.
 */
export const LIVE_STATUS = "OFFERED";

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
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${LIVE_STATUS}', ?
     WHERE NOT EXISTS (SELECT 1 FROM spark WHERE pair_key = ? AND status = '${LIVE_STATUS}')`,
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
    return Number(db.prepare(`DELETE FROM spark WHERE status = '${LIVE_STATUS}'`).run().changes);
  }
  const placeholders = candidateIds.map(() => "?").join(", ");
  return Number(
    db
      .prepare(
        `DELETE FROM spark
          WHERE status = '${LIVE_STATUS}'
            AND (idea_a_id NOT IN (${placeholders}) OR idea_b_id NOT IN (${placeholders}))`,
      )
      .run(...candidateIds, ...candidateIds).changes,
  );
}

/**
 * One deck row, exactly as `docs/API.md` §3.3 projects it (K1 `#35`). Deliberately not the row:
 * `mechanism`, `domain_distance`, `structural_alignment` and the source idea ids are selection
 * internals and never surface (`ARCHITECTURE.md` §2.3; §6's no-scores rule).
 */
export interface LiveSpark {
  id: string;
  direction: string;
  claim: string;
  /** The two source ideas' tags, pair order, deduped — `spark` stores no tags of its own (see below). */
  domain_tags: string[];
  created_at: string;
}

/**
 * The deck read — every live offer, in **server order** (`docs/API.md` §4.9, K1 `#35`).
 *
 * Insertion order is the sequence: `spark.created_at` is second-resolution (`API.md` §1) so it cannot
 * separate two offers written in one run, and `rowid` is the same monotonic order W8's run reads use.
 * Oldest offer first — a **departure** from §4.4's newest-first vault list, written into §4.9 so the
 * client lanes do not "fix" it into agreement.
 *
 * ## `domain_tags` is derived, because the DDL has no column for it
 *
 * §3.3 requires `domain_tags` on a `Spark` and `DESIGN.md` §9 renders them as the card's chips, but
 * `spark` carries no tags — so this is a read-side join onto the two source ideas, in **pair order**
 * (`idea_a_id` then `idea_b_id`, which `pair_key = min|max` fixes), deduped by first appearance. A
 * tag may be a *provisional* one (S0's `Other → free text` escape): there is no cluster field on a
 * `Spark`, so the card shows the raw tag and a client must not read chips as resolved clusters.
 *
 * ## The left joins are the count's guard, not a tolerance for dangling refs
 *
 * A live offer's sources exist by construction — `api/src/delete.ts` retracts a live offer in the
 * same transaction that removes an idea — so an inner join would be correct *today*. It is a left
 * join anyway because the failure it prevents is silent and load-bearing: an inner join that dropped
 * a row would hide a live offer that `engineState`'s `unreviewed` still counts, and §3.6's count and
 * §4.9's deck must describe the same set.
 */
export function liveOffers(db: DatabaseSync): LiveSpark[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.direction, s.claim, s.created_at,
              a.domain_tags AS a_tags, b.domain_tags AS b_tags
         FROM spark s
         LEFT JOIN idea a ON a.id = s.idea_a_id
         LEFT JOIN idea b ON b.id = s.idea_b_id
        WHERE s.status = '${LIVE_STATUS}'
        ORDER BY s.rowid ASC`,
    )
    .all() as Array<{
    id: string;
    direction: string;
    claim: string;
    created_at: string;
    a_tags: string | null;
    b_tags: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    claim: row.claim,
    domain_tags: pairTags(row.a_tags, row.b_tags),
    created_at: row.created_at,
  }));
}

/** The pair-order union: `a`'s tags then `b`'s, first appearance wins. */
function pairTags(a: string | null, b: string | null): string[] {
  const tags: string[] = [];
  for (const raw of [a, b]) {
    if (raw === null) continue;
    for (const tag of JSON.parse(raw) as string[]) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}
