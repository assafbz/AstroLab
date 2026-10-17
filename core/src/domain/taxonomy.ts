import type { SqliteConnection } from "../store/connection.js";
import { readClustersInSeedOrder } from "../store/index.js";

/**
 * S0's picker vocabulary — **the seeded `domain_cluster` rows, and nothing else** (`core/seed/README.md`,
 * curation rule 2; `ARCHITECTURE.md` §3.2 option a; plan invariant 7).
 *
 * v1 kept a **mirror** of the 28 clusters here, because the client could not reach the store: no
 * endpoint exposed the taxonomy, and `client` may not import `store`. That constraint retired with the
 * packages — the picker and the store are now the same package — so the copy is gone and the artifact
 * is the only source. What the copy was *for* still holds and is now structural:
 *
 * - **The value is the cluster `key`; the label is `name`.** The loader registers each cluster's key —
 *   and only the key — as a tag in its own cluster; the `name:` label is what S0 renders and is
 *   **never** written as a tag (normalising a label mints rows like `ai-&-ml`). A pick therefore
 *   **resolves by construction**, with no AI on the path (R1), which is what lets the salted `≥ 2`
 *   spread gate stay deterministic.
 * - **The order is the seed's order**, not a sort: it is the artifact's curated (six-family)
 *   presentation grouping, which is not stored as structure anywhere else. `readClustersInSeedOrder`
 *   carries that contract, including its `VACUUM` residual.
 *
 * Boot order is the caller's and is not optional: `migrate` → `seedDomainTaxonomy` → render S0. An
 * unseeded store has no vocabulary, and that is what {@link domainClusters} returns — an empty list,
 * never a built-in one.
 */

/** One seeded domain cluster, as S0 offers it. */
export interface DomainCluster {
  /** The picker's value — the tag the loader registers in `domain_map` (`ai-ml`). */
  key: string;
  /** The picker's label — display only, never written as a tag (`AI & ML`). */
  name: string;
}

/** The picker's list: the seeded clusters, in the seed's order. Empty before the seed has run. */
export function domainClusters(db: SqliteConnection): DomainCluster[] {
  return readClustersInSeedOrder(db).map((cluster) => ({ key: cluster.id, name: cluster.name }));
}
