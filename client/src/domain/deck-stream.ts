import type { EngineEventHandlers, EngineStream } from "../api/sparks.ts";
import type { EngineState, Spark } from "../api/types.ts";

/**
 * S4 — the deck's **connection policy** (`docs/API.md` §4.11; `FLOW.md` §4.1 E1, §5.6).
 *
 * §4.11 splits in two, and S1 `#35` took the first half: `api/sparks.ts` owns the *transport* — the
 * route, the `fetch`-stream that can carry §1's bearer, the frame decoder. What it deliberately does
 * **not** do is recover; its own docstring hands *"bounded backoff, only while `state = E1`"* to this
 * module. So this is the other half: **when to re-read, and what to do when the stream is gone.** It
 * frames nothing and renders nothing.
 *
 * Three rules, each a reading of §4.11:
 *
 * 1. **`offer` is a signal, not a payload.** §4.11 promises that a new spark surfaces *on the event,
 *    not a timer* — but the deck's contents are §4.9's read, whose order **is** the server's
 *    (`spark.rowid ASC`). So an `offer` frame triggers a fresh §4.9 read rather than an append:
 *    appending would rebuild deck order client-side from an event stream, which is exactly the
 *    re-derivation §4.9 forbids. The read is **coalesced** — a run that writes several offers in one
 *    transaction must not fan out into one read per frame.
 * 2. **A dead stream falls back to polling, and only while `state = E1`.** E1 is the one state that
 *    moves without the user doing anything, so it is the only one the deck can miss; elsewhere the
 *    vault is idle and every transition is client-initiated (Recompute, a resolution, a save), each of
 *    which re-reads §4.10 anyway. The rate is **bounded**: the delay walks a fixed schedule and holds
 *    at the last value — no unbounded growth, and no fixed-interval hammering either.
 * 3. **Recovery is polling, never a silent re-subscribe.** §4.11's fallback *is* the degraded mode for
 *    the session, so the module does not reconnect behind the caller's back (that would be a retry the
 *    caller cannot see and cannot stop). The next mount subscribes again, and any client-initiated run
 *    re-reads §4.10 — which re-arms the fallback if the state turns out to be E1.
 *
 * It never decides *what a state means* (`domain/deck-state.ts` composes E0–E4) and never invents one:
 * every state it reports came from §4.10 or from §4.11's stream. Pure policy — no React, no request of
 * its own; the reads and the subscriber are injected, so the whole schedule is testable without a
 * socket and without a clock.
 */

/**
 * §4.11's **bound**, in milliseconds: the delay before each successive fallback poll. The last value
 * repeats, so the rate is capped rather than stopped — a run that outlives the schedule keeps being
 * watched, at the slowest rate the bound allows. It starts at 1s because the work being watched is a
 * provider run (seconds, not milliseconds): an immediate poll would be a wasted round-trip, and a
 * timer that emits is precisely what §4.11 says the client must not be.
 */
export const POLL_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

export interface DeckStreamDeps {
  /** §4.11's subscriber — `subscribeEngineEvents` in the screen; a fake in a test. */
  subscribe(handlers: EngineEventHandlers): EngineStream;
  /** §4.10 — the fallback's state read (and the client-initiated re-read after a run is fired). */
  readState(): Promise<EngineState>;
  /** §4.9 — the fallback's deck read (and the refresh an `offer` frame asks for). */
  readDeck(): Promise<Spark[]>;
  /** A state to render: an SSE `state` frame, or a fallback poll's §4.10 read. */
  onState(state: EngineState): void;
  /** The deck to render: a fresh §4.9 array, in the server's order, untouched. */
  onDeck(deck: Spark[]): void;
  /** Override the schedule (a test drives it by hand); defaults to `POLL_BACKOFF_MS`. */
  backoffMs?: readonly number[];
  /** How a delayed poll is booked; returns a canceller. Defaults to `setTimeout`/`clearTimeout`. */
  schedule?: (ms: number, run: () => void) => () => void;
}

export interface DeckStream {
  /**
   * Begin: **issue the subscription, then let the caller read.** §4.11's connect-race rule — *"a client
   * subscribes, then reads §4.9"* — only holds of a client that has actually issued the subscription
   * first, so this returns with the request already in flight (`subscribeEngineEvents` starts its
   * `fetch` in the calling tick for exactly this reason). Idempotent.
   */
  open(): void;
  /**
   * Adopt the state the caller most recently read or was handed (§4.10). This is the fallback's only
   * gate, so it is fed from **every** read the screen makes — the first load, a Recompute's refresh —
   * not only from the stream: a client that re-read its way back to E1 has re-armed the fallback.
   */
  observe(state: EngineState): void;
  /** Stop: cancel any pending poll and close the subscription. The caller's own close is never a "death". */
  close(): void;
}

/** The default booking of a delayed poll, overridable so a test can drive the schedule by hand. */
function defaultSchedule(ms: number, run: () => void): () => void {
  const handle = setTimeout(run, ms);
  return () => clearTimeout(handle);
}

