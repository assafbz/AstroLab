import type { DatabaseSync } from "node:sqlite";

import { SCHEMA_VERSION, isoTimestamp } from "@astrolab/store";

import type { Idea, IdeaRow } from "./idea.js";

/**
 * The export — `GET /v1/export` (`docs/API.md` §4.17; `docs/ARCHITECTURE.md` §8; NFR-D1).
 *
 * The whole vault in one self-describing JSON document: the contract's **eight** keys, in the order
 * §4.17 lists them. The read is **read-only** over F3's tables and takes **one deferred snapshot**
 * (`BEGIN`…`COMMIT`), so `exported_at` and the seven arrays are a single vault state — a writer
 * committing mid-read cannot make the document disagree with itself (§4.5's `readSnapshot`, the same
 * reason V2 needed it).
 *
 * `decisions[]` is empty until the decision writer lands (K4 `#38`): that is the correct export of a
 * vault with no decisions, not a stub. The round-trip test is **EV5 `#47`**, a different issue —
 * nothing here claims a round-trip.
 *
 * `ARCHITECTURE.md` §8 fixes the eight **keys**, not their types, so the shapes below are the plan's
 * calls, recorded rather than invented silently:
 * - `ideas[]` is the **full row**, `mutation_delta` included (`null` for a ROOT, per the schema's
 *   column CHECK) — export is the backup path, so nothing the vault holds is dropped. The §3.1
 *   `Idea` resource deliberately omits it, so this module does not reuse `toIdea` to build the row.
 * - `lineage_edges[]` is one edge per idea that has a lineage parent (`idea.lineage_parent_id`).
 * - `domain_tags[]` is the domain vocabulary of record: one `{tag, cluster_id}` per `domain_map` row
 *   (`domain_cluster`'s names and `adjacency` are not among the frozen eight).
 */

/** §3.1's `Idea` plus the row-only `mutation_delta` (`0005`, V4 `#15`) — the backup-complete row. */
export interface ExportedIdea extends Idea {
  mutation_delta: string | null;
}

/** One `idea_version` row, `domain_tags` as the array the idea carries. */
export interface ExportedIdeaVersion {
  idea_id: string;
  version: number;
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
  created_at: string;
}

/** A single-parent lineage edge (`ARCHITECTURE.md` §2.2) — one per FORK, derived from the idea row. */
export interface LineageEdge {
  idea_id: string;
  parent_idea_id: string;
}

/** A provenance edge (`ARCHITECTURE.md` §2.2) — a seeded or accepted idea's two sources. */
export interface ProvenanceEdge {
  derived_idea_id: string;
  source_idea_id: string;
  spark_id: string;
}

/** One `decision` row (`ARCHITECTURE.md` §2.3); the PK is the client's `decision_id`. */
export interface ExportedDecision {
  decision_id: string;
  spark_id: string;
  kind: "ACCEPT" | "DISMISS" | "INSPIRED";
  result_idea_id: string | null;
  decided_at: string;
}

/** One `domain_map` row — the vocabulary of record (`docs/API.md` §4.17). */
export interface DomainTag {
  tag: string;
  cluster_id: string;
}

/** `docs/API.md` §4.17 — the document, eight keys, in the contract's order. */
export interface ExportDocument {
  schema_version: number;
  exported_at: string;
  ideas: ExportedIdea[];
  idea_versions: ExportedIdeaVersion[];
  lineage_edges: LineageEdge[];
  provenance_edges: ProvenanceEdge[];
  decisions: ExportedDecision[];
  domain_tags: DomainTag[];
}

export function exportVault(db: DatabaseSync): ExportDocument {
  return readSnapshot(db, () => ({
    // The **live** constant, never a literal (§4.17's example is stale — it shows `"1"` while the
    // store is at `SCHEMA_VERSION`; the string/number mismatch is corrected in this PR).
    schema_version: SCHEMA_VERSION,
    exported_at: isoTimestamp(),
    ideas: ideas(db),
    idea_versions: ideaVersions(db),
    lineage_edges: lineageEdges(db),
    provenance_edges: provenanceEdges(db),
    decisions: decisions(db),
    domain_tags: domainTags(db),
  }));
}

/**
 * One read, one snapshot — the V2 precedent (`ideas.ts`). A deferred `BEGIN` holds no write lock, so
 * the export costs concurrent writers nothing; the alternative is that the seven `SELECT`s straddle a
 * commit and ship a document from two vault states.
 */
function readSnapshot<T>(db: DatabaseSync, read: () => T): T {
  db.exec("BEGIN");
  try {
    const result = read();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Every idea, full row. Ordered by `id` — a restore need not preserve insertion order (the V2 ruling
 * for `provenance_edge`), and an id is the one key that is unique across a restore.
 */
function ideas(db: DatabaseSync): ExportedIdea[] {
  const rows = db
    .prepare(
      `SELECT id, hypothesis, problem, monetization, domain_tags, lineage_kind, lineage_parent_id,
              status, visibility, current_version, created_at, updated_at, mutation_delta
         FROM idea ORDER BY id`,
    )
    .all() as unknown as Array<
    Omit<IdeaRow, "domain_tags"> & { domain_tags: string; mutation_delta: string | null }
  >;
  return rows.map((row) => ({
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
    // A ROOT's `mutation_delta` is `null` by the schema CHECK, so the column is the whole answer.
    mutation_delta: row.mutation_delta,
  }));
}

/** Every version row, ordered by (idea, version) — deterministic, so two exports of one vault match. */
function ideaVersions(db: DatabaseSync): ExportedIdeaVersion[] {
  const rows = db
    .prepare(
      `SELECT idea_id, version, hypothesis, problem, monetization, domain_tags, created_at
         FROM idea_version ORDER BY idea_id, version`,
    )
    .all() as unknown as Array<Omit<ExportedIdeaVersion, "domain_tags"> & { domain_tags: string }>;
  return rows.map((row) => ({ ...row, domain_tags: JSON.parse(row.domain_tags) as string[] }));
}

/** One edge per FORK. Derived from the idea row — the edge *is* `idea.lineage_parent_id`. */
function lineageEdges(db: DatabaseSync): LineageEdge[] {
  return db
    .prepare(
      `SELECT id AS idea_id, lineage_parent_id AS parent_idea_id
         FROM idea WHERE lineage_parent_id IS NOT NULL ORDER BY id`,
    )
    .all() as unknown as LineageEdge[];
}

/** Every provenance edge (`ARCHITECTURE.md` §2.2), ordered as `ideas.ts` reads them. */
function provenanceEdges(db: DatabaseSync): ProvenanceEdge[] {
  return db
    .prepare(
      `SELECT derived_idea_id, source_idea_id, spark_id FROM provenance_edge
       ORDER BY derived_idea_id, source_idea_id, spark_id`,
    )
    .all() as unknown as ProvenanceEdge[];
}

/** Every `decision` row — empty until K4 `#38` ships the writer; correct, not a stub. */
function decisions(db: DatabaseSync): ExportedDecision[] {
  return db
    .prepare(
      `SELECT id AS decision_id, spark_id, kind, result_idea_id, decided_at
         FROM decision ORDER BY decided_at, id`,
    )
    .all() as unknown as ExportedDecision[];
}

/** The vocabulary of record. The contract's name for the key is `domain_tags`, not `domain_map`. */
function domainTags(db: DatabaseSync): DomainTag[] {
  return db
    .prepare("SELECT tag, cluster_id FROM domain_map ORDER BY tag")
    .all() as unknown as DomainTag[];
}
