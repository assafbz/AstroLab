import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { isoTimestamp, writeTransaction } from "@astrolab/store";

// The UTC shape lives in the store, because the run rows need the same one; re-exported here so
// this module stays the API-side name for it.
export { isoTimestamp };

/**
 * Capture — `POST /v1/ideas` (docs/API.md §4.2). The one write path V1 (#12) implements: a **blank**
 * capture (a plain ROOT idea) or a **seeded** capture from a spark (ROOT idea + provenance edges +
 * an `INSPIRED` decision, in one transaction). The HTTP layer owns the envelope; this module owns
 * the write.
 */

/** docs/API.md §4.2 — the server-side limit; the client's counter is not trusted. */
export const MAX_HYPOTHESIS_LENGTH = 280;

/**
 * The fields §4.2 accepts. `origin_spark_id`/`decision_id` are **both-or-neither**: both null is a
 * blank capture, both set is a seeded one (`parseCaptureInput` rejects exactly one).
 */
export interface CaptureInput {
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
  origin_spark_id: string | null;
  decision_id: string | null;
}

/** docs/API.md §3.1 — the response body of a capture. */
export interface Idea {
  id: string;
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
  lineage_kind: "ROOT" | "ITERATION" | "FORK";
  lineage_parent_id: string | null;
  status: "ACTIVE" | "NEEDS_COMPLETION";
  visibility: "PRIVATE";
  current_version: number;
  created_at: string;
  updated_at: string;
}

/** A request the contract rejects before any write (`422 validation_failed`). */
export class ValidationError extends Error {}

/** A referenced row the contract has no code for except `not_found` (`404`). */
export class NotFoundError extends Error {}

/**
 * docs/API.md §4.2 — "hypothesis ≤ 280 and all of hypothesis, problem, monetization, and ≥ 1
 * domain_tags non-empty → else 422". Runs before the transaction; it is pure input validation.
 */
export function parseCaptureInput(body: unknown): CaptureInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;

  const hypothesis = requiredText(raw, "hypothesis");
  if (hypothesis.length > MAX_HYPOTHESIS_LENGTH) {
    throw new ValidationError(`hypothesis exceeds ${MAX_HYPOTHESIS_LENGTH} characters`);
  }
  const problem = requiredText(raw, "problem");
  const monetization = requiredText(raw, "monetization");
  const domain_tags = requiredTags(raw);

  const origin_spark_id = optionalId(raw, "origin_spark_id");
  const decision_id = optionalId(raw, "decision_id");
  if ((origin_spark_id === null) !== (decision_id === null)) {
    // A seeded save needs both: `decision_id` is the idempotency key and the spark is what the
    // provenance edges point at. Accepting one and ignoring it would drop provenance silently.
    throw new ValidationError("origin_spark_id and decision_id must be provided together");
  }

  return { hypothesis, problem, monetization, domain_tags, origin_spark_id, decision_id };
}

/**
 * One capture, one transaction (docs/API.md §4.2): the idea, its first version, and — when seeded —
 * the provenance edges and the `INSPIRED` decision all land together or not at all. `vault_meta`
 * is bumped in the same transaction, so a candidate-affecting write can never go unstamped.
 *
 * **Idempotent on `decision_id`**: a repeat returns the first result and writes nothing — not even
 * a revision bump. The lookup runs before any write, inside the transaction that would write.
 */
export function captureIdea(db: DatabaseSync, input: CaptureInput): Idea {
  return writeTransaction(db, () => {
    const { origin_spark_id: sparkId, decision_id: decisionId } = input;

    if (sparkId !== null && decisionId !== null) {
      const prior = findDecision(db, decisionId);
      if (prior !== null) {
        const existing = prior.result_idea_id === null ? null : findIdea(db, prior.result_idea_id);
        if (existing === null) {
          throw new Error(`decision ${decisionId} exists without a result idea`);
        }
        return existing;
      }

      const spark = findSpark(db, sparkId);
      if (spark === null) {
        // Thrown inside the transaction, so the `NotFoundError` rolls back anything already written.
        throw new NotFoundError(`spark ${sparkId} not found`);
      }

      const idea = insertIdea(db, input);
      insertProvenance(db, idea.id, spark.idea_a_id, spark.id);
      insertProvenance(db, idea.id, spark.idea_b_id, spark.id);
      db.prepare(
        `INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at)
         VALUES (?, ?, 'INSPIRED', ?, ?)`,
      ).run(decisionId, spark.id, idea.id, idea.created_at);
      db.prepare("UPDATE spark SET status = 'RESOLVED-INSPIRED' WHERE id = ?").run(spark.id);
      bumpRevision(db);
      return idea;
    }

    const idea = insertIdea(db, input);
    bumpRevision(db);
    return idea;
  });
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} is required`);
  }
  return value;
}

function requiredTags(body: Record<string, unknown>): string[] {
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

interface IdeaRow {
  id: string;
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string;
  lineage_kind: Idea["lineage_kind"];
  lineage_parent_id: string | null;
  status: Idea["status"];
  visibility: Idea["visibility"];
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface SparkRow {
  id: string;
  idea_a_id: string;
  idea_b_id: string;
}

interface DecisionRow {
  id: string;
  result_idea_id: string | null;
}

function insertIdea(db: DatabaseSync, input: CaptureInput): Idea {
  const now = isoTimestamp();
  const idea: Idea = {
    id: randomUUID(),
    hypothesis: input.hypothesis,
    problem: input.problem,
    monetization: input.monetization,
    domain_tags: input.domain_tags,
    lineage_kind: "ROOT",
    lineage_parent_id: null,
    status: "ACTIVE",
    visibility: "PRIVATE",
    current_version: 1,
    created_at: now,
    updated_at: now,
  };
  const tags = JSON.stringify(idea.domain_tags);
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, ?, ?)`,
  ).run(idea.id, idea.hypothesis, idea.problem, idea.monetization, tags, now, now);
  // The first version is this content (PRD §3.2) — written with the row, not after it.
  db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
  ).run(idea.id, idea.hypothesis, idea.problem, idea.monetization, tags, now);
  return idea;
}

function insertProvenance(
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
  if (row === undefined) return null;
  return {
    id: row.id,
    hypothesis: row.hypothesis,
    problem: row.problem,
    monetization: row.monetization,
    domain_tags: JSON.parse(row.domain_tags) as string[],
    lineage_kind: row.lineage_kind,
    lineage_parent_id: row.lineage_parent_id,
    status: row.status,
    visibility: row.visibility,
    current_version: row.current_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function findSpark(db: DatabaseSync, id: string): SparkRow | null {
  const row = db.prepare("SELECT id, idea_a_id, idea_b_id FROM spark WHERE id = ?").get(id) as
    SparkRow | undefined;
  return row ?? null;
}

function findDecision(db: DatabaseSync, id: string): DecisionRow | null {
  const row = db.prepare("SELECT id, result_idea_id FROM decision WHERE id = ?").get(id) as
    DecisionRow | undefined;
  return row ?? null;
}

/**
 * docs/ARCHITECTURE.md §4 — every candidate-affecting mutation stamps the vault. The row is seeded
 * by `0002`; a miss means the vault has no counter at all, which must fail loudly rather than bump
 * nothing.
 */
function bumpRevision(db: DatabaseSync): void {
  const result = db.prepare("UPDATE vault_meta SET revision = revision + 1 WHERE id = 1").run();
  if (Number(result.changes) !== 1) {
    throw new Error("vault_meta singleton is missing");
  }
}
