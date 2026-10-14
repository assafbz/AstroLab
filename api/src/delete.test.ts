import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { deleteIdea } from "./delete.js";

/**
 * V5 (#16) — `DELETE /v1/ideas/{id}` (`docs/API.md` §4.8; `FLOW.md` T26 / M3), against a fresh
 * migrated vault. What the delete removes, what it deliberately leaves dangling, and the one thing it
 * must never do: un-resolve.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function revision(db: DatabaseSync): number {
  return (db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as { revision: number })
    .revision;
}

function seedIdea(
  db: DatabaseSync,
  id: string,
  over: { lineageKind?: string; lineageParentId?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', '["fintech"]', ?, ?, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, over.lineageKind ?? "ROOT", over.lineageParentId ?? null);
}

function seedSpark(db: DatabaseSync, id: string, a: string, b: string, status = "OFFERED"): void {
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES (?, ?, ?, ?, 'merge them', 'why not', ?, 't')`,
  ).run(id, a, b, `${a}|${b}`, status);
}

const edge = (db: DatabaseSync, derived: string, source: string): void => {
  db.prepare(
    "INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES (?, ?, 'sp-1')",
  ).run(derived, source);
};

/** The one write path that exists today: a seeded capture resolves its spark in the same transaction. */
const seedSeededCapture = (db: DatabaseSync, derived: string, a: string, b: string): void => {
  seedSpark(db, `sp-${derived}`, a, b, "RESOLVED-INSPIRED");
  db.prepare(
    "INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at) VALUES (?, ?, 'INSPIRED', ?, 't')",
  ).run(`dec-${derived}`, `sp-${derived}`, derived);
};

describe("deleteIdea — what goes, and what dangles", () => {
  test("an unknown id is false and writes nothing — a 404 must not churn the vault", () => {
    const db = newDb();
    const before = revision(db);
    expect(deleteIdea(db, "nope")).toBe(false);
    expect(revision(db)).toBe(before);
    expect(count(db, "spark_run")).toBe(0);
  });

  test("the idea's own rows go with it", () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "gone");
    db.exec(
      `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
       VALUES ('gone', 1, 'h', 'p', 'm', '["x"]', 't')`,
    );
    db.exec(
      `INSERT INTO idea_mechanism (idea_id, descriptor, source_hash, extracted_at)
       VALUES ('gone', '{}', 'hash', 't')`,
    );

    expect(deleteIdea(db, "gone")).toBe(true);
    expect(count(db, "idea")).toBe(1);
    expect(count(db, "idea_version")).toBe(0);
    expect(count(db, "idea_mechanism")).toBe(0);
  });

  test("the edge belongs to its derived idea: deleting one takes its provenance with it", () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    seedIdea(db, "derived");
    edge(db, "derived", "a");
    edge(db, "derived", "b");

    expect(deleteIdea(db, "derived")).toBe(true);
    expect(count(db, "provenance_edge")).toBe(0);
    // One direction only: the sources are untouched.
    expect(count(db, "idea")).toBe(2);
  });

  test("deleting a provenance source leaves the edge dangling and the derived idea alive (T26)", () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    seedIdea(db, "derived");
    edge(db, "derived", "a");
    edge(db, "derived", "b");
    seedSeededCapture(db, "derived", "a", "b");

    expect(deleteIdea(db, "a")).toBe(true);
    expect(count(db, "provenance_edge")).toBe(2);
    expect(count(db, "idea WHERE id = 'derived'")).toBe(1);
    // §5.4's permanence: the spark stays resolved, is not re-offered, and keeps the dangling source.
    expect(count(db, "spark WHERE status = 'RESOLVED-INSPIRED'")).toBe(1);
    expect(count(db, "spark WHERE idea_a_id = 'a'")).toBe(1);
    expect(count(db, "decision WHERE result_idea_id = 'derived'")).toBe(1);
  });

  test("deleting a fork parent leaves the child's parent reference dangling (T26)", () => {
    const db = newDb();
    seedIdea(db, "parent");
    seedIdea(db, "child", { lineageKind: "FORK", lineageParentId: "parent" });

    expect(deleteIdea(db, "parent")).toBe(true);
    expect(
      (
        db.prepare("SELECT lineage_parent_id AS p FROM idea WHERE id = 'child'").get() as {
          p: string;
        }
      ).p,
    ).toBe("parent");
    expect(count(db, "idea")).toBe(1);
  });

  test("a decision's result ref dangles: the resolution is permanent (§5.4)", () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    seedIdea(db, "derived");
    seedSeededCapture(db, "derived", "a", "b");

    expect(deleteIdea(db, "derived")).toBe(true);
    expect(count(db, "decision WHERE result_idea_id = 'derived'")).toBe(1);
    expect(count(db, "spark WHERE status = 'RESOLVED-INSPIRED'")).toBe(1);
  });
});

