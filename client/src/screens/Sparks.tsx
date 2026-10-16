import { useCallback, useEffect, useRef, useState } from "react";

import { enqueueRun, engineState, offeredSparks, subscribeEngineEvents } from "../api/sparks.ts";
import type { EngineState, Spark, VaultSummary } from "../api/types.ts";
import { vaultSummary } from "../api/vault.ts";
import { ColdState } from "../components/ColdState.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import { SparkCard } from "../components/SparkCard.tsx";
import { deckBand, type DeckBand } from "../domain/deck-state.ts";
import { createDeckStream, type DeckStream } from "../domain/deck-stream.ts";
import type { ResolveSeam } from "../domain/deck-interaction.ts";
import { createRunTrigger } from "../domain/run-trigger.ts";
import { sparkHref } from "../router.ts";

/**
 * S1 — Sparks, the home and the review queue (`FLOW.md` §2.1, `DESIGN.md` §9).
 *
 * **The state is not derived here.** §4.10 (`GET /v1/sparks/state`, W8 `#33`) computes E0–E4 and its
 * precedence once, server-side; the deck read is §4.9 (`GET /v1/sparks?state=offered`, K1 `#35`), whose
 * **order is deck order**. This screen does the one client-side thing the ruling allows: it composes
 * the **band** — which layer draws what — through `domain/deck-state.ts`, and renders it. It sorts
 * nothing, tallies nothing, and re-derives no state.
 *
 * S4 adds the two halves §4.11 left to the client: the **subscription** (consume `state` / `offer`, and
 * re-read §4.9 when one arrives — the stream is a signal, the read is the deck) and the **fallback**
 * when the stream dies mid-run. Both live in `domain/deck-stream.ts`; this file only wires them, and the
 * rule it has to get right is §4.11's ordering — **subscribe first, then read §4.9**.
 *
 * Reads, in one load: the summary (only for E0's readout and the E3-at-floor nudge — the gate itself is
 * `eligible`, the server's), §4.10's state, and §4.9's deck. The **count in the header is §4.10's
 * `unreviewed`**, never the length of the deck read, so the two cannot drift while a run is in flight.
 */
export function Sparks() {
  const [reads, setReads] = useState<DeckReads | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<DeckView>("deck");
  const streamRef = useRef<DeckStream | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const next = await readDeck();
      setReads(next);
      // The fallback's gate (§4.11). Fed from **every** §4.10 read the screen makes — the first load
      // and a Recompute's refresh alike — so a client-initiated run re-arms it when the stream is down.
      streamRef.current?.observe(next.state);
    } catch {
      // The read failed, not the vault: the screen says so and offers the retry, never a silent E0
      // (which would tell the user to add ideas when the truth is unknown).
      setFailed(true);
    }
  }, []);

  /**
   * The one run trigger (O5 `#25`, `domain/run-trigger.ts`): **Recompute** in E3 and **Retry** in E4 are
   * the same POST at the same edge (§4.16's dedup is per `PENDING` run, so a second POST while one is
   * `RUNNING` inserts a second row), so they share the one press-scoped guard rather than carrying one
   * each — a second module here would be a second place for the rule to drift (§5.5's reasoning).
   *
   * The refresh is attached to the POST's **settlement**, not to the press: the client must not assume
   * the run it just fired (that is the *"we just ran one"* flag §4.10 exists to remove). It re-reads
   * §4.10 and §4.9, and whatever the ladder says then is what renders — E1 included, if the run is real.
   */
  const [runTrigger] = useState(() =>
    createRunTrigger(() => enqueueRun().finally(() => void load())),
  );

  useEffect(() => {
    const stream = createDeckStream({
      subscribe: subscribeEngineEvents,
      readState: engineState,
      readDeck: offeredSparks,
      onState: (state) => setReads((current) => (current ? { ...current, state } : current)),
      onDeck: (sparks) => setReads((current) => (current ? { ...current, sparks } : current)),
    });
    streamRef.current = stream;

    // §4.11's connect-race rule, in the order it states: **a client subscribes, then reads §4.9.** The
    // subscription is issued in this tick (S1's own rule) and the reads follow it, so a commit landing
    // while the connection is being set up is either in that read or on the next tick's diff, never
    // neither. A frame that beats the first read is not lost either — it is in the read, or it repeats.
    stream.open();
    void load();

    return () => {
      streamRef.current = null;
      stream.close();
    };
  }, [load]);

  if (reads === null) {
    if (!failed) {
      return (
        <p className="sr-only" role="status">
          Loading your sparks…
        </p>
      );
    }
    return (
      <EmptyState
        title="Sparks are out of reach."
        body="Your vault is still there — the spark state needs its reads to answer."
        action={{ label: "Try again", onClick: () => void load() }}
      />
    );
  }

  const band = deckBand(reads.state, reads.sparks, {
    resolved_domains: reads.summary.resolved_domains,
    floor: reads.summary.floor,
    target: reads.summary.target,
  });

  return (
    <Band
      band={band}
      unreviewed={reads.state.unreviewed}
      summary={reads.summary}
      view={view}
      onToggleView={() => setView((current) => (current === "deck" ? "list" : "deck"))}
      onRun={() => void runTrigger.fire()}
    />
  );
}

