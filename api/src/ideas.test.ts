import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test } from "vitest";

import { ValidationError } from "./capture.js";
import { listIdeas, parseVaultFilters } from "./ideas.js";

/**
 * V2 (#13) — the vault read path against a fresh migrated vault. `docs/API.md` §4.4 (list, filters).
 * The property worth naming here: the filter vocabulary is the contract's, so an unknown enum value
 * or a present-but-empty value is the `422` envelope and never a silently-empty list.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

interface Seed {
  id: string;
  domain_tags?: string[];
  lineage_kind?: "ROOT" | "ITERATION" | "FORK";
  lineage_parent_id?: string | null;
  status?: "ACTIVE" | "NEEDS_COMPLETION";
  created_at?: string;
}

/** Rows as a write path would leave them; capture only makes ROOTs, so forks/iterations go in directly. */
function seedIdea(db: DatabaseSync, seed: Seed): void {
  const at = seed.created_at ?? "2026-01-01T00:00:00Z";
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', ?, ?, ?, ?, 'PRIVATE', 1, ?, ?)`,
  ).run(
    seed.id,
    JSON.stringify(seed.domain_tags ?? ["fintech"]),
    seed.lineage_kind ?? "ROOT",
    seed.lineage_parent_id ?? null,
    seed.status ?? "ACTIVE",
    at,
    at,
  );
}

const NO_FILTERS = { domain: null, lineage: null, status: null } as const;

describe("parseVaultFilters — docs/API.md §4.4 with §1's rules", () => {
  test("an absent key is no restriction", () => {
    expect(parseVaultFilters(new URLSearchParams(""))).toEqual(NO_FILTERS);
  });

  test("reads the three filters", () => {
    expect(
      parseVaultFilters(new URLSearchParams("domain=fintech&lineage=FORK&status=ACTIVE")),
    ).toEqual({ domain: "fintech", lineage: "FORK", status: "ACTIVE" });
  });

  test("ignores an unknown parameter name (§1)", () => {
    expect(parseVaultFilters(new URLSearchParams("nope=1&lineage=ROOT"))).toEqual({
      ...NO_FILTERS,
      lineage: "ROOT",
    });
  });

  test("a repeated key takes its first occurrence", () => {
    expect(parseVaultFilters(new URLSearchParams("lineage=ROOT&lineage=FORK")).lineage).toBe(
      "ROOT",
    );
  });

  test("an unknown enum value is a validation failure, not an empty list", () => {
    expect(() => parseVaultFilters(new URLSearchParams("lineage=NOPE"))).toThrow(ValidationError);
    expect(() => parseVaultFilters(new URLSearchParams("status=active"))).toThrow(ValidationError);
  });

  test("a present-but-empty value is a validation failure", () => {
    expect(() => parseVaultFilters(new URLSearchParams("lineage="))).toThrow(ValidationError);
    expect(() => parseVaultFilters(new URLSearchParams("domain="))).toThrow(ValidationError);
  });
});

describe("listIdeas — docs/API.md §4.4", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = newDb();
    seedIdea(db, { id: "a1", domain_tags: ["fintech"], created_at: "2026-01-01T00:00:00Z" });
    seedIdea(db, { id: "b2", domain_tags: ["health"], created_at: "2026-01-02T00:00:00Z" });
    seedIdea(db, {
      id: "c3",
      domain_tags: ["fintech", "logistics"],
      lineage_kind: "FORK",
      lineage_parent_id: "a1",
      created_at: "2026-01-03T00:00:00Z",
    });
    seedIdea(db, {
      id: "d4",
      domain_tags: ["fintech"],
      status: "NEEDS_COMPLETION",
      created_at: "2026-01-04T00:00:00Z",
    });
  });

  test("no filter returns every idea, newest first", () => {
    expect(listIdeas(db, NO_FILTERS).map((idea) => idea.id)).toEqual(["d4", "c3", "b2", "a1"]);
  });

  test("same-second rows fall back to the id, so the order is total", () => {
    // Seeded with the *older* id first, so a scan-order (rowid) tiebreak would answer `y8` first:
    // only the `id DESC` term yields `z9` first. That is the difference this assertion watches.
    seedIdea(db, { id: "y8", created_at: "2026-02-01T00:00:00Z" });
    seedIdea(db, { id: "z9", created_at: "2026-02-01T00:00:00Z" });
    expect(
      listIdeas(db, NO_FILTERS)
        .slice(0, 2)
        .map((idea) => idea.id),
    ).toEqual(["z9", "y8"]);
  });

  test("domain matches a tag exactly — a prefix is not a match", () => {
    expect(listIdeas(db, { ...NO_FILTERS, domain: "fintech" }).map((idea) => idea.id)).toEqual([
      "d4",
      "c3",
      "a1",
    ]);
    expect(listIdeas(db, { ...NO_FILTERS, domain: "fin" })).toEqual([]);
    expect(listIdeas(db, { ...NO_FILTERS, domain: "logistics" }).map((idea) => idea.id)).toEqual([
      "c3",
    ]);
  });

  test("lineage and status filter, and compose with domain", () => {
    expect(listIdeas(db, { ...NO_FILTERS, lineage: "FORK" }).map((idea) => idea.id)).toEqual([
      "c3",
    ]);
    expect(listIdeas(db, { ...NO_FILTERS, status: "NEEDS_COMPLETION" }).map((i) => i.id)).toEqual([
      "d4",
    ]);
    expect(
      listIdeas(db, { domain: "health", lineage: "ROOT", status: "ACTIVE" }).map((i) => i.id),
    ).toEqual(["b2"]);
    expect(listIdeas(db, { domain: "health", lineage: "FORK", status: null })).toEqual([]);
  });

  test("maps the row to the §3.1 shape, tags as an array", () => {
    const [idea] = listIdeas(db, { ...NO_FILTERS, domain: "logistics" });
    expect(idea).toEqual({
      id: "c3",
      hypothesis: "h",
      problem: "p",
      monetization: "m",
      domain_tags: ["fintech", "logistics"],
      lineage_kind: "FORK",
      lineage_parent_id: "a1",
      status: "ACTIVE",
      visibility: "PRIVATE",
      current_version: 1,
      created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-03T00:00:00Z",
    });
  });
});
