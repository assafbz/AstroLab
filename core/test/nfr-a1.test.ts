import { expect, test } from "vitest";

import type { SqliteConnection } from "../src/store/connection.js";
import { openNodeStore } from "../src/store/connection.node.js";
import {
  claimNextRun,
  finishRun,
  MIGRATIONS,
  migrate,
  seedDomainTaxonomy,
} from "../src/store/index.js";
import {
  captureIdea,
  type CaptureInput,
  type Idea,
  type IdeaFields,
} from "../src/vault/capture.js";
import { deleteIdea } from "../src/vault/delete.js";
import { engineState } from "../src/vault/engine-state.js";
import { forkIdea } from "../src/vault/fork.js";
import { getIdeaDetail, listIdeas, parseVaultFilters } from "../src/vault/ideas.js";
import { iterateIdea } from "../src/vault/iterate.js";

/**
 * EV3 (#45) — **NFR-A1, the fault injection** (`PRD.md` §4 NFR-A1; `ARCHITECTURE.md` §4; `FLOW.md` §5.6;
 * `ADR-0004` amended; the L1 carry-over table's *"A1 fault-injection … keeps its shape"*).
 *
 * The criterion is a conjunction — *with the provider disabled the vault works **and** S1 shows E4* —
 * and in v2 it is one process, so this file owns the half a **core** can observe: every vault operation,
 * in-process, in exactly the state a provider-disabled run leaves behind. The v1 form drove the same
 * operations over HTTP against `api/src/server.ts`; the transport retired with the server, the
 * operations did not, and neither did the claims.
 *
 * The other halves stay **attributed, not restated**. The injection itself — *a provider that cannot be
 * built fails runs, never the boot* — is L3's (`worker/src/compose.test.ts` today, `core/provider`'s
 * own suite after L3), and the deck's E4 render is L2's. What is left here is the conjunction:
 * **the vault suite running inside that state**, with no provider anywhere in it.
 *
 * | # | claim | read from | the fixture that fails it |
 * | :-- | :-- | :-- | :-- |
 * | 1 | the provider-disabled vault is the state the deck renders as E4 | `engineState` | the same vault with its run still claimed — **E1**, not E4 (the second test) |
 * | 2 | every vault operation passes in that state | capture · list · detail · iterate · fork · delete, in-process | a vault use-case that reaches the engine — it would throw where these answer |
 * | 3 | the pass is not vacuous | the rows each operation answers with | an empty vault, where every call answers and none is exercised |
 *
 * **0 provider calls** — no path here can reach one, and that is checked rather than promised: the
 * structural guard (`core/test/boundary-a1.test.ts`) fails if any `core/src/vault/**` module ever
 * imports `core/src/provider/**` or `core/src/engine/**`. So this file exercises the boundary; that
 * file holds it.
 *
 * **Why the run is settled by hand.** With the provider down, *every* run fails. `settleProviderDown`
 * claims the queued row and writes its terminal `FAILED` — the order `runOnce` uses (claim → body →
 * finish) with the body skipped, because the body's single job here is to fail and the row it leaves is
 * the row a real failure leaves. No engine is constructed, so none is needed.
 */

/** Two shipped clusters — above the domain floor *and* the idea floor, so E0 is out of the way. */
const PICKED = ["fintech", "health"] as const;

/** The construction error `createAdapterFromEnv` raises with no key — the string an unavailable run
 * rethrows from its body (`worker/src/provider/openrouter.ts`). */
const PROVIDER_DOWN = "OPENROUTER_API_KEY is not set";

/** A fresh migrated, seeded in-memory vault — the schema and vocabulary `main` ships. */
function newDb(): SqliteConnection {
  const db = openNodeStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db); // what the app's composition root does at boot, before the first read
  return db;
}

/** §4.2's mandatory fields (`FLOW.md` §4.2 T02), the blank-capture shape (`origin`/`decision` null). */
function fields(n: number, domainTag: string): IdeaFields {
  return {
    hypothesis: `hypothesis ${n}`,
    problem: `problem ${n}`,
    monetization: `monetization ${n}`,
    domain_tags: [domainTag],
  };
}

/** One capture — and a §4 trigger: `vaultMutation` stamps the revision and enqueues. */
function capture(db: SqliteConnection, n: number, domainTag: string): Idea {
  const input: CaptureInput = { ...fields(n, domainTag), origin_spark_id: null, decision_id: null };
  return captureIdea(db, input);
}

