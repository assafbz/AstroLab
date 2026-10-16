import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { ConflictError, NotFoundError, ValidationError } from "./capture.js";
import { parseDecisionInput, resolveDecision, type DecisionInput } from "./decision.js";
/**
 * K4 (`#38`) — `POST /v1/sparks/{id}/decision` (`docs/API.md` §4.13, `§3.5`), at the layer that owns
 * the write. Four properties here are *checks*, not readings, and each is mutable:
 *
 * - **idempotency** on `decision_id` — a repeat returns the first `Decision` and writes nothing (not
 *   even a revision bump); a repeat is answered **before** the already-resolved `409`, or a retry
 *   after an interrupted commit would `409` instead of returning the first decision;
 * - **ACCEPT's prefill** — `direction→hypothesis`, `claim→problem`, `monetization` blank, `domain_tags`
 *   the pair's union — and the status it implies (`NEEDS_COMPLETION`, because a spark carries no
 *   monetization and `PRD.md` §2 makes it mandatory: T27 by construction);
 * - **DISMISS's negative signal** — `suppressed_pair(reason = 'DISMISSED')` and **no** vault node;
 * - **the vault trigger** — both paths are candidate-affecting (`decision` is one of §4's four tables),
 *   so both stamp the revision and enqueue exactly one run.
 */

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

/** The two sources a spark pairs, with distinct tags so the union is observable. */
function seedPair(db: DatabaseSync): void {
  for (const [id, tags] of [
    ["a", ["fintech"]],
    ["b", ["health", "fintech"]],
  ] as const) {
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
    ).run(id, JSON.stringify(tags));
  }
}

