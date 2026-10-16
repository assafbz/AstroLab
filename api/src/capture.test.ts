import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { beforeEach, describe, expect, test } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConflictError,
  MAX_HYPOTHESIS_LENGTH,
  NotFoundError,
  ValidationError,
  captureIdea,
  derivedStatus,
  isoTimestamp,
  parseCaptureInput,
  type CaptureInput,
  type IdeaFields,
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

/** The run queue as the API leaves it: the stamp carried, and the state (ARCH §4). */
function pendingRuns(db: DatabaseSync): Array<{ vault_revision: number; status: string }> {
  return db
    .prepare("SELECT vault_revision, status FROM spark_run ORDER BY vault_revision")
    .all() as Array<{ vault_revision: number; status: string }>;
}

function seedIdea(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', '["fintech"]', 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id);
}

function seedSpark(
  db: DatabaseSync,
  id: string,
  ideaA: string,
  ideaB: string,
  status = "OFFERED",
): void {
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES (?, ?, ?, ?, 'merge them', 'why not', ?, 't')`,
  ).run(id, ideaA, ideaB, `${ideaA}|${ideaB}`, status);
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

describe("derivedStatus — the one status predicate (§4.13 mints it, §4.6 clears it)", () => {
  const complete: IdeaFields = {
    hypothesis: "H",
    problem: "P",
    monetization: "M",
    domain_tags: ["fintech"],
  };

  test("all four supplied → ACTIVE", () => {
    expect(derivedStatus(complete)).toBe("ACTIVE");
  });

  test("the ACCEPT case — a spark carries no monetization → NEEDS_COMPLETION (K4)", () => {
    expect(derivedStatus({ ...complete, monetization: "" })).toBe("NEEDS_COMPLETION");
  });

  test.each([
    ["hypothesis", ""],
    ["problem", ""],
    ["monetization", ""],
  ] as const)("a blank %s → NEEDS_COMPLETION", (field, value) => {
    expect(derivedStatus({ ...complete, [field]: value })).toBe("NEEDS_COMPLETION");
  });

  test("whitespace is not a supplied field", () => {
    expect(derivedStatus({ ...complete, problem: "   " })).toBe("NEEDS_COMPLETION");
  });

  test("no domain tag → NEEDS_COMPLETION (§5 invariant 1)", () => {
    expect(derivedStatus({ ...complete, domain_tags: [] })).toBe("NEEDS_COMPLETION");
  });
});

/**
 * The status rule is **one rule**. `derivedStatus` is defined once and every path that touches the
 * status calls it — §4.13's ACCEPT mints it (K4), §4.6's iterate clears it (#42), §4.7's fork derives
 * it (#137). A second, inline copy of the rule is the failure this guards: it would let the paths
 * disagree. Structural, so each scan carries its own non-vacuity assertion.
 */
describe("derivedStatus — one definition site, and the rule spelled once", () => {
  const SRC = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(SRC).filter(isShippedSource).sort();

  test("the scan reaches this package's real sources", () => {
    // Non-vacuity: a walk that saw nothing would make both assertions below pass for free.
    expect(sources.length).toBeGreaterThan(10);
    expect(sources).toEqual(
      expect.arrayContaining(["capture.ts", "decision.ts", "fork.ts", "iterate.ts"]),
    );
  });

  test("is defined once (capture.ts) and called by every path that touches the status", () => {
    const definitions: string[] = [];
    const callers: string[] = [];
    for (const name of sources) {
      const text = readFileSync(join(SRC, name), "utf8");
      if (/^export function derivedStatus\b/m.test(text)) definitions.push(name);
      else if (/\bderivedStatus\(/.test(text)) callers.push(name);
    }

    expect(definitions).toEqual(["capture.ts"]);
    expect(callers).toEqual(["decision.ts", "fork.ts", "iterate.ts"]);
  });

  test("the four-field completeness test is spelled once — a second inline copy is the fork", () => {
    const spelling = /\bmonetization\.trim\(\)\s*!==\s*""/;
    const sites = sources.filter((name) => spelling.test(readFileSync(join(SRC, name), "utf8")));

    expect(sites).toEqual(["capture.ts"]);
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

  test("a capture enqueues exactly one PENDING run at the stamp it just wrote (§4 trigger)", () => {
    captureIdea(db, blank);

    expect(pendingRuns(db)).toEqual([{ vault_revision: revision(db), status: "PENDING" }]);
  });

  test("a seeded capture enqueues a run too", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    seedSpark(db, "spark-1", "src-a", "src-b");

    captureIdea(db, { ...blank, origin_spark_id: "spark-1", decision_id: "decision-1" });

    expect(pendingRuns(db)).toEqual([{ vault_revision: revision(db), status: "PENDING" }]);
  });

  test("the idempotent repeat enqueues nothing (no bump, no run)", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    seedSpark(db, "spark-1", "src-a", "src-b");
    const seeded: CaptureInput = {
      ...blank,
      origin_spark_id: "spark-1",
      decision_id: "decision-1",
    };

    captureIdea(db, seeded);
    const first = pendingRuns(db);
    captureIdea(db, seeded);

    expect(pendingRuns(db)).toEqual(first);
  });

  test("isoTimestamp is the contract's UTC shape (§1)", () => {
    expect(isoTimestamp(new Date("2026-10-13T05:14:05.123Z"))).toBe("2026-10-13T05:14:05Z");
  });

  // #39 — the seeded save's two guards. Before this lane `captureIdea` recognised a committed
  // `decision_id` and returned its idea whatever spark was asked for, and it never looked at the
  // spark's state: one key could alias two saves, and a resolved spark could be saved again.

  test("a seeded save on a spark that is not OFFERED is 409, and writes nothing (#39)", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    seedSpark(db, "spark-res", "src-a", "src-b", "RESOLVED-INSPIRED");
    const before = revision(db);

    expect(() =>
      captureIdea(db, { ...blank, origin_spark_id: "spark-res", decision_id: "decision-1" }),
    ).toThrow(ConflictError);

    // Only a live offer may be seeded (§4.13's rule 4; FLOW §4.3 — the duplicate path H5 closes).
    expect(count(db, "idea")).toBe(2); // the two sources only
    expect(count(db, "decision")).toBe(0);
    expect(count(db, "provenance_edge")).toBe(0);
    expect(revision(db)).toBe(before); // a refused save stamps nothing
  });

  test("…and the same pair's *live* offer still saves — the guard's positive control (#39)", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    // One pair, two rows: `ux_spark_live` constrains `OFFERED` alone, so the resolved sibling coexists
    // and the only difference between the two saves is the status the guard reads.
    seedSpark(db, "spark-res", "src-a", "src-b", "RESOLVED-DISMISSED");
    seedSpark(db, "spark-live", "src-a", "src-b", "OFFERED");

    const idea = captureIdea(db, {
      ...blank,
      origin_spark_id: "spark-live",
      decision_id: "decision-1",
    });

    expect(idea.status).toBe("ACTIVE");
    expect(count(db, "decision")).toBe(1);
    expect(db.prepare("SELECT status FROM spark WHERE id = 'spark-live'").get()).toEqual({
      status: "RESOLVED-INSPIRED",
    });
    // …and the resolved sibling is untouched.
    expect(db.prepare("SELECT status FROM spark WHERE id = 'spark-res'").get()).toEqual({
      status: "RESOLVED-DISMISSED",
    });
  });

  test("a `decision_id` already recorded for another spark is 409, not a silent alias (#39)", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    seedIdea(db, "src-c");
    seedSpark(db, "spark-1", "src-a", "src-b");
    seedSpark(db, "spark-2", "src-a", "src-c"); // a distinct pair_key, so both are live offers
    const first = captureIdea(db, {
      ...blank,
      origin_spark_id: "spark-1",
      decision_id: "decision-1",
    });

    // The same key against a different card: returning `first` here would answer for the wrong spark.
    expect(() =>
      captureIdea(db, { ...blank, origin_spark_id: "spark-2", decision_id: "decision-1" }),
    ).toThrow(ConflictError);

    expect(count(db, "decision")).toBe(1);
    expect(db.prepare("SELECT spark_id, result_idea_id FROM decision").get()).toEqual({
      spark_id: "spark-1",
      result_idea_id: first.id,
    });
    expect(count(db, "idea")).toBe(4); // three sources + the one derived ROOT
    expect(db.prepare("SELECT status FROM spark WHERE id = 'spark-2'").get()).toEqual({
      status: "OFFERED",
    });
  });

  test("the repeat is answered before the already-resolved 409 — a retry of a committed save is legal (#39)", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    seedSpark(db, "spark-1", "src-a", "src-b");
    const seeded: CaptureInput = {
      ...blank,
      origin_spark_id: "spark-1",
      decision_id: "decision-1",
    };

    const first = captureIdea(db, seeded);
    // The first save left the spark RESOLVED-INSPIRED, so a state check *ahead* of the repeat — the
    // pre-#39 look-up returned the prior idea, but a naive guard would have 409'd here — must not fire.
    expect(db.prepare("SELECT status FROM spark WHERE id = 'spark-1'").get()).toEqual({
      status: "RESOLVED-INSPIRED",
    });
    expect(captureIdea(db, seeded)).toEqual(first);

    // A *different* key on the same, now-resolved spark is the state conflict (§4.13's rule 4).
    expect(() =>
      captureIdea(db, { ...blank, origin_spark_id: "spark-1", decision_id: "decision-2" }),
    ).toThrow(ConflictError);
    expect(count(db, "decision")).toBe(1);
  });

  test("an unknown spark is 404 even when its `decision_id` is committed elsewhere (#39, §4.13's order)", () => {
    seedIdea(db, "src-a");
    seedIdea(db, "src-b");
    seedSpark(db, "spark-1", "src-a", "src-b");
    captureIdea(db, { ...blank, origin_spark_id: "spark-1", decision_id: "decision-1" });
    const decisions = count(db, "decision");
    const ideas = count(db, "idea");

    // The key names a different spark and that spark does not exist: the id is consulted before the
    // key's cross-spark conflict, so the answer is `not_found` — the pre-#39 lookup would have returned
    // the first idea, which is exactly the alias this lane closes.
    expect(() =>
      captureIdea(db, { ...blank, origin_spark_id: "nope", decision_id: "decision-1" }),
    ).toThrow(NotFoundError);

    expect(count(db, "decision")).toBe(decisions);
    expect(count(db, "idea")).toBe(ideas);
  });
});

/** The shipped-source extension union, mirroring `worker/src/provider/boundary.test.ts` (tests are out). */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

function isShippedSource(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !TEST_FILE.test(name);
}
