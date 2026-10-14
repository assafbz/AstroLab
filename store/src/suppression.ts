import type { DatabaseSync } from "node:sqlite";

import { isoTimestamp } from "./iso.js";
import { withRetry } from "./retry.js";

/**
 * `suppressed_pair`, as SQL over one table (`ARCHITECTURE.md` §2.3, §3.5; W7 #32).
 *
 * The **rule** that turns a settled pair into "not re-offered" is the engine's
 * (`worker/src/engine/suppression.ts`), because the engine is the only reader. What lives here is the
 * **write**, because `suppressed_pair` has **two writers in two packages** and one shared, narrowed
 * vocabulary is what stops them drifting:
 *
 * | reason | writer | how it is called |
 * | :-- | :-- | :-- |
 * | `NOISE` | the engine — a pair the model rejected (§3.3 step 3) | `recordNoise`, standalone |
 * | `DISMISSED` | the API — K4's dismissal and its undo (`FLOW.md` §4.3 DISMISS, §5.4) | `recordDismissal` / `clearSuppression`, inside the caller's `vaultMutation` |
 *
 * This is the `mechanism.ts` / `domain-map.ts` precedent, the same one `runs.ts` states: SQL over a
 * table that is **not** one of §4's four trigger tables lives in `store`, so the "this is not a
 * `vaultMutation`" argument is made once instead of re-justified at a call site in another package.
 * A suppression changes the **next** run's candidate set; the next vault mutation is what stamps and
 * enqueues that run, never this write.
 *
 * ## `CLICHE` has no writer — by construction, not by a parameter check (W7 plan D5, ruled)
 *
 * The column's `CHECK` names three reasons; `SuppressionReason` names two, and neither writer takes a
 * reason **argument** — `recordNoise` is the noise writer and `recordDismissal` is the dismissal
 * writer, so there is no value a caller could pass to reach a third. Cliché is the **gate's** drop: a
 * pure function of the current vault, recomputed free on every run (§3.5), so persisting it would
 * freeze a *state-dependent* verdict — a one-domain vault, where every pair is cliché, would stay
 * blacklisted once the user adds the cross-domain idea the bootstrap exists to elicit. The column
 * keeps the value as vocabulary; production code may not write it.
 *
 * ## Retry posture follows the call, not the module
 *
 * `recordNoise` runs standalone (from W8's run **commit**, after `runOnce`'s currency check — the
 * hook `worker/src/engine/run.ts` builds), so it carries the bounded retry `upsertDescriptor` carries. `recordDismissal` / `clearSuppression` run **inside** the
 * caller's `vaultMutation`, whose `writeTransaction` already retries the whole body — an inner retry
 * there would sleep while holding the write lock. Both postures have precedent: `mechanism.ts` for the
 * first, `delete.ts` / `capture.ts` for the second.
 */

/** The `suppressed_pair.reason` values a writer may name — see the module note on `CLICHE`. */
export type SuppressionReason = "NOISE" | "DISMISSED";

/** The model's rejection (`ARCHITECTURE.md` §3.3 step 3). */
const NOISE: SuppressionReason = "NOISE";

/** The user's dismissal (`FLOW.md` §4.3 DISMISS) — the negative signal kept so a pairing is not re-offered. */
const DISMISSED: SuppressionReason = "DISMISSED";

/**
 * Record the pairs the model rejected. `DO NOTHING` on conflict: a rejection is not the engine's to
 * impose, so it never overwrites a row the user owns, and a retried run neither resurrects nor
 * re-stamps one. Idempotent under retry by construction.
 *
 * @returns the rows actually written — `0` for a key that already had a row.
 */
export function recordNoise(db: DatabaseSync, pairKeys: readonly string[]): number {
  // Empty input runs no statement at all — there is no `IN (…)` to build and nothing to write.
  if (pairKeys.length === 0) return 0;
  const insert = db.prepare(
    `INSERT INTO suppressed_pair (pair_key, reason, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(pair_key) DO NOTHING`,
  );
  let written = 0;
  for (const key of pairKeys) {
    // Per key, each with its own bounded retry: the rows are independent and writing a prefix of them
    // is a legal state, so a `SQLITE_BUSY` mid-call does not have to replay the whole list.
    written += Number(withRetry(() => insert.run(key, NOISE, isoTimestamp())).changes);
  }
  return written;
}

/**
 * Record the user's dismissal (`FLOW.md` §4.3 DISMISS). **Upsert**, not insert-if-absent: the user's
 * verdict is the last word on a pair, so it replaces a `NOISE` row rather than being dropped by a
 * conflict, and refreshes `updated_at`.
 *
 * Called **inside** K4's `vaultMutation` — the dismissal must commit with its `decision` row and its
 * spark's status in one transaction (`api/src/delete.ts` is the mirror pattern), so this carries no
 * transaction and no retry of its own.
 */
export function recordDismissal(db: DatabaseSync, pairKey: string): void {
  db.prepare(
    `INSERT INTO suppressed_pair (pair_key, reason, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(pair_key) DO UPDATE SET
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).run(pairKey, DISMISSED, isoTimestamp());
}

/**
 * Clear the negative signal — K4's one-step DISMISS undo, which returns the pair to the deck
 * (`FLOW.md` §5.4). Same posture as `recordDismissal`: the caller's transaction owns it.
 */
export function clearSuppression(db: DatabaseSync, pairKey: string): void {
  db.prepare("DELETE FROM suppressed_pair WHERE pair_key = ?").run(pairKey);
}
