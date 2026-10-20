#!/usr/bin/env node
// The taxonomy text the device bundle carries (ARCHITECTURE.md §3.4: "the seed now ships **in the app
// bundle** and is applied at first launch").
//
// `core/seed/domain-taxonomy.yaml` stays the artifact of record — `o1_check.py` and the tree's own
// guards read *that file*. A device bundle cannot read a file (no `node:fs` under Metro), so the entry
// needs the text as data: this script derives `core/src/seed/domain-taxonomy.ts` from the YAML, and
// `core/test/taxonomy-text.test.ts` fails the moment the two drift.
//
// Run after any edit to the YAML:  node scripts/gen-taxonomy-text.mjs
//
// The emitted module is written in the exact shape `prettier` keeps (the assignment breaks before the
// long literal), so regenerating is a no-op for `npm run format` — checked by
// `core/test/taxonomy-text.test.ts`, which also re-derives the text from the YAML.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const yamlPath = `${root}core/seed/domain-taxonomy.yaml`;
const outPath = `${root}core/src/seed/domain-taxonomy.ts`;

const text = readFileSync(yamlPath, "utf8");

const module = `/**
 * The shipped taxonomy **as text**, for a bundle that has no filesystem (ARCHITECTURE.md §3.4).
 *
 * GENERATED — do not edit by hand. \`core/seed/domain-taxonomy.yaml\` is the artifact of record;
 * \`node scripts/gen-taxonomy-text.mjs\` derives this file, and \`core/test/taxonomy-text.test.ts\`
 * fails if the two drift. The bytes here and in the YAML are one source, checked, not duplicated by
 * convention.
 *
 * Why a literal rather than a read: Metro resolves \`node:fs\` to an empty module, so a loader that
 * read the file at boot made the whole entry un-importable on device and web (issue #184).
 */
export const DOMAIN_TAXONOMY_TEXT: string =
  ${JSON.stringify(text)};
`;

writeFileSync(outPath, module);
console.log(`[gen-taxonomy-text] ${outPath} <- ${yamlPath} (${text.length} bytes)`);
