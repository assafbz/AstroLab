import { expect, test, vi, type Mock } from "vitest";

import type { EngineState, Spark } from "../types.js";
import {
  POLL_BACKOFF_MS,
  createDeckStream,
  type DeckStreamDeps,
  type EngineEventHandlers,
  type EngineStream,
} from "./deck-stream.js";

/**
 * S4's **connection policy** (`docs/API.md` §4.11). Each test names the rule it would redden:
 * `offer`-as-signal (never an append), the E1 gate on the fallback, the bound on its schedule, and the
 * stop conditions. The clock and the reads are injected, so the schedule is asserted exactly rather
 * than waited on.
 */

function state(
  name: EngineState["state"],
  unreviewed = 1,
  run: EngineState["run"] = null,
): EngineState {
  return { state: name, unreviewed, run };
}

const RUNNING: EngineState["run"] = { id: "r-42", status: "RUNNING", vault_revision: 42 };

const SPARK: Spark = {
  id: "1a2b",
  direction: "Route the overflow by relevance",
  claim: "The default metric is not the relevant one.",
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["audio-dsp"],
  created_at: "2026-10-15T05:14:05Z",
};

/** Let every already-resolved promise chain settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A hand-cranked clock: the delays the module books are recorded, and fired on demand. */
function clock() {
  const booked: { ms: number; run: () => void }[] = [];

  return {
    schedule(ms: number, run: () => void): () => void {
      const entry = { ms, run };
      booked.push(entry);
      return () => {
        const at = booked.indexOf(entry);
        if (at !== -1) booked.splice(at, 1);
      };
    },
    /** The delays still booked, oldest first. */
    delays: () => booked.map((entry) => entry.ms),
    /** Fire the booked timer (there is at most one) and let its poll settle. */
    async fire(): Promise<void> {
      const next = booked.shift();
      if (!next) throw new Error("no poll was booked");
      next.run();
      await settle();
    },
  };
}

interface Harness {
  stream: ReturnType<typeof createDeckStream>;
  handlers: () => EngineEventHandlers;
  subscribe: Mock<DeckStreamDeps["subscribe"]>;
  readState: Mock<DeckStreamDeps["readState"]>;
  readDeck: Mock<DeckStreamDeps["readDeck"]>;
  onState: Mock<DeckStreamDeps["onState"]>;
  onDeck: Mock<DeckStreamDeps["onDeck"]>;
  clock: ReturnType<typeof clock>;
  /** What the next §4.10/§4.9 read answers — the vault moves between polls. */
  answer(next: EngineState, deck?: Spark[]): void;
  /** Make both reads reject, as an unreachable API would. */
  fail(flag: boolean): void;
  /** Whether the module closed its subscription. */
  unsubscribed: () => boolean;
}

function harness(initial: EngineState, deck: Spark[] = []): Harness {
  const handlers: EngineEventHandlers[] = [];
  const hands = clock();
  let answerState = initial;
  let answerDeck = deck;
  let failing = false;
  let unsubscribed = false;

  const read = <T>(value: () => T): Promise<T> =>
    failing ? Promise.reject(new Error("unreachable")) : Promise.resolve(value());

  const deps: DeckStreamDeps = {
    subscribe: vi.fn((h: EngineEventHandlers) => {
      handlers.push(h);
      return {
        close: () => {
          unsubscribed = true;
        },
      } satisfies EngineStream;
    }),
    readState: vi.fn(() => read(() => answerState)),
    readDeck: vi.fn(() => read(() => answerDeck)),
    onState: vi.fn(),
    onDeck: vi.fn(),
    schedule: hands.schedule,
  };

  return {
    stream: createDeckStream(deps),
    handlers: () => {
      const first = handlers[0];
      if (!first) throw new Error("nothing subscribed");
      return first;
    },
    subscribe: deps.subscribe as unknown as Mock<DeckStreamDeps["subscribe"]>,
    readState: deps.readState as unknown as Mock<DeckStreamDeps["readState"]>,
    readDeck: deps.readDeck as unknown as Mock<DeckStreamDeps["readDeck"]>,
    onState: deps.onState as unknown as Mock<DeckStreamDeps["onState"]>,
    onDeck: deps.onDeck as unknown as Mock<DeckStreamDeps["onDeck"]>,
    clock: hands,
    answer: (next, nextDeck = []) => {
      answerState = next;
      answerDeck = nextDeck;
    },
    fail: (flag) => {
      failing = flag;
    },
    unsubscribed: () => unsubscribed,
  };
}

