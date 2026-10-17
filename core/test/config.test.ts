import type { SqliteConnection } from "../src/store/connection.js";
import { describe, expect, test } from "vitest";

import {
  GATE_CONFIG_DEFAULTS,
  InvalidConfigError,
  readGateConfig,
  seedGateConfig,
  setConfig,
} from "../src/store/config.js";
import { migrate } from "../src/store/migrate.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { currentVaultRevision } from "../src/store/runs.js";
import { openNodeStore } from "../src/store/connection.node.js";

/**
 * The gate thresholds' SQL (W5 #30; `ARCHITECTURE.md` §3.4).
 *
 * Two properties are load-bearing and pinned here:
 *
 * - **the shipped default is not a suggestion** — `min_domain_distance` **is** the cliché guard
 *   (§3.5), so a value that quietly becomes `0` disables it. The default is asserted as a literal.
 * - **non-stamping** — the seed and the set write outside `vaultMutation`, so a boot or a tune must
 *   never move `vault_meta.revision` or enqueue a run (Max's #78 exception, guarded where the write
 *   lives).
 */

function migrated(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

describe("readGateConfig — ARCHITECTURE.md §3.4", () => {
  test("an empty config reads the shipped defaults, asserted as literals", () => {
    const db = migrated();
    // Pinned: dropping `min_domain_distance` to 0 is the cliché-guard footgun (D4b), so this assert
    // is the regression guard, not a restatement of `GATE_CONFIG_DEFAULTS`.
    expect(readGateConfig(db)).toEqual({ minDomainDistance: 1, minAlignment: 0.02 });
    expect(GATE_CONFIG_DEFAULTS).toEqual({ minDomainDistance: 1, minAlignment: 0.02 });
  });

  test("an absent key falls back to its default while the other key still reads", () => {
    const db = migrated();
    db.prepare("INSERT INTO config (key, value) VALUES ('min_alignment', '0.9')").run();
    expect(readGateConfig(db)).toEqual({ minDomainDistance: 1, minAlignment: 0.9 });
  });

  test("a malformed stored value throws InvalidConfigError — never a silent fallback", () => {
    const cases: Array<[string, string]> = [
      ["min_alignment", "abc"],
      ["min_domain_distance", "-1"],
      ["min_alignment", "1.5"],
      ["min_domain_distance", "1.5"],
      ["min_domain_distance", "abc"],
    ];
    for (const [key, value] of cases) {
      const db = migrated();
      db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(key, value);
      expect(() => readGateConfig(db), `${key}=${value}`).toThrow(InvalidConfigError);
    }
  });

  test("min_domain_distance = 0 is valid and reads back as 0 (D4b: no distance filter)", () => {
    const db = migrated();
    setConfig(db, "min_domain_distance", "0");
    expect(readGateConfig(db).minDomainDistance).toBe(0);
  });
});

describe("seedGateConfig / setConfig — insert-only seeding, explicit tuning", () => {
  test("seeding writes the defaults; a second seed is a no-op", () => {
    const db = migrated();
    seedGateConfig(db);
    expect(readGateConfig(db)).toEqual({ minDomainDistance: 1, minAlignment: 0.02 });
    seedGateConfig(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM config").get()).toEqual({ n: 2 });
  });

  test("a tuned value survives a re-seed — the boot cannot revert it", () => {
    const db = migrated();
    seedGateConfig(db);
    setConfig(db, "min_alignment", "0.9");
    seedGateConfig(db); // the next boot
    expect(readGateConfig(db)).toEqual({ minDomainDistance: 1, minAlignment: 0.9 });
  });

  test("setConfig refuses a malformed value before writing it", () => {
    const db = migrated();
    expect(() => setConfig(db, "min_alignment", "1.5")).toThrow(InvalidConfigError);
    expect(() => setConfig(db, "min_domain_distance", "-1")).toThrow(InvalidConfigError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM config").get()).toEqual({ n: 0 });
  });
});

describe("config writes are non-stamping (Max's #78 exception)", () => {
  test("a seed and a set move neither the revision nor the run queue", () => {
    const db = migrated();
    const before = currentVaultRevision(db);
    seedGateConfig(db);
    setConfig(db, "min_alignment", "0.9");
    expect(currentVaultRevision(db)).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
  });
});
