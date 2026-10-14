import { MIGRATIONS, migrate, openStore } from "@astrolab/store";
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
