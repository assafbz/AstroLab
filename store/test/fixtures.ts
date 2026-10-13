import type { Migration } from "../src/migrate.js";

/**
 * Fixture migrations shared by the boot test and its children. F2 ships the runner, not the schema —
 * `0001_init` is F3's — so the fixtures stand in for it.
 */
export const FIXTURE_MIGRATIONS: Migration[] = [
  { version: 1, name: "0001_init", sql: "CREATE TABLE idea (id TEXT PRIMARY KEY)" },
  {
    version: 2,
    name: "0002_add_status",
    sql: "ALTER TABLE idea ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'",
  },
];

export const FIXTURE_VERSION = FIXTURE_MIGRATIONS.at(-1)!.version;

/**
 * How long each child is spawned before the instant it is aimed at. Long enough for `node --import
 * tsx` to be up and waiting, so the race is between the statements and not between start-ups.
 */
export const BOOT_LEAD_MS = 1200;

/** The gap between the barrier at `openStore` and the barrier at `migrate`, for the boot test. */
export const MIGRATE_BARRIER_MS = 400;
