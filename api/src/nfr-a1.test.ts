import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import {
  claimNextRun,
  finishRun,
  MIGRATIONS,
  migrate,
  openStore,
  seedDomainTaxonomy,
} from "@astrolab/store";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createApp } from "./server.js";

/**
 * EV3 (#45) — **NFR-A1: the fault injection** (`docs/PRD.md` §4 NFR-A1; `docs/ARCHITECTURE.md` §4,
 * §11 A1; `docs/FLOW.md` §5.6; `ADR-0004`).
 *
 * The criterion is a conjunction — *with the provider disabled the vault suite passes **and** S1 shows
 * E4* — and it spans three packages, so this file owns the half an **api** can observe: every vault
 * operation, over HTTP, in exactly the state a provider-disabled boot produces. The other halves are
 * **attributed, not restated**. The ruling on #45's thread is *one **construction site**, not one
 * file*: a second declaration of the same env/seed/expectation is the second harness the issue names.
 *
 * | half | authored at | why it is not here |
 * | :-- | :-- | :-- |
 * | the injection — a provider that cannot be built fails runs, never the boot | `worker/src/compose.test.ts`, `describe("a provider that cannot be built fails runs, never the boot (§5.6 → E4)")` — the repo's only site that constructs a provider-disabled engine | `api/package.json` depends on `@astrolab/store` only and `api/tsconfig.json` sets `rootDir: "src"`, so the provider is unreachable here by **package boundary**, not by convention |
 * | *S1 shows E4* | `client/src/screens/Sparks.test.tsx` (K2 `#36`, extended by K7 `#41`) | the deck's E4 render is already proved against `stubDeck({ state: state("E4", n) })`; a second E4 renderer is the drift the issue exists to prevent |
 *
 * What is left for this file is the **conjunction**: the vault suite running *inside* that state.
 *
 * | # | claim | read from | the fixture that fails it |
 * | :-- | :-- | :-- | :-- |
 * | 1 | the provider-disabled vault is the state the deck renders as E4 | `GET /v1/sparks/state` | the same vault with its run still claimed — **E1**, not E4 (the second test) |
 * | 2 | every vault operation passes in that state | §4.2 capture · §4.4 list · §4.5 detail · §4.6 iterate · §4.7 fork · §4.8 delete, over HTTP | a vault route that consults the engine — it would throw where these answer (plant recorded in the PR) |
 * | 3 | the pass is not vacuous | the rows each operation answers with | an empty vault, where every route answers and none of them is exercised |
 *
 * **0 provider calls** — no path here can reach one. `worker/src/provider/boundary.test.ts` holds the
 * AI-boundary import edge, and every route exercised is the vault's.
 */

const TOKEN = "test-token-ev3-8f05";
const JSON_UTF8 = "application/json; charset=utf-8";

/** Two shipped clusters — above the domain floor *and* above the idea floor, so E0 is out of the way
 * (`api/src/engine-state.ts:104`). Without the spread the vault reads E0 whatever the run did. */
const PICKED = ["fintech", "health"] as const;

/** The construction error `createAdapterFromEnv` raises with no key — the string the unavailable
 * engine rethrows from the run body (`worker/src/provider/openrouter.ts:239`). */
const PROVIDER_DOWN = "OPENROUTER_API_KEY is not set";

let server: Server;
let db: DatabaseSync;
let base: string;

beforeEach(async () => {
  db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db); // what `api/src/index.ts` does at boot, before the first gate reads it
  server = createApp({ db });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  base = `http://localhost:${address.port}`;
  process.env.API_TOKEN = TOKEN;
});

