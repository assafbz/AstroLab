import type { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { currentVaultRevision, MIGRATIONS, migrate, openStore } from "../src/index.js";
import { insertOfferedSparks, retractOffersOutside, type OfferedSpark } from "../src/sparks.js";
import { insertIdea } from "./seed.js";

/**
 * `spark`'s engine-side writes, at the layer that owns them (W8 #33, plan D1).
 *
 * Two properties are load-bearing and both are asserted here rather than argued in prose:
 *
 * - **a repeat cannot double-offer** (the `ux_spark_live` guard) — `POST /v1/sparks/run` is idempotent
 *   per revision and a crash-requeue re-runs a claim (`ADR-0004`), so the same confirmed pair can
 *   reach this function twice;
 * - **neither write stamps the vault or enqueues a run** — `spark` is not one of §4's four trigger
 *   tables, and a run whose writes stamped would enqueue its own successor forever.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  insertIdea(db, "a");
  insertIdea(db, "b");
  insertIdea(db, "c");
  return db;
}

function offer(over: Partial<OfferedSpark> = {}): OfferedSpark {
  return {
    idea_a_id: "a",
    idea_b_id: "b",
    pair_key: "a|b",
    direction: "A direction",
    claim: "A claim",
    what_it_takes: "what it takes",
    first_step: "a first step",
    mechanism: '{"verb":"fuse"}',
    domain_distance: 2,
    structural_alignment: 0.71,
    ...over,
  };
}

function sparkRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT pair_key, status, direction, mechanism, domain_distance, structural_alignment
         FROM spark ORDER BY pair_key`,
    )
    .all() as Array<Record<string, unknown>>;
}

describe("insertOfferedSparks — a confirmed pair becomes a live offer", () => {
  test("writes one `OFFERED` row per pair, with the draft and the internal scores", () => {
    const db = newDb();

    expect(insertOfferedSparks(db, [offer()], "2026-10-14T12:00:00Z")).toBe(1);

    expect(sparkRows(db)).toEqual([
      {
        pair_key: "a|b",
        status: "OFFERED",
        direction: "A direction",
        mechanism: '{"verb":"fuse"}',
        domain_distance: 2,
        structural_alignment: 0.71,
      },
    ]);
    const created = db.prepare("SELECT created_at FROM spark").get() as { created_at: string };
    expect(created.created_at).toBe("2026-10-14T12:00:00Z");
  });

  test("empty input writes nothing and reports zero", () => {
    const db = newDb();

    expect(insertOfferedSparks(db, [], "t")).toBe(0);
    expect(sparkRows(db)).toEqual([]);
  });

  test("a repeat of the same pair offers nothing new and leaves the first row alone", () => {
    const db = newDb();
    insertOfferedSparks(db, [offer({ direction: "first" })], "t");

    // A crash-requeue re-running the same claim: the pair is already live, so `ux_spark_live` must
    // not turn a legal re-run into a thrown run.
    expect(insertOfferedSparks(db, [offer({ direction: "second" })], "t")).toBe(0);

    expect(sparkRows(db)).toEqual([
      {
        pair_key: "a|b",
        status: "OFFERED",
        direction: "first",
        mechanism: '{"verb":"fuse"}',
        domain_distance: 2,
        structural_alignment: 0.71,
      },
    ]);
  });

  test("a second pair is a second row", () => {
    const db = newDb();

    expect(
      insertOfferedSparks(db, [offer(), offer({ idea_b_id: "c", pair_key: "a|c" })], "t"),
    ).toBe(2);
    expect(sparkRows(db).map((row) => row.pair_key)).toEqual(["a|b", "a|c"]);
  });
});

describe("retractOffersOutside — a live offer is not history (§4 recompute)", () => {
  function withOffers(): DatabaseSync {
    const db = newDb();
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES ('s1', 'a', 'b', 'a|b', 'd', 'c', 'OFFERED', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES ('s2', 'a', 'c', 'a|c', 'd', 'c', 'OFFERED', 't')`,
    ).run();
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES ('s3', 'a', 'b', 'a|b', 'd', 'c', 'RESOLVED-ACCEPTED', 't')`,
    ).run();
    return db;
  }

  test("removes a live offer whose idea fell out of the candidate set, and only that one", () => {
    const db = withOffers();

    expect(retractOffersOutside(db, ["a", "b", "c"])).toBe(0);

    // `c` dropped out (deleted, or no domain, or NEEDS_COMPLETION — the candidate set is what decides).
    expect(retractOffersOutside(db, ["a", "b"])).toBe(1);
    expect(sparkRows(db).map((row) => [row.pair_key, row.status])).toEqual([
      ["a|b", "OFFERED"],
      ["a|b", "RESOLVED-ACCEPTED"],
    ]);
  });

  test("a resolved spark is history — it keeps its pair even when its ideas are candidates", () => {
    const db = withOffers();

    retractOffersOutside(db, []);

    // Every live offer is outside an empty candidate set; the resolved row survives.
    expect(sparkRows(db)).toEqual([
      {
        pair_key: "a|b",
        status: "RESOLVED-ACCEPTED",
        direction: "d",
        mechanism: null,
        domain_distance: null,
        structural_alignment: null,
      },
    ]);
  });

  test("a resolved spark stays outside a non-empty set too — the `status` filter is the guard", () => {
    const db = withOffers();

    // `b` is outside a candidate set that is *not* empty, so `a|b` is swept — but only the live row:
    // nothing but the `status = 'OFFERED'` filter separates the resolved `a|b` from it, so dropping
    // that filter sweeps history with the offer. (The empty-set case above cannot see this arm.)
    expect(retractOffersOutside(db, ["a", "c"])).toBe(1);

    expect(sparkRows(db).map((row) => [row.pair_key, row.status])).toEqual([
      ["a|b", "RESOLVED-ACCEPTED"],
      ["a|c", "OFFERED"],
    ]);
  });
});

describe("the engine's spark writes touch no vault state (C7)", () => {
  test("neither an offer nor a sweep moves the revision or enqueues a run", () => {
    const db = newDb();
    const before = currentVaultRevision(db);

    insertOfferedSparks(db, [offer()], "t");
    retractOffersOutside(db, ["a"]);

    expect(currentVaultRevision(db)).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
  });
});
