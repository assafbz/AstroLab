import { apiHeaders, apiRequest } from "./client.ts";
import type { EngineState, RunAccepted, Spark, SparkDetail } from "./types.ts";

/**
 * The sparks surface the deck (S1) reads: the deck itself (§4.9), the engine state (§4.10), and the
 * run-progress stream (§4.11). Pure transport — the request shapes, the framing and the decoding.
 * **What the state *means* is not decided here**: the ladder arrives computed (`GET /v1/sparks/state`,
 * `api/src/engine-state.ts`) and the deck's composition of it is `client/src/domain/deck-state.ts`.
 * No component, no React, no state.
 */

/**
 * `POST /v1/sparks/run` (`docs/API.md` §4.16) — enqueue a run (the cold-start trigger, O5 `#25`).
 *
 * **No body, and none is sent.** §4.16 reads none and a body is ignored, not validated — so the request
 * carries only the bearer/envelope path `apiRequest` already owns. The call is **fire-and-forget** from
 * the caller's side (NFR-P1): it resolves to the accepted run, but nobody waits on the engine to leave
 * S0 — `202` means *enqueued*, not *done* (`→ E1`). Governance (idempotency per revision, stale-run
 * discard) is the server's; the client states no invariant of its own (`docs/API.md` §0).
 */
export function enqueueRun(): Promise<RunAccepted> {
  return apiRequest<RunAccepted>("/v1/sparks/run", { method: "POST" });
}

/**
 * `GET /v1/sparks/state` (`docs/API.md` §4.10, §3.6) — **the deck's only state input.**
 *
 * The ladder is computed in one place, server-side, and the readout reaches no provider — it must
 * answer in exactly the state it exists to report (E4, `FLOW.md` §5.6). So the client renders this;
 * it does not re-derive E0–E4 from a summary, a local tally or a *"we just ran one"* flag. E0's gate
 * on S0 (`client/src/domain/spread-gate.ts`, O4 `#24`) stays S0's exit gate: a second E0 reader is
 * the two-sources-of-truth defect this endpoint exists to remove.
 */
export function engineState(): Promise<EngineState> {
  return apiRequest<EngineState>("/v1/sparks/state");
}

/**
 * §4.9's query is **required**, and `offered` is its only value — **case-sensitive**, so
 * `?state=OFFERED` is `422`. It is stated once, here, so no caller can reach the read unfiltered.
 */
export const OFFERED_QUERY = "?state=offered";

/**
 * `GET /v1/sparks?state=offered` (`docs/API.md` §4.9) — live offers only.
 *
 * The body's order **is** deck order (§4.9: oldest offer first, `spark.rowid ASC`), so the client
 * returns the array as it arrived: no sort, no filter, no dedupe. The read is a read — it computes
 * nothing and carries no engine state (§4.10 owns that).
 */
export async function offeredSparks(): Promise<Spark[]> {
  const body = await apiRequest<{ sparks: Spark[] }>(`/v1/sparks${OFFERED_QUERY}`);
  return body.sparks;
}

/**
 * `GET /v1/sparks/{id}` (`docs/API.md` §4.12) — one spark, for the expanded view (S1b).
 *
 * The detail reads **its own** endpoint: it does not re-read §4.9 and it does not take the card's
 * payload on the way in, so a reload of `#/sparks/<id>` renders from §4.12 alone and a stale
 * in-memory card cannot shadow the server. What the read adds to the card is `what_it_takes` and
 * nothing else (§3.4); no score, no similarity readout.
 *
 * **By id, whatever the status.** §4.12 carries no filter — not §4.9's required `state=offered` — so a
 * spark the user resolved mid-session still answers when they tap back, rather than 404ing as if it had
 * never existed. `SparkDetail` carries no `status`, so the resolution does not surface; only an unknown
 * id is the §2 `not_found` envelope. That reading is a decision, recorded in #118, not an omission.
 */
export function sparkDetail(id: string): Promise<SparkDetail> {
  // Encoded, so an opaque id addresses exactly one route — the same rule `getIdeaDetail` states.
  return apiRequest<SparkDetail>(`/v1/sparks/${encodeURIComponent(id)}`);
}

/** §4.11's route, under the frozen `/v1` prefix (`ARCHITECTURE.md` §6). */
export const SPARKS_EVENTS_PATH = "/v1/sparks/events";

/** One decoded SSE frame: the event name and its `data` payload, still JSON text. */
export interface SseFrame {
  event: string;
  data: string;
}

/**
 * Decodes `text/event-stream` bytes into frames (`docs/API.md` §4.11).
 *
 * Returned as a chunk-fed function rather than a class so the framing is testable without a socket:
 * feed it the byte chunks a `fetch` body yields, in whatever sizes they arrive, and it returns the
 * frames that completed. State (a partial line, an open frame) lives in the closure, so **a frame
 * split across two chunks decodes once** — the failure this exists to prevent, since a stream's read
 * boundaries are not the server's write boundaries.
 *
 * What it deliberately does not do, so the omissions are decisions:
 * - **`: comment` lines** — §4.11's `: keepalive` — are dropped. They are transport, not signal.
 * - **`id` / `retry`** are ignored: §4.11 uses neither, and a client that honoured `retry` would be
 *   reconnecting on the server's schedule rather than its own (that is `deck-stream.ts`, S4).
 * - **An unterminated tail is discarded**, never dispatched: a frame is complete at its blank line,
 *   and half a JSON payload is not a payload.
 * - A frame with no `event:` name is dispatched as `message` (SSE's default), unnamed — §4.11 always
 *   names its events, so this is forward-compatibility, not a third signal.
 */
