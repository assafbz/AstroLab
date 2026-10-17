import { readFileSync } from "node:fs";
import type { SqliteConnection } from "../store/connection.js";
import { openNodeStore } from "../store/connection.node.js";
import { fileURLToPath } from "node:url";

import {
  MIGRATIONS,
  SCHEMA_VERSION,
  migrate,
  schemaVersion,
  seedDomainTaxonomy,
} from "../store/index.js";
import { describe, expect, test } from "vitest";

import { exportVault } from "./export.js";

/**
 * V6 (#17) — the export (`docs/API.md` §4.17; `docs/ARCHITECTURE.md` §8; NFR-D1).
 *
 * The claims here are the ones a happy-path check cannot make true, so they are asserted rather than
 * intended: the document is the **eight** contract keys and nothing else, `schema_version` is the
 * **live** constant (a number, not §4.17's stale string), `mutation_delta` rides with a FORK and is
 * `null` on a ROOT, the read is **one snapshot** (`BEGIN`…`COMMIT`), and it **writes nothing** and can
 * reach no provider.
 *
 * The round-trip is **EV5 #47** — nothing here claims one.
 */

function newDb(options: { seedTaxonomy?: boolean } = {}): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  if (options.seedTaxonomy ?? true) seedDomainTaxonomy(db);
  return db;
}

interface IdeaSpec {
  tags?: string[];
  status?: "ACTIVE" | "NEEDS_COMPLETION";
  lineageKind?: "ROOT" | "FORK";
  parentId?: string | null;
  mutationDelta?: string | null;
  createdAt?: string;
}

function idea(db: SqliteConnection, id: string, spec: IdeaSpec = {}): void {
  const kind = spec.lineageKind ?? "ROOT";
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at,
                       mutation_delta)
     VALUES (?, ?, 'p', 'm', ?, ?, ?, ?, 'PRIVATE', 1, ?, ?, ?)`,
  ).run(
    id,
    `h-${id}`,
    JSON.stringify(spec.tags ?? ["fintech"]),
    kind,
    kind === "FORK" ? (spec.parentId ?? "root") : null,
    spec.status ?? "ACTIVE",
    spec.createdAt ?? "2026-01-01T00:00:00Z",
    spec.createdAt ?? "2026-01-01T00:00:00Z",
    kind === "FORK" ? (spec.mutationDelta ?? "widened") : null,
  );
}

function version(db: SqliteConnection, ideaId: string, v: number, tags: string[]): void {
  db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, ?, 'h', 'p', 'm', ?, '2026-01-01T00:00:00Z')`,
  ).run(ideaId, v, JSON.stringify(tags));
}

function provenance(db: SqliteConnection, derived: string, source: string, spark: string): void {
  db.prepare(
    "INSERT INTO provenance_edge (derived_idea_id, source_idea_id, spark_id) VALUES (?, ?, ?)",
  ).run(derived, source, spark);
}

function decision(
  db: SqliteConnection,
  id: string,
  sparkId: string,
  kind: string,
  resultIdeaId: string | null,
): void {
  db.prepare(
    `INSERT INTO decision (id, spark_id, kind, result_idea_id, decided_at)
     VALUES (?, ?, ?, ?, '2026-02-01T00:00:00Z')`,
  ).run(id, sparkId, kind, resultIdeaId);
}

const revision = (db: SqliteConnection): number =>
  (db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as { revision: number })
    .revision;

