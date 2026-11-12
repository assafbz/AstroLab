import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  asAsyncConnection,
  type AsyncSqliteConnection,
  type SqliteConnection,
} from "./connection.js";
import { openNodeStore } from "./connection.node.js";
import { DOMAIN_TAXONOMY_TEXT } from "../seed/domain-taxonomy.js";
import { migrate, migrateAsync, schemaVersion, type Migration } from "./migrate.js";
import { seedDomainTaxonomy, seedDomainTaxonomyAsync } from "./domain-seed.js";
import { MIGRATIONS } from "./migrations.js";
import { openStore, openStoreAsync } from "./store.js";

/**
 * The guard for the **two channels** (#186, `docs/adr/0007-web-boot-async-channel.md`).
 *
 * `migrate` and `migrateAsync` share every rule *decision* (ordering, the duplicate-version check, the
 * forward-only guard, the in-transaction re-read) but are two imperative shells around the transaction —
 * the honest cost of keeping the port synchronous. This test is what makes the duplication safe: it
 * drives **both channels over the same fixtures** and asserts the resulting database is identical, so a
 * rule that lands in one shell and not the other is a red test rather than a divergence a reviewer has
 * to spot.
 *
 * Scope, named precisely: **identical `sqlite_master` (type · name · `sql`), identical `user_version`,
 * identical seed row counts and rows**, and identical *refusals* (same error, same message). `node:sqlite`
 * is synchronous, so the async plane is `asAsyncConnection` — the rules are channel-independent, so that
 * is the right fixture: only the transport differs between this and the web app.
 */

const dirs: string[] = [];
function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-parity-"));
  dirs.push(dir);
  return join(dir, "astrolab.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REBUILD_FIXTURES: Migration[] = [
  {
    version: 1,
    name: "0001_parent",
    sql: "CREATE TABLE parent (id TEXT PRIMARY KEY)",
  },
  {
    version: 2,
    name: "0002_child",
    // A real foreign key, so a rebuild below has something to preserve (and to check).
    sql: `CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE RESTRICT);
          INSERT INTO parent (id) VALUES ('p1');
          INSERT INTO child (id, parent_id) VALUES ('c1', 'p1');`,
  },
  {
    version: 3,
    name: "0003_child_cascade",
    // create-new → copy → drop-old → rename, changing the FK action — the `rebuildReferences` dance,
    // including `PRAGMA foreign_keys = OFF` outside the transaction and `foreign_key_check` inside it.
    rebuildReferences: true,
    sql: `CREATE TABLE child_new (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
          INSERT INTO child_new (id, parent_id) SELECT id, parent_id FROM child;
          DROP TABLE child;
          ALTER TABLE child_new RENAME TO child;`,
  },
];

/** The database's structural identity: every object type, name and the `sql` that created it. */
function schemaDump(db: SqliteConnection): unknown[] {
  return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
}

function seedRows(db: SqliteConnection): unknown[] {
  return db
    .prepare("SELECT tag, cluster_id FROM domain_map ORDER BY tag")
    .all()
    .concat(db.prepare("SELECT id, name, adjacency FROM domain_cluster ORDER BY id").all());
}

test("migrate and migrateAsync land on an identical schema, including a rebuild (FK rewrite)", async () => {
  const sync = openNodeStore(tempStorePath());
  const async = openNodeStore(tempStorePath());
  try {
    expect(migrate(sync, REBUILD_FIXTURES)).toBe(3);
    expect(schemaVersion(sync)).toBe(3);
    // Non-vacuity: the rebuild really happened — the FK action is CASCADE, not the RESTRICT it replaced.
    const childSql = schemaDump(sync).find((row) => (row as { name: string }).name === "child") as {
      sql: string;
    };
    expect(childSql.sql).toContain("CASCADE");
    // …and its rows survived the create-new/copy/drop/rename.
    expect(sync.prepare("SELECT id, parent_id FROM child").all()).toEqual([
      { id: "c1", parent_id: "p1" },
    ]);

    expect(await migrateAsync(asAsyncConnection(async), REBUILD_FIXTURES)).toBe(3);

    expect(schemaDump(async)).toEqual(schemaDump(sync));
    expect(schemaVersion(async)).toBe(schemaVersion(sync));
  } finally {
    sync.close();
    async.close();
  }
});