export function createSseDecoder(): (chunk: string) => SseFrame[] {
  let buffer = "";
  let name: string | null = null;
  let data: string[] = [];

  return (chunk) => {
    buffer += chunk;
    const frames: SseFrame[] = [];

    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      // CRLF and a bare CR both terminate a line on the wire; the `\n` above is the anchor.
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        if (name !== null || data.length > 0) {
          frames.push({ event: name ?? "message", data: data.join("\n") });
        }
        name = null;
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") name = value;
      else if (field === "data") data.push(value);
    }

    return frames;
  };
}

/**
 * Why the stream stopped, for the caller that must decide what to show (§4.11's fallback, S4).
 * `ended` is the only one that means *"it was working and then it wasn't"*.
 */
export type EngineStreamEnd =
  /** The response ended: the server closed it, or the network dropped mid-stream. */
  | "ended"
  /** The subscription was never an event stream: a non-2xx (the `/v1` gate), or no body. */
  | "rejected"
  /** A `state`/`offer` frame carried `data` that is not JSON. The frame's meaning is unknown. */
  | "malformed";

/** §4.11's two events. Both are **diffs** from the server's own baseline, never a full replay. */
export interface EngineEventHandlers {
  /** A new engine state — the whole ladder value, as §3.6 shapes it. */
  onState(state: EngineState): void;
  /** A spark that just entered the deck. New offers surface on the event, not a timer. */
  onOffer(spark: Spark): void;
  /**
   * The stream stopped **for a reason the caller did not cause**. A `close()` is the caller's own
   * decision and is not reported here.
   */
  onClose?(reason: EngineStreamEnd): void;
}

/** The handle a subscriber holds; `close()` is idempotent and aborts the underlying request. */
export interface EngineStream {
  close(): void;
}

/**
 * `GET /v1/sparks/events` (`docs/API.md` §4.11) — subscribe to the run-progress stream.
 *
 * **`fetch`, not `EventSource`.** §4.11 records the constraint: `EventSource` cannot set an
 * `Authorization` header, so it cannot reach `/v1`'s gate at all. The headers come from the same
 * `apiHeaders` every other call uses, with `accept: text/event-stream`.
 *
 * **Subscribe first, then read §4.9** (§4.11's connect-race rule, pinned by K1 `#35`): the change
 * signal is sampled before the server's baseline snapshot, so a commit landing while the connection
 * is being set up is either in that baseline or on the next tick's diff — never neither. That reading
 * only holds if the subscription is *issued* first, so this function starts the request **in the
 * calling tick**, before returning, not on a later microtask: a caller that subscribes, then awaits
 * `offeredSparks()`, has genuinely subscribed first.
 *
 * **The stream is live-only and adds nothing of its own**: no reconnect, no polling, no local state
 * machine. The first frame is the server's baseline `state`; a dropped stream is reported through
 * `onClose` and recovering from it — bounded backoff, only while `state = E1` (§4.11) — is S4's
 * `deck-stream.ts`, not this module's.
 */
export function subscribeEngineEvents(handlers: EngineEventHandlers): EngineStream {
  const controller = new AbortController();
  let closed = false;

  const close = (): void => {
    closed = true;
    controller.abort();
  };

  /** Report an end the caller did not ask for, once. A `close()` always wins: no spurious `onClose`. */
  const end = (reason: EngineStreamEnd): void => {
    if (closed) return;
    closed = true;
    handlers.onClose?.(reason);
  };

  void (async () => {
    let res: Response;
    try {
      res = await fetch(SPARKS_EVENTS_PATH, {
        headers: apiHeaders({ accept: "text/event-stream" }),
        signal: controller.signal,
      });
    } catch {
      // A `close()` aborts this fetch too; `end` is a no-op there, so this is only a real refusal.
      end("rejected");
      return;
    }

    if (!res.ok || res.body === null) {
      end("rejected");
      return;
    }

    const decoder = new TextDecoder();
    const read = createSseDecoder();
    const reader = res.body.getReader();

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of read(decoder.decode(value, { stream: true }))) {
          if (!deliver(frame, handlers)) {
            controller.abort();
            end("malformed");
            return;
          }
        }
      }
      end("ended");
    } catch {
      // A read that throws is either the caller's abort (`closed`, no-op) or a dropped connection.
      end("ended");
    }
  })();

  return { close };
}

/**
 * Route one frame to its handler. `false` means the frame was unreadable and the stream must stop —
 * a `state`/`offer` payload that is not JSON is not a state or an offer, and guessing past it would
 * be inventing a ladder value.
 *
 * **Any other event name is ignored.** §4.11 names two events; a client that failed on a third would
 * break the day the server adds one, and one that rendered it would be rendering an unknown shape.
 */
function deliver(frame: SseFrame, handlers: EngineEventHandlers): boolean {
  if (frame.event === "state") {
    const state = parseJson<EngineState>(frame.data);
    if (state === undefined) return false;
    handlers.onState(state);
  } else if (frame.event === "offer") {
    const spark = parseJson<Spark>(frame.data);
    if (spark === undefined) return false;
    handlers.onOffer(spark);
  }
  return true;
}

/** The frame's payload, or `undefined` when it is not JSON. The client maps, it does not validate. */
function parseJson<T>(data: string): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}
