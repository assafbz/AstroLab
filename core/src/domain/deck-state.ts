import type { EngineState, Spark } from "../types.js";

/**
 * S1's **band composition** — `DESIGN.md` §9, `FLOW.md` §4.1. The state itself is not decided here:
 * E0–E4 arrives computed from `GET /v1/sparks/state` (§4.10, `core/src/vault/engine-state.ts`), and this
 * module answers a different question — **which layer of the band draws what**, in the order §4.1
 * pins.
 *
 * > E0 dominates all · E4 > E3 · E1 may coexist with E2 · never a full-screen takeover.
 *
 * - **E0 dominates**: with no domain spread there is no spark to compute, review or await, so the band
 *   is the cold composition and *nothing else* — no cards from a stale deck read, no shimmer.
 * - **E4 keeps the deck**: already-offered sparks stay reviewable when the provider is down
 *   (`FLOW.md` §5.6, NFR-A1) — the paused notice + Retry composes *around* the cards, never instead
 *   of them.
 * - **E1 coexists**: the shimmer sits *with* the cards, at the in-flight work's position.
 * - **E3** is the composed empty state, and it is the one state whose deck read is empty **by
 *   definition** — E3 means 0 unreviewed, so a card there would be a contradiction between the two
 *   reads, and the state's own truth is what draws.
 *
 * Pure: no request, no React, no state. The screen renders what this returns, and the *count* it
 * renders is the server's `unreviewed` — the band deliberately carries no number of its own, so no
 * layer of it can drift into a local tally.
 */

/** §9's `x / 3` readout and its nudge, read from §3.2's payload — never from a literal. */
export interface VaultCoverage {
  /** Distinct clusters covered — the readout's numerator. */
  resolved_domains: number;
  /** The spark floor (E0's trigger), where §9's widening nudge appears. */
  floor: number;
  /** The onboarding target — the readout's denominator. */
  target: number;
}

export interface DeckBand {
  /** **E0** — the band draws the cold composition and nothing else. */
  cold: boolean;
  /** The cards to draw one at a time, in the read's order (never re-sorted, never filtered). */
  cards: Spark[];
  /** **E1** — the skeletal shimmer, drawn *with* the cards, never over them. */
  shimmer: boolean;
  /** **E3** — the composed empty state (`"No sparks left — for now."`), never a bare line. */
  exhausted: boolean;
  /** **E3 at exactly the floor** — §9's widening nudge: *"One more field widens what can spark."* */
  widen: boolean;
  /** **E4** — the quiet `"Sparks are paused."` notice + Retry, under cards that stay reviewable. */
  paused: boolean;
}

/**
 * The one order, stated once: E0 is asked **first** and returns before any other layer is considered;
 * the rest are read off the server's own precedence, which already resolved E4 > E3 and put E1 above
 * E2 for us.
 */
export function deckBand(state: EngineState, deck: Spark[], coverage: VaultCoverage): DeckBand {
  const quiet: Omit<DeckBand, "cold" | "cards"> = {
    shimmer: false,
    exhausted: false,
    widen: false,
    paused: false,
  };

  if (state.state === "E0") return { cold: true, cards: [], ...quiet };

  const band: DeckBand = { cold: false, cards: deck, ...quiet };

  switch (state.state) {
    case "E1":
      // In flight: the shimmer joins the cards rather than replacing them.
      return { ...band, shimmer: true };
    case "E3":
      // 0 unreviewed by definition — the deck read is empty here, and the state is what draws.
      return {
        ...band,
        cards: [],
        exhausted: true,
        widen: coverage.resolved_domains === coverage.floor,
      };
    case "E4":
      // The AI is down; the vault is not. Cards stay, and the notice waits beneath them.
      return { ...band, paused: true };
    case "E2":
      return band;
  }
}
