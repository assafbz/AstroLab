import type { SqliteConnection } from "../store/connection.js";

import { clearSuppression, isoTimestamp, LIVE_STATUS, vaultMutation } from "../store/index.js";

import { ConflictError, NotFoundError } from "./capture.js";
import { findDecision, undoRefusal, UNDO_WINDOW_SECONDS, type UndoRefusal } from "./decision.js";

/**
 * Undo — `POST /v1/decisions/{decision_id}/undo` (`docs/API.md` §4.15; `FLOW.md` §5.4 / T12 / N3).
 *
 * **One step, all three resolving paths.** §5.4's undo affordance appears after any *resolving* action
 * — a deck **ACCEPT**, a deck **DISMISS**, or a **committed seeded save** (T16) — and this route
 * reverses whichever one the id names. It is the last unwritten §4 endpoint: every primitive it needs
 * is already in `main` (`findDecision`, `undoRefusal`, `clearSuppression`, and V5's delete semantics),
 * so the new build is the route and its guards, not a schema.
 *
 * ## The reversibility predicate is `decision.ts`'s, not a second copy
 *
 * §4.13's response computes `undoable` from `undoRefusal`; this handler calls the **same** export, so
 * the client's signal and the route's answer for one state cannot differ. `UNDO_WINDOW_SECONDS` is the
 * server policy §4.15 owns (`FLOW.md` §5.4 leaves the duration unspecified).
 *
 * ## Precedence: `404` → the 409 arms → the write, all inside one transaction
 *
 * An unknown id names nothing (`404`); a known id in a state the predicate forbids is `409`; only
 * then does the retract run. Every check is inside the transaction, so a refused undo writes nothing —
 * no stamp, no run — the same "the `404`/`409` can never churn the vault" rule §4.13 records.
 *
 * ## The retract is V5's delete semantics, and it does not outlive what it retracts
 *
 * An ACCEPT / seeded-save undo deletes the derived idea — `ON DELETE CASCADE` takes its version
 * history and its provenance edges, so "clear its provenance" *is* the cascade — and drops
 * any **live offer** built from it, mirroring `core/src/vault/delete.ts` (an offer is a promise made from the
 * vault's current state, and the state just changed). A DISMISS undo clears its `suppressed_pair`
 * negative signal instead. Both then return the spark to `OFFERED` and delete the `decision` row.
 *
 * ## The `ux_spark_live` argument, stated
 *
 * Re-offering the spark cannot collide with a live offer for the same pair: while the decision stood,
 * the pair was settled — by the resolved `spark` row for ACCEPT / INSPIRED, by `suppressed_pair` for
 * DISMISS — and the engine's settled set (`spark` (any status) ∪ `suppressed_pair`) is what stops it
 * re-offering. So no `OFFERED` row for that `pair_key` can exist at this point.
 *
 * ## One product call (§4.15 / §3.5)
 *
 * §4.15's response is its only named shape, and the `decision_id` is the path — **no body is read**
 * (§4.16's posture: a body is ignored, not echoed). A retract with nothing to retract is the
 * `missing` arm, not a silent `200`.
 */

/** `docs/API.md` §4.15 — the undo's only named success. */
export interface UndoResult {
  undone: true;
  /** The spark the undone decision resolved. */
  spark_id: string;
  /** §4.15's verbatim terminal — the card is back in the deck. */
  spark_status: "OFFERED";
  /** The idea an ACCEPT / seeded-save undo retracted; `null` for a DISMISS (it created none). */
  retracted_idea_id: string | null;
}

/** Why an undo is refused, in words — §4.15's `409` envelope carries the arm (call 5's ordering). */
const REFUSAL_MESSAGE: Record<UndoRefusal, string> = {
  superseded: "a later decision has closed the undo window",
  expired: `the undo window (${UNDO_WINDOW_SECONDS}s) has closed`,
  edited: "the derived idea has been edited",
  missing: "the derived idea no longer exists",
};

/**
 * Undo one decision, or refuse — `docs/API.md` §4.15. One transaction for the whole thing, so the
 * retract, the re-offer and the cleared resolution commit together or not at all (an APPEND-only
 * rollback is free, as at §4.13).
 *
 * @throws NotFoundError an unknown `decision_id` (`404`).
 * @throws ConflictError a decision the window, a later decision, or its idea's edit/deletion retired
 *   (`409`).
 */
export function undoDecision(db: SqliteConnection, decisionId: string): UndoResult {
  return vaultMutation(db, () => {
    // 1 — §2: an unknown id names nothing. This is also a repeat *after* success: the row is gone.
    const row = findDecision(db, decisionId);
    if (row === null) throw new NotFoundError(`decision ${decisionId} not found`);

    // 2 — the shared predicate (§4.15 / §3.5). Everything §5.4 names as un-reversible is here, so the
    // 409 cannot drift from the `undoable` §4.13 reports for the same row.
    const refusal = undoRefusal(db, row, isoTimestamp());
    if (refusal !== null) {
      throw new ConflictError(
        `decision ${decisionId} is no longer reversible: ${REFUSAL_MESSAGE[refusal]}`,
      );
    }

    // The spark exists: `decision.spark_id` references `spark`, which is kept even when its ideas
    // dangle (T26). Its `pair_key` is what a DISMISS's negative signal was written with.
    const spark = db.prepare("SELECT pair_key FROM spark WHERE id = ?").get(row.spark_id) as {
      pair_key: string;
    };

    if (row.kind === "DISMISS") {
      // §5.4 "clear the negative signal" — the pair returns to the deck.
      clearSuppression(db, spark.pair_key);
    } else {
      // V5's delete semantics, in the caller's transaction: the idea and its own rows go (the cascade
      // takes the version, the mechanism cache and the provenance edges).
      db.prepare("DELETE FROM idea WHERE id = ?").run(row.result_idea_id);
      // A live offer built from the retracted idea is not history — retract it, as `deleteIdea` does.
      db.prepare(
        `DELETE FROM spark WHERE status = '${LIVE_STATUS}' AND (idea_a_id = ? OR idea_b_id = ?)`,
      ).run(row.result_idea_id, row.result_idea_id);
    }

    // §5.4's re-offer and the cleared resolution. The `decision` row gone is what retires the
    // resolution (the spark's own status is the only other side of it).
    db.prepare("UPDATE spark SET status = 'OFFERED' WHERE id = ?").run(row.spark_id);
    db.prepare("DELETE FROM decision WHERE id = ?").run(decisionId);

    return {
      undone: true,
      spark_id: row.spark_id,
      spark_status: "OFFERED",
      retracted_idea_id: row.kind === "DISMISS" ? null : row.result_idea_id,
    };
  });
}
