import { readFileSync } from "node:fs";
import type { SqliteConnection } from "./connection.js";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { writeTransaction } from "./store.js";

/**
 * The shipped seed taxonomy is **data, not code** (`ARCHITECTURE.md` §2.4, §3.2): one YAML file the
 * loader reads at boot and upserts, so `domain_map` resolves the ordinary tags the S0 picker and the
 * spread gate count. The curation rule lives in `seed/README.md`; the file itself is the artifact.
 *
 * `seed/` sits at the **package root**, so `../../seed/…` resolves from `src/store/` (tsx) and from
 * `dist/store/` (the built entry the app imports) alike. Moving it under `src/` would break the
 * `dist/` half, which only the post-`build` CI step would catch.
 */
export const TAXONOMY_PATH = fileURLToPath(
  new URL("../../seed/domain-taxonomy.yaml", import.meta.url),
);

/** Reserved top-level keys — every other top-level key names a cluster (the harness's file contract). */
const META = new Set(["adjacency", "version", "corrections"]);

/** The slug charset, applied to the **map** (`tag2cl ∪ keys`) only — never to `corrections`. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface Cluster {
  id: string;
  name: string;
  tags: string[];
}

interface Correction {
  tag: string;
  from: string;
  to: string;
  kind: string;
}

export interface Taxonomy {
  clusters: Cluster[];
  /** cluster id → symmetrised `{other_cluster_id: hops}`; each pair is listed once in the file. */
  adjacency: Map<string, Map<string, number>>;
  /** `string` or null: present only from the first *versioned* ship (v1.3); v1.2 ships unversioned. */
  version: string | null;
  corrections: Correction[];
}

function fail(message: string): never {
  throw new Error(`domain taxonomy: ${message}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function asList(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be a list`);
  return value;
}

function asString(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  return value;
}

/** Validates the whole file **before** the loader writes anything, so a bad file cannot half-seed. */
export function parseTaxonomy(text: string, source: string): Taxonomy {
  const doc = asRecord(parseYaml(text), source);
  const ids = Object.keys(doc).filter((key) => !META.has(key));
  if (ids.length === 0) fail(`${source} has no clusters`);

  const clusters: Cluster[] = [];
  const tag2cl = new Map<string, string>();
  for (const id of ids) {
    const entry = asRecord(doc[id], `cluster ${id}`);
    const name = asString(entry.name, `cluster ${id}.name`);
    if (name.trim() === "") fail(`cluster ${id}.name must not be blank`);
    const tags = asList(entry.tags, `cluster ${id}.tags`).map((tag, i) =>
      asString(tag, `cluster ${id}.tags[${i}]`),
    );
    for (const tag of tags) {
      const owner = tag2cl.get(tag);
      if (owner !== undefined) fail(`tag ${tag} is in two clusters: ${owner}, ${id}`);
      tag2cl.set(tag, id);
    }
    clusters.push({ id, name, tags });
  }

  // A key that is also another cluster's tag would make the key row a silent re-point inside one seed.
  for (const id of ids) {
    const owner = tag2cl.get(id);
    if (owner !== undefined && owner !== id) fail(`cluster key ${id} is also a tag of ${owner}`);
  }

  const version = doc.version === undefined ? null : doc.version;
  if (version !== null && typeof version !== "string") {
    fail(
      `version must be a quoted string, so YAML cannot reparse it as a number (${String(version)})`,
    );
  }

  const corrections: Correction[] = asList(doc.corrections ?? [], "corrections").map((raw, i) => {
    const entry = asRecord(raw, `corrections[${i}]`);
    return {
      tag: asString(entry.tag, `corrections[${i}].tag`),
      from: asString(entry.from, `corrections[${i}].from`),
      to: asString(entry.to, `corrections[${i}].to`),
      kind: entry.kind === undefined ? "repoint" : asString(entry.kind, `corrections[${i}].kind`),
    };
  });

  // Seed-lint: the domain is the map, never the declarations — a retirement names a tag precisely
  // because it is not clean, so linting declarations would make the hatch unusable.
  const bad = [...tag2cl.keys(), ...ids].filter((token) => !SLUG.test(token)).sort();
  if (bad.length > 0) fail(`tag/key is not a clean lowercase-hyphen slug: ${bad.join(", ")}`);

  return { clusters, adjacency: parseAdjacency(doc.adjacency, new Set(ids)), version, corrections };
}

