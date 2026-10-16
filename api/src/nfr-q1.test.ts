import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MIGRATIONS, migrate, openStore, seedDomainTaxonomy } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { captureIdea, type CaptureInput } from "./capture.js";
import { resolveDecision, type DecisionInput } from "./decision.js";
import { exportVault } from "./export.js";
import { forkIdea } from "./fork.js";
import { iterateIdea } from "./iterate.js";

/**
 * EV1 (#43) — **NFR-Q1, the new-domain instrument** (`docs/PRD.md` §5 / NFR-Q1: *"accepted sparks, and
 * how many landed in a new domain"*).
 *
 * The instrument is `idea.new_domain` (`0006`, `SCHEMA.md` §1e) and the rule that computes it is
 * `newDomainFlag` (`store/src/domain-map.ts`, unit-proved in `store/test/domain-map.test.ts`). What this
 * file proves is the half a unit test cannot: **which writes record it, and against which vault.**
 *
 * | # | claim | read from | the fixture that fails it |
 * | :-- | :-- | :-- | :-- |
 * | 1 | §4.2's capture records it at the write | the stored `new_domain` of the returned idea | capture a tag the vault already carries → `0`; capture `payments` where the vault holds `fintech` → `0` (cluster-relative, not tag-relative) |
 * | 2 | §4.7's fork records it **vault**-relative, not parent-relative | the fork row's `new_domain` | fork into a domain covered by a *third* idea → `0`, though the parent does not carry it (T25's `409` only compares the fork to its parent) |
 * | 3 | §4.6's iterate re-records it, against the vault *as it stood* | the row's `new_domain` after the call | iterate onto a fresh domain → `1`; a text-only re-save of the same domain → `0` (the case a "no other row" rule gets wrong) |
 * | 4 | §4.13's ACCEPT records **nothing** — the reading there is constant-false | the ACCEPT-born root's `new_domain` | the roots are `NULL`, never `0`: a naive compute-inside-`insertRootIdea` would store `0` and this reddens |
 * | 5 | the producers are **exactly** the three write sites, and each assigns the column | a scan of the shipped sources | a fourth `INSERT`/`UPDATE` of `idea` that never mentions `new_domain` |
 *
 * **0 provider calls** — every path here is `api`-local; nothing reaches a provider (`worker/src/
 * provider/boundary.test.ts`).
 *
 * ## Claim 4 is an absence, so it needs its reason stated
 *
 * At §4.13 an ACCEPT mints a ROOT whose `domain_tags` are `spark.domain_tags` — the **derived union** of
 * the two source ideas' stored tags (`store/src/sparks.ts`), both of which are pre-existing `idea` rows
 * the gate admitted (`worker/src/engine/gate.ts`). So the root's domains are a subset of the vault's
 * *already*, by construction: the flag can only ever read `0`, and a stored `0` would be a measurement
 * where there is none to make (`NULL` = "not recorded" is the honest value). The plan's original
 * "ACCEPT on an empty vault (new)" fixture is unreachable for the same reason — a live offer needs a
 * pair, and that pair is exactly where the tags come from. The constant is the *reason* the instrument
 * belongs on the writes that can widen, which is what claims 1–3 prove.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

/** A ROOT idea with explicit tags — the vault a write is measured against. */
function seedIdea(db: DatabaseSync, id: string, tags: string[]): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, JSON.stringify(tags));
}

/** The instrument's stored value for one row, straight off the table. */
function flagOf(db: DatabaseSync, id: string): number | null {
  const row = db.prepare("SELECT new_domain FROM idea WHERE id = ?").get(id) as {
    new_domain: number | null;
  };
  return row.new_domain;
}

const fields = (tags: string[]): CaptureInput => ({
  hypothesis: "h",
  problem: "p",
  monetization: "m",
  domain_tags: tags,
  origin_spark_id: null,
  decision_id: null,
});

