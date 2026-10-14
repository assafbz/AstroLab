import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import { expect, test } from "vitest";

import { DOMAIN_CLUSTERS } from "./taxonomy.ts";

/**
 * The drift guard for `taxonomy.ts` — **the copy is only safe if it cannot drift.**
 *
 * `taxonomy.ts` mirrors the shipped clusters because the client cannot reach them any other way (no
 * endpoint exposes the taxonomy; `client` may not import `store`). A mirror that drifts is worse than
 * no picker: the picker would write a key the loader never registered, the tag would stay
 * **provisional**, and the spread gate would silently never open — the exact failure `store/seed/README.md`
 * rule 2 and R1 exist to prevent. So this file reads the **artifact of record** and fails on any
 * divergence in key, label, order or count.
 *
 * It is dev-only (node env, `yaml` a dev dependency) — the shipped app still bundles `react`/
 * `react-dom` and nothing else.
 */

/** The shipped file. Three levels up from `client/src/domain/` is the repo root. */
const TAXONOMY_PATH = new URL("../../../store/seed/domain-taxonomy.yaml", import.meta.url);

/** `store/src/domain-seed.ts`'s reserved top-level keys — every other top-level key names a cluster. */
const META = new Set(["adjacency", "version", "corrections"]);

/** The shipped clusters, read the way the loader reads them: file order, META keys dropped. */
function shippedClusters(): Array<{ key: string; name: string }> {
  const doc = parseYaml(readFileSync(TAXONOMY_PATH, "utf8")) as Record<
    string,
    { name?: unknown }
  >;
  return Object.keys(doc)
    .filter((key) => !META.has(key))
    .map((key) => ({ key, name: String(doc[key]?.name) }));
}

test("the shipped taxonomy is present and parses to clusters (non-vacuity)", () => {
  const clusters = shippedClusters();
  // The guard cannot quietly scan nothing: an empty or reshaped file fails here rather than
  // comparing two empty lists and passing.
  expect(clusters.length).toBeGreaterThan(0);
  expect(clusters.length).toBe(28);
  expect(clusters.every((cluster) => cluster.name !== "undefined" && cluster.name !== "")).toBe(
    true,
  );
});

test("the picker list is the shipped clusters, in the shipped order", () => {
  // Order included, deliberately: the file's order is the curated order, and re-sorting would add a
  // structure the artifact does not carry (see the module note).
  expect([...DOMAIN_CLUSTERS]).toEqual(shippedClusters());
});

test("the picker's values are unique, so no two options can collide", () => {
  const keys = DOMAIN_CLUSTERS.map((cluster) => cluster.key);
  expect(new Set(keys).size).toBe(keys.length);
});
