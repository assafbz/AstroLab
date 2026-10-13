import type { Server } from "node:http";

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

import { createApp } from "./server.js";

/**
 * F4 (docs/API.md): the skeleton — HTTP/JSON, bearer auth on every `/v1` route, and **one** error
 * envelope on every failure path. The resource endpoints are the V, O and K issues, so the guard here
 * is that no `/v1` route answers 200 — not that any particular resource works.
 */
const TOKEN = "test-token-2f8c1a";
const JSON_UTF8 = "application/json; charset=utf-8";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  process.env.API_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.API_TOKEN;
});

interface Call {
  status: number;
  contentType: string | null;
  body: unknown;
}

async function call(method: string, path: string, authorization?: string): Promise<Call> {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  const res = await fetch(`${base}${path}`, { method, headers });
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: await res.json(),
  };
}

/** docs/API.md §2 — the one shape, and the only one, for every failure. */
function expectEnvelope(result: Call, status: number, code: string): void {
  expect(result.status).toBe(status);
  expect(result.contentType).toBe(JSON_UTF8);
  expect(result.body).toEqual({ error: { code, message: expect.any(String), details: null } });
}

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
  expectEnvelope(await call("GET", "/v1/ideas", "Bearer"), 401, "unauthorized");
  expectEnvelope(await call("GET", "/v1/ideas", "Bearer    "), 401, "unauthorized");
  expectEnvelope(await call("GET", "/v1/ideas", ""), 401, "unauthorized");
});

test("a /v1 route rejects a wrong token", async () => {
  expectEnvelope(await call("GET", "/v1/ideas", "Bearer not-the-token"), 401, "unauthorized");
});

test("a non-Bearer scheme is rejected, not parsed", async () => {
  expectEnvelope(await call("GET", "/v1/ideas", `Basic ${TOKEN}`), 401, "unauthorized");
});

test("fails closed: with no configured API_TOKEN nothing authenticates", async () => {
  delete process.env.API_TOKEN;
  expectEnvelope(await call("GET", "/v1/ideas", `Bearer ${TOKEN}`), 401, "unauthorized");
});

test("fail-closed is scoped to /v1 — /healthz still answers with no token configured", async () => {
  delete process.env.API_TOKEN;
  const health = await call("GET", "/healthz");
  expect(health.status).toBe(200);
  expect(health.body).toEqual({ status: "ok" });
  expectEnvelope(await call("GET", "/v1/ideas"), 401, "unauthorized");
});

test("an authorized but unimplemented /v1 route is the not_found envelope — never a 200", async () => {
  for (const [method, path] of [
    ["GET", "/v1/ideas"],
    ["POST", "/v1/ideas"],
    ["GET", "/v1/sparks"],
    ["GET", "/v1/sparks/state"],
    ["POST", "/v1/sparks/run"],
    ["GET", "/v1/export"],
    ["GET", "/v1"],
  ] as const) {
    expectEnvelope(await call(method, path, `Bearer ${TOKEN}`), 404, "not_found");
  }
});

test("a path outside /v1 is the envelope, and needs no token", async () => {
  expectEnvelope(await call("GET", "/"), 404, "not_found");
  expectEnvelope(await call("GET", "/nope"), 404, "not_found");
});

test("a non-GET method on /healthz does not answer 200", async () => {
  expectEnvelope(await call("POST", "/healthz"), 404, "not_found");
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
