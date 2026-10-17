import type { SqliteConnection } from "../store/connection.js";

import { ValidationError } from "./capture.js";
import { toIdea, type Idea, type IdeaRow } from "./idea.js";

/**
 * The vault **read** path (`docs/API.md` §4.4, §4.5): `GET /v1/ideas` and `GET /v1/ideas/{id}`.
 *
 * Two properties hold here and are tested, not assumed:
 * - **Provenance ≠ lineage.** `provenance` is its own array and never feeds `lineage` — a seeded idea
 *   has provenance and *no* lineage parent (`docs/API.md` §5 invariant 3).
 * - **The absent case is empty, never an error.** An idea with no provenance, no ancestors and no
 *   reverse references answers `200` with empty arrays (`docs/API.md` §4.5; the V2 ruling).
 *
 * No path here can reach the provider (`docs/ARCHITECTURE.md` §3.2, §4): both endpoints are reads.
 */

/** `GET /v1/ideas` filters (`docs/API.md` §4.4). `null` = the contract's "no restriction". */
export interface VaultFilters {
  domain: string | null;
  lineage: Idea["lineage_kind"] | null;
  status: Idea["status"] | null;
}

/** docs/API.md §3.1 — the enums, as the contract spells them. */
const LINEAGE_KINDS = ["ROOT", "FORK"] as const;
const STATUSES = ["ACTIVE", "NEEDS_COMPLETION"] as const;

/** One `idea_version` row under the same node (`docs/API.md` §4.5). */
export interface IdeaVersion {
  version: number;
  hypothesis: string;
  problem: string;
  monetization: string;
  domain_tags: string[];
  created_at: string;
}

/** docs/API.md §4.5 — muted provenance metadata. `source_idea_id` is never an ancestor. */
export interface ProvenanceRef {
  source_idea_id: string;
  spark_id: string;
}

export interface IdeaDetail {
  idea: Idea;
  versions: IdeaVersion[];
  /** The single-parent ancestor chain, root-first, excluding the node itself; `[]` for a `ROOT`. */
  lineage: Idea[];
  provenance: ProvenanceRef[];
  referenced_by: { forks: string[]; derived: string[] };
}

/**
 * `docs/API.md` §4.4 + §1. An absent key means no restriction; a key that is present with an empty
 * value, or with a value outside its enum, is `422 validation_failed` — the contract's "unknown enum
 * value" rule, applied to the filters' own vocabulary. **Unknown parameter names are ignored** (§1)
 * and a repeated key takes its first occurrence, both as recorded in §6.
 */
export function parseVaultFilters(query: URLSearchParams): VaultFilters {
  return {
    domain: optionalText(query, "domain"),
    lineage: optionalEnum(query, "lineage", LINEAGE_KINDS),
    status: optionalEnum(query, "status", STATUSES),
  };
}

/**
 * `docs/API.md` §4.4. One query, filters AND-composed, ordered `created_at DESC, id DESC` (§6) — the
 * `id` tiebreak because `isoTimestamp` truncates to the second, so two ideas really can share one.
 *
 * The `domain` filter matches the tag **exactly**: `json_each` walks the stored JSON array, so `fin`
 * does not match `fintech` the way a `LIKE` would.
 */
export function listIdeas(db: SqliteConnection, filters: VaultFilters): Idea[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filters.lineage !== null) {
    where.push("lineage_kind = ?");
    params.push(filters.lineage);
  }
  if (filters.status !== null) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.domain !== null) {
    where.push("EXISTS (SELECT 1 FROM json_each(idea.domain_tags) AS j WHERE j.value = ?)");
    params.push(filters.domain);
  }
  const sql = `SELECT * FROM idea ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC, id DESC`;
  // `node:sqlite` types `.all()` as rows of `SQLOutputValue`; the select above fixes the shape, so this
  // is a narrowing, not a guess — `as unknown as` is the cast that does not require an index signature.
  return (db.prepare(sql).all(...params) as unknown as IdeaRow[]).map(toIdea);
}

