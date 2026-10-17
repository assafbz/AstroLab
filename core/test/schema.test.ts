import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteConnection } from "../src/store/connection.js";
import { afterEach, expect, test } from "vitest";

import { migrate, schemaVersion } from "../src/store/migrate.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/store/migrations.js";
import { openNodeStore } from "../src/store/connection.node.js";
import { insertIdea, insertPair, insertSpark, rows } from "./seed.js";

/**
 * `0001_init` is the schema of record (docs/SCHEMA.md; ARCHITECTURE.md §2): twelve tables, the
 * partial unique index `ux_spark_live`, and the CHECK/FK guards. These tests pin that shape. The
 * invariants that need a write pattern — not a single-row constraint — are in invariants.test.ts.
 */

const TABLES = [
  "config",
  "decision",
  "domain_cluster",
  "domain_map",
  "idea",
  "idea_mechanism",
  "idea_version",
  "provenance_edge",
  "spark",
  "spark_run",
  "suppressed_pair",
  "vault_meta",
];

const COLUMNS: Record<string, string[]> = {
  idea: [
    "id",
    "hypothesis",
    "problem",
    "monetization",
    "domain_tags",
    "lineage_kind",
    "lineage_parent_id",
    "status",
    "visibility",
    "current_version",
    "created_at",
    "updated_at",
    "mutation_delta",
    "new_domain",
  ],
  idea_version: [
    "idea_id",
    "version",
    "hypothesis",
    "problem",
    "monetization",
    "domain_tags",
    "created_at",
  ],
  provenance_edge: ["derived_idea_id", "source_idea_id", "spark_id"],
  spark: [
    "id",
    "idea_a_id",
    "idea_b_id",
    "pair_key",
    "direction",
    "claim",
    "what_it_takes",
    "first_step",
    "mechanism",
    "domain_distance",
    "structural_alignment",
    "status",
    "created_at",
  ],
  idea_mechanism: ["idea_id", "descriptor", "source_hash", "extracted_at"],
  decision: ["id", "spark_id", "kind", "result_idea_id", "decided_at"],
  spark_run: ["id", "vault_revision", "status", "started_at", "finished_at", "error"],
  suppressed_pair: ["pair_key", "reason", "updated_at"],
  vault_meta: ["id", "revision"],
  config: ["key", "value"],
  domain_cluster: ["id", "name", "adjacency"],
  domain_map: ["tag", "cluster_id"],
};

const dirs: string[] = [];
const opened: SqliteConnection[] = [];

/** A fresh file store, opened but not yet migrated — file-backed, so FK enforcement is the real thing. */
function newStore(): SqliteConnection {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-schema-"));
  dirs.push(dir);
  const db = openNodeStore(join(dir, "astrolab.sqlite"));
  opened.push(db);
  return db;
}

