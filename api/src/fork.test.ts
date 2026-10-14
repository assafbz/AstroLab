import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { beforeEach, describe, expect, test } from "vitest";

import { ConflictError, NotFoundError, ValidationError } from "./capture.js";
import { forkIdea, parseForkInput, type ForkInput } from "./fork.js";

/**
 * V4 (#15) — `POST /v1/ideas/{id}/fork` (`docs/API.md` §4.7; `FLOW.md` T24/T25; `PRD.md` §3.2 item 2).
 *
 * The load-bearing half is what a fork *is*: a **new** node — one `idea` row, a FORK parent edge, its
 * own `idea_version` 1, the delta stored on the new node and nowhere else — and what it is **not**: no
 * `provenance_edge`, no touch to the parent. Then the two refusals, in the pinned order: unknown id
 * (`404`) before same-domain (`409`), both writing nothing.
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

/** A captured shape: `insertIdea` writes v1 with the row, so a node has one version already. */
function seedIdea(
  db: DatabaseSync,
  id: string,
  over: { domainTags?: string[]; hypothesis?: string } = {},
): void {
  const tags = JSON.stringify(over.domainTags ?? ["health"]);
  const hypothesis = over.hypothesis ?? "the parent's hypothesis";
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, hypothesis, tags);
  db.prepare(
    `INSERT INTO idea_version (idea_id, version, hypothesis, problem, monetization, domain_tags, created_at)
     VALUES (?, 1, ?, 'p', 'm', ?, 't')`,
  ).run(id, hypothesis, tags);
}

const forkInput: ForkInput = {
  mutation_delta: "into a healthcare scheduler",
  domain_tags: ["compliance"],
};

describe("parseForkInput — §4.7's two-field request", () => {
  test("returns exactly the two fields, `domain_tags` trimmed", () => {
    expect(parseForkInput({ ...forkInput, domain_tags: [" compliance ", "x"] })).toEqual({
      mutation_delta: "into a healthcare scheduler",
      domain_tags: ["compliance", "x"],
    });
    // The parent-copied text fields are not in the request; extra keys are ignored, not read.
    expect(parseForkInput({ ...forkInput, hypothesis: "h" })).toEqual(forkInput);
  });

  test.each([
    ["a non-object body", "nope"],
    ["an array body", []],
    ["missing mutation_delta", { domain_tags: ["x"] }],
    ["empty mutation_delta", { mutation_delta: "  ", domain_tags: ["x"] }],
    ["non-string mutation_delta", { mutation_delta: 7, domain_tags: ["x"] }],
    ["missing domain_tags", { mutation_delta: "d" }],
    ["empty domain_tags", { mutation_delta: "d", domain_tags: [] }],
    ["non-string domain tag", { mutation_delta: "d", domain_tags: ["ok", 7] }],
  ])("rejects %s", (_name, body) => {
    expect(() => parseForkInput(body)).toThrow(ValidationError);
  });
});

