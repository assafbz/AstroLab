import type { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations.js";
import { currentVaultRevision } from "./runs.js";
import { openStore } from "./store.js";
import { vaultMutation } from "./vault.js";

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

function runs(db: DatabaseSync): Array<{ vault_revision: number; status: string }> {
  return db
    .prepare("SELECT vault_revision, status FROM spark_run ORDER BY vault_revision")
    .all() as Array<{ vault_revision: number; status: string }>;
}

describe("vaultMutation — ARCHITECTURE.md §4, made unmissable", () => {
  test("returns the body's result, and stamps + enqueues when the body wrote", () => {
    const db = newDb();

    const result = vaultMutation(db, () => {
      seedIdea(db, "a");
      return "the-result";
    });

    expect(result).toBe("the-result");
    expect(currentVaultRevision(db)).toBe(1);
    expect(runs(db)).toEqual([{ vault_revision: 1, status: "PENDING" }]);
  });

  test("a body that changes nothing neither bumps the revision nor enqueues", () => {
    const db = newDb();

    // The idempotent `decision_id` repeat (docs/API.md §4.2) is exactly this case: a body that
    // returns early having written nothing must not churn the revision.
    const result = vaultMutation(db, () => db.prepare("SELECT COUNT(*) AS n FROM idea").get());

    expect(result).toEqual({ n: 0 });
    expect(currentVaultRevision(db)).toBe(0);
    expect(runs(db)).toEqual([]);
  });

  test("a body that throws leaves no write and no stamp", () => {
    const db = newDb();

    expect(() =>
      vaultMutation(db, () => {
        seedIdea(db, "a");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(db.prepare("SELECT COUNT(*) AS n FROM idea").get()).toEqual({ n: 0 });
    expect(currentVaultRevision(db)).toBe(0);
    expect(runs(db)).toEqual([]);
  });
});
