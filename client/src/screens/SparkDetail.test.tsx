// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { SparkCard } from "../components/SparkCard.tsx";
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
 * §4.13's request body, read off the stub's `init` — the decision id is what the tests read back.
 */
function bodyOf(init?: RequestInit): { decision_id: string; kind: string } {
  return JSON.parse(String(init?.body ?? "{}")) as { decision_id: string; kind: string };
}

/** The `Decision` (§3.5) the server would record for a §4.13 body. */
function decisionResponse(url: string, body: { decision_id: string; kind: string }) {
  const sparkId = url.split("/v1/sparks/")[1]!.split("/")[0]!;
  return {
    decision_id: body.decision_id,
    spark_id: sparkId,
    kind: body.kind,
    result_idea_id: body.kind === "ACCEPT" ? "9f1c" : null,
    spark_status: body.kind === "ACCEPT" ? "RESOLVED-ACCEPTED" : "RESOLVED-DISMISSED",
    decided_at: "2026-10-16T09:00:00Z",
    undoable: true,
  };
}

/**
 * A `fetch` stub that answers **only** §4.12 and §4.13 — anything else is a `not_found`, so a screen
 * that also read §4.9 (or took the card's payload as a prop) would not render at all.
 */
function stubFetch(impl?: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn((url: string, init?: RequestInit) =>
    impl
      ? impl(url, init)
      : Promise.resolve(
          json(url.includes("/decision") ? decisionResponse(url, bodyOf(init)) : DETAIL),
        ),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Every §4.13 call the screen made, with the body it carried — in call order. */
function decisionCalls(mock: ReturnType<typeof stubFetch>) {
  return mock.mock.calls
    .filter((call) => String(call[0]).includes("/decision"))
    .map((call) => ({ url: String(call[0]), body: bodyOf(call[1]) }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The resolution's one side effect is the route change (back to the deck); leaving it set would leak
  // into the next test, the same way it would for the tap in `Sparks.test.tsx`.
  window.location.hash = "";
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

test("Good hands the seam the same command the card sends — one shape, per screen (§5.5)", async () => {
  const cardSeam = vi.fn();
  const card = render(<SparkCard spark={DETAIL} onResolve={cardSeam} />);
  fireEvent.click(screen.getByRole("button", { name: "Good" }));
  card.unmount();

  const detailSeam = vi.fn();
  stubFetch();
  render(<SparkDetail id={DETAIL.id} onResolve={detailSeam} />);
  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  expect(detailSeam.mock.calls[0]).toEqual([DETAIL.id, "ACCEPT"]);
  // Byte-for-byte the card's command: the detail consumes the deck's own `ResolveSeam`, so K7 has one
  // shape to plug into per screen rather than two that must be kept in agreement.
  expect(detailSeam.mock.calls[0]).toEqual(cardSeam.mock.calls[0]);
});

test("Not for me is the second kind on the same path — and it is not the first", async () => {
  const detailSeam = vi.fn();
  stubFetch();
  render(<SparkDetail id={DETAIL.id} onResolve={detailSeam} />);
  fireEvent.click(await screen.findByRole("button", { name: "Not for me" }));

  expect(detailSeam.mock.calls).toEqual([[DETAIL.id, "DISMISS"]]);
});

test("with no seam supplied the screen resolves through its own module — the press posts §4.13 (K7)", async () => {
  const mock = stubFetch();
  render(<SparkDetail id={DETAIL.id} />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  // K3's seat was inert because nothing could post; K7 wires the **screen's own** resolver, so the app
  // path (no `onResolve` supplied) is the one that resolves: §4.12's read, then §4.13's write, nothing
  // else. The injected seam below still overrides it, which is what keeps the parity check honest.
  await waitFor(() => expect(decisionCalls(mock)).toHaveLength(1));
  expect(mock.mock.calls.map((call) => call[0])).toEqual([
    "/v1/sparks/1a2b",
    "/v1/sparks/1a2b/decision",
  ]);
});

test("a commit returns to the deck — the card is gone, so the detail would show what is not offered (4a)", async () => {
  const mock = stubFetch();
  render(<SparkDetail id={DETAIL.id} />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  await waitFor(() => expect(window.location.hash).toBe("#/"));
  // A real client-generated key (§2.2), not a literal — the id a Retry would have to re-issue.
  expect(decisionCalls(mock)[0]!.body.decision_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
});

test("a retryable failure keeps the detail and draws T29's notice; Retry re-issues the same id (K7)", async () => {
  let decisions = 0;
  const mock = stubFetch((url, init) => {
    if (!url.includes("/decision")) return Promise.resolve(json(DETAIL));
    decisions += 1;
    // §2 gives a rejected `fetch` the `network` code — the T29 case the surface exists for.
    return decisions === 1
      ? Promise.reject(new Error("dropped"))
      : Promise.resolve(json(decisionResponse(url, bodyOf(init))));
  });
  render(<SparkDetail id={DETAIL.id} />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  const notice = (await screen.findByText(/Nothing was recorded/)).closest("p")!;
  // The detail stays: no read ran, and the spark is still drawn.
  expect(screen.getByRole("heading", { level: 1, name: DETAIL.direction })).toBeTruthy();
  expect(window.location.hash).not.toBe("#/");

  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(decisionCalls(mock)).toHaveLength(2));
  // §2.2: the retry carries the same key, so a commit the response lost is answered by §4.13's repeat.
  expect(decisionCalls(mock)[1]!.body.decision_id).toBe(decisionCalls(mock)[0]!.body.decision_id);
  // …and when it commits, the deck is where the user lands.
  await waitFor(() => expect(window.location.hash).toBe("#/"));
});

test("a `409` returns to the deck and offers no Retry — the spark is not OFFERED, so a Retry would loop (4b)", async () => {
  stubFetch((url) =>
    url.includes("/decision")
      ? Promise.resolve(json({ error: { code: "conflict", message: "spark is not OFFERED" } }, 409))
      : Promise.resolve(json(DETAIL)),
  );
  render(<SparkDetail id={DETAIL.id} />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  // The server stated a truth; the client re-reads the deck (the route change mounts S1, which reads
  // §4.10 + §4.9) rather than retrying against it.
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(screen.queryByText(/Nothing was recorded/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("an injected seam overrides the screen's own — the parity path is still the seam's (K7)", async () => {
  // What `onResolve` is *for* now: the §5.5 parity checks compare the two screens' commands through it,
  // so the shape stays one per screen even though each screen owns its resolver.
  const mock = stubFetch();
  const seam = vi.fn();
  render(<SparkDetail id={DETAIL.id} onResolve={seam} />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  expect(seam.mock.calls).toEqual([[DETAIL.id, "ACCEPT"]]);
  // The injected seam is the path: nothing reaches §4.13 through the screen's own resolver.
  expect(decisionCalls(mock)).toHaveLength(0);
});
