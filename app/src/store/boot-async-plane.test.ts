import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * #186's boot-plane guard: **no shipped `app/` module may call the store's synchronous boot entry
 * points.** `openStore` · `migrate` · `seedDomainTaxonomy` are the boot's writes — the WAL conversion,
 * DDL, `COMMIT`/`ROLLBACK`, `PRAGMA user_version`, the seed's upserts — and on web each fsyncs past the
 * ~133 ms busy-wait budget, so a *sync* call loses the race on a cold worker (measured: 18 red loads in
 * 19). The fix is that they run on the async plane (`…Async`, #186); nothing in the type system stops a
 * future module from reaching for the sync one again — it is a fine API, just not on this path — so this
 * walks the shipped source instead.
 *
 * **Scope, stated so the negative is not read wider than it is.** The walk covers `app/src/**` (shipped
 * modules only; `*.test.ts` are skipped, since a test may drive either plane). It matches the three
 * *identifiers*, which is what every call form carries — a member call (`core.migrate(...)`) and an alias
 * both keep the name. Two limits, accepted rather than papered over: a name assembled at runtime is not
 * reachable by a text walk, and this does not inspect **raw SQL** — a hand-written `INSERT` in `app/`
 * would be a different defect (a rule re-implemented outside `core/`, route 2) with its own guard.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The sync boot entry points, and only them — the async twins end in `Async` and must not match. */
const SYNC_BOOT_CALLS: readonly { name: string; pattern: RegExp }[] = [
  { name: "openStore", pattern: /(?<!Async)\bopenStore\s*\(/ },
  { name: "migrate", pattern: /(?<!Async)\bmigrate\s*\(/ },
  { name: "seedDomainTaxonomy", pattern: /(?<!Async)\bseedDomainTaxonomy\s*\(/ },
];

/** The async twins — the non-vacuity half: these *are* the boot, and they must be present. */
const ASYNC_BOOT_CALLS = [/\bopenStoreAsync\s*\(/, /\bmigrateAsync\s*\(/, /\bseedDomainTaxonomyAsync\s*\(/];

function shippedSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) shippedSources(path, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Comments are stripped, so a doc line that names a sync entry point is not read as a call site. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the boot runs on the async plane from app source (#186)", () => {
  test("no shipped module calls a synchronous boot entry point", () => {
    const files = shippedSources(SRC);
    // Non-vacuity: the walk found the tree it exists for, or "no offenders" means nothing.
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toContain(join(SRC, "bootstrap.ts"));

    const offenders = files.flatMap((file) => {
      const source = withoutComments(readFileSync(file, "utf8"));
      return SYNC_BOOT_CALLS.filter(({ pattern }) => pattern.test(source)).map(
        ({ name }) => `${file} → ${name}`,
      );
    });
    expect(offenders).toEqual([]);
  });

  test("and the composition root does run the async ones", () => {
    const bootstrap = withoutComments(readFileSync(join(SRC, "bootstrap.ts"), "utf8"));
    for (const pattern of ASYNC_BOOT_CALLS) expect(bootstrap).toMatch(pattern);
  });

  test("the matcher bites, and its near miss stays green", () => {
    // Each pattern against its own call form — a member call keeps the name, and an alias would too.
    const offending: Record<string, string> = {
      openStore: "openStore(conn);",
      migrate: "await core.migrate(conn, MIGRATIONS);",
      seedDomainTaxonomy: "seedDomainTaxonomy(conn, text);",
    };
    // The near miss: the async twin must NOT be matched, or the guard fails on the fix itself — and a
    // guard that cannot tell the two apart is not a guard.
    const nearMiss =
      "await openStoreAsync(plane);\nawait migrateAsync(plane, MIGRATIONS);\nawait seedDomainTaxonomyAsync(plane);";

    for (const { name, pattern } of SYNC_BOOT_CALLS) {
      expect(pattern.test(offending[name]!)).toBe(true);
      expect({ name, matched: pattern.test(nearMiss) }).toEqual({ name, matched: false });
    }
  });
});
