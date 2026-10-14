import type { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations.js";
import { currentVaultRevision, enqueueRun, stampAndEnqueue } from "./runs.js";
import { openStore } from "./store.js";

/** A fresh migrated in-memory vault — the same schema `main` ships (`0001_init` + `0002`). */
function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function rows(db: DatabaseSync): Array<{ id: string; vault_revision: number; status: string }> {
  return db
    .prepare("SELECT id, vault_revision, status FROM spark_run ORDER BY vault_revision")
    .all() as Array<{ id: string; vault_revision: number; status: string }>;
}

describe("stampAndEnqueue — ARCHITECTURE.md §4 trigger", () => {
  test("bumps vault_meta.revision by one and enqueues a PENDING run at that stamp", () => {
    const db = newDb();
    expect(currentVaultRevision(db)).toBe(0);

    const run = stampAndEnqueue(db);

    expect(currentVaultRevision(db)).toBe(1);
    expect(run).toMatchObject({
      vault_revision: 1,
      status: "PENDING",
      started_at: null,
      finished_at: null,
      error: null,
    });
    expect(rows(db)).toEqual([{ id: run.id, vault_revision: 1, status: "PENDING" }]);
  });

  test("a second mutation supersedes the first run instead of queueing behind it (§4 / I)", () => {
    const db = newDb();
    const first = stampAndEnqueue(db);
    const second = stampAndEnqueue(db);

    expect(currentVaultRevision(db)).toBe(2);
    // ONE pending row, at the newer stamp — the stale one is discarded, not queued.
    expect(rows(db)).toEqual([{ id: second.id, vault_revision: 2, status: "PENDING" }]);
    expect(second.id).not.toBe(first.id);
  });

  test("fails loudly when the vault_meta singleton is missing (0002 not applied)", () => {
    const db = openStore(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.version === 1),
    );

    expect(() => stampAndEnqueue(db)).toThrow(/vault_meta singleton is missing/);
  });
});

describe("enqueueRun", () => {
  test("is idempotent per revision: a second enqueue at a pending stamp adds no row", () => {
    const db = newDb();
    const first = enqueueRun(db, 7);
    const again = enqueueRun(db, 7);

    expect(again.id).toBe(first.id);
    expect(rows(db)).toHaveLength(1);
  });

  test("discards a pending run whose stamp is behind, keeping only the newest", () => {
    const db = newDb();
    const older = enqueueRun(db, 3);
    const newer = enqueueRun(db, 5);

    expect(rows(db)).toEqual([{ id: newer.id, vault_revision: 5, status: "PENDING" }]);
    expect(older.id).not.toBe(newer.id);
  });
});
