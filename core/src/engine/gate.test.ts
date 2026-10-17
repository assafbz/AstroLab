import type { DatabaseSync } from "node:sqlite";

import {
  currentVaultRevision,
  MIGRATIONS,
  migrate,
  openStore,
  seedDomainTaxonomy,
  type ClusterOption,
} from "@astrolab/store";
import { describe, expect, test } from "vitest";

import type { MechanismDescriptor } from "../provider/index.js";
import type { VaultCut } from "../queue.js";
import { descriptorSimilarity } from "./alignment.js";
import { createDomainDistance, type DomainDistance } from "./domain.js";
import { createGate, type Gate } from "./gate.js";
import type { MechanismCache } from "./mechanism.js";

/**
 * The gate (W5 #30; `ARCHITECTURE.md` §3.1, §3.3 step 2, §3.5).
 *
 * The load-bearing cases, each pinned to a way the gate could silently do the wrong thing: the
 * **cliché quadrant** (same-domain, high alignment — must not be gated) and its **E0 ceiling** partner
 * (1-hop, high alignment — must be gated), the `null`-distance convention, the §3.5 exclusions, the
 * AI-free scan, and the fact that the gate **writes nothing**.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function seedIdea(db: DatabaseSync, id: string, tags: string[], status = "ACTIVE"): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, ?, 'PRIVATE', 1, 't', 't')`,
  ).run(id, JSON.stringify(tags), status);
}

/** A node with an explicit lineage edge — `FORK` carrying `lineage_parent_id`. */
function seedForkedIdea(
  db: DatabaseSync,
  id: string,
  tags: string[],
  parentId: string,
  status = "ACTIVE",
): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, 'FORK', ?, ?, 'PRIVATE', 1, 't', 't')`,
  ).run(id, JSON.stringify(tags), parentId, status);
}

function descriptor(over: Partial<MechanismDescriptor> = {}): MechanismDescriptor {
  return {
    verb: "route",
    object_class: "traffic",
    constraint: "peak load",
    transferable_structure: "overflow rerouted into a parallel channel",
    ...over,
  };
}

const FAR = descriptor({
  verb: "photosynthesise",
  object_class: "sunlight",
  constraint: "winter darkness",
  transferable_structure: "stored energy released across seasons",
});

function countingCache(descriptors: Record<string, MechanismDescriptor>): {
  calls: string[];
  cache: MechanismCache;
} {
  const calls: string[] = [];
  return {
    calls,
    cache: {
      async descriptorFor(id) {
        calls.push(id);
        return descriptors[id] ?? null;
      },
    },
  };
}

/** A `DomainDistance` that answers from a tag-pair table, and records how often it was asked. */
function scriptedDistance(entries: Array<[string, string, number | null]>): {
  calls: number;
  distance: DomainDistance;
} {
  const table = new Map(entries.map(([a, b, v]) => [[a, b].sort().join("|"), v]));
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    distance: {
      async between(tagsA, tagsB) {
        calls += 1;
        return table.get([...tagsA, ...tagsB].sort().join("|")) ?? null;
      },
    },
  };
}

function cutOf(ids: string[]): VaultCut {
  return { revision: 1, ideaIds: ids };
}

describe("createGate — the comparator (D2)", () => {
  test("a pair at distance 1 (adjacent clusters) with high alignment IS gated — the E0 ceiling", () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    const { cache } = countingCache({ a: descriptor(), b: descriptor() });
    const { distance } = scriptedDistance([["fintech", "mobility", 1]]);

    return createGate(db, cache, distance)
      .gatedPairs(cutOf(["a", "b"]))
      .then((pairs) => expect(pairs.map((p) => p.key)).toEqual(["a|b"]));
  });

  test("a same-cluster pair (distance 0) at high alignment is NOT gated — the cliché quadrant", () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["fintech"]);
    const { cache } = countingCache({ a: descriptor(), b: descriptor() });
    const { distance } = scriptedDistance([["fintech", "fintech", 0]]);

    return createGate(db, cache, distance)
      .gatedPairs(cutOf(["a", "b"]))
      .then((pairs) => expect(pairs).toEqual([]));
  });

  test("a pair below the alignment threshold is not gated, even when far apart", () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    const { cache } = countingCache({ a: descriptor(), b: FAR });
    const { distance } = scriptedDistance([["fintech", "mobility", 1]]);

    return createGate(db, cache, distance)
      .gatedPairs(cutOf(["a", "b"]))
      .then((pairs) => expect(pairs).toEqual([]));
  });

  test("a `null` distance reads as farthest — never Number(null) === 0", () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    seedIdea(db, "c", ["health"]);
    const { cache } = countingCache({ a: descriptor(), b: descriptor(), c: FAR });
    const { distance } = scriptedDistance([
      ["fintech", "mobility", null], // far → clears
      ["fintech", "health", 1], // below the 99 threshold → out
      ["mobility", "health", 1], // out
    ]);

    // A threshold no numeric distance can clear: only the `null` pair may gate. Coercing `null → 0`
    // would read the unconnected pair as same-domain and drop it.
    const gate = createGate(db, cache, distance, { minDomainDistance: 99, minAlignment: 0.5 });
    return gate
      .gatedPairs(cutOf(["a", "b", "c"]))
      .then((pairs) => expect(pairs.map((p) => p.key)).toEqual(["a|b"]));
  });
});

describe("createGate — the candidate set (§3.5)", () => {
  test("excludes NEEDS_COMPLETION ideas and domain-less ideas", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"], "NEEDS_COMPLETION");
    seedIdea(db, "c", []);
    const { cache, calls } = countingCache({ a: descriptor(), b: descriptor(), c: descriptor() });
    const { distance } = scriptedDistance([]);

    const pairs = await createGate(db, cache, distance).gatedPairs(cutOf(["a", "b", "c"]));

    expect(pairs).toEqual([]);
    // b and c never even reached Stage 1 — the exclusion is before extraction.
    expect(calls).toEqual(["a"]);
  });
});

describe("createGate — the lineage exclusion (§3.5, #141)", () => {
  // §4.7 copies a fork's mechanism text **verbatim** from its parent while refusing a same-domain
  // fork, so a parent/fork pair clears **both** axes by construction — a fake cross-domain spark that
  // is not a discovery. The gate must not offer it. Each case below carries a control pair with no
  // lineage relation that *is* gated, so the block cannot pass by suppressing the whole scan.

  test("a fork and its own parent are never paired, though the pair clears both thresholds", async () => {
    const db = newDb();
    seedIdea(db, "p", ["fintech"]); // the parent
    seedForkedIdea(db, "f", ["mobility"], "p"); // the fork: same descriptor, a different domain
    seedIdea(db, "u", ["mobility"]); // an unrelated node, same descriptor as the fork
    const { cache } = countingCache({ p: descriptor(), f: descriptor(), u: descriptor() });
    const scripted = scriptedDistance([
      ["fintech", "mobility", 1], // p|f and p|u both clear distance; alignment is 1.0 for all three
      ["mobility", "mobility", 0], // f|u is the cliché quadrant — dropped on distance alone
    ]);

    const pairs = await createGate(db, cache, scripted.distance).gatedPairs(cutOf(["p", "f", "u"]));

    // p|u gates — the gate itself is intact. p|f is dropped for lineage alone, and **before** the
    // distance axis is asked: the pair never reached `between` (2 calls, not the full C(3,2)=3).
    expect(pairs.map((pair) => pair.key)).toEqual(["p|u"]);
    expect(scripted.calls).toBe(2);
  });

  test("an ancestor two generations up is excluded even when the middle node is not a candidate", async () => {
    const db = newDb();
    seedIdea(db, "g", ["fintech"]); // grandparent (candidate)
    seedForkedIdea(db, "m", ["fintech"], "g", "NEEDS_COMPLETION"); // middle: outside the candidate set
    seedForkedIdea(db, "c", ["mobility"], "m"); // child (candidate)
    seedIdea(db, "x", ["mobility"]); // unrelated control
    const { cache } = countingCache({ g: descriptor(), c: descriptor(), x: descriptor() });
    const { distance } = scriptedDistance([
      ["fintech", "mobility", 1], // g|c and g|x
      ["mobility", "mobility", 0], // c|x
    ]);

    const pairs = await createGate(db, cache, distance).gatedPairs(cutOf(["g", "m", "c", "x"]));

    // The walk from c crossed m (NEEDS_COMPLETION, no candidate) to reach g, so g|c is excluded;
    // g|x still gates.
    expect(pairs.map((pair) => pair.key)).toEqual(["g|x"]);
  });

  test("siblings (two forks of one parent) are NOT excluded — only ancestor/descendant is", async () => {
    const db = newDb();
    seedIdea(db, "p", ["fintech"]);
    seedForkedIdea(db, "f1", ["mobility"], "p");
    seedForkedIdea(db, "f2", ["energy"], "p");
    const { cache } = countingCache({ p: descriptor(), f1: descriptor(), f2: descriptor() });
    const { distance } = scriptedDistance([
      ["fintech", "mobility", 1],
      ["fintech", "energy", 1],
      ["mobility", "energy", 1],
    ]);

    const pairs = await createGate(db, cache, distance).gatedPairs(cutOf(["p", "f1", "f2"]));

    // p|f1 and p|f2 are ancestor/descendant (excluded); f1|f2 are siblings — the ruled boundary.
    expect(pairs.map((pair) => pair.key)).toEqual(["f1|f2"]);
  });
});

describe("createGate — determinism and identity (D6)", () => {
  test("returns one `pair_key`-sorted list, stable across runs and argument order", async () => {
    const db = newDb();
    for (const id of ["a", "b", "c"]) seedIdea(db, id, [id]);
    const { cache } = countingCache({ a: descriptor(), b: descriptor(), c: descriptor() });
    const { distance } = scriptedDistance([
      ["a", "b", 1],
      ["a", "c", 1],
      ["b", "c", 1],
    ]);
    const gate: Gate = createGate(db, cache, distance);

    const first = await gate.gatedPairs(cutOf(["c", "b", "a"]));
    const second = await gate.gatedPairs(cutOf(["a", "b", "c"]));

    expect(first.map((p) => p.key)).toEqual(["a|b", "a|c", "b|c"]);
    expect(second.map((p) => p.key)).toEqual(first.map((p) => p.key));
    // the key is the canonical unordered form, whatever order the loop met the two ideas in
    expect(first[0]).toMatchObject({ aId: "a", bId: "b", key: "a|b" });
  });
});

describe("createGate — cost posture (D4): the pairwise scan makes no AI calls", () => {
  test("AI is paid once per idea and once per distinct tag — never once per pair", async () => {
    const db = newDb();
    seedDomainTaxonomy(db);
    let run = 0;

    async function aiCallsFor(
      n: number,
    ): Promise<{ extract: number; normalise: number; between: number }> {
      run += 1;
      const ids = Array.from({ length: n }, (_, i) => `r${run}-i${i}`);
      // Unmapped tags, so each is normalised exactly once (if the gate normalised per pair, this
      // count would track pairs, not tags).
      for (const id of ids) seedIdea(db, id, [`unmapped-${id}`]);
      const { cache, calls } = countingCache(
        Object.fromEntries(ids.map((id) => [id, descriptor()])),
      );
      const normalised: string[] = [];
      const normalizer = {
        async normalizeTag(tag: string, clusters: readonly ClusterOption[]): Promise<string> {
          normalised.push(tag);
          return clusters[0]!.id;
        },
      };
      const real = createDomainDistance(db, normalizer);
      let between = 0;
      const distance: DomainDistance = {
        async between(a, b) {
          between += 1;
          return real.between(a, b);
        },
      };

      await createGate(db, cache, distance).gatedPairs(cutOf(ids));
      return { extract: calls.length, normalise: normalised.length, between };
    }

    const four = await aiCallsFor(4);
    const six = await aiCallsFor(6);

    // The pairwise loop ran fully (between = C(N,2)), yet AI stays linear in N.
    expect(four).toEqual({ extract: 4, normalise: 4, between: 6 }); // C(4,2)=6
    expect(six).toEqual({ extract: 6, normalise: 6, between: 15 }); // C(6,2)=15
  });
});

describe("createGate — nothing is written", () => {
  test("no spark, no suppressed_pair, no revision bump after a gated run", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    const { cache } = countingCache({ a: descriptor(), b: descriptor() });
    const { distance } = scriptedDistance([["fintech", "mobility", 1]]);
    const revisionBefore = currentVaultRevision(db);

    await createGate(db, cache, distance).gatedPairs(cutOf(["a", "b"]));

    expect(db.prepare("SELECT COUNT(*) AS n FROM spark").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM suppressed_pair").get()).toEqual({ n: 0 });
    expect(currentVaultRevision(db)).toBe(revisionBefore);
  });
});

describe("the alignment axis is observably reachable — shape evidence for min_alignment (D5b)", () => {
  // The alignment *value* is the W9 τ\* (`store/src/config.ts`; the calibration curve is its evidence,
  // `W9_CALIBRATION.md` §6). What this block adds is **shape** evidence, which the curve cannot give:
  // the axis is checked against descriptors in the shape the gate actually meets, not toy strings.
  // The pair below is a genuinely shared mechanism across unrelated domains (batch-amortisation of a
  // fixed setup cost); the variant pair is the same-domain near-duplicate the distance axis exists to
  // remove. Alignment is 0.6488 and 0.9167 respectively — so the *higher*-scoring pair is the one
  // suppressed, which is the point. (This block was written against the retired provisional default
  // `0.5`; the assertions below are unchanged and hold on either value.)
  const MEAL_KIT: MechanismDescriptor = {
    verb: "amortise",
    object_class: "per meal preparation cost",
    constraint: "one cook session per batch",
    transferable_structure: "spread a fixed setup cost across many units",
  };
  const GRID_STORAGE: MechanismDescriptor = {
    verb: "amortise",
    object_class: "grid charge cost",
    constraint: "one charge cycle per batch",
    transferable_structure: "spread a fixed setup cost across many units",
  };
  const MEAL_KIT_VARIANT: MechanismDescriptor = {
    verb: "amortise",
    object_class: "per meal preparation cost",
    constraint: "one cook session per batch",
    transferable_structure: "spread a fixed setup cost across batches",
  };

  test("an aligned, far-apart pair clears the floor by a wide margin and is gated", async () => {
    const db = newDb();
    seedIdea(db, "meal", ["food"]);
    seedIdea(db, "grid", ["energy"]);
    const { cache } = countingCache({ meal: MEAL_KIT, grid: GRID_STORAGE });
    const { distance } = scriptedDistance([["food", "energy", 2]]);

    const pairs = await createGate(db, cache, distance).gatedPairs(cutOf(["meal", "grid"]));

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.alignment).toBeCloseTo(0.6488, 3);
    expect(pairs[0]?.alignment).toBeGreaterThanOrEqual(0.5);
  });

  test("a same-domain near-duplicate is suppressed though its alignment is higher", async () => {
    const db = newDb();
    seedIdea(db, "meal", ["food"]);
    seedIdea(db, "variant", ["food"]);
    const { cache } = countingCache({ meal: MEAL_KIT, variant: MEAL_KIT_VARIANT });
    const { distance } = scriptedDistance([["food", "food", 0]]);

    const pairs = await createGate(db, cache, distance).gatedPairs(cutOf(["meal", "variant"]));

    expect(pairs).toEqual([]); // distance 0 → the cliché quadrant, whatever the alignment
  });
});

describe("the alignment floor is inclusive at the boundary — τ* = 0.02 (#110 follow-up)", () => {
  // Why this exists. τ* = `0.02` is **exactly attainable**: four pairs in the calibration vault have an
  // exact alignment of exactly `1/50`, and their stored floats are exactly `0.02` too
  // (`W9_CALIBRATION.md` §6). The comparator reads `alignment < limits.minAlignment` (`gate.ts`), so a
  // pair *at* the floor is gated — but nothing tested that, and a later change to the comparator's
  // strictness or to the parser would drop those four **silently**. This block pins the shape the
  // boundary is actually reached in: *inclusive, on the exact value*.
  //
  // The fixture is **constructed**, deliberately: four fields whose Jaccard terms are `0`, `0`, `1/25`
  // and `1/25`, so the mean is exactly `1/50` in exact arithmetic — and, measured against the shipped
  // `descriptorSimilarity`, exactly the double `0.02`. That second fact is what makes the assertion
  // meaningful rather than approximate, so the first test below asserts the premise instead of
  // assuming it.
  //
  // Every limit is passed **explicitly**: this is a claim about the comparator, not about the shipped
  // default, so it must not move the next time τ* is re-based.
  /** Two 13-token strings sharing exactly one token: a `1/25` Jaccard, with a 12-token tail. */
  const jacOneOf25 = (prefix: string): { a: string; b: string } => {
    const tail = (side: string) =>
      Array.from({ length: 12 }, (_, i) => `${prefix}${side}${i + 1}`).join(" ");
    return { a: `${prefix}shared ${tail("a")}`, b: `${prefix}shared ${tail("b")}` };
  };
  const constraint = jacOneOf25("c");
  const structure = jacOneOf25("t");

  const AT_FLOOR: MechanismDescriptor = {
    verb: "alpha",
    object_class: "gamma",
    constraint: constraint.a,
    transferable_structure: structure.a,
  };
  const AT_FLOOR_MATE: MechanismDescriptor = {
    verb: "beta",
    object_class: "delta",
    constraint: constraint.b,
    transferable_structure: structure.b,
  };

  /** The fixture pair gated at an explicit alignment floor — the distance axis scripted clear. */
  const gateAt = (minAlignment: number) => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["mobility"]);
    const { cache } = countingCache({ a: AT_FLOOR, b: AT_FLOOR_MATE });
    const { distance } = scriptedDistance([["fintech", "mobility", 1]]);

    return createGate(db, cache, distance, { minDomainDistance: 1, minAlignment }).gatedPairs(
      cutOf(["a", "b"]),
    );
  };

  test("the fixture sits exactly on the boundary — the premise, asserted not assumed", () => {
    expect(descriptorSimilarity(AT_FLOOR, AT_FLOOR_MATE)).toBe(0.02); // `1/50`, exactly
  });

  test("a pair whose alignment is exactly the floor IS gated — inclusive, on the exact value", async () => {
    const pairs = await gateAt(0.02);

    expect(pairs.map((pair) => pair.key)).toEqual(["a|b"]);
    expect(pairs[0]?.alignment).toBe(0.02);
  });

  test("the companion: the same pair is dropped one step above the floor", async () => {
    // Non-vacuity in the other direction: without this, the test above would also pass if the gate
    // admitted every pair it saw.
    expect(await gateAt(0.021)).toEqual([]);
  });
});
