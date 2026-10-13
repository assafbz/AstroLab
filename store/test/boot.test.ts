import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { schemaVersion } from "../src/migrate.js";
import { SCHEMA_VERSION } from "../src/migrations.js";
import { openStore } from "../src/store.js";
import { BOOT_LEAD_MS, FIXTURE_VERSION } from "./fixtures.js";
import { runChild } from "./harness.js";

/**
 * The two boot races between the processes the store exists for, pinned. Both were real: a
 * concurrent WAL conversion failed instantly (the busy handler does not run for a journal-mode
 * change), and a concurrent `migrate` re-applied the DDL after losing the write lock.
 *
 * Each round aims two children at the same instant, so the race is between the statements rather
 * than between start-ups. Rounds are repeated because a race is a race — one attempt is a coin toss.
 */
const ROUNDS = 3;

const dirs: string[] = [];
function freshStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-boot-"));
  dirs.push(dir);
  // Deliberately not created: a fresh file is what makes the WAL conversion a contended write.
  return join(dir, "astrolab.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function boot(path: string, mode: "open" | "open-migrate", which: "fixture" | "real" = "fixture") {
  return runChild("boot.ts", [path, String(Date.now() + BOOT_LEAD_MS), mode, which]);
}

test(
  "two processes converting a fresh file to WAL at once both boot",
  { timeout: 120_000 },
  async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const path = freshStorePath();
      const results = await Promise.all([boot(path, "open"), boot(path, "open")]);
      const detail = results.map((r) => `exit ${r.code}: ${r.stderr.trim()}`).join(" | ");
      expect(
        results.map((r) => r.code),
        `round ${round} — ${detail}`,
      ).toEqual([0, 0]);
    }

    const db = openStore(freshStorePath());
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    } finally {
      db.close();
    }
  },
);

test(
  "two processes migrating the same file at boot both land at the same version",
  { timeout: 120_000 },
  async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const path = freshStorePath();
      const results = await Promise.all([boot(path, "open-migrate"), boot(path, "open-migrate")]);
      const detail = results.map((r) => `exit ${r.code}: ${r.stderr.trim()}`).join(" | ");
      expect(
        results.map((r) => r.code),
        `round ${round} — ${detail}`,
      ).toEqual([0, 0]);

      // Exactly once: the loser must skip, not re-apply the DDL and not leave a half-migration.
      const db = openStore(path);
      try {
        expect(schemaVersion(db)).toBe(FIXTURE_VERSION);
        const tables = db
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'idea'")
          .get()?.n;
        expect(tables, `round ${round} — idea table count`).toBe(1);
        db.exec("INSERT INTO idea (id) VALUES ('i1')");
        expect(db.prepare("SELECT status FROM idea WHERE id = 'i1'").get()?.status).toBe("ACTIVE");
      } finally {
        db.close();
      }
    }
  },
);

test(
  "two processes applying the shipped 0001_init at boot both land on the schema",
  { timeout: 120_000 },
  async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const path = freshStorePath();
      const results = await Promise.all([
        boot(path, "open-migrate", "real"),
        boot(path, "open-migrate", "real"),
      ]);
      const detail = results.map((r) => `exit ${r.code}: ${r.stderr.trim()}`).join(" | ");
      expect(
        results.map((r) => r.code),
        `round ${round} — ${detail}`,
      ).toEqual([0, 0]);

      // Exactly once, and the whole of §2: the loser must skip the twelve-table DDL, not re-apply it.
      const db = openStore(path);
      try {
        expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
        const tables = db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get()?.n;
        expect(tables, `round ${round} — table count`).toBe(12);
        const index = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_spark_live'")
          .get()?.name;
        expect(index, `round ${round} — partial index`).toBe("ux_spark_live");
      } finally {
        db.close();
      }
    }
  },
);
