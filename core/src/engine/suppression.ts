import type { SqliteConnection } from "../store/connection.js";

import { recordNoise } from "../store/index.js";

import type { RejectedPair } from "./adjudicate.js";
import type { GatedPair } from "./gate.js";

/**
 * The re-offer rule (`ARCHITECTURE.md` §3.5; W7 #32, Done 2): **which pairs are settled** — a `spark`
 * row of *any* status, or a `suppressed_pair` row of *any* reason — and therefore **not re-offered**.
 *
 * It sits between W5's gate and W6's adjudicator, and it is the **only** reader of the settled set
 * (the writes live in `core/src/store/suppression.ts`, where both packages can reach them):
 * W8 composes `gate → eligiblePairs → adjudicate → recordRejections`.
 *
 * ## The seam — a socket (D1, Q1)
 *
 * It ships unwired, like W3's cache, W4's distance, W5's gate and W6's adjudicator: nothing calls it
 * until **W8**'s run body composes the chain above. `queue.ts`'s default body stays `stubRunBody`;
 * `worker/src/index.ts` is a process entry, not a barrel, so W8 imports this by path exactly where
 * `adjudicate.ts` sits.
 *
 * ## Settled, and why the records *are* the state (D2)
 *
 * §3.5: a dismissed pair is "not re-offered **unchanged**", and an accepted pair is "retired from the
 * deck". The state that says so is already stored — `spark.pair_key` (every offer ever made) and
 * `suppressed_pair.pair_key` (the dismissals) — so eligibility is a read, not a new rule: a pair is
 * settled iff either table names it. Undo needs no case either: ACCEPT/DISMISS undo returns the spark
 * to `OFFERED` or deletes the suppression row (`FLOW.md` §5.4), and the pair becomes eligible again.
 *
 * **The `spark`-any-status half is this rule, not the index's.** `ux_spark_live` forbids only a second
 * `OFFERED` row per pair, so on its own it would still allow a *later* re-offer of an accepted pair —
 * which is exactly the retirement §3.5 states (`gate.ts`, D2 of the W7 plan).
 *
 * **No `decision` read.** Every resolving action moves its spark out of `OFFERED` (`FLOW.md` §4.3),
 * `decision.spark_id` is `NOT NULL` and references `spark(id)`, and the delete path retracts only
 * *live* offers (`core/src/vault/delete.ts`) — so `spark.pair_key` (any status) is a superset of every
 * decision. `spark ∪ suppressed_pair` is sufficient, provably, in one statement.
 *
 * ## Key-permanent (D4, Q2)
 *
 * `suppressed_pair.updated_at` is audit, not an anchor: a suppressed pair is never re-adjudicated. The
 * *different* pairing a materially changed vault surfaces (§3.5 / `FLOW.md` §5.3) is a different
 * `pair_key`, and the flywheel's own nudge — *Fork into a new domain* (`FLOW.md` §5.3) — is a new
 * node, hence new keys. (The staleness-aware alternative — revive a key when the idea text it was
 * derived from changed — is implementable and unadopted; it changes the design, so it is not silently
 * here. Its known cost, noted for the record: an *iteration* on a node in a dismissed pair keeps the
 * same `pair_key`, so this rule makes that dismissal final.)
 *
 * ## Cost, and what a settled pair never does
 *
 * `eligiblePairs` is a pure read: no provider, so it is **synchronous** like `gate.ts`'s own SQL, and
 * it drops a settled pair *before* adjudication — a settled pair costs **0 AI calls**. It writes
 * nothing: no `spark`, no `idea`, no revision bump, no enqueued run (D6).
 *
 * ## Placement is the caller's (D7)
 *
 * `recordRejections` must be called **after** the caller's **currency check** (§4/I): a run later
 * discarded as stale must not have suppressed pairs it never surfaced. W8 owns that placement — the
 * same reason W6's `adjudicate` writes nothing. The write itself is `store`'s
 * (`core/src/store/suppression.ts`), so the reason vocabulary is shared with K4's dismissal instead of
 * re-typed here.
 */

export interface Suppression {
  /**
   * The re-offer rule: W5's gated pairs minus the settled ones. Content and order are otherwise
   * untouched (W5 returns a `pair_key`-sorted list, and no caller stores it as these objects).
   */
  eligiblePairs(pairs: readonly GatedPair[]): GatedPair[];
  /**
   * W8: record the model's rejections (`ARCHITECTURE.md` §3.5). A key that already has a row is left
   * alone, so a retry is a no-op and a user verdict is never clobbered. Returns the rows written.
   */
  recordRejections(rejected: readonly RejectedPair[]): number;
}

/**
 * Every pair the vault has settled: any `spark` status, any suppression reason. One `UNION`, no
 * parameters, snapshot-consistent by construction (D2).
 */
function settledKeys(db: SqliteConnection): Set<string> {
  const rows = db
    .prepare(
      `SELECT pair_key FROM spark
       UNION
       SELECT pair_key FROM suppressed_pair`,
    )
    .all() as Array<{ pair_key: string }>;
  return new Set(rows.map((row) => row.pair_key));
}

export function createSuppression(db: SqliteConnection): Suppression {
  return {
    eligiblePairs(pairs) {
      if (pairs.length === 0) return [];
      const settled = settledKeys(db);
      if (settled.size === 0) return [...pairs];
      return pairs.filter((pair) => !settled.has(pair.key));
    },

    recordRejections(rejected) {
      return recordNoise(
        db,
        rejected.map((pair) => pair.key),
      );
    },
  };
}