describe("§4.2 capture records the instrument (claim 1)", () => {
  test("a tag the vault does not carry is a widening", () => {
    const db = newDb();
    seedIdea(db, "existing", ["fintech"]);
    const idea = captureIdea(db, fields(["health"]));
    expect(flagOf(db, idea.id)).toBe(1);
  });

  test("a tag an existing idea carries is not — and the same cluster is not either", () => {
    const db = newDb();
    seedIdea(db, "existing", ["fintech"]);
    expect(flagOf(db, captureIdea(db, fields(["fintech"])).id)).toBe(0);
    // `payments` is a *different tag* in the **same** cluster: the vault's vocabulary (`docs/API.md:119
    // — "#fintech + #banking are one domain") says the vault gained nothing.
    expect(flagOf(db, captureIdea(db, fields(["payments"])).id)).toBe(0);
  });

  test("the seeded capture records it on the same rule (its fields are the request's)", () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, first_step,
                          status, created_at)
       VALUES ('s1', 'a', 'b', 'a|b', 'd', 'c', 'f', 'OFFERED', 't')`,
    ).run();
    const idea = captureIdea(db, {
      ...fields(["education"]),
      origin_spark_id: "s1",
      decision_id: "d1",
    });
    expect(flagOf(db, idea.id)).toBe(1);
  });
});

describe("§4.7 fork records it vault-relative, not parent-relative (claim 2)", () => {
  test("a fork into a domain a third idea covers is not a widening", () => {
    const db = newDb();
    seedIdea(db, "parent", ["fintech"]);
    seedIdea(db, "other", ["health"]);
    // §4.7 only compares the fork to its **parent** (T25): `["health"]` differs from `["fintech"]`, so
    // the fork is legal — and the vault still gains nothing, because `other` already covers `health`.
    const fork = forkIdea(db, "parent", { mutation_delta: "pivot", domain_tags: ["health"] });
    expect(flagOf(db, fork.id)).toBe(0);
  });

  test("a fork into a genuinely fresh domain is a widening", () => {
    const db = newDb();
    seedIdea(db, "parent", ["fintech"]);
    const fork = forkIdea(db, "parent", { mutation_delta: "pivot", domain_tags: ["education"] });
    expect(flagOf(db, fork.id)).toBe(1);
  });
});

describe("§4.6 iterate re-records it against the vault as it stood (claim 3)", () => {
  test("iterating onto a fresh domain flips the root to 1 — the follow-through the metric reads", () => {
    const db = newDb();
    seedIdea(db, "source-a", ["fintech"]);
    seedIdea(db, "source-b", ["health", "fintech"]);
    // A root as §4.13 mints it (`NEEDS_COMPLETION`, tags = the pair's union), then completed onto a
    // domain the vault did not carry — T27's completion path.
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES ('root', 'h', 'p', '', ?, 'ROOT', NULL, 'NEEDS_COMPLETION', 'PRIVATE', 1, 't', 't')`,
    ).run(JSON.stringify(["fintech", "health"]));
    expect(flagOf(db, "root")).toBeNull(); // born by ACCEPT ⇒ unrecorded

    iterateIdea(db, "root", {
      hypothesis: "h",
      problem: "p",
      monetization: "m",
      domain_tags: ["education"],
    });
    expect(flagOf(db, "root")).toBe(1);
  });

  test("a text-only re-save of the idea's own domain is not a widening", () => {
    const db = newDb();
    // `sole` is the *only* carrier of its domain: the case that separates the shipped rule from a
    // "no OTHER row carries it" one, which would report this re-save as `1`.
    seedIdea(db, "sole", ["fintech"]);
    iterateIdea(db, "sole", {
      hypothesis: "rewritten",
      problem: "p",
      monetization: "m",
      domain_tags: ["fintech"],
    });
    expect(flagOf(db, "sole")).toBe(0);
  });
});

