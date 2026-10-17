import type { SqliteConnection } from "../store/connection.js";

import { MIGRATIONS, migrate, readDomainMap, seedDomainTaxonomy } from "../store/index.js";
import { openNodeStore } from "../store/connection.node.js";
import { describe, expect, test } from "vitest";

import type { ClusterOption, TagNormalizer } from "../provider/index.js";
import { createDomainDistance } from "./domain.js";

/**
 * Axis 1 — domain distance (`ARCHITECTURE.md` §3.2), against a fresh migrated + seeded vault.
 *
 * The load-bearing ones: a **mapped** tag never reaches the model; an unmapped tag is normalised
 * **exactly once** (the `domain_map` write is the cache); and the distance never invents a value —
 * `0` only for a shared cluster, `null` (never `0`) for a pair the table does not list.
 */

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

/** A `TagNormalizer` that records every tag and answers from `answers` — refusing an unoffered id. */
function fakeNormalizer(answers: Record<string, string>): {
  normalizer: TagNormalizer;
  tags: string[];
} {
  const tags: string[] = [];
  return {
    tags,
    normalizer: {
      async normalizeTag(tag: string, clusters: readonly ClusterOption[]): Promise<string> {
        tags.push(tag);
        const cluster = answers[tag];
        if (cluster === undefined) throw new Error(`no answer for ${tag}`);
        if (!clusters.some((offered) => offered.id === cluster)) {
          throw new Error(`answer ${cluster} was not offered`);
        }
        return cluster;
      },
    },
  };
}

describe("distance over the shipped taxonomy — hops (§3.2 step 3)", () => {
  test("same cluster is 0 — even from two different tags", async () => {
    const { normalizer } = fakeNormalizer({});
    const distance = createDomainDistance(newDb(), normalizer);
    // `payments` and `fintech` are two tags of the one `fintech` cluster.
    expect(await distance.between(["payments"], ["fintech"])).toBe(0);
  });

  test("hops_1 is 1, hops_2 is 2", async () => {
    const { normalizer } = fakeNormalizer({});
    const distance = createDomainDistance(newDb(), normalizer);
    expect(await distance.between(["fintech"], ["marketplaces"])).toBe(1);
    expect(await distance.between(["fintech"], ["ai-ml"])).toBe(2);
  });

  test("a pair the table does not list is null — never a made-up hop count (Decision 2)", async () => {
    const { normalizer } = fakeNormalizer({});
    const distance = createDomainDistance(newDb(), normalizer);
    // `fintech` and `education` share no listed path at hops_1 or hops_2.
    expect(await distance.between(["fintech"], ["education"])).toBeNull();
    expect(await distance.between(["education"], ["fintech"])).toBeNull();
  });

  test("null is 'no path': strictly not 0, and past every shipped hop count (W5's convention)", async () => {
    const { normalizer } = fakeNormalizer({});
    const distance = createDomainDistance(newDb(), normalizer);
    const unlisted = await distance.between(["fintech"], ["education"]);

    // 0 is the one wrong answer: it reads as same-domain → cliché → dropped, silently.
    expect(unlisted).toBeNull();
    expect(unlisted).not.toBe(0);
    // W5's comparator, as W4 pins the convention: a null must read as *distant*, i.e. the gate's
    // predicate is `distance === null || distance >= min`, never `Number(distance) >= min`.
    const min = 1;
    expect(unlisted === null || unlisted >= min).toBe(true);
  });

  test("multiple tags combine by min — a shared cluster is 0, the closest pairing wins", async () => {
    const { normalizer } = fakeNormalizer({});
    const distance = createDomainDistance(newDb(), normalizer);
    expect(await distance.between(["fintech", "health"], ["health"])).toBe(0);
    // ai-ml is 2 from fintech and unlisted from health → 2, the min.
    expect(await distance.between(["fintech", "health"], ["ai-ml"])).toBe(2);
  });
});

describe("resolve-first, normalise-on-miss (§3.2 steps 1–2)", () => {
  test("a mapped tag never reaches the model", async () => {
    const { normalizer, tags } = fakeNormalizer({});
    const distance = createDomainDistance(newDb(), normalizer);

    expect(await distance.between(["fintech"], ["marketplaces"])).toBe(1);
    expect(tags).toEqual([]);
  });

  test("an unmapped tag is normalised once and written back into domain_map", async () => {
    const db = newDb();
    const { normalizer, tags } = fakeNormalizer({ "neobank-xyz": "fintech" });
    const distance = createDomainDistance(db, normalizer);

    expect(await distance.between(["neobank-xyz"], ["fintech"])).toBe(0);
    expect(tags).toEqual(["neobank-xyz"]);
    // The write *is* the cache: the row now reads back.
    expect(readDomainMap(db, ["neobank-xyz"]).get("neobank-xyz")).toBe("fintech");
  });

  test("the same tag is normalised once across two calls on one instance", async () => {
    const { normalizer, tags } = fakeNormalizer({ "neobank-xyz": "fintech" });
    const distance = createDomainDistance(newDb(), normalizer);

    await distance.between(["neobank-xyz"], ["fintech"]);
    await distance.between(["neobank-xyz"], ["health"]);
    expect(tags).toEqual(["neobank-xyz"]);
  });

  test("a second run does not re-normalise — the domain_map row serves it (paid once per tag)", async () => {
    const db = newDb();
    const first = fakeNormalizer({ "neobank-xyz": "fintech" });
    await createDomainDistance(db, first.normalizer).between(["neobank-xyz"], ["fintech"]);
    expect(first.tags).toEqual(["neobank-xyz"]);

    const second = fakeNormalizer({ "neobank-xyz": "fintech" });
    expect(
      await createDomainDistance(db, second.normalizer).between(["neobank-xyz"], ["marketplaces"]),
    ).toBe(1);
    expect(second.tags).toEqual([]);
  });
});

describe("edges — the axis never throws on an empty or wholly-unmapped input", () => {
  test("an empty tag set on either side is null", async () => {
    const { normalizer } = fakeNormalizer({ "neobank-xyz": "fintech" });
    const distance = createDomainDistance(newDb(), normalizer);
    expect(await distance.between([], ["fintech"])).toBeNull();
    expect(await distance.between(["fintech"], [])).toBeNull();
    expect(await distance.between([], [])).toBeNull();
  });

  test("two unmapped tags resolve independently and then measure", async () => {
    const db = newDb();
    const { normalizer, tags } = fakeNormalizer({ "tag-a": "fintech", "tag-b": "marketplaces" });
    const distance = createDomainDistance(db, normalizer);

    expect(await distance.between(["tag-a"], ["tag-b"])).toBe(1);
    expect(tags.sort()).toEqual(["tag-a", "tag-b"]);
  });
});