describe("deleteIdea — live offers are retracted, history is not", () => {
  test("a live OFFERED spark naming the idea is retracted", () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    seedSpark(db, "sp-1", "a", "b");

    expect(deleteIdea(db, "a")).toBe(true);
    expect(count(db, "spark")).toBe(0);
  });

  test("a resolved spark naming the idea keeps its dangling pair", () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    seedSpark(db, "sp-1", "a", "b", "RESOLVED-DISMISSED");

    expect(deleteIdea(db, "a")).toBe(true);
    expect(count(db, "spark")).toBe(1);
    expect(count(db, "spark WHERE idea_a_id = 'a'")).toBe(1);
  });

  test("the retraction is scoped to the deleted idea's offers", () => {
    const db = newDb();
    for (const id of ["a", "b", "c", "d"]) seedIdea(db, id);
    seedSpark(db, "untouched", "c", "d");

    expect(deleteIdea(db, "a")).toBe(true);
    expect(count(db, "spark WHERE id = 'untouched'")).toBe(1);
  });

  test("no decision names a live offer — the invariant the retraction relies on", () => {
    // `decision.spark_id` still references `spark` (it is kept), so a decision on an `OFFERED` spark
    // would make the retraction's DELETE fail on the foreign key. Prove the state cannot arise rather
    // than assume it: the seeded capture below is the only decision writer that exists today, and it
    // resolves its spark in the same transaction.
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    seedIdea(db, "derived");
    seedSeededCapture(db, "derived", "a", "b");

    const liveWithDecision = (): number =>
      count(db, "spark s JOIN decision d ON d.spark_id = s.id WHERE s.status = 'OFFERED'");
    expect(liveWithDecision()).toBe(0);

    // …and the check is discriminating: the schema does *not* forbid the state, so planting it is
    // what makes the zero above evidence rather than a tautology.
    db.exec("UPDATE spark SET status = 'OFFERED' WHERE id = 'sp-derived'");
    expect(liveWithDecision()).toBe(1);
  });
});

describe("deleteIdea — the ARCH §4 trigger", () => {
  test("a real delete stamps the revision and enqueues a run, in one transaction", () => {
    const db = newDb();
    seedIdea(db, "gone");
    const before = revision(db);

    expect(deleteIdea(db, "gone")).toBe(true);
    expect(revision(db)).toBe(before + 1);
    const runs = db.prepare("SELECT vault_revision, status FROM spark_run").all() as Array<{
      vault_revision: number;
      status: string;
    }>;
    expect(runs).toEqual([{ vault_revision: before + 1, status: "PENDING" }]);
  });

  test("deleting a live-offer-only case still stamps once, not twice", () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    seedSpark(db, "sp-1", "a", "b");
    const before = revision(db);

    expect(deleteIdea(db, "a")).toBe(true);
    expect(revision(db)).toBe(before + 1);
    expect(count(db, "spark_run")).toBe(1);
  });
});
