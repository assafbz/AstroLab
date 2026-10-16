import { MIGRATIONS, migrate, openStore, seedDomainTaxonomy } from "@astrolab/store";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, test } from "vitest";

import { createApp } from "./server.js";

/**
 * The API (docs/API.md): bearer auth on every `/v1` route, one error envelope on every failure path,
 * and — since V1 (#12) — `POST /v1/ideas`. The guard here is the observable contract: no `/v1` path
 * answers without a token, and every failure is the envelope.
 */
const TOKEN = "test-token-2f8c1a";
const JSON_UTF8 = "application/json; charset=utf-8";

let server: Server;
let db: DatabaseSync;
let base: string;

beforeEach(async () => {
  db = openStore(":memory:");
  migrate(db, MIGRATIONS);
  server = createApp({ db });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  base = `http://127.0.0.1:${address.port}`;
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

async function call(
  method: string,
  path: string,
  options: { authorization?: string; json?: unknown } = {},
): Promise<Call> {
  const headers: Record<string, string> = {};
  if (options.authorization !== undefined) headers.authorization = options.authorization;
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

/** docs/API.md §2 — the one shape, and the only one, for every failure. */
function expectEnvelope(result: Call, status: number, code: string): void {
  expect(result.status).toBe(status);
  expect(result.contentType).toBe(JSON_UTF8);
  expect(result.body).toEqual({ error: { code, message: expect.any(String), details: null } });
}

const VALID = {
  hypothesis: "A single sentence",
  problem: "a problem",
  monetization: "a model",
  domain_tags: ["fintech"],
};

test("GET /healthz answers 200 with no auth", async () => {
  const result = await call("GET", "/healthz");
  expect(result.status).toBe(200);
  expect(result.contentType).toBe(JSON_UTF8);
  expect(result.body).toEqual({ status: "ok" });
});

test("a /v1 route rejects a missing token", async () => {
  expectEnvelope(await call("GET", "/v1/ideas"), 401, "unauthorized");
});

test("a /v1 route rejects a blank token", async () => {
  // `Bearer` with no value, and the scheme with only whitespace after it.
  expectEnvelope(await call("GET", "/v1/ideas", { authorization: "Bearer" }), 401, "unauthorized");
  expectEnvelope(
    await call("GET", "/v1/ideas", { authorization: "Bearer    " }),
    401,
    "unauthorized",
  );
  expectEnvelope(await call("GET", "/v1/ideas", { authorization: "" }), 401, "unauthorized");
});

test("a /v1 route rejects a wrong token", async () => {
  expectEnvelope(
    await call("GET", "/v1/ideas", { authorization: "Bearer not-the-token" }),
    401,
    "unauthorized",
  );
});

test("a non-Bearer scheme is rejected, not parsed", async () => {
  expectEnvelope(
    await call("GET", "/v1/ideas", { authorization: `Basic ${TOKEN}` }),
    401,
    "unauthorized",
  );
});

test("fails closed: with no configured API_TOKEN nothing authenticates", async () => {
  delete process.env.API_TOKEN;
  expectEnvelope(
    await call("GET", "/v1/ideas", { authorization: `Bearer ${TOKEN}` }),
    401,
    "unauthorized",
  );
});

test("fail-closed is scoped to /v1 — /healthz still answers with no token configured", async () => {
  delete process.env.API_TOKEN;
  const health = await call("GET", "/healthz");
  expect(health.status).toBe(200);
  expect(health.body).toEqual({ status: "ok" });
  expectEnvelope(await call("GET", "/v1/ideas"), 401, "unauthorized");
});

test("no path under /v1 answers anything but 401 without a valid token", async () => {
  // Auth is checked before routing, for the whole namespace — known routes, unknown routes, and the
  // bare prefix alike. An unauthenticated caller cannot tell which routes exist.
  for (const path of [
    "/v1",
    "/v1/",
    "/v1/ideas",
    "/v1/ideas/9f1c",
    "/v1/sparks",
    "/v1/sparks/state",
    "/v1/sparks/events",
    "/v1/sparks/9f1c",
    "/v1/vault/summary",
    "/v1/export",
    "/v1/nope",
    "/v1/does/not/exist",
  ]) {
    expectEnvelope(await call("GET", path), 401, "unauthorized");
  }
});

test("the namespace claim closes over encoded and duplicated-slash spellings", async () => {
  // F4 gated on the raw path, so `/v1%2Fideas` and `//v1/ideas` answered without a token. The shared
  // normaliser (decode, then collapse) gates on raw **or** normalized.
  expectEnvelope(await call("GET", "/v1%2Fideas"), 401, "unauthorized");
  expectEnvelope(await call("GET", "//v1/ideas"), 401, "unauthorized");
  expectEnvelope(await call("GET", "/%2Fv1/ideas"), 401, "unauthorized");
  // A malformed escape is still a `/v1` path: it must be the envelope, not a 500 and not a bare body.
  expectEnvelope(await call("GET", "/v1%"), 401, "unauthorized");
  expectEnvelope(await call("GET", "/v1%ZZ"), 401, "unauthorized");
});

test("authorized, the encoded spellings route to the same place or the envelope — never a 500", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  // V1 pinned the *gate* over both spellings; the router still works on the normalized string, so
  // once V2 (#13) implements `GET /v1/ideas` these spellings **route to it** rather than falling
  // through. That is the point of one normaliser: the router's input is the normalized path.
  const collapsed = await call("GET", "//v1/ideas", auth);
  expect(collapsed.status).toBe(200);
  expect(collapsed.body).toEqual({ ideas: [] });
  expect((await call("GET", "/v1%2Fideas", auth)).status).toBe(200);
  // A malformed escape decodes to nothing, so it stays outside every route.
  expectEnvelope(await call("GET", "/v1%", auth), 404, "not_found");
  expectEnvelope(await call("GET", "/v1%ZZ", auth), 404, "not_found");
});

test("an authorized but unimplemented /v1 route is the not_found envelope — never a 200", async () => {
  // W8 (#33) implemented `GET /v1/sparks/state` and `POST /v1/sparks/run`, K1 (#35) makes bare
  // `/v1/sparks` a route, V6 (#17) makes `/v1/export` one, and #118 makes `GET /v1/sparks/{id}` one;
  // each entry that pinned their *absence* is removed here as it lands (each has its own coverage
  // below). The `{id}` entry is replaced by the next *unclaimed* spark shape — §4.13's
  // `POST /v1/sparks/{id}/decision` (K6 #39) — so the envelope stays pinned for the shape still
  // without a route.
  for (const [method, path] of [
    ["POST", "/v1/sparks/9f1c/decision"],
    ["GET", "/v1"],
  ] as const) {
    expectEnvelope(
      await call(method, path, { authorization: `Bearer ${TOKEN}` }),
      404,
      "not_found",
    );
  }
});

/** W8 (#33) — `GET /v1/sparks/state` (§4.10) and `POST /v1/sparks/run` (§4.16). */
function seedSpread(): void {
  // Two ideas in two clusters, so E0's floor is out of the way and the run routes are observable.
  for (const [id, tag] of [
    ["a", "fintech"],
    ["b", "health"],
  ] as const) {
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1,
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(id, JSON.stringify([tag]));
  }
}

test("GET /v1/sparks/state answers EngineState, and E0 on an empty vault (§4.10)", async () => {
  const result = await call("GET", "/v1/sparks/state", { authorization: `Bearer ${TOKEN}` });
  expect(result.status).toBe(200);
  expect(result.contentType).toBe(JSON_UTF8);
  expect(result.body).toEqual({ state: "E0", unreviewed: 0, run: null });
});

test("GET /v1/sparks/state needs a token like every /v1 route (§1)", async () => {
  expectEnvelope(await call("GET", "/v1/sparks/state"), 401, "unauthorized");
});

test("GET /v1/sparks/events needs a token like every /v1 route (§1, §4.11)", async () => {
  // The SSE route is gated by the same `/v1` auth; an unauthenticated call never opens a stream.
  expectEnvelope(await call("GET", "/v1/sparks/events"), 401, "unauthorized");
});

test("POST /v1/sparks/run enqueues at the current revision and answers 202 (§4.16)", async () => {
  seedSpread();
  const result = await call("POST", "/v1/sparks/run", { authorization: `Bearer ${TOKEN}` });
  expect(result.status).toBe(202);
  expect(result.contentType).toBe(JSON_UTF8);
  expect(result.body).toMatchObject({ vault_revision: 0 });
  expect((result.body as { run_id: string }).run_id).toEqual(expect.any(String));
});

test("POST /v1/sparks/run is idempotent per revision — a repeat returns the same run (§4.16)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const first = await call("POST", "/v1/sparks/run", auth);
  const second = await call("POST", "/v1/sparks/run", auth);
  expect((second.body as { run_id: string }).run_id).toBe(
    (first.body as { run_id: string }).run_id,
  );
  // …and the enqueued run is visible as E1 through the state read.
  const state = await call("GET", "/v1/sparks/state", auth);
  expect(state.body).toMatchObject({ state: "E0", run: { status: "PENDING" } });
});

test("POST /v1/sparks/run needs a token, and its body is never read (§1, §4.16)", async () => {
  expectEnvelope(await call("POST", "/v1/sparks/run"), 401, "unauthorized");
  // A body is ignored, not validated: the route reads none, so garbage is not a 422.
  const result = await call("POST", "/v1/sparks/run", {
    authorization: `Bearer ${TOKEN}`,
    json: { unexpected: true },
  });
  expect(result.status).toBe(202);
});

test("the sparks routes dispatch by method — the wrong verb on a known path is the envelope (§2)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  expectEnvelope(await call("GET", "/v1/sparks/run", auth), 404, "not_found");
  expectEnvelope(await call("POST", "/v1/sparks/state", auth), 404, "not_found");
  expectEnvelope(await call("POST", "/v1/sparks", auth), 404, "not_found");
});

