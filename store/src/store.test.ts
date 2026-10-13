import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { openStore, writeTransaction } from "./store.js";

/** A file-backed store, because `journal_mode = WAL` is meaningless for an in-memory database. */
const dirs: string[] = [];
function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-store-"));
  dirs.push(dir);
  return join(dir, "astrolab.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("opens in WAL with a busy timeout and foreign keys enforced", () => {
  const db = openStore(tempStorePath());
  try {
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  } finally {
    db.close();
  }
});

test("honours an explicit busy timeout", () => {
  const db = openStore(tempStorePath(), { busyTimeoutMs: 250 });
  try {
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(250);
  } finally {
    db.close();
  }
});

test("rejects a nonsensical busy timeout rather than interpolating it into a pragma", () => {
  expect(() => openStore(tempStorePath(), { busyTimeoutMs: -1 })).toThrow(RangeError);
  expect(() => openStore(tempStorePath(), { busyTimeoutMs: 1.5 })).toThrow(RangeError);
});

test("writeTransaction commits on success", () => {
  const db = openStore(tempStorePath());
  try {
    db.exec("CREATE TABLE t (k INTEGER)");
    writeTransaction(db, () => db.exec("INSERT INTO t (k) VALUES (1)"));
    expect(db.prepare("SELECT count(*) AS n FROM t").get()?.n).toBe(1);
  } finally {
    db.close();
  }
});

test("writeTransaction rolls back and rethrows when the body fails", () => {
  const db = openStore(tempStorePath());
  try {
    db.exec("CREATE TABLE t (k INTEGER)");
    expect(() =>
      writeTransaction(db, () => {
        db.exec("INSERT INTO t (k) VALUES (1)");
        db.exec("SELECT * FROM no_such_table");
      }),
    ).toThrow(/no_such_table/);
    // The insert that happened before the failure must not survive.
    expect(db.prepare("SELECT count(*) AS n FROM t").get()?.n).toBe(0);
  } finally {
    db.close();
  }
});
