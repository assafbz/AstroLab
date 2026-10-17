import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteConnection } from "../src/store/connection.js";
import { openNodeStore } from "../src/store/connection.node.js";
import { fileURLToPath } from "node:url";

import { MIGRATIONS, migrate, seedDomainTaxonomy } from "../src/store/index.js";
import { describe, expect, test } from "vitest";

import { captureIdea, type CaptureInput } from "../src/vault/capture.js";
import { resolveDecision, type DecisionInput } from "../src/vault/decision.js";
import { exportVault } from "../src/export/export.js";
import { forkIdea } from "../src/vault/fork.js";
import { iterateIdea } from "../src/vault/iterate.js";
import {
  acceptedByMonth,
  acceptedLandingNewDomainByMonth,
  newDomainByMonth,
} from "../src/vault/metrics.js";

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
 * | 3 | §4.6's iterate records it, against the vault *as it stood*, and a recorded `1` is **durable** | the row's `new_domain` after the call | iterate onto a fresh domain → `1`; a text-only re-save of the same domain → `0` (the case a "no other row" rule gets wrong); a recorded `1` survives a later text-only re-save (the case an overwrite gets wrong) |
 * | 4 | §4.13's ACCEPT records **nothing** — the reading there is constant-false | the ACCEPT-born root's `new_domain` | the roots are `NULL`, never `0`: a naive compute-inside-`insertRootIdea` would store `0` and this reddens |
 * | 5 | the producers are **exactly** the three write sites, and each assigns the column | a scan of the three `src` trees (`api`, `worker`, `store`) | a fourth `INSERT`/`UPDATE` of `idea` that never mentions `new_domain` |
 * | 6 | `acceptedByMonth` — §4.13's accepted sparks, by accept month | `decision`, `kind = 'ACCEPT'`, bucket `[from, to)` on `decided_at` | the `DISMISS`/`INSPIRED` rows in the same month are not counted (`kind = 'ACCEPT'`, not "all decisions") |
 * | 7 | `newDomainByMonth` — ideas that widened, by birth month | `idea.new_domain = 1`, bucket on `created_at` | the `0` **and** the `NULL` rows in the same month are absent — the "not recorded" state is not a zero |
 * | 8 | `acceptedLandingNewDomainByMonth` — NFR-Q1's literal sentence | `decision` (ACCEPT) ⋈ `idea` on `result_idea_id` | a root written in a later month than its accept still counts in the **accept's** bucket; a root deleted since its accept is absent (inner join) |
 * | 9 | the reported set is the instrument's, end to end | a real `resolveDecision` ACCEPT | the ACCEPT-born root (flag `NULL`) is counted by 6 and by neither 7 nor 8 |
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

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

/** A ROOT idea with explicit tags — the vault a write is measured against. */
function seedIdea(db: SqliteConnection, id: string, tags: string[]): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, JSON.stringify(tags));
}