/** K1 (#35) — `GET /v1/sparks?state=offered`, the deck read (§4.9). */
test("GET /v1/sparks requires `state`, and only `offered` — bare is 422, never an unfiltered read", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  // Change A: a `Spark` carries no `status` (§3.3), so a read with no restriction is indistinguishable
  // from an offers read — it would hand back resolved sparks with nothing marking them. Missing, empty,
  // and out-of-enum are one status for two reasons (§2's mandatory field, §1's unknown enum), and the
  // comparison is case-sensitive.
  expectEnvelope(await call("GET", "/v1/sparks", auth), 422, "validation_failed");
  expectEnvelope(await call("GET", "/v1/sparks?state=", auth), 422, "validation_failed");
  expectEnvelope(await call("GET", "/v1/sparks?state=OFFERED", auth), 422, "validation_failed");
  expectEnvelope(await call("GET", "/v1/sparks?state=all", auth), 422, "validation_failed");
});

test("GET /v1/sparks?state=offered is the deck body — `{ sparks: [] }` on an empty vault (§4.9)", async () => {
  const result = await call("GET", "/v1/sparks?state=offered", {
    authorization: `Bearer ${TOKEN}`,
  });
  expect(result.status).toBe(200);
  expect(result.contentType).toBe(JSON_UTF8);
  expect(result.body).toEqual({ sparks: [] });
});

