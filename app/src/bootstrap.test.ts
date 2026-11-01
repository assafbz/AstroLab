import { describe, expect, test, vi } from "vitest";

// `expo-sqlite` (imported by `bootstrap`'s default opener) pulls in `expo` → `react-native`, whose
// Flow source vitest cannot parse. The boot test injects its own connection, so the module is stubbed
// and never touched — the same reason `expoConnection.test.ts` stubs it.
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: vi.fn(async () => ({ marker: "db" })) }));

// The `node:sqlite` adapter is for tests and CI only (invariant 5); the app supplies its own on device.
// It is reached here by its deep specifier — the same rule the engine/provider door uses — so `boot`'s
// real sequence is exercised without `expo-sqlite`.
import { openNodeConnection } from "@astrolab/core/dist/store/connection.node.js";

import { boot, startScreen, type StartScreen } from "./bootstrap";

/**
 * The boot sequence, proven end to end over `node:sqlite`.
 *
 * M1's acceptance is "the shell boots to S0/S1". `expo-sqlite` is a native module, so the *device*
 * half is the device row (Task 9) — but the **composition** (`openStore → migrate → seedDomainTaxonomy
 * → vaultSummary → startScreen`) is engine-agnostic and runs here, on the same port the app
 * implements. That is the strongest evidence this box can produce, and it is the plan's own method for
 * the re-homed flow tests (Task 8 consumes a `node:sqlite` connection the same way).
 *
 * **What green here does and does not mean.** The `node:fs`/`node:url`/`node:crypto` portability gap this
 * test used to flag is closed (#184 · #185 — the entry carries a bundled taxonomy and an id port), and the
 * web boot's remaining blocker, the cold-worker open, is fixed in `openDatabase` (#186). This test still
 * isolates the *composition* over `node:sqlite`; the browser run is the only evidence for the web bundle
 * itself and is recorded separately (`app/README.md`).
 */
describe("boot — brought up over node:sqlite", () => {
  test("a fresh vault boots to S0, with the taxonomy seeded", async () => {
    const conn = openNodeConnection(":memory:");
    const booted = await boot(async () => conn);
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
    await boot(async () => conn);
    expect((await boot(async () => conn)).start).toBe<StartScreen>("S0");
  });

  test("the open is awaited — a refused open rejects, and does not half-run the sequence (#186)", async () => {
    await expect(
      boot(async () => {
        throw new Error("open refused");
      }),
    ).rejects.toThrow("open refused");
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
