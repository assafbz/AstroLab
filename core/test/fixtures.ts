import type { Migration } from "../src/store/migrate.js";

/**
 * Fixture migrations shared by the store's boot tests. These exercise the *runner* with a two-step
 * change; F3's real `0001_init` is `../src/store/migrations.js` and is boot-tested alongside them.
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
