import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { DESCRIPTOR_SCHEMA, EXTRACTION_SYSTEM } from "../provider/index.js";
import type { IdeaText, MechanismDescriptor, MechanismExtractor } from "../provider/index.js";
import {
  EXTRACTOR_VERSION,
  createMechanismCache,
  hashIdeaText,
  readIdeaText,
  type MechanismProducer,
} from "./mechanism.js";

/** A fresh migrated in-memory vault — the schema `main` ships (`0001_init` + `0002`). */
function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  return db;
}

const TEXT: IdeaText = { hypothesis: "h", problem: "p", monetization: "m" };

/** The producer identity a call site resolves once and hands to both the adapter and the cache. */
const PRODUCER: MechanismProducer = { version: EXTRACTOR_VERSION, model: "test/model" };

function seedIdea(db: DatabaseSync, id: string, text: IdeaText = TEXT): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, '["fintech"]', 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, text.hypothesis, text.problem, text.monetization);
}

const descriptor = (verb: string): MechanismDescriptor => ({
  verb,
  object_class: "meals",
  constraint: "one cook session",
  transferable_structure: "amortise a fixed cost across many units",
});

/** A `MechanismExtractor` that records every payload and answers from `respond`. */
function fakeExtractor(respond: (call: number) => MechanismDescriptor): {
  extractor: MechanismExtractor;
  calls: IdeaText[];
} {
  const calls: IdeaText[] = [];
  return {
    calls,
    extractor: {
      async extract(idea) {
        const answer = respond(calls.length);
        calls.push(idea);
        return answer;
      },
    },
  };
}

function cacheRows(db: DatabaseSync): Array<{ descriptor: string; source_hash: string }> {
  return db.prepare("SELECT descriptor, source_hash FROM idea_mechanism").all() as Array<{
    descriptor: string;
    source_hash: string;
  }>;
}

