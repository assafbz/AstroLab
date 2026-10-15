import type { DatabaseSync } from "node:sqlite";

import {
  currentVaultRevision,
  MIGRATIONS,
  migrate,
  openStore,
  seedDomainTaxonomy,
  seedGateConfig,
  stampAndEnqueue,
  vaultMutation,
} from "@astrolab/store";
import { describe, expect, test } from "vitest";

import { engineFromProvider } from "./compose.js";
import {
  ProviderError,
  type MechanismDescriptor,
  type Provider,
  type SparkDraft,
} from "./provider/index.js";
import { runOnce } from "./queue.js";

/**
 * EV4 (#46) — **NFR-P1**, bounded delivery & non-blocking (`PRD.md` §4 NFR-P1; `FLOW.md` §5.6).
 *
 * NFR-P1 is two properties: spark results are produced **asynchronously and never block vault
 * operations**, and they are delivered **within a bounded time at expected personal vault sizes**.
 * This file measures both against the **real** composition (`engineFromProvider`: the real gate, the
 * real descriptor cache, the real adjudicator, the real suppression) over a stub provider — so the
 * pipeline under test is the one that ships, and the injected delay/failure is the only synthetic
 * thing. **0 provider calls**; no network is reachable from this file.
 *
 * The vault side is measured at the **store** level, not the HTTP level, because that is the layer
 * that could actually block: `node:sqlite` is synchronous, so a run body that held a transaction (or a
 * `BEGIN`) across its `await` would block the next vault write. In production the API never runs a
 * body at all — the enqueue posture is `api/src/nfr-p1.test.ts`, and the two halves together are the
 * claim.
 */

function newDb(): DatabaseSync {
  const db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db); // `fintech` / `health` resolve; this path never calls `normalizeTag`
  seedGateConfig(db);
  return db;
}

/** The shape `insertIdea` writes, as the store's own tests seed it. */
function seedIdea(db: DatabaseSync, id: string, tags: string[], status = "ACTIVE"): void {
  db.prepare(
    `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                       lineage_parent_id, status, visibility, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ROOT', NULL, ?, 'PRIVATE', 1, 't', 't')`,
  ).run(id, `hyp-${id}`, `prob-${id}`, `mon-${id}`, JSON.stringify(tags), status);
}

/**
 * A `spark_run` row, read back **by id**: `runOnce` returns the claim-time snapshot, and the newest row
 * is not necessarily this run's — a vault write during the run stamps a revision and enqueues its
 * successor (§4 / I).
 */
function runRow(db: DatabaseSync, id: string): { status: string; error: string | null } {
  return db.prepare("SELECT status, error FROM spark_run WHERE id = ?").get(id) as {
    status: string;
    error: string | null;
  };
}

/** One descriptor for every idea, so every **cross-cluster** pair clears Axis 2's alignment gate. */
const DESCRIPTOR: MechanismDescriptor = {
  verb: "route",
  object_class: "overflow",
  constraint: "peak load",
  transferable_structure: "overflow rerouted into a parallel channel",
};

const DRAFT: SparkDraft = {
  mechanism: "spill a peak into a parallel channel",
  direction: "batch the cook",
  claim: "one setup, many servings",
  what_it_takes: "a shared batch",
  first_step: "pilot one batch",
};

interface StubOptions {
  /** Injected provider latency, ms — applied to **every** operation. */
  delayMs?: number;
  /** Signals that a call has entered and is parked; the run body is provably mid-flight after this. */
  onEntered?: () => void;
  onExtract?: () => void;
  onAdjudicate?: () => void;
  /** The injected failure: `adjudicate` throws, as the adapter's mapping would. */
  failAdjudicate?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function stubProvider(options: StubOptions = {}): Provider {
  const pause = async (): Promise<void> => {
    options.onEntered?.();
    if (options.delayMs !== undefined) await sleep(options.delayMs);
  };
  return {
    async extract() {
      await pause();
      options.onExtract?.();
      return DESCRIPTOR;
    },
    async adjudicate() {
      await pause();
      options.onAdjudicate?.();
      if (options.failAdjudicate) throw new ProviderError("adjudicate unavailable");
      return DRAFT;
    },
    async normalizeTag() {
      // Every fixture tag is a shipped cluster key, so the distance axis resolves it from `domain_map`
      // and this never runs. Throwing (not returning a guess) keeps that a fact, not an assumption.
      throw new Error("normalizeTag was called — the fixture must use mapped cluster tags only");
    },
  };
}

describe("EV4 #46 — NFR-P1, injected delay and failure (`PRD.md` §4)", () => {
  test("an in-flight run never blocks the vault: a write and a read answer while the body is parked", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);
    stampAndEnqueue(db);

    // A real injected delay (≳ 500 ms, so "not blocked" is unambiguous) **and** an entry signal, so the
    // vault ops below run inside a window this test has proved the body is parked in — never after it
    // resolved, which is how a "not blocked" claim passes vacuously.
    let entered!: () => void;
    const enteredP = new Promise<void>((resolve) => (entered = resolve));
    const engine = engineFromProvider(
      db,
      stubProvider({ delayMs: 750, onEntered: () => entered() }),
      "stub-model",
    );

    const started = Date.now();
    const running = runOnce(db, engine.body, engine.commit);
    await enteredP; // the body is parked now — it cannot reach its commit before this test's ops

    // The vault's own transaction primitive, on the same synchronous connection the API uses. A body
    // that held a transaction across its `await` would make this throw ("cannot start a transaction
    // within a transaction"); a body holding a lock on a second handle would surface `SQLITE_BUSY`.
    // Either way the assertion below is not "it was fast", it is "it was allowed to run at all".
    const opStart = performance.now();
    vaultMutation(db, () => {
      seedIdea(db, "c", ["devtools"]);
      return null;
    });
    const read = db.prepare("SELECT COUNT(*) AS n FROM idea").get() as { n: number };
    const opMs = performance.now() - opStart;
    expect(read.n).toBe(3);

    const result = await running;
    const totalMs = Date.now() - started;

    expect(runRow(db, result!.run.id).status).toBe("DONE");
    // Absolute bound on the vault ops (a ratio against a µs baseline flakes); the injected delay is far
    // larger, and the run's own wall clock proves the delay was real — not that it resolved first.
    expect(opMs).toBeLessThan(250);
    expect(totalMs).toBeGreaterThanOrEqual(700);
  });

