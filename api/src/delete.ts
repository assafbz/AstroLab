import type { DatabaseSync } from "node:sqlite";

import { vaultMutation } from "@astrolab/store";

/**
 * Delete — `DELETE /v1/ideas/{id}` (`docs/API.md` §4.8; `FLOW.md` T26 / M3).
 *
 * **Orphan-with-warning.** The server never blocks a delete and never asks for confirmation: §4.5's
 * `referenced_by` is what the *client* shows, and the delete proceeds either way. It also never
 * **un-resolves** anything — a derived idea's spark stays `RESOLVED-*`, is not re-offered, and its
 * `decision` row keeps its now-dangling `result_idea_id` (`FLOW.md` §5.4's permanence point).
 *
 * What a delete *does* clean up is what cannot outlive its idea: the idea's own history (its
 * `idea_version` rows, its descriptor-cache row, and — because the edge belongs to its derived idea —
 * its provenance edges) and the **live offers** built from it. What it deliberately leaves is every
 * *historical* reference: a fork child's `lineage_parent_id`, a resolved spark's pair, and a
 * decision's `result_idea_id`. `0003_reference_actions` drops exactly those constraints so the refs
 * may dangle, which T26 tolerates; V2's read path already stops on them rather than failing.
 *
 * Writes `spark` too, on purpose: the worker *creates* sparks, the API *resolves* them — the same
 * split §4.13's ACCEPT/DISMISS take.
 */
export function deleteIdea(db: DatabaseSync, id: string): boolean {
  return vaultMutation(db, () => {
    // §4's trigger: a delete is candidate-affecting, so the revision stamps and a run enqueues in
    // this same transaction. An unknown id writes nothing, so nothing stamps — a `404` must not churn
    // the vault. The idea's own rows go with it by `ON DELETE CASCADE` (`0003`), so that rule lives in
    // the schema rather than in this function.
    const removed = db.prepare("DELETE FROM idea WHERE id = ?").run(id).changes > 0;
    if (!removed) return false;

    // A **live** offer is not history: it is a promise made from the vault's current state, and the
    // state just changed. A resolved spark is history and keeps its (now dangling) pair.
    //
    // The `status` filter is what confines this: `decision.spark_id` still references `spark`, and a
    // decision moves its spark out of `OFFERED` — so a decision can never name the row this deletes.
    // That is an invariant of the writers, asserted in the tests rather than assumed here.
    db.prepare(
      `DELETE FROM spark WHERE status = 'OFFERED' AND (idea_a_id = ? OR idea_b_id = ?)`,
    ).run(id, id);
    return true;
  });
}
