import { afterEach, describe, expect, test } from "vitest";

import {
  seedGateConfig,
  seedGateConfigAsync,
  setConfig,
  readGateConfig,
} from "../src/store/config.js";
import { asAsyncConnection, type SqliteConnection } from "../src/store/connection.js";
import { openNodeStore } from "../src/store/connection.node.js";
import { SCHEMA_VERSION, MIGRATIONS } from "../src/store/migrations.js";
import { requeueOrphanedRuns, requeueOrphanedRunsAsync } from "../src/store/runs.js";
import { migrate, schemaVersion } from "../src/store/migrate.js";
import { bootVault, bootVaultAsync } from "../src/boot.js";

/**
 * The guard for `#190`'s async boot — the twin `migrate-parity.test.ts` is for `#186`'s twins.
 *
 * `bootVault` and `bootVaultAsync` are two imperative shells around the same four steps (`migrate` ·
 * `seedDomainTaxonomy` · `seedGateConfig` · `requeueOrphanedRuns`), because a function that returns
 * `void` synchronously cannot contain `await` and the port is deliberately still synchronous
 * (`docs/adr/0007-web-boot-async-channel.md`). ADR-0007's discipline for that duplication is *guarded,
 * not asserted*, so this drives **both channels over the same fixtures** and requires an identical
 * database — and, one level in, drives the two **new** twins (`seedGateConfig` / `seedGateConfigAsync`,
 * `requeueOrphanedRuns` / `requeueOrphanedRunsAsync`) on their own, so a body that diverges in a step the
 * full-entry comparison could mask still reddens.
 *
 * `node:sqlite` is synchronous, so the async plane here is `asAsyncConnection` — the same shape
 * `#186`'s parity suite uses, and the right fixture for the same reason: the **rules** are
 * channel-independent, so only the transport differs between this and the web app.
 *
 * What green here does and does not mean: it proves the two entries land on the same database, and that
 * each new twin behaves like its sync sibling. It does **not** prove the async plane reaches
 * `expo-sqlite`'s `isSync: false` path — that is the web instrument's claim
 * (`scripts/gate2-cold-load.mjs`, gate 2), and the app's own suite covers the composition.
 */

/** The connection pair a parity case runs over: the same open, pragma-applied store, two planes. */
interface Pair {
  sync: SqliteConnection;
  async: ReturnType<typeof asAsyncConnection>;
  close: () => void;
}

/** A fresh `node:sqlite` store, opened the way both boot entries' callers open it (`openNodeStore`). */
function pair(): Pair {
  const sync = openNodeStore(":memory:");
  return { sync, async: asAsyncConnection(sync), close: () => sync.close() };
}

const open: Pair[] = [];
afterEach(() => {
  for (const p of open.splice(0)) p.close();
});

function opened(): Pair {
  const p = pair();
  open.push(p);
  return p;
}

/** Everything a boot can be asked to produce, read from one database. */
function snapshot(db: SqliteConnection) {
  return {
    master: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
    userVersion: schemaVersion(db),
    clusters: db.prepare("SELECT COUNT(*) AS n FROM domain_cluster").get(),
    tags: db.prepare("SELECT COUNT(*) AS n FROM domain_map").get(),
    config: db.prepare("SELECT key, value FROM config ORDER BY key").all(),
    runs: db
      .prepare("SELECT id, vault_revision, status, started_at FROM spark_run ORDER BY id")
      .all(),
  };
}

/** A `RUNNING` row, exactly as a process killed mid-run leaves one (ADR-0004, invariant 16). */
function plantOrphanedRun(db: SqliteConnection, id = "orphan"): void {
  db.exec(
    `INSERT INTO spark_run (id, vault_revision, status, started_at, finished_at, error)
     VALUES ('${id}', 1, 'RUNNING', '2026-11-12T00:00:00Z', NULL, NULL)`,
  );
}

