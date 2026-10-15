import { useCallback, useEffect, useState } from "react";

import { engineState, offeredSparks } from "../api/sparks.ts";
import type { EngineState, Spark, VaultSummary } from "../api/types.ts";
import { vaultSummary } from "../api/vault.ts";
import { ColdState } from "../components/ColdState.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { Shimmer } from "../components/Shimmer.tsx";
import { SparkCard } from "../components/SparkCard.tsx";
import { deckBand, type DeckBand } from "../domain/deck-state.ts";
import type { ResolveSeam } from "../domain/deck-interaction.ts";

/**
 * S1 — Sparks, the home and the review queue (`FLOW.md` §2.1, `DESIGN.md` §9).
 *
 * **The state is not derived here.** §4.10 (`GET /v1/sparks/state`, W8 `#33`) computes E0–E4 and its
 * precedence once, server-side; the deck read is §4.9 (`GET /v1/sparks?state=offered`, K1 `#35`), whose
 * **order is deck order**. This screen does the one client-side thing the ruling allows: it composes
 * the **band** — which layer draws what — through `domain/deck-state.ts`, and renders it. It sorts
 * nothing, tallies nothing, and re-derives no state.
 *
 * Reads, in one load: the summary (only for E0's readout and the E3-at-floor nudge — the gate itself is
 * `eligible`, the server's), §4.10's state, and §4.9's deck. The **count in the header is §4.10's
 * `unreviewed`**, never the length of the deck read, so the two cannot drift while a run is in flight.
 */
export function Sparks() {
  const [reads, setReads] = useState<DeckReads | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setReads(await readDeck());
    } catch {
      // The read failed, not the vault: the screen says so and offers the retry, never a silent E0
      // (which would tell the user to add ideas when the truth is unknown).
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
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

  return <Band band={band} unreviewed={reads.state.unreviewed} summary={reads.summary} />;
}

/** §4.10's state · §4.9's deck · §3.2's summary — the three reads the band composes from. */
interface DeckReads {
  state: EngineState;
  sparks: Spark[];
  summary: VaultSummary;
}

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
function Band(props: { band: DeckBand; unreviewed: number; summary: VaultSummary }) {
  const { band } = props;
  /** The read's head — the card the deck shows one at a time (§4.9's order, untouched). */
  const [head] = band.cards;

  // E0 dominates: the cold composition and nothing else — no cards from a stale read, no shimmer.
  if (band.cold) return <ColdState summary={props.summary} />;

  return (
    <section className="deck">
      <header className="deck__head">
        <h1 className="screen__title">Sparks</h1>
        {/* The mono count is §4.10's `unreviewed` — truthful in every state, including E1 (§3.6). */}
        <p className="mono deck__count">{`${props.unreviewed} unreviewed`}</p>
      </header>

      {/* §4.9's head, one card at a time. Its order is deck order; nothing here sorts or filters. */}
      {head ? <SparkCard spark={head} onResolve={resolve} /> : null}

      {/* E1 sits *with* the cards — in-flight work, never a full-screen takeover. */}
      {band.shimmer ? <Shimmer label="Computing sparks…" /> : null}

      {/* E3 is the composed empty; at exactly the floor it adds §9's widening nudge. */}
      {band.exhausted ? (
        <EmptyState
          title="No sparks left — for now."
          body={
            band.widen
              ? `domains covered ${props.summary.resolved_domains} / ${props.summary.target} — One more field widens what can spark.`
              : "Fork an idea into a new domain, or recompute."
          }
          action={{ label: "Add idea", href: "#/capture" }}
        />
      ) : null}

      {/* E4 is quiet and non-blocking: the notice composes *around* reviewable cards (NFR-A1). */}
      {band.paused ? (
        <p className="banner" role="status">
          <span className="banner__body">Sparks are paused. Your vault is fully available.</span>
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
