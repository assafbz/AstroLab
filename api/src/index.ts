import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  migrate,
  MIGRATIONS,
  openStore,
  seedDomainTaxonomy,
  seedGateConfig,
} from "@astrolab/store";

import { createApp } from "./server.js";

const dbPath = process.env.DB_PATH ?? "./data/astrolab.sqlite";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

// V1 (#12) opens the store: one file, opened through `openStore` so the WAL + busy_timeout + retry
// posture is the store's, not a second boot site's (store/README.md), then brought up to the schema.
const db = openStore(dbPath);
migrate(db, MIGRATIONS);
// O1 (#21): the seed taxonomy is data the loader applies at boot — idempotent and forward-only, so a
// second boot is a no-op, and `domain_map` is populated before the first gate reads it.
seedDomainTaxonomy(db);
// W5 (#30): the gate thresholds are seeded here too, insert-only — a tuned value survives every boot
// (§3.4). Both boots seed them, so neither process can boot without config.
seedGateConfig(db);

// K1 (#35): the SSE stream samples `PRAGMA data_version` on a **second, read-only** handle to the
// same file (api/src/spark-events.ts; docs/API.md §4.11). A connection is blind to its own commit, so
// a watcher on `db` would miss every change the API makes — §4.16's run enqueue and every
// `vaultMutation`. `:memory:` is a test-only path (a second handle there is a *different* database),
// so the sampler falls back to `db`; the shipped default (`DB_PATH`) is a file.
const watchDb = dbPath === ":memory:" ? db : openStore(dbPath);

const port = Number(process.env.API_PORT ?? 8080);

createApp({ db, watchDb }).listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
