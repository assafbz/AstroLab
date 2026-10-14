import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, migrate, openStore, stampAndEnqueue } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { cutVault, runOnce, stubRunBody, type VaultCut } from "./queue.js";

/** A fresh migrated in-memory vault — the same schema `main` ships (`0001_init` + `0002`). */
function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function seedIdea(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', '["fintech"]', 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id);
}

function runRows(db: DatabaseSync): Array<{
  id: string;
  vault_revision: number;
  status: string;
  error: string | null;
}> {
  return db
    .prepare("SELECT id, vault_revision, status, error FROM spark_run ORDER BY vault_revision")
    .all() as Array<{ id: string; vault_revision: number; status: string; error: string | null }>;
}

describe("runOnce", () => {
  test("returns null when the queue is empty", async () => {
    expect(await runOnce(newDb())).toBeNull();
  });

  test("claims the pending run, hands the body its cut, and records DONE", async () => {
    const db = newDb();
    seedIdea(db, "b");
    seedIdea(db, "a");
    const queued = stampAndEnqueue(db);

    const cuts: VaultCut[] = [];
    const result = await runOnce(db, (cut) => {
      cuts.push(cut);
      return { candidates: ["a|b"] };
    });

    expect(cuts).toEqual([{ revision: 1, ideaIds: ["a", "b"] }]);
    expect(result).toMatchObject({
      outcome: { candidates: ["a|b"] },
      discarded: false,
      error: null,
    });
    expect(result?.run.id).toBe(queued.id);
    expect(runRows(db)).toEqual([
      { id: queued.id, vault_revision: 1, status: "DONE", error: null },
    ]);
  });

  test("a body that throws leaves the run FAILED with the message, vault untouched", async () => {
    const db = newDb();
    seedIdea(db, "a");
    const queued = stampAndEnqueue(db);

    const result = await runOnce(db, () => {
      throw new Error("provider timed out");
    });

    expect(result).toMatchObject({ outcome: null, discarded: false, error: "provider timed out" });
    expect(runRows(db)).toEqual([
      { id: queued.id, vault_revision: 1, status: "FAILED", error: "provider timed out" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM idea").get()).toEqual({ n: 1 });
  });

  test("the default stub body produces no candidates and reaches no provider", () => {
    expect(stubRunBody({ revision: 1, ideaIds: [] })).toEqual({ candidates: [] });
  });
});

describe("cutVault", () => {
  test("orders idea ids ASC — the deterministic cut (issue #26, Done #4)", () => {
    const db = newDb();
    seedIdea(db, "c");
    seedIdea(db, "a");
    seedIdea(db, "b");

    expect(cutVault(db, 7)).toEqual({ revision: 7, ideaIds: ["a", "b", "c"] });
  });
});