  test("an injected provider failure fails only the run — the vault is untouched", async () => {
    const db = newDb();
    seedIdea(db, "a", ["fintech"]);
    seedIdea(db, "b", ["health"]);
    const before = {
      revision: currentVaultRevision(db),
      ideas: (db.prepare("SELECT COUNT(*) AS n FROM idea").get() as { n: number }).n,
    };
    stampAndEnqueue(db);
    const enqueuedAt = currentVaultRevision(db);

    const engine = engineFromProvider(db, stubProvider({ failAdjudicate: true }), "stub-model");
    const result = await runOnce(db, engine.body, engine.commit);

    expect(runRow(db, result!.run.id).status).toBe("FAILED");
    expect(runRow(db, result!.run.id).error).toContain("adjudicate unavailable");
    expect(result?.outcome).toBeNull();
    expect(result?.error).toContain("adjudicate unavailable");

    // `FAILED` writes nothing (the commit runs only on a successful, still-current body): no offer, no
    // noise, no further revision, and every idea still there.
    expect((db.prepare("SELECT COUNT(*) AS n FROM spark").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM suppressed_pair").get() as { n: number }).n).toBe(
      0,
    );
    expect(currentVaultRevision(db)).toBe(enqueuedAt);
    expect((db.prepare("SELECT COUNT(*) AS n FROM idea").get() as { n: number }).n).toBe(
      before.ideas,
    );
  });

  test("≤ 500 ideas, a responsive provider: delivered inside the 60 s bar, one extract per idea", async () => {
    const db = newDb();
    const IDEAS = 500;
    const clusters = ["fintech", "health"];
    for (let i = 0; i < IDEAS; i++) {
      seedIdea(db, `i${String(i).padStart(3, "0")}`, [clusters[i % clusters.length]!]);
    }
    stampAndEnqueue(db);

    let extracts = 0;
    let adjudications = 0;
    const engine = engineFromProvider(
      db,
      stubProvider({ onExtract: () => extracts++, onAdjudicate: () => adjudications++ }),
      "stub-model",
    );

    const started = performance.now();
    const result = await runOnce(db, engine.body, engine.commit);
    const elapsedMs = performance.now() - started;

    expect(runRow(db, result!.run.id).status).toBe("DONE");
    // The Delivery clause. One run is one sample — this is a wall clock against the bar, not a p95.
    expect(elapsedMs).toBeLessThanOrEqual(60_000);
    // D4's O(ideas) property, the bound that makes the wall clock legible: the cache is read once per
    // idea (500), never once per pair (124,750 at this size).
    expect(extracts).toBeLessThanOrEqual(IDEAS);
    // …and the descriptor is **paid once per idea**: the cache holds one row per idea after the run,
    // which is what makes a 500-idea vault cost 500 extracts and not 124,750.
    const cached = db.prepare("SELECT COUNT(*) AS n FROM idea_mechanism").get() as { n: number };
    expect(cached.n).toBe(IDEAS);
    expect(adjudications).toBeGreaterThan(0);
    const offers = db.prepare("SELECT COUNT(*) AS n FROM spark WHERE status = 'OFFERED'").get() as {
      n: number;
    };
    expect(offers.n).toBe(adjudications);
    console.log(
      `[nfr-p1] ${IDEAS} ideas · ${Math.round(elapsedMs)} ms · ${extracts} extracts · ` +
        `${adjudications} gated pairs → ${offers.n} offers`,
    );
    // The worst case for volume — a stub that confirms every gated pair, so the run writes one offer
    // per pair (62,500 here). The 60 s bar is the assertion above; this only has to be larger than it,
    // so the *bar* is what reports, not a harness timeout.
  }, 120_000);
});
