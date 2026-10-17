import { randomUUID } from "node:crypto";
import type { SqliteConnection } from "./connection.js";

import { withRetry } from "./retry.js";

/**
 * `spark`'s engine-side writes, as SQL over one table (`ARCHITECTURE.md` §2.3, §3.5, §4; W8 #33).
 *
 * | operation | caller | how |
 * | :-- | :-- | :-- |
 * | an `OFFERED` spark | the engine — a gated pair the model confirmed (§3.3 step 3) | `insertOfferedSparks`, standalone |
 * | the sweep | the engine — a live offer whose ideas are no longer candidates (V5 `#16` ⑤) | `retractOffersOutside`, standalone |
 * | the deck read | the API — `GET /v1/sparks?state=offered` (K1 `#35`, §4.9) | `liveOffers`, standalone |
 * | the detail read | the API — `GET /v1/sparks/{id}` (§4.12, #118) | `sparkById`, standalone |
 *
 * ## One live-offer predicate, one constant
 *
 * "A live offer" is `spark.status = LIVE_STATUS` and nothing else. That predicate is executable in
 * six places — the insert guard, both sweep branches, the API's delete-retraction
 * (`api/src/delete.ts`), the `unreviewed` count (`api/src/engine-state.ts`), and `liveOffers` — so it
 * lives here as one exported constant rather than as six literal copies that drift. The two DDL
 * copies (`migrations.ts`) stay literal: DDL cannot take a TS const, and the shipped SQL is what
 * `core/test/schema.test.ts` asserts.
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

/**
 * `spark.status`'s whole vocabulary (`ARCHITECTURE.md` §2.3's CHECK; `FLOW.md` §3's verbs). The three
 * terminal values are the resolutions; `OFFERED` is `LIVE_STATUS`, "a live offer".
 */