describe("§4.13 ACCEPT records nothing (claim 4)", () => {
  test("the ACCEPT-born root is NULL, not 0 — the reading there is constant-false", () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, first_step,
                          status, created_at)
       VALUES ('s1', 'a', 'b', 'a|b', 'd', 'c', 'f', 'OFFERED', 't')`,
    ).run();

    const accept: DecisionInput = { decision_id: "d1", kind: "ACCEPT" };
    const decision = resolveDecision(db, "s1", accept);
    expect(decision.result_idea_id).not.toBeNull();
    // The root's tags are the pair's union, so a flag computed here could only be `0`. `NULL` says
    // "not recorded"; `0` would claim a measurement was taken.
    expect(flagOf(db, decision.result_idea_id as string)).toBeNull();
  });

  test("the export carries the state as it is — the unrecorded value included (docs/API.md §4.17)", () => {
    const db = newDb();
    seedIdea(db, "pre-existing", ["fintech"]); // predates the column ⇒ NULL
    const captured = captureIdea(db, fields(["education"]));
    const byId = Object.fromEntries(exportVault(db).ideas.map((row) => [row.id, row.new_domain]));
    expect(byId["pre-existing"]).toBeNull();
    expect(byId[captured.id]).toBe(1);
  });
});

/**
 * Claim 5's structural half — the behavioural tests above prove the three call sites *today*, but
 * nothing in them fails if a fourth writer appears tomorrow and silently drops the instrument.
 *
 * Method is `api/src/nfr-u1.test.ts`'s (the same walk, the same extension union), applied to a
 * different claim: **every shipped module that writes `idea` must assign `new_domain`.** Both halves are
 * asserted — the writer *set* (an addition and a removal both fail) and the assignment — and the
 * matcher's own boundary and the walk's non-vacuity are pinned, so the guard cannot quietly scan
 * nothing or the wrong table.
 *
 * Residual, stated rather than implied: the matcher keys on the statement (`INSERT INTO idea` / `UPDATE
 * idea SET`), so a writer that reached the row some other way — a `REPLACE INTO`, an `INSERT` with the
 * table name quoted and spelled differently — would be missed, exactly as #123 found for the sibling
 * canary. `new_domain`'s own spelling is the second half of the check, and it is a text match: a writer
 * that assigned the column through a helper in another file would pass this and still be correct.
 */
describe("the producers are exactly the three write sites (claim 5)", () => {
  // `INSERT OR REPLACE`/`OR IGNORE` and a quoted identifier write the **same** table; the lookahead
  // separates `idea` from `idea_version` / `idea_new` even when a closing quote intervenes.
  const WRITES_IDEA =
    /(INSERT\s+(?:OR\s+\w+\s+)?INTO\s+"?idea"?(?![\w]))|(UPDATE\s+"?idea"?\s+SET\b)/i;

  test("the matcher separates the tables, the dialects and the statements", () => {
    expect(WRITES_IDEA.test("INSERT INTO idea (id) VALUES (1)")).toBe(true);
    expect(WRITES_IDEA.test("insert into idea (id) values (1)")).toBe(true);
    expect(WRITES_IDEA.test('INSERT INTO "idea" (id) VALUES (1)')).toBe(true);
    expect(WRITES_IDEA.test("INSERT OR REPLACE INTO idea (id) VALUES (1)")).toBe(true);
    expect(WRITES_IDEA.test("UPDATE idea SET hypothesis = ? WHERE id = ?")).toBe(true);
    expect(WRITES_IDEA.test("INSERT INTO idea_version (idea_id) VALUES (1)")).toBe(false);
    expect(WRITES_IDEA.test("INSERT INTO idea_new (id) VALUES (1)")).toBe(false);
    expect(WRITES_IDEA.test('INSERT INTO "idea_version" (idea_id) VALUES (1)')).toBe(false);
    expect(WRITES_IDEA.test("DELETE FROM idea WHERE id = ?")).toBe(false);
  });

  test("every writer of `idea` assigns `new_domain`, and there are exactly three", () => {
    // The shipped-source extension union, mirroring `worker/src/provider/boundary.test.ts`.
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
    const isShipped = (name: string): boolean =>
      extensions.some((ext) => name.endsWith(ext)) && !/\.test\.[cm]?[jt]sx?$/.test(name);
    const walk = (dir: string): string[] => {
      const found: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          for (const nested of walk(join(dir, entry.name))) found.push(join(entry.name, nested));
        } else if (isShipped(entry.name)) found.push(entry.name);
      }
      return found.sort();
    };

    const root = fileURLToPath(new URL("../../", import.meta.url));
    const packages = ["api/src", "worker/src", "store/src"];
    const visited: string[] = [];
    const writers: string[] = [];
    const missing: string[] = [];
    for (const pkg of packages) {
      for (const file of walk(join(root, pkg))) {
        const rel = `${pkg}/${file}`;
        visited.push(rel);
        const source = readFileSync(join(root, pkg, file), "utf8");
        if (!WRITES_IDEA.test(source)) continue;
        writers.push(rel);
        if (!source.includes("new_domain")) missing.push(rel);
      }
    }

    // Non-vacuity: the walk reached the packages' real files…
    expect(visited.length).toBeGreaterThan(20);
    // …the writer set is exactly the three write sites (capture + fork insert, iterate updates)…
    expect(writers).toEqual(["api/src/capture.ts", "api/src/fork.ts", "api/src/iterate.ts"]);
    // …and each of them assigns the instrument, so a writer added without it goes red here.
    expect(missing).toEqual([]);
  });
});
