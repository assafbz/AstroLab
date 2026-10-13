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
