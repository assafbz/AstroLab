import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { beforeEach, describe, expect, test } from "vitest";

import { NotFoundError, ValidationError, parseIdeaFields, type IdeaFields } from "./capture.js";
import { iterateIdea } from "./iterate.js";

/**
 * V3 (#14) — `POST /v1/ideas/{id}/iterate` (`docs/API.md` §4.6; `FLOW.md` T23; `PRD.md` §3.2 item 1).
 *
 * The one thing this path must *not* do is the interesting half: an iteration is the same node with a
 * new version, so it creates **no** lineage edge and **no** new `idea` row (`FLOW.md` §2.3, L1). The
 * second half is the ARCH §4 trigger — one stamp, one run, in the same transaction — and the third is
 * that an unknown id writes nothing at all.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function revision(db: DatabaseSync): number {
  return (db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as { revision: number })
    .revision;
}

function pendingRuns(db: DatabaseSync): Array<{ vault_revision: number; status: string }> {
  return db
    .prepare("SELECT vault_revision, status FROM spark_run ORDER BY vault_revision")
    .all() as Array<{ vault_revision: number; status: string }>;
}

function seedIdea(
  db: DatabaseSync,
  id: string,
  over: { lineageKind?: string; lineageParentId?: string | null; status?: string } = {},
): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, 'h', 'p', 'm', '["fintech"]', ?, ?, ?, 'PRIVATE', 1, 't', 't')`,
  ).run(id, over.lineageKind ?? "ROOT", over.lineageParentId ?? null, over.status ?? "ACTIVE");
  // Capture writes v1 with the row, so a seeded node has one version already — the shape every real
  // iterate starts from (`capture.ts` `insertIdea`).
  db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, 1, 'h', 'p', 'm', '["fintech"]', 't')`,
  ).run(id);
}

const edited: IdeaFields = {
  hypothesis: "h2",
  problem: "p2",
  monetization: "m2",
  domain_tags: ["health", "audio-dsp"],
};

describe("parseIdeaFields — the §4.2 validator, shared with capture", () => {
  const valid = { hypothesis: "H", problem: "P", monetization: "M", domain_tags: ["fintech"] };

  test("returns exactly the four mandatory fields, trimmed", () => {
    expect(parseIdeaFields({ ...valid, domain_tags: [" fintech ", "x"] })).toEqual({
      ...valid,
      domain_tags: ["fintech", "x"],
    });
    // The spark pair is capture's business, not this validator's.
    expect(parseIdeaFields({ ...valid, origin_spark_id: "s1" })).not.toHaveProperty(
      "origin_spark_id",
    );
  });

  test.each([
    ["missing hypothesis", { ...valid, hypothesis: undefined }],
    ["empty hypothesis", { ...valid, hypothesis: "  " }],
    ["missing problem", { ...valid, problem: undefined }],
    ["missing monetization", { ...valid, monetization: undefined }],
    ["empty domain_tags", { ...valid, domain_tags: [] }],
    ["non-string domain tag", { ...valid, domain_tags: ["ok", 7] }],
    ["over 280", { ...valid, hypothesis: "x".repeat(281) }],
  ])("rejects %s", (_name, body) => {
    expect(() => parseIdeaFields(body)).toThrow(ValidationError);
  });
});

describe("iterateIdea — a new version on the same node", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = newDb();
  });

  test("appends one idea_version and bumps current_version; the node itself is otherwise unmoved", () => {
    seedIdea(db, "i1");

    const idea = iterateIdea(db, "i1", edited);

    expect(idea).toMatchObject({
      id: "i1",
      hypothesis: "h2",
      problem: "p2",
      monetization: "m2",
      domain_tags: ["health", "audio-dsp"],
      lineage_kind: "ROOT",
      lineage_parent_id: null,
      status: "ACTIVE",
      current_version: 2,
      created_at: "t", // the node's birth is not re-dated — only `updated_at` moves
    });
    expect(idea.updated_at).not.toBe("t");
    expect(idea.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(count(db, "idea")).toBe(1);
    expect(count(db, "idea_version")).toBe(2);
  });

  test("creates no lineage edge — a FORK stays the same FORK with the same parent", () => {
    seedIdea(db, "parent");
    seedIdea(db, "child", { lineageKind: "FORK", lineageParentId: "parent" });

    const idea = iterateIdea(db, "child", edited);

    expect(idea.lineage_kind).toBe("FORK");
    expect(idea.lineage_parent_id).toBe("parent");
    expect(count(db, "idea")).toBe(2); // no new node
    const stored = db
      .prepare("SELECT lineage_kind, lineage_parent_id p FROM idea WHERE id='child'")
      .get();
    expect(stored).toEqual({ lineage_kind: "FORK", p: "parent" });
  });

  test("prior versions stay readable — v1 keeps the original text", () => {
    seedIdea(db, "i1");
    iterateIdea(db, "i1", edited);

    expect(
      db
        .prepare("SELECT version, hypothesis FROM idea_version WHERE idea_id='i1' ORDER BY version")
        .all(),
    ).toEqual([
      { version: 1, hypothesis: "h" },
      { version: 2, hypothesis: "h2" },
    ]);
  });

  test("two iterations are three versions, densely numbered", () => {
    seedIdea(db, "i1");

    iterateIdea(db, "i1", edited);
    const second = iterateIdea(db, "i1", { ...edited, hypothesis: "h3" });

    expect(second.current_version).toBe(3);
    expect(
      db.prepare("SELECT version FROM idea_version WHERE idea_id='i1' ORDER BY version").all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });

  test("a full iterate clears NEEDS_COMPLETION — the completion path (§4.6 / T27)", () => {
    seedIdea(db, "i1", { status: "NEEDS_COMPLETION" });

    expect(iterateIdea(db, "i1", edited).status).toBe("ACTIVE");
  });

  test("the **stored row** is ACTIVE — the flag is cleared on the node, not only in the answer", () => {
    seedIdea(db, "i1", { status: "NEEDS_COMPLETION" });

    iterateIdea(db, "i1", edited);

    expect(db.prepare("SELECT status FROM idea WHERE id = 'i1'").get()).toEqual({
      status: "ACTIVE",
    });
  });

  test("an ACTIVE idea stays ACTIVE — iterate never downgrades the status (§4.6)", () => {
    seedIdea(db, "i1");

    expect(iterateIdea(db, "i1", edited).status).toBe("ACTIVE");
  });

  test("an unknown id is NotFoundError, and writes nothing at all", () => {
    const before = revision(db);

    expect(() => iterateIdea(db, "missing", edited)).toThrow(NotFoundError);

    expect(count(db, "idea")).toBe(0);
    expect(count(db, "idea_version")).toBe(0);
    expect(revision(db)).toBe(before);
    expect(count(db, "spark_run")).toBe(0);
  });

  test("one iterate stamps the revision once and enqueues one PENDING run at it (§4 trigger)", () => {
    seedIdea(db, "i1");
    const before = revision(db);

    iterateIdea(db, "i1", edited);

    expect(revision(db)).toBe(before + 1);
    expect(pendingRuns(db)).toEqual([{ vault_revision: before + 1, status: "PENDING" }]);
  });
});
