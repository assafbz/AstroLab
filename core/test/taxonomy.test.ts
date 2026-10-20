import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteConnection } from "../src/store/connection.js";
import { afterEach, expect, test } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { seedDomainTaxonomy } from "../src/store/domain-seed.js";
import { TAXONOMY_PATH } from "../src/seed/taxonomy-file.node.js";
import { migrate } from "../src/store/migrate.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { openNodeStore } from "../src/store/connection.node.js";
import { rows } from "./seed.js";

/**
 * O1 (#21) — the loader's own assertions. The canonical harness (`o1_check.py`, its own CI job) reads
 * the *file*: it checks the data and the file contract, and it structurally cannot see the loader's
 * SQL. Everything below is a property of what the loader writes, which is why it lives here.
 *
 * The file-level numbers are re-derived here from the shipped bytes rather than imported from the
 * loader, so this is verification of the seed, not the loader vouching for itself.
 */

const META = new Set(["adjacency", "version", "corrections"]);

interface ClusterDoc {
  name: string;
  tags: string[];
}

const SHIPPED = readFileSync(TAXONOMY_PATH, "utf8");
const DOC = parseYaml(SHIPPED) as Record<string, unknown>;
const IDS = Object.keys(DOC).filter((key) => !META.has(key));
const FILE_TAGS = new Set(IDS.flatMap((id) => clusterDoc(DOC, id).tags));

function clusterDoc(doc: Record<string, unknown>, id: string): ClusterDoc {
  return doc[id] as ClusterDoc;
}

const dirs: string[] = [];
const opened: SqliteConnection[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-taxonomy-"));
  dirs.push(dir);
  return dir;
}

/** A migrated, empty store. */
function migrated(): SqliteConnection {
  const db = openNodeStore(join(tempDir(), "astrolab.sqlite"));
  opened.push(db);
  migrate(db, MIGRATIONS);
  return db;
}

/**
 * A variant of the shipped document, as **text** — the loader takes the taxonomy itself now, not a path
 * (#184), and the shipped bytes stay the one source of truth: every variant is re-serialised from them.
 */
function variant(mutate: (doc: Record<string, unknown>) => void): string {
  const doc = parseYaml(SHIPPED) as Record<string, unknown>;
  mutate(doc);
  return stringifyYaml(doc);
}

function count(db: SqliteConnection, table: "domain_cluster" | "domain_map"): number {
  return Number(rows(db, `SELECT count(*) AS n FROM ${table}`)[0]?.n);
}

/** SQLite's per-connection row-change counter: the only way to observe "the repeat wrote nothing". */
function changes(db: SqliteConnection): number {
  return Number(rows(db, "SELECT total_changes() AS n")[0]?.n);
}

function snapshot(db: SqliteConnection): unknown {
  return {
    clusters: rows(db, "SELECT id, name, adjacency FROM domain_cluster ORDER BY id"),
    map: rows(db, "SELECT tag, cluster_id FROM domain_map ORDER BY tag"),
  };
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the shipped file is the artifact of record: 28 clusters, 246 distinct tags, >= 8 each", () => {
  expect(IDS).toHaveLength(28);
  expect(FILE_TAGS.size).toBe(246);
  expect(IDS.flatMap((id) => clusterDoc(DOC, id).tags)).toHaveLength(246); // no cross-cluster dupe
  for (const id of IDS) expect(clusterDoc(DOC, id).tags.length).toBeGreaterThanOrEqual(8);
});

test("seeds 28 clusters and 264 map rows — 246 file tags plus the 18 keys not already in their list", () => {
  const keysNotListed = IDS.filter((id) => !FILE_TAGS.has(id));
  expect(keysNotListed).toHaveLength(18);
  expect(FILE_TAGS.size + keysNotListed.length).toBe(264); // the 10 keys already listed add nothing

  const db = migrated();
  seedDomainTaxonomy(db);
  expect(count(db, "domain_cluster")).toBe(28);
  expect(count(db, "domain_map")).toBe(264);
});

test("symmetrises adjacency on write: 53 listed pairs become 106 directed edges", () => {
  const db = migrated();
  seedDomainTaxonomy(db);

  const stored = new Map(
    rows(db, "SELECT id, adjacency FROM domain_cluster").map((row) => [
      String(row.id),
      JSON.parse(String(row.adjacency)) as Record<string, number>,
    ]),
  );
  expect([...stored.values()].reduce((n, map) => n + Object.keys(map).length, 0)).toBe(106);

  // Listed once in the file, both directions in the store: distance(A,B) == distance(B,A).
  expect(stored.get("fintech")?.marketplaces).toBe(1);
  expect(stored.get("marketplaces")?.fintech).toBe(1);
  // An unlisted pair is FAR (3) and is simply absent — it never becomes a stored `3`.
  expect(stored.get("fintech")?.devtools).toBeUndefined();
  expect(Object.values(stored.get("fintech") ?? {})).not.toContain(3);
});

