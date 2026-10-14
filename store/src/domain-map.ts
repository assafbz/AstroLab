import type { DatabaseSync } from "node:sqlite";

import { withRetry } from "./retry.js";

/**
 * The domain vocabulary's SQL (`ARCHITECTURE.md` §2.4, §3.2 steps 1–2) — the reads Axis 1 makes, and
 * the one write it makes: the cached normalisation of a provisional tag.
 *
 * It lives in `store`, beside `mechanism.ts`, for the same reason: the write is reached from the
 * worker and its reads are shared, so the SQL lives above both packages rather than behind a new
 * `api → worker` edge.
 *
 * ## The write is non-stamping, deliberately
 *
 * `upsertDomainTag` writes directly (`withRetry`), never through `vaultMutation`. `domain_map` is not
 * one of §4's trigger tables (`idea` / `idea_version` / `provenance_edge` / `decision`), and the vault
 * summary reads it **live** — a stamp would advance `vault_meta.revision` inside the run writing it
 * and make that run discard its own outcome. This is the `idea_mechanism` exception (Max's #78 ruling).
 *
 * ## No producer hash on the row
 *
 * Unlike `idea_mechanism.source_hash`, a `domain_map` row carries `tag` + `cluster_id` only. A
 * normaliser **prompt or model** change therefore does **not** re-normalise existing rows: the only
 * correction path is a seed `corrections` entry (`domain-seed.ts` fails loudly on an undeclared
 * re-point). W9's calibration should know a prompt bump is not a re-normalisation.
 *
 * `ClusterOption` is deliberately declared here too (not imported from `provider/types.ts`): `store`
 * must keep no path to the AI boundary (`provider/boundary.test.ts`, NFR-A1), and the two shapes are
 * structurally identical, so an engine hands one straight to the other.
 */

/** One cluster as the engine offers it to the normaliser (`§2.4`; the `domain_cluster` row). */
export interface ClusterOption {
  id: string;
  name: string;
}

/** The shipped clusters, sorted by id — a stable, deterministic set to offer the normaliser. */
export function readClusters(db: DatabaseSync): ClusterOption[] {
  // Cast the rows to an inline type literal (which gets an implicit index signature) and map, rather
  // than casting to `ClusterOption[]` (an interface has none — `mechanism.ts`'s row-shape note).
  const rows = db.prepare("SELECT id, name FROM domain_cluster ORDER BY id ASC").all() as Array<{
    id: string;
    name: string;
  }>;
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/**
 * The symmetrised hop map: `cluster id → {other cluster id: hops}`. The seed file lists each pair
 * once and `domain-seed.ts` writes both directions into `adjacency`; this reads that JSON back, one
 * parse per row.
 */
export function readClusterAdjacency(db: DatabaseSync): Map<string, Map<string, number>> {
  const adjacency = new Map<string, Map<string, number>>();
  const rows = db.prepare("SELECT id, adjacency FROM domain_cluster").all() as Array<{
    id: string;
    adjacency: string;
  }>;
  for (const row of rows) {
    adjacency.set(
      row.id,
      new Map(Object.entries(JSON.parse(row.adjacency) as Record<string, number>)),
    );
  }
  return adjacency;
}

/** The mapped clusters for these tags — only the tags that resolve. An empty id list reads nothing. */
export function readDomainMap(db: DatabaseSync, tags: readonly string[]): Map<string, string> {
  if (tags.length === 0) return new Map();
  const placeholders = tags.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT tag, cluster_id FROM domain_map WHERE tag IN (${placeholders})`)
    .all(...tags) as Array<{ tag: string; cluster_id: string }>;
  return new Map(rows.map((row) => [row.tag, row.cluster_id]));
}

/**
 * Write (or replace) one tag's cluster — idempotent, keyed by the **exact raw tag**. Never lower-cased
 * or trimmed here: `ARCHITECTURE.md` §3.2 stores the tag raw and the worker "writes that exact
 * spelling back", which is the invariant the S3 filter and the vault summary's exact match both rest
 * on. The conflict guard makes a repeat a true no-op and a genuine re-point a one-row update.
 */
export function upsertDomainTag(db: DatabaseSync, tag: string, clusterId: string): void {
  withRetry(() =>
    db
      .prepare(
        `INSERT INTO domain_map (tag, cluster_id) VALUES (?, ?)
         ON CONFLICT(tag) DO UPDATE SET cluster_id = excluded.cluster_id
         WHERE domain_map.cluster_id IS NOT excluded.cluster_id`,
      )
      .run(tag, clusterId),
  );
}
