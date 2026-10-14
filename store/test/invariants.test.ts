import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { migrate } from "../src/migrate.js";
import { MIGRATIONS } from "../src/migrations.js";
import { openStore, writeTransaction } from "../src/store.js";
import { insertIdea, insertPair, insertSpark, rows } from "./seed.js";

/**
 * The four invariants F3 (#10) names. Three of them are properties of a *write pattern*, not a
 * single-row constraint, so the schema alone cannot state them: the test asserts the pattern and,
 * where the schema can see the violation, that it rejects it.
 */

const dirs: string[] = [];
const opened: DatabaseSync[] = [];

function migrated(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-invariants-"));
  dirs.push(dir);
  const db = openStore(join(dir, "astrolab.sqlite"));
  opened.push(db);
  migrate(db, MIGRATIONS);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The cross-table check the ACCEPT write path keeps true: a derived idea is always a ROOT. */
function provenanceViolations(db: DatabaseSync): number {
  return Number(
    rows(
      db,
      `SELECT count(*) AS n FROM idea i
       WHERE i.lineage_parent_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM provenance_edge p WHERE p.derived_idea_id = i.id)`,
    )[0]?.n,
  );
}

function revision(db: DatabaseSync): number {
  return Number(rows(db, "SELECT revision FROM vault_meta WHERE id = 1")[0]?.revision);
}

/** The vault's stamp: a relative `UPDATE` inside the mutation's transaction (ARCH §4). */
function bump(db: DatabaseSync): void {
  writeTransaction(db, () => db.exec("UPDATE vault_meta SET revision = revision + 1 WHERE id = 1"));
}

test("provenance-bearing ⇒ lineage_parent_id IS NULL (ARCH §2.2, closes D1)", () => {
  const db = migrated();
  insertPair(db);

  // The ACCEPT shape: the derived idea is a brand-new ROOT and carries the provenance edges to its
  // two sources (K4 writes idea + edges + the spark status change in one transaction).
  insertIdea(db, "derived");
  insertSpark(db, "s1", "RESOLVED-ACCEPTED");
  db.exec(
    `INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id)
     VALUES ('derived','a','s1'), ('derived','b','s1')`,
  );
  expect(provenanceViolations(db)).toBe(0);

  // The half the schema can see — a non-FORK carrying a parent — is rejected outright.
  expect(() => db.exec("UPDATE idea SET lineage_parent_id = 'a' WHERE id = 'derived'")).toThrow(
    /CHECK/,
  );

  // Negative control: the detector is not vacuous. A violation planted past the write path (the
  // CHECK is bypassed by making it a FORK in the same statement) is reported.
  db.exec("UPDATE idea SET lineage_kind = 'FORK', lineage_parent_id = 'a' WHERE id = 'derived'");
  expect(provenanceViolations(db)).toBe(1);
});

test("lineage is single-parent — one nullable column, set only for a FORK", () => {
  const db = migrated();

  // Structural half: exactly one parent column, so "two parents" is not expressible.
  const parentColumns = rows(db, "PRAGMA table_info(idea)")
    .map((c) => String(c.name))
    .filter((n) => n.includes("parent"));
  expect(parentColumns).toEqual(["lineage_parent_id"]);

  insertIdea(db, "root");
  insertIdea(db, "fork", { lineageKind: "FORK", lineageParentId: "root" });
  expect(rows(db, "SELECT lineage_parent_id AS p FROM idea WHERE id = 'fork'")[0]?.p).toBe("root");

  // The CHECK confines the parent to FORK. The FK is deliberately **gone** (V5 #16): T26 tolerates a
  // dangling parent ref so a fork child survives its parent's deletion, and V2's read path stops the
  // ancestor walk on one rather than failing.
  expect(() =>
    insertIdea(db, "iter", { lineageKind: "ITERATION", lineageParentId: "root" }),
  ).toThrow(/CHECK/);
  expect(() =>
    insertIdea(db, "dangling", { lineageKind: "FORK", lineageParentId: "ghost" }),
  ).not.toThrow();
});

test("a repeated decision_id insert is a no-op returning the first row (FLOW §2.2, N4/H4)", () => {
  const db = migrated();
  insertPair(db);
  insertSpark(db, "s1");
  insertIdea(db, "derived");

  const upsert = db.prepare(
    `INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at)
     VALUES (?, 's1', ?, ?, 't1') ON CONFLICT(id) DO NOTHING`,
  );
  upsert.run("d1", "ACCEPT", "derived");
  // A retry — or a raced swipe+tap — with a different payload must not overwrite the first decision.
  upsert.run("d1", "DISMISS", null);

  const all = rows(db, "SELECT id, kind, result_idea_id FROM decision");
  expect(all).toHaveLength(1);
  expect(all[0]).toEqual({ id: "d1", kind: "ACCEPT", result_idea_id: "derived" });

  // The PK on the client-supplied decision_id is what makes the upsert a no-op; a plain insert of
  // the same id is rejected, which is the constraint the idempotency rides on.
  expect(() =>
    db.exec(
      "INSERT INTO decision (id, spark_id, kind, decided_at) VALUES ('d1','s1','DISMISS','t2')",
    ),
  ).toThrow(/UNIQUE|PRIMARY/);
});

test("the vault_meta singleton is seeded — the first bump is not a silent no-op (ARCH §4)", () => {
  const db = migrated();

  // 0002_seed_vault_meta: the row exists the moment migrate() returns, so the first relative bump
  // lands instead of matching zero rows and reporting success.
  expect(rows(db, "SELECT count(*) AS n FROM vault_meta")[0]?.n).toBe(1);
  expect(revision(db)).toBe(0);
  bump(db);
  expect(revision(db)).toBe(1);

  // And it stays monotonic: the bump is relative (`revision + 1`), never an absolute set.
  const seen = [revision(db)];
  for (let i = 0; i < 5; i++) {
    bump(db);
    seen.push(revision(db));
  }
  expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  expect(rows(db, "SELECT count(*) AS n FROM vault_meta")[0]?.n).toBe(1);
});
