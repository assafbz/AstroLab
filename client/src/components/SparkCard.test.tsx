// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import type { Spark } from "../api/types.ts";
import { SparkCard } from "./SparkCard.tsx";

/**
 * S3's **behavioural parity** (`FLOW.md` §5.5): the swipe and the button are the same command with the
 * same payload, and the card renders the `Spark` projection and nothing more (§3.3, `DESIGN.md` §4).
 */

const SPARK: Spark = {
  id: "1a2b",
  direction: "Route the overflow by relevance",
  claim: "The default metric is not the relevant one.",
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["audio-dsp", "transit"],
  created_at: "2026-10-13T05:14:05Z",
};

afterEach(cleanup);

function renderCard() {
  const onResolve = vi.fn();
  render(<SparkCard spark={SPARK} onResolve={onResolve} swipeDistance={48} />);
  return { onResolve, card: screen.getByLabelText("Spark") };
}

/** The same card over a payload the test chooses — the one caller that needs a legacy row. */
function renderPayload(spark: Spark) {
  render(<SparkCard spark={spark} onResolve={vi.fn()} swipeDistance={48} />);
  return { card: screen.getByLabelText("Spark") };
}

test("the card shows the idea, the claim and the raw domain chips — and nothing from §3.3's ban", () => {
  const { card } = renderCard();

  expect(card.textContent).toContain(SPARK.direction);
  expect(card.textContent).toContain(SPARK.claim);
  expect(card.textContent).toContain("audio-dsp");
  expect(card.textContent).toContain("transit");
  // No origin, no mechanism, no distance/alignment/similarity readout (§1 governance rule, §7).
  expect(card.textContent).not.toMatch(/distance|alignment|similar|origin|mechanism/i);
});

test("the card draws FIRST STEP from the payload, between THE CLAIM and the chips (§1's order)", () => {
  const { card } = renderCard();

  // The order is the spec's (stitch-prompts.md §1): IDEA · CLAIM · FIRST STEP · chips. Reading the
  // labels off the card is what makes it an order check rather than a presence check.
  expect([...card.querySelectorAll(".section__label")].map((node) => node.textContent)).toEqual([
    "THE IDEA",
    "THE CLAIM",
    "FIRST STEP",
  ]);
  // And the value is the read's, not a literal on the card.
  expect(card.textContent).toContain(SPARK.first_step);
  expect(card.querySelector(".sparkcard__firststep")?.textContent).toBe(SPARK.first_step);
});

test("a `null` FIRST STEP is absent — no label over nothing, and no filler (§3.3)", () => {
  // `null` is a legacy row (#115): the label must not be drawn above an empty value, and the card must
  // not invent a step the payload did not carry.
  const { card } = renderPayload({ ...SPARK, first_step: null });
  expect(card.textContent).not.toContain("FIRST STEP");
  expect(card.querySelector(".sparkcard__firststep")).toBeNull();
});

test("a swipe right and a Good press hand the seam identical arguments — the same path, not two", () => {
  const { onResolve, card } = renderCard();

  fireEvent.pointerDown(card, { clientX: 0 });
  fireEvent.pointerUp(card, { clientX: 200 });
  fireEvent.click(screen.getByRole("button", { name: "Good" }));

  expect(onResolve).toHaveBeenCalledTimes(2);
  expect(onResolve.mock.calls[0]).toEqual([SPARK.id, "ACCEPT"]);
  // Byte-for-byte the same command: the second call repeats the first exactly.
  expect(onResolve.mock.calls[1]).toEqual(onResolve.mock.calls[0]);
});

test("a swipe left and a Not-for-me press hand the seam identical arguments", () => {
  const { onResolve, card } = renderCard();

  fireEvent.pointerDown(card, { clientX: 200 });
  fireEvent.pointerUp(card, { clientX: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Not for me" }));

  expect(onResolve).toHaveBeenCalledTimes(2);
  expect(onResolve.mock.calls[0]).toEqual([SPARK.id, "DISMISS"]);
  expect(onResolve.mock.calls[1]).toEqual(onResolve.mock.calls[0]);
});

test("a drag under the threshold resolves nothing — the buttons stay the only path", () => {
  const { onResolve, card } = renderCard();

  fireEvent.pointerDown(card, { clientX: 10 });
  fireEvent.pointerUp(card, { clientX: 40 });

  expect(onResolve).not.toHaveBeenCalled();
});

test("the buttons are always present — the deck is operable without a gesture (§5.5)", () => {
  renderCard();

  expect(screen.getByRole("button", { name: "Good" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Not for me" })).toBeTruthy();
});
