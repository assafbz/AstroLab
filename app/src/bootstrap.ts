import {
  bootVaultAsync,
  openStoreAsync,
  vaultSummary,
  type SqliteConnection,
  type VaultSummary,
} from "@astrolab/core";

import { openDatabase, type OpenedVault } from "./store/expoConnection";

/**
 * The composition root (`docs/ARCHITECTURE.md` v2 §1, plan invariant 4). This module is the only place
 * that knows *how* the app is put together: it opens the connection, applies `core`'s pragmas, runs
 * `core`'s boot, and reads the one number the first screen turns on. It holds **no business logic** —
 * every rule it touches is a `core` function.
 *
 * The boot is **not a splash screen and does not await the engine** (§4.1): a read path never waits on
 * a run. `boot()` is thin — it awaits the async boot, then makes one synchronous read — and the only
 * decision it makes, which screen to open on, is extracted as {@link startScreen} so it can be asserted
 * without a database.
 *
 * ## The boot is `core`'s, not this file's (#190)
 *
 * `boot()` applies the store's pragmas and then calls **one** `core` entry, `bootVaultAsync` — the async
 * twin of `bootVault`, which is the sequence `migrate → seedDomainTaxonomy → seedGateConfig →
 * requeueOrphanedRuns`. This file used to inline the first two of those steps, which silently skipped
 * the other two: the gate thresholds were never seeded, and a `RUNNING` run left by a killed process was
 * never requeued, so ADR-0004's resume path was dead the moment L3 wired the driver (#190). Both now run
 * on every boot, and `seedGateConfig` and `requeueOrphanedRuns` cannot be skipped again without a red
 * test: `app/src/store/boot-async-plane.test.ts` fails if a shipped `app/` module names a boot step.
 *
 * ## Two channels, and where the seam is (#186)
 *
 * `openStoreAsync` + `bootVaultAsync` are the boot's **writes** — the WAL conversion, DDL,
 * `COMMIT`/`ROLLBACK`, `PRAGMA user_version`, the seed's upserts, the requeue. On web they fsync, and a
 * *sync* call answers inside `expo-sqlite`'s ~133 ms busy-wait only by luck
 * (`docs/adr/0007-web-boot-async-channel.md`), so they run on the **async** plane and are **awaited**.
 * `vaultSummary` is a **read**, answers in a few ms, and stays on the synchronous port — invariant 1's
 * concurrency argument for reads is untouched.
 *
 * `openStoreAsync` is the one boot step this file names, and deliberately so: applying the pragmas is
 * the **opener's** half on both channels (`openNodeStore` is `openNodeConnection` + `openStore` for the
 * same reason), so `bootVaultAsync`'s contract matches `bootVault`'s — a caller supplies an open,
 * pragma-applied connection — and the two can be driven over one fixture by `core`'s parity suite.
 *
 * **Order is load-bearing twice over.** Pragmas before migrations (the `foreign_keys`-off rebuild depends
 * on them), the taxonomy after the schema that holds it — and the async boot must be **fully awaited
 * before the first sync read**, or a read races the writes it depends on. `vaultSummary(conn)` below is
 * that first sync read, and it is reached only after the `await`s above it resolve; `bootstrap.test.ts`
 * pins the ordering with a boot held open mid-flight.
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
 * Opens the vault, brings it up through `core`'s boot, then decides the first screen.
 *
 * `open` is injected (default {@link openDatabase}) so the sequence can be driven in a test without
 * `expo-sqlite`; the production path is the default. It returns **both planes**, so the test can supply
 * a `node:sqlite` connection wrapped by `asAsyncConnection` and exercise the real sequence.
 */
export async function boot(open: () => Promise<OpenedVault> = openDatabase): Promise<Booted> {
  const { conn, async: plane } = await open();
  await openStoreAsync(plane);
  await bootVaultAsync(plane);
  return { conn, start: startScreen(vaultSummary(conn)) };
}
