import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { liveOffers } from "@astrolab/store";

import { engineState, type EngineState } from "./engine-state.js";
import type { Spark } from "./sparks.js";

/**
 * `GET /v1/sparks/events` — the run-progress stream (`docs/API.md` §4.11; K1 `#35`).
 *
 * ## The store is the notifier; the API is a subscriber
 *
 * The two processes share one SQLite file (`ARCHITECTURE.md` §1) and SQLite has no cross-process
 * pub/sub, so no write-hook in `store`/`worker` can reach the API process. The stream therefore
 * samples SQLite's own cross-connection change signal — `PRAGMA data_version` — and re-reads the deck
 * (`liveOffers`) and the state (`engineState`, §4.10) **only when that signal moves**. A commit on
 * *any other* connection — the worker's offer write, or the API's own `POST /v1/sparks/run` enqueue —
 * moves it; a commit on the sampling connection itself does not (SQLite's documented semantics).
 *
 * ## Why the sampler is a **second, read-only** handle — never the API's `db`
 *
 * A connection is blind to its own commit. A watcher on `db` would therefore miss every change the
 * API process itself makes — §4.16's run enqueue and every `vaultMutation` — and, with the worker
 * down, §4.11's "every change" would be silently narrower. `watchDb` is a second handle on the same
 * file, used **only** to read `PRAGMA data_version`, and it **never writes**. Any later
 * "optimisation" that drops `watchDb` for `db` reintroduces exactly that blind spot.
 *
 * `:memory:` is a **test-only** path (`api/src/index.ts:14` defaults `DB_PATH` to a file): a second
 * handle there is a *different* database, so `createApp` falls back to sampling `db`. That fallback is
 * a test affordance and can never mask the blind spot in production, where `index.ts` always opens a
 * distinct handle.
 *
 * ## "On the event, not a timer"
 *
 * The cadence is transport: it only bounds latency. A tick emits **nothing** when `data_version` has
 * not moved, and the frames it emits are **diffs** — `state` when `EngineState` differs from the last
 * frame, `offer` once per *new* live-offer id. So with nothing committed there is no frame, and an
 * offer that lands surfaces once, on the write, never on a repeating tick.
 *
 * ## Live-only, per-subscriber
 *
 * The sampler is created on connect and destroyed on disconnect: with no subscriber there is no
 * sampling, no buffering and no replay. A `state` change with no client connected is simply not
 * observed; a reconnecting client gets the baseline `state` below and re-reads §4.9 for the deck.
 */

/** The sampler's cadence. `NFR-P1`'s bound is 60 s, so this is ~100× inside it. */
export const WATCH_INTERVAL_MS = 500;

/** The keepalive comment's period, so an idle stream is not reaped by an intermediary. */
export const HEARTBEAT_MS = 20_000;

/** Test affordances for the two periods; production uses the constants above. */
export interface SparkEventsOptions {
  intervalMs?: number;
  heartbeatMs?: number;
}

/** One frame, as §4.11 spells it (`event: <name>` then `data: <json>`, blank-line terminated). */
function send(res: ServerResponse, event: "state" | "offer", data: EngineState | Spark): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function currentVersion(statement: StatementSync): number {
  return (statement.get() as { data_version: number }).data_version;
}

export function handleSparkEvents(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
  watchDb: DatabaseSync,
  options: SparkEventsOptions = {},
): void {
  const intervalMs = options.intervalMs ?? WATCH_INTERVAL_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  // An idle stream must not be reaped by the socket's own timeout.
  req.socket.setTimeout(0);
  res.setTimeout(0);

  // Sample the change signal **before** taking the baseline snapshot below. Taken the other way round,
  // a commit landing between the two — a second process (the worker) can interleave here even though
  // this connect sequence is synchronous — would be folded into `seen` *and* absent from the baseline,
  // and the unchanged signal would keep every later tick silent: the change is lost. Signal first: any
  // commit after this line moves the signal on a later tick, and one landing during the snapshot is
  // re-read and diffed idempotently.
  //
  // One prepared `PRAGMA data_version`, reused: it reports fresh on every read (no cached row).
  const dataVersion = watchDb.prepare("PRAGMA data_version");
  let seen = currentVersion(dataVersion);

  // Prime the diff caches from the current state: connecting sends one baseline `state`, never a
  // replay of the whole deck as `offer` frames. The client reads §4.9 for the deck.
  let lastState = engineState(db);
  let lastOfferIds = new Set(liveOffers(db).map((spark) => spark.id));
  send(res, "state", lastState);

  let closed = false;

  const tick = (): void => {
    if (closed) return;
    try {
      const version = currentVersion(dataVersion);
      if (version === seen) return; // nothing committed anywhere: no frame, and no read
      seen = version;

      const state = engineState(db);
      if (JSON.stringify(state) !== JSON.stringify(lastState)) {
        lastState = state;
        send(res, "state", state);
      }

      const offers = liveOffers(db);
      const ids = new Set(offers.map((spark) => spark.id));
      for (const spark of offers) {
        if (!lastOfferIds.has(spark.id)) send(res, "offer", spark);
      }
      lastOfferIds = ids;
    } catch {
      // A write against a stream the client has already dropped must not take the server down.
      cleanup();
    }
  };

  const watcher = setInterval(tick, intervalMs);
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": keepalive\n\n");
  }, heartbeatMs);

  function cleanup(): void {
    if (closed) return;
    closed = true;
    clearInterval(watcher);
    clearInterval(heartbeat);
    res.end();
  }
  res.on("close", cleanup);
}
