import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * The device bundle carries no `node:` specifier (plan invariant 5).
 *
 * `core/src/index.ts` is the package entry the Expo app resolves, so a single `export … from
 * "./store/connection.node.js"` would put a Node built-in into the device bundle — a failure that
 * typecheck, lint and the whole suite pass straight through (it is a *shipping* mistake, not a test
 * one). This guard reads the source tree and fails on it.
 *
 * **Two scans, one principle.** The first is flat: no shipped `core/src` module imports the adapter.
 * The second (and the one that would have caught #184) walks the **transitive closure of the entry**
 * and fails on *any* `node:` specifier in it — `node:fs`/`node:url` in the taxonomy loader and
 * `node:crypto` in the writers were reachable from the app while this file watched one module name.
 * A flat grep cannot see a closure, which is exactly how four defects of this class shipped.
 *
 * Both halves of the repo's guard discipline are here: the scanner is itself checked against all
 * three import forms (a silent regex is the classic false-green), the scan asserts it read the
 * modules it exists for, and the closure walk keeps a **positive control** — the adapter, which *does*
 * reach `node:sqlite`, is walked by the same function and must be reported — so a green verdict is a
 * verdict and not a walker that quietly stopped resolving.
 */

const CORE = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(CORE, "src");
const ADAPTER = "src/store/connection.node.ts";

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

test("the specifier scanner sees all three import forms, and only real ones", () => {
  expect(specifiersOf('import a from "./x.js";')).toEqual(["./x.js"]);
  expect(specifiersOf('import "./side-effect.js";')).toEqual(["./side-effect.js"]);
  expect(specifiersOf('export * from "./y.js";')).toEqual(["./y.js"]);
  expect(specifiersOf('const p = await import("./z.js");')).toEqual(["./z.js"]);
  // A multi-line import, the form a naive `from "…"`-only matcher still gets — kept as the reminder
  // that the walk has to survive formatting.
  expect(specifiersOf('import {\n  a,\n  b,\n} from "./multi.js";')).toEqual(["./multi.js"]);
  // …and prose is not a specifier, in either comment form.
  expect(specifiersOf("// import x from './comment.js'")).toEqual([]);
  expect(specifiersOf("/* import x from './block.js' */")).toEqual([]);
});

test("no shipped core/src module imports the node:sqlite adapter", () => {
  const modules = walk(SRC).filter((file) => !file.endsWith(".test.ts"));
  const rel = modules.map((file) => relative(CORE, file));

  // Non-vacuity: the walk found the package it means to guard, and the guard's own target is present.
  expect(rel.length).toBeGreaterThanOrEqual(3);
  expect(rel).toContain(ADAPTER);
  expect(rel).toContain("src/store/connection.ts");

  const offenders = modules.flatMap((file) =>
    specifiersOf(readFileSync(file, "utf8"))
      .filter((specifier) => specifier.includes("connection.node"))
      .map((specifier) => `${relative(CORE, file)} → ${specifier}`),
  );
  expect(offenders).toEqual([]);

  // …and the pattern is live: the adapter's own test imports it, so "no offenders" is a verdict,
  // not a scanner that has quietly stopped matching.
  const testFile = join(SRC, "store", "connection.test.ts");
  expect(specifiersOf(readFileSync(testFile, "utf8"))).toContain("./connection.node.js");
  expect(dirname(testFile)).toBe(join(SRC, "store"));
});

/**
 * The device half of the same posture (L3 · #166). The app supplies the `expo-sqlite` adapter and the
 * secure-store key adapter; `core/` supplies neither, so the two claims below are the mirror of the
 * `node:sqlite` one above — and the second is plan invariant 10's: `expo-sqlite` implements sync on web
 * through a Worker + `Atomics.wait`, and the async transaction API it offers there is **unsupported**
 * (`withExclusiveTransactionAsync`), which is one reason the port is synchronous-only (`connection.ts`).
 */
test("no shipped core/src module imports an expo package, or the async transaction API", () => {
  const modules = walk(SRC).filter((file) => !file.endsWith(".test.ts"));
  const rel = modules.map((file) => relative(CORE, file));

  // Non-vacuity: the walk found the package, and the matchers are live on text that exists somewhere.
  expect(rel.length).toBeGreaterThanOrEqual(3);
  expect(rel).toContain(ADAPTER);

  const EXPO = /^expo(-|$)/;
  const expoOffenders = modules.flatMap((file) =>
    specifiersOf(readFileSync(file, "utf8"))
      .filter((specifier) => EXPO.test(specifier))
      .map((specifier) => `${relative(CORE, file)} → ${specifier}`),
  );
  expect(expoOffenders).toEqual([]);
  // …and the matcher is live: the package name the app installs matches it, a near miss does not.
  expect(EXPO.test("expo-sqlite")).toBe(true);
  expect(EXPO.test("expo-secure-store")).toBe(true);
  expect(EXPO.test("express")).toBe(false);

  // Plan invariant 10: the async transaction API is unsupported on web, and the port is sync-only —
  // so nothing in `core/` may name it. The claim is structural; `connection.ts` states the reason.
  const ASYNC_API = /withExclusiveTransactionAsync|withTransactionAsync/;
  expect(
    modules
      .filter((file) => ASYNC_API.test(readFileSync(file, "utf8")))
      .map((file) => relative(CORE, file)),
  ).toEqual([]);
  // A unit control: the matcher bites on the call and not on a shorter name that contains it.
  expect(ASYNC_API.test("await db.withExclusiveTransactionAsync(async (tx) => tx);")).toBe(true);
  expect(ASYNC_API.test("db.withTransactionSync(() => {})")).toBe(false);
});

/**
 * The **entry closure** — everything the app can reach by importing `core/src/index.ts` (#184).
 *
 * The walk resolves **relative** specifiers only, following `./x.js` → `x.ts`; a bare package
 * (`yaml`) is a dependency Metro bundles, not a module of ours to inspect, and a `node:` specifier is
 * the finding rather than an edge to follow.
 */
const ENTRY = join(SRC, "index.ts");

/** `./x.js` → `x.ts` (NodeNext), and plainly `./x` → `x.ts`. `null` for a specifier we do not own. */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, base]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every file reachable from `entry` by relative imports, with the specifiers each one names. */
function closureOf(entry: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (found.has(file)) continue;
    const specifiers = specifiersOf(readFileSync(file, "utf8"));
    found.set(file, specifiers);
    for (const specifier of specifiers) {
      const next = resolveSpecifier(file, specifier);
      if (next !== null && !found.has(next)) queue.push(next);
    }
  }
  return found;
}

