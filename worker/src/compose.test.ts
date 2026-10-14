import type { DatabaseSync } from "node:sqlite";

import {
  currentVaultRevision,
  MIGRATIONS,
  migrate,
  openStore,
  seedDomainTaxonomy,
  stampAndEnqueue,
} from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { createEngineFromEnv } from "./compose.js";
import { type ChatResponse, type Transport, type ZdrPinnedRequest } from "./provider/index.js";
import { runOnce } from "./queue.js";

/**
 * The composition root (W8 #33, D4). Two properties a reading cannot make true, so they are asserted:
 * the four stages really are composed (a run **offers** a spark end to end, through a scripted
 * transport — not merely constructs), and a provider that cannot be built **fails runs, never the
 * boot** (§5.6 → E4), writing nothing.
 *
 * The last test pins the coupling the module docstring names: the composition's model must be the
 * adapter's model, because `idea_mechanism.source_hash` covers it — if the root hardcoded the default
 * there, a second model would serve the first model's cached descriptor.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  // Seeded so `fintech`/`health` resolve to clusters without a normalisation call: this file is about
  // the wiring, and W4's normalisation path is `domain.test.ts`'s subject.
  seedDomainTaxonomy(db);
  return db;
}

function seedIdea(db: DatabaseSync, id: string, tags: string[]): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, `hyp-${id}`, `prob-${id}`, `mon-${id}`, JSON.stringify(tags));
}

const DESCRIPTOR = JSON.stringify({
  verb: "batch",
  object_class: "meals",
  constraint: "one cook session",
  transferable_structure: "amortise a fixed cost across many units",
});

const DRAFT = JSON.stringify({
  shared_mechanism: "amortising a fixed setup cost",
  direction: "Batch the setup step",
  claim: "Both amortise one setup across many units",
  what_it_takes: "A batching scheduler",
  first_step: "Group jobs by setup key",
});

/** A transport that answers by schema name and records every request — the adapter's only seam. */
function fakeTransport(): { transport: Transport; requests: ZdrPinnedRequest[] } {
  const requests: ZdrPinnedRequest[] = [];
  const reply = (content: string): ChatResponse => ({ choices: [{ message: { content } }] });
  return {
    requests,
    transport: {
      async send(request) {
        requests.push(request);
        switch (request.response_format.json_schema.name) {
          case "mechanism_descriptor":
            return reply(DESCRIPTOR);
          case "spark_adjudication":
            return reply(DRAFT);
          case "domain_cluster":
            return reply(JSON.stringify({ cluster_id: "fintech" }));
          default:
            throw new Error(`unexpected schema: ${request.response_format.json_schema.name}`);
        }
      },
    },
  };
}

const schemaNames = (request: ZdrPinnedRequest): string => request.response_format.json_schema.name;

function sparkRows(
  db: DatabaseSync,
): Array<{ pair_key: string; status: string; direction: string }> {
  return db
    .prepare("SELECT pair_key, status, direction FROM spark ORDER BY pair_key")
    .all() as Array<{ pair_key: string; status: string; direction: string }>;
}

function runRows(db: DatabaseSync): Array<{ status: string; error: string | null }> {
  return db.prepare("SELECT status, error FROM spark_run ORDER BY vault_revision").all() as Array<{
    status: string;
    error: string | null;
  }>;
}

describe("createEngineFromEnv — the four stages, composed (D4)", () => {
  test("a built provider composes end to end: the run offers a spark through the scripted transport", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);
    const { transport, requests } = fakeTransport();
    const engine = createEngineFromEnv(db, { env: {}, transport }); // an injected transport needs no key
    stampAndEnqueue(db);

    const result = await runOnce(db, engine.body, engine.commit);

    expect(result?.error).toBeNull();
    expect(result?.discarded).toBe(false);
    expect(sparkRows(db)).toEqual([
      { pair_key: "a|b", status: "OFFERED", direction: "Batch the setup step" },
    ]);
    // The wiring is real, not merely constructible: one extraction per idea, then one adjudication.
    expect(requests.map(schemaNames)).toEqual([
      "mechanism_descriptor",
      "mechanism_descriptor",
      "spark_adjudication",
    ]);
  });

  test("the adapter's model is the composition's model — the descriptor cache follows AI_MODEL", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);

    const first = fakeTransport();
    const engineA = createEngineFromEnv(db, {
      env: { AI_MODEL: "vendor/model-a" },
      transport: first.transport,
    });
    stampAndEnqueue(db);
    await runOnce(db, engineA.body, engineA.commit);
    expect(first.requests.map(schemaNames)).toEqual(["mechanism_descriptor"]);
    expect(first.requests[0]?.model).toBe("vendor/model-a");

    // Same vault, same text, a *different* model: the hash covers the model, so the cache must MISS.
    // A root that hardcoded DEFAULT_MODEL for the producer would serve model-a's descriptor here.
    const second = fakeTransport();
    const engineB = createEngineFromEnv(db, {
      env: { AI_MODEL: "vendor/model-b" },
      transport: second.transport,
    });
    stampAndEnqueue(db);
    await runOnce(db, engineB.body, engineB.commit);
    expect(second.requests.map(schemaNames)).toEqual(["mechanism_descriptor"]);
    expect(second.requests[0]?.model).toBe("vendor/model-b");
  });
});

describe("a provider that cannot be built fails runs, never the boot (§5.6 → E4)", () => {
  const UNAVAILABLE: Array<[string, Record<string, string>, RegExp]> = [
    ["no API key", {}, /OPENROUTER_API_KEY/],
    ["an unsupported AI_PROVIDER", { AI_PROVIDER: "anthropic" }, /AI_PROVIDER/],
  ];

  for (const [label, env, message] of UNAVAILABLE) {
    test(`${label}: the root does not throw, and the run is FAILED with that error`, async () => {
      const db = newDb();
      seedIdea(db, "a", ["fintech"]);
      seedIdea(db, "b", ["health"]);

      expect(() => createEngineFromEnv(db, { env })).not.toThrow();
      const engine = createEngineFromEnv(db, { env });
      stampAndEnqueue(db);

      const result = await runOnce(db, engine.body, engine.commit);

      expect(result?.error).toMatch(message);
      expect(runRows(db)).toEqual([{ status: "FAILED", error: expect.stringMatching(message) }]);
      // Nothing was written by the unavailable path: no offer, no suppression, and the revision is
      // exactly the one `stampAndEnqueue` set — a failed run never churns the vault (NFR-A1).
      expect(sparkRows(db)).toEqual([]);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM suppressed_pair").get() as { n: number }).n,
      ).toBe(0);
      expect(currentVaultRevision(db)).toBe(1);
    });
  }
});
