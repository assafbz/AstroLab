import type { SqliteConnection } from "../src/store/connection.js";

import { parseRunFailure } from "../src/failure.js";
import { NoKeyError } from "../src/provider/index.js";
import { MIGRATIONS, enqueueRun, migrate, stampAndEnqueue } from "../src/store/index.js";
import { openNodeStore } from "../src/store/connection.node.js";
import { describe, expect, test } from "vitest";

import {
  cutVault,
  runOnce,
  stubRunBody,
  type RunOutcome,
  type VaultCut,
} from "../src/engine/queue.js";

/** A fresh migrated in-memory vault — the same schema `main` ships (`0001_init` + `0002`). */
function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function seedIdea(db: SqliteConnection, id: string): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', '["fintech"]', 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id);
}

function runRows(db: SqliteConnection): Array<{
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

    // Content, not order: `SELECT id FROM idea` walks the covering `sqlite_autoindex_idea_1`, so these
    // ids come back ASC whatever the insert order — seeding "b" before "a" does *not* exercise the sort
    // (see `cutVault`'s `shortcut:`). The falsifiable ordering test is W5's gate determinism (gate.test).
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

    // The row carries the cause's tag (L3 · #166): E4 has one bit and §4.3 needs the reason, so the
    // classification is written where it is known and read back by the vault without touching a provider.
    expect(result).toMatchObject({
      outcome: null,
      discarded: false,
      error: "failure:unavailable: provider timed out",
    });
    expect(runRows(db)).toEqual([
      {
        id: queued.id,
        vault_revision: 1,
        status: "FAILED",
        error: "failure:unavailable: provider timed out",
      },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM idea").get()).toEqual({ n: 1 });
  });

  test("a NoKeyError's cause rides the row — E4 renders *Add your AI key* (§4.3)", async () => {
    const db = newDb();
    seedIdea(db, "a");
    stampAndEnqueue(db);

    const result = await runOnce(db, () => {
      throw new NoKeyError("no API key is set");
    });

    expect(result?.error).toBe("failure:no-key: no API key is set");
    expect(runRows(db)[0]?.error).toBe("failure:no-key: no API key is set");
    expect(parseRunFailure(runRows(db)[0]?.error ?? null)).toBe("no-key");
  });

  test("the default stub body produces no candidates and reaches no provider", () => {
    expect(stubRunBody({ revision: 1, ideaIds: [] })).toEqual({ candidates: [] });
  });
});

describe("runOnce — reproducibility & supersession (issue #26, Done #4)", () => {
  test("re-running the same revision hands the body an identical cut", async () => {
    const db = newDb();
    seedIdea(db, "b");
    seedIdea(db, "a");
    stampAndEnqueue(db);

    const cuts: VaultCut[] = [];
    const body = (cut: VaultCut): RunOutcome => {
      cuts.push(cut);
      return { candidates: ["a|b"] };
    };

    await runOnce(db, body);
    enqueueRun(db, 1); // the same revision again
    await runOnce(db, body);

    expect(cuts).toHaveLength(2);
    expect(cuts[1]).toEqual(cuts[0]); // the determinism claim: two runs, one revision, one cut
    // Content, not order (same `shortcut:` as `cutVault`): `sqlite_autoindex_idea_1` yields ids ASC
    // regardless of insert order, so this literal cannot discriminate a sort.
    expect(cuts[0]).toEqual({ revision: 1, ideaIds: ["a", "b"] });
  });

  test("a run that goes stale mid-body is DONE and discarded; the newer run supersedes it", async () => {
    const db = newDb();
    seedIdea(db, "a");
    const stale = stampAndEnqueue(db); // revision 1

    const result = await runOnce(db, () => {
      stampAndEnqueue(db); // the vault moves *during* the run → revision 2
      return { candidates: ["a|b"] };
    });

    // The stale run completed, but its outcome is discarded — never offered (§4 / I).
    expect(result).toMatchObject({ discarded: true, error: null });
    expect(result?.outcome).toEqual({ candidates: ["a|b"] });

    const all = runRows(db);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      id: stale.id,
      vault_revision: 1,
      status: "DONE",
      error: "discarded: superseded by revision 2",
    });
    expect(all[1]).toMatchObject({ vault_revision: 2, status: "PENDING" });

    // The superseding run is what the loop picks up next.
    const next = await runOnce(db);
    expect(next).toMatchObject({ discarded: false });
    expect(next?.run.vault_revision).toBe(2);
  });

  test("enqueue during a run keeps the RUNNING row and leaves exactly one PENDING (pin: at most one *pending*)", async () => {
    const db = newDb();
    stampAndEnqueue(db); // revision 1

    const during: ReturnType<typeof runRows> = [];
    await runOnce(db, () => {
      stampAndEnqueue(db); // revision 2 while revision 1 is RUNNING
      during.push(...runRows(db));
      return { candidates: [] };
    });

    expect(during).toHaveLength(2);
    expect(during).toMatchObject([
      { vault_revision: 1, status: "RUNNING" },
      { vault_revision: 2, status: "PENDING" },
    ]);
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