/** §4.10's state · §4.9's deck · §3.2's summary — the three reads the band composes from. */
interface DeckReads {
  state: EngineState;
  sparks: Spark[];
  summary: VaultSummary;
}

/** §2.1 S1: the deck is the default, **View all** the escape hatch. UI state, not a route. */
type DeckView = "deck" | "list";

async function readDeck(): Promise<DeckReads> {
  const [state, sparks, summary] = await Promise.all([
    engineState(),
    offeredSparks(),
    vaultSummary(),
  ]);
  return { state, sparks, summary };
}

/**
 * The band (`DESIGN.md` §9): one frame between the header and the nav, and the state changes only its
 * contents. Each layer is already decided by `deckBand`; this draws it.
 */
function Band(props: {
  band: DeckBand;
  unreviewed: number;
  summary: VaultSummary;
  view: DeckView;
  onToggleView: () => void;
  onRun: () => void;
}) {
  const { band } = props;
  /** The read's head — the card the deck shows one at a time (§4.9's order, untouched). */
  const [head] = band.cards;

  // E0 dominates: the cold composition and nothing else — no cards from a stale read, no shimmer.
  if (band.cold) return <ColdState summary={props.summary} />;

  // §4.1 E2 / DESIGN §9: the toggle's bar is **n > 1**, and n is §4.10's `unreviewed` — the number the
  // header already shows, never `cards.length`. The list is the escape hatch for a count, not for an
  // array; and with one spark to review there is nothing to escape to.
  const listable = props.unreviewed > 1;
  const listing = listable && props.view === "list";

  return (
    <section className="deck">
      <header className="deck__head">
        <h1 className="screen__title">Sparks</h1>
        {/* The mono count is §4.10's `unreviewed` — truthful in every state, including E1 (§3.6). */}
        <p className="mono deck__count">{`${props.unreviewed} unreviewed`}</p>
        {listable ? (
          <button
            type="button"
            className="button button--ghost deck__toggle"
            onClick={props.onToggleView}
          >
            {listing ? "One at a time" : "View all"}
          </button>
        ) : null}
      </header>

      {/* §4.9's head, one card at a time — or, on the toggle, the same read as a list. Either way its
          order is deck order, and nothing here sorts or filters. */}
      {listing ? (
        <ul className="list">
          {band.cards.map((spark) => (
            <li key={spark.id}>
              <SparkCard spark={spark} onResolve={resolve} onOpen={openSpark} />
            </li>
          ))}
        </ul>
      ) : head ? (
        <SparkCard spark={head} onResolve={resolve} onOpen={openSpark} />
      ) : null}

      {/* E1 sits *with* the cards — in-flight work, never a full-screen takeover. Nothing about a
          dropped stream changes that: the fallback re-reads, and until it answers the band is the last
          truth the server gave. */}
      {band.shimmer ? <Shimmer label="Computing sparks…" /> : null}

      {/* E3 is the composed empty; at exactly the floor it adds §9's widening nudge, and its levers are
          Add idea + Recompute (§5.3; the Fork CTA lands with S5, which owns that route). */}
      {band.exhausted ? (
        <EmptyState
          title="No sparks left — for now."
          body={
            band.widen
              ? `domains covered ${props.summary.resolved_domains} / ${props.summary.target} — One more field widens what can spark.`
              : "Fork an idea into a new domain, or recompute."
          }
          action={{ label: "Add idea", href: "#/capture" }}
          secondary={{ label: "Recompute", onClick: props.onRun }}
        />
      ) : null}

      {/* E4 is quiet and non-blocking: the notice composes *around* reviewable cards (NFR-A1), and its
          one lever is Retry (→ E1) — the same guarded run trigger as E3's Recompute. */}
      {band.paused ? (
        <p className="banner">
          <span className="banner__body" role="status">
            Sparks are paused. Your vault is fully available.
          </span>
          <button type="button" className="button button--ghost" onClick={props.onRun}>
            Retry
          </button>
        </p>
      ) : null}
    </section>
  );
}

/**
 * The deck's resolution seam — **the call itself is K4 `#38`'s** (`POST /v1/sparks/{id}/decision`).
 * This slice wires the path (card → the one `onResolve`) and leaves the seat the decision API will
 * occupy; until then a Good / Not for me press resolves nothing rather than inventing a request, so the
 * deck never claims a decision the server has not recorded. Undo (K5) and Recompute (S4) meet the same
 * edge.
 */
const resolve: ResolveSeam = () => {};

/**
 * T08 — the card's **tap** opens S1b (`#/sparks/<id>`, `FLOW.md` §4.5). It is a route change, not a
 * resolution: the deck stays where it is, and the tapped spark is read again by its own §4.12 read, so
 * nothing here hands the detail a payload to be stale against.
 */
function openSpark(id: string): void {
  window.location.hash = sparkHref(id);
}