describe("forkIdea — a new node branching from a parent", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = newDb();
  });

  test("creates a FORK: a new node, the parent edge, the parent's text copied, the request's domains", () => {
    seedIdea(db, "parent", { domainTags: ["health"], hypothesis: "the parent's hypothesis" });

    const fork = forkIdea(db, "parent", forkInput);

    expect(fork.id).not.toBe("parent");
    expect(fork).toMatchObject({
      hypothesis: "the parent's hypothesis", // copied, not in the request
      problem: "p",
      monetization: "m",
      domain_tags: ["compliance"], // the request's
      lineage_kind: "FORK",
      lineage_parent_id: "parent",
      status: "ACTIVE",
      current_version: 1,
    });
    expect(fork.created_at).toBe(fork.updated_at);

    // Two nodes now, and the child's v1 carries exactly the child's content.
    expect(count(db, "idea")).toBe(2);
    expect(
      db.prepare("SELECT hypothesis, domain_tags FROM idea_version WHERE idea_id = ?").get(fork.id),
    ).toEqual({ hypothesis: "the parent's hypothesis", domain_tags: '["compliance"]' });
    // The parent is untouched — a fork adds a node, it does not move one.
    expect(
      db.prepare("SELECT lineage_kind, current_version FROM idea WHERE id = 'parent'").get(),
    ).toEqual({ lineage_kind: "ROOT", current_version: 1 });
  });

  test("the mutation delta is stored on the new node and nowhere else", () => {
    seedIdea(db, "parent");
    const fork = forkIdea(db, "parent", forkInput);

    expect(
      (
        db.prepare("SELECT mutation_delta AS d FROM idea WHERE id = ?").get(fork.id) as {
          d: string;
        }
      ).d,
    ).toBe("into a healthcare scheduler");
    expect(
      (
        db.prepare("SELECT mutation_delta AS d FROM idea WHERE id = 'parent'").get() as {
          d: string;
        }
      ).d,
    ).toBeNull();
  });

  test("creates no provenance edge — a fork's parent is lineage, not provenance (§2.3)", () => {
    seedIdea(db, "parent");
    forkIdea(db, "parent", forkInput);

    expect(count(db, "provenance_edge")).toBe(0);
  });

  test("a superset domain set differs and is accepted — the fork widens the vault", () => {
    seedIdea(db, "parent", { domainTags: ["health"] });
    const fork = forkIdea(db, "parent", { ...forkInput, domain_tags: ["health", "compliance"] });
    expect(fork.domain_tags).toEqual(["health", "compliance"]);
    expect(count(db, "idea")).toBe(2);
  });

  test("the same domain set in another order is still the same set — ConflictError", () => {
    seedIdea(db, "parent", { domainTags: ["health", "compliance"] });

    expect(() =>
      forkIdea(db, "parent", { ...forkInput, domain_tags: ["compliance", "health"] }),
    ).toThrow(ConflictError);
  });

  test("the literal rule admits a narrowing subset; the gap is recorded, not implemented (§4.7)", () => {
    // A strict subset of a *wider* parent: `["health"]` from `["health","compliance"]` differs, so the
    // equality rule accepts it, though it narrows the vault. The flywheel guard `F ⊆ P` is a §4.7
    // note, not this PR — this pins the accepted behaviour so a silent tightening is caught.
    seedIdea(db, "wide", { domainTags: ["health", "compliance"] });
    const fork = forkIdea(db, "wide", { ...forkInput, domain_tags: ["health"] });
    expect(fork.domain_tags).toEqual(["health"]);
    expect(count(db, "idea")).toBe(2);
  });

  test("an unknown id is NotFoundError, and writes nothing at all", () => {
    const before = revision(db);

    expect(() => forkIdea(db, "missing", forkInput)).toThrow(NotFoundError);

    expect(count(db, "idea")).toBe(0);
    expect(count(db, "idea_version")).toBe(0);
    expect(count(db, "spark_run")).toBe(0);
    expect(revision(db)).toBe(before);
  });

  test("a same-domain fork is ConflictError, and writes nothing at all", () => {
    seedIdea(db, "parent", { domainTags: ["health"] });
    const before = revision(db);

    expect(() => forkIdea(db, "parent", { ...forkInput, domain_tags: ["health"] })).toThrow(
      ConflictError,
    );

    expect(count(db, "idea")).toBe(1); // only the parent
    expect(count(db, "idea_version")).toBe(1);
    expect(count(db, "spark_run")).toBe(0);
    expect(revision(db)).toBe(before);
  });

  test("one fork stamps the revision once and enqueues one PENDING run (§4 trigger)", () => {
    seedIdea(db, "parent");
    const before = revision(db);

    forkIdea(db, "parent", forkInput);

    expect(revision(db)).toBe(before + 1);
    expect(pendingRuns(db)).toEqual([{ vault_revision: before + 1, status: "PENDING" }]);
  });
});
