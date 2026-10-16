import { afterEach, expect, test, vi } from "vitest";

import { postDecision } from "./decisions.ts";
import type { Decision } from "./types.ts";

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

afterEach(() => vi.unstubAllGlobals());

const ACCEPTED: Decision = {
  decision_id: "c7d",
  spark_id: "1a2b",
  kind: "ACCEPT",
  result_idea_id: "9f1c",
  spark_status: "RESOLVED-ACCEPTED",
  decided_at: "2026-10-13T05:14:05Z",
  undoable: true,
};

test("postDecision POSTs §4.13's body — the pair, and nothing else — and returns the Decision", async () => {
  const mock = stubFetch(() => Promise.resolve(json(ACCEPTED)));

  expect(await postDecision("1a2b", "c7d", "ACCEPT")).toEqual(ACCEPTED);
  expect(mock).toHaveBeenCalledTimes(1);

  const [url, init] = mock.mock.calls[0]!;
  expect(url).toBe("/v1/sparks/1a2b/decision");
  expect(init!.method).toBe("POST");
  expect(new Headers(init!.headers).get("content-type")).toBe("application/json");
  // §4.13's body is exactly this pair: the spark is the path, and the `decision_id` is the client's
  // idempotency key. A third field on the wire would be one the contract does not read.
  expect(JSON.parse(init!.body as string)).toEqual({ decision_id: "c7d", kind: "ACCEPT" });
});

test("postDecision carries DISMISS too — the route's other member", async () => {
  const dismissed: Decision = {
    ...ACCEPTED,
    kind: "DISMISS",
    result_idea_id: null,
    spark_status: "RESOLVED-DISMISSED",
  };
  const mock = stubFetch(() => Promise.resolve(json(dismissed)));

  expect(await postDecision("1a2b", "c7d", "DISMISS")).toEqual(dismissed);
  expect(JSON.parse(mock.mock.calls[0]![1]!.body as string)).toEqual({
    decision_id: "c7d",
    kind: "DISMISS",
  });
});

test("INSPIRED posts nothing — §4.14's inspire is a seeded capture, not this route (§4.13)", async () => {
  // The seam's `ResolutionKind` is three wide; §4.13 accepts two. `INSPIRED` writes **no** `decision`
  // row, so the arm must reach the wire with nothing at all — a POST here would be a decision the
  // server does not model (and #119 owns the seeded capture). `null` is "no decision recorded".
  const mock = stubFetch(() => Promise.resolve(json(ACCEPTED)));

  await expect(postDecision("1a2b", "c7d", "INSPIRED")).resolves.toBeNull();
  expect(mock).not.toHaveBeenCalled();
});

test("the spark id is encoded, so an opaque id addresses exactly one route", async () => {
  const mock = stubFetch(() => Promise.resolve(json(ACCEPTED)));

  await expect(postDecision("a b", "c7d", "ACCEPT")).resolves.toEqual(ACCEPTED);
  expect(mock.mock.calls[0]![0]).toBe("/v1/sparks/a%20b/decision");
});

test("the response travels unreshaped — §3.5's fields, a null `result_idea_id` included", async () => {
  // DISMISS creates no vault node, so `result_idea_id` is `null`; the transport must pass that through
  // rather than defaulting it, the way §3.3/§3.4's legacy-row nulls are passed through.
  const dismissed: Decision = {
    ...ACCEPTED,
    kind: "DISMISS",
    result_idea_id: null,
    spark_status: "RESOLVED-DISMISSED",
    undoable: false,
  };
  stubFetch(() => Promise.resolve(json(dismissed)));

  const decision = await postDecision("1a2b", "c7d", "DISMISS");

  expect(decision!.result_idea_id).toBeNull();
  expect(decision!.undoable).toBe(false);
  expect(decision!.spark_status).toBe("RESOLVED-DISMISSED");
  expect(decision!.decided_at).toBe(ACCEPTED.decided_at);
});

test("a refusal surfaces §2's envelope — a `conflict` is the server's verdict, not a bare failure", async () => {
  stubFetch(() =>
    Promise.resolve(json({ error: { code: "conflict", message: "spark is not OFFERED" } }, 409)),
  );

  await expect(postDecision("1a2b", "c7d", "ACCEPT")).rejects.toMatchObject({
    code: "conflict",
    status: 409,
  });
});
