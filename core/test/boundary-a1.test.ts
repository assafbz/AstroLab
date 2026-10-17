import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * NFR-A1's **structural** half — no vault module can reach the AI boundary (`ARCHITECTURE.md` §4,
 * §13.4; `PRD.md` §4 NFR-A1; `ADR-0004` amended).
 *
 * v1 held this with a guard in `worker/src/provider/boundary.test.ts` that walked every *non-worker*
 * package and failed if one imported the provider. The rebuild re-homes it at the other end of the
 * same edge: **`core/src/vault/**` may not import `core/src/provider/**`** — nor `core/src/engine/**`,
 * which owns the run body that calls the provider. The requirement — *the vault works with the AI
 * unavailable* — holds only while that edge does not exist, so it is checked rather than asserted.
 *
 * The *behaviour* is the fault-injection sibling's (`core/test/nfr-a1.test.ts`): every vault operation
 * passes with the engine down. This file proves the *mechanism* — that a vault module could not reach
 * the provider in the first place. §4 names both halves; neither implies the other.
 *
 * ## Discipline (`AGENTS.md`, guard scope)
 *
 * *Seen failing in the state it forbids*: the pipeline below is exercised on a synthetic module that
 * imports `../provider/index.js` — the exact shape a real violation has — and a real vault file was
 * planted with the same import and watched red in the PR (`core/src/vault/ideas.ts` → restored).
 * Non-vacuity, twice: the walk must find the vault's modules, and the extractor must be shown to see
 * all three import forms.
 *
 * **Residual, named.** This reads *specifiers*, not what a module does: a provider reached through a
 * re-export chain, or a specifier assembled at runtime, is outside what a static walk sees — the limit
 * the v1 guard stated too. It also reads only `core/src/vault/**`; the `app/`-side half (a vault
 * screen reaching no engine module) is L2's (#148).
 */

const CORE = fileURLToPath(new URL("..", import.meta.url));
const VAULT = join(CORE, "src", "vault");

/** The two directories the vault may never reach: the AI boundary, and the engine that calls it. */
const BOUNDARY_DIRS = ["provider", "engine"];
/** The retired package that hosted both (`worker/`, until L3 relocates them) — still reachable by name. */
const BOUNDARY_PACKAGES = ["@astrolab/worker"];

/** Every `.ts` under `dir`, sorted so the offender list is stable. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith(".ts")) found.push(full);
  }
  return found;
}

/**
 * Comments are removed first: a specifier named only in prose is not an import, and a guard that
 * flagged one would be noise. Block first, then line, on the whole source.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Every module specifier a TypeScript source names: `… from "x"`, a bare `import "x"`, `import("x")`. */
function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  const code = stripComments(source);
  for (const match of code.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)) {
    found.add(match[1]!);
  }
  for (const match of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) found.add(match[1]!);
  for (const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.add(match[1]!);
  return [...found];
}

/**
 * Whether a specifier resolves into the AI boundary. Matched on **whole path segments** after the
 * extension is dropped, so `../provider/index.js` and `../../engine/run.js` are reaches while the
 * vault's own `./engine-state.js` — a vault module the deck's state read lives in — is not. A bare
 * package that *is* the boundary is named separately, because it has no directory segment to match.
 */
function reachesBoundary(specifier: string): boolean {
  if (BOUNDARY_PACKAGES.includes(specifier)) return true;
  return specifier
    .split("/")
    .map((segment) => segment.replace(/\.(?:[cm]?[jt]sx?)$/, ""))
    .some((segment) => BOUNDARY_DIRS.includes(segment));
}

test("the specifier scanner sees all three import forms, and only real ones", () => {
  expect(specifiersOf('import a from "./x.js";')).toEqual(["./x.js"]);
  expect(specifiersOf('import "./side-effect.js";')).toEqual(["./side-effect.js"]);
  expect(specifiersOf('export * from "./y.js";')).toEqual(["./y.js"]);
  expect(specifiersOf('const p = await import("./z.js");')).toEqual(["./z.js"]);
  // A multi-line import, the form a `from "…"`-only matcher still gets — kept as the reminder that the
  // walk has to survive formatting.
  expect(specifiersOf('import {\n  a,\n  b,\n} from "./multi.js";')).toEqual(["./multi.js"]);
  // …and prose is not a specifier, in either comment form.
  expect(specifiersOf("// import x from './comment.js'")).toEqual([]);
  expect(specifiersOf("/* import x from './block.js' */")).toEqual([]);
});

test("the boundary rule accepts the vault's real specifiers and refuses a provider/engine reach", () => {
  // Both directions, or a rule that refused (or accepted) everything would read exactly like a pass.
  for (const refused of [
    "../provider/index.js",
    "../engine/run.js",
    "../../engine/gate.js",
    "@astrolab/worker",
    "@astrolab/core/provider",
  ]) {
    expect(reachesBoundary(refused), refused).toBe(true);
  }
  for (const allowed of [
    "./engine-state.js",
    "./capture.js",
    "../store/connection.js",
    "../store/index.js",
    "node:crypto",
  ]) {
    expect(reachesBoundary(allowed), allowed).toBe(false);
  }
});

test("the guard's pipeline flags a planted boundary import, and not the near miss", () => {
  // The state the guard exists to forbid, as a synthetic module — the exact string the planted file
  // carried in the PR. Non-vacuity for `reachesBoundary` + `specifiersOf` together, not each alone.
  const planted = [
    'import type { SqliteConnection } from "../store/connection.js";',
    'import { extract } from "../provider/index.js";',
  ].join("\n");
  expect(specifiersOf(planted).filter(reachesBoundary)).toEqual(["../provider/index.js"]);

  // The near miss the whole-segment rule exists for: `engine-state` is a *vault* module, and a
  // substring rule would flag it — which is why the rule strips the extension and compares segments.
  expect(
    specifiersOf('import { engineState } from "./engine-state.js";').filter(reachesBoundary),
  ).toEqual([]);
});

test("the scan is real — it reads the vault's modules and their specifiers", () => {
  const modules = walk(VAULT).filter((file) => !file.endsWith(".test.ts"));
  const rel = modules.map((file) => relative(CORE, file));

  // Non-vacuity, part one: the walk found the directory it exists for — the vault's modules, named.
  expect(rel.length).toBeGreaterThanOrEqual(12);
  expect(rel).toContain("src/vault/capture.ts");
  expect(rel).toContain("src/vault/engine-state.ts");
  // …and tests are out of scope on purpose: a vault test may hold a *planted* boundary string as its
  // own fixture (the three per-module specifier guards do), which is a string, not an import.
  expect(rel.some((name) => name.endsWith(".test.ts"))).toBe(false);
  expect(walk(VAULT).some((file) => file.endsWith(".test.ts"))).toBe(true);

  // Non-vacuity, part two: a module that *does* import something is read, so "no offenders" below is
  // a verdict about a live scan rather than one that has quietly stopped extracting specifiers.
  const capture = readFileSync(join(VAULT, "capture.ts"), "utf8");
  expect(specifiersOf(capture)).toContain("../store/index.js");
});

test("no vault module imports the AI boundary or the engine", () => {
  const offenders = walk(VAULT)
    .filter((file) => !file.endsWith(".test.ts"))
    .flatMap((file) =>
      specifiersOf(readFileSync(file, "utf8"))
        .filter(reachesBoundary)
        .map((specifier) => `${relative(CORE, file)} → ${specifier}`),
    );

  expect(offenders).toEqual([]);
});