describe("hashIdeaText — the cache key (§2.3 source_hash)", () => {
  test("is stable for the same text, and 64 lowercase hex", () => {
    const hash = hashIdeaText(TEXT, PRODUCER);
    expect(hash).toBe(hashIdeaText(TEXT, PRODUCER));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("covers all three text fields — a `problem`- or `monetization`-only edit re-extracts", () => {
    const base = hashIdeaText(TEXT, PRODUCER);
    expect(hashIdeaText({ ...TEXT, problem: "different" }, PRODUCER)).not.toBe(base);
    expect(hashIdeaText({ ...TEXT, monetization: "different" }, PRODUCER)).not.toBe(base);
  });

  test("cannot be fooled by moving a character across the field boundary", () => {
    expect(hashIdeaText({ hypothesis: "ab", problem: "", monetization: "c" }, PRODUCER)).not.toBe(
      hashIdeaText({ hypothesis: "a", problem: "b", monetization: "c" }, PRODUCER),
    );
  });
});

describe("readIdeaText — the extract payload, and nothing else (§3.3 step 1)", () => {
  test("reads exactly the three fields the boundary sends — never `domain_tags`", () => {
    const db = newDb();
    seedIdea(db, "a");

    const text = readIdeaText(db, "a");
    expect(text).toEqual(TEXT);
    expect(Object.keys(text ?? {}).sort()).toEqual(["hypothesis", "monetization", "problem"]);
  });

  test("is null for an idea that is not in the vault", () => {
    expect(readIdeaText(newDb(), "ghost")).toBeNull();
  });
});

describe("createMechanismCache — Stage 1's cache (§3.3 step 1)", () => {
  test("extracts and caches on a miss; the row holds the descriptor and the key", async () => {
    const db = newDb();
    seedIdea(db, "a");
    const { extractor, calls } = fakeExtractor(() => descriptor("batch"));

    await expect(createMechanismCache(db, extractor, PRODUCER).descriptorFor("a")).resolves.toEqual(
      descriptor("batch"),
    );

    expect(calls).toHaveLength(1);
    const [row] = cacheRows(db);
    expect(JSON.parse(row?.descriptor ?? "null")).toEqual(descriptor("batch"));
    expect(row?.source_hash).toBe(hashIdeaText(TEXT, PRODUCER));
  });

  test("serves the cache when nothing changed — zero provider calls", async () => {
    const db = newDb();
    seedIdea(db, "a");
    const { extractor, calls } = fakeExtractor(() => descriptor("batch"));
    const cache = createMechanismCache(db, extractor, PRODUCER);

    const first = await cache.descriptorFor("a");
    const second = await cache.descriptorFor("a");

    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  test("re-extracts when the idea's text changes, and still keeps exactly one row", async () => {
    const db = newDb();
    seedIdea(db, "a");
    const { extractor, calls } = fakeExtractor((call) =>
      descriptor(call === 0 ? "first" : "second"),
    );
    const cache = createMechanismCache(db, extractor, PRODUCER);

    await cache.descriptorFor("a");
    db.prepare("UPDATE idea SET problem = 'a different problem' WHERE id = 'a'").run();

    await expect(cache.descriptorFor("a")).resolves.toEqual(descriptor("second"));
    expect(calls).toHaveLength(2);
    expect(cacheRows(db)).toHaveLength(1);
  });

  test("re-extracts when only `problem` changes — the under-hash canary", async () => {
    const db = newDb();
    seedIdea(db, "a");
    const { extractor, calls } = fakeExtractor(() => descriptor("batch"));
    const cache = createMechanismCache(db, extractor, PRODUCER);

    await cache.descriptorFor("a");
    db.prepare("UPDATE idea SET problem = 'only the problem moved' WHERE id = 'a'").run();
    await cache.descriptorFor("a");

    expect(calls).toHaveLength(2);
  });

  test("re-extracts when the extraction contract version changes (§12 item 2)", async () => {
    const db = newDb();
    seedIdea(db, "a");
    const first = fakeExtractor(() => descriptor("batch"));
    await createMechanismCache(db, first.extractor, PRODUCER).descriptorFor("a");

    const next = fakeExtractor(() => descriptor("batch"));
    const bumped: MechanismProducer = { ...PRODUCER, version: EXTRACTOR_VERSION + 1 };
    await createMechanismCache(db, next.extractor, bumped).descriptorFor("a");

    expect(first.calls).toHaveLength(1);
    expect(next.calls).toHaveLength(1);
  });

  test("re-extracts when the model changes (ADR-0003: re-pointable without a code change)", async () => {
    const db = newDb();
    seedIdea(db, "a");
    const first = fakeExtractor(() => descriptor("batch"));
    await createMechanismCache(db, first.extractor, PRODUCER).descriptorFor("a");

    const next = fakeExtractor(() => descriptor("batch"));
    const onAnotherModel: MechanismProducer = { ...PRODUCER, model: "other/model" };
    await createMechanismCache(db, next.extractor, onAnotherModel).descriptorFor("a");

    expect(next.calls).toHaveLength(1);
  });

  test("serves a row an earlier process cached", async () => {
    const db = newDb();
    seedIdea(db, "a");
    db.prepare(
      "INSERT INTO idea_mechanism (idea_id, descriptor, source_hash, extracted_at) VALUES (?, ?, ?, ?)",
    ).run(
      "a",
      JSON.stringify(descriptor("from another process")),
      hashIdeaText(TEXT, PRODUCER),
      "t",
    );
    const { extractor, calls } = fakeExtractor(() => descriptor("fresh"));

    await expect(createMechanismCache(db, extractor, PRODUCER).descriptorFor("a")).resolves.toEqual(
      descriptor("from another process"),
    );
    expect(calls).toHaveLength(0);
  });

  test("returns null, and writes nothing, for an idea that does not exist", async () => {
    const db = newDb();
    const { extractor, calls } = fakeExtractor(() => descriptor("batch"));

    await expect(
      createMechanismCache(db, extractor, PRODUCER).descriptorFor("ghost"),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(0);
    expect(cacheRows(db)).toEqual([]);
  });

  test("hashes exactly what it sends — one read, one field set", async () => {
    const db = newDb();
    seedIdea(db, "a", { hypothesis: "H", problem: "P", monetization: "M" });
    const { extractor, calls } = fakeExtractor(() => descriptor("batch"));

    await createMechanismCache(db, extractor, PRODUCER).descriptorFor("a");

    const sent = calls[0];
    expect(sent).toBeDefined();
    expect(cacheRows(db)[0]?.source_hash).toBe(hashIdeaText(sent as IdeaText, PRODUCER));
  });

  test("a cache write that fails propagates — and leaves no row (condition 2's check)", async () => {
    const db = newDb();
    seedIdea(db, "a");
    // The write fails the way it really can: the idea is deleted between the cut and the write, and
    // `idea_mechanism.idea_id` is an FK to `idea(id)`.
    const { extractor } = fakeExtractor(() => {
      db.prepare("DELETE FROM idea WHERE id = 'a'").run();
      return descriptor("batch");
    });

    await expect(
      createMechanismCache(db, extractor, PRODUCER).descriptorFor("a"),
    ).rejects.toThrow();
    expect(cacheRows(db)).toEqual([]);
  });
});

describe("the extraction contract (§12 item 2; David's condition 5)", () => {
  // The prompt and the descriptor field set are W9 tuning artifacts (§12 item 2): change either and
  // every cached descriptor is stale. This pins {version, contract} together, so that edit turns the
  // suite red and the fix is a deliberate `EXTRACTOR_VERSION` bump (and this pin), not a silent
  // old-shape cache. W9 owns the field set; this owns "the cache noticed it moved".
  const contract = createHash("sha256")
    .update(`${EXTRACTION_SYSTEM}\u0000${JSON.stringify(DESCRIPTOR_SCHEMA)}`, "utf8")
    .digest("hex")
    .slice(0, 16);

  test("EXTRACTOR_VERSION still covers the prompt and the field set it versions", () => {
    expect({ version: EXTRACTOR_VERSION, contract }).toEqual({
      version: 1,
      contract: "a68881b2ea90b315",
    });
  });
});
