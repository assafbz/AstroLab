import type { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { currentVaultRevision, MIGRATIONS, migrate, openStore } from "../src/index.js";
import {
  insertOfferedSparks,
  LIVE_STATUS,
  liveOffers,
  retractOffersOutside,
  type OfferedSpark,
} from "../src/sparks.js";
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

/**
 * The deck read (K1 `#35`, `docs/API.md` §4.9). Three properties are a *check* rather than a
 * reading — the resolved spark that must not surface, the derived `domain_tags`, and the projection's
 * five fields — and each one is mutable: dropping the `status` filter, sorting the union, or
 * returning the row instead of the projection reddens exactly one of them.
 */
describe("liveOffers — the deck read (K1 #35, §4.9)", () => {
  /** An idea with explicit tags: `seed.ts`'s `insertIdea` hard-codes `["x"]`, which cannot discriminate. */
  function taggedIdea(db: DatabaseSync, id: string, tags: string[]): void {
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
    ).run(id, JSON.stringify(tags));
  }

  test("live offers only, in insertion order — a resolved spark never reaches the deck", () => {
    const db = newDb();
    // The lexicographically-**later** pair goes in **first**, so `rowid` order and `pair_key` order
    // differ and neither can stand in for the other (Max, #35 slice-1 review).
    insertOfferedSparks(db, [offer({ idea_b_id: "c", pair_key: "a|c", direction: "second" })], "t");
    insertOfferedSparks(db, [offer({ direction: "first" })], "t");
    // History keeps its pair (`0003` dropped the FKs so the ids may dangle), and a resolved spark is
    // exactly the row §4.9 must not hand back — this is the row the missing `status` filter would leak.
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES ('s-res', 'b', 'c', 'b|c', 'resolved', 'c', 'RESOLVED-ACCEPTED', 't')`,
    ).run();

    // Every row shares `created_at = 't'` (second-resolution, `API.md` §1), so only the insertion
    // sequence can produce this order: `ORDER BY created_at` would leave it unchanged, and both
    // `ORDER BY pair_key ASC` and a dropped clause would sort it the other way (`a|b` before `a|c`).
    expect(liveOffers(db).map((row) => row.direction)).toEqual(["second", "first"]);
  });

  test("the projection is the contract's five fields — no mechanism, no scores, no source ids", () => {
    const db = newDb();
    insertOfferedSparks(db, [offer()], "t");

    // `toEqual` is exact: an extra key (the row's `mechanism`, `domain_distance`, …) fails it.
    expect(liveOffers(db)).toEqual([
      {
        id: expect.any(String),
        direction: "A direction",
        claim: "A claim",
        domain_tags: ["x"],
        created_at: "t",
      },
    ]);
  });

  test("domain_tags is the pair-order union, deduped — not sorted, and not either side's list", () => {
    const db = openStore(":memory:");
    migrate(db, MIGRATIONS);
    taggedIdea(db, "a", ["fintech", "audio-dsp"]);
    taggedIdea(db, "b", ["audio-dsp", "health"]);
    insertOfferedSparks(db, [offer()], "t");

    // Pair order (`idea_a_id` then `idea_b_id`), first appearance wins: a sort would give
    // `["audio-dsp", "fintech", "health"]`, and either single side would be a prefix of this.
    const [first] = liveOffers(db);
    expect(first?.domain_tags).toEqual(["fintech", "audio-dsp", "health"]);
    // Deterministic across reads — nothing here depends on hash or row order.
    expect(liveOffers(db)[0]?.domain_tags).toEqual(first?.domain_tags);
  });

  test("a live offer whose source is gone is still listed — the count and the deck describe one set", () => {
    const db = openStore(":memory:");
    migrate(db, MIGRATIONS);
    taggedIdea(db, "a", ["fintech"]);
    taggedIdea(db, "b", ["health"]);
    insertOfferedSparks(db, [offer()], "t");
    // `0003` dropped `spark.idea_a_id`'s FK, so this row can exist; in the shipped paths only
    // `delete.ts` removes an idea, and it retracts the live offer in the same transaction. An inner
    // join here would silently drop the row that `engineState`'s `unreviewed` still counts.
    db.prepare("DELETE FROM idea WHERE id = 'a'").run();

    const deck = liveOffers(db);
    expect(deck).toHaveLength(1);
    expect(deck[0]?.domain_tags).toEqual(["health"]);
  });

  test("an empty deck is an empty array", () => {
    expect(liveOffers(newDb())).toEqual([]);
  });

  test("LIVE_STATUS is the predicate the shipped index carries — the const and the DDL cannot drift", () => {
    const db = newDb();
    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_spark_live'")
      .get() as { sql: string } | undefined;

    // Non-vacuity: the query found the shipped index, so the `toContain` below is not scanning "".
    expect(index?.sql).toContain("CREATE UNIQUE INDEX ux_spark_live");
    expect(index?.sql).toContain(`status = '${LIVE_STATUS}'`);
  });
});
