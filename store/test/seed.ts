import type { DatabaseSync } from "node:sqlite";

/**
 * Row inserts shared by the schema and invariant tests: the shapes the write paths will produce
 * (`docs/SCHEMA.md`; `ARCHITECTURE.md` §2). Deliberately not a repository layer — F3 ships the
 * schema and its guards, not the write API (that is F4/K4).
 */

export interface IdeaOverrides {
  lineageKind?: string;
  lineageParentId?: string | null;
  status?: string;
  visibility?: string;
}

export function insertIdea(db: DatabaseSync, id: string, over: IdeaOverrides = {}): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', '["x"]', ?, ?, ?, ?, 1, 't', 't')`,
  ).run(
    id,
    over.lineageKind ?? "ROOT",
    over.lineageParentId ?? null,
    over.status ?? "ACTIVE",
    over.visibility ?? "PRIVATE",
  );
}

export function insertSpark(
  db: DatabaseSync,
  id: string,
  status = "OFFERED",
  pairKey = "a|b",
): void {
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES (?, 'a', 'b', ?, 'd', 'c', ?, 't')`,
  ).run(id, pairKey, status);
}

/** The two source ideas a spark's ids name (`0003` dropped the FKs, but this is still the shape the write paths produce). */
export function insertPair(db: DatabaseSync): void {
  insertIdea(db, "a");
  insertIdea(db, "b");
}

export function rows(db: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return db.prepare(sql).all() as Array<Record<string, unknown>>;
}
