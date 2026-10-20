import type { SqliteConnection } from "../store/connection.js";

import { currentVaultRevision, MIGRATIONS, migrate, stampAndEnqueue } from "../store/index.js";
import { openNodeStore } from "../store/connection.node.js";
import { describe, expect, test } from "vitest";

import {
  ProviderError,
  type IdeaText,
  type MechanismDescriptor,
  type SparkAdjudicator,
  type SparkDraft,
} from "../provider/index.js";
import { runOnce } from "./queue.js";
import { createAdjudicator } from "./adjudicate.js";
import { createEngineRun, type EngineRun } from "./run.js";
import type { Gate, GatedPair } from "./gate.js";
import { createSuppression } from "./suppression.js";

/**
 * The run surface (W8 #33; `ARCHITECTURE.md` §3.1, §3.3, §4). Each case pins a way the composed run
 * could silently do the wrong thing: writing on a **stale** run (the discarded path must write
 * nothing), a **settled** pair spending an AI call, a provider failure partial-writing, a run
 * **stamping its own revision** (the self-feeding loop), and the sweep retracting an offer whose idea
 * is still a candidate.
 *
 * The gate is a fake here: W5's comparator and determinism are `gate.test.ts`'s subject, and this
 * file is about **composition and the write placement**. The adjudicator is real (`createAdjudicator`)
 * over a scripted provider, and suppression is real — the composer's behaviour on each is the point.
 */

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

/** `hypothesis` carries the id, so the fake adjudicator can name the pair it was handed. */
function seedIdea(db: SqliteConnection, id: string, tags: string[], status = "ACTIVE"): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, ?, 'PRIVATE', 1, 't', 't')`,
  ).run(id, `hyp-${id}`, `prob-${id}`, `mon-${id}`, JSON.stringify(tags), status);
}

function descriptorFor(id: string): MechanismDescriptor {
  return {
    verb: "route",
    object_class: id,
    constraint: "peak load",
    transferable_structure: "overflow rerouted into a parallel channel",
  };
}

/** A `GatedPair` in the shape W5 emits (D6): `key = [aId, bId].sort().join("|")`, ascending ids. */
function pairOf(aId: string, bId: string, over: Partial<GatedPair> = {}): GatedPair {
  return {
    key: [aId, bId].sort().join("|"),
    aId,
    bId,
    a: descriptorFor(aId),
    b: descriptorFor(bId),
    distance: 1,
    alignment: 0.7,
    ...over,
  };
}

/** A gate that returns a fixed pair list — W5's own behaviour is `gate.test.ts`'s subject. */
function fakeGate(pairs: GatedPair[]): Gate {
  return {
    async gatedPairs() {
      return pairs;
    },
  };
}

function draft(over: Partial<SparkDraft> = {}): SparkDraft {
  return {
    mechanism: "spread a fixed setup cost across many units",
    direction: "batch the cook",
    claim: "one setup, many servings",
    what_it_takes: "a shared batch",
    first_step: "pilot one batch",
    ...over,
  };
}

/** One answer per pair `key`: a draft, a `null` refusal, or an error to throw. Unlisted ⇒ a draft. */
type Answer = SparkDraft | null | Error;

function scriptedAdjudicator(answers: Record<string, Answer>): {
  calls: string[];
  provider: SparkAdjudicator;
} {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      async adjudicate(ideaA: IdeaText, ideaB: IdeaText) {
        const aId = ideaA.hypothesis.replace("hyp-", "");
        const bId = ideaB.hypothesis.replace("hyp-", "");
        const key = [aId, bId].sort().join("|");
        calls.push(key);
        const answer = answers[key];
        if (answer instanceof Error) throw answer;
        return answer === undefined ? draft({ mechanism: `mech-${key}` }) : answer;
      },
    },
  };
}

/** The run surface, wired exactly as the composition root wires it (D4). */
function engineFor(
  db: SqliteConnection,
  pairs: GatedPair[],
  answers: Record<string, Answer> = {},
): { engine: EngineRun; calls: string[] } {
  const { calls, provider } = scriptedAdjudicator(answers);
  const engine = createEngineRun(db, {
    gate: fakeGate(pairs),
    suppression: createSuppression(db),
    adjudicator: createAdjudicator(db, provider),
  });
  return { engine, calls };
}

/** A `spark` row written directly — the history a later run must read and respect. */
function seedSpark(db: SqliteConnection, aId: string, bId: string, status = "OFFERED"): void {
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES (?, ?, ?, ?, 'd', 'c', ?, 't')`,
  ).run(`spark-${aId}-${bId}`, aId, bId, [aId, bId].sort().join("|"), status);
}