/** A vault at or above both floors: two ideas, two distinct shipped clusters. */
function seedSpread(db: SqliteConnection): Idea[] {
  return [capture(db, 1, PICKED[0]), capture(db, 2, PICKED[1])];
}

/**
 * Settles the queued run the way a provider-disabled driver settles it: claim the `PENDING` row the
 * mutation enqueued, write its terminal row, leave nothing in flight — E4's signal. Called again after
 * every mutating operation below, because with the provider down *every* run fails: the vault is
 * exercised with the engine down throughout, not merely once at the start.
 */
function settleProviderDown(db: SqliteConnection): void {
  const run = claimNextRun(db);
  if (run === null) throw new Error("expected a queued run to settle");
  finishRun(db, run.id, "FAILED", PROVIDER_DOWN);
}

function count(db: SqliteConnection, sql: string, ...params: string[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

test("claim 1 — a provider-disabled vault is the state the deck renders as E4", () => {
  const db = newDb();
  seedSpread(db);
  settleProviderDown(db);

  // `run: null` matters as much as the name: E4 is *no run in flight* **and** the last one FAILED.
  expect(engineState(db)).toEqual({ state: "E4", unreviewed: 0, run: null, cause: null });

  // The failed run wrote nothing, so the vault it failed over is intact — which is what makes claim 2's
  // pass below a pass *over a real vault* rather than over an empty one (claim 3).
  expect(listIdeas(db, parseVaultFilters(new URLSearchParams()))).toHaveLength(PICKED.length);
});

test("claim 1 discriminates — the same vault with its run still in flight reads E1, not E4", () => {
  const db = newDb();
  seedSpread(db);

  // The only difference from the test above is that the run has not finished. If E4 keyed on "a run
  // exists" or on the vault's shape, this fixture would satisfy it too; it is the run's *outcome* that
  // carries the state, which is why the injection above is what claim 1 is about.
  expect(claimNextRun(db)).not.toBeNull();
  expect(engineState(db).state).toBe("E1");
});

test("claim 2 — every vault operation passes with the provider disabled (NFR-A1's vault suite)", () => {
  const db = newDb();
  const seeded = seedSpread(db);
  settleProviderDown(db);

  /** Asserted before *every* operation, so no call is proved in some other state by accident. */
  const assertEngineDown = (): void => {
    expect(engineState(db).state, "the engine is not down for this operation").toBe("E4");
  };

  assertEngineDown();

  // §4.2 capture — a write, and the §4 trigger that widens the candidate set. The write committed and
  // enqueued: it answered without a run completing, and the queue holds the revision it stamped.
  const created = capture(db, 3, "mobility");
  expect(created.lineage_kind).toBe("ROOT");
  expect(count(db, "SELECT COUNT(*) AS n FROM spark_run WHERE status = 'PENDING'")).toBe(1);
  settleProviderDown(db);
  assertEngineDown();

  // §4.4 list and §4.5 detail — the reads the Vault renders. Asserted over the *content*, so a call that
  // answered nothing fails here rather than passing vacuously (claim 3).
  const listed = listIdeas(db, parseVaultFilters(new URLSearchParams()));
  expect(listed.map((idea) => idea.id)).toContain(created.id);
  const detail = getIdeaDetail(db, created.id);
  expect(detail?.idea.id).toBe(created.id);
  expect(detail?.versions.map((version) => version.version)).toEqual([1]);

  // §4.6 iterate — the same node, a new version.
  const iterated = iterateIdea(db, created.id, fields(4, "mobility"));
  expect(iterated.id).toBe(created.id);
  expect(iterated.current_version).toBe(2);
  settleProviderDown(db);
  assertEngineDown();

  // §4.7 fork — a new node, the parent copied, the domain set differing by construction.
  const forked = forkIdea(db, created.id, {
    mutation_delta: "narrow it to dispatch",
    domain_tags: ["legal-compliance"],
  });
  expect(forked.lineage_parent_id).toBe(created.id);
  settleProviderDown(db);
  assertEngineDown();

  // §4.8 delete — orphan-with-warning: the vault never blocks and never asks.
  expect(deleteIdea(db, created.id)).toBe(true);
  settleProviderDown(db);
  assertEngineDown();

  // The writes landed and stayed landed while the engine kept failing: the fork is its own node, the
  // deleted id is gone, and the vault holds the two seeded ideas plus the fork.
  expect(count(db, "SELECT COUNT(*) AS n FROM idea WHERE id = ?", created.id)).toBe(0);
  expect(count(db, "SELECT COUNT(*) AS n FROM idea")).toBe(seeded.length + 1);
});
