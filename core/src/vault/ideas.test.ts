import { MIGRATIONS, migrate } from "../store/index.js";
import type { SqliteConnection } from "../store/connection.js";
import { openNodeStore } from "../store/connection.node.js";
import { beforeEach, describe, expect, test } from "vitest";

import { ValidationError } from "./capture.js";
import { deleteIdea } from "./delete.js";
import { getIdeaDetail, listIdeas, parseVaultFilters } from "./ideas.js";

/**
 * V2 (#13) — the vault read path against a fresh migrated vault. `docs/API.md` §4.4 (list, filters)
 * and §4.5 (detail). Properties worth naming: the filter vocabulary is the contract's, so an unknown
 * enum value or a present-but-empty value is the `422` envelope and never a silently-empty list; and
 * in the detail the absent case is **empty, never an error**, with `provenance` never feeding
 * `lineage`.
 */

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

interface Seed {
  id: string;
  domain_tags?: string[];
  lineage_kind?: "ROOT" | "FORK";
  lineage_parent_id?: string | null;
  status?: "ACTIVE" | "NEEDS_COMPLETION";
  created_at?: string;
}

/** Rows as a write path would leave them; capture only makes ROOTs, so forks/iterations go in directly. */
function seedIdea(db: SqliteConnection, seed: Seed): void {
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

function seedVersion(
  db: SqliteConnection,
  id: string,
  version: number,
  domain_tags: string[],
): void {
  db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, ?, ?, 'p', 'm', ?, '2026-01-01T00:00:00Z')`,
  ).run(id, version, `h${version}`, JSON.stringify(domain_tags));
}

function seedProvenance(
  db: SqliteConnection,
  derived: string,
  source: string,
  spark: string,
): void {
  db.prepare(
    `INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES (?, ?, ?)`,
  ).run(derived, source, spark);
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
  let db: SqliteConnection;
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

describe("getIdeaDetail — docs/API.md §4.5", () => {
  test("an unknown id is null, so the caller answers the not_found envelope", () => {
    expect(getIdeaDetail(newDb(), "nope")).toBeNull();
  });

  test("a ROOT with nothing attached returns empty arrays, never an error", () => {
    const db = newDb();
    seedIdea(db, { id: "root" });
    seedVersion(db, "root", 1, ["fintech"]);
    expect(getIdeaDetail(db, "root")).toEqual({
      idea: expect.objectContaining({ id: "root", lineage_kind: "ROOT", lineage_parent_id: null }),
      versions: [expect.objectContaining({ version: 1, hypothesis: "h1" })],
      lineage: [],
      provenance: [],
      referenced_by: { forks: [], derived: [] },
    });
  });

  test("versions are every row for the node, ascending, the current one included", () => {
    const db = newDb();
    seedIdea(db, { id: "root" });
    seedVersion(db, "root", 1, ["fintech"]);
    seedVersion(db, "root", 3, ["fintech", "health"]);
    seedVersion(db, "root", 2, ["health"]);
    expect(getIdeaDetail(db, "root")?.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(getIdeaDetail(db, "root")?.versions.at(-1)?.domain_tags).toEqual(["fintech", "health"]);
  });

  test("lineage is the ancestor chain, root-first, and excludes the node itself", () => {
    const db = newDb();
    seedIdea(db, { id: "root" });
    seedIdea(db, { id: "mid", lineage_kind: "FORK", lineage_parent_id: "root" });
    seedIdea(db, { id: "leaf", lineage_kind: "FORK", lineage_parent_id: "mid" });
    const detail = getIdeaDetail(db, "leaf");
    expect(detail?.lineage.map((idea) => idea.id)).toEqual(["root", "mid"]);
    expect(detail?.idea.id).toBe("leaf");
  });

  test("a lineage cycle terminates instead of looping — the `seen` guard", () => {
    // `0003` (V5 #16) dropped `idea`'s self-reference, so **two** degenerate shapes are reachable
    // now, and the walk has a guard for each. This is the cycle: build `a → b`, then re-point `b` at
    // `a`. It exits through `seen`, and must stop rather than loop.
    const db = newDb();
    seedIdea(db, { id: "b" });
    seedIdea(db, { id: "a", lineage_kind: "FORK", lineage_parent_id: "b" });
    db.exec("UPDATE idea SET lineage_kind = 'FORK', lineage_parent_id = 'a' WHERE id = 'b'");
    expect(getIdeaDetail(db, "a")?.lineage.map((idea) => idea.id)).toEqual(["b"]);
  });

  test("a dangling lineage parent stops the walk instead of failing — T26's tolerated ref", () => {
    // The **other** degenerate shape, and the one `0003` made reachable: T26 tolerates a deleted fork
    // parent, so the child keeps a `lineage_parent_id` naming a row that is gone (asserted at the
    // schema level in `store/test/references.test.ts`). The read path must answer §4.5's absent case
    // — `lineage: []` — through `ancestorChain`'s `break`, not by throwing and not through `seen`.
    const db = newDb();
    seedIdea(db, { id: "parent" });
    seedIdea(db, { id: "child", lineage_kind: "FORK", lineage_parent_id: "parent" });
    expect(deleteIdea(db, "parent")).toBe(true);

    const detail = getIdeaDetail(db, "child");
    expect(detail?.idea.lineage_parent_id).toBe("parent"); // the ref survives the delete
    expect(detail?.lineage).toEqual([]); // …and the walk stops on it
  });

  test("provenance is its own array, sorted, and never folded into lineage", () => {
    const db = newDb();
    seedIdea(db, { id: "left" });
    seedIdea(db, { id: "right" });
    // A derived idea carries provenance and NO lineage parent — the §5 invariant-3 shape.
    seedIdea(db, { id: "born" });
    seedProvenance(db, "born", "right", "spark-2");
    seedProvenance(db, "born", "left", "spark-1");
    seedProvenance(db, "born", "left", "spark-0");

    const detail = getIdeaDetail(db, "born");
    expect(detail?.provenance).toEqual([
      { source_idea_id: "left", spark_id: "spark-0" },
      { source_idea_id: "left", spark_id: "spark-1" },
      { source_idea_id: "right", spark_id: "spark-2" },
    ]);
    expect(detail?.lineage).toEqual([]);
    expect(detail?.referenced_by).toEqual({ forks: [], derived: [] });
    // Guard discipline, stated rather than implied: this assertion is **not** discriminating on this
    // schema. The PK's covering index on `(derived_idea_id, …)` already returns these rows in
    // `(source_idea_id, spark_id)` order, so deleting the `ORDER BY` leaves the result unchanged — the
    // same undiscriminating shape AGENTS.md records for `cutVault`. The clause is kept because it is
    // the contract (the V2 ruling), not because this test can see it. The `referenced_by` orderings in
    // the test below **are** discriminating: `EXPLAIN QUERY PLAN` shows both of those queries scan, so
    // insertion order is observable and the sort is what makes the answer deterministic.
  });

  test("referenced_by names the forks and the ideas derived from this one, in id order", () => {
    const db = newDb();
    seedIdea(db, { id: "origin" });
    // Seeded with the *later* id first, so rowid (scan) order is the reverse of id order: a missing
    // `ORDER BY id` answers `["z-fork", "a-fork"]` here, and the assertion below goes red.
    seedIdea(db, { id: "z-fork", lineage_kind: "FORK", lineage_parent_id: "origin" });
    seedIdea(db, { id: "a-fork", lineage_kind: "FORK", lineage_parent_id: "origin" });
    seedIdea(db, { id: "z-born" });
    seedIdea(db, { id: "a-born" });
    seedProvenance(db, "z-born", "origin", "spark-1");
    seedProvenance(db, "a-born", "origin", "spark-2");
    expect(getIdeaDetail(db, "origin")?.referenced_by).toEqual({
      forks: ["a-fork", "z-fork"],
      derived: ["a-born", "z-born"],
    });
  });

  test("the five reads run inside one transaction — a single snapshot", () => {
    // The only observable proof that the read opens its own transaction: SQLite refuses to nest one.
    // Without it each of the five statements takes its own WAL snapshot, and a concurrent commit can
    // land between them, shipping a `versions` list that disagrees with `idea.current_version`.
    const db = newDb();
    seedIdea(db, { id: "root" });
    db.exec("BEGIN");
    try {
      expect(() => getIdeaDetail(db, "root")).toThrow(/transaction/i);
    } finally {
      db.exec("ROLLBACK");
    }
  });
});