test("open() issues the subscription with no state invented before a frame (§4.11)", () => {
  const h = harness(state("E2", 1));
  h.stream.open();

  expect(h.subscribe).toHaveBeenCalledTimes(1);
  expect(h.onState).not.toHaveBeenCalled();
  expect(h.onDeck).not.toHaveBeenCalled();
});

test("open() is idempotent — a second call cannot open a second subscription", () => {
  const h = harness(state("E2", 1));
  h.stream.open();
  h.stream.open();

  expect(h.subscribe).toHaveBeenCalledTimes(1);
});

test("a `state` frame is reported as it arrived — the ladder is never re-derived here (§4.10)", () => {
  const h = harness(state("E2", 1));
  h.stream.open();
  h.handlers().onState(state("E1", 1, RUNNING));

  expect(h.onState).toHaveBeenCalledTimes(1);
  expect(h.onState).toHaveBeenCalledWith(state("E1", 1, RUNNING));
});

test("an `offer` frame re-reads §4.9 — the deck is the server's array, never a local append", async () => {
  const deck = [SPARK];
  const h = harness(state("E1", 1, RUNNING), deck);
  h.stream.open();
  h.handlers().onOffer(SPARK);
  await settle();

  expect(h.readDeck).toHaveBeenCalledTimes(1);
  expect(h.onDeck).toHaveBeenCalledTimes(1);
  // The array itself, untouched: §4.9's order is deck order, so the client hands it straight through.
  expect(h.onDeck.mock.calls[0]?.[0]).toBe(deck);
});

test("a burst of `offer` frames costs one read plus one — never one read per frame", async () => {
  const h = harness(state("E1", 1, RUNNING), [SPARK]);
  h.stream.open();

  // One run commits its offers in one transaction, so the diff arrives as a burst in one tick.
  h.handlers().onOffer(SPARK);
  h.handlers().onOffer(SPARK);
  h.handlers().onOffer(SPARK);
  expect(h.readDeck).toHaveBeenCalledTimes(1);

  await settle();
  expect(h.readDeck).toHaveBeenCalledTimes(2);

  await settle();
  expect(h.readDeck).toHaveBeenCalledTimes(2);
  expect(h.onDeck).toHaveBeenCalledTimes(2);
});

test("a stream that dies while E1 falls back to polling, on the bounded schedule (§4.11)", async () => {
  const h = harness(state("E1", 1, RUNNING), [SPARK]);
  h.stream.open();
  h.stream.observe(state("E1", 1, RUNNING));
  h.handlers().onClose!("rejected");

  expect(h.clock.delays()).toEqual([POLL_BACKOFF_MS[0]]);

  // Each poll reads §4.10 **and** §4.9 together and reports both.
  await h.clock.fire();
  expect(h.readState).toHaveBeenCalledTimes(1);
  expect(h.readDeck).toHaveBeenCalledTimes(1);
  expect(h.onState).toHaveBeenLastCalledWith(state("E1", 1, RUNNING));
  expect(h.onDeck).toHaveBeenLastCalledWith([SPARK]);

  // Still in flight, so the delay walks the schedule …
  expect(h.clock.delays()).toEqual([POLL_BACKOFF_MS[1]]);
  await h.clock.fire();
  expect(h.clock.delays()).toEqual([POLL_BACKOFF_MS[2]]);
  await h.clock.fire();
  expect(h.clock.delays()).toEqual([POLL_BACKOFF_MS[3]]);
  await h.clock.fire();
  // … and holds at the last value: bounded, not unbounded, and not a fixed-interval timer either.
  expect(h.clock.delays()).toEqual([POLL_BACKOFF_MS[3]]);
});

