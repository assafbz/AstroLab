import type { SqliteConnection } from "../src/store/connection.js";

import { describe, expect, test } from "vitest";

import { currentVaultRevision, MIGRATIONS, migrate } from "../src/index.js";
import { openNodeStore } from "../src/store/connection.node.js";
import {
  clearSuppression,
  recordDismissal,
  recordNoise,
  type SuppressionReason,
} from "../src/store/suppression.js";

/**
 * `suppressed_pair`'s writes, at the layer that owns them (W7 #32, plan D3).
 *
 * Two writers in two packages share this table — the engine's `NOISE` and the API's `DISMISSED` — so
 * the properties that must hold for *both* are guarded here, where the SQL is: a rejection never
 * overrides the user, a dismissal always lands, and neither stamps the vault. The *rule* those rows
 * feed (settled ⇒ not re-offered) is the engine's, guarded beside it in
 * `worker/src/engine/suppression.test.ts`.
 */

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function suppressedRows(
  db: SqliteConnection,
): Array<{ pair_key: string; reason: string; updated_at: string }> {
  return db
    .prepare("SELECT pair_key, reason, updated_at FROM suppressed_pair ORDER BY pair_key")
    .all() as Array<{ pair_key: string; reason: string; updated_at: string }>;
}

function seedSuppression(db: SqliteConnection, key: string, reason: string): void {
  db.prepare(`INSERT INTO suppressed_pair (pair_key, reason, updated_at) VALUES (?, ?, 't')`).run(
    key,
    reason,
  );
}

describe("recordNoise — the model's rejection (§3.3 step 3)", () => {
  test("writes `NOISE` for exactly the keys it is given, and reports how many", () => {
    const db = newDb();

    expect(recordNoise(db, ["a|b", "a|c"])).toBe(2);

    expect(suppressedRows(db).map((row) => [row.pair_key, row.reason])).toEqual([
      ["a|b", "NOISE"],
      ["a|c", "NOISE"],
    ]);
    expect(suppressedRows(db).every((row) => row.updated_at.length > 0)).toBe(true);
  });

  test("empty input writes no statement and reports zero", () => {
    const db = newDb();

    expect(recordNoise(db, [])).toBe(0);
    expect(suppressedRows(db)).toEqual([]);
  });

  test("a repeat is a true no-op — same rows, same `updated_at`", () => {
    const db = newDb();
    recordNoise(db, ["a|b"]);
    const after = suppressedRows(db);

    expect(recordNoise(db, ["a|b"])).toBe(0);

    expect(suppressedRows(db)).toEqual(after);
  });

  test("counts only the keys it actually wrote — an existing one is skipped, a new one still lands", () => {
    const db = newDb();
    recordNoise(db, ["a|b"]);

    expect(recordNoise(db, ["a|b", "a|c"])).toBe(1);

    expect(suppressedRows(db).map((row) => row.pair_key)).toEqual(["a|b", "a|c"]);
  });

  test("a `DISMISSED` row is never overwritten by a rejection (the user's verdict wins)", () => {
    const db = newDb();
    seedSuppression(db, "a|b", "DISMISSED");

    expect(recordNoise(db, ["a|b"])).toBe(0);

    expect(suppressedRows(db)).toEqual([{ pair_key: "a|b", reason: "DISMISSED", updated_at: "t" }]);
  });
});

describe("recordDismissal / clearSuppression — the user's verdict and its undo (FLOW §4.3, §5.4)", () => {
  test("a dismissal is written, and its undo removes it — the one-step round trip", () => {
    const db = newDb();

    recordDismissal(db, "a|b");
    expect(suppressedRows(db).map((row) => [row.pair_key, row.reason])).toEqual([
      ["a|b", "DISMISSED"],
    ]);

    clearSuppression(db, "a|b");
    expect(suppressedRows(db)).toEqual([]);
  });

  test("a dismissal replaces a rejection — the later, user-owned verdict is the one that stands", () => {
    const db = newDb();
    recordNoise(db, ["a|b"]);
    const noiseRow = suppressedRows(db)[0]!;

    recordDismissal(db, "a|b");

    expect(suppressedRows(db)).toHaveLength(1);
    expect(suppressedRows(db)[0]!.reason).toBe("DISMISSED");
    expect(suppressedRows(db)[0]!.updated_at).not.toBe("");
    expect(noiseRow.reason).toBe("NOISE");
  });

  test("clearing a pair with no row is a no-op, not an error (a repeated undo)", () => {
    const db = newDb();

    expect(() => clearSuppression(db, "a|b")).not.toThrow();
    expect(suppressedRows(db)).toEqual([]);
  });
});

describe("the suppression write is not a vault mutation (§4; plan D6)", () => {
  test("no revision bump and no run — from either writer — with exactly the rows expected", () => {
    const db = newDb();
    const before = currentVaultRevision(db);

    recordNoise(db, ["a|b", "a|c"]);
    recordDismissal(db, "d|e");
    clearSuppression(db, "a|c");

    expect(currentVaultRevision(db)).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
    expect(suppressedRows(db).map((row) => row.pair_key)).toEqual(["a|b", "d|e"]);
  });
});

describe("`CLICHE` has no writer (plan D5)", () => {
  test("the vocabulary has no third value — a caller cannot name the gate's verdict", () => {
    // The gate's drop is recomputed from the vault on every run (§3.5), so persisting it would freeze
    // a state-dependent verdict. This asserts the *type* refuses it; the writers below assert the same
    // thing structurally — neither takes a reason argument, so `CLICHE` has no path even if this type
    // ever widened. Widen `SuppressionReason` and this directive becomes unused, failing `typecheck`:
    // that is the mutation this check is here to catch.
    // @ts-expect-error — `CLICHE` is deliberately outside `SuppressionReason`.
    const cliche: SuppressionReason = "CLICHE";

    expect(cliche).toBe("CLICHE");
  });
});