test("GET /v1/sparks?state=offered returns the live deck and never a resolved spark (§4.9)", async () => {
  // The data-bearing path *over HTTP*, at the W8 bar: the deck read returns §3.3's `Spark` for a live
  // offer and drops a resolved one, with `domain_tags` the pair-order union of the two source ideas.
  for (const [id, tag] of [
    ["a", "fintech"],
    ["b", "health"],
    ["c", "audio-dsp"],
  ] as const) {
    db.prepare(
      `INSERT INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
    ).run(id, JSON.stringify([tag]));
  }
  const spark = (id: string, a: string, b: string, status: string): void => {
    const [x, y] = [a, b].sort();
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, first_step, status,
                          created_at)
       VALUES (?, ?, ?, ?, 'a direction', 'a claim', 'a first step', ?, '2026-01-01T00:00:00Z')`,
    ).run(id, a, b, `${x}|${y}`, status);
  };
  spark("live", "a", "b", "OFFERED");
  spark("resolved", "a", "c", "RESOLVED-DISMISSED");

  const result = await call("GET", "/v1/sparks?state=offered", {
    authorization: `Bearer ${TOKEN}`,
  });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    sparks: [
      {
        id: "live",
        direction: "a direction",
        claim: "a claim",
        first_step: "a first step",
        domain_tags: ["fintech", "health"],
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
});

/** #118 — §4.12, `GET /v1/sparks/{id}`: the `SparkDetail` the S1b screen reads. */
function seedSparkDetail(sparkId: string, status: string, withDetail: boolean): void {
  for (const [id, tag] of [
    ["a", "fintech"],
    ["b", "health"],
  ] as const) {
    db.prepare(
      `INSERT OR IGNORE INTO idea (id, hypothesis, problem, monetization, domain_tags, lineage_kind,
                         lineage_parent_id, status, visibility, current_version, created_at, updated_at)
       VALUES (?, 'h', 'p', 'm', ?, 'ROOT', NULL, 'ACTIVE', 'PRIVATE', 1, 't', 't')`,
    ).run(id, JSON.stringify([tag]));
  }
  db.prepare(
    `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, first_step,
                        what_it_takes, status, created_at, mechanism, domain_distance,
                        structural_alignment)
     VALUES (?, 'a', 'b', ?, 'a direction', 'a claim', 'a first step', ?, ?, ?, '{"verb":"fuse"}', 2, 0.71)`,
  ).run(
    sparkId,
    `a|b|${sparkId}`,
    withDetail ? "what it takes" : null,
    status,
    "2026-01-01T00:00:00Z",
  );
}

test("GET /v1/sparks/{id} answers §4.12's SparkDetail — the deck's fields plus only `what_it_takes`", async () => {
  seedSparkDetail("s1", "OFFERED", true);

  const result = await call("GET", "/v1/sparks/s1", { authorization: `Bearer ${TOKEN}` });
  expect(result.status).toBe(200);
  // Exact: the selection internals are in the row and absent from the body, and the detail's whole
  // delta over `Spark` (§3.4) is present.
  expect(result.body).toEqual({
    id: "s1",
    direction: "a direction",
    claim: "a claim",
    first_step: "a first step",
    what_it_takes: "what it takes",
    domain_tags: ["fintech", "health"],
    created_at: "2026-01-01T00:00:00Z",
  });
});

test("GET /v1/sparks/{id} is status-blind — a resolved spark answers 200; only an unknown id is the envelope", async () => {
  seedSparkDetail("s-res", "RESOLVED-ACCEPTED", false);

  // §4.9's deck drops this row; §4.12 must not — the tap-back 404 the issue forbids.
  const read = await call("GET", "/v1/sparks/s-res", { authorization: `Bearer ${TOKEN}` });
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({ id: "s-res", what_it_takes: null });

  expectEnvelope(
    await call("GET", "/v1/sparks/9f1c-missing", { authorization: `Bearer ${TOKEN}` }),
    404,
    "not_found",
  );
});

test("the {id} shape claims exactly one segment — §4.13's `{id}/decision` and an empty id stay the envelope", async () => {
  // Seed a **real** spark, so a greedy matcher (which read `s1` out of `s1/decision`) would answer 200
  // here and this test would catch it; without the row both spellings 404 for the wrong reason.
  seedSparkDetail("s1", "OFFERED", true);
  const auth = { authorization: `Bearer ${TOKEN}` };

  expect((await call("GET", "/v1/sparks/s1", auth)).status).toBe(200);
  // K6 #39 owns `POST /v1/sparks/{id}/decision`; until it lands, a further segment is not a route.
  expectEnvelope(await call("POST", "/v1/sparks/s1/decision", auth), 404, "not_found");
  expectEnvelope(await call("GET", "/v1/sparks/s1/decision", auth), 404, "not_found");
  // The bare path with a trailing slash is neither the deck route nor a detail id.
  expectEnvelope(await call("GET", "/v1/sparks/", auth), 404, "not_found");
  // The reserved exact paths are matched **before** the `{id}` shape, so `state` is never a detail id.
  const state = await call("GET", "/v1/sparks/state", auth);
  expect(state.status).toBe(200);
  expect(state.body).toMatchObject({ state: "E0" });
});

test("a path outside /v1 is the envelope, and needs no token", async () => {
  expectEnvelope(await call("GET", "/"), 404, "not_found");
  expectEnvelope(await call("GET", "/nope"), 404, "not_found");
});

test("a non-GET method on /healthz does not answer 200", async () => {
  expectEnvelope(await call("POST", "/healthz"), 404, "not_found");
});

test("POST /v1/ideas with a valid body answers 201 with the Idea (§3.1)", async () => {
  const result = await call("POST", "/v1/ideas", {
    authorization: `Bearer ${TOKEN}`,
    json: VALID,
  });
  expect(result.status).toBe(201);
  expect(result.contentType).toBe(JSON_UTF8);
  expect(result.body).toMatchObject({
    hypothesis: VALID.hypothesis,
    problem: VALID.problem,
    monetization: VALID.monetization,
    domain_tags: VALID.domain_tags,
    lineage_kind: "ROOT",
    lineage_parent_id: null,
    status: "ACTIVE",
    visibility: "PRIVATE",
    current_version: 1,
  });
  const idea = result.body as { id: string; created_at: string };
  expect(idea.id).toEqual(expect.any(String));
  expect(idea.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("capture validation failures are the 422 envelope, one per branch", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  for (const body of [
    {},
    { ...VALID, hypothesis: "" },
    { ...VALID, problem: "" },
    { ...VALID, monetization: "" },
    { ...VALID, domain_tags: [] },
    { ...VALID, hypothesis: "x".repeat(281) },
    { ...VALID, origin_spark_id: "spark-1" },
  ]) {
    expectEnvelope(
      await call("POST", "/v1/ideas", { ...auth, json: body }),
      422,
      "validation_failed",
    );
  }
  // No `content-type`-less body at all is still the envelope.
  expectEnvelope(await call("POST", "/v1/ideas", auth), 422, "validation_failed");
});

test("a seeded capture with an unknown spark is the not_found envelope, and writes nothing", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  expectEnvelope(
    await call("POST", "/v1/ideas", {
      ...auth,
      json: { ...VALID, origin_spark_id: "missing", decision_id: "d-1" },
    }),
    404,
    "not_found",
  );
  const rows = db.prepare("SELECT COUNT(*) AS n FROM idea").get() as { n: number };
  expect(rows.n).toBe(0);
});

test("GET /v1/ideas answers the §4.4 shape, filters, and ignores unknown parameters", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  expect(await call("GET", "/v1/ideas", auth)).toEqual({
    status: 200,
    contentType: JSON_UTF8,
    body: { ideas: [] },
  });

  await call("POST", "/v1/ideas", { ...auth, json: { ...VALID, domain_tags: ["fintech"] } });
  await call("POST", "/v1/ideas", { ...auth, json: { ...VALID, domain_tags: ["health"] } });

  const all = (await call("GET", "/v1/ideas", auth)).body as { ideas: unknown[] };
  expect(all.ideas).toHaveLength(2);

  const filtered = (await call("GET", "/v1/ideas?domain=fintech&lineage=ROOT&status=ACTIVE", auth))
    .body as { ideas: Array<{ domain_tags: string[] }> };
  expect(filtered.ideas).toEqual([expect.objectContaining({ domain_tags: ["fintech"] })]);

  // Exact tag match: a prefix is not a match (§4.4), and an unknown parameter name is ignored (§1).
  expect((await call("GET", "/v1/ideas?domain=fin", auth)).body).toEqual({ ideas: [] });
  expect((await call("GET", "/v1/ideas?nope=1", auth)).status).toBe(200);
});

test("a filter value outside its enum, or empty, is the 422 envelope", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  for (const query of ["?lineage=NOPE", "?status=active", "?domain=", "?lineage="]) {
    expectEnvelope(await call("GET", `/v1/ideas${query}`, auth), 422, "validation_failed");
  }
});

test("GET /v1/ideas/{id} answers the §4.5 shape — provenance muted, empty sets not errors", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const created = await call("POST", "/v1/ideas", { ...auth, json: VALID });
  const { id } = created.body as { id: string };

  const detail = await call("GET", `/v1/ideas/${id}`, auth);
  expect(detail.status).toBe(200);
  expect(detail.contentType).toBe(JSON_UTF8);
  // The exact key set is the contract: no scores, no distance, no "related" readout (§0, §5 invariant 6).
  expect(detail.body).toEqual({
    idea: expect.objectContaining({ id, domain_tags: VALID.domain_tags }),
    versions: [expect.objectContaining({ version: 1 })],
    lineage: [],
    provenance: [],
    referenced_by: { forks: [], derived: [] },
  });
});

