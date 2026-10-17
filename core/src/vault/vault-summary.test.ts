import { readFileSync } from "node:fs";
import type { SqliteConnection } from "../store/connection.js";
import { openNodeStore } from "../store/connection.node.js";
import { fileURLToPath } from "node:url";

import { MIGRATIONS, migrate, seedDomainTaxonomy } from "../store/index.js";
import { describe, expect, test } from "vitest";

import { FLOOR, TARGET, vaultSummary } from "./vault-summary.js";

/**
 * O2 (#22) — the vault summary (`docs/API.md` §3.2/§4.3, `docs/ARCHITECTURE.md` §3.2) against a fresh
 * migrated vault.
 *
 * Three properties that a happy-path check cannot make true, so they are asserted rather than intended:
 * the two counts are **one snapshot** (one statement — see the module), the count is **monotone
 * non-decreasing** under the worker's normalisation, and the summary **reaches no provider and writes
 * nothing**.
 *
 * The shipped seed is used where the claim is about the shipped taxonomy (`fintech` + `banking` both
 * being tags of one cluster); explicit `domain_map` rows are used where it is not, so seed-file churn
 * cannot silently retarget a test.
 */

function newDb(options: { seedTaxonomy?: boolean } = {}): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  if (options.seedTaxonomy ?? true) seedDomainTaxonomy(db);
  return db;
}

function idea(
  db: SqliteConnection,
  id: string,
  tags: string[],
  status: "ACTIVE" | "NEEDS_COMPLETION" = "ACTIVE",
): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, ?, 'PRIVATE', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(id, JSON.stringify(tags), status);
}

/** The worker's write-back: one tag collapsed into a cluster (`ARCHITECTURE.md` §3.2 step 2). */
function normalise(db: SqliteConnection, tag: string, clusterId: string): void {
  db.prepare("INSERT INTO domain_map (tag, cluster_id) VALUES (?, ?)").run(tag, clusterId);
}

const revision = (db: SqliteConnection): number =>
  (db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as { revision: number })
    .revision;

describe("vaultSummary — docs/API.md §3.2", () => {
  test("an empty vault is 0/0, not an error", () => {
    expect(vaultSummary(newDb())).toEqual({
      resolved_domains: 0,
      provisional_domains: 0,
      target: 3,
      floor: 2,
      eligible: false,
    });
  });

  test("the floor and target are constants, never derived from the vault", () => {
    const db = newDb();
    expect(vaultSummary(db)).toMatchObject({ floor: FLOOR, target: TARGET });
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["health"]);
    idea(db, "c", ["devtools"]);
    expect(vaultSummary(db)).toMatchObject({ floor: FLOOR, target: TARGET, eligible: true });
  });

  test("one mapped tag is one resolved domain — and not yet eligible", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    expect(vaultSummary(db)).toMatchObject({
      resolved_domains: 1,
      provisional_domains: 0,
      eligible: false,
    });
  });

  test("two clusters clear the floor", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["health"]);
    expect(vaultSummary(db)).toMatchObject({
      resolved_domains: 2,
      provisional_domains: 0,
      eligible: true,
    });
  });

  test("#fintech + #banking collapse to one domain — the gate stays shut (R1)", () => {
    // `banking` is a tag of the `fintech` cluster in the shipped file, so two *typed* tags resolve to
    // one cluster. Counting tags instead of clusters would read this as 2 domains and open the gate.
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["banking"]);
    expect(vaultSummary(db)).toMatchObject({
      resolved_domains: 1,
      provisional_domains: 0,
      eligible: false,
    });
  });

  test("a tag used by many ideas counts once", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["fintech"]);
    idea(db, "c", ["fintech", "fintech"]);
    expect(vaultSummary(db)).toMatchObject({ resolved_domains: 1, provisional_domains: 0 });
  });

  test("an unmapped tag is provisional, counted by distinct tag, and never opens the gate", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["defi-xyz"]);
    expect(vaultSummary(db)).toMatchObject({
      resolved_domains: 1,
      provisional_domains: 1,
      eligible: false,
    });
    // The same unmapped tag in a second idea is one provisional cluster, not two.
    idea(db, "c", ["defi-xyz"]);
    expect(vaultSummary(db)).toMatchObject({ provisional_domains: 1, eligible: false });
  });

  test("two provisional tags are two clusters, and neither is a resolved domain", () => {
    const db = newDb();
    idea(db, "a", ["defi-xyz"]);
    idea(db, "b", ["orbital-logistics"]);
    idea(db, "c", ["health"]);
    expect(vaultSummary(db)).toMatchObject({
      resolved_domains: 1,
      provisional_domains: 2,
      eligible: false,
    });
  });

  test("the match is exact — a raw-cased tag is provisional, not resolved", () => {
    // Capture stores the tag raw (`ARCHITECTURE.md` §3.2); the shipped keys are lower-case slugs, so
    // `Fintech` resolves only once the worker writes that exact spelling back. Normalising here would
    // invent a second vocabulary — and would let the count move for a reason the contract does not name.
    const db = newDb();
    idea(db, "a", ["Fintech"]);
    expect(vaultSummary(db)).toMatchObject({ resolved_domains: 0, provisional_domains: 1 });
    normalise(db, "Fintech", "fintech");
    expect(vaultSummary(db)).toMatchObject({ resolved_domains: 1, provisional_domains: 0 });
  });

  test("resolved is monotone non-decreasing under normalisation", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["defi-xyz"]);
    const before = vaultSummary(db);
    expect(before).toMatchObject({ resolved_domains: 1, provisional_domains: 1 });

    normalise(db, "defi-xyz", "fintech"); // the collapse: a provisional tag joins an existing cluster
    const after = vaultSummary(db);
    expect(after.resolved_domains).toBeGreaterThanOrEqual(before.resolved_domains);
    expect(after.provisional_domains).toBeLessThanOrEqual(before.provisional_domains);
    expect(after).toMatchObject({ resolved_domains: 1, provisional_domains: 0 });

    // And a normalisation that lands in a *new* cluster only ever adds.
    idea(db, "c", ["orbital-logistics"]);
    normalise(db, "orbital-logistics", "space-defense");
    expect(vaultSummary(db).resolved_domains).toBe(2);
    expect(vaultSummary(db).resolved_domains).toBeGreaterThanOrEqual(after.resolved_domains);
  });

  test("one idea carrying two clusters counts both — and is why E0 is the engine's (O2 #22 ruling)", () => {
    // This is the corner David ruled on: `eligible` is the S0→S1 *spread gate* (`resolved >= 2`), so a
    // single idea holding two clusters is eligible. E0's "(or < 2 ideas)" clause is the engine's state
    // (`FLOW.md` §4.1), computed once for `GET /v1/sparks/state` — never derived from this summary,
    // which is why `VaultSummary` deliberately carries no idea count. Carried to #24 (O4).
    const db = newDb();
    idea(db, "a", ["fintech", "health"]);
    expect(vaultSummary(db)).toMatchObject({
      resolved_domains: 2,
      provisional_domains: 0,
      eligible: true,
    });
  });

  test("every idea row contributes — a status filter would break the monotone rule", () => {
    const db = newDb();
    idea(db, "a", ["health"], "NEEDS_COMPLETION");
    expect(vaultSummary(db)).toMatchObject({ resolved_domains: 1, provisional_domains: 0 });
  });

  test("an unseeded vault is all-provisional — the failure mode the boot order prevents", () => {
    // `worker/src/boot.ts` seeds before its first run for exactly this reason: with an empty
    // `domain_map` every domain reads provisional, so nothing would be eligible and the gate would
    // never open. The summary reports that truthfully rather than guessing a cluster.
    const db = newDb({ seedTaxonomy: false });
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["health"]);
    expect(vaultSummary(db)).toEqual({
      resolved_domains: 0,
      provisional_domains: 2,
      target: 3,
      floor: 2,
      eligible: false,
    });
  });

  test("both counts come from one statement — one snapshot, not two reads", () => {
    // The property, asserted rather than asserted-in-prose: two statements could straddle a commit
    // under WAL and answer `resolved` from one vault state and `provisional` from another. Counting
    // `prepare` calls is what makes "one snapshot by construction" a check — a second statement
    // reddens this, and the fix is a transaction wrapper (the V2 precedent), not a looser test.
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["defi-xyz"]);
    let prepares = 0;
    const counting = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        if (property === "prepare") {
          return (...args: unknown[]) => {
            prepares += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    expect(vaultSummary(counting as SqliteConnection)).toMatchObject({
      resolved_domains: 1,
      provisional_domains: 1,
    });
    expect(prepares).toBe(1);
  });
});

