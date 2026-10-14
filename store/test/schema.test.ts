import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { migrate, schemaVersion } from "../src/migrate.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/migrations.js";
import { openStore } from "../src/store.js";
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
const opened: DatabaseSync[] = [];

/** A fresh file store, opened but not yet migrated — file-backed, so FK enforcement is the real thing. */
function newStore(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-schema-"));
  dirs.push(dir);
  const db = openStore(join(dir, "astrolab.sqlite"));
  opened.push(db);
  return db;
}

/** A fresh file store with the shipped migrations applied. */
function migrated(): DatabaseSync {
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
  expect(() =>
    insertIdea(db, "iter", { lineageKind: "ITERATION", lineageParentId: "root" }),
  ).toThrow(/CHECK/);
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