/** A fresh file store with the shipped migrations applied. */
function migrated(): SqliteConnection {
  const db = newStore();
  migrate(db, MIGRATIONS);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("applies 0001_init: the schema version and the twelve tables of §2", () => {
  const db = migrated();
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);

  const names = rows(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((r) => String(r.name));
  expect(names).toEqual(TABLES);
});

test("every table carries the documented columns", () => {
  const db = migrated();
  for (const [table, expected] of Object.entries(COLUMNS)) {
    const actual = rows(db, `PRAGMA table_info(${table})`).map((r) => String(r.name));
    expect(actual.sort(), table).toEqual([...expected].sort());
  }
});

test("ux_spark_live is partial: one live offer per pair, not one offer ever", () => {
  const db = migrated();

  const index = rows(db, "PRAGMA index_list(spark)").find((r) => r.name === "ux_spark_live");
  expect(index?.unique).toBe(1);
  expect(index?.partial).toBe(1);
  const sql = rows(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_spark_live'",
  )[0]?.sql;
  expect(String(sql)).toContain("WHERE status = 'OFFERED'");

  insertPair(db);
  insertSpark(db, "s1");
  expect(() => insertSpark(db, "s2")).toThrow(/UNIQUE/);
  // The predicate is `status = 'OFFERED'`: once the pair resolves it is no longer live, so a
  // fresh offer for the same pair is allowed.
  db.exec("UPDATE spark SET status = 'RESOLVED-DISMISSED' WHERE id = 's1'");
  expect(() => insertSpark(db, "s3")).not.toThrow();
});

test("the store's connection enforces foreign keys", () => {
  const db = migrated();
  expect(rows(db, "PRAGMA foreign_keys")[0]?.foreign_keys).toBe(1);

  insertPair(db);
  insertSpark(db, "s1");
  const fk = /FOREIGN KEY/;
  expect(() =>
    db.exec(
      `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
       VALUES ('ghost', 1, 'h', 'p', 'm', '["x"]', 't')`,
    ),
  ).toThrow(fk);
  expect(() =>
    db.exec(
      "INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES ('ghost','a','s1')",
    ),
  ).toThrow(fk);
  expect(() =>
    db.exec(
      "INSERT INTO decision (id, spark_id, kind, decided_at) VALUES ('d1','ghost','DISMISS','t')",
    ),
  ).toThrow(fk);
  expect(() => db.exec("INSERT INTO domain_map (tag, cluster_id) VALUES ('x','ghost')")).toThrow(
    fk,
  );
});

test("only a FORK may carry a lineage parent", () => {
  const db = migrated();
  insertIdea(db, "root");
  expect(() =>
    insertIdea(db, "fork", { lineageKind: "FORK", lineageParentId: "root" }),
  ).not.toThrow();
  expect(() => insertIdea(db, "root2", { lineageKind: "ROOT", lineageParentId: "root" })).toThrow(
    /CHECK/,
  );
  // V5 (#16): `lineage_parent_id` is no longer a foreign key. T26 requires a fork **child** to keep
  // its parent reference after the parent is deleted, so a ghost id has to be *accepted* here — the
  // CHECK above is the only thing confining the column, and the dangling ref is the documented shape.
  expect(() =>
    insertIdea(db, "dangling", { lineageKind: "FORK", lineageParentId: "ghost" }),
  ).not.toThrow();
});

test("the vocabulary CHECKs reject out-of-vocabulary values", () => {
  const db = migrated();
  // V3 (#14): `ITERATION` is *retired* — iteration is a new `idea_version` on the same node, not a
  // lineage kind, and `0004` narrowed the CHECK. It is now rejected for the same reason `NOPE` is.
  expect(() => insertIdea(db, "i0", { lineageKind: "ITERATION" })).toThrow(/CHECK/);
  expect(() => insertIdea(db, "i1", { lineageKind: "NOPE" })).toThrow(/CHECK/);
  expect(() => insertIdea(db, "i2", { status: "NOPE" })).toThrow(/CHECK/);
  expect(() => insertIdea(db, "i3", { visibility: "PUBLIC" })).toThrow(/CHECK/);

  insertPair(db);
  expect(() => insertSpark(db, "s1", "NOPE")).toThrow(/CHECK/);
  expect(() =>
    db.exec("INSERT INTO spark_run (id, vault_revision, status) VALUES ('r1', 0, 'NOPE')"),
  ).toThrow(/CHECK/);
  expect(() =>
    db.exec("INSERT INTO suppressed_pair (pair_key, reason, updated_at) VALUES ('a|b','NOPE','t')"),
  ).toThrow(/CHECK/);

  insertSpark(db, "s1");
  expect(() =>
    db.exec("INSERT INTO decision (id, spark_id, kind, decided_at) VALUES ('d1','s1','NOPE','t')"),
  ).toThrow(/CHECK/);
});

test("vault_meta is structurally a single row", () => {
  const db = migrated();
  // `0002_seed_vault_meta` inserts the singleton; a second row is impossible.
  expect(rows(db, "SELECT count(*) AS n FROM vault_meta")[0]?.n).toBe(1);
  expect(() => db.exec("INSERT INTO vault_meta (id, revision) VALUES (2, 0)")).toThrow(/CHECK/);
});

test("a populated v3 store upgrades to 0004 — rows intact, the lineage CHECK narrowed", () => {
  const db = newStore();
  // Apply only the first three, so this is a real upgrade path (the state every dev store is in),
  // not a fresh install: `0004` rebuilds `idea` and must carry the rows across.
  migrate(db, MIGRATIONS.slice(0, 3));
  expect(schemaVersion(db)).toBe(3);

  insertIdea(db, "root");
  insertIdea(db, "child", { lineageKind: "FORK", lineageParentId: "root" });
  db.exec(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES ('child', 1, 'h', 'p', 'm', '["x"]', 't')`,
  );

  expect(migrate(db, MIGRATIONS)).toBe(SCHEMA_VERSION);
  expect(rows(db, "SELECT count(*) AS n FROM idea")[0]?.n).toBe(2);
  expect(rows(db, "SELECT lineage_parent_id AS p FROM idea WHERE id = 'child'")[0]?.p).toBe("root");
  expect(rows(db, "SELECT count(*) AS n FROM idea_version")[0]?.n).toBe(1);
  // The rebuild drops and recreates `idea`, so the child's cascade FK must still be there — and the
  // enum it was rebuilt for is now closed to `ITERATION`.
  expect(() => insertIdea(db, "iter", { lineageKind: "ITERATION" })).toThrow(/CHECK/);
  db.exec("DELETE FROM idea WHERE id = 'child'");
  expect(rows(db, "SELECT count(*) AS n FROM idea_version")[0]?.n).toBe(0);
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});

test("only a FORK may carry a mutation delta (0005, V4 #15)", () => {
  const db = migrated();
  insertIdea(db, "root");
  insertIdea(db, "parent");
  insertIdea(db, "fork", { lineageKind: "FORK", lineageParentId: "parent" });

  // The column is nullable: a ROOT and a FORK without a delta are both fine.
  expect(rows(db, "SELECT mutation_delta AS d FROM idea WHERE id = 'root'")[0]?.d).toBeNull();
  expect(rows(db, "SELECT mutation_delta AS d FROM idea WHERE id = 'fork'")[0]?.d).toBeNull();

  // A FORK may carry one — on INSERT and on UPDATE alike.
  db.exec("UPDATE idea SET mutation_delta = 'into a new domain' WHERE id = 'fork'");
  expect(rows(db, "SELECT mutation_delta AS d FROM idea WHERE id = 'fork'")[0]?.d).toBe(
    "into a new domain",
  );
  // A ROOT may not — the delta exists only on a fork, which is a schema fact, not call-site discipline.
  expect(() => db.exec("UPDATE idea SET mutation_delta = 'd' WHERE id = 'root'")).toThrow(/CHECK/);
  expect(() =>
    db.exec(
      "INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind, status, visibility, current_version, created_at, updated_at, mutation_delta) VALUES ('r2','h','p','m','[\"x\"]','ROOT','ACTIVE','PRIVATE',1,'t','t','d')",
    ),
  ).toThrow(/CHECK/);

  // Negative control the schema enforces: a delta is a FORK's *only* parent-bearing form, so a row
  // cannot be demoted to a ROOT while keeping the delta — the pair is written together or not at all.
  expect(() =>
    db.exec("UPDATE idea SET lineage_kind = 'ROOT', lineage_parent_id = NULL WHERE id = 'fork'"),
  ).toThrow(/CHECK/);
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});

test("a populated v4 store upgrades to 0005 — rows intact, the delta column added", () => {
  const db = newStore();
  // Apply only the first four, so this is a real upgrade path (the state every dev store is in).
  migrate(db, MIGRATIONS.slice(0, 4));
  expect(schemaVersion(db)).toBe(4);

  insertIdea(db, "root");
  insertIdea(db, "child", { lineageKind: "FORK", lineageParentId: "root" });

  expect(migrate(db, MIGRATIONS)).toBe(SCHEMA_VERSION);
  expect(rows(db, "SELECT count(*) AS n FROM idea")[0]?.n).toBe(2);
  expect(rows(db, "SELECT lineage_parent_id AS p FROM idea WHERE id = 'child'")[0]?.p).toBe("root");
  // The added column defaults to NULL, and the guard is live on the upgraded store.
  expect(rows(db, "SELECT mutation_delta AS d FROM idea WHERE id = 'child'")[0]?.d).toBeNull();
  expect(() => db.exec("UPDATE idea SET mutation_delta = 'd' WHERE id = 'root'")).toThrow(/CHECK/);
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});

test("new_domain is nullable and only 0/1 (0006, EV1 #43)", () => {
  const db = migrated();
  insertIdea(db, "root");
  // NULL is the default and a state in its own right: **"not recorded"** — a pre-existing row, or an
  // ACCEPT-born root at birth. The report counts `= 1`, so NULL is excluded, never read as 0.
  expect(rows(db, "SELECT new_domain AS d FROM idea WHERE id = 'root'")[0]?.d).toBeNull();

  // Both recorded values are accepted — on INSERT and on UPDATE alike (the column is not FORK-only).
  db.exec("UPDATE idea SET new_domain = 1 WHERE id = 'root'");
  expect(rows(db, "SELECT new_domain AS d FROM idea WHERE id = 'root'")[0]?.d).toBe(1);
  db.exec("UPDATE idea SET new_domain = 0 WHERE id = 'root'");
  expect(rows(db, "SELECT new_domain AS d FROM idea WHERE id = 'root'")[0]?.d).toBe(0);

  // Nothing outside the vocabulary is: the guard is the schema's, not call-site discipline.
  expect(() => db.exec("UPDATE idea SET new_domain = 2 WHERE id = 'root'")).toThrow(/CHECK/);
  expect(() => db.exec("UPDATE idea SET new_domain = -1 WHERE id = 'root'")).toThrow(/CHECK/);
  expect(() => db.exec("UPDATE idea SET new_domain = 'yes' WHERE id = 'root'")).toThrow(/CHECK/);
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});

test("a populated v5 store upgrades to 0006 — rows intact, the column added and NULL", () => {
  const db = newStore();
  // Apply only the first five, so this is a real upgrade path (the state every dev store is in).
  migrate(db, MIGRATIONS.slice(0, 5));
  expect(schemaVersion(db)).toBe(5);

  insertIdea(db, "root");
  insertIdea(db, "child", { lineageKind: "FORK", lineageParentId: "root" });

  expect(migrate(db, MIGRATIONS)).toBe(SCHEMA_VERSION);
  expect(rows(db, "SELECT count(*) AS n FROM idea")[0]?.n).toBe(2);
  expect(rows(db, "SELECT lineage_parent_id AS p FROM idea WHERE id = 'child'")[0]?.p).toBe("root");
  // The added column has no default, so every pre-existing row lands NULL = "not recorded" — which is
  // the whole point: no backfill is faked, and the metric's `= 1` filter keeps them out.
  expect(rows(db, "SELECT new_domain AS d FROM idea WHERE id = 'child'")[0]?.d).toBeNull();
  // And the CHECK is live on the upgraded store, not just on a fresh install.
  expect(() => db.exec("UPDATE idea SET new_domain = 7 WHERE id = 'child'")).toThrow(/CHECK/);
  expect(rows(db, "PRAGMA foreign_key_check")).toEqual([]);
});

test("a store already at v1 is upgraded by 0002 and the singleton appears", () => {
  const db = newStore();
  // The F3 world: only `0001_init` applied, so `vault_meta` is empty.
  migrate(db, [MIGRATIONS[0]!]);
  expect(schemaVersion(db)).toBe(1);
  expect(rows(db, "SELECT count(*) AS n FROM vault_meta")[0]?.n).toBe(0);

  // Forward-only upgrade: `0002` runs, and §2's single-row invariant now holds at revision 0.
  migrate(db, MIGRATIONS);
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
  expect(rows(db, "SELECT id, revision FROM vault_meta")).toEqual([{ id: 1, revision: 0 }]);
});