test("is idempotent: a repeat writes nothing and leaves the store identical", () => {
  const db = migrated();
  seedDomainTaxonomy(db);

  const before = changes(db);
  const rowsBefore = snapshot(db);
  seedDomainTaxonomy(db);

  expect(changes(db)).toBe(before); // not even a same-value upsert
  expect(snapshot(db)).toEqual(rowsBefore);
  expect(count(db, "domain_cluster")).toBe(28);
  expect(count(db, "domain_map")).toBe(264);
});

test("refuses an undeclared re-point, and applies a declared correction", () => {
  // `streaming` ships in media-entertainment; moving it to data-infra flips the cliché/adjacency guard.
  const move = (doc: Record<string, unknown>): void => {
    const media = clusterDoc(doc, "media-entertainment");
    const infra = clusterDoc(doc, "data-infra");
    media.tags = media.tags.filter((tag) => tag !== "streaming");
    infra.tags = ["streaming", ...infra.tags];
  };

  const db = migrated();
  seedDomainTaxonomy(db);
  expect(() => seedDomainTaxonomy(db, variant(move))).toThrow(
    /re-point streaming: media-entertainment -> data-infra is not declared/,
  );
  expect(rows(db, "SELECT cluster_id FROM domain_map WHERE tag = 'streaming'")[0]?.cluster_id).toBe(
    "media-entertainment",
  ); // the refused run left the vault as it was

  const declared = variant((doc) => {
    move(doc);
    doc.corrections = [
      { tag: "streaming", from: "media-entertainment", to: "data-infra", reason: "mis-clustered" },
    ];
  });
  seedDomainTaxonomy(db, declared);
  expect(rows(db, "SELECT cluster_id FROM domain_map WHERE tag = 'streaming'")[0]?.cluster_id).toBe(
    "data-infra",
  );
});

test("never deletes: a row the file does not name survives a re-run untouched", () => {
  const db = migrated();
  seedDomainTaxonomy(db);

  // §3.2 step 2 — the worker's write-back, one row per distinct user free-text tag. It is user
  // content, not shipped vocabulary, and it is deliberately not clean.
  db.prepare("INSERT INTO domain_map (tag, cluster_id) VALUES (?, ?)").run("ai-&-ml", "ai-ml");
  const before = changes(db);

  // Both shapes of "absent from the file": a tag dropped from a cluster, and the worker's row.
  const dropped = variant((doc) => {
    const devtools = clusterDoc(doc, "devtools");
    devtools.tags = devtools.tags.filter((tag) => tag !== "deployment");
  });
  seedDomainTaxonomy(db, dropped);

  expect(rows(db, "SELECT cluster_id FROM domain_map WHERE tag = 'deployment'")).toHaveLength(1);
  expect(rows(db, "SELECT cluster_id FROM domain_map WHERE tag = 'ai-&-ml'")).toHaveLength(1);
  expect(count(db, "domain_map")).toBe(265); // 264 seeded + the worker's row: nothing was removed
  expect(changes(db)).toBe(before); // forward-only: the 28 remaining clusters were already identical
});

test("registers each cluster's key, never its display label", () => {
  const db = migrated();
  seedDomainTaxonomy(db);

  const tags = new Set(rows(db, "SELECT tag FROM domain_map").map((row) => String(row.tag)));
  expect(tags.has("ai-ml")).toBe(true); // the picker's value resolves by construction
  for (const id of IDS) expect(tags.has(clusterDoc(DOC, id).name)).toBe(false);
  expect(tags.has("ai-&-ml")).toBe(false);
  expect(rows(db, "SELECT name FROM domain_cluster WHERE id = 'ai-ml'")[0]?.name).toBe("AI & ML");
});

test("rejects a non-slug tag and an unquoted version", () => {
  const hyphen = variant((doc) => {
    clusterDoc(doc, "devtools").tags.push("ai--ml"); // the `&`-class's sibling: reaches the map
  });
  expect(() => seedDomainTaxonomy(migrated(), hyphen)).toThrow(
    /not a clean lowercase-hyphen slug: ai--ml/,
  );

  const numeric = variant((doc) => {
    doc.version = 1.2; // YAML would reparse "1.10" as 1.1 — the version is an identifier, not a number
  });
  expect(() => seedDomainTaxonomy(migrated(), numeric)).toThrow(/version must be a quoted string/);
});

test("the node-side file helper resolves the seed from the package root", () => {
  // The *loader* no longer reads a file (#184 — it takes text, so the bundle ships the taxonomy); this
  // is the path CI, the scripts and this suite read the artifact of record through. `seed/` sits at the
  // package root, so `../../seed/…` resolves from `src/seed/` (tsx) and `dist/seed/` (the built tree)
  // alike.
  expect(TAXONOMY_PATH.endsWith(join("core", "seed", "domain-taxonomy.yaml"))).toBe(true);
  expect(existsSync(TAXONOMY_PATH)).toBe(true);
});
