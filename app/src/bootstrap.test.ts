import { describe, expect, test, vi } from "vitest";

// `expo-sqlite` (imported by `bootstrap`'s default opener) pulls in `expo` → `react-native`, whose
// Flow source vitest cannot parse. The boot test injects its own connection, so the module is stubbed
// and never touched — the same reason `expoConnection.test.ts` stubs it.
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: vi.fn(async () => ({ marker: "db" })) }));

// The `node:sqlite` adapter is for tests and CI only (invariant 5); the app supplies its own on device.
// It is reached here by its deep specifier — the same rule the engine/provider door uses — so `boot`'s
// real sequence is exercised without `expo-sqlite`.
import {
  asAsyncConnection,
  readGateConfig,
  type AsyncSqliteConnection,
  type SqliteConnection,
} from "@astrolab/core";
import { openNodeConnection } from "@astrolab/core/dist/store/connection.node.js";

import { boot, startScreen, type StartScreen } from "./bootstrap";

/**
 * The boot sequence, proven end to end over `node:sqlite`.
 *
 * M1's acceptance is "the shell boots to S0/S1". `expo-sqlite` is a native module, so the *device*
 * half is the device row (Task 9) — but the **composition** (`openStoreAsync → bootVaultAsync →
 * vaultSummary → startScreen`) is engine-agnostic and runs here, on the same ports the app implements.
 * That is the strongest evidence this box can produce, and it is the plan's own method for the re-homed
 * flow tests (Task 8 consumes a `node:sqlite` connection the same way).
 *
 * **What green here does and does not mean.** The `node:fs`/`node:url`/`node:crypto` portability gap
 * this test used to flag is closed (#184 · #185), and the web boot's cold-worker write hazard is fixed
 * by running the boot on the async channel (#186 · #190). This test still isolates the *composition*
 * over `node:sqlite`; the browser run is the only evidence for the web bundle itself (`app/README.md`).
 *
 * `node:sqlite` is synchronous, so its async plane is `asAsyncConnection(conn)` — the same calls, one
 * promise deep. That is exactly the point: the **rules** are channel-independent, so the composition
 * under test is the one the web app runs, and only the transport differs.
 */
function opened(conn: SqliteConnection): {
  conn: SqliteConnection;
  async: ReturnType<typeof asAsyncConnection>;
} {
  return { conn, async: asAsyncConnection(conn) };
}

