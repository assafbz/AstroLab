import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { expect, test } from "vitest";

import { seedDomainTaxonomy } from "../store/index.js";
import { openNodeStore } from "../store/connection.node.js";
import { migrate } from "../store/migrate.js";
import { MIGRATIONS } from "../store/migrations.js";

import { domainClusters } from "./taxonomy.js";

/**
 * The picker's vocabulary is the **seeded rows**, and the module carries no list of its own
 * (plan invariant 7).
 *
 * v1 shipped a mirror of the 28 clusters here plus a drift test that read the shipped YAML and failed
 * if the copy diverged. Both are gone: the store and the picker are one package now, so the copy has
 * no reason to exist and nothing can drift. What is left to check is the property the copy could hide
 * — that this module reports what the seed put in the database, in the seed's order — and its
 * non-vacuity: with no rows, the picker offers **nothing** rather than a built-in list.
 */

/** The shipped file, read the way `o1_check.py` reads it: file order, META keys dropped. */
const TAXONOMY = new URL("../../seed/domain-taxonomy.yaml", import.meta.url);
const META = new Set(["adjacency", "version", "corrections"]);

function seeded(): ReturnType<typeof openNodeStore> {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

test("the picker is the seeded clusters, in the seed's order", () => {
  const db = seeded();
  try {
    const doc = parseYaml(readFileSync(TAXONOMY, "utf8")) as Record<string, { name?: unknown }>;
    const shipped = Object.keys(doc)
      .filter((key) => !META.has(key))
      .map((key) => ({ key, name: String(doc[key]?.name) }));

    // Both halves: the vocabulary (keys + labels) and the order. The order is the claim
    // `readClustersInSeedOrder` exists for — insertion order *is* file order because the seed writes
    // in file order and the curation rule is additive-only.
    expect(shipped.length).toBe(28);
    expect(domainClusters(db)).toEqual(shipped);
    // …and it is the file's order, not a sort — the two differ for the shipped artifact, so a
    // `ORDER BY id` regression cannot pass this.
    expect(shipped.map((cluster) => cluster.key)).not.toEqual(
      [...shipped.map((cluster) => cluster.key)].sort(),
    );
  } finally {
    db.close();
  }
});

test("no seed, no vocabulary — the module has no list of its own", () => {
  const db = openNodeStore(":memory:");
  try {
    migrate(db, MIGRATIONS);
    // The anti-mirror assertion: an inline list would answer here, on a store the seed never touched.
    expect(domainClusters(db)).toEqual([]);
  } finally {
    db.close();
  }
});
