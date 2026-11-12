import type { AsyncSqliteConnection, SqliteConnection } from "./store/connection.js";

import {
  MIGRATIONS,
  migrate,
  migrateAsync,
  requeueOrphanedRuns,
  requeueOrphanedRunsAsync,
  seedDomainTaxonomy,
  seedDomainTaxonomyAsync,
  seedGateConfig,
  seedGateConfigAsync,
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

/**
 * {@link bootVault} on the async channel (`#190`) — **the same four steps, in the same order, against
 * the same rules**, awaited. Same contract as its sync twin: it takes a connection the caller already
 * opened and applied the store's pragmas to (`openStore` / `openStoreAsync`), never a path, and it does
 * not own the adapter choice. Keeping the two signatures the same kind is what lets `#190`'s parity suite
 * drive both over one fixture and require an identical database.
 *
 * ## Why the app boot needs this twin
 *
 * On web, `expo-sqlite` implements a **sync** call as a main-thread busy-wait with a hard ~133 ms budget,
 * and every one of these four steps is a **write** — DDL, `COMMIT`/`ROLLBACK`, `PRAGMA user_version`, the
 * seed upserts, the requeue `UPDATE` — that fsyncs past it on a cold worker, so a cold load died with
 * `Sync operation timeout` (measured: 18 red / 19 loads). The async plane posts `isSync: false` and
 * awaits, with no cap, so the hazard is **removed rather than won**
 * (`docs/adr/0007-web-boot-async-channel.md`; `#186` moved the first three steps, `#190` moves the rest).
 *
 * ## What the twin is not
 *
 * It is not a re-implementation: every step is the async twin of a `core` rule — `migrateAsync` ·
 * `seedDomainTaxonomyAsync` · `seedGateConfigAsync` · `requeueOrphanedRunsAsync` — and the shared
 * definitions (migration ordering, the seed's SQL, the requeue's SQL, the transaction shell) are named
 * once and used by both channels. The duplication that remains is the two imperative shells, and it is
 * **guarded, not asserted**: `core/test/vault-boot-async.test.ts` drives `bootVault` and `bootVaultAsync`
 * over the same fixtures and requires an identical database (`migrate-parity.test.ts` is the pattern).
 *
 * `bootVault` itself stays **sync** for tests, scripts and CI — the device's steady state, and the only
 * channel `scripts/w9-calibrate.ts` uses.
 */
export async function bootVaultAsync(conn: AsyncSqliteConnection): Promise<void> {
  await migrateAsync(conn, MIGRATIONS);
  await seedDomainTaxonomyAsync(conn);
  await seedGateConfigAsync(conn);
  await requeueOrphanedRunsAsync(conn);
}
