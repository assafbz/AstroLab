import { expect, test } from "vitest";

import { normalizeMiss, type SqlRow, type SqliteConnection } from "./connection.js";
import { openNodeConnection } from "./connection.node.js";

/**
 * The port's own contract, on the adapter CI runs. Every claim here is one the *device* adapter must
 * also satisfy — that is the whole reason the port exists — so the sentinel half is exercised against
 * a connection that answers the way `expo-sqlite` does rather than the way `node:sqlite` does.
 */

function withStore<T>(fn: (conn: SqliteConnection) => T): T {
  const conn = openNodeConnection(":memory:");
  try {
    conn.exec("CREATE TABLE t (k INTEGER PRIMARY KEY, label TEXT)");
    return fn(conn);
  } finally {
    conn.close();
  }
}

test("round-trips a row through exec / prepare / run / get / all / close", () => {
  withStore((conn) => {
    const insert = conn.prepare("INSERT INTO t (k, label) VALUES (?, ?)");
    expect(Number(insert.run(1, "one").changes)).toBe(1);
    expect(Number(insert.run(2, "two").changes)).toBe(1);

    expect(conn.prepare("SELECT label FROM t WHERE k = ?").get(1)).toEqual({ label: "one" });
    expect(conn.prepare("SELECT k FROM t ORDER BY k").all()).toEqual([{ k: 1 }, { k: 2 }]);
  });
});

test("a miss is undefined, not null — the sentinel the port pins", () => {
  withStore((conn) => {
    expect(conn.prepare("SELECT k FROM t WHERE k = ?").get(99)).toBeUndefined();
    expect(conn.prepare("SELECT k FROM t WHERE k = ?").all(99)).toEqual([]);
  });
});

/**
 * The device divergence, reproduced and then closed (invariant 1c).
 *
 * `node:sqlite`'s `get()` answers `undefined`; `expo-sqlite`'s `getFirstSync()` answers `null`. The
 * v1 storage code branches on `=== undefined` (`store/src/runs.ts` — a missing singleton must fail
 * loudly), so the `null` an unmapped device adapter returns is *silently* the wrong path: CI green,
 * device broken. This test holds both ends: the reproduction, and the mapping that closes it.
 */
test("an engine that answers null on a miss is mapped, or the sentinel reaches the caller", () => {
  // `expo-sqlite`'s `getFirstSync()`, in one line: no row is `null`, not `undefined`.
  const engineMiss = (): SqlRow | null => null;

  // A v1-shaped reader (`store/src/runs.ts`): only `undefined` means a miss, and a miss is loud.
  const readLoudly = (get: () => SqlRow | null | undefined): string => {
    const row = get();
    if (row === undefined) throw new Error("row is missing");
    return String(row?.["label"]);
  };

  // Unmapped, the device's `null` slips past the loud branch: CI green, device quietly wrong.
  expect(() => readLoudly(engineMiss)).not.toThrow();
  // Mapped, the sentinel is the port's and the same reader fails loudly.
  expect(() => readLoudly(() => normalizeMiss(engineMiss()))).toThrow("row is missing");
  // Pass-through on a hit, so the mapping cannot lose a row.
  expect(normalizeMiss({ label: "one" })).toEqual({ label: "one" });
});