test("an unknown idea id is the not_found envelope", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  expectEnvelope(await call("GET", "/v1/ideas/9f1c-missing", auth), 404, "not_found");
});

test("the detail route reads the normalized path, so an encoded id still routes", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const created = await call("POST", "/v1/ideas", { ...auth, json: VALID });
  const { id } = created.body as { id: string };
  // The first character, percent-encoded — the normaliser decodes it, so this is the same id.
  const encoded = `%${id.charCodeAt(0).toString(16).padStart(2, "0")}${id.slice(1)}`;
  expect((await call("GET", `/v1/ideas/${encoded}`, auth)).status).toBe(200);
});

test("a path or method that is not a defined route is the not_found envelope (§2, §6)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  // `/v1/ideas/` resolves on the *client* router (`#/vault/`) but is not a server route, and a deeper
  // path is not one either — recorded in §6 so nobody "fixes" one side to match the other.
  expectEnvelope(await call("GET", "/v1/ideas/", auth), 404, "not_found");
  expectEnvelope(await call("GET", "/v1/ideas/a/b", auth), 404, "not_found");
  expectEnvelope(await call("POST", "/v1/ideas/9f1c", { ...auth, json: VALID }), 404, "not_found");
});

test("GET /v1/vault/summary answers the §3.2 shape — deterministic and provider-free", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  seedDomainTaxonomy(db); // what `api/src/index.ts` does at boot, before the first gate reads it
  expect(await call("GET", "/v1/vault/summary", auth)).toEqual({
    status: 200,
    contentType: JSON_UTF8,
    body: {
      resolved_domains: 0,
      provisional_domains: 0,
      target: 3,
      floor: 2,
      eligible: false,
    },
  });
});