/** The `node:` specifiers a closure names, as `file → specifier` lines. */
function nodeSpecifiersIn(closure: Map<string, string[]>): string[] {
  return [...closure.entries()].flatMap(([file, specifiers]) =>
    specifiers
      .filter((specifier) => specifier.startsWith("node:"))
      .map((specifier) => `${relative(CORE, file)} → ${specifier}`),
  );
}

test("the entry's closure is actually walked — the modules the app ships are the ones inspected", () => {
  const closure = closureOf(ENTRY);
  const rel = [...closure.keys()].map((file) => relative(CORE, file)).sort();

  // Non-vacuity: a walk that resolved nothing (a broken `./x.js` → `x.ts` rule) would report no
  // offenders and read as green. It must contain the entry, the store it re-exports, and the four
  // modules #184 was about.
  expect(rel.length).toBeGreaterThanOrEqual(10);
  expect(rel).toContain("src/index.ts");
  expect(rel).toContain("src/store/index.ts");
  expect(rel).toContain("src/store/domain-seed.ts");
  expect(rel).toContain("src/store/runs.ts");
  expect(rel).toContain("src/store/sparks.ts");
  expect(rel).toContain("src/store/ids.ts");

  // …and the two deliberate Node-only modules are *not* on it: they are how the tree talks to its
  // filesystem, and `src/index.ts` must not re-export either.
  expect(rel).not.toContain(ADAPTER);
  expect(rel).not.toContain("src/seed/taxonomy-file.node.ts");
});

test("no module in the entry's closure names a node: specifier (#184)", () => {
  expect(nodeSpecifiersIn(closureOf(ENTRY))).toEqual([]);
});

test("…and the walk bites: rooted at the adapter it reports node:sqlite (the positive control)", () => {
  // The control that makes the test above a verdict: the same closure walk, the same extractor, over a
  // file in this tree that *does* reach a Node built-in. If the walker stops resolving, this goes red.
  const adapterClosure = closureOf(join(CORE, ADAPTER));
  expect([...adapterClosure.keys()].map((file) => relative(CORE, file))).toContain(ADAPTER);
  expect(nodeSpecifiersIn(adapterClosure)).toContain("src/store/connection.node.ts → node:sqlite");
});
