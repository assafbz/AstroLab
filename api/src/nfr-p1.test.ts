import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, migrate, openStore, seedDomainTaxonomy } from "@astrolab/store";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createApp } from "./server.js";

/**
 * EV4 (#46) — **NFR-P1**, the **enqueue posture** half (`PRD.md` §4 NFR-P1; `FLOW.md` §4.2 T04).
 *
 * In production the API never runs a run body: `POST /v1/sparks/run` stamps a revision, enqueues a
 * `PENDING` row and answers `202`, and the worker drains the queue in another process. So this file
 * asserts exactly what an API can observe — that the enqueue is a **posture, not a result**, and that
 * every vault route answers with a run outstanding. The coupled in-flight measurement (the layer that
 * could actually block, `node:sqlite` being synchronous) is `worker/src/nfr-p1.test.ts`; together the
 * two are the claim. **0 provider calls** — no vault path can reach one (`worker/src/provider/boundary.test.ts`).
 *
 * The latency figure is an **absolute** bound, not a ratio: the baseline here is µs-scale, and a ratio
 * against noise flakes (the ruling on this issue). A run that a vault route waited on would not be
 * slow — it would **hang**, and the test would time out.
 */

const TOKEN = "test-token-ev4-7a31";
const JSON_UTF8 = "application/json; charset=utf-8";

let server: Server;
let db: DatabaseSync;
let base: string;

beforeEach(async () => {
  db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  seedDomainTaxonomy(db);
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

/** Two ideas in two resolved clusters, so the vault is eligible and a run is meaningful. */
async function seedVault(): Promise<string> {
  const first = await call("POST", "/v1/ideas", {
    json: { hypothesis: "h", problem: "p", monetization: "m", domain_tags: ["fintech"] },
  });
  await call("POST", "/v1/ideas", {
    json: { hypothesis: "h2", problem: "p2", monetization: "m2", domain_tags: ["health"] },
  });
  return (first.body as { id: string }).id;
}

function runRow(id: string | null = null): { status: string; error: string | null } {
  const sql =
    id === null
      ? "SELECT status, error FROM spark_run ORDER BY rowid DESC LIMIT 1"
      : "SELECT status, error FROM spark_run WHERE id = ?";
  const row = (id === null ? db.prepare(sql).get() : db.prepare(sql).get(id)) as
    { status: string; error: string | null } | undefined;
  if (row === undefined) throw new Error("no spark_run row");
  return row;
}

/** p95 of a sample, nearest-rank — a diagnostic, never the requirement. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/** One pass over every vault route, returning each request's latency in ms. */
async function sweepVaultRoutes(ideaId: string): Promise<number[]> {
  const ms: number[] = [];
  const timed = async (run: () => Promise<Call>): Promise<void> => {
    const started = performance.now();
    const result = await run();
    ms.push(performance.now() - started);
    expect(result.status).toBeLessThan(500); // answered, not an error envelope
  };
  await timed(() => call("GET", "/v1/ideas"));
  await timed(() => call("GET", `/v1/ideas/${ideaId}`));
  await timed(() => call("GET", "/v1/vault/summary"));
  await timed(() => call("GET", "/v1/sparks/state"));
  await timed(() =>
    call("POST", "/v1/ideas", {
      json: { hypothesis: "x", problem: "y", monetization: "z", domain_tags: ["devtools"] },
    }),
  );
  return ms;
}

test("POST /v1/sparks/run is an enqueue, not a result — 202 before any spark exists", async () => {
  await seedVault();

  const enqueued = await call("POST", "/v1/sparks/run");
  expect(enqueued.status).toBe(202);
  expect(enqueued.contentType).toBe(JSON_UTF8);
  // The enqueue stamps the vault's current revision (two captures ⇒ 2), not a constant.
  expect((enqueued.body as { vault_revision: number }).vault_revision).toBeGreaterThan(0);
  const runId = (enqueued.body as { run_id: string }).run_id;
  expect(runId).toEqual(expect.any(String));

  // Nothing was computed on the request's path: the vault holds no spark, and the run is still queued.
  expect((db.prepare("SELECT COUNT(*) AS n FROM spark").get() as { n: number }).n).toBe(0);
  expect(runRow(runId)).toEqual({ status: "PENDING", error: null });
  // …and the state read reports the queue truthfully: computing, so not Cold (`FLOW.md` §4.1 C2).
  expect((await call("GET", "/v1/sparks/state")).body).toMatchObject({
    state: "E1",
    run: { status: "PENDING" },
  });
});

test("a run enqueued does not hold the vault: every vault route answers, at baseline", async () => {
  const ideaId = await seedVault();
  const PASSES = 24;

  // Baseline: the same routes, no run outstanding.
  const baseline: number[] = [];
  for (let i = 0; i < PASSES; i++) baseline.push(...(await sweepVaultRoutes(ideaId)));

  // Now a run is outstanding for the whole measured window. Nothing drains it in this process — which
  // is the point: a vault route that awaited the engine would hang here rather than be merely slow.
  const enqueued = await call("POST", "/v1/sparks/run");
  expect(enqueued.status).toBe(202);

  const inFlight: number[] = [];
  for (let i = 0; i < PASSES; i++) inFlight.push(...(await sweepVaultRoutes(ideaId)));

  const baseP95 = p95(baseline);
  const flightP95 = p95(inFlight);
  console.log(
    `[nfr-p1] vault routes · baseline p95 ${baseP95.toFixed(2)} ms · with a run queued ` +
      `${flightP95.toFixed(2)} ms (n=${inFlight.length})`,
  );

  // Absolute bound, primary: these are localhost SQLite reads. A ratio against a µs baseline flakes.
  expect(flightP95).toBeLessThan(250);
  // Floored ratio as a secondary — it can only fire well above the absolute bound (ruling's shape).
  expect(flightP95).toBeLessThanOrEqual(Math.max(5 * baseP95, baseP95 + 25));

  // The vault never waited on the queue. Each capture in the sweep stamps a revision and **supersedes**
  // the outstanding PENDING run (§4 / I), so the row under the latest stamp is the one to read — the
  // original `runId` is legitimately gone by now, replaced rather than blocked behind.
  expect(runRow().status).toBe("PENDING");
});
