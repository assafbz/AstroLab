// A process that boots the store at a synchronized instant, so a test can make two of them race.
// usage: boot.ts <db-path> <start-at-epoch-ms> <open|open-migrate> [fixture|real]
import { migrate } from "../src/migrate.js";
import { MIGRATIONS } from "../src/migrations.js";
import { openStore } from "../src/store.js";
import { FIXTURE_MIGRATIONS, MIGRATE_BARRIER_MS } from "./fixtures.js";
import { sleepUntil } from "./harness.js";

const [path, startAtRaw, mode, which = "fixture"] = process.argv.slice(2);
if (!path || !startAtRaw || (mode !== "open" && mode !== "open-migrate")) {
  throw new Error(
    "usage: boot.ts <db-path> <start-at-epoch-ms> <open|open-migrate> [fixture|real]",
  );
}
const startAt = Number(startAtRaw);
// `real` runs F3's shipped `0001_init`; `fixture` is F2's two-step stand-in for the runner.
const migrations = which === "real" ? MIGRATIONS : FIXTURE_MIGRATIONS;

// Barrier 1: both children reach `openStore` together — the WAL conversion is the race.
sleepUntil(startAt);
try {
  const db = openStore(path);
  if (mode === "open-migrate") {
    // Barrier 2: aim at the migrate step itself, which is where the second race lives.
    sleepUntil(startAt + MIGRATE_BARRIER_MS);
    migrate(db, migrations);
  }
  db.close();
  console.log(`${mode} ok`);
} catch (err) {
  console.error(`${mode} FAIL ${(err as Error).message}`);
  process.exit(1);
}
