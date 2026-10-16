import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { isoTimestamp, LIVE_STATUS, vaultMutation } from "@astrolab/store";

import { toIdea, type Idea, type IdeaRow } from "./idea.js";

// The UTC shape lives in the store, because the run rows need the same one; re-exported here so
// this module stays the API-side name for it.
export { isoTimestamp };
// Likewise the §3.1 `Idea` shape, which now lives in `./idea.js` shared with the read path.
export type { Idea };

/**
 * Capture — `POST /v1/ideas` (docs/API.md §4.2). The one write path V1 (#12) implements: a **blank**
 * capture (a plain ROOT idea) or a **seeded** capture from a spark (ROOT idea + provenance edges +
 * an `INSPIRED` decision, in one transaction). The HTTP layer owns the envelope; this module owns
 * the write.
 */

/** docs/API.md §4.2 — the server-side limit; the client's counter is not trusted. */
export const MAX_HYPOTHESIS_LENGTH = 280;

/**
 * The four mandatory fields every idea write carries (`docs/API.md` §2's mandatory set). Shared by
 * capture and iterate, so "validation as §4.2" has **one** implementation.
 */
export interface IdeaFields {
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
}

/**
 * `FLOW.md` §4.3 step 4 / T27, executed rather than hard-coded: an idea is `ACTIVE` only when every
 * mandatory field arrived, and `NEEDS_COMPLETION` otherwise. **One predicate owns the status**, so the
 * two paths that touch it cannot disagree — §4.13's ACCEPT **mints** it from a spark's prefill, and
 * §4.6's iterate **clears** it by the same call. Today a spark carries no `monetization`, so every
 * ACCEPT lands `NEEDS_COMPLETION`; a validated iterate request always carries all four (§4.2's `422`),
 * so it always lands `ACTIVE`. Assert the ACCEPT side (`decision.test.ts`) and adding a prefill
 * reddens it rather than silently changing what the vault holds.
 */
export function derivedStatus(fields: IdeaFields): "ACTIVE" | "NEEDS_COMPLETION" {
  const supplied =
    fields.hypothesis.trim() !== "" &&
    fields.problem.trim() !== "" &&
    fields.monetization.trim() !== "" &&
    fields.domain_tags.length > 0;
  return supplied ? "ACTIVE" : "NEEDS_COMPLETION";
}

/**
 * The fields §4.2 accepts. `origin_spark_id`/`decision_id` are **both-or-neither**: both null is a
 * blank capture, both set is a seeded one (`parseCaptureInput` rejects exactly one).
 */
export interface CaptureInput extends IdeaFields {
  origin_spark_id: string | null;
  decision_id: string | null;
}

/** A request the contract rejects before any write (`422 validation_failed`). */
export class ValidationError extends Error {}

/** A referenced row the contract has no code for except `not_found` (`404`). */
export class NotFoundError extends Error {}

/**
 * A request the contract refuses on state rather than shape (`409 conflict`, `docs/API.md` §2): a
 * same-domain fork, which offers **Iterate** instead (§4.7), and — since `#39` — a seeded save whose
 * `decision_id` is committed to another spark or whose spark is no longer `OFFERED` (§4.2). Thrown
 * inside the transaction, as `NotFoundError` is, so the rollback is free.
 */
export class ConflictError extends Error {}

/**
 * docs/API.md §4.2 — "hypothesis ≤ 280 and all of hypothesis, problem, monetization, and ≥ 1
 * domain_tags non-empty → else 422". Pure input validation, so it runs before any transaction; the
 * iterate path (`docs/API.md` §4.6, "validation as §4.2") calls this same function.
 */
export function parseIdeaFields(body: unknown): IdeaFields {
  const raw = requireObjectBody(body);

  const hypothesis = requiredText(raw, "hypothesis");
  if (hypothesis.length > MAX_HYPOTHESIS_LENGTH) {
    throw new ValidationError(`hypothesis exceeds ${MAX_HYPOTHESIS_LENGTH} characters`);
  }

  return {
    hypothesis,
    problem: requiredText(raw, "problem"),
    monetization: requiredText(raw, "monetization"),
    domain_tags: parseDomainTags(raw),
  };
}

/**
 * §4.2's spark pair, on top of the mandatory fields: `origin_spark_id` and `decision_id` are
 * **both-or-neither** — a seeded save needs the idempotency key (`decision_id`) *and* the spark the
 * provenance edges point at; accepting one and ignoring it would drop provenance silently.
 */
