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
    "/v1/sparks/state",
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
  for (const [method, path] of [
    ["GET", "/v1/sparks"],
    ["GET", "/v1/sparks/state"],
    ["POST", "/v1/sparks/run"],
    ["GET", "/v1/export"],
    ["GET", "/v1"],
  ] as const) {
    expectEnvelope(
      await call(method, path, { authorization: `Bearer ${TOKEN}` }),
      404,
      "not_found",
    );
  }
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
