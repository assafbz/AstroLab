import type { SqliteConnection } from "./store/connection.js";

import {
  MIGRATIONS,
  migrate,
  requeueOrphanedRuns,
  seedDomainTaxonomy,
  seedGateConfig,
} from "./store/index.js";

/**
 * The vault's boot — `migrate → seedDomainTaxonomy → seedGateConfig → requeueOrphanedRuns`, in one
 * place, on a connection the caller owns (`ARCHITECTURE.md` §2, §4; `ADR-0006`).
 *
 * v1 ran this sequence in two processes (the API's boot and the worker's), which is why #26 carried it
 * as a *duplicated* rule. There is one writer now — the app — so the sequence is one function, and a
 * caller that opened the connection still has to call it: the taxonomy must be seeded **before** any
 * engine read, or every domain reads *provisional* and provisional tags never open the spread gate
 * (§3.2 / R1).
 *
 * **The orphan requeue is the resume mechanism** (ADR-0004, invariant 16). A process killed mid-run
 * leaves its row `RUNNING`; the next boot returns it to `PENDING`, and the app's driver re-runs it.
 * That is safe because the run body is side-effect-free — it computes what to write and the commit
 * writes only for a still-current run (invariant 3) — so a re-run cannot double-offer.
 *
 * Seeding is **insert-only** (§3.4): a tuned threshold survives the restart; a snapshot would revert
 * it.
 */
export function bootVault(conn: SqliteConnection): void {
  migrate(conn, MIGRATIONS);
  seedDomainTaxonomy(conn);
  seedGateConfig(conn);
  requeueOrphanedRuns(conn);
}
