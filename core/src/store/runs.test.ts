import type { SqliteConnection } from "./connection.js";
import { openNodeStore } from "./connection.node.js";

import { describe, expect, test } from "vitest";

import { migrate } from "./migrate.js";
import { MIGRATIONS } from "./migrations.js";
import {
  claimNextRun,
  currentVaultRevision,
  enqueueRun,
  finishRun,
  requeueOrphanedRuns,
  stampAndEnqueue,
} from "./runs.js";

/** A fresh migrated in-memory vault — the same schema `main` ships (`0001_init` + `0002`). */
function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function rows(db: SqliteConnection): Array<{ id: string; vault_revision: number; status: string }> {
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
    const db = openNodeStore(":memory:");
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

describe("claimNextRun", () => {
  test("returns null on an empty queue", () => {
    expect(claimNextRun(newDb())).toBeNull();
  });

  test("marks the newest pending run RUNNING and stamps started_at", () => {
    const db = newDb();
    const pending = enqueueRun(db, 4);

    const claimed = claimNextRun(db);

    expect(claimed).toMatchObject({ id: pending.id, vault_revision: 4, status: "RUNNING" });
    expect(claimed?.started_at).not.toBeNull();
    expect(claimNextRun(db)).toBeNull(); // the row is no longer PENDING
  });

  test("discards a pending run whose stamp is behind instead of running it (§4 / I)", () => {
    const db = newDb();
    stampAndEnqueue(db); // revision 1
    stampAndEnqueue(db); // revision 2 — a PENDING row must sit at 2
    // Manufacture the stale queue a crash could leave: a PENDING row behind the vault.
    db.exec(
      `INSERT INTO spark_run (id, vault_revision, status, started_at, finished_at, error)
       VALUES ('stale', 1, 'PENDING', NULL, NULL, NULL)`,
    );

    // The row at the newest stamp wins; the behind-stamp row is gone, not queued behind it.
    expect(claimNextRun(db)?.vault_revision).toBe(2);
    expect(rows(db).map((r) => r.id)).not.toContain("stale");
  });

  test("deletes a behind-stamp run even when it is the only one pending", () => {
    const db = newDb();
    stampAndEnqueue(db);
    db.exec("UPDATE vault_meta SET revision = 9 WHERE id = 1");
    db.exec(
      `INSERT INTO spark_run (id, vault_revision, status, started_at, finished_at, error)
       VALUES ('stale', 1, 'PENDING', NULL, NULL, NULL)`,
    );

    expect(claimNextRun(db)).toBeNull();
    expect(rows(db)).toHaveLength(0);
  });
});

describe("finishRun", () => {
  test("DONE records finished_at and leaves error null", () => {
    const db = newDb();
    const run = enqueueRun(db, 2);
    claimNextRun(db);

    finishRun(db, run.id, "DONE");

    expect(rows(db)).toEqual([{ id: run.id, vault_revision: 2, status: "DONE" }]);
    const row = db.prepare("SELECT finished_at, error FROM spark_run WHERE id = ?").get(run.id) as {
      finished_at: string | null;
      error: string | null;
    };
    expect(row.finished_at).not.toBeNull();
    expect(row.error).toBeNull();
  });

  test("FAILED records the message", () => {
    const db = newDb();
    const run = enqueueRun(db, 2);
    claimNextRun(db);

    finishRun(db, run.id, "FAILED", "provider timed out");

    const row = db.prepare("SELECT status, error FROM spark_run WHERE id = ?").get(run.id) as {
      status: string;
      error: string | null;
    };
    expect(row.status).toBe("FAILED");
    expect(row.error).toBe("provider timed out");
  });

  test("refuses to finish a run that is not RUNNING", () => {
    const db = newDb();
    const run = enqueueRun(db, 2);

    expect(() => finishRun(db, run.id, "DONE")).toThrow(/not RUNNING/);
  });
});

describe("requeueOrphanedRuns — ADR-0004: a restart simply re-enqueues", () => {
  test("returns a crash-orphaned RUNNING row to PENDING and clears started_at", () => {
    const db = newDb();
    const run = enqueueRun(db, 3);
    claimNextRun(db);

    expect(requeueOrphanedRuns(db)).toBe(1);

    const row = db.prepare("SELECT status, started_at FROM spark_run WHERE id = ?").get(run.id) as {
      status: string;
      started_at: string | null;
    };
    expect(row.status).toBe("PENDING");
    expect(row.started_at).toBeNull();
  });

  test("is a no-op on a clean queue", () => {
    const db = newDb();
    enqueueRun(db, 3);
    expect(requeueOrphanedRuns(db)).toBe(0);
  });
});