test("a stream that dies with the vault idle polls nothing — the fallback is E1's alone", () => {
  const h = harness(state("E2", 2), [SPARK]);
  h.stream.open();
  h.stream.observe(state("E2", 2));
  h.handlers().onClose!("ended");

  expect(h.clock.delays()).toEqual([]);
  expect(h.readState).not.toHaveBeenCalled();
});

test("the fallback stops the moment the ladder leaves E1 — no timer outlives the run", async () => {
  const h = harness(state("E1", 1, RUNNING));
  h.stream.open();
  h.stream.observe(state("E1", 1, RUNNING));
  h.handlers().onClose!("ended");

  h.answer(state("E2", 2), [SPARK]);
  await h.clock.fire();

  expect(h.onState).toHaveBeenLastCalledWith(state("E2", 2));
  expect(h.onDeck).toHaveBeenLastCalledWith([SPARK]);
  expect(h.clock.delays()).toEqual([]);
});

test("a failed poll keeps the schedule — bounded by the rate, never stopped by the failure", async () => {
  const h = harness(state("E1", 1, RUNNING));
  h.stream.open();
  h.stream.observe(state("E1", 1, RUNNING));
  h.handlers().onClose!("ended");
  h.fail(true);

  const seen: number[] = [];
  for (let tick = 0; tick < 6; tick += 1) {
    seen.push(...h.clock.delays());
    await h.clock.fire();
  }

  // The whole episode, in order, with the ceiling held: 1s, 2s, 4s, 8s, 8s, 8s.
  expect(seen).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
  expect(h.onState).not.toHaveBeenCalled();
});

test("a stream that dies before any state still recovers — the caller's own read is the gate", async () => {
  const h = harness(state("E1", 1, RUNNING));
  h.stream.open();
  h.handlers().onClose!("rejected");
  // Nothing to gate on yet: no state has been observed, so nothing is booked.
  expect(h.clock.delays()).toEqual([]);

  // The screen's §4.10 read lands and says the engine is working: now the fallback is arming.
  h.stream.observe(state("E1", 1, RUNNING));
  expect(h.clock.delays()).toEqual([POLL_BACKOFF_MS[0]]);

  await h.clock.fire();
  expect(h.readState).toHaveBeenCalledTimes(1);
});

test("a read back to E1 re-arms the fallback — a client-initiated run is not lost to a dead stream", async () => {
  const h = harness(state("E2", 2));
  h.stream.open();
  h.stream.observe(state("E2", 2));
  h.handlers().onClose!("ended");
  expect(h.clock.delays()).toEqual([]);

  // Recompute re-read §4.10 and found E1: the stream is still down, so the poll resumes from the start.
  h.stream.observe(state("E1", 1, RUNNING));
  expect(h.clock.delays()).toEqual([POLL_BACKOFF_MS[0]]);
});

test("observe() before open() books no poll — an unopened stream is not a dead one", () => {
  const h = harness(state("E1", 1, RUNNING));
  h.stream.observe(state("E1", 1, RUNNING));

  expect(h.clock.delays()).toEqual([]);
});

test("close() cancels a booked poll and the subscription, and stops reporting", async () => {
  const h = harness(state("E1", 1, RUNNING));
  h.stream.open();
  h.stream.observe(state("E1", 1, RUNNING));
  h.handlers().onClose!("ended");
  expect(h.clock.delays()).toHaveLength(1);

  h.stream.close();

  expect(h.clock.delays()).toEqual([]);
  expect(h.unsubscribed()).toBe(true);

  // A frame that races the close is not delivered: nothing is reported after the caller let go.
  h.handlers().onState(state("E2", 9));
  await settle();
  expect(h.onState).not.toHaveBeenCalled();
  expect(h.readState).not.toHaveBeenCalled();
});
