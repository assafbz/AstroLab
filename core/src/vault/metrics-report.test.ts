import type { SqliteConnection } from "../store/connection.js";
import { openNodeStore } from "../store/connection.node.js";

import { migrate, MIGRATIONS, seedDomainTaxonomy } from "../store/index.js";
import { describe, expect, test } from "vitest";

import { forkIdea } from "./fork.js";
import { iterateIdea } from "./iterate.js";
import {
  activeUserMonths,
  distinctDomainsPerUser,
  lineageActivityByMonth,
  onboardingActivation,
  weeklyRetention,
} from "./metrics-report.js";

/**
 * EV2 (`#44`) — **the metrics readout** (`docs/PRD.md` §5). It proves the five query families, and the
 * two definitions the schema does not carry (the module states them in full).
 *
 * | # | claim (PRD §5) | the fixture that fails it |
 * | :-- | :-- | :-- |
 * | 1 | `activeUserMonths` — a month is active on **any** decision kind | a DISMISS-only month must appear (a read that filtered `kind='ACCEPT'` would drop it) |
 * | 2 | `activeUserMonths` — only in-window months | a decision in the month **after** `to` is absent |
 * | 3 | a malformed bound is **loud** | an instant (`2026-10-01T…`) instead of a month key throws, rather than an empty report |
 * | 4 | `distinctDomainsPerUser` — distinct **domains**, not tags | two tags of one cluster (`payments`+`banking`) count `1`; a second cluster counts `2` |
 * | 5 | an unmapped tag is a **provisional** domain of its own | a tag absent from the shipped taxonomy adds `1` to `provisional`, not to `resolved` |
 * | 6 | `onboardingActivation` — gate `≥2`, target `≥3` | the same vault crosses `cleared_gate` at 2 and `met_target` at 3, not together |
 * | 7 | `lineageActivityByMonth` — iterations are `idea_version`, not a `lineage_kind` | a `version = 1` (birth) row is **not** an iteration; a `ROOT` is not a fork |
 * | 8 | the real writers land in the readout | `forkIdea` + `iterateIdea` on a live store produce exactly one fork and one iteration in the current month |
 * | 9 | `weeklyRetention` — the return proxy | two active weeks over a five-week month (`rate 0.4`); quiet weeks are absent from `weeks` but counted in `weeks_spanned` |
 * | 10 | an empty window spans no week | `from >= to` reports `weeks_spanned: 0`, `rate: 0` — not the CTE's base row |
 *
 * **0 provider calls** — every path is `api`-local SQL over the F3 tables.
 */

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  return db;
}

interface SeedIdeaOptions {
  kind?: "ROOT" | "FORK";
  createdAt?: string;
}

function seedIdea(
  db: SqliteConnection,
  id: string,
  tags: string[],
  opts: SeedIdeaOptions = {},
): void {
  const at = opts.createdAt ?? "2026-10-05T00:00:00Z";
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, ?, NULL, 'ACTIVE', 'PRIVATE', 1, ?, ?)`,
  ).run(id, JSON.stringify(tags), opts.kind ?? "ROOT", at, at);
}

function seedIteration(
  db: SqliteConnection,
  ideaId: string,
  version: number,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, ?, 'h', 'p', 'm', '["payments"]', ?)`,
  ).run(ideaId, version, createdAt);
}