test("migrate and migrateAsync run the shipped migrations to the same version and schema", async () => {
  const sync = openNodeStore(tempStorePath());
  const async = openNodeStore(tempStorePath());
  try {
    expect(migrate(sync, MIGRATIONS)).toBe(sync.prepare("PRAGMA user_version").get()?.user_version);
    expect(await migrateAsync(asAsyncConnection(async), MIGRATIONS)).toBe(
      sync.prepare("PRAGMA user_version").get()?.user_version,
    );
    expect(schemaDump(async)).toEqual(schemaDump(sync));
    // A migration that writes data (e.g. `vault_meta`) must land identically on both channels.
    expect(async.prepare("SELECT * FROM vault_meta").all()).toEqual(
      sync.prepare("SELECT * FROM vault_meta").all(),
    );
  } finally {
    sync.close();
    async.close();
  }
});

test("seedDomainTaxonomy and its async twin write the same rows", async () => {
  const sync = openNodeStore(tempStorePath());
  const async = openNodeStore(tempStorePath());
  try {
    migrate(sync, MIGRATIONS);
    migrate(async, MIGRATIONS);
    seedDomainTaxonomy(sync);
    await seedDomainTaxonomyAsync(asAsyncConnection(async));

    const rows = seedRows(sync);
    // Non-vacuity: the seed wrote a real body of rows, or "equal" would be trivially true.
    expect(rows.length).toBeGreaterThan(200);
    expect(seedRows(async)).toEqual(rows);

    // And the whole async boot (`openStoreAsync → migrateAsync → seedDomainTaxonomyAsync`) matches the
    // sync one — the sequence `app/src/bootstrap.ts` runs, on both channels.
    const bootSync = openNodeStore(tempStorePath());
    const bootAsync = openNodeStore(tempStorePath());
    try {
      openStore(bootSync);
      const plane: AsyncSqliteConnection = asAsyncConnection(bootAsync);
      await openStoreAsync(plane);
      migrate(bootSync, MIGRATIONS);
      await migrateAsync(plane, MIGRATIONS);
      seedDomainTaxonomy(bootSync);
      await seedDomainTaxonomyAsync(plane);
      expect(schemaDump(bootAsync)).toEqual(schemaDump(bootSync));
      expect(seedRows(bootAsync)).toEqual(seedRows(bootSync));
      expect(bootAsync.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    } finally {
      bootSync.close();
      bootAsync.close();
    }
  } finally {
    sync.close();
    async.close();
  }
});

test("both channels refuse a newer store with the same error", async () => {
  const sync = openNodeStore(tempStorePath());
  const async = openNodeStore(tempStorePath());
  try {
    migrate(sync, REBUILD_FIXTURES);
    migrate(async, REBUILD_FIXTURES);
    const older: Migration[] = [REBUILD_FIXTURES[0]!];

    let syncError: unknown;
    try {
      migrate(sync, older);
    } catch (err) {
      syncError = err;
    }
    await expect(migrateAsync(asAsyncConnection(async), older)).rejects.toThrow(
      (syncError as Error).message,
    );
  } finally {
    sync.close();
    async.close();
  }
});

test("both channels reject a duplicate migration version with the same error", async () => {
  const sync = openNodeStore(tempStorePath());
  const async = openNodeStore(tempStorePath());
  const dup: Migration[] = [
    { version: 1, name: "a", sql: "CREATE TABLE a (id TEXT)" },
    { version: 1, name: "b", sql: "CREATE TABLE b (id TEXT)" },
  ];
  try {
    let syncError: unknown;
    try {
      migrate(sync, dup);
    } catch (err) {
      syncError = err;
    }
    expect(syncError).toBeInstanceOf(Error);
    await expect(migrateAsync(asAsyncConnection(async), dup)).rejects.toThrow(
      (syncError as Error).message,
    );
    // The duplicate check runs before any statement: neither channel created a table.
    expect(sync.prepare("SELECT name FROM sqlite_master WHERE name IN ('a','b')").all()).toEqual(
      [],
    );
    expect(async.prepare("SELECT name FROM sqlite_master WHERE name IN ('a','b')").all()).toEqual(
      [],
    );
  } finally {
    sync.close();
    async.close();
  }
});

test("the fixture taxonomy text is the one the seeder reads by default", () => {
  // The parity above is only meaningful against the shipped seed.
  expect(typeof DOMAIN_TAXONOMY_TEXT).toBe("string");
  expect(DOMAIN_TAXONOMY_TEXT.length).toBeGreaterThan(1000);
});
