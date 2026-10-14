import { afterEach, expect, test, vi, type Mock } from "vitest";

import { enqueueRun } from "./sparks.ts";
import type { RunAccepted } from "./types.ts";

const ACCEPTED: RunAccepted = { run_id: "r-42", vault_revision: 42 };

function json(body: unknown, status = 202): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

test("enqueueRun POSTs /v1/sparks/run with no body and returns the 202 unreshaped", async () => {
  const mock: Mock<(url: string, init?: RequestInit) => Promise<Response>> = vi.fn(() =>
    Promise.resolve(json(ACCEPTED)),
  );
  vi.stubGlobal("fetch", mock);

  expect(await enqueueRun()).toEqual(ACCEPTED);
  expect(mock).toHaveBeenCalledTimes(1);

  const [url, init] = mock.mock.calls[0]!;
  expect(url).toBe("/v1/sparks/run");
  expect(init!.method).toBe("POST");
  // §4.16 reads no body: the request must not send one (a sent body would be ignored, not validated).
  expect(init!.body).toBeUndefined();
});

test("a failed enqueue surfaces the envelope's code, not a bare failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(json({ error: { code: "unauthorized", message: "no token" } }, 401)),
    ),
  );

  await expect(enqueueRun()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
});