function sparkRows(db: SqliteConnection): Array<{ pair_key: string; status: string }> {
  return db.prepare("SELECT pair_key, status FROM spark ORDER BY pair_key, status").all() as Array<{
    pair_key: string;
    status: string;
  }>;
}

function runRows(db: SqliteConnection): Array<{ status: string; error: string | null }> {
  return db.prepare("SELECT status, error FROM spark_run ORDER BY vault_revision").all() as Array<{
    status: string;
    error: string | null;
  }>;
}

function suppressedRows(db: SqliteConnection): Array<{ pair_key: string; reason: string }> {
  return db
    .prepare("SELECT pair_key, reason FROM suppressed_pair ORDER BY pair_key")
    .all() as Array<{ pair_key: string; reason: string }>;
}

describe("createEngineRun — the body composes and writes nothing", () => {
  test("returns the adjudicated pairs, the offers and the rejections, and touches no table", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    const { engine } = engineFor(db, [pairOf("a", "b")]);
    const before = currentVaultRevision(db);

    const outcome = await engine.body({ revision: 1, ideaIds: ["a", "b"] });

    expect(outcome.candidates).toEqual(["a|b"]);
    expect(outcome.offers?.map((spark) => spark.pair_key)).toEqual(["a|b"]);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.candidateIds).toEqual(["a", "b"]);
    // The whole point of the split (S2): the body is a pure compute, so a discarded run cannot write.
    expect(sparkRows(db)).toEqual([]);
    expect(suppressedRows(db)).toEqual([]);
    expect(currentVaultRevision(db)).toBe(before);
  });
});

describe("createEngineRun — the commit offers and records (§3.3 step 3)", () => {
  test("a confirmed pair lands as an OFFERED spark, draft fields and internal scores included", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    stampAndEnqueue(db);
    const { engine } = engineFor(db, [pairOf("a", "b")]);

    const result = await runOnce(db, engine.body, engine.commit);

    expect(result).toMatchObject({ discarded: false, error: null });
    expect(sparkRows(db)).toEqual([{ pair_key: "a|b", status: "OFFERED" }]);
    // The gate's evidence and the draft's surfaced fields are stored verbatim (§2.3).
    expect(
      db
        .prepare(
          `SELECT direction, claim, what_it_takes, first_step, mechanism,
                  domain_distance, structural_alignment FROM spark`,
        )
        .get(),
    ).toEqual({
      direction: "batch the cook",
      claim: "one setup, many servings",
      what_it_takes: "a shared batch",
      first_step: "pilot one batch",
      mechanism: "mech-a|b",
      domain_distance: 1,
      structural_alignment: 0.7,
    });
  });

  test("a refused pair is recorded as NOISE and offers nothing", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    stampAndEnqueue(db);
    const { engine } = engineFor(db, [pairOf("a", "b")], { "a|b": null });

    await runOnce(db, engine.body, engine.commit);

    expect(sparkRows(db)).toEqual([]);
    expect(suppressedRows(db)).toEqual([{ pair_key: "a|b", reason: "NOISE" }]);
  });

  test("a settled pair is never adjudicated — 0 AI calls (§3.5)", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    // Settled by any record: a suppression row of any reason, or a spark of any status (W7 D2).
    db.prepare(
      "INSERT INTO suppressed_pair (pair_key, reason, updated_at) VALUES ('a|b', 'NOISE', 't')",
    ).run();
    stampAndEnqueue(db);
    const { engine, calls } = engineFor(db, [pairOf("a", "b")]);

    const result = await runOnce(db, engine.body, engine.commit);

    expect(calls).toEqual([]); // the re-offer rule dropped it *before* adjudication
    expect(result?.outcome?.candidates).toEqual([]);
    expect(sparkRows(db)).toEqual([]);
    expect(suppressedRows(db)).toEqual([{ pair_key: "a|b", reason: "NOISE" }]); // no new row
  });
});

