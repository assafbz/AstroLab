import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * #186's regression guard: **no shipped `app/` module may name `expo-sqlite`'s sync opener.**
 *
 * The defect was structural, not a typo. `expo-sqlite`'s web target runs SQLite in a worker that boots
 * lazily; the sync opener's *first* call asks that cold worker to answer inside a main-thread busy-wait
 * (~133 ms of budget against a worker that needs ~200 ms to exist), so it threw `Sync operation timeout`
 * on every cold load. The fix is that the vault's one open goes through the **async** opener. Nothing in
 * the type system stops a future module from reaching for the sync one again — `await openDatabaseSync(n)`
 * even typechecks as a `Promise` — so this walks the shipped source instead.
 *
 * **Scope, stated so the negative is not read wider than it is.** The walk covers `app/src/**` (shipped
 * modules only; `*.test.ts` are skipped, since stubbing the opener is exactly what the adapter's own test
 * does). It matches the *identifier*, which is what every import form carries — named, aliased
 * (`import { openDatabaseSync as open }`) and namespace (`ns.openDatabaseSync(...)`) all normalise to it.
 * A name assembled at runtime (`ns["openDatabase" + "Sync"]`) is not reachable by a text walk; that is the
 * limit and it is accepted rather than papered over.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The identifier, across the spelling space an import can produce. */
const SYNC_OPEN = /\bopenDatabaseSync\b/;

function shippedSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) shippedSources(path, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Comments are stripped, so a doc line that names the opener is not read as a call site. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the vault is never opened synchronously from app source (#186)", () => {
  test("no shipped module names the sync opener", () => {
    const files = shippedSources(SRC);
    // Non-vacuity: the walk found the tree it exists for, or "no offenders" means nothing.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain(join(SRC, "store", "expoConnection.ts"));

    const offenders = files.filter((f) => SYNC_OPEN.test(withoutComments(readFileSync(f, "utf8"))));
    expect(offenders).toEqual([]);
  });

  test("the matcher bites — and its near miss stays green", () => {
    expect(SYNC_OPEN.test('import { openDatabaseSync } from "expo-sqlite";')).toBe(true);
    expect(SYNC_OPEN.test('import { openDatabaseSync as open } from "expo-sqlite";')).toBe(true);
    expect(SYNC_OPEN.test('const db = SQLite.openDatabaseSync("astrolab.db");')).toBe(true);
    // Near-miss control: the async opener must NOT be matched, or the guard buys its green by over-matching.
    expect(SYNC_OPEN.test('const db = await openDatabaseAsync("astrolab.db");')).toBe(false);
  });

  test("and the adapter does use the async opener", () => {
    const adapter = withoutComments(readFileSync(join(SRC, "store", "expoConnection.ts"), "utf8"));
    expect(adapter).toMatch(/\bopenDatabaseAsync\b/);
  });
});
