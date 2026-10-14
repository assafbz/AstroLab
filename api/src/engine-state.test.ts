import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MIGRATIONS, migrate, openStore, seedDomainTaxonomy } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { engineState, MIN_IDEAS } from "./engine-state.js";

/**
 * W8 (#33) — the engine state (`docs/API.md` §3.6, §4.10; `docs/FLOW.md` §4.1) against a fresh
 * migrated vault.
 *
 * The ladder is asserted through **overlapping constructed states**, because that is the only way the
 * precedence is a check rather than a reading: a vault that is simultaneously E0 and E4, or E1 and E2,
 * is where a reordered `if` shows up. `FLOW.md` §4.1's E0 is also exercised in both of its arms — the
 * domain floor *and* the idea floor — since the second arm is the one `VaultSummary` deliberately
 * cannot see.
 *
 * The shipped seed is used (`#fintech` and `#health` are two clusters; `#banking` folds into
 * `#fintech`), so seed-file churn cannot silently retarget a test.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

function idea(
  db: DatabaseSync,
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

/** A spark row, `OFFERED` unless the caller asks for a resolution. */
function spark(
  db: DatabaseSync,
  a: string,
  b: string,
  status: "OFFERED" | "RESOLVED-DISMISSED" = "OFFERED",
): void {
  const [x, y] = [a, b].sort();
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES (?, ?, ?, ?, 'a direction', 'a claim', ?, '2026-01-01T00:00:00Z')`,
  ).run(`spark-${x}-${y}`, a, b, `${x}|${y}`, status);
}

/** A `spark_run` row, inserted in call order — the rowid is what C4's monotonic sequence reads. */
function run(
  db: DatabaseSync,
  id: string,
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED",
  error: string | null = null,
): void {
  db.prepare(
    `INSERT INTO spark_run (id, vault_revision, status, started_at, finished_at, error)
     VALUES (?, 1, ?, NULL, NULL, ?)`,
  ).run(id, status, error);
}

/** Two ideas in two distinct clusters: at/above the domain floor, so E0 is out of the way. */
function spread(db: DatabaseSync): void {
  idea(db, "a", ["fintech"]);
  idea(db, "b", ["health"]);
}

describe("E0 Cold — FLOW.md §4.1's two arms", () => {
  test("an empty vault is E0 with nothing to review and nothing in flight", () => {
    expect(engineState(newDb())).toEqual({ state: "E0", unreviewed: 0, run: null });
  });

  test("the domain arm: one resolved cluster is E0 even with two ideas", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["banking"]); // the same cluster as `fintech` — two tags, one domain
    expect(engineState(db)).toMatchObject({ state: "E0" });
  });

  test("the domain arm: a provisional-only vault is E0", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["defi-xyz"]); // unmapped — provisional, never a resolved domain
    expect(engineState(db)).toMatchObject({ state: "E0" });
  });

  test("the idea arm: one idea holding two clusters is E0 — the missing-pair case", () => {
    // `eligible: true` (two resolved clusters) and still E0: a pair needs two ideas **and** two
    // distinct clusters. This is the arm `VaultSummary` cannot see — it carries no idea count (§6) —
    // and the regression guard for it is the reason `engineState` reads `COUNT(*) FROM idea` itself.
    const db = newDb();
    idea(db, "a", ["fintech", "health"]);
    expect(engineState(db)).toMatchObject({ state: "E0", unreviewed: 0, run: null });
  });

  test("E0 dominates E4 — below the floor with a failed run still reads E0", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    run(db, "r1", "FAILED", "provider timeout");
    expect(engineState(db)).toMatchObject({ state: "E0", run: null });
  });

  test("E0 reports the run truthfully — the state field dominates, the fields do not lie", () => {
    // `FLOW.md` §4.1: E0 shows *regardless of AI state*. The run is still in flight and §3.6 says
    // `run` is the in-flight row, so it is reported, not hidden behind the E0 label.
    const db = newDb();
    run(db, "r1", "PENDING");
    expect(engineState(db)).toMatchObject({
      state: "E0",
      run: { id: "r1", status: "PENDING", vault_revision: 1 },
    });
  });

  test("codes the idea floor as a named constant, not a magic 2", () => {
    expect(MIN_IDEAS).toBe(2);
  });
});

describe("E1 Computing — a run in flight (C2/C3)", () => {
  test("a PENDING run is E1 and is reported as the in-flight run", () => {
    const db = newDb();
    spread(db);
    run(db, "r1", "PENDING");
    expect(engineState(db)).toEqual({
      state: "E1",
      unreviewed: 0,
      run: { id: "r1", status: "PENDING", vault_revision: 1 },
    });
  });

  test("a RUNNING run is E1 too — in flight is PENDING or RUNNING", () => {
    const db = newDb();
    spread(db);
    run(db, "r1", "RUNNING");
    expect(engineState(db)).toMatchObject({ state: "E1", run: { id: "r1", status: "RUNNING" } });
  });

  test("E1 above E2 (C3): a run in flight wins the state, the count stays truthful", () => {
    // The coexistence the contract names (§3.6): the client polls on `state = E1` (§4.11) while the
    // deck still renders the offered card — which is only possible if `unreviewed` is not zeroed by
    // the state field.
    const db = newDb();
    spread(db);
    spark(db, "a", "b");
    run(db, "r1", "RUNNING");
    expect(engineState(db)).toEqual({
      state: "E1",
      unreviewed: 1,
      run: { id: "r1", status: "RUNNING", vault_revision: 1 },
    });
  });

  test("the newest in-flight run is the one reported", () => {
    const db = newDb();
    spread(db);
    run(db, "older", "PENDING");
    run(db, "newer", "RUNNING");
    expect(engineState(db)).toMatchObject({ state: "E1", run: { id: "newer", status: "RUNNING" } });
  });

  test("a run failed while an older run is still RUNNING is E1, not E4", () => {
    // C4's E4 needs *no* run in flight: a FAILED row that is merely the newest insertion cannot mask a
    // live run underneath it.
    const db = newDb();
    spread(db);
    run(db, "live", "RUNNING");
    run(db, "failed", "FAILED", "provider timeout");
    expect(engineState(db)).toMatchObject({ state: "E1", run: { id: "live" } });
  });
});

describe("E4 Unavailable and E3 Exhausted — FLOW.md §5.6, §5.3", () => {
  test("the last run FAILED with nothing in flight is E4, and `run` is null", () => {
    const db = newDb();
    spread(db);
    run(db, "r1", "FAILED", "provider timeout");
    expect(engineState(db)).toEqual({ state: "E4", unreviewed: 0, run: null });
  });

  test("E4 > E3 — a failed run does not read as Exhausted", () => {
    const db = newDb();
    spread(db);
    run(db, "r1", "FAILED", "provider timeout");
    // Same vault, no failure: E3. The failure flips the state to E4 (the transient cause, with Retry).
    expect(engineState(db).state).toBe("E4");
    db.prepare("DELETE FROM spark_run").run();
    expect(engineState(db).state).toBe("E3");
  });

  test("a DONE run with the `discarded:` note is informational, never E4 (the recorded carry)", () => {
    // The disposition rides the `error` column as a non-fatal note (`queue.ts`); only a FAILED row is
    // E4's signal. A stale run's note must not surface as "the AI is down".
    const db = newDb();
    spread(db);
    run(db, "r1", "DONE", "discarded: superseded by revision 3");
    expect(engineState(db)).toEqual({ state: "E3", unreviewed: 0, run: null });
  });

  test("a clean DONE run with nothing to review is E3", () => {
    const db = newDb();
    spread(db);
    run(db, "r1", "DONE");
    expect(engineState(db)).toEqual({ state: "E3", unreviewed: 0, run: null });
  });
});

describe("E2 Ready(n) — the deck's count (API.md §3.6)", () => {
  test("a live offer is E2 with the count the deck needs", () => {
    const db = newDb();
    spread(db);
    spark(db, "a", "b");
    expect(engineState(db)).toEqual({ state: "E2", unreviewed: 1, run: null });
  });

  test("a third idea adds a second offer — `unreviewed` counts every live offer", () => {
    const db = newDb();
    spread(db);
    idea(db, "c", ["devtools"]);
    spark(db, "a", "b");
    spark(db, "a", "c");
    expect(engineState(db)).toMatchObject({ state: "E2", unreviewed: 2 });
  });

  test("a resolved spark is not `unreviewed` — it is history, not the deck's queue", () => {
    const db = newDb();
    spread(db);
    spark(db, "a", "b", "RESOLVED-DISMISSED");
    expect(engineState(db)).toEqual({ state: "E3", unreviewed: 0, run: null });
  });
});

describe("the state read cannot reach a provider (ARCH §5, NFR-A1)", () => {
  // The `vault-summary.test.ts` precedent, applied to the module beside it: a *module-specifier* guard,
  // so the provider-free claim is checked rather than documented. `boundary.test.ts` already fails if
  // any vault package imports the boundary; this pins that this module's reach is the three specifiers
  // it needs and nothing more — a transport, an `fs`, or a `../worker/…` escape reddens it by name.
  const MODULE_PATH = fileURLToPath(new URL("./engine-state.ts", import.meta.url));
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

  test("the scan is real — it read this module and found its imports", () => {
    // Non-vacuity: without this, a broken regex turns the assertion below into a silent pass.
    expect(MODULE_PATH.endsWith("/api/src/engine-state.ts")).toBe(true);
    expect(MODULE_TEXT.length).toBeGreaterThan(0);
    expect(specifiers(MODULE_TEXT)).toContain("node:sqlite");
  });

  test("its only specifiers are the SQLite type, the store's `LIVE_STATUS`, and the summary", () => {
    // `node:sqlite` is a **type-only** import (erased at runtime). `@astrolab/store` supplies one value
    // — `LIVE_STATUS`, the live-offer predicate this module's `unreviewed` count shares with the deck
    // read and the delete path (K1 `#35`) — plus types. The sibling summary is guarded to
    // `node:sqlite` alone. An equality, not a denylist: the next specifier must be a deliberate edit
    // with its reason.
    expect(specifiers(MODULE_TEXT)).toEqual([
      "node:sqlite",
      "@astrolab/store",
      "./vault-summary.js",
    ]);
  });
});

describe("the state read moves nothing (NFR-P1's read posture)", () => {
  test("a call changes no revision, no row count, and touches no table", () => {
    const db = newDb();
    spread(db);
    spark(db, "a", "b");
    run(db, "r1", "RUNNING");
    const before = {
      revision: (
        db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as {
          revision: number;
        }
      ).revision,
      changes: (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
      runs: (db.prepare("SELECT COUNT(*) AS n FROM spark_run").get() as { n: number }).n,
    };
    engineState(db);
    expect(
      (db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as { revision: number })
        .revision,
    ).toBe(before.revision);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(
      before.changes,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM spark_run").get() as { n: number }).n).toBe(
      before.runs,
    );
  });
});
