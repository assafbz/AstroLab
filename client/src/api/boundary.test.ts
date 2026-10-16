import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * The `client/src/api/` → `client/src/domain/` boundary (`AGENTS.md`'s guard discipline; the same shape
 * as `worker/src/provider/boundary.test.ts`, one package over).
 *
 * Every other edge in the client runs **`domain/` → `api/`**: a rule module may take the transport's
 * shapes, and `domain/deck-interaction.ts` already states the rule for the screens — *"Only a value
 * import can post anything, so a `type`-only `../api/` import is fine and any other is not."* K7 `#41`
 * adds the mirror: `api/decisions.ts` takes the seam's `ResolutionKind` as **`import type`**, so the
 * union has one declaration rather than a second spelling in the transport.
 *
 * That edge is only safe while it stays type-only. A **value** import from `api/` into `domain/` would
 * make the two packages mutually dependent at runtime — a cycle, not just a layering slip — and the
 * graph would no longer be acyclic by construction. The claim was JSDoc prose until this guard; a
 * structural claim asserted only in prose is not a check (`AGENTS.md`).
 *
 * **Residual, named:** it reads *specifiers*, not what the modules do. A type-only import of a value,
 * or a value smuggled through a re-export, is outside what a static specifier walk can see.
 */

const API_DIR = fileURLToPath(new URL(".", import.meta.url));

/** An import into `domain/` found in an `api/` module: where it came from, and whether it is type-only. */
interface DomainImport {
  name: string;
  specifier: string;
  typeOnly: boolean;
}

/** Every non-test module under `client/src/api`, with its source. */
function apiModules(): { name: string; source: string }[] {
  return readdirSync(API_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, source: readFileSync(join(API_DIR, name), "utf8") }));
}

/**
 * The `domain/` imports in one source, type-only ones flagged.
 *
 * Two shapes, and both must be read or the walk is blind to the quiet one: a **side-effect** import
 * (`import "../domain/x.ts"`) has no `from` at all — the exact miss `AGENTS.md` records for this
 * guard's sibling. Imports may also span lines, so the specifier pattern is allowed to.
 */
function domainImports(name: string, source: string): DomainImport[] {
  const found: DomainImport[] = [];

  for (const match of source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gm)) {
    const specifier = match[2]!;
    if (specifier.startsWith("../domain/")) {
      found.push({ name, specifier, typeOnly: match[1] !== undefined });
    }
  }
  for (const match of source.matchAll(/^import\s+"([^"]+)";/gm)) {
    const specifier = match[1]!;
    if (specifier.startsWith("../domain/")) {
      found.push({ name, specifier, typeOnly: false });
    }
  }

  return found;
}

test("`api/` imports `domain/` only as a type — the graph stays one-way at runtime (K7 #41)", () => {
  const modules = apiModules();
  // Non-vacuity, part one: the walk must be reading the package — several modules, and one of them the
  // module this edge belongs to. An empty (or one-file) read would satisfy the rule below for the wrong
  // reason. `client.ts` legitimately has no imports, so the check is "more than one has some".
  expect(modules.map((module) => module.name)).toContain("decisions.ts");
  expect(modules.filter((module) => module.source.includes("import")).length).toBeGreaterThan(1);

  const found = modules.flatMap((module) => domainImports(module.name, module.source));

  // Non-vacuity, part two: the scan must actually *see* the edge it exists for — the one K7 added.
  expect(found).toContainEqual({
    name: "decisions.ts",
    specifier: "../domain/deck-interaction.ts",
    typeOnly: true,
  });

  // The rule: no value import from `domain/` anywhere under `api/`.
  expect(found.filter((entry) => !entry.typeOnly)).toEqual([]);
});
