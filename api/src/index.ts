import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { migrate, MIGRATIONS, openStore } from "@astrolab/store";

import { createApp } from "./server.js";

const dbPath = process.env.DB_PATH ?? "./data/astrolab.sqlite";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

// V1 (#12) opens the store: one file, opened through `openStore` so the WAL + busy_timeout + retry
// posture is the store's, not a second boot site's (store/README.md), then brought up to the schema.
const db = openStore(dbPath);
migrate(db, MIGRATIONS);

const port = Number(process.env.API_PORT ?? 8080);

createApp({ db }).listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
