// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Sparks } from "./Sparks.tsx";

/**
 * S3's **screen wiring**: the band is composed from §4.10 + §4.9 and drawn, the header count is
 * §4.10's `unreviewed`, and the deck's order is the read's order — the server's, never a local sort.
 * Each test names the layer it would redden.
 */

const COLD = {
  resolved_domains: 1,
  provisional_domains: 2,
  target: 3,
  floor: 2,
  eligible: false,
};

const OPEN = { ...COLD, resolved_domains: 3, eligible: true };

/** §3.9's `Spark` projection; the deck's order is the array's order. */
const FIRST = {
  id: "aaa1",
  direction: "Route the overflow by relevance",
  claim: "The default metric is not the relevant one.",
  domain_tags: ["audio-dsp"],
  created_at: "2026-10-14T05:14:05Z",
};

const SECOND = {
  id: "bbb2",
  direction: "Pair the transit lattice with audio",
  claim: "Scheduling and DSP share a shape.",
  domain_tags: ["transit"],
  created_at: "2026-10-13T05:14:05Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Reads {
  summary?: unknown;
  state?: unknown;
  sparks?: unknown;
}

function state(name: string, unreviewed: number, run: unknown = null) {
  return { state: name, unreviewed, run };
}

/** Route by route, so a read cannot silently receive another route's payload. */
function stubDeck(reads: Reads) {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/sparks/state")) {
      return Promise.resolve(json(reads.state ?? state("E2", 1)));
    }
    if (url.includes("/v1/sparks?state=offered")) {
      return Promise.resolve(json({ sparks: reads.sparks ?? [] }));
    }
    if (url.includes("/v1/vault/summary")) {
      return Promise.resolve(json(reads.summary ?? OPEN));
    }
    return Promise.resolve(json({ error: { code: "not_found", message: "no route" } }, 404));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("E0 — §4.10's state draws the cold composition and nothing else", async () => {
  stubDeck({ state: state("E0", 0), sparks: [FIRST], summary: COLD });
  render(<Sparks />);

  await screen.findByLabelText("Sparks need more domains");
  // No card from the read that is sitting there, no shimmer, no header count (E0 is a breadth state).
  expect(screen.queryByLabelText("Spark")).toBeNull();
  expect(screen.queryByText("1 unreviewed")).toBeNull();
});

test("the landing follows §4.10's state, not a local read of the summary", async () => {
  // The summary's own `eligible` is false, but §4.10 says E2 with a card: the state read is the deck's
  // only state input (the ruling on Call 1), so the card draws and E0 does not.
  stubDeck({ summary: COLD, state: state("E2", 1), sparks: [FIRST] });
  render(<Sparks />);

  expect((await screen.findByLabelText("Spark")).textContent).toContain(FIRST.direction);
  expect(screen.queryByLabelText("Sparks need more domains")).toBeNull();
});

test("the header count is §4.10's `unreviewed`, never the deck read's length", async () => {
  stubDeck({ state: state("E2", 7), sparks: [FIRST, SECOND] });
  render(<Sparks />);

  await screen.findByLabelText("Spark");
  expect(screen.getByText("7 unreviewed")).toBeTruthy();
});

test("the card shown is the read's first — §4.9's order is deck order, no local sort", async () => {
  // Server order: FIRST (created later) then SECOND. Sorting by `created_at` ascending would flip the
  // two and redden this; the screen must draw the head of the array it was handed.
  stubDeck({ state: state("E2", 2), sparks: [FIRST, SECOND] });
  render(<Sparks />);

  const card = await screen.findByLabelText("Spark");
  expect(card.textContent).toContain(FIRST.direction);
  expect(card.textContent).not.toContain(SECOND.direction);
});

test("E1 — the shimmer sits with the cards, never instead of them", async () => {
  stubDeck({
    state: state("E1", 1, { id: "r-42", status: "RUNNING", vault_revision: 42 }),
    sparks: [FIRST],
  });
  render(<Sparks />);

  expect((await screen.findByLabelText("Spark")).textContent).toContain(FIRST.direction);
  expect(screen.getByRole("status").textContent).toContain("Computing sparks");
});

test("E4 — the paused notice composes around cards that stay reviewable (NFR-A1)", async () => {
  stubDeck({ state: state("E4", 1), sparks: [FIRST] });
  render(<Sparks />);

  expect((await screen.findByLabelText("Spark")).textContent).toContain(FIRST.direction);
  expect(screen.getByText("Sparks are paused. Your vault is fully available.")).toBeTruthy();
});

test("E3 — the composed empty, with §9's widening nudge only at the floor", async () => {
  stubDeck({ state: state("E3", 0), sparks: [], summary: { ...OPEN, resolved_domains: 2 } });
  render(<Sparks />);

  expect(await screen.findByText("No sparks left — for now.")).toBeTruthy();
  expect(screen.getByText(/One more field widens what can spark\./)).toBeTruthy();
  expect(screen.queryByLabelText("Spark")).toBeNull();
});

test("E3 above the floor gets no widening nudge — Fork and Recompute are its levers", async () => {
  stubDeck({ state: state("E3", 0), sparks: [], summary: OPEN });
  render(<Sparks />);

  await screen.findByText("No sparks left — for now.");
  expect(screen.queryByText(/One more field widens what can spark\./)).toBeNull();
});

test("a failed read says so and retries — it never shows E0 as a guess", async () => {
  // The first pass fails every route; flipping the flag lets the retry succeed.
  let failing = true;
  const mock = vi.fn((input: RequestInfo | URL) => {
    if (failing) {
      return Promise.resolve(json({ error: { code: "internal_error", message: "boom" } }, 500));
    }
    const url = String(input);
    if (url.includes("/v1/sparks/state")) return Promise.resolve(json(state("E0", 0)));
    if (url.includes("/v1/sparks?state=offered")) return Promise.resolve(json({ sparks: [] }));
    return Promise.resolve(json(COLD));
  });
  vi.stubGlobal("fetch", mock);
  render(<Sparks />);

  expect(await screen.findByText("Sparks are out of reach.")).toBeTruthy();
  expect(screen.queryByLabelText("Sparks need more domains")).toBeNull();
  // The retry re-issues the reads; the second answer is a cold vault, so E0 lands.
  failing = false;
  screen.getByRole("button", { name: "Try again" }).click();
  expect(await screen.findByLabelText("Sparks need more domains")).toBeTruthy();
});
