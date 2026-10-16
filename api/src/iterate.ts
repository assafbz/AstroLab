import type { DatabaseSync } from "node:sqlite";

import { isoTimestamp, newDomainFlag, vaultMutation } from "@astrolab/store";

import { NotFoundError, derivedStatus, type IdeaFields } from "./capture.js";
import { toIdea, type Idea, type IdeaRow } from "./idea.js";

/**
 * Iterate — `POST /v1/ideas/{id}/iterate` (`docs/API.md` §4.6; `FLOW.md` T23; `PRD.md` §3.2 item 1).
 *
 * An iteration is the **same node** with a new version: it appends one `idea_version` row, replaces the
 * four mandatory fields and bumps `current_version`, and creates **no** lineage edge and **no** new
 * `idea` row (`FLOW.md` §2.3, L1). `status` is **re-derived, not left stale** — supplying the four
 * mandatory fields *is* `FLOW.md` T27's completion path (K8), so the one predicate that mints the flag
 * (§4.13 ACCEPT's `derivedStatus`) clears it here, and the two paths cannot disagree.
 *
 * One transaction, and the ARCH §4 trigger comes from `vaultMutation` rather than a call here: the new
 * version, the node update and the revision stamp + enqueue commit together or not at all. An unknown
 * id throws **inside** the transaction, so a `404` writes nothing and moves no revision.
 */
export function iterateIdea(db: DatabaseSync, id: string, fields: IdeaFields): Idea {
  return vaultMutation(db, () => {
    const row = db.prepare("SELECT * FROM idea WHERE id = ?").get(id) as IdeaRow | undefined;
    if (row === undefined) throw new NotFoundError(`idea ${id} not found`);

    // Read and bump inside the transaction, so a BUSY retry cannot reuse a version number: the
    // transaction it re-runs re-reads `current_version`.
    const version = row.current_version + 1;
    const now = isoTimestamp();
    const tags = JSON.stringify(fields.domain_tags);
    // The §4.2 validator guarantees all four arrived, so this is always `ACTIVE` — but the status is
    // *derived* here, not hard-coded, so the mint (§4.13) and the clear stay one rule.
    const status = derivedStatus(fields);
    // The third write that can widen (§4.2 capture, §4.7 fork). Computed **before** the UPDATE on
    // purpose: the row's own current tags are part of the coverage being compared against — they are
    // exactly what the vault already carried — so a text-only re-save of the same domain reads `0`
    // rather than a false "new" whenever no other row shares it (`EV1` #43 / NFR-Q1).
    //
    // That `newDomain` is a fact about *this write*, and it is written **monotonically** below: a
    // recorded `1` is never cleared. Without the `CASE`, the recomputation — against a vault that now
    // includes the row itself — resets a row that widened at birth to `0` on any later write of its own
    // domain, a plain text edit included, and both month views drift down with use. NFR-Q1 reads an
    // event ("landed"), so the flag is the idea's widening *history*, not the latest write's answer.
    const newDomain = newDomainFlag(db, fields.domain_tags);

    db.prepare(
      `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, version, fields.hypothesis, fields.problem, fields.monetization, tags, now);

    db.prepare(
      `UPDATE idea SET hypothesis = ?, problem = ?, monetization = ?, domain_tags = ?,
                       status = ?, current_version = ?, updated_at = ?,
                       new_domain = CASE WHEN new_domain = 1 THEN 1 ELSE ? END
       WHERE id = ?`,
    ).run(
      fields.hypothesis,
      fields.problem,
      fields.monetization,
      tags,
      status,
      version,
      now,
      newDomain,
      id,
    );

    return toIdea({
      ...row,
      hypothesis: fields.hypothesis,
      problem: fields.problem,
      monetization: fields.monetization,
      domain_tags: tags,
      status,
      current_version: version,
      updated_at: now,
    });
  });
}