function seedSpark(db: DatabaseSync, id: string, a: string, b: string, status = "OFFERED"): void {
  const [x, y] = [a, b].sort();
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, first_step,
                        status, created_at)
     VALUES (?, ?, ?, ?, 'a direction', 'a claim', 'a first step', ?, 't')`,
  ).run(id, a, b, `${x}|${y}`, status);
}

const accept: DecisionInput = { decision_id: "d-accept", kind: "ACCEPT" };
const dismiss: DecisionInput = { decision_id: "d-dismiss", kind: "DISMISS" };

describe("parseDecisionInput — docs/API.md §4.13's body", () => {
  test("accepts §4.13's two fields", () => {
    expect(parseDecisionInput({ decision_id: "d1", kind: "ACCEPT" })).toEqual({
      decision_id: "d1",
      kind: "ACCEPT",
    });
  });

  test("a missing or blank `decision_id` is 422 — it is the idempotency key", () => {
    expect(() => parseDecisionInput({ kind: "ACCEPT" })).toThrow(ValidationError);
    expect(() => parseDecisionInput({ decision_id: "", kind: "ACCEPT" })).toThrow(ValidationError);
    expect(() => parseDecisionInput({ decision_id: "  ", kind: "ACCEPT" })).toThrow(
      ValidationError,
    );
    expect(() => parseDecisionInput({ decision_id: 7, kind: "ACCEPT" })).toThrow(ValidationError);
  });

  test("`kind` is ACCEPT or DISMISS, case-sensitively — anything else is 422", () => {
    // §4.13 names two kinds: INSPIRE is not a resolution (§4.14) and the seeded save is §4.2's.
    for (const kind of [undefined, "", "accept", "ACCEPTED", "INSPIRED", 1, null]) {
      expect(() => parseDecisionInput({ decision_id: "d1", kind })).toThrow(ValidationError);
    }
  });

  test("a body that is not a JSON object is 422", () => {
    for (const body of [null, [], "ACCEPT", 7]) {
      expect(() => parseDecisionInput(body)).toThrow(ValidationError);
    }
  });
});

describe("resolveDecision — ACCEPT (§4.13)", () => {
  test("one transaction: the ROOT idea, its two provenance edges, the resolution and the decision", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");

    const decision = resolveDecision(db, "s1", accept);

    expect(decision).toEqual({
      decision_id: "d-accept",
      spark_id: "s1",
      kind: "ACCEPT",
      result_idea_id: expect.any(String),
      spark_status: "RESOLVED-ACCEPTED",
      decided_at: expect.any(String),
      undoable: true,
    });

    // §4.3 step 1/4 — the derived idea is a ROOT, prefilled from the spark where the spark can.
    const idea = db
      .prepare("SELECT * FROM idea WHERE id = ?")
      .get((decision.result_idea_id ?? "") as string) as Record<string, unknown>;
    expect(idea).toMatchObject({
      hypothesis: "a direction",
      problem: "a claim",
      monetization: "",
      domain_tags: JSON.stringify(["fintech", "health"]),
      lineage_kind: "ROOT",
      lineage_parent_id: null,
      status: "NEEDS_COMPLETION",
      visibility: "PRIVATE",
      current_version: 1,
    });
    expect(count(db, "idea_version")).toBe(1); // the derived idea's first version, written with the row
    expect(
      db
        .prepare("SELECT version, hypothesis FROM idea_version WHERE idea_id = ?")
        .get(decision.result_idea_id as string),
    ).toEqual({ version: 1, hypothesis: "a direction" });

    // §4.3 step 2 — provenance to **both** sources, each edge naming the spark.
    expect(
      db
        .prepare(
          "SELECT source_idea_id, spark_id FROM provenance_edge WHERE derived_idea_id = ? ORDER BY source_idea_id",
        )
        .all(decision.result_idea_id as string),
    ).toEqual([
      { source_idea_id: "a", spark_id: "s1" },
      { source_idea_id: "b", spark_id: "s1" },
    ]);

    // §4.3 step 3, and the decision row that keys the idempotency.
    expect(db.prepare("SELECT status FROM spark WHERE id = 's1'").get()).toEqual({
      status: "RESOLVED-ACCEPTED",
    });
    expect(db.prepare("SELECT id, spark_id, kind, result_idea_id FROM decision").all()).toEqual([
      {
        id: "d-accept",
        spark_id: "s1",
        kind: "ACCEPT",
        result_idea_id: decision.result_idea_id,
      },
    ]);
    // ACCEPT writes no negative signal: the spark row is what retires the pair (§3.5).
    expect(count(db, "suppressed_pair")).toBe(0);
  });

  test("the resolution is a vault mutation — it stamps the revision and enqueues one run", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    const before = revision(db);

    resolveDecision(db, "s1", accept);

    expect(revision(db)).toBe(before + 1);
    expect(db.prepare("SELECT vault_revision, status FROM spark_run").all()).toEqual([
      { vault_revision: before + 1, status: "PENDING" },
    ]);
  });

  test("every prefill lands `NEEDS_COMPLETION` — a spark carries no monetization (T27)", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");

    resolveDecision(db, "s1", accept);

    // Not a defect: `PRD.md` §2 makes monetization mandatory and the spark cannot supply it, so a
    // one-tap Good is saved-and-flagged, never silently complete.
    expect(
      db
        .prepare("SELECT status FROM idea WHERE lineage_kind = 'ROOT' AND id != 'a' AND id != 'b'")
        .get(),
    ).toEqual({ status: "NEEDS_COMPLETION" });
  });
});

describe("resolveDecision — DISMISS (§4.13)", () => {
  test("one transaction: the negative signal, the resolution and the decision — and no vault node", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    const before = revision(db);

    const decision = resolveDecision(db, "s1", dismiss);

    expect(decision).toEqual({
      decision_id: "d-dismiss",
      spark_id: "s1",
      kind: "DISMISS",
      result_idea_id: null,
      spark_status: "RESOLVED-DISMISSED",
      decided_at: expect.any(String),
      undoable: true,
    });

    // §4.3 DISMISS — no vault node is created, and the pair is kept as negative signal (§3.5).
    expect(count(db, "idea")).toBe(2);
    expect(count(db, "provenance_edge")).toBe(0);
    expect(db.prepare("SELECT pair_key, reason FROM suppressed_pair").all()).toEqual([
      { pair_key: "a|b", reason: "DISMISSED" },
    ]);
    expect(db.prepare("SELECT status FROM spark WHERE id = 's1'").get()).toEqual({
      status: "RESOLVED-DISMISSED",
    });
    expect(db.prepare("SELECT id, kind, result_idea_id FROM decision").all()).toEqual([
      { id: "d-dismiss", kind: "DISMISS", result_idea_id: null },
    ]);

    // `decision` is one of §4's four trigger tables, so a dismissal stamps and enqueues like any
    // other candidate-affecting write.
    expect(revision(db)).toBe(before + 1);
    expect(count(db, "spark_run")).toBe(1);
  });

  test("a dismissal replaces the model's noise for the same pair — the user owns the pair", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    db.prepare(
      `INSERT INTO suppressed_pair (pair_key, reason, updated_at) VALUES ('a|b', 'NOISE', 't')`,
    ).run();

    resolveDecision(db, "s1", dismiss);

    expect(db.prepare("SELECT reason FROM suppressed_pair").all()).toEqual([
      { reason: "DISMISSED" },
    ]);
  });
});

describe("resolveDecision — idempotency on `decision_id` (§4.13, FLOW §2.2/N4)", () => {
  test("a repeat returns the first `Decision` unchanged, and writes nothing", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    const first = resolveDecision(db, "s1", accept);
    const afterFirst = revision(db);
    const ideas = count(db, "idea");

    // The retry of an interrupted commit: the same key, and the spark is already resolved.
    const second = resolveDecision(db, "s1", accept);

    expect(second).toEqual(first);
    expect(count(db, "idea")).toBe(ideas);
    expect(count(db, "decision")).toBe(1);
    // "Writes nothing" is observable: `vaultMutation` stamps iff the body wrote, so a bump here would
    // mean the repeat wrote a row.
    expect(revision(db)).toBe(afterFirst);
    expect(count(db, "spark_run")).toBe(1);
  });

  test("the repeat is answered before the already-resolved `409`", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    resolveDecision(db, "s1", dismiss);

    // A *different* key on the same, now-resolved spark is the state conflict…
    expect(() => resolveDecision(db, "s1", accept)).toThrow(ConflictError);
    // …but the recorded key is the retry path, and must not be.
    expect(resolveDecision(db, "s1", dismiss).decision_id).toBe("d-dismiss");
  });

  test("a `decision_id` already recorded for another spark is a conflict, not a silent alias", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    seedSpark(db, "s2", "a", "b", "RESOLVED-DISMISSED");
    resolveDecision(db, "s1", accept);

    expect(() => resolveDecision(db, "s2", accept)).toThrow(ConflictError);
  });

  test("a second resolution of one spark is `409` — only a live offer may resolve", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    resolveDecision(db, "s1", accept);

    expect(() => resolveDecision(db, "s1", dismiss)).toThrow(ConflictError);
    expect(count(db, "decision")).toBe(1);
  });

  test("a refused second resolution writes nothing — the refusal rolls the transaction back", () => {
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    seedSpark(db, "s2", "a", "b", "RESOLVED-DISMISSED");
    const before = revision(db);

    expect(() => resolveDecision(db, "s2", dismiss)).toThrow(ConflictError);

    expect(count(db, "decision")).toBe(0);
    expect(count(db, "suppressed_pair")).toBe(0);
    expect(revision(db)).toBe(before);
  });

  test("one key, two connections to one file — the resolution is the store's, and the second sees it", () => {
    // The falsifiable form of the "no `SQLITE_CONSTRAINT` handler" claim (ruled at #38's slice 1).
    // `vaultMutation` opens `BEGIN IMMEDIATE`, so a second connection blocks at `BEGIN` until the first
    // commits; its transaction then *reads* the committed row, which is why the primary-key path never
    // fires and no bespoke handler is shipped. Delete the step-1 return and this reddens with a `409`
    // (the key-conflict branch, reached only because the second connection *did* read the committed
    // row), so the argument is checked rather than asserted.
    const dir = mkdtempSync(join(tmpdir(), "astrolab-k4-"));
    const path = join(dir, "vault.sqlite");
    const first = openStore(path);
    try {
      migrate(first, MIGRATIONS);
      seedPair(first);
      seedSpark(first, "s1", "a", "b");
      // A **second handle on the file** — `:memory:` would be a different database (the W8 lesson).
      const second = openStore(path);

      const committed = resolveDecision(first, "s1", accept);
      const replayed = resolveDecision(second, "s1", accept);

      expect(replayed).toEqual(committed);
      expect(count(second, "decision")).toBe(1);
      expect(count(second, "idea")).toBe(3); // the two sources + the one derived ROOT
      expect(count(second, "spark_run")).toBe(1);
      second.close();
    } finally {
      first.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveDecision — the §2 envelope cases", () => {
  test("an unknown spark is `not_found`, and writes nothing", () => {
    const db = newDb();
    seedPair(db);
    const before = revision(db);

    expect(() => resolveDecision(db, "nope", accept)).toThrow(NotFoundError);

    expect(count(db, "decision")).toBe(0);
    expect(revision(db)).toBe(before);
  });

  test("an unknown spark is `404` even when its `decision_id` is committed elsewhere (§4.2/§4.6/§4.7 order)", () => {
    // The `422 → 404 → 409` order §4.2/§4.6/§4.7 established: the id is consulted before the state.
    // Only the *repeat* (step 1) is hoisted above it, and this key names a different spark.
    const db = newDb();
    seedPair(db);
    seedSpark(db, "s1", "a", "b");
    resolveDecision(db, "s1", accept);

    expect(() => resolveDecision(db, "nope", accept)).toThrow(NotFoundError);
  });
});