test("the summary counts captured domains, collapsing two tags of one cluster (R1)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  seedDomainTaxonomy(db);

  // `#fintech` + `#banking` are both tags of the `fintech` cluster in the shipped file, so two ideas
  // are still **one** resolved domain and the gate stays shut — the collapse R1 exists to prevent.
  await call("POST", "/v1/ideas", { ...auth, json: { ...VALID, domain_tags: ["fintech"] } });
  const one = (await call("GET", "/v1/vault/summary", auth)).body;
  expect(one).toMatchObject({ resolved_domains: 1, provisional_domains: 0, eligible: false });

  await call("POST", "/v1/ideas", { ...auth, json: { ...VALID, domain_tags: ["banking"] } });
  const collapsed = (await call("GET", "/v1/vault/summary", auth)).body;
  expect(collapsed).toMatchObject({ resolved_domains: 1, eligible: false });

  // A genuinely different cluster clears the floor.
  await call("POST", "/v1/ideas", { ...auth, json: { ...VALID, domain_tags: ["health"] } });
  const spread = (await call("GET", "/v1/vault/summary", auth)).body;
  expect(spread).toMatchObject({ resolved_domains: 2, provisional_domains: 0, eligible: true });

  // A free-text lane is provisional and never counts toward the gate (§4.2/T02).
  await call("POST", "/v1/ideas", { ...auth, json: { ...VALID, domain_tags: ["defi-xyz"] } });
  const provisional = (await call("GET", "/v1/vault/summary", auth)).body;
  expect(provisional).toMatchObject({
    resolved_domains: 2,
    provisional_domains: 1,
    eligible: true,
  });
});

test("the summary route reads no query parameter, and only GET is a route", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  seedDomainTaxonomy(db);
  // §1: an unknown query parameter is ignored — and this route takes none at all.
  const ignored = await call("GET", "/v1/vault/summary?nope=1&domain=fintech", auth);
  expect(ignored.status).toBe(200);
  expect(ignored.body).toEqual({
    resolved_domains: 0,
    provisional_domains: 0,
    target: 3,
    floor: 2,
    eligible: false,
  });
  expectEnvelope(await call("POST", "/v1/vault/summary", auth), 404, "not_found");
  expectEnvelope(await call("GET", "/v1/vault/summary/", auth), 404, "not_found");
});

test("GET /v1/export answers §4.17 — the eight contract keys, top-level and in order", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const result = await call("GET", "/v1/export", auth);
  expect(result.status).toBe(200);
  expect(result.contentType).toBe(JSON_UTF8);
  // The body **is** the document: the eight keys are top-level (no wrapper), in §4.17's order. A
  // `domain_tags[]` that shipped misplaced or dropped is the defect §4.17 calls out, so the key set
  // and its order are asserted here rather than left to the unit read in `export.test.ts`.
  expect(Object.keys(result.body as object)).toEqual([
    "schema_version",
    "exported_at",
    "ideas",
    "idea_versions",
    "lineage_edges",
    "provenance_edges",
    "decisions",
    "domain_tags",
  ]);
  expect((result.body as { ideas: unknown[] }).ideas).toEqual([]);
});

