export { parseTaxonomy, seedDomainTaxonomy, TAXONOMY_PATH, type Taxonomy } from "./domain-seed.js";
export { isoTimestamp } from "./iso.js";
// The `idea_mechanism` cache writes directly, never through `vaultMutation` — it is derived state,
// not a vault table. The reason is in the module: `store/src/mechanism.ts`.
export { readDescriptors, upsertDescriptor, type IdeaMechanism } from "./mechanism.js";
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