describe("boot — brought up over node:sqlite", () => {
  test("a fresh vault boots to S0, with the taxonomy seeded", async () => {
    const conn = openNodeConnection(":memory:");
    const booted = await boot(async () => opened(conn));
    expect(booted.start).toBe<StartScreen>("S0");

    // Non-vacuity: the seed must have written clusters, or "S0" could be S0 for the wrong reason
    // (an unseeded taxonomy looks the same from `resolved_domains === 0`).
    const clusters = (
      conn.prepare("SELECT COUNT(*) AS n FROM domain_cluster").get() as { n: number }
    ).n;
    expect(clusters).toBeGreaterThan(0);
  });

  test("the sequence is idempotent — a second boot on the same connection is still S0", async () => {
    const conn = openNodeConnection(":memory:");
    await boot(async () => opened(conn));
    expect((await boot(async () => opened(conn))).start).toBe<StartScreen>("S0");
  });

  /**
   * #190's criterion 1, at the level the app actually runs it: **all five steps execute on app boot.**
   * The two that the composition root used to skip are the two with no other writer —
   * `seedGateConfig` and `requeueOrphanedRuns` — so each gets an assertion on the state it leaves.
   *
   * On the config half, note that `readGateConfig` alone proves nothing: it fills an **absent** key from
   * the code default, so a skipped seed and a correct one read identically. The row count is what
   * separates them.
   */
  test("the boot seeds the gate config and requeues an orphaned run — the two steps app boot skipped (#190)", async () => {
    const conn = openNodeConnection(":memory:");
    await boot(async () => opened(conn));

    expect(readGateConfig(conn)).toEqual({ minDomainDistance: 1, minAlignment: 0.02 });
    expect((conn.prepare("SELECT COUNT(*) AS n FROM config").get() as { n: number }).n).toBe(2);

    // A process killed mid-run leaves its row RUNNING (ADR-0004, invariant 16).
    conn.exec(
      `INSERT INTO spark_run (id, vault_revision, status, started_at, finished_at, error)
       VALUES ('orphan', 1, 'RUNNING', '2026-11-12T00:00:00Z', NULL, NULL)`,
    );

    await boot(async () => opened(conn));

    expect(
      conn.prepare("SELECT status, started_at FROM spark_run WHERE id = 'orphan'").get(),
    ).toEqual({ status: "PENDING", started_at: null });
  });

  test("the open is awaited — a refused open rejects, and does not half-run the sequence (#186)", async () => {
    await expect(
      boot(async () => {
        throw new Error("open refused");
      }),
    ).rejects.toThrow("open refused");
  });

  /**
   * The #186/#190 ordering rule, asserted rather than described: **the async boot is fully awaited before
   * the first sync read.**
   *
   * The gate is on the **last** async step — the orphan requeue's `UPDATE`, which `bootVaultAsync` awaits
   * after the schema, the taxonomy and the gate seeds. While it is parked, the sync plane must still be
   * untouched: `vaultSummary` is the first sync read, and it comes after *every* async step.
   *
   * Gating the **last** step rather than the first is what makes the claim about the whole sequence, and
   * that is measured, not assumed (2026-11-12). On a scratch copy, gating the first seed upsert stayed
   * **green** when `core/src/boot.ts`'s final `await requeueOrphanedRunsAsync(conn)` was replaced with
   * `void requeueOrphanedRunsAsync(conn)` — with the `asAsyncConnection` fixture the started-but-unawaited
   * chain drained before the boot resolved, so neither the ordering nor the resulting database could see
   * it. This shape reddens that mutation, and — checked on the same scratch copy — only this test.
   */
  test("the async boot is fully awaited before the first sync read (#186, #190)", async () => {
    const real = openNodeConnection(":memory:");
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parked = false;

    const plane = asAsyncConnection(real);
    // Only the requeue's statement parks; every step before it runs normally. It needs no rows to park —
    // that the requeue *moves* a row is the criterion-1 test's subject, not this one's.
    const gated: AsyncSqliteConnection = {
      ...plane,
      run: async (sql, params) => {
        if (/^\s*UPDATE spark_run\b/.test(sql)) {
          events.push("async:requeue-parked");
          parked = true;
          await gate;
          events.push("async:requeue");
        }
        return plane.run(sql, params);
      },
    };

    const syncPlane: SqliteConnection = {
      exec: (sql: string): void => {
        events.push(`sync:exec:${sql}`);
        return real.exec(sql);
      },
      prepare: (sql: string): ReturnType<SqliteConnection["prepare"]> => {
        events.push(`sync:prepare:${sql}`);
        return real.prepare(sql);
      },
      close: (): void => real.close(),
    };

    const pending = boot(async () => ({ conn: syncPlane, async: gated }));

    // Let `boot` run up to the requeue gate.
    for (let i = 0; i < 200_000 && !parked; i++) await Promise.resolve();

    // Non-vacuity: the boot reached the step this test exists to gate, and it is genuinely parked.
    expect(parked).toBe(true);
    // The ordering rule: while the last async step is in flight, the sync plane is untouched.
    expect(events.filter((event) => event.startsWith("sync:"))).toEqual([]);

    release();
    expect((await pending).start).toBe<StartScreen>("S0");

    // Non-vacuity: the gate was passed, the sync plane *is* used after the boot (`vaultSummary` reads it),
    // and it is used only after the last async step.
    const firstSync = events.findIndex((event) => event.startsWith("sync:"));
    expect(events.indexOf("async:requeue")).toBeGreaterThan(-1);
    expect(firstSync).toBeGreaterThan(events.indexOf("async:requeue"));
  });
});

describe("startScreen — the S0/S1 decision reads core's shipped predicate", () => {
  const summary = (resolved: number): Parameters<typeof startScreen>[0] => ({
    resolved_domains: resolved,
    provisional_domains: 0,
    target: 3,
    floor: 2,
    eligible: resolved >= 2,
  });

  test("below the floor is S0", () => {
    expect(startScreen(summary(1))).toBe<StartScreen>("S0");
  });

  test("at the floor is S1", () => {
    expect(startScreen(summary(2))).toBe<StartScreen>("S1");
  });
});