/** Symmetrises on read: the file lists each pair once, the stored JSON carries both directions. */
function parseAdjacency(value: unknown, keys: Set<string>): Map<string, Map<string, number>> {
  const symmetric = new Map<string, Map<string, number>>();
  for (const key of keys) symmetric.set(key, new Map());
  if (value === undefined) return symmetric;

  const adjacency = asRecord(value, "adjacency");
  const listed = new Map<string, number>();
  for (const hops of [1, 2]) {
    const raw = adjacency[`hops_${hops}`];
    if (raw === undefined) continue;
    for (const [i, pair] of asList(raw, `adjacency.hops_${hops}`).entries()) {
      const where = `adjacency.hops_${hops}[${i}]`;
      const [a, b] = asList(pair, where).map((end, j) => asString(end, `${where}[${j}]`));
      if (a === undefined || b === undefined) fail(`${where} must be a [a, b] pair`);
      if (!keys.has(a) || !keys.has(b)) fail(`${where} names an unknown cluster: ${a}-${b}`);
      if (a === b) fail(`${where} is a self-pair: ${a}`);
      const seen = listed.get(a < b ? `${a}|${b}` : `${b}|${a}`);
      if (seen !== undefined) fail(`${a}-${b} is listed twice (hop ${seen} and hop ${hops})`);
      listed.set(a < b ? `${a}|${b}` : `${b}|${a}`, hops);
      symmetric.get(a)!.set(b, hops);
      symmetric.get(b)!.set(a, hops);
    }
  }
  return symmetric;
}

/** Sorted keys, so an unchanged file serialises identically and the upsert stays a true no-op. */
function adjacencyJson(map: Map<string, number>): string {
  const out: Record<string, number> = {};
  for (const key of [...map.keys()].sort()) out[key] = map.get(key)!;
  return JSON.stringify(out);
}

/**
 * Applies the shipped taxonomy. **Idempotent** (`INSERT … ON CONFLICT DO UPDATE` guarded so a repeat
 * writes nothing), **forward-only** (it never deletes), and it refuses a **silent re-point** — a tag
 * that already maps elsewhere must be declared in `corrections`. Safe to call at every boot.
 */
export function seedDomainTaxonomy(db: SqliteConnection, path: string = TAXONOMY_PATH): void {
  const taxonomy = parseTaxonomy(readFileSync(path, "utf8"), path);
  const declared = new Set(
    taxonomy.corrections
      .filter((c) => c.kind === "repoint")
      .map((c) => `${c.tag}\u0000${c.from}\u0000${c.to}`),
  );

  writeTransaction(db, () => {
    const existing = new Map<string, string>();
    for (const row of db.prepare("SELECT tag, cluster_id FROM domain_map").all() as Array<{
      tag: string;
      cluster_id: string;
    }>) {
      existing.set(row.tag, row.cluster_id);
    }

    const upsertCluster = db.prepare(
      `INSERT INTO domain_cluster (id, name, adjacency) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, adjacency = excluded.adjacency
       WHERE domain_cluster.name IS NOT excluded.name
          OR domain_cluster.adjacency IS NOT excluded.adjacency`,
    );
    const upsertTag = db.prepare(
      `INSERT INTO domain_map (tag, cluster_id) VALUES (?, ?)
       ON CONFLICT(tag) DO UPDATE SET cluster_id = excluded.cluster_id
       WHERE domain_map.cluster_id IS NOT excluded.cluster_id`,
    );

    for (const cluster of taxonomy.clusters) {
      upsertCluster.run(
        cluster.id,
        cluster.name,
        adjacencyJson(taxonomy.adjacency.get(cluster.id)!),
      );
    }
    // Rule 4: each cluster's **key** — and only the key — is a tag in its own cluster, so the picker's
    // own value resolves by construction. The display name is a label, never vocabulary.
    for (const cluster of taxonomy.clusters) upsertTag.run(cluster.id, cluster.id);
    for (const cluster of taxonomy.clusters) {
      for (const tag of cluster.tags) {
        const owner = existing.get(tag);
        if (owner !== undefined && owner !== cluster.id) {
          if (!declared.has(`${tag}\u0000${owner}\u0000${cluster.id}`)) {
            fail(`re-point ${tag}: ${owner} -> ${cluster.id} is not declared in "corrections"`);
          }
        }
        upsertTag.run(tag, cluster.id);
      }
    }
  });
}
