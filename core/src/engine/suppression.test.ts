import type { DatabaseSync } from "node:sqlite";

import { currentVaultRevision, MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import type { MechanismDescriptor, SparkAdjudicator } from "../provider/index.js";
import { createAdjudicator } from "./adjudicate.js";
import type { DomainDistance } from "./domain.js";
import type { GatedPair } from "./gate.js";
import { createGate } from "./gate.js";
import type { MechanismCache } from "./mechanism.js";
import { createSuppression, type Suppression } from "./suppression.js";

/**
 * The settled-pair rule — "the vault has already decided this pair, so it is not re-offered"
 * (`ARCHITECTURE.md` §3.5; W7 #32, Done 2).
 *
 * Each case names a way the rule could silently do the wrong thing: re-offering a pair the vault has
 * already settled (the one failure the module exists to prevent), spending adjudication calls on it
 * anyway, or writing something that stamps the vault. The table-driven status/reason cases are the
 * point of D2 — "settled" must not depend on *which* status or *which* reason.
 *
 * The write's own properties (idempotent under retry, never over a user verdict, no stamp) are
 * guarded where the SQL is — `store/test/suppression.test.ts` — because `recordRejections` delegates
 * to it and a check here could not see the statement.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function seedIdea(db: DatabaseSync, id: string, status = "ACTIVE"): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, ?, 'PRIVATE', 1, 't', 't')`,
  ).run(id, JSON.stringify([id]), status);
}

function seedSpark(db: DatabaseSync, id: string, key: string, status: string): void {
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES (?, ?, ?, ?, 'd', 'c', ?, 't')`,
  ).run(id, ...key.split("|"), key, status);
}

function seedSuppression(db: DatabaseSync, key: string, reason: string): void {
  db.prepare(`INSERT INTO suppressed_pair (pair_key, reason, updated_at) VALUES (?, ?, 't')`).run(
    key,
    reason,
  );
}

function suppressedRows(
  db: DatabaseSync,
): Array<{ pair_key: string; reason: string; updated_at: string }> {
  return db
    .prepare("SELECT pair_key, reason, updated_at FROM suppressed_pair ORDER BY pair_key")
    .all() as Array<{ pair_key: string; reason: string; updated_at: string }>;
}

function descriptor(): MechanismDescriptor {
  return {
    verb: "route",
    object_class: "traffic",
    constraint: "peak load",
    transferable_structure: "overflow rerouted into a parallel channel",
  };
}

function pair(aId: string, bId: string): GatedPair {
  const [first, second] = [aId, bId].sort();
  return {
    key: `${first}|${second}`,
    aId,
    bId,
    a: descriptor(),
    b: descriptor(),
    distance: 1,
    alignment: 0.9,
  };
}

const keys = (pairs: readonly GatedPair[]): string[] => pairs.map((p) => p.key);

describe("createSuppression — the re-offer rule (§3.5, Done 2)", () => {
  test("identity when nothing is settled: content and order are W5's", () => {
    const db = newDb();
    const gated = [pair("a", "c"), pair("a", "d"), pair("c", "d")];

    const eligible = createSuppression(db).eligiblePairs(gated);

    expect(keys(eligible)).toEqual(["a|c", "a|d", "c|d"]);
    expect(eligible).toEqual(gated);
  });

  test("an empty candidate list stays empty, and reads nothing", () => {
    const db = newDb();

    expect(createSuppression(db).eligiblePairs([])).toEqual([]);
  });

  test("a `spark` row settles its pair in each of the four statuses (D2)", () => {
    for (const status of [
      "OFFERED",
      "RESOLVED-ACCEPTED",
      "RESOLVED-DISMISSED",
      "RESOLVED-INSPIRED",
    ]) {
      const db = newDb();
      seedSpark(db, "s", "a|b", status);

      const eligible = createSuppression(db).eligiblePairs([pair("a", "b"), pair("a", "c")]);

      // The accepted-pair retirement §3.5 states: `ux_spark_live` alone would allow a later re-offer.
      expect(keys(eligible), status).toEqual(["a|c"]);
    }
  });

  test("a `suppressed_pair` row settles its pair for every reason the column allows (D2)", () => {
    for (const reason of ["CLICHE", "NOISE", "DISMISSED"]) {
      const db = newDb();
      seedSuppression(db, "a|b", reason);

      // The *reader* is reason-agnostic; D5 is about the *writer* (nothing writes CLICHE). A row
      // seeded directly must still settle, or a reason the column permits would silently re-offer.
      const eligible = createSuppression(db).eligiblePairs([pair("a", "b"), pair("a", "c")]);

      expect(keys(eligible), reason).toEqual(["a|c"]);
    }
  });

  test("a settled pair is dropped before adjudication — it costs zero provider calls", async () => {
    const db = newDb();
    for (const id of ["a", "b", "c"]) seedIdea(db, id);
    seedSpark(db, "s", "a|b", "OFFERED");

    const cache: MechanismCache = {
      async descriptorFor() {
        return descriptor();
      },
    };
    const distance: DomainDistance = {
      async between() {
        return 2;
      },
    };
    const gate = createGate(db, cache, distance, { minDomainDistance: 1, minAlignment: 0.5 });

    const adjudicated: string[] = [];
    const adjudicator: SparkAdjudicator = {
      async adjudicate(a, b) {
        adjudicated.push([a.hypothesis, b.hypothesis].sort().join("|"));
        return null; // every pair the model sees is rejected — noise
      },
    };

    const gated = await gate.gatedPairs({ revision: 1, ideaIds: ["a", "b", "c"] });
    expect(keys(gated)).toEqual(["a|b", "a|c", "b|c"]); // W5 gates all three

    const suppression = createSuppression(db);
    const eligible = suppression.eligiblePairs(gated);
    expect(keys(eligible)).toEqual(["a|c", "b|c"]); // the settled pair is gone

    const { rejected } = await createAdjudicator(db, adjudicator).adjudicate(eligible);

    // The whole point: two calls, not three. The settled pair never reached the model.
    expect(adjudicated).toHaveLength(2);
    expect(rejected.map((r) => r.key)).toEqual(["a|c", "b|c"]);
    expect(suppression.recordRejections(rejected)).toBe(2);
    const rows = suppressedRows(db);
    expect(rows.map((row) => [row.pair_key, row.reason])).toEqual([
      ["a|c", "NOISE"],
      ["b|c", "NOISE"],
    ]);
    expect(rows.every((row) => row.updated_at.length > 0)).toBe(true);
  });

  test("reading is a pure read: `eligiblePairs` writes nothing (D6)", () => {
    const db = newDb();
    seedSpark(db, "s", "a|b", "OFFERED");
    seedSuppression(db, "c|d", "DISMISSED");
    const revisionBefore = currentVaultRevision(db);

    createSuppression(db).eligiblePairs([pair("a", "b"), pair("c", "d"), pair("e", "f")]);

    expect(suppressedRows(db)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spark").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
    expect(currentVaultRevision(db)).toBe(revisionBefore);
  });
});

describe("createSuppression — `recordRejections` is the rejection entry point (§3.3 step 3)", () => {
  test("records `NOISE` for exactly the rejected keys", () => {
    const db = newDb();

    const written = createSuppression(db).recordRejections([
      { key: "a|b", aId: "a", bId: "b" },
      { key: "a|c", aId: "a", bId: "c" },
    ]);

    expect(written).toBe(2);
    expect(suppressedRows(db).map((row) => [row.pair_key, row.reason])).toEqual([
      ["a|b", "NOISE"],
      ["a|c", "NOISE"],
    ]);
  });

  test("empty input writes no statement at all", () => {
    const db = newDb();

    expect(createSuppression(db).recordRejections([])).toBe(0);
    expect(suppressedRows(db)).toEqual([]);
  });

  test("a repeat write is a no-op — same rows, same `updated_at`", () => {
    const db = newDb();
    const suppression: Suppression = createSuppression(db);
    suppression.recordRejections([{ key: "a|b", aId: "a", bId: "b" }]);
    const after = suppressedRows(db);

    const written = suppression.recordRejections([{ key: "a|b", aId: "a", bId: "b" }]);

    expect(written).toBe(0);
    expect(suppressedRows(db)).toEqual(after);
  });

  test("a `DISMISSED` row is never clobbered by a rejection (the user's verdict wins)", () => {
    const db = newDb();
    seedSuppression(db, "a|b", "DISMISSED");

    const written = createSuppression(db).recordRejections([{ key: "a|b", aId: "a", bId: "b" }]);

    expect(written).toBe(0);
    expect(suppressedRows(db)).toEqual([{ pair_key: "a|b", reason: "DISMISSED", updated_at: "t" }]);
  });
});
