import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { NoKeyError } from "./types.js";
import { normalizeKey, readKey, type KeyStore } from "./key.js";

/**
 * The key's hygiene, as checked invariants (NFR-PRIV1; `ARCHITECTURE.md` §5, §11; L3 · #166, T3).
 *
 * The key is the user's, it is not ours to leak, and the leak classes are enumerable: a **log**, a
 * **vault row**, the **export**, and a **second reader** — a module other than the accessor that reads
 * the port and can therefore write the key somewhere. Each is a structural claim about the source
 * tree, so each is a walk rather than a promise. `key.ts` states the design; this file makes it true.
 *
 * Discipline (`AGENTS.md`, guard scope): every arm is seen failing in the state it forbids — a planted
 * `console.log(key)` and a planted reader outside `provider/` redden the suite in the PR, and each
 * matcher has a positive control so "no offenders" is a verdict about a live scan.
 */
const CORE = fileURLToPath(new URL("../../", import.meta.url));
const PROVIDER = join(CORE, "src", "provider");
const SHIPPED = [...walk(join(CORE, "src"))].filter((file) => !file.endsWith(".test.ts"));

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (full.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Every module specifier a TypeScript source names — `from "x"`, a bare `import "x"`, `import("x")`. */
function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)) {
    found.add(match[1]!);
  }
  for (const match of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) found.add(match[1]!);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    found.add(match[1]!);
  }
  return [...found];
}

const rel = (file: string): string => relative(CORE, file).split(/[\\/]/).join("/");
const source = (file: string): string => readFileSync(file, "utf8");

/**
 * Comments are removed before a *name* is matched: a docstring citing v1's bearer header is history (a
 * retired transport's, in `domain/deck-stream.ts`), not a channel a value can travel through. Block
 * first, then line — the repo's extractor (`core/test/boundary-a1.test.ts`).
 */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/** Does a specifier reach the accessor **module**? The provider's entry is not the accessor: importing
 * the `Provider` interface is the engine's normal business, and only `key.js` reads the key. */
function reachesKeyModule(specifier: string): boolean {
  return /(^|\/)key\.js$/.test(specifier);
}

