import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { isoTimestamp, vaultMutation } from "@astrolab/store";

import {
  ConflictError,
  NotFoundError,
  parseDomainTags,
  requiredText,
  requireObjectBody,
} from "./capture.js";
import { type Idea, type IdeaRow } from "./idea.js";

/**
 * Fork — `POST /v1/ideas/{id}/fork` (`docs/API.md` §4.7; `FLOW.md` T24/T25; `PRD.md` §3.2 item 2).
 *
 * A fork is a **new** node: it inserts one `idea` row with `lineage_kind = FORK` and
 * `lineage_parent_id = {id}`, and its own `idea_version` 1 — the same node, forever after. It writes
 * **no** `provenance_edge` row: provenance is a different relation from lineage (`FLOW.md` §2.3), and a
 * fork has no spark (`provenance_edge.spark_id` is NOT NULL).
 *
 * §4.7's request is two fields, so the fork's content has exactly one source — the parent, copied
 * verbatim. The mutation delta records what changed.
 */

/** docs/API.md §4.7 — the request, exactly the two fields the frozen contract carries. */
export interface ForkInput {
  mutation_delta: string;
  domain_tags: string[];
}

/**
 * §4.7's request: a non-empty `mutation_delta` (`422` when empty) and the fork's `domain_tags`,
 * validated as §4.2's rule. The text fields are **not** in the request — they come from the parent.
 */
export function parseForkInput(body: unknown): ForkInput {
  const raw = requireObjectBody(body);
  return { mutation_delta: requiredText(raw, "mutation_delta"), domain_tags: parseDomainTags(raw) };
}

/**
 * One fork, one transaction (docs/API.md §4.7): the `idea` row and its `idea_version` 1 commit
 * together, and `vaultMutation` supplies the ARCH §4 stamp + run rather than a call here — exactly as
 * capture (§4.2) and iterate (§4.6) do. The checks run **inside** the transaction and in the pinned
 * order `404` → `409`: an unknown id, or a same-domain fork, writes nothing and moves no revision.
 */
export function forkIdea(db: DatabaseSync, id: string, input: ForkInput): Idea {
  return vaultMutation(db, () => {
    const parent = db.prepare("SELECT * FROM idea WHERE id = ?").get(id) as IdeaRow | undefined;
    if (parent === undefined) throw new NotFoundError(`idea ${id} not found`);

    if (sameDomainSet(JSON.parse(parent.domain_tags) as string[], input.domain_tags)) {
      throw new ConflictError(`idea ${id} already carries this domain set — iterate instead`);
    }

    // The three text fields come from the parent in one binding: §4.7's two-field request has one
    // possible source for them, so a later four-field ruling is a contained diff right here.
    const content = {
      hypothesis: parent.hypothesis,
      problem: parent.problem,
      monetization: parent.monetization,
    };

    const now = isoTimestamp();
    const idea: Idea = {
      id: randomUUID(),
      ...content,
      domain_tags: input.domain_tags,
      lineage_kind: "FORK",
      lineage_parent_id: id,
      status: "ACTIVE",
      visibility: "PRIVATE",
      current_version: 1,
      created_at: now,
      updated_at: now,
    };
    const tags = JSON.stringify(idea.domain_tags);
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at,
                         mutation_delta)
       VALUES (?, ?, ?, ?, ?, 'FORK', ?, 'ACTIVE', 'PRIVATE', 1, ?, ?, ?)`,
    ).run(
      idea.id,
      idea.hypothesis,
      idea.problem,
      idea.monetization,
      tags,
      id,
      now,
      now,
      input.mutation_delta,
    );
    // The first version is this content (PRD §3.2 item 2) — written with the row, not after it.
    db.prepare(
      `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
       VALUES (?, 1, ?, ?, ?, ?, ?)`,
    ).run(idea.id, idea.hypothesis, idea.problem, idea.monetization, tags, now);
    return idea;
  });
}

/**
 * The §4.7 / T25 rule, as a **set** comparison: the fork's domain set must differ from the parent's, so
 * equality (in any order or with duplicates) is the `409`. A superset differs, and *widens* the vault —
 * the flywheel case, where `["health","compliance"]` forking `["health"]` is legal. The subset case
 * (`["health"]` forking `["health","compliance"]`) narrows and is *accepted* by the literal rule; it is
 * recorded as a known gap in §4.7, not implemented as `F ⊆ P` here.
 */
function sameDomainSet(a: string[], b: string[]): boolean {
  const first = new Set(a);
  const second = new Set(b);
  return first.size === second.size && [...first].every((tag) => second.has(tag));
}