describe("the summary is a read, and cannot reach a provider (ARCH §3.2, NFR-A1)", () => {
  test("a call moves neither the vault revision nor the change counter", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["defi-xyz"]);
    const before = {
      revision: revision(db),
      changes: (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
    };
    vaultSummary(db);
    expect(revision(db)).toBe(before.revision);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(
      before.changes,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM spark_run").get() as { n: number }).n).toBe(0);
  });

  const MODULE_PATH = fileURLToPath(new URL("./vault-summary.ts", import.meta.url));
  const MODULE_TEXT = readFileSync(MODULE_PATH, "utf8");

  /** Every module specifier in a file — the same extractor the worker's boundary guard uses. */
  function specifiers(text: string): string[] {
    return [...text.matchAll(/(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map(
      (match) => match[1] ?? "",
    );
  }

  test("the extractor sees every import form — a side-effect import has no `from`", () => {
    const text = [
      'import "@astrolab/worker";',
      'import { a } from "./a.js";',
      'import type { B } from "@astrolab/worker";',
      'export * from "../worker/src/provider/index.js";',
      'const c = await import("./c.js");',
    ].join("\n");

    expect(specifiers(text)).toEqual([
      "@astrolab/worker",
      "./a.js",
      "@astrolab/worker",
      "../worker/src/provider/index.js",
      "./c.js",
    ]);
  });

  test("the scan is real — it read this module and found its one import", () => {
    // Non-vacuity: without this, a broken regex turns the assertion below into a silent pass.
    expect(MODULE_PATH.endsWith("/core/src/vault/vault-summary.ts")).toBe(true);
    expect(MODULE_TEXT.length).toBeGreaterThan(0);
    expect(specifiers(MODULE_TEXT)).toContain("../store/connection.js");
  });

  test("the module's only specifier is the port type — no transport, no provider, no fs", () => {
    // The port type is the sole import (a type-only one). Anything else — a bare package, a `../`
    // escape, a second builtin that reaches state — must arrive as a *named* exception with its
    // reason, which is why this is an equality rather than a denylist.
    expect(specifiers(MODULE_TEXT)).toEqual(["../store/connection.js"]);
  });
});
