import { afterEach, expect, test, vi } from "vitest";

import { vaultSummary } from "./vault.ts";
import type { VaultSummary } from "./types.ts";

const SUMMARY: VaultSummary = {
  resolved_domains: 2,
  provisional_domains: 1,
  target: 3,
  floor: 2,
  eligible: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

test("vaultSummary reads GET /v1/vault/summary and returns the payload unreshaped", async () => {
  const mock = vi.fn(() => Promise.resolve(json(SUMMARY)));
  vi.stubGlobal("fetch", mock);

  expect(await vaultSummary()).toEqual(SUMMARY);
  expect(mock).toHaveBeenCalledTimes(1);
  // No query string: §4.3 fixes the route and reads no parameter.
  expect(mock.mock.calls[0]![0]).toBe("/v1/vault/summary");
});

test("a failed summary read surfaces the envelope's code, not a bare failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(json({ error: { code: "unauthorized", message: "no token" } }, 401)),
    ),
  );

  await expect(vaultSummary()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
});
