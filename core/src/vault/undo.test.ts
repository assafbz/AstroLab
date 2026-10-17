import type { SqliteConnection } from "../store/connection.js";
import { openNodeStore } from "../store/connection.node.js";

import { MIGRATIONS, migrate } from "../store/index.js";
import { describe, expect, test } from "vitest";

import { captureIdea, ConflictError, NotFoundError, type CaptureInput } from "./capture.js";
import { resolveDecision } from "./decision.js";
import { undoDecision } from "./undo.js";

/**
 * K6 (`#40`) — `POST /v1/decisions/{decision_id}/undo` (`docs/API.md` §4.15; `FLOW.md` §5.4 / T12 /
 * N3), at the layer that owns the write. The route covers **all three** resolving paths — deck
 * ACCEPT, deck DISMISS, and a committed seeded save — and is *permanent* once the window closes.
 *
 * Four properties are *checks*, not readings:
 *
 * - **the retract is V5's delete semantics** — the derived idea and its own rows (version, mechanism,
 *   provenance) go, and a live offer built from it is retracted, exactly as `deleteIdea` does;
 * - **the re-offer** — the spark returns to `OFFERED` and a DISMISS's negative signal is cleared;
 * - **the window + the four 409 arms** — superseded / expired / edited / missing, in §4.15's order,
 *   with the `404` ahead of them all and the retract last, so a refused undo writes nothing;
 * - **the vault trigger** — `decision` is one of §4's four tables, so an undo stamps and enqueues.
 */

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function revision(db: SqliteConnection): number {
  return (db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as { revision: number })
    .revision;
}

function count(db: SqliteConnection, table: string, params: string[] = []): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(...params) as { n: number }).n;
}

function seedIdeas(
  db: SqliteConnection,
  rows: ReadonlyArray<readonly [string, readonly string[]]>,
): void {
  for (const [id, tags] of rows) {
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
    ).run(id, JSON.stringify(tags));
  }
}

function seedPair(db: SqliteConnection): void {
  seedIdeas(db, [
    ["a", ["fintech"]],
    ["b", ["health", "fintech"]],
  ]);
}

function seedSpark(
  db: SqliteConnection,
  id: string,
  a: string,
  b: string,
  status = "OFFERED",
): void {
  const [x, y] = [a, b].sort();
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, first_step,
                        status, created_at)
     VALUES (?, ?, ?, ?, 'a direction', 'a claim', 'a first step', ?, 't')`,
  ).run(id, a, b, `${x}|${y}`, status);
}

/** A committed seeded save through the real writer, so its `decision` row is the one §4.2 makes. */
function seededSave(decisionId: string): CaptureInput {
  return {
    hypothesis: "a seeded idea",
    problem: "p",
    monetization: "m",
    domain_tags: ["fintech"],
    origin_spark_id: "s1",
    decision_id: decisionId,
  };
}

describe("undoDecision — ACCEPT undo (§4.15)", () => {
  test("retracts the derived idea and its rows, clears the resolution, re-offers the spark", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    const decision = resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    const derived = decision.result_idea_id as string;

    const result = undoDecision(db, "d1");

    expect(result).toEqual({
      undone: true,
      spark_id: "s1",
      spark_status: "OFFERED",
      retracted_idea_id: derived,
    });
    // V5's delete semantics: the idea and its own rows are gone (the cascade takes the version, the
    // mechanism cache and the provenance edges); the two sources stay.
    expect(count(db, "idea")).toBe(2);
    expect(count(db, "idea_version")).toBe(0);
    expect(count(db, "provenance_edge")).toBe(0);
    // The resolution is cleared and the card is back in the deck.
    expect(count(db, "decision")).toBe(0);
    expect(db.prepare("SELECT status FROM spark WHERE id = 's1'").get()).toEqual({
      status: "OFFERED",
    });
  });

  test("a live offer built from the retracted idea is retracted too — a promise from stale state", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    const decision = resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    const derived = decision.result_idea_id as string;
    // A separate pair, one side of which is the just-derived idea — the engine would have offered it.
    seedIdeas(db, [["z", ["edu"]]]);
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES ('live', ?, 'z', ?, 'd', 'c', 'OFFERED', 't')`,
    ).run(derived, [derived, "z"].sort().join("|"));

    undoDecision(db, "d1");

    expect(count(db, "spark WHERE idea_a_id = ? OR idea_b_id = ?", [derived, derived])).toBe(0);
    expect(count(db, "spark")).toBe(1); // only s1, now OFFERED
  });

  test("the undo is a vault mutation — it stamps the revision and enqueues one run", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    const before = revision(db);

    undoDecision(db, "d1");

    expect(revision(db)).toBe(before + 1);
    expect(count(db, "spark_run")).toBe(1);
  });
});