test("GET /v1/export reads the live vault, not a static — a captured idea is present (§4.17)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  await call("POST", "/v1/ideas", { ...auth, json: VALID });
  const doc = (await call("GET", "/v1/export", auth)).body as {
    ideas: Array<{ hypothesis: string }>;
  };
  expect(doc.ideas.map((row) => row.hypothesis)).toEqual([VALID.hypothesis]);
});

test("the export route dispatches by method — only GET is a route (§2)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  expectEnvelope(await call("POST", "/v1/export", auth), 404, "not_found");
  expectEnvelope(await call("PUT", "/v1/export", auth), 404, "not_found");
  // The trailing-slash spelling is not the route — there is no third case (§2, §6).
  expectEnvelope(await call("GET", "/v1/export/", auth), 404, "not_found");
});

test("DELETE /v1/ideas/{id} answers 200, and the idea is gone from every read", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const created = await call("POST", "/v1/ideas", { ...auth, json: VALID });
  const { id } = created.body as { id: string };

  expect(await call("DELETE", `/v1/ideas/${id}`, auth)).toEqual({
    status: 200,
    contentType: JSON_UTF8,
    body: { deleted: true, id },
  });
  expectEnvelope(await call("GET", `/v1/ideas/${id}`, auth), 404, "not_found");
  expect((await call("GET", "/v1/ideas", auth)).body).toEqual({ ideas: [] });
});

test("an unknown id — and a repeat delete — are the not_found envelope (§2: the id is unknown)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  expectEnvelope(await call("DELETE", "/v1/ideas/9f1c-missing", auth), 404, "not_found");

  const created = await call("POST", "/v1/ideas", { ...auth, json: VALID });
  const { id } = created.body as { id: string };
  expect((await call("DELETE", `/v1/ideas/${id}`, auth)).status).toBe(200);
  // Not idempotent by design: once the row is gone the id is unknown, and §2 answers that with 404.
  expectEnvelope(await call("DELETE", `/v1/ideas/${id}`, auth), 404, "not_found");
});

test("a delete needs a token, and only a `{id}` path is a route", async () => {
  expectEnvelope(await call("DELETE", "/v1/ideas/9f1c"), 401, "unauthorized");

  const auth = { authorization: `Bearer ${TOKEN}` };
  // The list path has no DELETE route, and neither does a bare or deeper path — §2, no third case.
  expectEnvelope(await call("DELETE", "/v1/ideas", auth), 404, "not_found");
  expectEnvelope(await call("DELETE", "/v1/ideas/", auth), 404, "not_found");
  expectEnvelope(await call("DELETE", "/v1/ideas/a/b", auth), 404, "not_found");

  // The method dispatch is real, not a fall-through: on a path that *does* name a live idea, a
  // method with no route there is still the envelope — if the dispatch ignored the method, this PUT
  // would delete the idea and answer 200.
  const created = await call("POST", "/v1/ideas", { ...auth, json: VALID });
  const { id } = created.body as { id: string };
  expectEnvelope(await call("PUT", `/v1/ideas/${id}`, { ...auth, json: VALID }), 404, "not_found");
  expect((await call("GET", `/v1/ideas/${id}`, auth)).status).toBe(200);
});

test("the delete retracts a live offer naming the idea, and keeps a resolved one", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const first = await call("POST", "/v1/ideas", { ...auth, json: VALID });
  const second = await call("POST", "/v1/ideas", { ...auth, json: VALID });
  const a = (first.body as { id: string }).id;
  const b = (second.body as { id: string }).id;
  const seedSpark = (sparkId: string, status: string): void => {
    db.prepare(
      `INSERT INTO spark (id, idea_a_id, idea_b_id, pair_key, direction, claim, status, created_at)
       VALUES (?, ?, ?, ?, 'd', 'c', ?, 't')`,
    ).run(sparkId, a, b, `${a}|${b}|${sparkId}`, status);
  };
  seedSpark("live", "OFFERED");
  seedSpark("resolved", "RESOLVED-DISMISSED");

  expect((await call("DELETE", `/v1/ideas/${a}`, auth)).status).toBe(200);

  // A live offer is a promise made from the current vault state, so it goes; the resolved one is
  // history and keeps its (now dangling) pair.
  const left = db.prepare("SELECT id FROM spark ORDER BY id").all() as Array<{ id: string }>;
  expect(left).toEqual([{ id: "resolved" }]);
});

test("capture stores domain tags raw — no normalisation, no `domain_map` write (ARCH §3.2)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  seedDomainTaxonomy(db);

  // An unmapped tag reaches the vault verbatim and stays provisional: the write path resolves no
  // cluster and reaches no model (W4). Only capture's own trim applies — never a lower-case or a
  // cluster lookup; the boundary guard is the structural half of this.
  const created = await call("POST", "/v1/ideas", {
    ...auth,
    json: { ...VALID, domain_tags: ["defi-xyz", "  Raw Case "] },
  });
  expect(created.status).toBe(201);
  expect((created.body as { domain_tags: string[] }).domain_tags).toEqual(["defi-xyz", "Raw Case"]);

  const mapped = db
    .prepare("SELECT count(*) AS n FROM domain_map WHERE tag IN ('defi-xyz', 'Raw Case')")
    .get() as { n: number };
  expect(mapped.n).toBe(0);
  // And the summary still reads both as provisional — the vault path never collapsed them.
  expect((await call("GET", "/v1/vault/summary", auth)).body).toMatchObject({
    resolved_domains: 0,
    provisional_domains: 2,
  });
});

