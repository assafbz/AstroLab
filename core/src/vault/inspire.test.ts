import type { SqliteConnection } from "../store/connection.js";
import { openNodeStore } from "../store/connection.node.js";

import { MIGRATIONS, migrate } from "../store/index.js";
import { describe, expect, test } from "vitest";

import { inspireSeed } from "./inspire.js";

/**
 * K5 (`#39`) — `POST /v1/sparks/{id}/inspire` (`docs/API.md` §4.14), at the layer that owns the read.
 * Two properties here are *checks*, not readings:
 *
 * - **INSPIRE is not a resolution** (#39's done criterion): it writes no `decision`, moves the revision
 *   by nothing, and leaves the spark `OFFERED`. The seeded save (`POST /v1/ideas`, §4.2) is the only
 *   thing that resolves a spark, and it is `capture.ts`'s.
 * - **The projection is exact** — §3.4's fields under the payload's key names, the selection internals
 *   never selected, and a legacy `what_it_takes` reading `null` rather than `""`.
 */

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function revision(db: SqliteConnection): number {
  const row = db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as {
    revision: number;
  };
  return row.revision;
}

function count(db: SqliteConnection, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** A spark with both sources (`a`, `b`), the two tags distinct so the derived union is observable. */
function seedSpark(
  db: SqliteConnection,
  id: string,
  status: string,
  whatItTakes: string | null,
  firstStep: string | null = "a first step",
): void {
  for (const [idea, tag] of [
    ["a", "fintech"],
    ["b", "health"],
  ] as const) {
    db.prepare(
      `INSERT OR IGNORE INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
    ).run(idea, JSON.stringify([tag]));
  }
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, first_step,
                        what_it_takes, status, created_at, mechanism, domain_distance,
                        structural_alignment)
     VALUES (?, 'a', 'b', ?, 'a direction', 'a claim', ?, ?, ?, '2026-01-01T00:00:00Z',
             '{"verb":"fuse"}', 2, 0.71)`,
  ).run(id, `a|b|${id}`, firstStep, whatItTakes, status);
}

describe("inspireSeed — docs/API.md §4.14's seed payload", () => {
  test("is §3.4's projection under the payload's keys — `spark_id`, no `created_at`, no internals", () => {
    const db = newDb();
    seedSpark(db, "s1", "OFFERED", "what it takes");

    // Exact: the key set *is* the contract. `created_at` is dropped, `id` is presented as `spark_id`,
    // and `mechanism` / the two scores / the source idea ids are in the row and absent from the body.
    expect(inspireSeed(db, "s1")).toEqual({
      spark_id: "s1",
      direction: "a direction",
      claim: "a claim",
      what_it_takes: "what it takes",
      first_step: "a first step",
      domain_tags: ["fintech", "health"],
    });
  });

  test('a legacy row\'s `what_it_takes` is `null`, never `""` (§3.4; one test)', () => {
    const db = newDb();
    seedSpark(db, "s-legacy", "OFFERED", null, null);

    const seed = inspireSeed(db, "s-legacy");
    // Absent, not an empty block: a client renders nothing for it rather than `""`.
    expect(seed?.what_it_takes).toBeNull();
    expect(seed?.first_step).toBeNull();
  });

  test("an unknown id is `null` — the caller answers §2's envelope", () => {
    const db = newDb();
    seedSpark(db, "s1", "OFFERED", "what it takes");

    expect(inspireSeed(db, "9f1c-missing")).toBeNull();
  });

  test("is status-blind — a resolved spark still seeds (the id is the filter, §4.12's reading)", () => {
    const db = newDb();
    seedSpark(db, "s-resolved", "RESOLVED-INSPIRED", "what it takes");

    // §4.9's deck drops this row; §4.14 must not — the seed carries no `status` either way.
    expect(inspireSeed(db, "s-resolved")).toMatchObject({ spark_id: "s-resolved" });
  });

  test("writes nothing — no `decision`, no revision stamp, and the spark stays `OFFERED` (#39)", () => {
    const db = newDb();
    seedSpark(db, "s1", "OFFERED", "what it takes");
    const before = revision(db);

    inspireSeed(db, "s1");

    expect(count(db, "decision")).toBe(0);
    expect(revision(db)).toBe(before); // a read: no vault write, so no stamp and no run
    expect(db.prepare("SELECT status FROM spark WHERE id = 's1'").get()).toEqual({
      status: "OFFERED",
    });
  });
});