export function parseCaptureInput(body: unknown): CaptureInput {
  const fields = parseIdeaFields(body);
  const raw = body as Record<string, unknown>;

  const origin_spark_id = optionalId(raw, "origin_spark_id");
  const decision_id = optionalId(raw, "decision_id");
  if ((origin_spark_id === null) !== (decision_id === null)) {
    throw new ValidationError("origin_spark_id and decision_id must be provided together");
  }

  return { ...fields, origin_spark_id, decision_id };
}

/**
 * One capture, one transaction (docs/API.md §4.2): the idea, its first version, and — when seeded —
 * the provenance edges and the `INSPIRED` decision all land together or not at all. The stamp and the
 * run come from `vaultMutation` (@astrolab/store) rather than a call here, so the ARCH §4 trigger
 * cannot be forgotten by this path — or by the iterate / fork / delete / complete paths that follow.
 *
 * **Idempotent on `decision_id`**: a repeat returns the first result and writes nothing — not even
 * a revision bump. The lookup runs before any write, inside the transaction that would write.
 *
 * ## The seeded save's check order (`#39`) — §4.13's, on this key
 *
 * | # | condition | answer |
 * | :-- | :-- | :-- |
 * | 0 | a malformed body — the HTTP layer's `parseCaptureInput` | `422` |
 * | 1 | a recorded decision for this `decision_id`, **this** spark | `201`, the first `Idea` |
 * | 2 | an unknown `origin_spark_id` | `404` §2 envelope |
 * | 3 | a recorded decision for this `decision_id`, a **different** spark | `409` |
 * | 4 | a spark that is not `OFFERED` | `409` |
 *
 * Steps 0→2→3→4 are the §4.2/§4.6/§4.7 order (`422 → 404 → 409`); step 1 is hoisted above them all
 * for §4.13's reason — a committed save leaves its spark `RESOLVED-INSPIRED`, so a state check ahead
 * of the repeat would `409` a legal retry. The two `409` arms are §4.13's, on the same
 * `decision_id` key: the key is **global**, so one client id must not silently alias two saves
 * (which `captureIdea` did until #39 — it returned the first idea whatever spark was asked for), and
 * only a **live offer** may be resolved — the duplicate path `FLOW.md` H5 closes. Every state check
 * runs **inside** the transaction, so a refused save writes nothing.
 *
 * The engine is never called here (NFR-P1 / NFR-A1): the mutation commits and returns; the worker
 * picks the run up out of band.
 */
export function captureIdea(db: DatabaseSync, input: CaptureInput): Idea {
  return vaultMutation(db, () => {
    const { origin_spark_id: sparkId, decision_id: decisionId } = input;

    if (sparkId !== null && decisionId !== null) {
      const prior = findDecision(db, decisionId);

      // 1 — the retry of a committed save. A recorded key for **this** spark answers the first idea
      // untouched; the spark's own status is irrelevant here, exactly as at §4.13.
      if (prior !== null && prior.spark_id === sparkId) {
        const existing = prior.result_idea_id === null ? null : findIdea(db, prior.result_idea_id);
        if (existing === null) {
          throw new Error(`decision ${decisionId} exists without a result idea`);
        }
        return existing;
      }

      // 2 — §2: an unknown spark is `not_found` — the id is consulted **before** the key's cross-spark
      // conflict, §4.13's `422 → 404 → 409` order.
      const spark = findSpark(db, sparkId);
      if (spark === null) {
        // Thrown inside the transaction, so the `NotFoundError` rolls back anything already written.
        throw new NotFoundError(`spark ${sparkId} not found`);
      }

      // 3 — the key is committed to a **different** spark. One client id must not silently alias two
      // saves; answering the first idea would resolve the wrong card's provenance (§4.13's rule 3).
      if (prior !== null) {
        throw new ConflictError(
          `decision_id ${decisionId} is already recorded for spark ${prior.spark_id}`,
        );
      }

      // 4 — only a live offer may be seeded (`ARCHITECTURE.md` §3.5; `FLOW.md` §4.3): a spark already
      // resolved by some *other* key is not re-savable — the duplicate-idea path H5 closes.
      if (spark.status !== LIVE_STATUS) {
        throw new ConflictError(`spark ${sparkId} is ${spark.status}`);
      }

      const idea = insertIdea(db, input);
      insertProvenance(db, idea.id, spark.idea_a_id, spark.id);
      insertProvenance(db, idea.id, spark.idea_b_id, spark.id);
      db.prepare(
        `INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at)
         VALUES (?, ?, 'INSPIRED', ?, ?)`,
      ).run(decisionId, spark.id, idea.id, idea.created_at);
      db.prepare("UPDATE spark SET status = 'RESOLVED-INSPIRED' WHERE id = ?").run(spark.id);
      return idea;
    }

    const idea = insertIdea(db, input);
    return idea;
  });
}