/**
 * V3 (#14) — `POST /v1/ideas/{id}/iterate` (`docs/API.md` §4.6). The contract-level half of the
 * write: `200` (not `201`), the bumped `current_version`, the version history read back through
 * §4.5, and the envelope on every failure — including a non-`POST` on the same path.
 */
const EDITED = {
  hypothesis: "a refined sentence",
  problem: "a sharper problem",
  monetization: "a clearer model",
  domain_tags: ["health"],
};

/** A captured idea's id, via the one route that creates them. */
async function capture(auth: { authorization: string }): Promise<string> {
  const created = await call("POST", "/v1/ideas", { ...auth, json: VALID });
  return (created.body as { id: string }).id;
}

test("POST /v1/ideas/{id}/iterate answers 200 with the bumped Idea, and the history reads back", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const id = await capture(auth);

  const iterated = await call("POST", `/v1/ideas/${id}/iterate`, { ...auth, json: EDITED });
  expect(iterated.status).toBe(200); // §4.6 — an update, not a creation
  expect(iterated.contentType).toBe(JSON_UTF8);
  expect(iterated.body).toMatchObject({
    id,
    ...EDITED,
    lineage_kind: "ROOT", // no lineage edge — iteration is a version, not a branch (L1)
    lineage_parent_id: null,
    current_version: 2,
  });

  // Prior versions are readable through §4.5's `versions`, ascending, the current one included.
  const detail = await call("GET", `/v1/ideas/${id}`, auth);
  expect(detail.body).toMatchObject({
    idea: { current_version: 2, hypothesis: EDITED.hypothesis },
    versions: [
      { version: 1, hypothesis: VALID.hypothesis },
      { version: 2, hypothesis: EDITED.hypothesis },
    ],
    lineage: [],
  });
  // Still one node in the vault — an iteration adds no idea.
  expect((await call("GET", "/v1/ideas", auth)).body).toEqual({
    ideas: [expect.objectContaining({ id })],
  });
});

test("iterate of an unknown id is the not_found envelope, and writes nothing", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const before = db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get() as {
    revision: number;
  };

  expectEnvelope(
    await call("POST", "/v1/ideas/9f1c-missing/iterate", { ...auth, json: EDITED }),
    404,
    "not_found",
  );

  expect(db.prepare("SELECT count(*) AS n FROM idea").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get()).toEqual(before);
});

test("iterate checks the body before the id — malformed on an unknown id is 422, not 404 (§6)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  // The id does not exist; only the order of the two checks decides this answer. A malformed body
  // is the failure, whatever the id, so the request never reaches the lookup.
  expectEnvelope(
    await call("POST", "/v1/ideas/9f1c-missing/iterate", { ...auth, json: {} }),
    422,
    "validation_failed",
  );
  // The same unknown id with a valid body is the not_found envelope — the id is consulted second,
  // not ignored. Both attempts leave the vault untouched.
  expectEnvelope(
    await call("POST", "/v1/ideas/9f1c-missing/iterate", { ...auth, json: EDITED }),
    404,
    "not_found",
  );
  expect(db.prepare("SELECT count(*) AS n FROM idea").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
});

test("iterate validation failures are the 422 envelope, one per branch", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const id = await capture(auth);
  for (const body of [
    {},
    { ...EDITED, hypothesis: "" },
    { ...EDITED, problem: "" },
    { ...EDITED, monetization: "" },
    { ...EDITED, domain_tags: [] },
    { ...EDITED, hypothesis: "x".repeat(281) },
  ]) {
    expectEnvelope(
      await call("POST", `/v1/ideas/${id}/iterate`, { ...auth, json: body }),
      422,
      "validation_failed",
    );
  }
  // No body at all is a missing mandatory field, not a parse error — the same envelope.
  expectEnvelope(await call("POST", `/v1/ideas/${id}/iterate`, auth), 422, "validation_failed");
});

test("iterate needs a token — the gate is checked before routing", async () => {
  expectEnvelope(
    await call("POST", "/v1/ideas/9f1c/iterate", { json: EDITED }),
    401,
    "unauthorized",
  );
});

test("only POST on `{id}/iterate` is a route; anything else is the envelope (§2, §6)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const id = await capture(auth);
  expectEnvelope(await call("GET", `/v1/ideas/${id}/iterate`, auth), 404, "not_found");
  expectEnvelope(await call("DELETE", `/v1/ideas/${id}/iterate`, auth), 404, "not_found");
  expectEnvelope(
    await call("POST", `/v1/ideas/${id}/nope`, { ...auth, json: EDITED }),
    404,
    "not_found",
  );
  expectEnvelope(await call("POST", `/v1/ideas/a/b`, { ...auth, json: EDITED }), 404, "not_found");
  // The method dispatch is real: a GET on the detail path still reads, it does not fall through.
  expect((await call("GET", `/v1/ideas/${id}`, auth)).status).toBe(200);
});

