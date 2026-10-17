import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import * as entry from "../src/index.js";

/**
 * The entry's shape (`core/src/index.ts`) is a contract two other things lean on — the app, which may
 * import `core` and nothing else of it, and `app/src/domain/deck-interaction.test.ts`, whose rule is a
 * specifier walk over exactly this surface. So it gets a guard of its own, in the same discipline as
 * `boundary-node-adapter.test.ts`, whose subject is what the entry must *not* reach.
 *
 * What it exists for: **`export *` is not a union.** When two re-exported modules export the same
 * *name*, the entry re-exports **neither**, silently — and this entry deliberately carries modules that
 * overlap. `./types.ts` alone declares thirteen names in parallel with `./vault/**` (`Idea`,
 * `IdeaDetail`, `VaultSummary`, `Spark`, `SparkDetail`, … identical fields, distinct declarations; a v1
 * inheritance, not a rebuild defect), and `./vault/metrics.ts` / `./vault/metrics-report.ts` collide on
 * `MonthlyCount`. A `export * from "./types.js"` added later would therefore drop all thirteen without a
 * red test — unless this file is here. The four exclusions are asserted absent by name for the same
 * reason.
 *
 * Verified when the entry was widened (L2 / #165, at `fdb8b50`): 24 modules · 62 type names · 118 value
 * names — every value name present at runtime, every type name resolvable by `tsc`. The runtime half is
 * re-asserted here; the type half is `tsc`'s, because a vitest test cannot see an erased name.
 *
 * **Seen failing, and the plant is instructive** (2026-10-17): appending `export * from "./types.js";`
 * fails the **first** test and *passes* the second — the names a wildcard union drops here are all
 * types, so the runtime half is blind to them. The module-set assertion is therefore the load-bearing
 * one, which is why it is written as an equality against a list derived from the tree rather than as a
 * "none of the exclusions" check.
 */

const CORE = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(CORE, "src");
const ENTRY = join(SRC, "index.ts");

/** Deliberately off the entry. The reason for each is in `src/index.ts`. */
const EXCLUDED = ["types", "vault/metrics", "vault/metrics-report", "domain/deck-stream"];

function modulesIn(dir: string): string[] {
  return readdirSync(join(SRC, dir))
    .sort()
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => `${dir}/${file.slice(0, -3)}`);
}

/** The modules the entry *should* re-export: every shipped module, minus the exclusions. */
function expectedModules(): string[] {
  return [...modulesIn("vault"), ...modulesIn("domain"), "store/index"]
    .filter((module) => !EXCLUDED.includes(module))
    .sort();
}

/** The modules the entry *does* re-export, read off its own source rather than restated here. */
function reExportTargets(): string[] {
  return [...readFileSync(ENTRY, "utf8").matchAll(/^export \* from "\.\/(.+?)\.js";/gm)]
    .map((match) => match[1]!)
    .sort();
}

/**
 * A module's **value** exports — `const` · `function` · `class` · `enum`, plus the value half of an
 * `export { … }` clause. Only these can be reached from a bundle; interfaces and type aliases are
 * erased, which is why they are `tsc`'s half of the claim and not this test's.
 */
function valueNamesOf(relativePath: string): string[] {
  const source = readFileSync(join(SRC, relativePath + ".ts"), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(
    /^export (?:declare )?(?:const|function|class|enum) ([A-Za-z_]\w*)/gm,
  )) {
    names.add(match[1]!);
  }
  for (const match of source.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const raw of match[1]!.split(",")) {
      const item = raw.trim();
      if (item.length === 0 || item.startsWith("type ")) continue;
      const name = item.split(" as ").pop()!.trim();
      if (/^[A-Za-z_]\w*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

test("the entry re-exports every module it should, and none of the four it should not", () => {
  const targets = reExportTargets();
  // Non-vacuity: the reader found the entry and a real body of modules, not an empty or renamed file.
  expect(targets.length).toBeGreaterThanOrEqual(20);
  expect(statSync(ENTRY).isFile()).toBe(true);

  expect(targets).toEqual(expectedModules());
  for (const excluded of EXCLUDED) expect(targets).not.toContain(excluded);
});

test("every value a re-exported module declares is reachable from the entry", () => {
  const keys = new Set(Object.keys(entry));
  // Non-vacuity: this is the widened entry, not one module that happens to exist.
  expect(keys.size).toBeGreaterThanOrEqual(100);

  const modules = reExportTargets();
  const missing = modules.flatMap((module) =>
    valueNamesOf(module)
      .filter((name) => !keys.has(name))
      .map((name) => `${relative(CORE, join(SRC, module))} → ${name}`),
  );
  expect(missing).toEqual([]);
});
