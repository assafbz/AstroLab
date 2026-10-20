import {
  MIGRATIONS,
  migrate,
  openStore,
  seedDomainTaxonomy,
  vaultSummary,
  type SqliteConnection,
  type VaultSummary,
} from "@astrolab/core";

import { openDatabase } from "./store/expoConnection";

/**
 * The composition root (`docs/ARCHITECTURE.md` v2 §1, plan invariant 4). This module is the only place
 * that knows *how* the app is put together: it opens the connection, applies `core`'s pragmas, runs
 * the migrations, applies the shipped taxonomy, and reads the one number the first screen turns on.
 * It holds **no business logic** — every rule it touches is a `core` function.
 *
 * The boot is **not a splash screen and does not await the engine** (§4.1): a read path never waits on
 * a run. `boot()` is deliberately synchronous and thin, and the only decision it makes — which screen
 * to open on — is extracted as {@link startScreen} so it can be asserted without a database.
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
 * `expo-sqlite`; the production path is the default. Order is load-bearing: pragmas before migrations
 * (a `foreign_keys`-off rebuild depends on them) and the taxonomy after the schema that holds it.
 */
export function boot(open: () => SqliteConnection = openDatabase): Booted {
  const conn = open();
  openStore(conn);
  migrate(conn, MIGRATIONS);
  seedDomainTaxonomy(conn);
  return { conn, start: startScreen(vaultSummary(conn)) };
}
