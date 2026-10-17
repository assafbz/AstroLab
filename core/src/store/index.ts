/**
 * The store's surface — the package's internals consume it by relative path (`../store/index.js`), and
 * the package entry re-exports it for the app (`core/src/index.ts`).
 *
 * `writeTransaction` is deliberately **not** on this surface. A caller outside the store that could
 * open its own transaction could write a vault table and skip the ARCH §4 stamp; with it unexported,
 * `vaultMutation` is the only transaction primitive the rest of `core/` can reach, so the mistake is a
 * compile error rather than a silent one. The store's own modules still import it by relative path.
 * `core/test/vault-writes.test.ts` fails if this export comes back.
 */
export {
  normalizeMiss,
  type SqlRow,
  type SqlRunResult,
  type SqlStatement,
  type SqlValue,
  type SqliteConnection,
} from "./connection.js";
export {
  newDomainFlag,
  readClusterAdjacency,
  readClusters,
  readClustersInSeedOrder,
  readDomainMap,
  upsertDomainTag,
  type ClusterOption,
} from "./domain-map.js";
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
} from "./config.js";
export { parseTaxonomy, seedDomainTaxonomy, TAXONOMY_PATH, type Taxonomy } from "./domain-seed.js";
export { isoTimestamp } from "./iso.js";
// The `idea_mechanism` cache writes directly, never through `vaultMutation` — it is derived state,
// not a vault table. The reason is in the module: `core/src/store/mechanism.ts`.
export { readDescriptors, upsertDescriptor, type IdeaMechanism } from "./mechanism.js";
// `suppressed_pair` is the same kind of table — not one of §4's four trigger tables — and it has two
// writers in two packages (the engine's noise, the vault's dismissal), so its SQL lives here too. The
// reasons, including why `CLICHE` has no writer, are in the module: `core/src/store/suppression.ts`.
export { clearSuppression, recordDismissal, recordNoise } from "./suppression.js";
export { migrate, schemaVersion, type Migration } from "./migrate.js";
export { MIGRATIONS, SCHEMA_VERSION } from "./migrations.js";
export { isBusyError, withRetry, type RetryOptions } from "./retry.js";
export {
  claimNextRun,
  currentVaultRevision,
  enqueueRun,
  finishRun,
  requeueOrphanedRuns,
  stampAndEnqueue,
  type RunStatus,
  type SparkRun,
} from "./runs.js";
export { openStore } from "./store.js";
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
} from "./sparks.js";
export { vaultMutation } from "./vault.js";
