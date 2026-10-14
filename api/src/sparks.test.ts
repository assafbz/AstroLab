import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { ValidationError } from "./capture.js";
import { listOfferedSparks, parseSparkQuery } from "./sparks.js";

/**
 * K1 (#35) — the deck read (`docs/API.md` §4.9, §3.3) against a fresh migrated vault.
 *
 * The store's own tests cover the SQL (`store/test/sparks.test.ts`); this file is the **contract's**
 * layer: `state`'s vocabulary (change A — required, `offered` only, case-sensitive) and the body the
 * route ships, including the one row that must never appear — a resolved spark.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

/** An idea with explicit tags — the deck's derived `domain_tags` is read from these. */
function idea(db: DatabaseSync, id: string, tags: string[]): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, JSON.stringify(tags));
}

/** A `spark` row, `OFFERED` unless the caller asks for a resolution. */
function spark(
  db: DatabaseSync,
  id: string,
  a: string,
  b: string,
  status = "OFFERED",
  direction = "a direction",
): void {
  const [x, y] = [a, b].sort();
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'a claim', ?, 't')`,
  ).run(id, a, b, `${x}|${y}`, direction, status);
}

describe("parseSparkQuery — `state` is mandatory and enum-exact (§4.9, §1)", () => {
  test("`offered` is the one value that validates", () => {
    expect(parseSparkQuery(new URLSearchParams("state=offered"))).toEqual({ state: "offered" });
  });

  test("a missing or empty `state` is a ValidationError — never an unfiltered read (change A)", () => {
    expect(() => parseSparkQuery(new URLSearchParams(""))).toThrow(ValidationError);
    expect(() => parseSparkQuery(new URLSearchParams("state="))).toThrow(ValidationError);
  });

  test("an out-of-enum `state` is a ValidationError, and the comparison is case-sensitive", () => {
    expect(() => parseSparkQuery(new URLSearchParams("state=OFFERED"))).toThrow(ValidationError);
    expect(() => parseSparkQuery(new URLSearchParams("state=all"))).toThrow(ValidationError);
  });

  test("a repeated key takes its first occurrence — §1's rule, so `all` first is still a 422", () => {
    expect(() => parseSparkQuery(new URLSearchParams("state=all&state=offered"))).toThrow(
      ValidationError,
    );
  });

  test("an unknown parameter is ignored (§1)", () => {
    expect(parseSparkQuery(new URLSearchParams("state=offered&domain=fintech"))).toEqual({
      state: "offered",
    });
  });
});

describe("listOfferedSparks — §4.9's body", () => {
  test("an empty vault is `[]`, not an error", () => {
    expect(listOfferedSparks(newDb())).toEqual([]);
  });

  test("a live offer is exactly §3.3's five fields — no mechanism, no scores, no source ids", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["health"]);
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at,
                          mechanism, domain_distance, structural_alignment)
       VALUES ('s1', 'a', 'b', 'a|b', 'the direction', 'the claim', 'OFFERED', 't',
               '{"verb":"fuse"}', 2, 0.71)`,
    ).run();

    // `toEqual` is exact: the row's internals are present in the table and absent from the body.
    expect(listOfferedSparks(db)).toEqual([
      {
        id: "s1",
        direction: "the direction",
        claim: "the claim",
        domain_tags: ["fintech", "health"],
        created_at: "t",
      },
    ]);
  });

  test("server order is deck order — insertion, oldest first, ahead of any created_at tie", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["health"]);
    idea(db, "c", ["audio-dsp"]);
    // The lexicographically-**later** pair first, so `rowid` order ("second", "first") is the reverse
    // of `pair_key` order — the ordering *basis*, not just its direction (Max, #35 slice-1 review).
    spark(db, "s2", "a", "c", "OFFERED", "second");
    spark(db, "s1", "a", "b", "OFFERED", "first");

    expect(listOfferedSparks(db).map((row) => row.direction)).toEqual(["second", "first"]);
  });

  test("a resolved spark never reaches the deck — it is history, and §3.3 carries no status", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["health"]);
    idea(db, "c", ["audio-dsp"]);
    spark(db, "s-live", "a", "b");
    spark(db, "s-res", "b", "c", "RESOLVED-ACCEPTED");

    expect(listOfferedSparks(db).map((row) => row.id)).toEqual(["s-live"]);
  });
});

describe("the deck read moves nothing (NFR-P1's read posture)", () => {
  test("a call changes no revision and no row count", () => {
    const db = newDb();
    idea(db, "a", ["fintech"]);
    idea(db, "b", ["health"]);
    spark(db, "s1", "a", "b");
    const before = {
      revision: (
        db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as { revision: number }
      ).revision,
      changes: (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
    };

    listOfferedSparks(db);

    expect(
      (db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as { revision: number })
        .revision,
    ).toBe(before.revision);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(
      before.changes,
    );
  });
});

/**
 * The deck read owns **no second ladder** (K1's fence; W8 `#33`'s state read is the only one).
 *
 * Two checkable parts, because the mistake has two shapes: reusing the state read arrives as an
 * **import** (part 1, the `vault-summary.test.ts` / `engine-state.test.ts` precedent — an equality, so
 * the next specifier is a deliberate edit), and hand-rolling one arrives as **SQL** on the tables only
 * a ladder needs (part 2). Both are planted in the PR body and watched red.
 */
describe("the deck read does not re-derive E0–E4 (W8 #33 is the one place)", () => {
  const MODULE_PATH = fileURLToPath(new URL("./sparks.ts", import.meta.url));
  const MODULE_TEXT = readFileSync(MODULE_PATH, "utf8");

  /** Every module specifier in a file — the extractor the sibling guards use. */
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
    // Non-vacuity: without this, a broken regex turns the assertions below into silent passes.
    expect(MODULE_PATH.endsWith("/api/src/sparks.ts")).toBe(true);
    expect(MODULE_TEXT.length).toBeGreaterThan(0);
    expect(specifiers(MODULE_TEXT)).toContain("node:sqlite");
  });

  test("its only specifiers are the SQLite type, the store's deck read, and the validation error", () => {
    expect(specifiers(MODULE_TEXT)).toEqual(["node:sqlite", "@astrolab/store", "./capture.js"]);
  });

  test("and it issues no query of its own — no ladder SQL, no run-queue table", () => {
    // A hand-rolled ladder could dodge the import route above by writing the SQL here; this is that
    // route. `db` is handed to the store's read and never prepared against, and `spark_run` — E1/E4's
    // queue — is the state read's table, not the deck's.
    expect(MODULE_TEXT).not.toMatch(/db\s*\.\s*(prepare|exec)\s*\(/);
    expect(MODULE_TEXT).not.toMatch(/spark_run/);
    // Non-vacuity, both ways: the same shapes exist where they belong, so neither negative assertion
    // is scanning nothing — the store read this module composes does prepare, and the state read owns
    // the run queue.
    const storeRead = readFileSync(new URL("../../store/src/sparks.ts", import.meta.url), "utf8");
    expect(storeRead).toMatch(/db\s*\.\s*(prepare|exec)\s*\(/);
    const stateRead = readFileSync(new URL("./engine-state.ts", import.meta.url), "utf8");
    expect(stateRead).toMatch(/spark_run/);
  });
});