/** One live `OFFERED` spark — `decision.spark_id` carries a real reference (`0003`), so it needs a row. */
function seedSpark(db: SqliteConnection): void {
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
     VALUES ('s1', 'a', 'b', 'a|b', 'd', 'c', 'OFFERED', '2026-10-01T00:00:00Z')`,
  ).run();
}

function seedDecision(db: SqliteConnection, id: string, kind: string, decidedAt: string): void {
  db.prepare(
    `INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at) VALUES (?, 's1', ?, NULL, ?)`,
  ).run(id, kind, decidedAt);
}

describe("activeUserMonths — the active user-month set (Call 1)", () => {
  test("any decision kind marks a month active; only in-window months appear", () => {
    const db = newDb();
    seedSpark(db);
    seedDecision(db, "d1", "ACCEPT", "2026-10-03T00:00:00Z");
    seedDecision(db, "d2", "DISMISS", "2026-10-20T00:00:00Z");
    seedDecision(db, "d3", "INSPIRED", "2026-11-02T00:00:00Z");
    seedDecision(db, "d4", "ACCEPT", "2026-12-01T00:00:00Z"); // outside [2026-10, 2026-12)
    expect(activeUserMonths(db, "2026-10", "2026-12")).toEqual([
      { month: "2026-10", count: 2 },
      { month: "2026-11", count: 1 },
    ]);
  });

  test("a DISMISS-only month is active — the set is not the accepted set", () => {
    const db = newDb();
    seedSpark(db);
    seedDecision(db, "d1", "DISMISS", "2026-10-03T00:00:00Z");
    expect(activeUserMonths(db, "2026-10", "2026-11")).toEqual([{ month: "2026-10", count: 1 }]);
  });

  test("a bound that is not a month key throws rather than reporting an empty window", () => {
    const db = newDb();
    expect(() => activeUserMonths(db, "2026-10-01T00:00:00Z", "2026-11")).toThrow(RangeError);
    expect(() => activeUserMonths(db, "2026-10", "2026-13")).toThrow(RangeError);
  });
});

describe("diversity + onboarding activation — read off the vault, not re-derived", () => {
  test("two tags in one cluster are one domain; a second cluster is a second", () => {
    const db = newDb();
    seedIdea(db, "a", ["payments", "banking"]); // both in the `fintech` cluster
    expect(distinctDomainsPerUser(db)).toEqual({ resolved: 1, provisional: 0, total: 1 });
    seedIdea(db, "b", ["health"]); // a second cluster
    expect(distinctDomainsPerUser(db)).toEqual({ resolved: 2, provisional: 0, total: 2 });
  });

  test("a tag the taxonomy does not carry is a provisional domain of its own", () => {
    const db = newDb();
    seedIdea(db, "a", ["payments"]);
    seedIdea(db, "b", ["quantum-crochet"]); // not in the shipped taxonomy
    expect(distinctDomainsPerUser(db)).toEqual({ resolved: 1, provisional: 1, total: 2 });
  });

  test("activation: the gate is ≥2 resolved and the target ≥3 — one vault, one answer", () => {
    const db = newDb();
    expect(onboardingActivation(db)).toMatchObject({
      resolved_domains: 0,
      floor: 2,
      target: 3,
      cleared_gate: false,
      met_target: false,
    });
    seedIdea(db, "a", ["payments"]);
    expect(onboardingActivation(db)).toMatchObject({
      resolved_domains: 1,
      cleared_gate: false,
      met_target: false,
    });
    seedIdea(db, "b", ["health"]);
    expect(onboardingActivation(db)).toMatchObject({
      resolved_domains: 2,
      cleared_gate: true,
      met_target: false,
    });
    seedIdea(db, "c", ["education"]);
    expect(onboardingActivation(db)).toMatchObject({
      resolved_domains: 3,
      cleared_gate: true,
      met_target: true,
    });
  });
});

describe("lineageActivityByMonth — forks from `idea`, iterations from `idea_version` (Call 3)", () => {
  test("a fork and an iteration bucket by their own rows' created_at", () => {
    const db = newDb();
    seedIdea(db, "root", ["payments"], { createdAt: "2026-10-01T00:00:00Z" });
    seedIdea(db, "fork", ["health"], { kind: "FORK", createdAt: "2026-10-04T00:00:00Z" });
    seedIteration(db, "root", 2, "2026-11-05T00:00:00Z");
    expect(lineageActivityByMonth(db, "2026-10", "2026-12")).toEqual([
      { month: "2026-10", forks: 1, iterations: 0 },
      { month: "2026-11", forks: 0, iterations: 1 },
    ]);
  });

  test("a birth `idea_version` (version 1) is not an iteration, and a ROOT is not a fork", () => {
    const db = newDb();
    seedIdea(db, "root", ["payments"], { createdAt: "2026-10-01T00:00:00Z" });
    seedIteration(db, "root", 1, "2026-10-01T00:00:00Z");
    expect(lineageActivityByMonth(db, "2026-10", "2026-11")).toEqual([]);
  });

  test("the real writers land in the readout — forkIdea + iterateIdea", () => {
    const db = newDb();
    seedIdea(db, "parent", ["payments"], { createdAt: "2026-10-01T00:00:00Z" });
    const fork = forkIdea(db, "parent", { mutation_delta: "pivot", domain_tags: ["health"] });
    iterateIdea(db, "parent", {
      hypothesis: "h2",
      problem: "p",
      monetization: "m",
      domain_tags: ["payments"],
    });
    // The fork's own birth row is `version = 1`, so the fork contributes a fork and the iterate
    // contributes the iteration — the two halves come from the two different tables, both to now().
    expect(fork.lineage_kind).toBe("FORK");
    const month = new Date().toISOString().slice(0, 7);
    expect(lineageActivityByMonth(db, "2000-01", "2099-01")).toEqual([
      { month, forks: 1, iterations: 1 },
    ]);
  });
});

describe("weeklyRetention — the return proxy over the decision trace (Call 2)", () => {
  test("two active weeks over a five-week month; quiet weeks are absent but counted in the span", () => {
    const db = newDb();
    seedSpark(db);
    seedDecision(db, "d1", "ACCEPT", "2026-10-05T10:00:00Z"); // 2026-W40
    seedDecision(db, "d2", "DISMISS", "2026-10-19T10:00:00Z"); // 2026-W42
    const readout = weeklyRetention(db, "2026-10", "2026-11");
    expect(readout.weeks).toEqual([
      { week: "2026-W40", decisions: 1 },
      { week: "2026-W42", decisions: 1 },
    ]);
    expect(readout.active_weeks).toBe(2);
    expect(readout.weeks_spanned).toBe(5);
    expect(readout.rate).toBe(0.4);
  });

  test("a window with no decisions reports no active week — and a real span, not a division by zero", () => {
    const db = newDb();
    expect(weeklyRetention(db, "2026-10", "2026-11")).toEqual({
      weeks: [],
      active_weeks: 0,
      weeks_spanned: 5,
      rate: 0,
    });
  });

  test("an empty window (from >= to) spans no week", () => {
    const db = newDb();
    expect(weeklyRetention(db, "2026-10", "2026-10")).toEqual({
      weeks: [],
      active_weeks: 0,
      weeks_spanned: 0,
      rate: 0,
    });
    expect(weeklyRetention(db, "2026-11", "2026-10")).toEqual({
      weeks: [],
      active_weeks: 0,
      weeks_spanned: 0,
      rate: 0,
    });
  });
});
