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

    async function aiCallsFor(n: number): Promise<{ extract: number; normalise: number; between: number }> {
      run += 1;
      const ids = Array.from({ length: n }, (_, i) => `r${run}-i${i}`);
      // Unmapped tags, so each is normalised exactly once (if the gate normalised per pair, this
      // count would track pairs, not tags).
      for (const id of ids) seedIdea(db, id, [`unmapped-${id}`]);
      const { cache, calls } = countingCache(Object.fromEntries(ids.map((id) => [id, descriptor()])));
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

describe("the shipped default is observably reachable — evidence for min_alignment (D5b)", () => {
  // The alignment floor has no product rule behind it, so it is checked against descriptors in the
  // shape the gate actually meets, not toy strings. The pair below is a genuinely shared mechanism
  // across unrelated domains (batch-amortisation of a fixed setup cost); the variant pair is the
  // same-domain near-duplicate the distance axis exists to remove. Alignment is 0.6488 and 0.9167
  // respectively — so the *higher*-scoring pair is the one suppressed, which is the point.
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

  test("an aligned, far-apart pair clears the shipped default (min_alignment = 0.5) and is gated", async () => {
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
