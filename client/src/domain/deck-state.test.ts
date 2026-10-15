import { expect, test } from "vitest";

import { deckBand, type VaultCoverage } from "./deck-state.ts";
import type { EngineState, Spark } from "../api/types.ts";

/**
 * `DESIGN.md` §9's precedence, at the one place the client can invert it: the band. Each test names
 * the layer it would redden, and the "overlapping states" group is the three rows that only pass if
 * the order is right.
 */

const COVERAGE: VaultCoverage = { resolved_domains: 3, floor: 2, target: 3 };

const SPARK: Spark = {
  id: "1a2b",
  direction: "Route the overflow by relevance",
  claim: "The default metric is not the relevant one.",
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["audio-dsp"],
  created_at: "2026-10-13T05:14:05Z",
};

const SECOND: Spark = { ...SPARK, id: "9f1c" };

const DECK: Spark[] = [SPARK, SECOND];

function state(
  name: EngineState["state"],
  unreviewed: number,
  run: EngineState["run"] = null,
): EngineState {
  return { state: name, unreviewed, run };
}

test("the overlapping states — the three rows that only pass if the order is right", () => {
  // 1 · E0 dominates: three cards are sitting in the read, and none of them draws.
  expect(deckBand(state("E0", 3), DECK, COVERAGE)).toEqual({
    cold: true,
    cards: [],
    shimmer: false,
    exhausted: false,
    widen: false,
    paused: false,
  });

  // 2 · E4 keeps the deck: the paused notice composes *around* the cards, never instead of them.
  expect(deckBand(state("E4", 2), DECK, COVERAGE)).toEqual({
    cold: false,
    cards: DECK,
    shimmer: false,
    exhausted: false,
    widen: false,
    paused: true,
  });

  // 3 · E1 sits with the cards — never a full-screen takeover.
  expect(
    deckBand(state("E1", 2, { id: "r-42", status: "RUNNING", vault_revision: 42 }), DECK, COVERAGE),
  ).toEqual({
    cold: false,
    cards: DECK,
    shimmer: true,
    exhausted: false,
    widen: false,
    paused: false,
  });
});

test("E2 is the deck and nothing else", () => {
  const band = deckBand(state("E2", 2), DECK, COVERAGE);

  expect(band).toEqual({
    cold: false,
    cards: DECK,
    shimmer: false,
    exhausted: false,
    widen: false,
    paused: false,
  });
});

test("E3 draws the composed empty — and no card: the deck read is empty there by definition", () => {
  // A card in the read alongside `state = E3` is a contradiction between §4.10 and §4.9 (E3 *is* 0
  // unreviewed), and the state's own truth is what draws.
  expect(deckBand(state("E3", 0), DECK, COVERAGE)).toEqual({
    cold: false,
    cards: [],
    shimmer: false,
    exhausted: true,
    widen: false,
    paused: false,
  });
});

test("E3's widening nudge appears at exactly the floor, and nowhere else (§9)", () => {
  const at = (resolved: number) =>
    deckBand(state("E3", 0), [], { ...COVERAGE, resolved_domains: resolved });

  expect(at(2).widen).toBe(true);
  expect(at(3).widen).toBe(false);
  expect(at(4).widen).toBe(false);
});

test("the cards are the read, untouched — a local sort or filter would break the identity", () => {
  // §4.9: deck order *is* server order. The band hands the array through, so any re-derivation is a
  // new array here and reddens — the count it renders is §4.10's, and the band carries no number.
  const band = deckBand(state("E2", 2), DECK, COVERAGE);

  expect(band.cards).toBe(DECK);
  expect(Object.keys(band)).not.toContain("unreviewed");
});

test("E4 does not take the count with it: the paused band still reports the deck it keeps", () => {
  const band = deckBand(state("E4", 2), DECK, COVERAGE);

  expect(band.paused).toBe(true);
  expect(band.cards).toHaveLength(2);
});
