import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  MIGRATIONS,
  migrate,
  openStore,
  requeueOrphanedRuns,
  seedDomainTaxonomy,
} from "@astrolab/store";

/**
 * The worker's boot — deliberately the **same sequence as the API** (`api/src/index.ts`):
 * `openStore → migrate → seedDomainTaxonomy`. That carry (#26, flagged by Ari on PR #68 / O1 #21) is
 * why the engine can never read an unseeded `domain_map` on a box where the API has not booted: a
 * taxonomy-less `domain_map` would make every domain read *provisional*, and provisional tags never
 * open the spread gate (`ARCHITECTURE.md` §3.2 / R1).
 *
 * Then `requeueOrphanedRuns`: a run a crashed process left `RUNNING` is returned to `PENDING`
 * (ADR-0004 — *"a restart simply re-enqueues"*).
 */
export function bootWorker(
  dbPath: string = process.env.DB_PATH ?? "./data/astrolab.sqlite",
): DatabaseSync {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

  // Opened through `openStore`, never a bare `new DatabaseSync` — the WAL + busy_timeout + retry
  // posture is the store's, and a second boot site must not reintroduce the fresh-file WAL race
  // (store/README.md).
  const db = openStore(dbPath);
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
  requeueOrphanedRuns(db);
  return db;
}
