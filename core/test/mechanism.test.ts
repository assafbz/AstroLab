import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteConnection } from "../src/store/connection.js";
import { afterEach, describe, expect, test } from "vitest";

import { readDescriptors, upsertDescriptor } from "../src/store/mechanism.js";
import { migrate } from "../src/store/migrate.js";
import { MIGRATIONS } from "../src/store/migrations.js";
import { openNodeStore } from "../src/store/connection.node.js";
import { insertIdea, rows } from "./seed.js";

/**
 * The `idea_mechanism` cache's persistence, at the layer that owns it (W3 #28, Max's condition A).
 *
 * The load-bearing one is the last block: this write is a **named exception** to `vaultMutation`
 * (`core/src/store/mechanism.ts`), and the property that makes it safe — *no revision stamp, no run* — must
 * be guarded **where the write lives**. An engine-side test cannot see this helper, so the property
 * would go unguarded the moment it moved here.
 */

const dirs: string[] = [];
const opened: SqliteConnection[] = [];

function migrated(): SqliteConnection {
  const dir = mkdtempSync(join(tmpdir(), "astrolab-mechanism-"));
  dirs.push(dir);
  const db = openNodeStore(join(dir, "astrolab.sqlite"));
  opened.push(db);
  migrate(db, MIGRATIONS);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DESCRIPTOR = JSON.stringify({
  verb: "batch",
  object_class: "meals",
  constraint: "one session",
  transferable_structure: "amortise a fixed cost",
});

describe("upsertDescriptor — one row per idea (§2.3)", () => {
  test("writes the row the engine reads back", () => {
    const db = migrated();
    insertIdea(db, "a");

    upsertDescriptor(db, { ideaId: "a", descriptor: DESCRIPTOR, sourceHash: "h1" });

    expect(readDescriptors(db, ["a"])).toEqual([
      { idea_id: "a", descriptor: DESCRIPTOR, source_hash: "h1", extracted_at: expect.any(String) },
    ]);
  });

  test("replaces in place — a second write leaves exactly one row", () => {
    const db = migrated();
    insertIdea(db, "a");

    upsertDescriptor(db, { ideaId: "a", descriptor: DESCRIPTOR, sourceHash: "h1" });
    upsertDescriptor(db, { ideaId: "a", descriptor: "{}", sourceHash: "h2" });

    const stored = readDescriptors(db, ["a"]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ descriptor: "{}", source_hash: "h2" });
  });

  test("reads only the ids asked for — an id with no row is simply absent", () => {
    const db = migrated();
    insertIdea(db, "a");
    insertIdea(db, "b");

    upsertDescriptor(db, { ideaId: "a", descriptor: DESCRIPTOR, sourceHash: "h1" });

    expect(readDescriptors(db, ["a", "b"]).map((row) => row.idea_id)).toEqual(["a"]);
    expect(readDescriptors(db, [])).toEqual([]);
  });
});

describe("a failed write leaves no row", () => {
  test("an idea id with no `idea` row is an FK violation, and nothing is written", () => {
    const db = migrated();

    expect(() =>
      upsertDescriptor(db, { ideaId: "ghost", descriptor: DESCRIPTOR, sourceHash: "h" }),
    ).toThrow();

    expect(rows(db, "SELECT count(*) AS n FROM idea_mechanism")[0]?.n).toBe(0);
  });
});

describe("the cache write is not a vault mutation (ARCH §4; Max's #78 carry)", () => {
  test("no `vault_meta` bump, no `spark_run` row, exactly one row", () => {
    const db = migrated();
    insertIdea(db, "a");
    const revision = () => rows(db, "SELECT revision FROM vault_meta WHERE id = 1")[0]?.revision;
    const before = revision();

    upsertDescriptor(db, { ideaId: "a", descriptor: DESCRIPTOR, sourceHash: "h1" });

    expect(revision()).toBe(before);
    expect(rows(db, "SELECT count(*) AS n FROM spark_run")[0]?.n).toBe(0);
    expect(rows(db, "SELECT count(*) AS n FROM idea_mechanism")[0]?.n).toBe(1);
  });
});
