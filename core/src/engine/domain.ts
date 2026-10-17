import type { SqliteConnection } from "../store/connection.js";

import {
  readClusterAdjacency,
  readClusters,
  readDomainMap,
  upsertDomainTag,
} from "../store/index.js";

import type { ClusterOption, TagNormalizer } from "../provider/index.js";

/**
 * Axis 1 — domain distance (`ARCHITECTURE.md` §3.2), deterministic and worker-only.
 *
 * The three steps, in order: **map** (each tag present in `domain_map` resolves with no AI),
 * **normalise** (an unmapped tag gets one AI call, written back into `domain_map` so it is paid once
 * per distinct tag), **distance** (taxonomy hops between the two ideas' clusters).
 *
 * ## Two readings of §3.2 the spec leaves open
 *
 * 1. **A set, not a tag.** §3.2 says each tag resolves to a cluster but never combines a set into one
 *    number. The rule here is **min hops over every cluster pair**, so `0` iff the two ideas share a
 *    cluster — the conservative, cliché-safe reading (a shared domain *might* be the obvious analogy,
 *    so it is left for the alignment axis to decide). One function, no interface; flip-able at W5's
 *    calibration.
 * 2. **An unlisted pair is `null`.** `domain_cluster.adjacency` lists `hops_1`/`hops_2` only, so a pair
 *    the table does not name has no measured distance. `null` means *"no path among the shipped
 *    hops"* — **never coerced to `0`** (which would read as same-domain → cliché → dropped, silently).
 *    W5's gate reads it as distant: `distance === null || distance >= min`, not `Number(distance)`.
 *
 * ## Cost posture
 *
 * The taxonomy (`domain_cluster` + its adjacency) is immutable after boot, so it is read **once**,
 * lazily, and memoised on this instance — the axis runs per pair, and re-parsing 28 rows per pair at
 * O(N²) is waste. `domain_map` **does** change (this module writes it), so it is read per call, which
 * is what makes a cache-back visible to the next call. A per-instance `tag → cluster` memo keeps one
 * instance's repeated tag from a second lookup.
 *
 * This is a **socket**: W5's gate calls `between`. It is not wired into the run loop (`queue.ts`) — the
 * default body stays `stubRunBody` until the gate consumes the axis, exactly as W3 left the cache.
 */

/**
 * The distance between two ideas' domain tags.
 *
 * `0` = the two ideas share a cluster; `1`/`2` = the listed hops; `null` = no listed path (≥ 3 hops or
 * unconnected), which the gate reads as distant.
 */
export interface DomainDistance {
  between(tagsA: readonly string[], tagsB: readonly string[]): Promise<number | null>;
}

export function createDomainDistance(
  db: SqliteConnection,
  normalizer: TagNormalizer,
): DomainDistance {
  let taxonomy: {
    clusters: ClusterOption[];
    adjacency: Map<string, Map<string, number>>;
  } | null = null;
  /** tag → cluster, for this instance — a repeat tag is not looked up (or normalised) twice. */
  const resolved = new Map<string, string>();

  function taxonomyOnce(): {
    clusters: ClusterOption[];
    adjacency: Map<string, Map<string, number>>;
  } {
    taxonomy ??= { clusters: readClusters(db), adjacency: readClusterAdjacency(db) };
    return taxonomy;
  }

  /** Each tag's cluster: `domain_map` first, then one normalisation written back (the cache). */
  async function clustersFor(tags: readonly string[]): Promise<Set<string>> {
    const { clusters } = taxonomyOnce();
    const unique = [...new Set(tags)];
    const mapped = readDomainMap(db, unique);

    const out = new Set<string>();
    for (const tag of unique) {
      let cluster = resolved.get(tag) ?? mapped.get(tag);
      if (cluster === undefined) {
        cluster = await normalizer.normalizeTag(tag, clusters);
        upsertDomainTag(db, tag, cluster);
      }
      resolved.set(tag, cluster);
      out.add(cluster);
    }
    return out;
  }

  return {
    async between(tagsA, tagsB) {
      const a = await clustersFor(tagsA);
      const b = await clustersFor(tagsB);
      if (a.size === 0 || b.size === 0) return null;

      const { adjacency } = taxonomyOnce();
      let best: number | null = null;
      for (const clusterA of a) {
        for (const clusterB of b) {
          const hops = clusterA === clusterB ? 0 : (adjacency.get(clusterA)?.get(clusterB) ?? null);
          if (hops === null) continue;
          if (best === null || hops < best) best = hops;
          if (best === 0) return 0;
        }
      }
      return best;
    },
  };
}
