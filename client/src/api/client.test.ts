import { afterEach, expect, test, vi } from "vitest";

import { ApiError, apiRequest, apiToken } from "./client.ts";

/** A stubbed `fetch` whose calls the test can inspect. */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("apiToken is the configured VITE_API_TOKEN, or empty when unset", () => {
  expect(apiToken()).toBe("");
  vi.stubEnv("VITE_API_TOKEN", "t");
  expect(apiToken()).toBe("t");
});

test("apiRequest sends the bearer when a token is configured", async () => {
  vi.stubEnv("VITE_API_TOKEN", "t");
  const fetchMock = stubFetch(() => Promise.resolve(json({ ideas: [] })));

  await apiRequest("/v1/ideas");

  const [, init] = fetchMock.mock.calls[0]!;
  expect(new Headers(init!.headers).get("authorization")).toBe("Bearer t");
});

test("apiRequest omits the bearer when no token is configured — the server fails closed (401)", async () => {
  const fetchMock = stubFetch(() => Promise.resolve(json({ ideas: [] })));

  await apiRequest("/v1/ideas");

  const [, init] = fetchMock.mock.calls[0]!;
  expect(new Headers(init!.headers).get("authorization")).toBeNull();
});

test("apiRequest returns the parsed body on 200", async () => {
  stubFetch(() => Promise.resolve(json({ ideas: [] })));
  await expect(apiRequest("/v1/ideas")).resolves.toEqual({ ideas: [] });
});

test("apiRequest maps the error envelope to an ApiError with code and status", async () => {
  stubFetch(() =>
    Promise.resolve(
      json(
        {
          error: {
            code: "validation_failed",
            message: "hypothesis exceeds 280 characters",
            details: null,
          },
        },
        422,
      ),
    ),
  );

  const error = await apiRequest("/v1/ideas").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: "validation_failed", status: 422 });
});

test("apiRequest falls back to internal_error when the failure body is not the envelope", async () => {
  stubFetch(() => Promise.resolve(new Response("<html>oops</html>", { status: 500 })));

  const error = await apiRequest("/v1/ideas").catch((e: unknown) => e);
  expect(error).toMatchObject({ code: "internal_error", status: 500 });
});

test("apiRequest maps a transport failure to the client-local network code", async () => {
  stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

  const error = await apiRequest("/v1/ideas").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ code: "network", status: 0 });
});
