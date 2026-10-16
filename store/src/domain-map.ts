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
 * The new-domain instrument — EV1 `#43` (`PRD.md` §5 / NFR-Q1: *"of the sparks accepted, how many
 * landed in a new domain"*). One question, asked **at the write**: does this domain set reach a domain
 * the vault **did not already carry**?
 *
 * ## A domain's identity is the vault's own rule, not a second one
 *
 * A domain is the **cluster** (`docs/API.md:119` — *"`#fintech` + `#banking` are **one** domain"*), and
 * the vault already counts coverage that way: `SUMMARY_SQL` (`api/src/vault-summary.ts`) reads
 * `COUNT(DISTINCT m.cluster_id)`, with an unmapped tag counted as **its own cluster** (provisional).
 * The identity used here is that same expression — `COALESCE(domain_map.cluster_id, <the tag>)` — so
 * the instrument cannot disagree with the readout it feeds. A tag in `domain_map` therefore resolves
 * identically for every row (the map is keyed by the exact raw tag, §3.2), and a tag the vocabulary
 * has not seen is its own domain until the worker writes it back.
 *
 * Consequence, stated deliberately: a **typed** fresh tag counts as a widening at the write. `NULL`-ing
 * it instead would hide exactly the widening the flywheel wants, and the worker's later normalisation
 * can only collapse a provisional tag into a cluster that some row already carried — never split one.
 *
 * ## Why the write, and not report time
 *
 * The answer is a fact about the vault **at that instant** and is not recomputable later: the vault is
 * append-and-iterate, so a later idea carrying the same domain changes it, and the worker's `domain_map`
 * write-back moves a provisional tag's identity. NFR-Q1's verification is *"instrumentation +
 * reporting"*, so the flag is **stored** by the writes that can widen (§4.2 capture, §4.7 fork, §4.6
 * iterate) and read back by month — never re-derived from the current vault.
 *
 * ## The comparison is the vault *before* the write
 *
 * The flag answers *"did this write widen the vault?"*, so the domain set is compared against the vault
 * **as it stood at that moment** — callers compute it before their `INSERT`/`UPDATE`, never after. That
 * is what makes the rule the same one for all three writers, and it is what the plan's parenthetical
 * ("a re-save of its own domain is not a widening") actually requires: for §4.6's iterate — the one
 * writer whose row already exists — the row's **own current tags are part of the coverage being
 * compared against**, because they are exactly what the vault already carried. Ignoring them would
 * report a plain text-only re-save as a widening whenever no *other* row happened to share that domain
 * (measured 2026-10-16; the store suite pins the case), which is the false positive this shape removes.
 * For the two `INSERT` paths the distinction cannot arise: the row is not in the table yet.
 *
 * Returns the column's value, `0 | 1`. `NULL` ("not recorded") is never returned: it is the *absence*
 * of a write, and only §4.13's ACCEPT leaves one — its root's tags are the source pair's union, drawn
 * from rows that already exist, so the reading there is constant-false by construction and a stored
 * `0` would be a measurement where there is none to make.
 */
const NEW_DOMAIN_SQL = `WITH other_domains(cluster) AS (
  SELECT COALESCE(m.cluster_id, j.value) AS cluster
    FROM idea AS i, json_each(i.domain_tags) AS j
    LEFT JOIN domain_map AS m ON m.tag = j.value
)
SELECT EXISTS (
  SELECT 1
    FROM json_each(?) AS j
    LEFT JOIN domain_map AS m ON m.tag = j.value
   WHERE NOT EXISTS (
           SELECT 1 FROM other_domains o WHERE o.cluster IS COALESCE(m.cluster_id, j.value)
         )
) AS is_new`;

/**
 * The `idea.new_domain` value (`0006`, `SCHEMA.md` §1e) for a write of `domainTags`: `1` iff at least
 * one domain it reaches is carried by **no row the vault already holds**, else `0`. One statement, so
 * the "carried" set and the question are a single read snapshot; the comparison is `IS` (null-safe)
 * rather than `=`, so a row whose `domain_tags` carried a JSON `null` cannot poison it into a false
 * "not new".
 *
 * **Call it before the write** — for §4.6's iterate that is load-bearing (see above), and it is the
 * only order in which the question has an answer.
 */
export function newDomainFlag(db: DatabaseSync, domainTags: readonly string[]): 0 | 1 {
  const row = db.prepare(NEW_DOMAIN_SQL).get(JSON.stringify(domainTags)) as { is_new: number };
  return row.is_new === 1 ? 1 : 0;
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
