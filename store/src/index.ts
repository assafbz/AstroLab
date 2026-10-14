export {
  readClusterAdjacency,
  readClusters,
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
// not a vault table. The reason is in the module: `store/src/mechanism.ts`.
export { readDescriptors, upsertDescriptor, type IdeaMechanism } from "./mechanism.js";
// `suppressed_pair` is the same kind of table — not one of §4's four trigger tables — and it has two
// writers in two packages (the engine's noise, the API's dismissal), so its SQL lives here too. The
// reasons, including why `CLICHE` has no writer, are in the module: `store/src/suppression.ts`.
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
// `writeTransaction` is deliberately **not** on this surface. A cross-package caller that could open
// its own transaction could write a vault table and skip the ARCH §4 stamp; with it unexported,
// `vaultMutation` is the only transaction primitive a package outside `store` can reach, so the
// mistake is a compile error rather than a silent one. The store's own modules still import it by
// relative path. `store/test/vault-writes.test.ts` fails if this export comes back.
export { openStore, type OpenStoreOptions } from "./store.js";
export { vaultMutation } from "./vault.js";
