import {
  MIGRATIONS,
  migrateAsync,
  openStoreAsync,
  seedDomainTaxonomyAsync,
  vaultSummary,
  type SqliteConnection,
  type VaultSummary,
} from "@astrolab/core";

import { openDatabase, type OpenedVault } from "./store/expoConnection";

/**
 * The composition root (`docs/ARCHITECTURE.md` v2 §1, plan invariant 4). This module is the only place
 * that knows *how* the app is put together: it opens the connection, applies `core`'s pragmas, runs
 * the migrations, applies the shipped taxonomy, and reads the one number the first screen turns on.
 * It holds **no business logic** — every rule it touches is a `core` function.
 *
 * The boot is **not a splash screen and does not await the engine** (§4.1): a read path never waits on
 * a run. `boot()` is thin — it awaits the async boot, then makes one synchronous read — and the only
 * decision it makes, which screen to open on, is extracted as {@link startScreen} so it can be asserted
 * without a database.
 *
 * ## Two channels, and where the seam is (#186)
 *
 * `openStore → migrate → seedDomainTaxonomy` are the boot's **writes** — the WAL conversion, DDL,
 * `COMMIT`/`ROLLBACK`, `PRAGMA user_version`, the seed's upserts. On web they fsync, and a *sync* call
 * answers inside `expo-sqlite`'s ~133 ms busy-wait only by luck (`docs/adr/0007-web-boot-async-channel.md`),
 * so they run on the **async** plane and are **awaited**. `vaultSummary` is a **read**, answers in a few
 * ms, and stays on the synchronous port — invariant 1's concurrency argument for reads is untouched.
 *
 * **Order is load-bearing twice over.** Pragmas before migrations (the `foreign_keys`-off rebuild depends
 * on them), the taxonomy after the schema that holds it — and the async boot must be **fully awaited
 * before the first sync read**, or a read races the writes it depends on. `vaultSummary(conn)` below is
 * that first sync read, and it is reached only after the three `await`s above it resolve;
 * `bootstrap.test.ts` pins the ordering with a boot held open mid-flight.
 *
 * **Out of scope here, recorded in the ADR:** `core/src/boot.ts`'s `bootVault` (migrate · seed ·
 * `seedGateConfig` · `requeueOrphanedRuns`) has no production caller — this root runs the first two steps
 * only, per the L2 plan's Task 1. #186 twins the steps that run today and does not widen the boot.
 */

/** The shell's first two screens: S0 onboarding and S1 the deck (`FLOW.md` §2.1). */
export type StartScreen = "S0" | "S1";

/**
 * S0 until the vault can spread, then S1 — read through the **shipped** predicate, not recomputed:
 * `vaultSummary` already answers `eligible` from `resolved_domains >= FLOOR` (`core/src/vault/vault-summary.ts`),
 * and `FLOW.md` §7 requires the S0 gate and the engine's E0 check to read the same quantity.
 */
export function startScreen(summary: VaultSummary): StartScreen {
  return summary.eligible ? "S1" : "S0";
}

/** What the shell holds for the session: the open connection and the screen it opens on. */
export interface Booted {
  conn: SqliteConnection;
  start: StartScreen;
}

/**
 * Opens the vault and brings the store up to the shipped schema, then decides the first screen.
 *
 * `open` is injected (default {@link openDatabase}) so the sequence can be driven in a test without
 * `expo-sqlite`; the production path is the default. It returns **both planes**, so the test can supply
 * a `node:sqlite` connection wrapped by `asAsyncConnection` and exercise the real sequence.
 */
export async function boot(open: () => Promise<OpenedVault> = openDatabase): Promise<Booted> {
  const { conn, async: plane } = await open();
  await openStoreAsync(plane);
  await migrateAsync(plane, MIGRATIONS);
  await seedDomainTaxonomyAsync(plane);
  return { conn, start: startScreen(vaultSummary(conn)) };
}