/** `docs/API.md` §4.5, or `null` for an unknown id — the caller answers the `not_found` envelope. */
export function getIdeaDetail(db: SqliteConnection, id: string): IdeaDetail | null {
  return readSnapshot(db, () => {
    const row = db.prepare("SELECT * FROM idea WHERE id = ?").get(id) as IdeaRow | undefined;
    if (row === undefined) return null;
    return {
      idea: toIdea(row),
      versions: versionsOf(db, id),
      lineage: ancestorChain(db, row),
      provenance: provenanceOf(db, id),
      referenced_by: { forks: forksOf(db, id), derived: derivedOf(db, id) },
    };
  });
}

/**
 * One read, one snapshot. Under WAL each statement otherwise takes its own, so five of them can
 * straddle a commit and ship a `versions` list that `idea.current_version` disagrees with (V2 ruling).
 * A deferred read holds no write lock, so this costs writers nothing.
 */
export function readSnapshot<T>(db: SqliteConnection, read: () => T): T {
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

/** Ascending, and **every** version including the current one — the editor's own values are history too. */
function versionsOf(db: SqliteConnection, id: string): IdeaVersion[] {
  const rows = db
    .prepare(
      `SELECT version, hypothesis, problem, monetization, domain_tags, created_at
       FROM idea_version WHERE idea_id = ? ORDER BY version`,
    )
    .all(id) as Array<Omit<IdeaVersion, "domain_tags"> & { domain_tags: string }>;
  return rows.map((row) => ({ ...row, domain_tags: JSON.parse(row.domain_tags) as string[] }));
}

/**
 * Walks `lineage_parent_id` to the root, then reverses: `docs/API.md` §4.5's chain reads root-first,
 * and the node itself is the `idea` field, not a member. A parent that no longer exists is a
 * **dangling ref the contract tolerates** (§4.8: a deleted fork child keeps its `lineage_parent_id`),
 * so the walk stops rather than failing — and the `seen` set stops a cycle rather than looping.
 */
function ancestorChain(db: SqliteConnection, row: IdeaRow): Idea[] {
  const chain: Idea[] = [];
  const seen = new Set<string>([row.id]);
  let parent = row.lineage_parent_id;
  while (parent !== null && !seen.has(parent)) {
    seen.add(parent);
    const ancestor = db.prepare("SELECT * FROM idea WHERE id = ?").get(parent) as
      IdeaRow | undefined;
    if (ancestor === undefined) break;
    chain.push(toIdea(ancestor));
    parent = ancestor.lineage_parent_id;
  }
  return chain.reverse();
}

/** Sorted, because a restore need not preserve insertion order (V2 ruling) — and the PK can tie on the id. */
function provenanceOf(db: SqliteConnection, id: string): ProvenanceRef[] {
  return db
    .prepare(
      `SELECT source_idea_id, spark_id FROM provenance_edge WHERE derived_idea_id = ?
       ORDER BY source_idea_id, spark_id`,
    )
    .all(id) as unknown as ProvenanceRef[];
}

/** `referenced_by` supplies the T26 delete warning (`docs/API.md` §4.5); never used to block a delete. */
function forksOf(db: SqliteConnection, id: string): string[] {
  const rows = db
    .prepare("SELECT id FROM idea WHERE lineage_parent_id = ? ORDER BY id")
    .all(id) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function derivedOf(db: SqliteConnection, id: string): string[] {
  const rows = db
    .prepare(
      "SELECT derived_idea_id FROM provenance_edge WHERE source_idea_id = ? ORDER BY derived_idea_id",
    )
    .all(id) as Array<{ derived_idea_id: string }>;
  return rows.map((row) => row.derived_idea_id);
}

function optionalText(query: URLSearchParams, key: string): string | null {
  if (!query.has(key)) return null;
  const value = query.get(key) ?? "";
  if (value === "") throw new ValidationError(`${key} must not be empty when present`);
  return value;
}

function optionalEnum<T extends string>(
  query: URLSearchParams,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = optionalText(query, key);
  if (value === null) return null;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