/** A log sink: the call, not the word — `console.log(` and a `logger.info(`-shaped method call. */
const LOG_CALL = /\bconsole\s*\.\s*\w+\s*\(|process\s*\.\s*(?:stdout|stderr)\s*\.\s*write\s*\(/;

/** The key's **value channels**, as names: v1's env var, the header, and the scheme itself. */
const KEY_VALUE = /\bapiKey\b|\bAuthorization\b|\bBearer\b/i;

/** The key vocabulary *at all* — used where not even a mention belongs (the vault, the export). */
const KEY_VOCABULARY =
  /\bKeyStore\b|\breadKey\b|\bnormalizeKey\b|\bapiKey\b|\bAuthorization\b|\bBearer\b/i;

describe("the key is read in exactly one place", () => {
  const ACCESSOR = join(PROVIDER, "key.ts");

  test("the scan is real — it reads the shipped tree, and the accessor is in it", () => {
    // Non-vacuity: without this, a broken walk turns every assertion below into a silent pass.
    expect(SHIPPED.length).toBeGreaterThan(30);
    expect(SHIPPED.map(rel)).toContain("src/provider/key.ts");
    expect(SHIPPED.map(rel)).toContain("src/provider/openrouter.ts");
    // …and the walk really excludes tests, which legitimately hold planted strings.
    expect(SHIPPED.some((file) => file.endsWith(".test.ts"))).toBe(false);
    expect(readdirSync(PROVIDER).some((name) => name === "key.test.ts")).toBe(true);
  });

  test("no shipped module outside the boundary imports the accessor", () => {
    const offenders = SHIPPED.filter((file) => !file.startsWith(PROVIDER)).flatMap((file) =>
      specifiersOf(source(file))
        .filter(reachesKeyModule)
        .map((specifier) => `${rel(file)} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
    // Non-vacuity: the accessor is imported somewhere, so "no offenders" is a verdict about a live
    // matcher rather than about a specifier nobody writes.
    expect(
      SHIPPED.filter((file) => file.startsWith(PROVIDER)).flatMap((file) =>
        specifiersOf(source(file)).filter(reachesKeyModule),
      ).length,
    ).toBeGreaterThan(0);
  });

  test("no shipped module outside the boundary names a key *value* channel", () => {
    // Weaker than the port's name and stronger where it matters: `KeyStore` in another module's
    // docstring is a type and a description, but `apiKey` / `Authorization` / `Bearer` are how a value
    // travels — outside the boundary those names have no business at all.
    const offenders = SHIPPED.filter(
      (file) => !file.startsWith(PROVIDER) && KEY_VALUE.test(code(file)),
    );

    expect(offenders.map(rel)).toEqual([]);
    // Positive control: the boundary does name them, so the matcher bites on real text.
    expect(KEY_VALUE.test(code(join(PROVIDER, "openrouter.ts")))).toBe(true);
    expect(KEY_VALUE.test(code(ACCESSOR))).toBe(false); // the port is a type; the value names are not here
    // …and the comment-stripper really strips: this file's own header prose names the channels.
    expect(KEY_VALUE.test(source(ACCESSOR))).toBe(false);
  });

  test("the extractor and the vocabulary matcher see real inputs, not just absent ones", () => {
    expect(specifiersOf('import { readKey } from "./key.js";')).toEqual(["./key.js"]);
    expect(
      specifiersOf('import { readKey } from "@astrolab/core/dist/provider/index.js";'),
    ).toEqual(["@astrolab/core/dist/provider/index.js"]);
    expect(reachesKeyModule("./key.js")).toBe(true);
    // Near misses the rule must not swallow: a sibling, and the provider's entry — reaching the
    // `Provider` interface is the engine's business and is not reaching the key.
    expect(reachesKeyModule("./keys.js")).toBe(false);
    expect(reachesKeyModule("./schema.js")).toBe(false);
    expect(reachesKeyModule("../provider/index.js")).toBe(false);
  });
});

describe("the key never reaches a log (NFR-PRIV1)", () => {
  test("no module in the boundary calls a log sink at all", () => {
    // The boundary is the only place the key value exists, so the strongest cheap claim is that the
    // boundary logs nothing: no sink, no leak, whatever the value. A future need for diagnostics has
    // to arrive as a deliberate, reviewed sink rather than as a `console.log` nobody noticed.
    const offenders = SHIPPED.filter(
      (file) => file.startsWith(PROVIDER) && LOG_CALL.test(source(file)),
    );

    expect(offenders.map(rel)).toEqual([]);
  });

  test("the log matcher bites on a call and not on prose", () => {
    expect(LOG_CALL.test("console.log(key)")).toBe(true);
    expect(LOG_CALL.test("  process.stdout.write(key)")).toBe(true);
    expect(LOG_CALL.test("// console.log(key) — removed")).toBe(true); // a *call* inside a comment is still a call site to fix
    expect(LOG_CALL.test("the console.log path was retired")).toBe(false);
    expect(LOG_CALL.test("logger.info(key)")).toBe(false); // named, not silently matched
  });
});

describe("the key cannot reach a vault row or the export (NFR-PRIV1)", () => {
  test("neither the vault nor the export names the key", () => {
    // The value-level half of NFR-A1: the vault may not *reach* the provider (asserted structurally
    // in `core/test/boundary-a1.test.ts`), and it must not carry the key's name either — a key in a
    // vault row would be exported, backed up and synced by definition.
    const offenders = SHIPPED.filter(
      (file) => /src\/(vault|export)\//.test(rel(file)) && KEY_VOCABULARY.test(code(file)),
    );

    expect(offenders.map(rel)).toEqual([]);
    // Non-vacuity: those directories have shipped modules, and every one of them was read.
    expect(
      SHIPPED.filter((file) => /src\/(vault|export)\//.test(rel(file))).length,
    ).toBeGreaterThan(10);
  });
});

describe("normalizeKey / readKey — what 'set' means", () => {
  const store = (value: string | null): KeyStore => ({
    get: async () => value,
    set: async () => {},
    clear: async () => {},
  });

  test("a blank or whitespace-only value is absent, not a key", () => {
    expect(normalizeKey(null)).toBeNull();
    expect(normalizeKey(undefined)).toBeNull();
    expect(normalizeKey("")).toBeNull();
    expect(normalizeKey("   ")).toBeNull();
    expect(normalizeKey("  sk-or-v1-abc  ")).toBe("sk-or-v1-abc");
  });

  test("readKey returns the trimmed key", async () => {
    await expect(readKey(store(" sk-or-v1-abc "))).resolves.toBe("sk-or-v1-abc");
  });

  test("readKey throws NoKeyError rather than handing an empty key to the network", async () => {
    await expect(readKey(store(null))).rejects.toBeInstanceOf(NoKeyError);
    await expect(readKey(store("   "))).rejects.toBeInstanceOf(NoKeyError);
    await expect(readKey(store(null))).rejects.toThrow(/no API key is set/);
  });
});