describe("exportVault — docs/API.md §4.17", () => {
  test("the document is exactly the eight contract keys", () => {
    expect(Object.keys(exportVault(newDb()))).toEqual([
      "schema_version",
      "exported_at",
      "ideas",
      "idea_versions",
      "lineage_edges",
      "provenance_edges",
      "decisions",
      "domain_tags",
    ]);
  });

  test("an empty vault exports empty collections, not an error", () => {
    const doc = exportVault(newDb({ seedTaxonomy: false }));
    expect(doc.ideas).toEqual([]);
    expect(doc.idea_versions).toEqual([]);
    expect(doc.lineage_edges).toEqual([]);
    expect(doc.provenance_edges).toEqual([]);
    expect(doc.decisions).toEqual([]);
    expect(doc.domain_tags).toEqual([]);
  });

  test('schema_version is the live constant, a number — §4.17\'s stale `"1"` is not shipped', () => {
    const db = newDb();
    const doc = exportVault(db);
    expect(doc.schema_version).toBe(SCHEMA_VERSION);
    expect(typeof doc.schema_version).toBe("number");
    // The pin that keeps the constant honest: the store's own reading, so a future divergence
    // (`SCHEMA_VERSION` vs `PRAGMA user_version`) reddens instead of shipping silently.
    expect(doc.schema_version).toBe(schemaVersion(db));
    // The exact defect §4.17's example carries: a string placeholder that drifted from the store.
    expect(doc.schema_version).not.toBe("1");
  });

  test("exported_at is the store's UTC second-resolution stamp", () => {
    expect(exportVault(newDb()).exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("ideas[] is the full row: a FORK carries mutation_delta, a ROOT is null", () => {
    const db = newDb();
    idea(db, "root", { lineageKind: "ROOT" });
    idea(db, "fork", { lineageKind: "FORK", parentId: "root", mutationDelta: "pivot to health" });

    const byId = Object.fromEntries(exportVault(db).ideas.map((row) => [row.id, row]));
    expect(byId.root).toMatchObject({
      id: "root",
      hypothesis: "h-root",
      lineage_kind: "ROOT",
      lineage_parent_id: null,
      mutation_delta: null,
      domain_tags: ["fintech"],
    });
    // The row-only field — §3.1's `Idea` omits it, so a `toIdea`-shaped export would drop it here.
    expect(byId.fork).toMatchObject({
      lineage_kind: "FORK",
      lineage_parent_id: "root",
      mutation_delta: "pivot to health",
    });
  });

  test("every idea is present, ordered by id", () => {
    const db = newDb();
    idea(db, "b-idea");
    idea(db, "a-idea");
    expect(exportVault(db).ideas.map((row) => row.id)).toEqual(["a-idea", "b-idea"]);
  });

  test("idea_versions[] carries every version, domain_tags parsed, ordered by (idea, version)", () => {
    const db = newDb();
    idea(db, "a");
    version(db, "a", 2, ["health"]);
    version(db, "a", 1, ["fintech"]);
    const versions = exportVault(db).idea_versions;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]).toMatchObject({ idea_id: "a", domain_tags: ["fintech"] });
  });

  test("lineage_edges[] is one edge per FORK, and none for a ROOT", () => {
    const db = newDb();
    idea(db, "root", { lineageKind: "ROOT" });
    idea(db, "fork", { lineageKind: "FORK", parentId: "root" });
    expect(exportVault(db).lineage_edges).toEqual([{ idea_id: "fork", parent_idea_id: "root" }]);
  });

  test("provenance_edges[] is the muted relation, ordered — and disjoint from lineage", () => {
    const db = newDb();
    idea(db, "derived");
    provenance(db, "derived", "s2", "spark-b");
    provenance(db, "derived", "s1", "spark-a");
    const edges = exportVault(db).provenance_edges;
    expect(edges).toEqual([
      { derived_idea_id: "derived", source_idea_id: "s1", spark_id: "spark-a" },
      { derived_idea_id: "derived", source_idea_id: "s2", spark_id: "spark-b" },
    ]);
    // A provenance edge is never a lineage edge (§5 invariant 3).
    expect(exportVault(db).lineage_edges).toEqual([]);
  });

  test("decisions[] exports the rows that exist and is empty before the writer (K4 #38)", () => {
    const db = newDb();
    expect(exportVault(db).decisions).toEqual([]); // correct, not a stub to fill

    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES ('spark-a', 'a', 'b', 'a|b', 'd', 'c', 'RESOLVED-ACCEPTED', '2026-01-01T00:00:00Z')`,
    ).run();
    decision(db, "dec-1", "spark-a", "ACCEPT", "derived");
    expect(exportVault(db).decisions).toEqual([
      {
        decision_id: "dec-1",
        spark_id: "spark-a",
        kind: "ACCEPT",
        result_idea_id: "derived",
        decided_at: "2026-02-01T00:00:00Z",
      },
    ]);
  });

  test("domain_tags[] is the vocabulary of record — one {tag, cluster_id} per domain_map row", () => {
    const db = newDb({ seedTaxonomy: false });
    db.prepare("INSERT INTO domain_cluster (id, name, adjacency) VALUES ('c1', 'C1', '{}')").run();
    db.prepare("INSERT INTO domain_map (tag, cluster_id) VALUES ('zeta', 'c1')").run();
    db.prepare("INSERT INTO domain_map (tag, cluster_id) VALUES ('alpha', 'c1')").run();
    expect(exportVault(db).domain_tags).toEqual([
      { tag: "alpha", cluster_id: "c1" },
      { tag: "zeta", cluster_id: "c1" },
    ]);
  });
});

describe("the export is one snapshot, a read, and cannot reach a provider (NFR-D1, NFR-A1)", () => {
  test("every read happens inside exactly one BEGIN…COMMIT", () => {
    // The property, asserted rather than described: the seven reads must sit between one `BEGIN` and
    // one `COMMIT`, or a writer committing mid-read ships a document from two vault states. Remove
    // the wrapper and there is no `BEGIN` — this reddens, which is the "seen failing" bar.
    const db = newDb();
    idea(db, "a");
    version(db, "a", 1, ["fintech"]);

    const events: Array<{ op: "exec" | "prepare"; sql: string }> = [];
    const counting = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        if (property === "exec") {
          return (sql: string) => {
            events.push({ op: "exec", sql });
            return (value as (s: string) => unknown).apply(target, [sql]);
          };
        }
        if (property === "prepare") {
          return (sql: string) => {
            events.push({ op: "prepare", sql });
            return (value as (s: string) => unknown).apply(target, [sql]);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });

    exportVault(counting as SqliteConnection);

    const execs = events.filter((e) => e.op === "exec").map((e) => e.sql.trim().toUpperCase());
    expect(execs.filter((s) => s === "BEGIN")).toHaveLength(1);
    expect(execs.filter((s) => s === "COMMIT")).toHaveLength(1);
    expect(execs).not.toContain("ROLLBACK");

    const beginAt = events.findIndex(
      (e) => e.op === "exec" && e.sql.trim().toUpperCase() === "BEGIN",
    );
    const commitAt = events.findIndex(
      (e) => e.op === "exec" && e.sql.trim().toUpperCase() === "COMMIT",
    );
    const prepares = events.filter((e) => e.op === "prepare");
    // Non-vacuity: if the scan missed the prepares, "all between" is trivially true.
    expect(prepares.length).toBeGreaterThan(0);
    prepares.forEach((p) => {
      const at = events.indexOf(p);
      expect(at).toBeGreaterThan(beginAt);
      expect(at).toBeLessThan(commitAt);
    });
  });

  test("the export writes nothing — no revision bump, no change counter, no run", () => {
    const db = newDb();
    idea(db, "a");
    const before = {
      revision: revision(db),
      changes: (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
    };
    exportVault(db);
    expect(revision(db)).toBe(before.revision);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(
      before.changes,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM spark_run").get() as { n: number }).n).toBe(0);
  });

  const MODULE_PATH = fileURLToPath(new URL("./export.ts", import.meta.url));
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
    expect(MODULE_PATH.endsWith("/core/src/export/export.ts")).toBe(true);
    expect(MODULE_TEXT.length).toBeGreaterThan(0);
    expect(specifiers(MODULE_TEXT)).toContain("../store/connection.js");
  });

  test("the module reaches only SQLite, the store, and its own row type — no provider, no fs", () => {
    // `@astrolab/store` is the vault's own package (the export's `SCHEMA_VERSION` / `isoTimestamp`);
    // `./ideas.js` is §4.5's shared `readSnapshot`; `./idea.js` is a type-only import. Anything else —
    // a provider, a transport, `../`-escapes into the worker — must arrive as a named exception with
    // its reason, so this is equality, not a denylist.
    expect(specifiers(MODULE_TEXT).sort()).toEqual(
      [
        "../store/connection.js",
        "../store/index.js",
        "../vault/idea.js",
        "../vault/ideas.js",
      ].sort(),
    );
  });
});
