/**
 * `core/` — everything portable, consumed by the Expo app and compiled by `tsc`
 * (`ARCHITECTURE.md` §1, §2; `docs/superpowers/plans/2026-10-17-l1-l4-local-only-rebuild.md`).
 *
 * One rule holds for this surface and nothing else needs to be said about it: the device supplies the
 * engine. The port's types are exported; the `node:sqlite` adapter is deliberately **not**, so the
 * app bundle cannot reach it (`core/test/boundary-node-adapter.test.ts`).
 */
export {
  normalizeMiss,
  type SqlRow,
  type SqlRunResult,
  type SqlStatement,
  type SqlValue,
  type SqliteConnection,
} from "./store/connection.js";
