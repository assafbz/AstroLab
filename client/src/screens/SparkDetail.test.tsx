// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { SparkDetail } from "./SparkDetail.tsx";

/**
 * S1b's **composition** (`stitch-prompts.md` §2 · `API.md` §3.4/§4.12 · `PRD.md` §3.3 item 4): the
 * idea and its chips, then THE CLAIM · WHAT IT WOULD TAKE · FIRST STEP — the read's fields and nothing
 * else, and the read is its own endpoint so a reload renders without the card it was reached from.
 */

/** §3.4 — `Spark` plus `what_it_takes`. */
const DETAIL = {
  id: "1a2b",
  direction: "Pair the transit lattice with audio",
  claim: "Scheduling and DSP share a shape.",
  first_step: "Instrument the ingest path before the model runs.",
  what_it_takes: "Two weekends on the ingest path, then a week of labelling.",
  domain_tags: ["transit", "audio-dsp"],
  created_at: "2026-10-13T05:14:05Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A `fetch` stub that answers **only** §4.12 — anything else is a `not_found`, so a screen that also
 * read §4.9 (or took the card's payload as a prop) would not render at all.
 */
function stubFetch(impl?: (url: string) => Promise<Response>) {
  const mock = vi.fn((url: string) => (impl ? impl(url) : Promise.resolve(json(DETAIL))));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The labels the screen drew, in document order — the composition's own order, read off the DOM. */
function labels(): (string | null)[] {
  return [...document.querySelectorAll(".section__label")].map((node) => node.textContent);
}

test("the detail composes §2's order: the idea, its chips, then CLAIM · WHAT IT WOULD TAKE · FIRST STEP", async () => {
  stubFetch();
  render(<SparkDetail id="1a2b" />);

  // The idea is the headline, not a labelled field (stitch-prompts.md §2: a large Geist headline).
  expect(await screen.findByRole("heading", { level: 1, name: DETAIL.direction })).toBeTruthy();
  // Then exactly these three sections, in this order — a label set, so a fourth label reddens.
  expect(labels()).toEqual(["THE CLAIM", "WHAT IT WOULD TAKE", "FIRST STEP"]);
  // And each value is the read's, never a literal on the screen.
  expect(document.body.textContent).toContain(DETAIL.claim);
  expect(document.body.textContent).toContain(DETAIL.what_it_takes);
  expect(document.body.textContent).toContain(DETAIL.first_step);
  // The domain tags sit beneath the headline, as chips.
  expect([...document.querySelectorAll(".chip__label")].map((node) => node.textContent)).toEqual(
    DETAIL.domain_tags,
  );
});

test("the composition carries no score, no origin line and no similarity readout (§3.3 item 4)", async () => {
  stubFetch();
  render(<SparkDetail id="1a2b" />);
  await screen.findByRole("heading", { level: 1, name: DETAIL.direction });

  // The governance rule, as one assertion over everything the screen rendered: selection internals
  // never surface, and neither does stitch §2's provenance line (§3.3/§3.4 exclude source idea ids).
  expect(document.body.textContent).not.toMatch(
    /distance|alignment|similar|origin|mechanism|sparked from/i,
  );
});

test("the detail reads its own endpoint — a reload renders from §4.12 alone", async () => {
  const mock = stubFetch();
  render(<SparkDetail id="1a2b" />);
  await screen.findByRole("heading", { level: 1, name: DETAIL.direction });

  // One call, to the by-id route: not a §4.9 re-read, and no deck read to be stale against.
  expect(mock.mock.calls.map((call) => call[0])).toEqual(["/v1/sparks/1a2b"]);
});

test("a `null` what_it_takes is a legacy row and draws no label — no label over nothing (§3.4)", async () => {
  stubFetch(() => Promise.resolve(json({ ...DETAIL, what_it_takes: null })));
  render(<SparkDetail id="1a2b" />);
  await screen.findByRole("heading", { level: 1, name: DETAIL.direction });

  expect(labels()).toEqual(["THE CLAIM", "FIRST STEP"]);
  expect(document.body.textContent).not.toContain("WHAT IT WOULD TAKE");
});

test("a `null` first_step draws no label either (§3.3's legacy-row rule, on the other field)", async () => {
  stubFetch(() => Promise.resolve(json({ ...DETAIL, first_step: null })));
  render(<SparkDetail id="1a2b" />);
  await screen.findByRole("heading", { level: 1, name: DETAIL.direction });

  expect(labels()).toEqual(["THE CLAIM", "WHAT IT WOULD TAKE"]);
  expect(document.body.textContent).not.toContain("FIRST STEP");
});

test("an unknown id is the missing state with a way back — `not_found` is not an error to retry", async () => {
  stubFetch(() =>
    Promise.resolve(json({ error: { code: "not_found", message: "no such spark" } }, 404)),
  );
  render(<SparkDetail id="0bad" />);

  expect(await screen.findByText("This spark is not here.")).toBeTruthy();
  // A way back to the deck, and no Retry: retrying an id the server does not have is a loop.
  expect(screen.getByRole("link", { name: "Back to Sparks" }).getAttribute("href")).toBe("#/");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a failed read offers T29's retry, and the retry recovers in place", async () => {
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    return calls === 1
      ? Promise.resolve(json({ error: { code: "internal_error", message: "boom" } }, 500))
      : Promise.resolve(json(DETAIL));
  });
  render(<SparkDetail id="1a2b" />);

  expect(await screen.findByText("Couldn’t load this spark.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  // Non-destructive: the retry re-reads and the screen shows the spark, no reload of the shell.
  expect(await screen.findByRole("heading", { level: 1, name: DETAIL.direction })).toBeTruthy();
  expect(calls).toBe(2);
});