/** The instrument's stored value for one row, straight off the table. */
function flagOf(db: SqliteConnection, id: string): number | null {
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

  test("a recorded `1` is durable — a later write of the idea's own domain cannot clear it", () => {
    const db = newDb();
    seedIdea(db, "existing", ["fintech"]);
    // A capture that genuinely widened the vault: no row carried `health`.
    const idea = captureIdea(db, fields(["health"]));
    expect(flagOf(db, idea.id)).toBe(1);

    // The commonest follow-through there is — a plain text edit, same domain. The write does not widen
    // the vault, but the *landing* the row already recorded did. NFR-Q1 reads an event ("landed"), so a
    // recorded `1` is a fact about the idea's history and a later write must not erase it. Without the
    // durable form, this reads `0`: the flag would be recomputed against a vault that now includes the
    // row's own tags, so every widening would be cleared by the next unrelated edit and both month
    // views would drift down with use.
    iterateIdea(db, idea.id, {
      hypothesis: "rewritten",
      problem: "p",
      monetization: "m",
      domain_tags: ["health"],
    });
    expect(flagOf(db, idea.id)).toBe(1);
  });

  test("durability does not resurrect a `0` — the write still decides when nothing was recorded", () => {
    const db = newDb();
    // `existing` carries `health` from the start, so a row iterated onto it never widens: `1` is not
    // sticky for its own sake, only for a `1` the row actually earned.
    seedIdea(db, "existing", ["health"]);
    const idea = captureIdea(db, fields(["health"]));
    expect(flagOf(db, idea.id)).toBe(0);
    iterateIdea(db, idea.id, {
      hypothesis: "rewritten",
      problem: "p",
      monetization: "m",
      domain_tags: ["education"],
    });
    expect(flagOf(db, idea.id)).toBe(1);
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
 * Method is EV7 #49's walk (the same extension union), applied to a different claim: **every module
 * the walk scans — the `core` and `worker` `src` trees — that writes `idea` must assign
 * `new_domain`.** Both halves are asserted — the writer *set* (an addition
 * and a removal both fail) and the assignment — and the matcher's own boundary and the walk's
 * non-vacuity are pinned, so the guard cannot quietly scan nothing or the wrong table.
 *
 * Residual, stated rather than implied: the walk is scoped to those three `src` trees, so a writer
 * outside them is not scanned — `scripts/w9-c5-fixture.ts:96` and `scripts/w9-calibrate.ts:121` insert
 * `idea` rows and assign no instrument, and their rows land `NULL` ("not recorded"), so the metric is
 * unaffected. The matcher keys on the statement (`INSERT INTO idea` / `UPDATE
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
    const packages = ["core/src", "worker/src"];
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
    expect(writers).toEqual([
      "core/src/vault/capture.ts",
      "core/src/vault/fork.ts",
      "core/src/vault/iterate.ts",
    ]);
    // …and each of them assigns the instrument, so a writer added without it goes red here.
    expect(missing).toEqual([]);
  });
});

/**
 * Claims 6–8 — the **reporting** half (`core/src/vault/metrics.ts`). Rows are seeded with explicit stamps, so
 * a bucket is asserted against a month the test names rather than against whatever `isoTimestamp()`
 * happened to return; claim 9 then ties the shape back to the real writer.
 *
 * The bucket convention is read into the fixtures: `[from, to)` over `YYYY-MM` keys, `from` inclusive,
 * `to` exclusive — so the two boundary rows below (the first instant of each month) must straddle it.
 */
describe("the reporting queries — accepted, widened, and the ratio between them (claims 6–8)", () => {
  const stamp = (month: string, day: string, time = "00:00:00"): string =>
    `${month}-${day}T${time}Z`;

  function seedIdeaAt(
    db: SqliteConnection,
    id: string,
    over: { tags?: string[]; createdAt: string; newDomain?: 0 | 1 | null } = {
      createdAt: "2026-01-15T00:00:00Z",
    },
  ): void {
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at,
                         new_domain)
       VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, ?, ?, ?)`,
    ).run(
      id,
      JSON.stringify(over.tags ?? ["fintech"]),
      over.createdAt,
      over.createdAt,
      over.newDomain ?? null,
    );
  }

  /** A spark (the `decision` FK) plus one decision on it. */
  function seedDecisionAt(
    db: SqliteConnection,
    id: string,
    kind: "ACCEPT" | "DISMISS" | "INSPIRED",
    decidedAt: string,
    resultIdeaId: string | null = null,
  ): void {
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES (?, 's-a', 's-b', ?, 'd', 'c', 'OFFERED', 't')`,
    ).run(`spark-${id}`, `s-a|s-b|${id}`);
    db.prepare(
      `INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, `spark-${id}`, kind, resultIdeaId, decidedAt);
  }

  test("`acceptedByMonth` counts ACCEPTs only, and honours the half-open range", () => {
    const db = newDb();
    seedDecisionAt(db, "d1", "ACCEPT", stamp("2026-01", "31", "23:59:59"));
    seedDecisionAt(db, "d2", "ACCEPT", stamp("2026-01", "01"));
    seedDecisionAt(db, "d3", "ACCEPT", stamp("2026-02", "28"));
    seedDecisionAt(db, "d4", "DISMISS", stamp("2026-01", "15"));
    seedDecisionAt(db, "d5", "INSPIRED", stamp("2026-02", "15"));
    // The boundary rows: the first instant of each month belongs to that month alone.
    seedDecisionAt(db, "d6", "ACCEPT", stamp("2026-03", "01"));
    seedDecisionAt(db, "d7", "ACCEPT", stamp("2026-04", "01"));

    expect(acceptedByMonth(db, "2026-01", "2026-03")).toEqual([
      { month: "2026-01", count: 2 }, // `d1`, `d2` — the DISMISS `d4` is not an acceptance
      { month: "2026-02", count: 1 }, // `d3`, not the INSPIRED `d5`
    ]);
    // `to` is exclusive: `2026-03-01T00:00:00Z` is March's, and a month with no rows is absent.
    expect(acceptedByMonth(db, "2026-03", "2026-04")).toEqual([{ month: "2026-03", count: 1 }]);
    expect(acceptedByMonth(db, "2026-04", "2026-05")).toEqual([{ month: "2026-04", count: 1 }]);
    expect(acceptedByMonth(db, "2025-01", "2026-01")).toEqual([]); // nothing before the vault existed
    expect(acceptedByMonth(newDb(), "2026-01", "2026-02")).toEqual([]); // an empty vault
  });

  test("`newDomainByMonth` counts the recorded `1`s, and neither a `0` nor the unrecorded `NULL`", () => {
    const db = newDb();
    seedIdeaAt(db, "widened-jan", { createdAt: stamp("2026-01", "15"), newDomain: 1 });
    seedIdeaAt(db, "plain-jan", { createdAt: stamp("2026-01", "16"), newDomain: 0 });
    seedIdeaAt(db, "unrecorded-jan", { createdAt: stamp("2026-01", "17") }); // §4.13's ACCEPT-born shape
    seedIdeaAt(db, "widened-feb", { createdAt: stamp("2026-02", "15"), newDomain: 1 });

    expect(newDomainByMonth(db, "2026-01", "2026-03")).toEqual([
      { month: "2026-01", count: 1 },
      { month: "2026-02", count: 1 },
    ]);
    // The discriminating half, read out of the table rather than assumed: the month really does hold
    // three ideas, so a `!= 0`- or `IS NOT 1`-shaped predicate would report more than 1 here.
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM idea WHERE substr(created_at, 1, 7) = '2026-01'")
          .get() as { n: number }
      ).n,
    ).toBe(3);
  });

  test("`acceptedLandingNewDomainByMonth` buckets on the accept, and excludes what cannot answer", () => {
    const db = newDb();
    // A root accepted in January but *written* in March: the cohort is the accept, so January is its
    // bucket. (This is the assertion a `GROUP BY i.created_at` implementation fails.)
    seedIdeaAt(db, "landed", { createdAt: stamp("2026-03", "10"), newDomain: 1 });
    seedDecisionAt(db, "a1", "ACCEPT", stamp("2026-01", "20"), "landed");
    // Not recorded (§4.13's own shape) and recorded `0` — neither is a landing.
    seedIdeaAt(db, "unrecorded", { createdAt: stamp("2026-01", "21") });
    seedDecisionAt(db, "a2", "ACCEPT", stamp("2026-01", "21"), "unrecorded");
    seedIdeaAt(db, "stayed", { createdAt: stamp("2026-01", "22"), newDomain: 0 });
    seedDecisionAt(db, "a3", "ACCEPT", stamp("2026-01", "22"), "stayed");
    // A DISMISS has no result idea at all.
    seedDecisionAt(db, "a4", "DISMISS", stamp("2026-01", "23"));
    // A root deleted since its accept: the flag died with the row (inner join, documented).
    seedIdeaAt(db, "gone", { createdAt: stamp("2026-01", "24"), newDomain: 1 });
    seedDecisionAt(db, "a5", "ACCEPT", stamp("2026-01", "24"), "gone");
    db.exec("DELETE FROM idea WHERE id = 'gone'");

    expect(acceptedLandingNewDomainByMonth(db, "2026-01", "2026-02")).toEqual([
      { month: "2026-01", count: 1 },
    ]);
    // …and the denominator is unaffected by any of it: five ACCEPTs, one landing.
    expect(acceptedByMonth(db, "2026-01", "2026-02")).toEqual([{ month: "2026-01", count: 4 }]);
    // The other numerator: January's ideas that widened are none — `landed` is the March row — while
    // the *same* root is in January's trickle-down count above. That gap is the two cohorts, stated.
    expect(newDomainByMonth(db, "2026-01", "2026-02")).toEqual([]);
    expect(newDomainByMonth(db, "2026-03", "2026-04")).toEqual([{ month: "2026-03", count: 1 }]);
    expect(acceptedLandingNewDomainByMonth(db, "2026-03", "2026-04")).toEqual([]);
  });

  test("a bound that is an instant, not a month, fails loudly instead of reporting zero", () => {
    const db = newDb();
    expect(() => acceptedByMonth(db, "2026-10-16T00:00:00Z", "2026-11")).toThrow(/YYYY-MM/);
    expect(() => acceptedByMonth(db, "2026-1", "2026-11")).toThrow(/YYYY-MM/);
    expect(() => newDomainByMonth(db, "2026-01", "2026-13")).toThrow(/YYYY-MM/);
    expect(() => acceptedLandingNewDomainByMonth(db, "", "2026-13")).toThrow(/YYYY-MM/);
    // Reversed but well-formed bounds are a legitimate empty range, not an error.
    expect(newDomainByMonth(db, "2026-05", "2026-02")).toEqual([]);
  });

  test("claim 9 — the real ACCEPT is counted by the denominator and by neither numerator", () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, first_step,
                          status, created_at)
       VALUES ('s1', 'a', 'b', 'a|b', 'd', 'c', 'f', 'OFFERED', 't')`,
    ).run();
    const decision = resolveDecision(db, "s1", { decision_id: "d1", kind: "ACCEPT" });
    const thisMonth = decision.decided_at.slice(0, 7);
    const year = Number(thisMonth.slice(0, 4));

    expect(acceptedByMonth(db, `${year}-01`, `${year + 1}-01`)).toEqual([
      { month: thisMonth, count: 1 },
    ]);
    // The root's tags are the pair's union, so the instrument never claimed a widening here — and the
    // report says so by reporting nothing, rather than by reporting a `0`.
    expect(newDomainByMonth(db, `${year}-01`, `${year + 1}-01`)).toEqual([]);
    expect(acceptedLandingNewDomainByMonth(db, `${year}-01`, `${year + 1}-01`)).toEqual([]);
  });
});