afterEach(async () => {
  delete process.env.API_TOKEN;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Call {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function call(method: string, path: string, options: { json?: unknown } = {}): Promise<Call> {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: text === "" ? null : JSON.parse(text),
  };
}

/** §4.2's body — the four mandatory fields (`FLOW.md` §4.2 T02). */
function ideaFields(n: number, domainTag: string): Record<string, unknown> {
  return {
    hypothesis: `hypothesis ${n}`,
    problem: `problem ${n}`,
    monetization: `monetization ${n}`,
    domain_tags: [domainTag],
  };
}

interface Idea {
  id: string;
  status: string;
  domain_tags: string[];
  lineage_kind: string;
  lineage_parent_id: string | null;
  current_version: number;
}

/** One capture, over HTTP (§4.2) — and a §4 trigger: `vaultMutation` stamps the revision and enqueues. */
async function capture(n: number, domainTag: string): Promise<Idea> {
  const result = await call("POST", "/v1/ideas", { json: ideaFields(n, domainTag) });
  expect(result.status).toBe(201);
  return result.body as Idea;
}

async function listIdeas(): Promise<Idea[]> {
  const result = await call("GET", "/v1/ideas");
  expect(result.status).toBe(200);
  expect(result.contentType).toBe(JSON_UTF8);
  return (result.body as { ideas: Idea[] }).ideas;
}

interface State {
  state: string;
  unreviewed: number;
  run: unknown;
}

async function readState(): Promise<State> {
  const result = await call("GET", "/v1/sparks/state");
  expect(result.status).toBe(200);
  expect(result.contentType).toBe(JSON_UTF8);
  return result.body as State;
}

/** A vault at/above both floors: two ideas, two distinct shipped clusters. */
async function seedSpread(): Promise<Idea[]> {
  return [await capture(1, PICKED[0]), await capture(2, PICKED[1])];
}

/**
 * Settles the queued run the way a provider-disabled worker settles it: claim the `PENDING` row — the
 * §4 trigger a vault mutation stamps and enqueues (`vaultMutation` → `stampAndEnqueue`) — write its
 * terminal row, and leave nothing in flight. That is E4's signal (`api/src/engine-state.ts:109`).
 *
 * The claim → finish order is `runOnce`'s (`worker/src/queue.ts`); the **body in between is not run
 * here** — what it would throw is the construction error `worker/src/compose.test.ts` injects, and the
 * row this leaves is the row that injection leaves. Called again after every mutating operation below,
 * because with the provider down *every* run fails: the vault is exercised with the engine down
 * throughout, not merely once at the start.
 */
function settleProviderDown(database: DatabaseSync): void {
  const run = claimNextRun(database);
  if (run === null) throw new Error("expected a queued run to settle");
  finishRun(database, run.id, "FAILED", PROVIDER_DOWN);
}

test("claim 1 — the provider-disabled vault is the state the deck renders as E4", async () => {
  await seedSpread();
  settleProviderDown(db);

  const state = await readState();
  // `run: null` matters as much as the name: E4 is *no run in flight* **and** the last one FAILED.
  expect(state).toEqual({ state: "E4", unreviewed: 0, run: null });

  // The failed run wrote nothing, so the vault it failed over is intact — which is what makes claim
  // 2's pass below a pass *over a real vault* rather than over an empty one (claim 3).
  expect(await listIdeas()).toHaveLength(PICKED.length);
});

test("claim 1 discriminates — the same vault with its run claimed reads E1, not E4", async () => {
  await seedSpread();

  // The only difference from the test above is that the run has not finished. If E4 were asserted on
  // "a run exists" or on the vault's shape, this fixture would pass it too; it is the run's *outcome*
  // that carries the state, which is why the injection above is what claim 1 is about.
  expect(claimNextRun(db)).not.toBeNull();
  expect((await readState()).state).toBe("E1");
});

test("claim 2 — every vault operation passes with the provider disabled (NFR-A1's vault suite)", async () => {
  const seeded = await seedSpread();
  settleProviderDown(db);

  /** The vault reads E4 — asserted before *every* operation below, so no route is proved in some other
   * state by accident: with the provider down, the engine is down for the whole suite. */
  async function assertEngineDown(): Promise<void> {
    expect((await readState()).state).toBe("E4");
  }

  await assertEngineDown();

  // §4.2 capture — a write, and the §4 trigger that widens the candidate set.
  const created = await capture(3, "mobility");
  expect(created.lineage_kind).toBe("ROOT");
  // The write committed and enqueued: it answered without a run completing, and the queue holds the
  // revision it stamped (`store/src/runs.ts` — one `PENDING` run, supersession included).
  expect(db.prepare("SELECT COUNT(*) AS n FROM spark_run WHERE status = 'PENDING'").get()).toEqual({
    n: 1,
  });
  settleProviderDown(db);
  await assertEngineDown();

  // §4.4 list and §4.5 detail — the reads the Vault renders. Asserted over the *content*, so a route
  // that answered `200` with nothing fails here rather than passing vacuously (claim 3).
  const listed = await listIdeas();
  expect(listed.map((idea) => idea.id)).toContain(created.id);
  const detail = await call("GET", `/v1/ideas/${created.id}`);
  expect(detail.status).toBe(200);
  expect((detail.body as { idea: Idea }).idea.id).toBe(created.id);

  // §4.6 iterate — the same node, a new version.
  const iterated = await call("POST", `/v1/ideas/${created.id}/iterate`, {
    json: ideaFields(4, "mobility"),
  });
  expect(iterated.status).toBe(200);
  expect((iterated.body as Idea).current_version).toBe(2);
  settleProviderDown(db);
  await assertEngineDown();

  // §4.7 fork — a new node, the parent copied verbatim, the domain set differing by construction.
  const forked = await call("POST", `/v1/ideas/${created.id}/fork`, {
    json: { mutation_delta: "narrow it to dispatch", domain_tags: ["legal-compliance"] },
  });
  expect(forked.status).toBe(201);
  expect((forked.body as Idea).lineage_parent_id).toBe(created.id);
  settleProviderDown(db);
  await assertEngineDown();

  // §4.8 delete — orphan-with-warning: the server never blocks and never asks.
  const deleted = await call("DELETE", `/v1/ideas/${created.id}`);
  expect(deleted.status).toBe(200);
  expect(deleted.body).toEqual({ deleted: true, id: created.id });
  settleProviderDown(db);
  await assertEngineDown();

  // The writes landed and stayed landed while the engine kept failing: the fork is its own node, the
  // deleted id is gone, and the vault holds the two seeded ideas plus the fork.
  expect(db.prepare("SELECT COUNT(*) AS n FROM idea WHERE id = ?").get(created.id)).toEqual({
    n: 0,
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM idea").get()).toEqual({ n: seeded.length + 1 });
});
