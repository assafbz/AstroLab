import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The seed **file** — for tests, CI and scripts, never for the app (#184).
 *
 * `core/seed/domain-taxonomy.yaml` is the artifact of record (`core/seed/README.md`): `o1_check.py`
 * reads it, and the tree's own guards read it. Those are Node programs, so `node:fs` is exactly right
 * for them.
 *
 * The **device** cannot read a file: Metro resolves `node:fs` to an empty module, so a loader that
 * read the YAML at boot made the whole entry un-importable on device and web. The app therefore gets
 * the text from {@link DOMAIN_TAXONOMY_TEXT} (`core/src/seed/domain-taxonomy.ts`, generated from this
 * file), and this module is deliberately **not** reachable from `core/src/index.ts` — same posture as
 * `store/connection.node.ts`, with the same guard (`core/test/boundary-node-adapter.test.ts`).
 *
 * `seed/` sits at the **package root**, so `../../seed/…` resolves from `src/seed/` (tsx) and from
 * `dist/seed/` (the built entry) alike.
 */
export const TAXONOMY_PATH = fileURLToPath(
  new URL("../../seed/domain-taxonomy.yaml", import.meta.url),
);

/** The shipped bytes, read from the artifact of record. */
export function readTaxonomyFile(): string {
  return readFileSync(TAXONOMY_PATH, "utf8");
}
