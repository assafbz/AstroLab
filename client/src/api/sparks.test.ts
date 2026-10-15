import { afterEach, expect, test, vi, type Mock } from "vitest";

import {
  OFFERED_QUERY,
  createSseDecoder,
  engineState,
  enqueueRun,
  offeredSparks,
  subscribeEngineEvents,
  type EngineEventHandlers,
  type EngineStreamEnd,
} from "./sparks.ts";
import type { EngineState, RunAccepted, Spark } from "./types.ts";

/** A stubbed `fetch` whose calls the test can inspect. */
function stubFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): Mock<(url: string, init?: RequestInit) => Promise<Response>> {
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

/** A stream response whose chunks are delivered in the sizes the test chose, then closed. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A frame as §4.11 writes it on the wire: `event: <name>`, `data: <json>`, blank line. */
function frame(event: "state" | "offer", payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** One delivered callback, in arrival order, plus a promise that resolves when the stream reports. */
interface Recorded {
  seen: { kind: "state" | "offer" | "close"; payload?: unknown }[];
  closed: Promise<EngineStreamEnd | undefined>;
  handlers: EngineEventHandlers;
}

function recorder(): Recorded {
  const seen: Recorded["seen"] = [];
  let settle!: (reason: EngineStreamEnd | undefined) => void;
  const closed = new Promise<EngineStreamEnd | undefined>((resolve) => {
    settle = resolve;
  });

  return {
    seen,
    closed,
    handlers: {
      onState: (state) => seen.push({ kind: "state", payload: state }),
      onOffer: (spark) => seen.push({ kind: "offer", payload: spark }),
      onClose: (reason) => {
        seen.push({ kind: "close", payload: reason });
        settle(reason);
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ACCEPTED: RunAccepted = { run_id: "r-42", vault_revision: 42 };

const STATE: EngineState = {
  state: "E2",
  unreviewed: 2,
  run: null,
};

const SPARK: Spark = {
  id: "1a2b",
  direction: "Route the overflow by relevance",
  claim: "The default metric is not the relevant one.",
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["audio-dsp"],
  created_at: "2026-10-13T05:14:05Z",
};

test("enqueueRun POSTs /v1/sparks/run with no body and returns the 202 unreshaped", async () => {
  const mock = stubFetch(() => Promise.resolve(json(ACCEPTED, 202)));

  expect(await enqueueRun()).toEqual(ACCEPTED);
  expect(mock).toHaveBeenCalledTimes(1);

  const [url, init] = mock.mock.calls[0]!;
  expect(url).toBe("/v1/sparks/run");
  expect(init!.method).toBe("POST");
  // §4.16 reads no body: the request must not send one (a sent body would be ignored, not validated).
  expect(init!.body).toBeUndefined();
});

test("a failed enqueue surfaces the envelope's code, not a bare failure", async () => {
  stubFetch(() =>
    Promise.resolve(json({ error: { code: "unauthorized", message: "no token" } }, 401)),
  );

  await expect(enqueueRun()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
});

test("engineState reads /v1/sparks/state and returns the ladder unreshaped (§4.10)", async () => {
  const mock = stubFetch(() => Promise.resolve(json(STATE)));

  expect(await engineState()).toEqual(STATE);
  expect(mock.mock.calls[0]![0]).toBe("/v1/sparks/state");
});

test("engineState surfaces the envelope on a refusal, never a default state (§2)", async () => {
  stubFetch(() =>
    Promise.resolve(json({ error: { code: "internal_error", message: "boom" } }, 500)),
  );

  await expect(engineState()).rejects.toMatchObject({ code: "internal_error", status: 500 });
});

test("offeredSparks reads §4.9 with the required `state=offered`, case-sensitively", async () => {
  const mock = stubFetch(() => Promise.resolve(json({ sparks: [SPARK] })));

  expect(await offeredSparks()).toEqual([SPARK]);
  // The read is unfiltered without `state` (422), and `OFFERED` is not `offered` — one string, one place.
  expect(mock.mock.calls[0]![0]).toBe(`/v1/sparks${OFFERED_QUERY}`);
  expect(OFFERED_QUERY).toBe("?state=offered");
});

test("offeredSparks keeps server order — deck order is the server's, never re-sorted (§4.9)", async () => {
  // Deliberately not id-ordered and not `created_at`-ordered: a client-side sort of either reddens.
  const second: Spark = { ...SPARK, id: "zz", created_at: "2026-10-13T00:00:00Z" };
  const third: Spark = { ...SPARK, id: "9f", created_at: "2026-10-14T00:00:00Z" };
  stubFetch(() => Promise.resolve(json({ sparks: [SPARK, second, third] })));

  expect((await offeredSparks()).map((spark) => spark.id)).toEqual(["1a2b", "zz", "9f"]);
});

test("offeredSparks carries §3.3's whole projection through, `first_step` included (#115)", async () => {
  // The card's third element is the read's, not a literal: the field survives the transport unreshaped,
  // and a `null` (a legacy row) travels as `null` rather than being dropped or defaulted here.
  stubFetch(() =>
    Promise.resolve(json({ sparks: [SPARK, { ...SPARK, id: "legacy", first_step: null }] })),
  );

  const [offered, legacy] = await offeredSparks();
  expect(offered!.first_step).toBe(SPARK.first_step);
  expect(legacy!.first_step).toBeNull();
});

test("offeredSparks answers an empty deck with an empty array, not a failure (§4.9)", async () => {
  stubFetch(() => Promise.resolve(json({ sparks: [] })));

  expect(await offeredSparks()).toEqual([]);
});

test("the decoder completes a frame split across chunks, and drops an unterminated tail", () => {
  const read = createSseDecoder();

  // The wire's write boundaries are not the reader's read boundaries: split mid-JSON and mid-line.
  expect(read('event: state\ndata: {"state":"E')).toEqual([]);
  expect(read('1"')).toEqual([]);
  expect(read(',"unreviewed":0,"run":null}\n\n')).toEqual([
    { event: "state", data: '{"state":"E1","unreviewed":0,"run":null}' },
  ]);

  // Two frames in one chunk, a `: keepalive` comment between them, CRLF line endings, and a tail that
  // never got its blank line — which must not be dispatched.
  const frames = read(
    ': keepalive\r\nevent: offer\r\ndata: {"id":"a"}\r\n\r\nevent: offer\ndata: {"id":"b"}\n',
  );
  expect(frames).toEqual([{ event: "offer", data: '{"id":"a"}' }]);
});

test("subscription delivers §4.11's frames in order and reports the close", async () => {
  stubFetch(() =>
    Promise.resolve(sseResponse([frame("state", STATE), frame("offer", SPARK), ": keepalive\n\n"])),
  );
  const recorded = recorder();

  const stream = subscribeEngineEvents(recorded.handlers);
  expect(await recorded.closed).toBe("ended");
  stream.close();

  expect(recorded.seen).toEqual([
    { kind: "state", payload: STATE },
    { kind: "offer", payload: SPARK },
    { kind: "close", payload: "ended" },
  ]);
});

test("an unknown event name is ignored, not fatal — a later frame type must not break the client", async () => {
  stubFetch(() =>
    Promise.resolve(
      sseResponse([frame("state", STATE), "event: ping\ndata: {}\n\n", frame("offer", SPARK)]),
    ),
  );
  const recorded = recorder();

  subscribeEngineEvents(recorded.handlers);

  expect(await recorded.closed).toBe("ended");
  expect(recorded.seen.slice(0, 2)).toEqual([
    { kind: "state", payload: STATE },
    { kind: "offer", payload: SPARK },
  ]);
});

test("the request is issued in the calling tick — subscribe first, read §4.9 second (§4.11)", () => {
  const mock = stubFetch(() => Promise.resolve(sseResponse([])));
  const recorded = recorder();

  const stream = subscribeEngineEvents(recorded.handlers);
  // No `await` since the call: the connect-race rule only holds if the subscription is issued before
  // the caller's deck read, so "subscribed" cannot mean "on a later microtask".
  expect(mock).toHaveBeenCalledTimes(1);
  stream.close();
});

test("the stream reaches §1's gate with a fetch, since EventSource cannot set Authorization", async () => {
  vi.stubEnv("VITE_API_TOKEN", "t");
  const source = vi.fn();
  vi.stubGlobal("EventSource", source);
  const mock = stubFetch(() => Promise.resolve(sseResponse([frame("state", STATE)])));
  const recorded = recorder();

  subscribeEngineEvents(recorded.handlers);
  expect(await recorded.closed).toBe("ended");

  const [url, init] = mock.mock.calls[0]!;
  expect(url).toBe("/v1/sparks/events");
  const headers = new Headers(init!.headers);
  expect(headers.get("accept")).toBe("text/event-stream");
  expect(headers.get("authorization")).toBe("Bearer t");
  expect(source).not.toHaveBeenCalled();
});

test("a payload that is not JSON stops the stream — no ladder value is invented (§4.11)", async () => {
  stubFetch(() =>
    Promise.resolve(sseResponse([frame("state", STATE), "event: state\ndata: not json\n\n"])),
  );
  const recorded = recorder();

  const stream = subscribeEngineEvents(recorded.handlers);

  expect(await recorded.closed).toBe("malformed");
  expect(recorded.seen).toEqual([
    { kind: "state", payload: STATE },
    { kind: "close", payload: "malformed" },
  ]);
  stream.close();
});

test("a refusal is reported as `rejected`, and no frame is delivered from it", async () => {
  vi.stubEnv("VITE_API_TOKEN", "");
  stubFetch(() =>
    Promise.resolve(json({ error: { code: "unauthorized", message: "no token" } }, 401)),
  );
  const recorded = recorder();

  subscribeEngineEvents(recorded.handlers);

  expect(await recorded.closed).toBe("rejected");
  expect(recorded.seen).toEqual([{ kind: "close", payload: "rejected" }]);
});

test("close() aborts the request and is silent: the caller's own close is not a stream death", async () => {
  let aborted = false;
  const mock = stubFetch(
    (_url, init) =>
      new Promise<Response>((resolve) => {
        init!.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve(json({ error: { code: "internal_error", message: "aborted" } }, 500));
        });
      }),
  );
  const recorded = recorder();

  const stream = subscribeEngineEvents(recorded.handlers);
  expect(mock).toHaveBeenCalledTimes(1);
  stream.close();
  stream.close(); // idempotent
  await Promise.resolve();
  await Promise.resolve();

  expect(aborted).toBe(true);
  expect(recorded.seen).toEqual([]);
});