describe("createEngineRun — the commit's placement (S2/D7)", () => {
  test("a run that goes stale mid-body writes nothing — no offer, no suppression, no sweep", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"], "NEEDS_COMPLETION"); // live offer below, idea now a non-candidate
    seedIdea(db, "c", ["health"]);
    seedIdea(db, "d", ["energy"]);
    seedSpark(db, "a", "b"); // the sweep *would* retract this, were the commit to run
    stampAndEnqueue(db); // revision 1
    // A pair the run would confirm — so a commit would also **offer** a new spark, not just sweep.
    const { engine } = engineFor(db, [pairOf("c", "d")]);

    const result = await runOnce(
      db,
      async (cut) => {
        stampAndEnqueue(db); // the vault moves *during* the body → revision 2
        return engine.body(cut);
      },
      engine.commit,
    );

    expect(result).toMatchObject({ discarded: true, error: null });
    expect(result?.outcome?.offers?.map((spark) => spark.pair_key)).toEqual(["c|d"]);
    expect(runRows(db)).toMatchObject([
      { status: "DONE", error: "discarded: superseded by revision 2" },
      { status: "PENDING", error: null },
    ]);
    // The decisive assertion: the offer is *not* written and the live offer survives untouched.
    expect(sparkRows(db)).toEqual([{ pair_key: "a|b", status: "OFFERED" }]);
    expect(suppressedRows(db)).toEqual([]);
  });

  test("a provider failure fails the run and writes nothing", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    stampAndEnqueue(db);
    const { engine } = engineFor(db, [pairOf("a", "b")], {
      "a|b": new ProviderError("adjudication timed out"),
    });

    const result = await runOnce(db, engine.body, engine.commit);

    expect(result).toMatchObject({
      outcome: null,
      error: "failure:unavailable: adjudication timed out",
    });
    expect(runRows(db)).toEqual([
      { status: "FAILED", error: "failure:unavailable: adjudication timed out" },
    ]);
    expect(sparkRows(db)).toEqual([]);
    expect(suppressedRows(db)).toEqual([]);
  });
});

describe("createEngineRun — the run's writes are non-stamping and non-enqueueing (C7)", () => {
  test("a run that offers a spark moves no revision and enqueues no run", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    stampAndEnqueue(db); // revision 1 + one PENDING run
    const before = currentVaultRevision(db);
    const { engine } = engineFor(db, [pairOf("a", "b")]);

    await runOnce(db, engine.body, engine.commit);

    expect(sparkRows(db)).toHaveLength(1); // the offer landed
    expect(currentVaultRevision(db)).toBe(before); // but nothing stamped
    expect(db.prepare("SELECT COUNT(*) AS n FROM spark_run").get()).toEqual({ n: 1 }); // no successor
  });
});

describe("createEngineRun — the sweep (§4's recompute; V5 #16 ⑤)", () => {
  test("retracts a live offer whose idea is no longer a candidate, and leaves a resolved one", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"], "NEEDS_COMPLETION"); // not a candidate (§3.5)
    seedIdea(db, "c", ["energy"]);
    seedSpark(db, "a", "b"); // live, and outside the candidate set → swept
    seedSpark(db, "a", "c", "RESOLVED-DISMISSED"); // history → kept
    stampAndEnqueue(db);
    const { engine } = engineFor(db, []);

    const result = await runOnce(db, engine.body, engine.commit);

    expect(result?.outcome?.candidateIds).toEqual(["a", "c"]);
    expect(sparkRows(db)).toEqual([{ pair_key: "a|c", status: "RESOLVED-DISMISSED" }]);
  });

  test("keeps a live offer whose ideas are both still candidates", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    seedSpark(db, "a", "b");
    stampAndEnqueue(db);
    const { engine } = engineFor(db, []); // the pair is settled, so the gate offers nothing new

    await runOnce(db, engine.body, engine.commit);

    expect(sparkRows(db)).toEqual([{ pair_key: "a|b", status: "OFFERED" }]);
  });
});
