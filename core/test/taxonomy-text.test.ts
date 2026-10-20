import { expect, test } from "vitest";

import { DOMAIN_TAXONOMY_TEXT } from "../src/seed/domain-taxonomy.js";
import { readTaxonomyFile } from "../src/seed/taxonomy-file.node.js";
import { parseTaxonomy } from "../src/store/domain-seed.js";

/**
 * The **drift guard** between the artifact of record and the text the bundle carries (#184).
 *
 * `core/seed/domain-taxonomy.yaml` is the artifact (`core/seed/README.md`; `o1_check.py` reads it), and
 * `core/src/seed/domain-taxonomy.ts` is *generated* from it so a device bundle — which has no
 * filesystem — can still seed the taxonomy. Two copies of one thing drift by convention; this file is
 * what makes the drift a red test.
 *
 * Deriving the expectation from the file (not from the generator's own output) is the point: the
 * comparison is the file's bytes against the shipped constant, and the last test shows the comparison
 * can fail.
 */

test("the shipped text is the artifact of record, byte for byte", () => {
  const file = readTaxonomyFile();
  // Non-vacuity first: an empty file and an empty constant would make the equality below meaningless.
  expect(file.length).toBeGreaterThan(1000);
  expect(file).toContain("devtools:");
  expect(file).toBe(DOMAIN_TAXONOMY_TEXT);
});

test("both sources parse to the same taxonomy — clusters, adjacency, version and corrections", () => {
  const fromBundle = parseTaxonomy(DOMAIN_TAXONOMY_TEXT, "bundle");
  const fromFile = parseTaxonomy(readTaxonomyFile(), "file");

  expect(fromBundle.clusters.length).toBe(28);
  expect(fromBundle).toEqual(fromFile);
});

test("…and the comparison bites: a changed cluster is not equal to the shipped text", () => {
  // A near miss, so "they are equal" is a verdict rather than a matcher that never fires. A cluster's
  // `name` is the right field to move: renaming the *key* would also invalidate the adjacency pairs,
  // and then this would be testing that a broken document throws rather than that the comparison bites.
  const mutated = DOMAIN_TAXONOMY_TEXT.replace(
    'name: "Developer tools"',
    'name: "Developer tooling"',
  );
  expect(mutated).not.toBe(DOMAIN_TAXONOMY_TEXT);
  expect(parseTaxonomy(mutated, "mutated")).not.toEqual(
    parseTaxonomy(DOMAIN_TAXONOMY_TEXT, "same"),
  );
});
