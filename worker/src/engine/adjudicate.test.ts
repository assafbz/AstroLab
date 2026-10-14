import type { DatabaseSync } from "node:sqlite";

import { currentVaultRevision, MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import {
  InvalidOutputError,
  ProviderError,
  type IdeaText,
  type MechanismDescriptor,
  type MechanismPair,
  type SparkAdjudicator,
  type SparkDraft,
} from "../provider/index.js";
import { createAdjudicator } from "./adjudicate.js";
import type { GatedPair } from "./gate.js";

/**
 * Stage 2 — adjudication (W6 #31; `ARCHITECTURE.md` §3.1, §3.3 step 3, §3.5).
 *
 * Each case pins a way this stage could silently do the wrong thing: a second call for a pair the gate
 * already offered, a refusal read as a failed call (**W2's pin** — that would suppress a pair for the
 * wrong reason), a swallowed provider error, a pair invented for an idea that no longer exists, a text
 * read per pair instead of per idea, and an output order that does not follow the candidate set. The
 * last case pins the thing W6 must *not* do: write — a suppression landing here would sit outside the
 * run lifecycle, so a run later discarded as stale (§4/I) would have suppressed pairs it never
 * surfaced (D1).
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

/** `hypothesis` carries the id, so a fake adjudicator can name the pair it was handed. */
function seedIdea(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '["fintech"]', 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, `hyp-${id}`, `prob-${id}`, `mon-${id}`);
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
function pairOf(aId: string, bId: string): GatedPair {
  return {
    key: [aId, bId].sort().join("|"),
    aId,
    bId,
    a: descriptorFor(aId),
    b: descriptorFor(bId),
    distance: 1,
    alignment: 0.7,
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

interface Scripted {
  /** The pairs the provider was actually asked about, in call order — one entry per call. */
  calls: Array<{ key: string; mechanisms: MechanismPair }>;
  provider: SparkAdjudicator;
}

function scriptedAdjudicator(answers: Record<string, Answer>): Scripted {
  const calls: Scripted["calls"] = [];
  return {
    calls,
    provider: {
      async adjudicate(ideaA: IdeaText, ideaB: IdeaText, mechanisms: MechanismPair) {
        const aId = ideaA.hypothesis.replace("hyp-", "");
        const bId = ideaB.hypothesis.replace("hyp-", "");
        const key = [aId, bId].sort().join("|");
        calls.push({ key, mechanisms });
        const answer = answers[key];
        if (answer instanceof Error) throw answer;
        return answer === undefined ? draft({ mechanism: `mech-${key}` }) : answer;
      },
    },
  };
}

/**
 * The `idea` reads the adjudicator actually ran, in order. Wrapping `prepare`/`get` is wrapping *the
 * read* — `readIdeaText` is one `SELECT … FROM idea` — so the count below is the real one, not a
 * mocked stand-in. (`FROM idea\b` does not match `FROM idea_mechanism`: `_` is a word character, so
 * there is no boundary after `idea`.)
 */
function countingDb(db: DatabaseSync): { db: DatabaseSync; reads: string[] } {
  const reads: string[] = [];
  const wrapping = new Proxy(db, {
    get(target, property) {
      if (property !== "prepare") return Reflect.get(target, property);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!/\bFROM idea\b/.test(sql)) return statement;
        return new Proxy(statement, {
          get(stmtTarget, stmtProperty) {
            if (stmtProperty !== "get") return Reflect.get(stmtTarget, stmtProperty);
            return (...args: unknown[]) => {
              reads.push(String(args[0]));
              return (stmtTarget.get as (...rest: unknown[]) => unknown)(...args);
            };
          },
        });
      };
    },
  });
  return { db: wrapping, reads };
}

describe("createAdjudicator — one call per gated pair (§3.1 / §3.3 step 3; D3)", () => {
  test("calls once per pair, and hands the provider the pair's own texts and descriptors", async () => {
    const db = newDb();
    for (const id of ["a", "b", "c"]) seedIdea(db, id);
    const { calls, provider } = scriptedAdjudicator({});

    const result = await createAdjudicator(db, provider).adjudicate([
      pairOf("a", "b"),
      pairOf("a", "c"),
    ]);

    expect(calls.map((call) => call.key)).toEqual(["a|b", "a|c"]);
    // The gate's evidence travels with the pair: the descriptors are the pair's own, not swapped — the
    // call compares exactly the two descriptors that cleared the gate.
    expect(calls[0]?.mechanisms).toEqual({ a: descriptorFor("a"), b: descriptorFor("b") });
    expect(calls[1]?.mechanisms).toEqual({ a: descriptorFor("a"), b: descriptorFor("c") });
    expect(result.confirmed.map((spark) => spark.key)).toEqual(["a|b", "a|c"]);
  });

  test("no gated pairs ⇒ no calls and empty lists", async () => {
    const db = newDb();
    const { calls, provider } = scriptedAdjudicator({});

    const result = await createAdjudicator(db, provider).adjudicate([]);

    expect(calls).toEqual([]);
    expect(result).toEqual({ confirmed: [], rejected: [] });
  });
});

describe("createAdjudicator — a refusal is a rejection, not a failure (§3.3 step 3; D3)", () => {
  test("a `null` answer rejects that pair and leaves the others alone", async () => {
    const db = newDb();
    for (const id of ["a", "b", "c"]) seedIdea(db, id);
    const { provider } = scriptedAdjudicator({ "a|b": null });

    const result = await createAdjudicator(db, provider).adjudicate([
      pairOf("a", "b"),
      pairOf("a", "c"),
    ]);

    expect(result.rejected).toEqual([{ key: "a|b", aId: "a", bId: "b" }]);
    expect(result.confirmed.map((spark) => spark.key)).toEqual(["a|c"]);
  });

  test("an all-refused run resolves — nothing thrown, nothing stored", async () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    const revisionBefore = currentVaultRevision(db);
    const { provider } = scriptedAdjudicator({ "a|b": null });

    const result = await createAdjudicator(db, provider).adjudicate([pairOf("a", "b")]);

    expect(result).toEqual({ confirmed: [], rejected: [{ key: "a|b", aId: "a", bId: "b" }] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM suppressed_pair").get()).toEqual({ n: 0 });
    expect(currentVaultRevision(db)).toBe(revisionBefore);
  });

  test("a confirmed pair carries W5's scores and the draft unchanged (D1/D2 — nothing re-derived)", async () => {
    const db = newDb();
    seedIdea(db, "a");
    seedIdea(db, "b");
    const { provider } = scriptedAdjudicator({ "a|b": draft({ mechanism: "shared" }) });

    const [confirmed] = (await createAdjudicator(db, provider).adjudicate([pairOf("a", "b")]))
      .confirmed;

    expect(confirmed).toMatchObject({
      key: "a|b",
      aId: "a",
      bId: "b",
      distance: 1, // W5's GatedPair.distance, internal
      alignment: 0.7, // W5's GatedPair.alignment, internal
      draft: { mechanism: "shared" },
    });
  });
});

describe("createAdjudicator — a failed call propagates (§4's FAILED path; D3)", () => {
  test("a ProviderError / InvalidOutputError rejects, and nothing is written", async () => {
    for (const failure of [new ProviderError("timeout"), new InvalidOutputError("bad shape")]) {
      const db = newDb();
      for (const id of ["a", "b", "c"]) seedIdea(db, id);
      const revisionBefore = currentVaultRevision(db);
      // The first pair succeeds before the second fails — a partial outcome must not leave a trace.
      const { provider } = scriptedAdjudicator({ "a|b": draft(), "a|c": failure });

      await expect(
        createAdjudicator(db, provider).adjudicate([pairOf("a", "b"), pairOf("a", "c")]),
      ).rejects.toBe(failure); // propagated as-is, never wrapped or swallowed

      expect(db.prepare("SELECT COUNT(*) AS n FROM spark").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM suppressed_pair").get()).toEqual({ n: 0 });
      expect(currentVaultRevision(db)).toBe(revisionBefore);
    }
  });
});

describe("createAdjudicator — an idea that vanished after the gate (D4)", () => {
  test("its pairs are skipped: no call, no output, and the rest still adjudicate", async () => {
    const db = newDb();
    for (const id of ["a", "b", "c"]) seedIdea(db, id);
    db.prepare("DELETE FROM idea WHERE id = ?").run("c");
    const { calls, provider } = scriptedAdjudicator({});

    const result = await createAdjudicator(db, provider).adjudicate([
      pairOf("a", "b"),
      pairOf("a", "c"),
      pairOf("b", "c"),
    ]);

    // `c` is named by two pairs and asked about by none: a skipped pair is never sent, never invented.
    expect(calls.map((call) => call.key)).toEqual(["a|b"]);
    expect(result.confirmed.map((spark) => spark.key)).toEqual(["a|b"]);
    expect(result.rejected).toEqual([]);
  });
});

describe("createAdjudicator — the idea text is read once per idea (D4)", () => {
  test("4 pairs over 4 ideas ⇒ 4 reads, not 8", async () => {
    const db = newDb();
    for (const id of ["a", "b", "c", "d"]) seedIdea(db, id);
    const { db: counting, reads } = countingDb(db);
    const { calls, provider } = scriptedAdjudicator({});

    const result = await createAdjudicator(counting, provider).adjudicate([
      pairOf("a", "b"),
      pairOf("a", "c"),
      pairOf("a", "d"),
      pairOf("b", "c"),
    ]);

    expect([...reads].sort()).toEqual(["a", "b", "c", "d"]);
    expect(reads).toHaveLength(4); // a read-per-pair stage would do 8
    expect(calls).toHaveLength(4);
    expect(result.confirmed).toHaveLength(4);
  });
});

describe("createAdjudicator — deterministic, key-sorted output (D5)", () => {
  test("both lists are key-sorted whatever order the pairs arrive in", async () => {
    const db = newDb();
    for (const id of ["a", "b", "c"]) seedIdea(db, id);
    const pairs = [pairOf("a", "b"), pairOf("a", "c"), pairOf("b", "c")];
    const { provider } = scriptedAdjudicator({ "a|c": null, "b|c": null });

    const adjudicator = createAdjudicator(db, provider);
    const forward = await adjudicator.adjudicate(pairs);
    const reversed = await adjudicator.adjudicate([...pairs].reverse());

    expect(forward.confirmed.map((spark) => spark.key)).toEqual(["a|b"]);
    expect(forward.rejected.map((pair) => pair.key)).toEqual(["a|c", "b|c"]);
    // Reversing the input reverses the call order; the outcome order is unchanged.
    expect(reversed.confirmed.map((spark) => spark.key)).toEqual(["a|b"]);
    expect(reversed.rejected.map((pair) => pair.key)).toEqual(["a|c", "b|c"]);
  });
});

describe("createAdjudicator — writes nothing (D1; the run lifecycle owns the write)", () => {
  test("no spark, no suppressed_pair, no revision bump after a confirm-and-reject run", async () => {
    const db = newDb();
    for (const id of ["a", "b", "c"]) seedIdea(db, id);
    const revisionBefore = currentVaultRevision(db);
    const { provider } = scriptedAdjudicator({ "a|c": null });

    const result = await createAdjudicator(db, provider).adjudicate([
      pairOf("a", "b"),
      pairOf("a", "c"),
    ]);

    expect(result.confirmed).toHaveLength(1);
    // The pair IS classified as rejected — the "recorded as suppressed (noise)" write is W7's.
    expect(result.rejected).toEqual([{ key: "a|c", aId: "a", bId: "c" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spark").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM suppressed_pair").get()).toEqual({ n: 0 });
    expect(currentVaultRevision(db)).toBe(revisionBefore);
  });
});
