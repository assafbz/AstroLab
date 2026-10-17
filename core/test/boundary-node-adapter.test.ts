import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

/**
 * The `node:sqlite` adapter is for tests and CI only (plan invariant 5).
 *
 * `core/src/index.ts` is the package entry the Expo app resolves, so a single `export … from
 * "./store/connection.node.js"` would put a Node built-in into the device bundle — a failure that
 * typecheck, lint and the whole suite pass straight through (it is a *shipping* mistake, not a test
 * one). This guard reads the source tree and fails on it.
 *
 * Both halves of the repo's guard discipline are here: the scanner is itself checked against all
 * three import forms (a silent regex is the classic false-green), and the scan asserts it read the
 * modules it exists for — including the one file that *does* import the adapter, so the pattern it
 * looks for is demonstrably live rather than merely absent.
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
