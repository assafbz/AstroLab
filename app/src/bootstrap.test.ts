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
  type AsyncSqliteConnection,
  type SqliteConnection,
} from "@astrolab/core";
import { openNodeConnection } from "@astrolab/core/dist/store/connection.node.js";

import { boot, startScreen, type StartScreen } from "./bootstrap";

/**
 * The boot sequence, proven end to end over `node:sqlite`.
 *
 * M1's acceptance is "the shell boots to S0/S1". `expo-sqlite` is a native module, so the *device*
 * half is the device row (Task 9) — but the **composition** (`openStoreAsync → migrateAsync →
 * seedDomainTaxonomyAsync → vaultSummary → startScreen`) is engine-agnostic and runs here, on the same
 * ports the app implements. That is the strongest evidence this box can produce, and it is the plan's
 * own method for the re-homed flow tests (Task 8 consumes a `node:sqlite` connection the same way).
 *
 * **What green here does and does not mean.** The `node:fs`/`node:url`/`node:crypto` portability gap
 * this test used to flag is closed (#184 · #185), and the web boot's cold-worker write hazard is fixed
 * by running the boot on the async channel (#186). This test still isolates the *composition* over
 * `node:sqlite`; the browser run is the only evidence for the web bundle itself (`app/README.md`).
 *
 * `node:sqlite` is synchronous, so its async plane is `asAsyncConnection(conn)` — the same calls, one
 * promise deep. That is exactly the point: the **rules** are channel-independent, so the composition
 * under test is the one the web app runs, and only the transport differs.
 */
function opened(conn: SqliteConnection): { conn: SqliteConnection; async: ReturnType<typeof asAsyncConnection> } {
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

  test("the open is awaited — a refused open rejects, and does not half-run the sequence (#186)", async () => {
    await expect(
      boot(async () => {
        throw new Error("open refused");
      }),
    ).rejects.toThrow("open refused");
  });

  /**
   * The #186 ordering rule, asserted rather than described: **the async boot is fully awaited before the
   * first sync read.** The seed's first `run` is held open on a gate; while it is pending, the sync plane
   * must not have been touched — `vaultSummary` is the first sync read and it comes *after* every async
   * step. A boot that raced its own writes would fail this and would also flake gate 1.
   */
  test("the async boot is awaited before the first sync read (#186)", async () => {
    const real = openNodeConnection(":memory:");
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const plane = asAsyncConnection(real);
    // The first gated call: the seed's first upsert. Held until `release()`.
    const gated: AsyncSqliteConnection = {
      ...plane,
      run: async (sql, params) => {
        events.push("async:seed-run-pending");
        await gate;
        events.push("async:seed-run");
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

    // Let `boot` run up to the gate.
    while (!events.includes("async:seed-run-pending")) await Promise.resolve();

    // While the boot is mid-flight, the sync plane must be untouched — the ordering rule.
    expect(events.filter((event) => event.startsWith("sync:"))).toEqual([]);

    release();
    expect((await pending).start).toBe<StartScreen>("S0");

    // Non-vacuity: the sync plane *is* used, after boot — `vaultSummary` reads it.
    const firstSync = events.findIndex((event) => event.startsWith("sync:"));
    expect(firstSync).toBeGreaterThan(events.indexOf("async:seed-run"));
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
