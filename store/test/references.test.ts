import type { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";

import { migrate, schemaVersion } from "../src/migrate.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/migrations.js";
import { openStore } from "../src/store.js";
import { insertIdea, insertPair, insertSpark, rows } from "./seed.js";

/**
 * V5 (#16) — `0003_reference_actions`: what each of the eight `REFERENCES idea(id)` constraints became,
 * and the delete semantics T26 needs on top of them (**the row's owner cascades, historical refs
 * dangle**).
 *
 * The structural half is `PRAGMA foreign_key_list`, because "the FK is gone" is exactly the kind of
 * claim a passing suite cannot make true by accident: it is asserted per column, and mutating the
 * migration back to a bare reference reddens it.
 */

const migrated = (): DatabaseSync => {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
};

/** `table.from:on_delete` for every foreign key on a table — the shape that makes a diff readable. */
const fks = (db: DatabaseSync, table: string): string[] =>
  rows(db, `PRAGMA foreign_key_list(${table})`)
    .map((r) => `${String(r.table)}.${String(r.from)}:${String(r.on_delete)}`)
    .sort();

const count = (db: DatabaseSync, sql: string): number => (db.prepare(sql).get() as { n: number }).n;

test("the schema version is 4 and the store migrates to it", () => {
  const db = migrated();
  expect(SCHEMA_VERSION).toBe(4);
  expect(schemaVersion(db)).toBe(4);
  // The rebuild runs with `PRAGMA foreign_keys = OFF`; enforcement must be back on afterwards, or a
  // connection left open would silently accept violations forever.
  expect(rows(db, "PRAGMA foreign_keys")[0]?.foreign_keys).toBe(1);
});

test("the row's owner cascades — the idea's own rows", () => {
  const db = migrated();
  expect(fks(db, "idea_version")).toEqual(["idea.idea_id:CASCADE"]);
  expect(fks(db, "idea_mechanism")).toEqual(["idea.idea_id:CASCADE"]);
  expect(fks(db, "provenance_edge")).toEqual(["idea.derived_idea_id:CASCADE"]);
});

test("historical refs dangle — the references that were dropped, per column", () => {
  const db = migrated();
  // `idea` had two: the self-reference on `lineage_parent_id`, and nothing else.
  expect(fks(db, "idea")).toEqual([]);
  // `provenance_edge` keeps exactly one of its two: the derived side cascades, the source side dangles.
  expect(fks(db, "provenance_edge")).not.toContainEqual(expect.stringContaining("source_idea_id"));
  // A spark's pair is history — a resolved spark keeps the ids of ideas that may be gone.
  expect(fks(db, "spark")).toEqual([]);
  // A decision keeps its result idea; it keeps the reference to its own spark.
  expect(fks(db, "decision")).toEqual(["spark.spark_id:NO ACTION"]);
});

test("ux_spark_live survives the rebuild as a partial unique index", () => {
  const db = migrated();
  // The rebuild drops the table, and the index with it. Recreating it is part of the migration, and
  // this is the assertion that would catch its loss.
  const index = rows(db, "PRAGMA index_list(spark)").find((r) => r.name === "ux_spark_live");
  expect(index?.unique).toBe(1);
  expect(index?.partial).toBe(1);

  insertPair(db);
  insertSpark(db, "s1");
  expect(() => insertSpark(db, "s2")).toThrow(/UNIQUE/);
});

test("a populated v2 store upgrades to the newest schema with every row intact", () => {
  const db = openStore(":memory:");
  // Apply only the first two, so this is a real upgrade path and not a fresh install.
  migrate(db, MIGRATIONS.slice(0, 2));
  expect(schemaVersion(db)).toBe(2);

  insertIdea(db, "root");
  insertIdea(db, "child", { lineageKind: "FORK", lineageParentId: "root" });
  db.exec(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES ('root', 1, 'h', 'p', 'm', '["x"]', 't')`,
  );
  db.exec(
    `INSERT INTO idea_mechanism (idea_id, descriptor, source_hash, extracted_at)
     VALUES ('root', '{}', 'hash', 't')`,
  );
  insertPair(db);
  db.exec(
    "INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES ('root','a','sp-1')",
  );
  insertSpark(db, "sp-1", "RESOLVED-ACCEPTED");
  db.exec(
    "INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at) VALUES ('dec','sp-1','ACCEPT','root','t')",
  );

  expect(migrate(db, MIGRATIONS)).toBe(SCHEMA_VERSION);
  for (const [table, expected] of [
    ["idea", 4],
    ["idea_version", 1],
    ["idea_mechanism", 1],
    ["provenance_edge", 1],
    ["spark", 1],
    ["decision", 1],
  ] as const) {
    expect(count(db, `SELECT COUNT(*) AS n FROM ${table}`), table).toBe(expected);
  }
  expect(rows(db, "SELECT lineage_parent_id AS p FROM idea WHERE id = 'child'")[0]?.p).toBe("root");
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});

test("deleting a provenance source leaves the edge dangling, and the derived idea alive", () => {
  const db = migrated();
  insertPair(db);
  insertIdea(db, "derived");
  db.exec(
    "INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES ('derived','a','sp-1')",
  );
  insertSpark(db, "sp-1", "RESOLVED-INSPIRED");

  // The row that could not be deleted at all before this migration: `idea_version` no longer blocks it.
  db.exec("DELETE FROM idea WHERE id = 'a'");

  expect(count(db, "SELECT COUNT(*) AS n FROM provenance_edge WHERE source_idea_id = 'a'")).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM idea WHERE id = 'derived'")).toBe(1);
  // T26: the spark stays resolved and is not re-offered; the pair keeps naming the deleted source.
  expect(count(db, "SELECT COUNT(*) AS n FROM spark WHERE status = 'RESOLVED-INSPIRED'")).toBe(1);
  expect(count(db, "SELECT COUNT(*) AS n FROM spark WHERE idea_a_id = 'a'")).toBe(1);
  // A dangling reference is *not* a violation — the constraint is gone, not broken.
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});

test("deleting a derived idea takes its provenance edges with it — the edge has no other owner", () => {
  const db = migrated();
  insertPair(db);
  insertIdea(db, "derived");
  db.exec(
    "INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES ('derived','a','sp-1')",
  );
  db.exec(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES ('derived', 1, 'h', 'p', 'm', '["x"]', 't')`,
  );
  db.exec(
    `INSERT INTO idea_mechanism (idea_id, descriptor, source_hash, extracted_at)
     VALUES ('derived', '{}', 'hash', 't')`,
  );

  db.exec("DELETE FROM idea WHERE id = 'derived'");

  expect(
    count(db, "SELECT COUNT(*) AS n FROM provenance_edge WHERE derived_idea_id = 'derived'"),
  ).toBe(0);
  expect(count(db, "SELECT COUNT(*) AS n FROM idea_version WHERE idea_id = 'derived'")).toBe(0);
  expect(count(db, "SELECT COUNT(*) AS n FROM idea_mechanism WHERE idea_id = 'derived'")).toBe(0);
  // The sources are untouched: cascading is one direction.
  expect(count(db, "SELECT COUNT(*) AS n FROM idea WHERE id IN ('a','b')")).toBe(2);
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});

test("deleting a fork parent leaves the child's parent reference dangling", () => {
  const db = migrated();
  insertIdea(db, "parent");
  insertIdea(db, "child", { lineageKind: "FORK", lineageParentId: "parent" });

  db.exec("DELETE FROM idea WHERE id = 'parent'");

  expect(rows(db, "SELECT lineage_parent_id AS p FROM idea WHERE id = 'child'")[0]?.p).toBe(
    "parent",
  );
  expect(count(db, "SELECT COUNT(*) AS n FROM idea WHERE id = 'child'")).toBe(1);
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});