export type SparkStatus =
  typeof LIVE_STATUS | "RESOLVED-ACCEPTED" | "RESOLVED-DISMISSED" | "RESOLVED-INSPIRED";

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
  db: SqliteConnection,
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
export function retractOffersOutside(
  db: SqliteConnection,
  candidateIds: readonly string[],
): number {
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
 * The one select behind the spark reads: §3.3's six fields — including the derived `domain_tags` from
 * the two source ideas (§4.9) — plus §3.4's `what_it_takes`, plus the row's identity/state
 * (`idea_a_id`, `idea_b_id`, `pair_key`, `status`) the resolving read needs and **no response carries**.
 * The deck appends a `status` filter and a row order; the by-id read an id predicate; the resolving
 * read nothing. One definition, so the deck row, the detail row and the resolving row cannot come to
 * describe different shapes (the module's one-`LIVE_STATUS` posture, above) — the derived union in
 * particular, which is `pairTags`' and is folded exactly once below.
 */
const SPARK_SELECT = `SELECT s.id, s.idea_a_id, s.idea_b_id, s.pair_key, s.status, s.direction, s.claim,
         s.first_step, s.what_it_takes, s.created_at,
         a.domain_tags AS a_tags, b.domain_tags AS b_tags
    FROM spark s
    LEFT JOIN idea a ON a.id = s.idea_a_id
    LEFT JOIN idea b ON b.id = s.idea_b_id`;

/** The columns `SPARK_SELECT` returns, before the derived `domain_tags` is folded in. */
interface SparkReadRow {
  id: string;
  idea_a_id: string;
  idea_b_id: string;
  pair_key: string;
  status: SparkStatus;
  direction: string;
  claim: string;
  first_step: string | null;
  what_it_takes: string | null;
  created_at: string;
  a_tags: string | null;
  b_tags: string | null;
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
  /**
   * The card's third element (`DESIGN.md` §4/§9, `PRD.md` §3.3 item 4; #115). A real value by
   * construction — `parseAdjudication` accepts only an all-non-empty draft or an all-null refusal
   * (`worker/src/provider/schema.ts`) — so a `null` here is a legacy row, rendered as simply absent.
   */
  first_step: string | null;
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
 * (the stored `idea_a_id` then `idea_b_id`), deduped by first appearance. `pair_key = min|max` keys
 * the pair but does not fix which id is `idea_a_id`, so the order is the writer's, not id order. A
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
export function liveOffers(db: SqliteConnection): LiveSpark[] {
  const rows = db
    .prepare(`${SPARK_SELECT} WHERE s.status = '${LIVE_STATUS}' ORDER BY s.rowid ASC`)
    .all() as unknown as SparkReadRow[];
  // §3.3's six fields: `what_it_takes` is the detail's alone (§3.4), so the deck drops it here rather
  // than shipping it and ignoring it downstream.
  return rows.map((row) => ({
    id: row.id,
    direction: row.direction,
    claim: row.claim,
    first_step: row.first_step,
    domain_tags: pairTags(row.a_tags, row.b_tags),
    created_at: row.created_at,
  }));
}

/**
 * A `Spark` **and** the detail-only `what_it_takes` (`docs/API.md` §3.4) — one spark read **by id**,
 * in whatever status it holds. The status-blind sibling of `LiveSpark`: the deck filters to
 * `LIVE_STATUS`, this read does not, because the `{id}` in the request *is* the filter (§4.12).
 */
export interface DetailSpark extends LiveSpark {
  /** What the idea would take to build. `null` only on a legacy row — rendered as simply absent. */
  what_it_takes: string | null;
}

/**
 * One spark by id, in **any** status (§4.12, #118), or `null` for an id the vault does not hold.
 *
 * ## Status-blind by design — the opposite reading from §4.9
 *
 * There is no `status` filter here, and there must not be. A spark the user resolved mid-session must
 * still answer when they tap back to it; only an *unknown* id is absent (the §2 envelope). §4.9's deck
 * needs its filter because a `Spark` carries no `status`, so an unfiltered list is ambiguous — it would
 * hand back resolved sparks with nothing marking them. Here the id is the filter, so no ambiguity
 * exists, and a resolved spark never surfaces as resolved: neither the deck row nor the detail row
 * carries a `status` field (§3.3/§3.4).
 *
 * The select, the join and the derived `domain_tags` are `liveOffers`' (`SPARK_SELECT`), plus §3.4's one
 * extra field. The selection internals are never selected, so nothing here can surface them.
 */
export function sparkById(db: SqliteConnection, id: string): DetailSpark | null {
  const row = db.prepare(`${SPARK_SELECT} WHERE s.id = ?`).get(id) as unknown as
    SparkReadRow | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    direction: row.direction,
    claim: row.claim,
    first_step: row.first_step,
    what_it_takes: row.what_it_takes,
    domain_tags: pairTags(row.a_tags, row.b_tags),
    created_at: row.created_at,
  };
}

/**
 * A spark as its **resolution** needs it (K4 `#38`, `docs/API.md` §4.13) — the identity, the state and
 * the pair, which no response carries. `Spark`/`SparkDetail`/`LiveSpark` all drop these on purpose
 * (§3.3/§3.4: `status` never surfaces, and a `Spark` has no source idea ids); this is the writer's read
 * and has no response contract at all.
 *
 * It carries the two source ids because `ACCEPT` writes a `provenance_edge` per source and `DISMISS`
 * writes the pair's negative signal — the pair is `pair_key`, which is canonical here rather than
 * recomputed at the call site. The projection is otherwise `sparkById`'s, over the same `SPARK_SELECT`
 * and the same `pairTags`, so the union cannot drift from the deck's or the detail's.
 *
 * **Not a filter on `status`.** The caller decides what a non-`OFFERED` spark means (`409`, §4.13); a
 * filter here would answer `null` and turn that `409` into a `404`.
 */
export function sparkForDecision(db: SqliteConnection, id: string): DecisionSpark | null {
  const row = db.prepare(`${SPARK_SELECT} WHERE s.id = ?`).get(id) as unknown as
    SparkReadRow | undefined;
  if (row === undefined) return null;
  return {
    id: row.id,
    idea_a_id: row.idea_a_id,
    idea_b_id: row.idea_b_id,
    pair_key: row.pair_key,
    direction: row.direction,
    claim: row.claim,
    domain_tags: pairTags(row.a_tags, row.b_tags),
    status: row.status,
  };
}

/** A spark as the resolving write needs it — see `sparkForDecision`. */
export interface DecisionSpark {
  id: string;
  /** The pair's two source ideas, in stored order — the provenance edges' targets (§4.13). */
  idea_a_id: string;
  idea_b_id: string;
  /** `[aId, bId].sort().join("|")` — the canonical key `suppressed_pair` is written with. */
  pair_key: string;
  direction: string;
  claim: string;
  domain_tags: string[];
  status: SparkStatus;
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