describe("undoDecision — DISMISS undo (§4.15)", () => {
  test("clears the negative signal, re-offers the spark, and retracts no idea", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    resolveDecision(db, "s1", { decision_id: "d1", kind: "DISMISS" });

    const result = undoDecision(db, "d1");

    expect(result).toEqual({
      undone: true,
      spark_id: "s1",
      spark_status: "OFFERED",
      retracted_idea_id: null,
    });
    expect(count(db, "suppressed_pair")).toBe(0);
    expect(count(db, "decision")).toBe(0);
    expect(count(db, "idea")).toBe(2); // the two sources, untouched
    expect(db.prepare("SELECT status FROM spark WHERE id = 's1'").get()).toEqual({
      status: "OFFERED",
    });
  });
});

describe("undoDecision — a committed seeded save (§4.15 / N3)", () => {
  test("retracts the seeded idea and its provenance, and returns the spark to OFFERED", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    const idea = captureIdea(db, seededSave("d-insp"));
    expect(db.prepare("SELECT status FROM spark WHERE id = 's1'").get()).toEqual({
      status: "RESOLVED-INSPIRED",
    });

    const result = undoDecision(db, "d-insp");

    expect(result).toEqual({
      undone: true,
      spark_id: "s1",
      spark_status: "OFFERED",
      retracted_idea_id: idea.id,
    });
    expect(count(db, "idea")).toBe(2);
    expect(count(db, "provenance_edge")).toBe(0);
    expect(count(db, "decision")).toBe(0);
    expect(db.prepare("SELECT status FROM spark WHERE id = 's1'").get()).toEqual({
      status: "OFFERED",
    });
  });
});

describe("undoDecision — the four 409 arms and the 404 (§4.15)", () => {
  test("an unknown decision_id is `not_found`, and writes nothing", () => {
    const db = newDb();
    const before = revision(db);

    expect(() => undoDecision(db, "nope")).toThrow(NotFoundError);

    expect(revision(db)).toBe(before);
    expect(count(db, "spark_run")).toBe(0);
  });

  test("a later decision retires the window — `superseded`", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    seedIdeas(db, [
      ["c", ["govt"]],
      ["d", ["edu"]],
    ]);
    seedSpark(db, "s2", "c", "d");
    resolveDecision(db, "s2", { decision_id: "d2", kind: "DISMISS" });
    const before = revision(db);

    expect(() => undoDecision(db, "d1")).toThrow(ConflictError);

    expect(revision(db)).toBe(before);
    expect(count(db, "decision")).toBe(2);
    expect(count(db, "idea")).toBe(5); // a, b, the ACCEPT's derived idea, and c, d — all survive
  });

  test("a closed window retires it — `expired`, with `UNDO_WINDOW_SECONDS` the boundary", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    db.prepare("UPDATE decision SET decided_at = ? WHERE id = 'd1'").run("2000-01-01T00:00:00Z");
    const before = revision(db);

    expect(() => undoDecision(db, "d1")).toThrow(ConflictError);

    expect(revision(db)).toBe(before);
    expect(count(db, "decision")).toBe(1);
  });

  test("an edited derived idea retires it — `edited`", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    const decision = resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    db.prepare("UPDATE idea SET current_version = 2 WHERE id = ?").run(decision.result_idea_id);

    expect(() => undoDecision(db, "d1")).toThrow(ConflictError);
    expect(count(db, "decision")).toBe(1);
  });

  test("a deleted derived idea retires it — `missing` (nothing left to retract)", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    const decision = resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    db.prepare("DELETE FROM idea WHERE id = ?").run(decision.result_idea_id);

    expect(() => undoDecision(db, "d1")).toThrow(ConflictError);
    expect(count(db, "decision")).toBe(1);
  });

  test("undo is not idempotent — a repeat after success is a `404`, the row is gone", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    undoDecision(db, "d1");

    expect(() => undoDecision(db, "d1")).toThrow(NotFoundError);
  });
});