/**
 * V4 (#15) — `POST /v1/ideas/{id}/fork` (`docs/API.md` §4.7). The contract-level half: `201` with a new
 * `FORK` node whose text is the parent's and whose domains are the request's; the `409` that offers
 * Iterate; the `404`/`422` envelopes; the pinned check order; and the gate on the path.
 */
const FORK = { mutation_delta: "into a healthcare scheduler", domain_tags: ["health"] };

test("POST /v1/ideas/{id}/fork answers 201 with the new FORK Idea, and the chain reads back", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const parent = await capture(auth);

  const forked = await call("POST", `/v1/ideas/${parent}/fork`, { ...auth, json: FORK });
  expect(forked.status).toBe(201); // §4.7 — a fork creates
  expect(forked.contentType).toBe(JSON_UTF8);
  const child = (forked.body as { id: string }).id;
  expect(child).not.toBe(parent);
  expect(forked.body).toMatchObject({
    hypothesis: VALID.hypothesis, // copied from the parent — not in the request
    problem: VALID.problem,
    monetization: VALID.monetization,
    domain_tags: ["health"], // the request's
    lineage_kind: "FORK",
    lineage_parent_id: parent,
    current_version: 1,
  });
  // The delta is stored (write-only in the MVP: §3.1's `Idea` has no field for it).
  expect(db.prepare("SELECT mutation_delta AS d FROM idea WHERE id = ?").get(child)).toEqual({
    d: FORK.mutation_delta,
  });
  // Two nodes now; the child's chain is its parent and it carries no provenance.
  expect((await call("GET", `/v1/ideas/${child}`, auth)).body).toMatchObject({
    lineage: [{ id: parent, lineage_kind: "ROOT" }],
    provenance: [],
  });
  // And the parent now names the child as a fork — the T26 warning's source (§4.5).
  expect((await call("GET", `/v1/ideas/${parent}`, auth)).body).toMatchObject({
    referenced_by: { forks: [child], derived: [] },
  });
});

test("a same-domain fork is the 409 conflict envelope, and writes nothing", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const parent = await capture(auth); // domain_tags ["fintech"], which already bumped the revision
  // The capture left one idea and one queued run; the refusal must add neither and move no revision.
  const before = db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get();
  const runs = db.prepare("SELECT count(*) AS n FROM spark_run").get();

  expectEnvelope(
    await call("POST", `/v1/ideas/${parent}/fork`, {
      ...auth,
      json: { ...FORK, domain_tags: ["fintech"] },
    }),
    409,
    "conflict",
  );

  expect(db.prepare("SELECT count(*) AS n FROM idea").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT count(*) AS n FROM spark_run").get()).toEqual(runs);
  expect(db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get()).toEqual(before);
});

test("fork of an unknown id is the not_found envelope, and writes nothing", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const before = db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get();

  expectEnvelope(
    await call("POST", "/v1/ideas/9f1c-missing/fork", { ...auth, json: FORK }),
    404,
    "not_found",
  );

  expect(db.prepare("SELECT count(*) AS n FROM idea").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT revision FROM vault_meta WHERE id = 1").get()).toEqual(before);
});

test("fork checks the body before the id — malformed on an unknown id is 422, not 404 (§6)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  expectEnvelope(
    await call("POST", "/v1/ideas/9f1c-missing/fork", { ...auth, json: {} }),
    422,
    "validation_failed",
  );
  expectEnvelope(
    await call("POST", "/v1/ideas/9f1c-missing/fork", { ...auth, json: FORK }),
    404,
    "not_found",
  );
  expect(db.prepare("SELECT count(*) AS n FROM idea").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT count(*) AS n FROM spark_run").get()).toEqual({ n: 0 });
});

test("fork validation failures are the 422 envelope, one per branch", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const parent = await capture(auth);
  for (const body of [
    {},
    { domain_tags: ["health"] },
    { mutation_delta: "  ", domain_tags: ["health"] },
    { mutation_delta: "d" },
    { mutation_delta: "d", domain_tags: [] },
    { mutation_delta: "d", domain_tags: ["ok", 7] },
  ]) {
    expectEnvelope(
      await call("POST", `/v1/ideas/${parent}/fork`, { ...auth, json: body }),
      422,
      "validation_failed",
    );
  }
  // No body at all is a missing mandatory field, not a parse error — the same envelope.
  expectEnvelope(await call("POST", `/v1/ideas/${parent}/fork`, auth), 422, "validation_failed");
});

test("fork needs a token — the gate is checked before routing", async () => {
  expectEnvelope(await call("POST", "/v1/ideas/9f1c/fork", { json: FORK }), 401, "unauthorized");
});

test("only POST on `{id}/fork` is a route; anything else is the envelope (§2, §6)", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  const id = await capture(auth);
  expectEnvelope(await call("GET", `/v1/ideas/${id}/fork`, auth), 404, "not_found");
  expectEnvelope(await call("DELETE", `/v1/ideas/${id}/fork`, auth), 404, "not_found");
});
