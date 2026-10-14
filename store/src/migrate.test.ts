import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { migrate, schemaVersion, type Migration } from "./migrate.js";
import { openStore } from "./store.js";

const dirs: string[] = [];
function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-migrate-"));
  dirs.push(dir);
  return join(dir, "astrolab.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// F2 ships the runner, not the schema: these fixtures exercise it with a two-step change. F3's real
// `0001_init` is in `../src/migrations.js`.
const FIXTURES: Migration[] = [
  { version: 1, name: "0001_init", sql: "CREATE TABLE idea (id TEXT PRIMARY KEY)" },
  {
    version: 2,
    name: "0002_add_status",
    sql: "ALTER TABLE idea ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'",
  },
];

test("applies pending migrations in order and records the version", () => {
  const db = openStore(tempStorePath());
  try {
    expect(schemaVersion(db)).toBe(0);
    expect(migrate(db, FIXTURES)).toBe(2);
    expect(schemaVersion(db)).toBe(2);
    db.exec("INSERT INTO idea (id) VALUES ('i1')");
    expect(db.prepare("SELECT status FROM idea WHERE id = 'i1'").get()?.status).toBe("ACTIVE");
  } finally {
    db.close();
  }
});

test("is a no-op when the store is already current", () => {
  const path = tempStorePath();
  const first = openStore(path);
  migrate(first, FIXTURES);
  first.close();

  const second = openStore(path);
  try {
    expect(migrate(second, FIXTURES)).toBe(2);
  } finally {
    second.close();
  }
});

test("is forward-only: an already-applied migration is not re-run", () => {
  const db = openStore(tempStorePath());
  try {
    migrate(db, FIXTURES);
    // Re-running the v1 DDL would fail with "table idea already exists" if the version filter leaked.
    migrate(db, FIXTURES);
    expect(schemaVersion(db)).toBe(2);
  } finally {
    db.close();
  }
});

test("rolls a failing migration back, leaving the previous version", () => {
  const db = openStore(tempStorePath());
  try {
    migrate(db, [FIXTURES[0]!]);
    const broken: Migration = {
      version: 2,
      name: "0002_broken",
      sql: "CREATE TABLE ok (id TEXT); NOT SQL AT ALL;",
    };
    expect(() => migrate(db, [FIXTURES[0]!, broken])).toThrow();
    expect(schemaVersion(db)).toBe(1);
    // SQLite's DDL is transactional, so the half of the migration that did parse must be gone.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get()).toBeUndefined();
  } finally {
    db.close();
  }
});

test("refuses to run against a store newer than this build", () => {
  const db = openStore(tempStorePath());
  try {
    migrate(db, FIXTURES);
    expect(() => migrate(db, [FIXTURES[0]!])).toThrow(/forward-only/);
  } finally {
    db.close();
  }
});

test("rejects a duplicate version instead of silently skipping one", () => {
  const db = openStore(tempStorePath());
  try {
    const clashing: Migration[] = [
      { version: 1, name: "0001_a", sql: "CREATE TABLE a (id TEXT)" },
      { version: 1, name: "0001_b", sql: "CREATE TABLE b (id TEXT)" },
    ];
    expect(() => migrate(db, clashing)).toThrow(/duplicate migration version: 1/);
  } finally {
    db.close();
  }
});

/**
 * V5 (#16) — `rebuildReferences`: SQLite cannot `ALTER` a foreign-key action, so the change is a
 * table rebuild, and a rebuild needs `PRAGMA foreign_keys = OFF` — which only takes effect **outside**
 * a transaction. These fixtures are a faithful miniature of `0003`.
 */
const REBUILD_FIXTURES: Migration[] = [
  {
    version: 1,
    name: "0001_parent_child",
    sql: `CREATE TABLE idea (id TEXT PRIMARY KEY);
          CREATE TABLE child (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES idea(id));
          CREATE TABLE note (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES idea(id));`,
  },
  {
    version: 2,
    name: "0002_rebuild_child",
    rebuildReferences: true,
    sql: `CREATE TABLE child_new (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL);
          INSERT INTO child_new (id, idea_id) SELECT id, idea_id FROM child;
          DROP TABLE child;
          ALTER TABLE child_new RENAME TO child;`,
  },
];

const foreignKeys = (db: ReturnType<typeof openStore>): number =>
  (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number }).foreign_keys ?? 0;
const childFks = (db: ReturnType<typeof openStore>): unknown[] =>
  db.prepare("PRAGMA foreign_key_list(child)").all();

test("a rebuild migration changes the action, keeps the rows, and restores enforcement", () => {
  const db = openStore(tempStorePath());
  try {
    migrate(db, [REBUILD_FIXTURES[0]!]);
    db.exec(
      "INSERT INTO idea (id) VALUES ('i1'); INSERT INTO child (id, idea_id) VALUES ('c1','i1')",
    );

    expect(migrate(db, REBUILD_FIXTURES)).toBe(2);
    expect(childFks(db)).toEqual([]); // the reference is gone
    expect(db.prepare("SELECT id FROM child").all()).toEqual([{ id: "c1" }]); // and the rows survived
    expect(foreignKeys(db)).toBe(1); // enforcement is back on
  } finally {
    db.close();
  }
});

test("a rebuild that leaves a violation fails, rolls back, and still restores enforcement", () => {
  const db = openStore(tempStorePath());
  try {
    migrate(db, [REBUILD_FIXTURES[0]!]);
    const violating: Migration = {
      version: 2,
      name: "0002_violating",
      rebuildReferences: true,
      // The violation can only be written with enforcement off, which is exactly the window this
      // migration runs in — so `foreign_key_check` inside the transaction is the only thing that sees
      // it. It is written into `note`, whose reference the rebuild does *not* touch: a ghost in
      // `child` would be legal once its own reference is dropped, and would prove nothing.
      sql: `${REBUILD_FIXTURES[1]!.sql}
            INSERT INTO note (id, idea_id) VALUES ('n1', 'nope');`,
    };
    expect(() => migrate(db, [REBUILD_FIXTURES[0]!, violating])).toThrow(/foreign-key violation/);
    expect(schemaVersion(db)).toBe(1);
    expect(childFks(db)).toHaveLength(1); // the rebuild rolled back with the transaction
    expect(foreignKeys(db)).toBe(1);
  } finally {
    db.close();
  }
});

test("refuses a rebuild migration inside an open transaction, naming the silent no-op", () => {
  const db = openStore(tempStorePath());
  try {
    migrate(db, [REBUILD_FIXTURES[0]!]);
    db.exec("BEGIN");
    try {
      // `PRAGMA foreign_keys = OFF` here would be accepted, ignored, and reported as success — so the
      // migration would fail later with a bare FK error pointing at its SQL. Say what happened instead.
      expect(() => migrate(db, [REBUILD_FIXTURES[0]!, REBUILD_FIXTURES[1]!])).toThrow(
        /silent no-op inside a transaction/,
      );
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
});

test("a rebuild migration that is already applied still restores enforcement", () => {
  const db = openStore(tempStorePath());
  try {
    migrate(db, [REBUILD_FIXTURES[0]!]);
    expect(migrate(db, REBUILD_FIXTURES)).toBe(2);
    // Already applied: the second call takes the skip path, so the pragma dance must not leave
    // enforcement off there either.
    expect(migrate(db, REBUILD_FIXTURES)).toBe(2);
    expect(foreignKeys(db)).toBe(1);
  } finally {
    db.close();
  }
});
