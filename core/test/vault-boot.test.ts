import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readGateConfig, SCHEMA_VERSION, setConfig, stampAndEnqueue } from "../src/store/index.js";
import { afterEach, describe, expect, test } from "vitest";

import { bootVault } from "../src/boot.js";
import { openNodeStore } from "../src/store/connection.node.js";
import { runOnce } from "../src/engine/queue.js";

const dirs: string[] = [];
function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-worker-boot-"));
  dirs.push(dir);
  return join(dir, "astrolab.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bootVault — one sequence, one writer (#26 carry; ADR-0006)", () => {
  test("brings the store to the shipped schema version", () => {
    const db = openNodeStore(":memory:");
    bootVault(db);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
  });

  test("seeds domain_map, so the engine never reads an unseeded taxonomy", () => {
    const db = openNodeStore(":memory:");
    bootVault(db);

    const seeded = db.prepare("SELECT COUNT(*) AS n FROM domain_map").get() as { n: number };
    expect(seeded.n).toBeGreaterThan(0);
    // and the queue table is there and empty
    expect(db.prepare("SELECT COUNT(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
  });

  test("seeds gate config, so a run can never read thresholds from an unseeded table (§3.4)", () => {
    const db = openNodeStore(":memory:");
    bootVault(db);
    expect(readGateConfig(db)).toEqual({ minDomainDistance: 1, minAlignment: 0.02 });
  });

  test("a tuned threshold survives a re-boot — seeding is insert-only, not a revert", () => {
    const path = tempStorePath();
    const first = openNodeStore(path);
    bootVault(first);
    setConfig(first, "min_alignment", "0.9");
    first.close();

    const second = openNodeStore(path);
    bootVault(second);

    expect(readGateConfig(second)).toEqual({ minDomainDistance: 1, minAlignment: 0.9 });
    second.close();
  });

  test("re-enqueues a crash-orphaned RUNNING run (ADR-0004: a restart simply re-enqueues)", () => {
    const path = tempStorePath();
    const first = openNodeStore(path);
    bootVault(first);
    // A process that died mid-run leaves the row RUNNING.
    first.exec(
      `INSERT INTO spark_run (id, vault_revision, status, started_at, finished_at, error)
       VALUES ('orphan', 1, 'RUNNING', '2026-10-14T00:00:00Z', NULL, NULL)`,
    );
    first.close();

    const second = openNodeStore(path);
    bootVault(second);

    expect(
      second.prepare("SELECT status, started_at FROM spark_run WHERE id = 'orphan'").get(),
    ).toEqual({ status: "PENDING", started_at: null });
    second.close();
  });

  test("drains one enqueued run end to end — the mutation returns, the worker finishes it", async () => {
    const db = openNodeStore(":memory:");
    bootVault(db);
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES ('a', 'h', 'p', 'm', '["fintech"]', 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
    ).run();
    stampAndEnqueue(db); // what a capture leaves behind

    const result = await runOnce(db);

    expect(result).toMatchObject({ discarded: false, error: null });
    expect(db.prepare("SELECT status FROM spark_run").get()).toEqual({ status: "DONE" });
  });
});
