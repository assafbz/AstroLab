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
export {
  normalizeMiss,
  type SqlRow,
  type SqlRunResult,
  type SqlStatement,
  type SqlValue,
  type SqliteConnection,
} from "./store/connection.js";
export {
  newDomainFlag,
  readClusterAdjacency,
  readClusters,
  readDomainMap,
  upsertDomainTag,
  type ClusterOption,
} from "./store/domain-map.js";
// The gate thresholds (`ARCHITECTURE.md` §3.4). Like `idea_mechanism` / `domain_map`, these writes go
// directly (`withRetry`), never through `vaultMutation` — the reason is in the module.
export {
  GATE_CONFIG_DEFAULTS,
  InvalidConfigError,
  MIN_ALIGNMENT_KEY,
  MIN_DOMAIN_DISTANCE_KEY,
  readGateConfig,
  seedGateConfig,
  setConfig,
  type GateConfig,
} from "./store/config.js";
export {
  parseTaxonomy,
  seedDomainTaxonomy,
  TAXONOMY_PATH,
  type Taxonomy,
} from "./store/domain-seed.js";
export { isoTimestamp } from "./store/iso.js";
// The `idea_mechanism` cache writes directly, never through `vaultMutation` — it is derived state,
// not a vault table. The reason is in the module: `core/src/store/mechanism.ts`.
export { readDescriptors, upsertDescriptor, type IdeaMechanism } from "./store/mechanism.js";
// `suppressed_pair` is the same kind of table — not one of §4's four trigger tables — and it has two
// writers in two packages (the engine's noise, the vault's dismissal), so its SQL lives here too. The
// reasons, including why `CLICHE` has no writer, are in the module: `core/src/store/suppression.ts`.
export { clearSuppression, recordDismissal, recordNoise } from "./store/suppression.js";
export { migrate, schemaVersion, type Migration } from "./store/migrate.js";
export { MIGRATIONS, SCHEMA_VERSION } from "./store/migrations.js";
export { isBusyError, withRetry, type RetryOptions } from "./store/retry.js";
export {
  claimNextRun,
  currentVaultRevision,
  enqueueRun,
  finishRun,
  requeueOrphanedRuns,
  stampAndEnqueue,
  type RunStatus,
  type SparkRun,
} from "./store/runs.js";
// `writeTransaction` is deliberately **not** on this surface. A caller outside the package that could
// open its own transaction could write a vault table and skip the ARCH §4 stamp; with it unexported,
// `vaultMutation` is the only transaction primitive the app can reach, so the mistake is a compile
// error rather than a silent one. The package's own modules still import it by relative path.
// `core/test/vault-writes.test.ts` fails if this export comes back.
export { openStore } from "./store/store.js";
// The `spark` writes are the engine's, and like `domain_map` / `idea_mechanism` they are derived
// engine state: written directly, never through `vaultMutation` (`core/src/store/sparks.ts`).
// `liveOffers` is the read twin (the deck), and `LIVE_STATUS` is the one definition of "a live offer"
// that the writes, the read and the retraction/count all share. `sparkById` is the status-blind
// by-id sibling (the §4.12 detail, #118).
export {
  insertOfferedSparks,
  LIVE_STATUS,
  liveOffers,
  retractOffersOutside,
  sparkById,
  sparkForDecision,
  type DecisionSpark,
  type DetailSpark,
  type LiveSpark,
  type OfferedSpark,
  type SparkStatus,
} from "./store/sparks.js";
export { vaultMutation } from "./store/vault.js";
