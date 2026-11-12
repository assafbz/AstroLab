import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

/**
 * The boot-plane guard: **`app/` runs `core`'s boot entry, and names no boot step of its own.**
 *
 * Two defects live in this one property, and both are structural rather than typos:
 *
 * 1. **The sync channel (#186).** `openStore` · `migrate` · `seedDomainTaxonomy` are the boot's writes —
 *    the WAL conversion, DDL, `COMMIT`/`ROLLBACK`, `PRAGMA user_version`, the seed's upserts — and on web
 *    each fsyncs past `expo-sqlite`'s ~133 ms main-thread busy-wait budget, so a *sync* call loses the
 *    race on a cold worker (measured: 18 red loads in 19).
 * 2. **An inlined subset of the boot (#190).** The composition root used to run the first two steps by
 *    hand, which silently skipped `seedGateConfig` and `requeueOrphanedRuns` — the gate thresholds were
 *    never seeded and a `RUNNING` row left by a killed process was never requeued (ADR-0004's resume
 *    path). A step run "by hand" is a step that can be forgotten, so the rule is not *"call the right
 *    steps"* but *"call the entry"*.
 *
 * Nothing in the type system stops a future module from reaching for a step again — each is a fine API,
 * just not on this path — so this walks the shipped source instead.
 *
 * **The anchor is the IDENTIFIER, not the call form.** That is a correction, not a style choice: the
 * first version of this guard matched `migrate\s*\(`, so a renamed import
 * (`import { migrate as runMigrations }`) carried the name only in the *import* and the call site the
 * pattern was built for never appeared — the #171 shape, found in review on #196 (Ari, 2026-11-12). The
 * identifier is what **every** import form carries, so that spelling is covered here the way
 * `no-cold-sync-open.test.ts` already covers it: named · aliased · namespace (`ns.migrate(...)`). Both
 * `bites` arms below are that case.
 *
 * **Scope, stated so the negative is not read wider than it is.** The walk covers `app/src/**` (shipped
 * modules only; `*.test.ts` are skipped, since a test may drive either plane). Two limits are accepted
 * rather than papered over: a name assembled at runtime (`ns["mig" + "rate"]`) is not reachable by a text
 * walk, and this does not inspect **raw SQL** — a hand-written `INSERT` in `app/` would be a different
 * defect (a rule re-implemented outside `core/`) with its own guard.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The **sync** boot steps. Each entry is the identifier; the `…Async` twin is a *different* word
 * (`\bmigrate\b` finds no boundary before the `A` of `migrateAsync`), so these bilaterally do not match
 * the async spellings — which is what makes the near-miss arms below meaningful.
 */
const SYNC_BOOT_STEPS: readonly { name: string; pattern: RegExp }[] = [
  { name: "bootVault", pattern: /\bbootVault\b/ },
  { name: "openStore", pattern: /\bopenStore\b/ },
  { name: "migrate", pattern: /\bmigrate\b/ },
  { name: "seedDomainTaxonomy", pattern: /\bseedDomainTaxonomy\b/ },
  { name: "seedGateConfig", pattern: /\bseedGateConfig\b/ },
  { name: "requeueOrphanedRuns", pattern: /\brequeueOrphanedRuns\b/ },
];

/**
 * The steps `core`'s entry now runs, in either spelling. `openStoreAsync` is deliberately **not** here:
 * applying the pragmas is the *opener's* half on both channels (`openNodeStore` is `openNodeConnection` +
 * `openStore` for the same reason), and `bootVaultAsync`'s contract is its sync twin's — a caller supplies
 * an open, pragma-applied connection.
 */
const INNER_BOOT_STEP =
  /\b(?:migrate|seedDomainTaxonomy|seedGateConfig|requeueOrphanedRuns)(?:Async)?\b/;

/** What the composition root must call instead: the pragmas, then `core`'s one async boot entry. */
const REQUIRED_IN_ROOT = [/\bopenStoreAsync\b/, /\bbootVaultAsync\b/];

function shippedSources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) shippedSources(path, found);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Comments are stripped, so a doc line that names a step is not read as a call site. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every shipped module's source of record, read once. */
function shippedSourcesWithText(): { file: string; source: string }[] {
  const files = shippedSources(SRC);
  // Non-vacuity: the walk found the tree it exists for, or "no offenders" means nothing.
  expect(files.length).toBeGreaterThanOrEqual(5);
  expect(files).toContain(join(SRC, "bootstrap.ts"));
  return files.map((file) => ({ file, source: withoutComments(readFileSync(file, "utf8")) }));
}

describe("the boot runs on the async plane from app source (#186, #190)", () => {
  test("no shipped module names a synchronous boot step", () => {
    const offenders = shippedSourcesWithText().flatMap(({ file, source }) =>
      SYNC_BOOT_STEPS.filter(({ pattern }) => pattern.test(source)).map(
        ({ name }) => `${file} → ${name}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  test("the composition root calls core's boot entry — and no shipped module names an inner step", () => {
    const sources = shippedSourcesWithText();
    const bootstrap = sources.find(({ file }) => file === join(SRC, "bootstrap.ts"))!;
    for (const pattern of REQUIRED_IN_ROOT) expect(bootstrap.source).toMatch(pattern);

    const offenders = sources
      .filter(({ source }) => INNER_BOOT_STEP.test(source))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test("the matcher bites — including the renamed import — and its near miss stays green", () => {
    // The near miss first: the async twins must NOT be matched, or the guard fails on the fix itself,
    // and a guard that cannot tell the two apart is not a guard.
    const nearMiss = ["await openStoreAsync(plane);", "await bootVaultAsync(plane);"].join("\n");
    for (const { name, pattern } of SYNC_BOOT_STEPS) {
      expect({ name, matched: pattern.test(nearMiss) }).toEqual({ name, matched: false });
    }

    // Each pattern against its own call form — a member call keeps the name, and so does an alias.
    const offending: Record<string, string> = {
      bootVault: "bootVault(conn);",
      openStore: "openStore(conn);",
      migrate: "await core.migrate(conn, MIGRATIONS);",
      seedDomainTaxonomy: "seedDomainTaxonomy(conn, text);",
      seedGateConfig: "seedGateConfig(conn);",
      requeueOrphanedRuns: "requeueOrphanedRuns(conn);",
    };
    for (const { name, pattern } of SYNC_BOOT_STEPS) {
      expect({ name, matched: pattern.test(offending[name]!) }).toEqual({ name, matched: true });
    }
  });

  test("the renamed-import evasion that this anchor was corrected for stays caught (#196 review)", () => {
    // The exact shape the call-form anchor could not see: the identifier appears in the import only.
    const renamed =
      'import { migrate as runMigrations } from "@astrolab/core";\nrunMigrations(conn);';
    expect(SYNC_BOOT_STEPS.find(({ name }) => name === "migrate")!.pattern.test(renamed)).toBe(
      true,
    );
    expect(INNER_BOOT_STEP.test(renamed)).toBe(true);
    // And a namespace member call, the other spelling the identifier has to cover.
    expect(
      SYNC_BOOT_STEPS.find(({ name }) => name === "migrate")!.pattern.test("ns.migrate(x);"),
    ).toBe(true);
  });
});
