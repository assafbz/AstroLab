import type { SqliteConnection } from "../src/store/connection.js";

import { openNodeStore } from "../src/store/connection.node.js";
import {
  currentVaultRevision,
  MIGRATIONS,
  migrate,
  seedDomainTaxonomy,
  stampAndEnqueue,
} from "../src/store/index.js";
import { describe, expect, test } from "vitest";

import { engineFromProvider } from "../src/engine/compose.js";
import { runOnce } from "../src/engine/queue.js";
import {
  ProviderError,
  type IdeaText,
  type MechanismDescriptor,
  type Provider,
  type SparkDraft,
} from "../src/provider/index.js";

/**
 * The composition root (W8 #33, D4; L3 · #166). Two properties a reading cannot make true, so they
 * are asserted: the four stages really are composed — a run **offers** a spark end to end through the
 * composed gate/cache/adjudicator, not merely constructs — and a provider that **fails** fails only
 * its run, writing nothing (§5.6 → E4, NFR-A1).
 *
 * The provider here is a hand-written stub rather than the real adapter: this file is about the
 * *wiring*, and the adapter's own behaviour (key resolution, the ZDR pin, invalid output) is
 * `provider/openrouter.test.ts`'s and the failure taxonomy's subject (T4). What the stub must not do
 * is hide the model coupling: `idea_mechanism.source_hash` covers the model, so the cache must MISS
 * when the composition's model changes — that is the second test.
 */

function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  // Seeded so `fintech`/`health` resolve to clusters without a normalisation call: this file is about
  // the wiring, and W4's normalisation path is `domain.test.ts`'s subject.
  seedDomainTaxonomy(db);
  return db;
}

function seedIdea(db: SqliteConnection, id: string, tags: string[]): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
  ).run(id, `hyp-${id}`, `prob-${id}`, `mon-${id}`, JSON.stringify(tags));
}

/** One descriptor for every idea, so the pair clears Axis 2's alignment gate. */
const DESCRIPTOR: MechanismDescriptor = {
  verb: "batch",
  object_class: "meals",
  constraint: "one cook session",
  transferable_structure: "amortise a fixed cost across many units",
};

const DRAFT: SparkDraft = {
  mechanism: "amortising a fixed setup cost",
  direction: "Batch the setup step",
  claim: "Both amortise one setup across many units",
  what_it_takes: "A batching scheduler",
  first_step: "Group jobs by setup key",
};

/** The stub provider: every call recorded, each operation's reply fixed. */
function stubProvider(over: { extract?: (idea: IdeaText) => Promise<MechanismDescriptor> } = {}): {
  provider: Provider;
  ops: string[];
} {
  const ops: string[] = [];
  return {
    ops,
    provider: {
      async extract(idea: IdeaText): Promise<MechanismDescriptor> {
        ops.push("extract");
        return over.extract !== undefined ? over.extract(idea) : DESCRIPTOR;
      },
      async adjudicate(): Promise<SparkDraft | null> {
        ops.push("adjudicate");
        return DRAFT;
      },
      // Never reached on this file's vaults (both tags resolve from the seeded taxonomy) — and it
      // throws rather than guessing, so a wiring change that started resolving tags shows up here.
      async normalizeTag(): Promise<string> {
        ops.push("normalizeTag");
        throw new Error("unexpected normalizeTag call");
      },
    },
  };
}

function sparkRows(
  db: SqliteConnection,
): Array<{ pair_key: string; status: string; direction: string }> {
  return db
    .prepare("SELECT pair_key, status, direction FROM spark ORDER BY pair_key")
    .all() as Array<{ pair_key: string; status: string; direction: string }>;
}

function runRows(db: SqliteConnection): Array<{ status: string; error: string | null }> {
  return db.prepare("SELECT status, error FROM spark_run ORDER BY vault_revision").all() as Array<{
    status: string;
    error: string | null;
  }>;
}

describe("engineFromProvider — the four stages, composed (D4)", () => {
  test("a run offers a spark end to end: one extraction per idea, then one adjudication", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);
    const { provider, ops } = stubProvider();
    const engine = engineFromProvider(db, provider, "vendor/model-a");
    stampAndEnqueue(db);

    const result = await runOnce(db, engine.body, engine.commit);

    expect(result?.error).toBeNull();
    expect(result?.discarded).toBe(false);
    expect(sparkRows(db)).toEqual([
      { pair_key: "a|b", status: "OFFERED", direction: "Batch the setup step" },
    ]);
    // The wiring is real, not merely constructible.
    expect(ops).toEqual(["extract", "extract", "adjudicate"]);
  });

  test("the descriptor cache follows the model — the producer identity is the composition's", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);

    const first = stubProvider();
    const engineA = engineFromProvider(db, first.provider, "vendor/model-a");
    stampAndEnqueue(db);
    await runOnce(db, engineA.body, engineA.commit);
    expect(first.ops).toEqual(["extract", "extract", "adjudicate"]);

    // Same vault, same text, the **same** model: the cache hits, so no extraction is paid again —
    // and the pair is already settled, so §3.5's re-offer rule reaches no adjudication either. Both
    // zeros together are the claim: nothing was recomputed and nothing was re-offered.
    const again = stubProvider();
    const engineAgain = engineFromProvider(db, again.provider, "vendor/model-a");
    stampAndEnqueue(db);
    await runOnce(db, engineAgain.body, engineAgain.commit);
    expect(again.ops).toEqual([]);

    // A *different* model: the hash covers the model, so the cache must MISS. A composition that
    // resolved the model a second way (v1 read `AI_MODEL` in two places) would serve the stale row.
    const second = stubProvider();
    const engineB = engineFromProvider(db, second.provider, "vendor/model-b");
    stampAndEnqueue(db);
    await runOnce(db, engineB.body, engineB.commit);
    // Both descriptors are re-paid (the cache missed on the model), and still no adjudication.
    expect(second.ops).toEqual(["extract", "extract"]);
  });
});

describe("a provider that fails fails the run, never the vault (§5.6 → E4)", () => {
  test("the run is FAILED with the provider's message, and nothing is written (NFR-A1)", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);
    const { provider } = stubProvider({
      extract: () => Promise.reject(new ProviderError("OPENROUTER_API_KEY is not set")),
    });
    const engine = engineFromProvider(db, provider, "vendor/model-a");
    stampAndEnqueue(db);

    const result = await runOnce(db, engine.body, engine.commit);

    expect(result?.error).toMatch(/OPENROUTER_API_KEY/);
    expect(runRows(db)).toEqual([
      { status: "FAILED", error: expect.stringMatching(/OPENROUTER_API_KEY/) },
    ]);
    // No offer, no suppression, no sweep — and the revision `stampAndEnqueue` set is untouched.
    expect(sparkRows(db)).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM suppressed_pair").get() as { n: number }).n).toBe(
      0,
    );
    expect(currentVaultRevision(db)).toBe(1);
  });
});