describe("bootVaultAsync — the async boot is the sync boot (#190)", () => {
  test("both entries land on an identical database, over a fixture that exercises all four steps", async () => {
    const a = opened();
    const b = opened();

    // First pass over an empty file: the schema, the taxonomy seed, the gate seed.
    bootVault(a.sync);
    await bootVaultAsync(b.async);

    // Second pass over a non-empty file carrying a crash-orphaned run: the re-run path and the requeue.
    for (const db of [a.sync, b.sync]) plantOrphanedRun(db);
    bootVault(a.sync);
    await bootVaultAsync(b.async);

    expect(snapshot(b.sync)).toEqual(snapshot(a.sync));
  });

  test("both entries reach the shipped schema version", async () => {
    const a = opened();
    const b = opened();
    bootVault(a.sync);
    await bootVaultAsync(b.async);
    expect(schemaVersion(a.sync)).toBe(SCHEMA_VERSION);
    expect(schemaVersion(b.sync)).toBe(SCHEMA_VERSION);
  });

  test("the async entry seeds the gate config — the step the app used to skip (#190)", async () => {
    const b = opened();
    await bootVaultAsync(b.async);
    // Non-vacuity: the row is there *and* it is the shipped default, not an absence read as one.
    expect(readGateConfig(b.sync)).toEqual({ minDomainDistance: 1, minAlignment: 0.02 });
    const rows = b.sync.prepare("SELECT key FROM config ORDER BY key").all() as { key: string }[];
    expect(rows.map((r) => r.key)).toEqual(["min_alignment", "min_domain_distance"]);
  });

  test("the async entry requeues a crash-orphaned RUNNING run (#190)", async () => {
    const b = opened();
    // The schema must exist before the orphan can be planted, so boot once, plant, boot again.
    await bootVaultAsync(b.async);
    plantOrphanedRun(b.sync);

    await bootVaultAsync(b.async);

    expect(
      b.sync.prepare("SELECT status, started_at FROM spark_run WHERE id = 'orphan'").get(),
    ).toEqual({ status: "PENDING", started_at: null });
  });

  test("the requeue keeps the stamp, so a superseded orphan is not resurrected as current", async () => {
    const b = opened();
    await bootVaultAsync(b.async);
    plantOrphanedRun(b.sync, "stale");
    b.sync.exec("UPDATE spark_run SET vault_revision = 1 WHERE id = 'stale'");

    await bootVaultAsync(b.async);

    expect(b.sync.prepare("SELECT vault_revision FROM spark_run WHERE id = 'stale'").get()).toEqual(
      {
        vault_revision: 1,
      },
    );
  });

  test("seeding stays insert-only on the async entry — a tuned threshold survives a re-boot", async () => {
    const b = opened();
    await bootVaultAsync(b.async);
    setConfig(b.sync, "min_alignment", "0.9");

    await bootVaultAsync(b.async);

    expect(readGateConfig(b.sync)).toEqual({ minDomainDistance: 1, minAlignment: 0.9 });
  });
});

describe("the twins, one level in (#190) — each new async body against its sync sibling", () => {
  /** Both stores carried through `bootVault`, so the twins run against the same starting state. */
  function bootedPair(): Pair {
    const p = opened();
    bootVault(p.sync);
    return p;
  }

  /** Both stores brought only to the schema, so a seed's own effect is what gets compared. */
  function migratedPair(): Pair {
    const p = opened();
    migrate(p.sync, MIGRATIONS);
    return p;
  }

  test("seedGateConfigAsync writes the same rows as seedGateConfig", async () => {
    const a = migratedPair();
    const b = migratedPair();
    // Non-vacuity: the table is empty on both sides, so the comparison below is about what the seed
    // wrote — not two already-seeded stores agreeing.
    for (const p of [a, b]) {
      expect(p.sync.prepare("SELECT COUNT(*) AS n FROM config").get()).toEqual({ n: 0 });
    }

    seedGateConfig(a.sync);
    await seedGateConfigAsync(b.async);

    const rows = (p: Pair): unknown =>
      p.sync.prepare("SELECT key, value FROM config ORDER BY key").all();
    expect(rows(b)).toEqual(rows(a));
    expect(rows(a)).toEqual([
      { key: "min_alignment", value: "0.02" },
      { key: "min_domain_distance", value: "1" },
    ]);
  });

  test("seedGateConfigAsync is insert-only, like the sync body", async () => {
    const p = bootedPair();
    setConfig(p.sync, "min_alignment", "0.9");
    await seedGateConfigAsync(p.async);
    expect(readGateConfig(p.sync)).toEqual({ minDomainDistance: 1, minAlignment: 0.9 });
  });

  test("requeueOrphanedRunsAsync reports and applies the same count and rows", async () => {
    const a = bootedPair();
    const b = bootedPair();
    plantOrphanedRun(a.sync, "x1");
    plantOrphanedRun(b.sync, "x1");
    // A second orphan and a row that must NOT move, so the comparison is not satisfied by "requeues
    // everything". DONE and PENDING rows are inert on both channels.
    for (const db of [a.sync, b.sync]) {
      plantOrphanedRun(db, "x2");
      db.exec(
        `INSERT INTO spark_run (id, vault_revision, status, started_at, finished_at, error)
         VALUES ('done', 1, 'DONE', 't', 't', NULL)`,
      );
    }

    const syncCount = requeueOrphanedRuns(a.sync);
    const asyncCount = await requeueOrphanedRunsAsync(b.async);

    expect(asyncCount).toBe(syncCount);
    expect(syncCount).toBe(2);
    expect(
      b.sync.prepare("SELECT id, status, started_at FROM spark_run ORDER BY id").all(),
    ).toEqual(a.sync.prepare("SELECT id, status, started_at FROM spark_run ORDER BY id").all());
  });

  test("requeueOrphanedRunsAsync runs its update in one transaction", async () => {
    const p = bootedPair();
    plantOrphanedRun(p.sync, "x1");
    let begins = 0;
    const counted: typeof p.async = {
      ...p.async,
      exec: async (sql: string): Promise<void> => {
        if (/^BEGIN\b/.test(sql)) begins += 1;
        return p.async.exec(sql);
      },
    };

    await requeueOrphanedRunsAsync(counted);

    // The shell is `writeTransactionAsync`'s, not restated: exactly one `BEGIN IMMEDIATE` per call.
    expect(begins).toBe(1);
  });
});