/** The one body-shape rule, shared by every parser (§4.2, §4.6, §4.7): a JSON object, not a bare value. */
export function requireObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** A mandatory non-empty text field (§4.2's rule), shared so a field's message is written once. */
export function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} is required`);
  }
  return value;
}

/** §4.2's `domain_tags` rule: at least one, each a non-empty string, trimmed — shared with §4.6 and §4.7. */
export function parseDomainTags(body: Record<string, unknown>): string[] {
  const value = body["domain_tags"];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("at least one domain tag is required");
  }
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string" || tag.trim() === "") {
      throw new ValidationError("domain_tags must be non-empty strings");
    }
    tags.push(tag.trim());
  }
  return tags;
}

function optionalId(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} must be a non-empty string or null`);
  }
  return value;
}

interface SparkRow {
  id: string;
  idea_a_id: string;
  idea_b_id: string;
  /** The row's state — read so steps 3–4 can tell a live offer from a resolved one (`#39`). */
  status: string;
}

interface DecisionRow {
  id: string;
  /** The spark the key resolved — read so a repeat is told from a cross-spark alias (`#39`). */
  spark_id: string;
  result_idea_id: string | null;
}

function insertIdea(db: DatabaseSync, input: IdeaFields): Idea {
  return insertRootIdea(db, input, "ACTIVE", isoTimestamp());
}

/**
 * A ROOT idea and its first version, in the caller's transaction (`PRD.md` §3.2, §4.2). Shared by the
 * **blank** capture and the **seeded** one, and by §4.13's ACCEPT (`api/src/decision.ts`) — the three
 * paths that create a node — so "the first version is this content" is written once rather than
 * restated per caller. The status is the caller's: a capture's is `ACTIVE`, and an ACCEPT computes its
 * own from what the spark could prefill (`FLOW.md` §4.3 step 4 / T27).
 */
export function insertRootIdea(
  db: DatabaseSync,
  fields: IdeaFields,
  status: Idea["status"],
  now: string,
): Idea {
  const idea: Idea = {
    id: randomUUID(),
    hypothesis: fields.hypothesis,
    problem: fields.problem,
    monetization: fields.monetization,
    domain_tags: fields.domain_tags,
    lineage_kind: "ROOT",
    lineage_parent_id: null,
    status,
    visibility: "PRIVATE",
    current_version: 1,
    created_at: now,
    updated_at: now,
  };
  const tags = JSON.stringify(idea.domain_tags);
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, ?, 'PRIVATE', 1, ?, ?)`,
  ).run(idea.id, idea.hypothesis, idea.problem, idea.monetization, tags, idea.status, now, now);
  // The first version is this content (PRD §3.2) — written with the row, not after it.
  db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
  ).run(idea.id, idea.hypothesis, idea.problem, idea.monetization, tags, now);
  return idea;
}

/** One provenance edge, in the caller's transaction (`FLOW.md` §4.3; §4.2 seeded, §4.13 ACCEPT). */
export function insertProvenance(
  db: DatabaseSync,
  derivedIdeaId: string,
  sourceIdeaId: string,
  sparkId: string,
): void {
  db.prepare(
    `INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES (?, ?, ?)`,
  ).run(derivedIdeaId, sourceIdeaId, sparkId);
}

function findIdea(db: DatabaseSync, id: string): Idea | null {
  const row = db.prepare("SELECT * FROM idea WHERE id = ?").get(id) as IdeaRow | undefined;
  return row === undefined ? null : toIdea(row);
}

function findSpark(db: DatabaseSync, id: string): SparkRow | null {
  const row = db
    .prepare("SELECT id, idea_a_id, idea_b_id, status FROM spark WHERE id = ?")
    .get(id) as SparkRow | undefined;
  return row ?? null;
}

function findDecision(db: DatabaseSync, id: string): DecisionRow | null {
  const row = db
    .prepare("SELECT id, spark_id, result_idea_id FROM decision WHERE id = ?")
    .get(id) as DecisionRow | undefined;
  return row ?? null;
}