export function createDeckStream(deps: DeckStreamDeps): DeckStream {
  const backoff = deps.backoffMs ?? POLL_BACKOFF_MS;
  const schedule = deps.schedule ?? defaultSchedule;

  /** The subscription was issued. Not "the stream is up" — that is `live`. */
  let opened = false;
  /** The caller closed us: nothing further is reported, and no timer survives it. */
  let closed = false;
  /** The stream is considered up; `onClose` is the only thing that clears it. */
  let live = false;
  /** The newest state we know — from a frame, a poll, or the caller's own §4.10 read. */
  let last: EngineState | null = null;

  let stream: EngineStream | null = null;
  /** The pending poll's canceller, or `null` when no poll is booked. */
  let cancelPoll: (() => void) | null = null;
  /** A poll is booked or in flight — the guard that keeps `reconcile` from starting a second chain. */
  let polling = false;
  /** How many polls this episode has scheduled; indexes into `backoff`. */
  let attempt = 0;

  /** One §4.9 read at a time, with the dirty flag that makes a burst of `offer` frames cost two reads. */
  let deckReading = false;
  let deckDirty = false;

  /** §4.11's gate, in one place: in flight means `PENDING` or `RUNNING` (§4.10 — not `PENDING` alone). */
  function isRunning(): boolean {
    return last !== null && last.state === "E1";
  }

  function stopPolling(): void {
    if (cancelPoll !== null) {
      cancelPoll();
      cancelPoll = null;
    }
    attempt = 0;
    polling = false;
  }

  function bookPoll(): void {
    const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 0;
    attempt += 1;
    cancelPoll = schedule(delay, () => {
      cancelPoll = null;
      void poll();
    });
  }

  /**
   * The one rule that decides whether the fallback runs, evaluated on every observation: **the stream
   * was opened, is down, and the state is E1**. Anything else — a stream that has not been opened, a
   * live stream, an idle vault — leaves no poll booked. Requiring `opened` is what keeps a read landing
   * before `open()` from arming a fallback that would then race the live subscription.
   */
  function reconcile(): void {
    if (closed) return;
    if (opened && !live && isRunning()) {
      if (!polling) {
        polling = true;
        bookPoll();
      }
      return;
    }
    stopPolling();
  }

  /**
   * Adopt a state and report it. The stream and the fallback both land here. `close()` is *"stop
   * reporting"*, so the guard is here rather than at each caller: a frame racing the close is adopted
   * for the gate and dropped for the caller, and a poll that resolves after it reports nothing.
   */
  function adopt(state: EngineState): void {
    if (closed) return;
    last = state;
    deps.onState(state);
  }

  /** The fallback's one tick: read §4.10 and §4.9 together, report both, then decide whether to go on. */
  async function poll(): Promise<void> {
    if (closed) return;
    try {
      // Both, always: §4.11 polls *state + offered*, and reporting a state without its deck would
      // leave the band describing a ladder the cards no longer match.
      const [state, deck] = await Promise.all([deps.readState(), deps.readDeck()]);
      if (closed) return;
      adopt(state);
      deps.onDeck(deck);
    } catch {
      // A failed poll is not a reason to stop: the API may be briefly unreachable, and the state we
      // last saw (E1) is still the only one we can gate on. The schedule — not the failure — is the
      // bound, so the next attempt is booked and the rate stays capped.
    }
    if (closed) return;
    if (isRunning()) {
      bookPoll();
      return;
    }
    // The run ended (or the ladder moved off E1): the deck can no longer change on its own, so the
    // fallback stops here. A later client-initiated read that finds E1 again re-arms it (`reconcile`).
    polling = false;
  }

  /**
   * An `offer` frame: re-read §4.9 rather than append (§4.11 — the event is the signal, the read is the
   * deck). Coalesced, because one run commits its offers in one transaction and the sampler's diff
   * emits them as a burst.
   */
  function refreshDeck(): void {
    if (closed) return;
    if (deckReading) {
      deckDirty = true;
      return;
    }
    deckReading = true;
    void deps.readDeck().then(
      (deck) => {
        deckReading = false;
        if (closed) return;
        deps.onDeck(deck);
        if (deckDirty) {
          deckDirty = false;
          refreshDeck();
        }
      },
      () => {
        // Drop it: the stream is still live, and the next frame — a later offer or a state change —
        // asks again. Inventing a retry here would be a second recovery policy beside the fallback's.
        deckReading = false;
        deckDirty = false;
      },
    );
  }

  /**
   * The stream stopped for a reason the caller did not cause (`api/sparks.ts` reports `ended`,
   * `rejected` and `malformed`). **The reason is deliberately not branched on**: all three mean the
   * same thing to this module — §4.11's transport is not available — and the one recovery the ruling
   * names is the polling fallback, gated on E1.
   */
  function onClose(): void {
    live = false;
    reconcile();
  }

  return {
    open(): void {
      if (opened || closed) return;
      opened = true;
      live = true;
      stream = deps.subscribe({ onState: adopt, onOffer: refreshDeck, onClose });
      // The stream is live, so this is a no-op today; it is stated so the gate has exactly one home.
      reconcile();
    },
    observe(state: EngineState): void {
      // The caller has already rendered this read; adopt it for the gate without re-reporting it.
      last = state;
      reconcile();
    },
    close(): void {
      closed = true;
      stream?.close();
      stopPolling();
    },
  };
}
