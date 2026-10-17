import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { openNodeStore } from "../src/store/connection.node.js";
import { migrate, schemaVersion } from "../src/store/migrate.js";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/store/migrations.js";

import { FIXTURE_MIGRATIONS, FIXTURE_VERSION } from "./fixtures.js";

/**
 * Booting the store — as **one** process does (`ADR-0006`: the app is the only writer).
 *
 * v1 pinned these as races between two processes (a concurrent WAL conversion, a concurrent
 * `migrate`). Both races were real and both retired with the API + worker split, so the two-process
 * fixtures went with them; what survives is what still has to hold, plus the property that replaced
 * them — a **second connection is refused loudly instead of silently corrupting**, because the
 * single-writer assumption is now load-bearing rather than merely usual.
 */

const dirs: string[] = [];
/** Deliberately not created: a fresh file is what makes the WAL conversion a contended write. */
function freshStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-boot-"));
  dirs.push(dir);
  return join(dir, "astrolab.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a fresh file boots into WAL", () => {
  const db = openNodeStore(freshStorePath());
  try {
    expect(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe("wal");
  } finally {
    db.close();
  }
});

test("migrating a file that is already at the version is a no-op, not a re-apply", () => {
  const path = freshStorePath();

  const first = openNodeStore(path);
  try {
    expect(migrate(first, FIXTURE_MIGRATIONS)).toBe(FIXTURE_VERSION);
  } finally {
    first.close();
  }

  // A second boot of the same file: `user_version` is the sentinel, so the DDL is skipped.
  const second = openNodeStore(path);
  try {
    expect(schemaVersion(second)).toBe(FIXTURE_VERSION);
    expect(migrate(second, FIXTURE_MIGRATIONS)).toBe(FIXTURE_VERSION);
    expect(
      second
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'idea'")
        .get()?.["n"],
    ).toBe(1);
    second.exec("INSERT INTO idea (id) VALUES ('i1')");
    expect(second.prepare("SELECT status FROM idea WHERE id = 'i1'").get()?.["status"]).toBe(
      "ACTIVE",
    );
  } finally {
    second.close();
  }
});

test("the shipped migration lands the whole of §2, once", () => {
  const path = freshStorePath();

  for (const round of [1, 2]) {
    const db = openNodeStore(path);
    try {
      expect(migrate(db, MIGRATIONS), `round ${round}`).toBe(SCHEMA_VERSION);
      expect(
        db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get()?.["n"],
        `round ${round} — table count`,
      ).toBe(12);
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_spark_live'")
          .get()?.["name"],
        `round ${round} — partial index`,
      ).toBe("ux_spark_live");
    } finally {
      db.close();
    }
  }
});

test("a second connection is refused loudly, not tolerated", () => {
  const path = freshStorePath();

  const writer = openNodeStore(path);
  const intruder = openNodeStore(path, { busyTimeoutMs: 0 });
  try {
    writer.exec("CREATE TABLE t (k INTEGER)");
    // The one writer holds the write lock — the state two connections must never both be in.
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO t (k) VALUES (1)");

    // `busyTimeoutMs: 0` so the refusal is immediate and unambiguous. A store that retried this away
    // would be hiding a second writer, which is the failure the single-writer model exists to prevent.
    expect(() => intruder.exec("INSERT INTO t (k) VALUES (2)")).toThrow(/busy|locked/i);

    writer.exec("COMMIT");
    expect(writer.prepare("SELECT count(*) AS n FROM t").get()?.["n"]).toBe(1);

    // …and the lock was the only obstacle: once the writer is done, the second connection writes.
    intruder.exec("BEGIN IMMEDIATE");
    intruder.exec("INSERT INTO t (k) VALUES (2)");
    intruder.exec("COMMIT");
    expect(intruder.prepare("SELECT count(*) AS n FROM t").get()?.["n"]).toBe(2);
  } finally {
    writer.close();
    intruder.close();
  }
});
