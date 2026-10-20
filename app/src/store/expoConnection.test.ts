import { describe, expect, test, vi } from "vitest";

// `expo-sqlite` is a native module: loading it here would fail in CI. The adapter's *mapping* — the
// part that is green in CI and wrong on the device when it drifts — needs no engine, so the module is
// stubbed and only its call shape is asserted.
vi.mock("expo-sqlite", () => ({ openDatabaseSync: vi.fn(() => ({ marker: "db" })) }));

import { openDatabaseSync } from "expo-sqlite";

import {
  createExpoConnection,
  openDatabase,
  type ExpoDatabase,
  type ExpoStatement,
} from "./expoConnection";

/**
 * The adapter's parity test, CI half. It cannot run SQL — there is no engine in CI — so it asserts the
 * three things the port pins and the adapter is responsible for, and each has a discriminating case:
 *
 * 1. **Miss sentinel**: `get()` must answer `undefined`, never the `null` `expo-sqlite` returns
 *    (invariant 1c). The stub answers `null`; the assertion is `undefined`.
 * 2. **Row-id spelling**: `run()` must answer `lastInsertRowid`, not the engine's `lastInsertRowId`.
 * 3. **Statement lifetime**: every call finalises its statement, including when the call throws — the
 *    case a `try`/`finally` exists for and a plain "call `finalizeSync` after" would miss.
 *
 * The full SQL round-trip (`open → table → insert → read back → read a missing row`) needs a real
 * engine and lives in the device row: `expoConnection.device.test.ts`, run with `npm run test:device`
 * (plan Task 9). Named here so the split is not mistaken for a gap.
 */

/** A recording stub of the `expo-sqlite` database that returns canned statement results. */
function stubEngine(
  result: Partial<{ first: unknown; rows: unknown[]; changes: number; id: number }>,
): {
  db: ExpoDatabase;
  statements: string[];
  finalized: number;
  throwOnExecute: boolean;
} {
  const state = { statements: [] as string[], finalized: 0, throwOnExecute: false };
  const db: ExpoDatabase = {
    execSync: () => {},
    closeSync: () => {},
    prepareSync: (sql: string): ExpoStatement => {
      state.statements.push(sql);
      return {
        executeSync: () => {
          if (state.throwOnExecute) throw new Error("engine failure");
          return {
            changes: result.changes ?? 0,
            lastInsertRowId: result.id ?? 0,
            getFirstSync: () => (result.first ?? null) as never,
            getAllSync: () => (result.rows ?? []) as never,
          };
        },
        finalizeSync: () => {
          state.finalized += 1;
        },
      };
    },
  };
  return Object.assign(state, { db }) as never;
}

describe("createExpoConnection — the three pinned mappings", () => {
  test("a miss is undefined, not the engine's null (invariant 1c)", () => {
    const f = stubEngine({ first: null });
    expect(createExpoConnection(f.db).prepare("SELECT 1 AS n WHERE 0").get()).toBeUndefined();
  });

  test("a hit is passed through unchanged", () => {
    const f = stubEngine({ first: { n: 1 } });
    expect(createExpoConnection(f.db).prepare("SELECT 1 AS n").get()).toEqual({ n: 1 });
  });

  test("run() answers lastInsertRowid, not the engine's lastInsertRowId", () => {
    const f = stubEngine({ changes: 3, id: 42 });
    const out = createExpoConnection(f.db).prepare("INSERT INTO t (v) VALUES (?)").run("x");
    expect(out).toEqual({ changes: 3, lastInsertRowid: 42 });
    // The engine's spelling must not leak into the returned object.
    expect(out).not.toHaveProperty("lastInsertRowId");
  });

  test("each call prepares and finalises its own statement, even when the call throws", () => {
    const f = stubEngine({ rows: [{ a: 1 }] });
    expect(createExpoConnection(f.db).prepare("SELECT a FROM t").all()).toEqual([{ a: 1 }]);
    expect(f.finalized).toBe(1);

    f.throwOnExecute = true;
    expect(() => createExpoConnection(f.db).prepare("SELECT a FROM t").get()).toThrow(
      "engine failure",
    );
    // The throwing call still released its handle — this is what the `finally` is for.
    expect(f.finalized).toBe(2);
  });

  test("exec and close pass straight through, and bind params are forwarded", () => {
    const f = stubEngine({ rows: [] });
    const seen: string[] = [];
    const conn = createExpoConnection(f.db);
    conn.exec("PRAGMA foreign_keys = ON");
    const all = conn.prepare("SELECT ? AS v").all(7);
    seen.push(...f.statements);
    expect(all).toEqual([]);
    expect(seen).toEqual(["SELECT ? AS v"]);
  });
});

describe("openDatabase", () => {
  test("opens the named file through expo-sqlite's sync opener", () => {
    const conn = openDatabase("vault.db");
    expect(openDatabaseSync).toHaveBeenCalledWith("vault.db");
    expect(typeof conn.prepare).toBe("function");
  });

  test("defaults to the app's vault file name", () => {
    openDatabase();
    expect(openDatabaseSync).toHaveBeenCalledWith("astrolab.db");
  });
});
