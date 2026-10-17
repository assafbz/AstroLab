/**
 * `core/` — everything portable: the store, the vault use-cases, the domain modules and the engine,
 * consumed by the Expo app and compiled by `tsc` (`ARCHITECTURE.md` §1, §2;
 * `docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md`).
 *
 * Two rules hold for this surface. The **device supplies the engine**: the port's types are exported
 * and the `node:sqlite` adapter deliberately is not, so the app bundle cannot reach it
 * (`core/test/boundary-node-adapter.test.ts`). And the **composition root is the app**: it opens the
 * connection, the key store and the engine driver, and hands them in.
 */
export * from "./store/index.js";
