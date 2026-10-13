import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { beforeEach, describe, expect, test } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import {
  MAX_HYPOTHESIS_LENGTH,
  NotFoundError,
  ValidationError,
  captureIdea,
  isoTimestamp,
  parseCaptureInput,
  type CaptureInput,
} from "./capture.js";

/** A fresh migrated in-memory vault, the same schema `main` ships (`0001_init` + `0002`). */
function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function revision(db: DatabaseSync): number {
  const row = db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as {
    revision: number;
  };
  return row.revision;
}

function count(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

function seedIdea(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', '["fintech"]', 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id);
}

function seedSpark(db: DatabaseSync, id: string, ideaA: string, ideaB: string): void {
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES (?, ?, ?, ?, 'merge them', 'why not', 'OFFERED', 't')`,
  ).run(id, ideaA, ideaB, `${ideaA}|${ideaB}`);
}

const blank: CaptureInput = {
  hypothesis: "A single sentence",
  problem: "a problem",
  monetization: "a model",
  domain_tags: ["fintech", "logistics"],
  origin_spark_id: null,
  decision_id: null,
};

describe("parseCaptureInput — docs/API.md §4.2 validation", () => {
  const valid = {
    hypothesis: "H",
    problem: "P",
    monetization: "M",
    domain_tags: ["fintech"],
  };

  test("accepts the minimum valid body and defaults both spark fields to null", () => {
    expect(parseCaptureInput(valid)).toEqual({
      ...valid,
      origin_spark_id: null,
      decision_id: null,
    });
  });

  test.each([
    ["missing hypothesis", { ...valid, hypothesis: undefined }],
    ["empty hypothesis", { ...valid, hypothesis: "" }],
    ["whitespace-only hypothesis", { ...valid, hypothesis: "   " }],
    ["missing problem", { ...valid, problem: undefined }],
    ["empty problem", { ...valid, problem: "" }],
    ["missing monetization", { ...valid, monetization: undefined }],
    ["empty monetization", { ...valid, monetization: "" }],
    ["missing domain_tags", { ...valid, domain_tags: undefined }],
    ["empty domain_tags", { ...valid, domain_tags: [] }],
    ["non-string domain tag", { ...valid, domain_tags: ["ok", 7] }],
    ["empty domain tag", { ...valid, domain_tags: ["  "] }],
    ["non-string hypothesis", { ...valid, hypothesis: 42 }],
    ["origin_spark_id without decision_id", { ...valid, origin_spark_id: "s1" }],
    ["decision_id without origin_spark_id", { ...valid, decision_id: "d1" }],
  ])("rejects %s", (_name, body) => {
    expect(() => parseCaptureInput(body)).toThrow(ValidationError);
  });

  test(`rejects hypothesis over ${MAX_HYPOTHESIS_LENGTH} characters, server-side`, () => {
    expect(() =>
      parseCaptureInput({ ...valid, hypothesis: "x".repeat(MAX_HYPOTHESIS_LENGTH + 1) }),
    ).toThrow(/exceeds 280/);
    expect(parseCaptureInput({ ...valid, hypothesis: "x".repeat(MAX_HYPOTHESIS_LENGTH) })).toEqual({
      ...valid,
      hypothesis: "x".repeat(MAX_HYPOTHESIS_LENGTH),
      origin_spark_id: null,
      decision_id: null,
    });
  });

  test("rejects a non-object body", () => {
    for (const body of [null, 42, "str", ["a"]]) {
      expect(() => parseCaptureInput(body)).toThrow(ValidationError);
    }
  });

  test("ignores unknown fields (§1)", () => {
    const parsed = parseCaptureInput({ ...valid, scores: 0.9, mechanism: "internal" });
    expect(parsed).not.toHaveProperty("scores");
  });
});

describe("captureIdea", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = newDb();
  });

  test("a blank capture writes the idea and its first version, and bumps the revision once", () => {
    const before = revision(db);
    const idea = captureIdea(db, blank);

    expect(idea).toMatchObject({
      hypothesis: blank.hypothesis,
      domain_tags: blank.domain_tags,
      lineage_kind: "ROOT",
      lineage_parent_id: null,
      status: "ACTIVE",
      visibility: "PRIVATE",
      current_version: 1,
    });
    expect(count(db, "idea")).toBe(1);
    expect(count(db, "idea_version")).toBe(1);
    expect(count(db, "decision")).toBe(0);
    expect(count(db, "provenance_edge")).toBe(0);
    expect(revision(db)).toBe(before + 1);

    const tags = db.prepare("SELECT domain_tags FROM idea").get() as { domain_tags: string };
    expect(JSON.parse(tags.domain_tags)).toEqual(blank.domain_tags);
  });

  test("a seeded capture writes idea, version, both provenance edges and the INSPIRED decision together", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    seedSpark(db, "spark-1", "src-a", "src-b");
    const before = revision(db);

    const idea = captureIdea(db, {
      ...blank,
      origin_spark_id: "spark-1",
      decision_id: "decision-1",
    });

    expect(count(db, "provenance_edge")).toBe(2);
    const sources = db
      .prepare("SELECT source_idea_id FROM provenance_edge ORDER BY source_idea_id")
      .all();
    expect(sources).toEqual([{ source_idea_id: "src-a" }, { source_idea_id: "src-b" }]);
    expect(db.prepare("SELECT * FROM decision").get()).toMatchObject({
      id: "decision-1",
      spark_id: "spark-1",
      kind: "INSPIRED",
      result_idea_id: idea.id,
    });
    expect(db.prepare("SELECT status FROM spark WHERE id = 'spark-1'").get()).toEqual({
      status: "RESOLVED-INSPIRED",
    });
    expect(revision(db)).toBe(before + 1);
  });

  test("is idempotent on decision_id: the repeat returns the first result and writes nothing", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    seedSpark(db, "spark-1", "src-a", "src-b");
    const seeded: CaptureInput = {
      ...blank,
      origin_spark_id: "spark-1",
      decision_id: "decision-1",
    };

    const first = captureIdea(db, seeded);
    const afterFirst = {
      ideas: count(db, "idea"),
      decisions: count(db, "decision"),
      revision: revision(db),
    };

    const second = captureIdea(db, seeded);

    expect(second).toEqual(first);
    expect({
      ideas: count(db, "idea"),
      decisions: count(db, "decision"),
      revision: revision(db),
    }).toEqual(afterFirst);
  });

  test("an unknown spark is not_found, and writes nothing", () => {
    const before = revision(db);

    expect(() =>
      captureIdea(db, { ...blank, origin_spark_id: "missing", decision_id: "decision-1" }),
    ).toThrow(NotFoundError);

    expect(count(db, "idea")).toBe(0);
    expect(count(db, "idea_version")).toBe(0);
    expect(count(db, "provenance_edge")).toBe(0);
    expect(count(db, "decision")).toBe(0);
    expect(revision(db)).toBe(before);
  });

  test("a failure after the first writes rolls the whole capture back", () => {
    // A spark whose two sources are the same idea: the second provenance edge violates the
    // (derived, source, spark) primary key — a failure *after* the idea, its version and the first
    // edge are written, so only a real ROLLBACK leaves the vault clean. The unknown-spark case
    // cannot earn this: it throws before writing anything.
    seedIdea(db, "src-a");
    seedSpark(db, "spark-dup", "src-a", "src-a");

    expect(() =>
      captureIdea(db, { ...blank, origin_spark_id: "spark-dup", decision_id: "decision-1" }),
    ).toThrow();

    expect(count(db, "idea")).toBe(1); // the seeded source only
    expect(count(db, "idea_version")).toBe(0);
    expect(count(db, "provenance_edge")).toBe(0);
    expect(count(db, "decision")).toBe(0);
    expect(revision(db)).toBe(0);
  });

  test("revision monotonicity: two captures, both stamped, ordered", () => {
    captureIdea(db, blank);
    const first = revision(db);
    captureIdea(db, blank);
    expect(revision(db)).toBe(first + 1);
  });

  test("isoTimestamp is the contract's UTC shape (§1)", () => {
    expect(isoTimestamp(new Date("2026-10-13T05:14:05.123Z"))).toBe("2026-10-13T05:14:05Z");
  });
});
