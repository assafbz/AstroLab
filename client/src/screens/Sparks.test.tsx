// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { Sparks } from "./Sparks.tsx";

/**
 * S4's **screen wiring**: the band is composed from §4.10 + §4.9 and drawn, the header count is
 * §4.10's `unreviewed`, the deck's order is the read's order, §4.11's subscription feeds both, and the
 * one run trigger (§4.16) serves Recompute and Retry. Each test names the layer it would redden.
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
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["audio-dsp"],
  created_at: "2026-10-14T05:14:05Z",
};

const SECOND = {
  id: "bbb2",
  direction: "Pair the transit lattice with audio",
  claim: "Scheduling and DSP share a shape.",
  first_step: "Instrument the ingest path before the model runs.",
  domain_tags: ["transit"],
  created_at: "2026-10-13T05:14:05Z",
};

const THIRD = { ...SECOND, id: "ccc3", direction: "Index the vault by mechanism" };

/** K8 `#42` — a spark-derived idea that could not be prefilled: the shape ACCEPT mints (§4.13). */
const OWED = {
  id: "9f1c",
  hypothesis: "Route the overflow by relevance",
  problem: "the friction",
  monetization: "",
  domain_tags: ["audio-dsp"],
  lineage_kind: "ROOT",
  lineage_parent_id: null,
  status: "NEEDS_COMPLETION",
  visibility: "PRIVATE",
  current_version: 1,
  created_at: "2026-10-16T09:00:00Z",
  updated_at: "2026-10-16T09:00:00Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A §4.11 connection the test drives: push frames, or end it, to make the stream behave. */
interface Live {
  response: Response;
  push(event: "state" | "offer", payload: unknown): void;
  end(): void;
}

function sse(): Live {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(pipe) {
      controller = pipe;
    },
  });

  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (event, payload) =>
      controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)),
    end: () => controller.close(),
  };
}

/** A stream that stays open and silent — the default, so a test observes only what it drives. */
function quiet(): Response {
  return sse().response;
}

function state(name: string, unreviewed: number, run: unknown = null) {
  return { state: name, unreviewed, run };
}

interface Reads {
  summary?: unknown;
  /**
   * K8 `#42` — §4.4's answer to the needs-completion read (`{ ideas: […] }`). Absent = an empty list,
   * so the deck's other tests never see a prompt; `"fail"` rejects it (the best-effort test).
   */
  incomplete?: unknown;
  state?: unknown;
  /** §4.10's answer *after* the first read — the ladder moving while the screen is open. */
  stateAfter?: unknown;
  sparks?: unknown;
  /** §4.9's answer after the first read — so an `offer`-driven refresh is observable. */
  sparksAfter?: unknown;
  events?: Response;
  /** Hold the run POST open, so a second press lands while the first is still in flight. */
  holdRun?: boolean;
  /** Answer the run POST with the envelope's failure (§2) instead of a `202`. */
  failRun?: boolean;
  /**
   * §4.13's answer, from the parsed body and the url. Defaults to a `200 Decision` built from them, so
   * a test that does not care about the shape still exercises a real commit.
   */
  decision?: (
    body: { decision_id: string; kind: string },
    url: string,
  ) => Response | Promise<Response>;
}

/** The `Decision` (§3.5) the server would record for a §4.13 body — the stub's own reading of it. */
function decisionResponse(body: { decision_id: string; kind: string }, url: string) {
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

/** Route by route, so a read cannot silently receive another route's payload. */
function stubDeck(reads: Reads) {
  let statesSeen = 0;
  let decksSeen = 0;
  const runCalls: string[] = [];
  /** Every §4.13 call, with the body it carried — the decision id is what the tests read back. */
  const decisionCalls: Array<{ url: string; body: { decision_id: string; kind: string } }> = [];

  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/sparks/events")) {
      return Promise.resolve(reads.events ?? quiet());
    }
    if (url.includes("/decision")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        decision_id: string;
        kind: string;
      };
      decisionCalls.push({ url, body });
      return Promise.resolve(
        reads.decision ? reads.decision(body, url) : json(decisionResponse(body, url)),
      );
    }
    if (url.includes("/v1/sparks/run")) {
      runCalls.push(url);
      if (reads.holdRun) return new Promise<Response>(() => {});
      if (reads.failRun) {
        return Promise.resolve(json({ error: { code: "internal_error", message: "no run" } }, 500));
      }
      return Promise.resolve(json({ run_id: "r-1", vault_revision: 1 }, 202));
    }
    if (url.includes("/v1/sparks/state")) {
      statesSeen += 1;
      const answer = statesSeen > 1 ? (reads.stateAfter ?? reads.state) : reads.state;
      return Promise.resolve(json(answer ?? state("E2", 1)));
    }
    if (url.includes("/v1/sparks?state=offered")) {
      decksSeen += 1;
      const answer = decksSeen > 1 ? (reads.sparksAfter ?? reads.sparks) : reads.sparks;
      return Promise.resolve(json({ sparks: answer ?? [] }));
    }
    if (url.includes("/v1/ideas")) {
      // K8 `#42` — §4.4's needs-completion slice. `"fail"` exercises the best-effort catch inside
      // `readDeck`: the prompt read may reject, and the deck must still render (NFR-A1).
      if (reads.incomplete === "fail") return Promise.reject(new TypeError("offline"));
      return Promise.resolve(json(reads.incomplete ?? { ideas: [] }));
    }
    if (url.includes("/v1/vault/summary")) {
      return Promise.resolve(json(reads.summary ?? OPEN));
    }
    return Promise.resolve(json({ error: { code: "not_found", message: "no route" } }, 404));
  });

  vi.stubGlobal("fetch", mock);
  return { mock, runCalls, decisionCalls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The tap's one side effect is the route change; leaving it set would leak into the next test.
  window.location.hash = "";
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

test("tapping the card opens the detail's own route — `#/sparks/<id>` (T08)", async () => {
  stubDeck({ state: state("E2", 2), sparks: [FIRST, SECOND] });
  render(<Sparks />);

  const card = await screen.findByLabelText("Spark");
  expect(card.textContent).toContain(FIRST.direction);
  fireEvent.pointerDown(card, { clientX: 12, clientY: 20 });
  fireEvent.pointerUp(card, { clientX: 12, clientY: 20 });

  // The route the tapped spark was read at — the deck's own head, and its id, not a literal.
  expect(window.location.hash).toBe("#/sparks/aaa1");
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
  // E4's one lever is Retry (§9), and it is the guarded run trigger.
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("E3 — the composed empty, with §9's widening nudge only at the floor", async () => {
  stubDeck({ state: state("E3", 0), sparks: [], summary: { ...OPEN, resolved_domains: 2 } });
  render(<Sparks />);

  expect(await screen.findByText("No sparks left — for now.")).toBeTruthy();
  expect(screen.getByText(/One more field widens what can spark\./)).toBeTruthy();
  expect(screen.queryByLabelText("Spark")).toBeNull();
});

test("E3 above the floor gets no widening nudge — and all three of §9's levers, in order", async () => {
  stubDeck({ state: state("E3", 0), sparks: [], summary: OPEN });
  const { container } = render(<Sparks />);

  await screen.findByText("No sparks left — for now.");
  expect(screen.queryByText(/One more field widens what can spark\./)).toBeNull();
  // §9's E3 composes three levers, in this order: Add idea (S2) · Fork an idea into a new domain (S5,
  // V9 `#20` — the flywheel's own lever) · Recompute (the guarded run trigger).
  expect(screen.getByRole("link", { name: "Add idea" }).getAttribute("href")).toBe("#/capture");
  expect(
    screen.getByRole("link", { name: "Fork an idea into a new domain" }).getAttribute("href"),
  ).toBe("#/fork");
  expect(screen.getByRole("button", { name: "Recompute" })).toBeTruthy();
  expect(
    [...container.querySelectorAll(".empty__actions > *")].map((node) => node.textContent),
  ).toEqual(["Add idea", "Fork an idea into a new domain", "Recompute"]);
});

test("a failed read says so and retries — it never shows E0 as a guess", async () => {
  // The first pass fails every route; flipping the flag lets the retry succeed.
  let failing = true;
  const mock = vi.fn((input: RequestInfo | URL) => {
    if (failing) {
      return Promise.resolve(json({ error: { code: "internal_error", message: "boom" } }, 500));
    }
    const url = String(input);
    if (url.includes("/v1/sparks/events")) return Promise.resolve(quiet());
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

/**
 * §4.11's connect-race rule. *"A client subscribes, then reads §4.9"* only holds of a client that has
 * issued the subscription first: defer the subscription by one microtask and the deck read can beat it.
 */
test("the screen subscribes before it reads §4.9, then §4.10 (§4.11)", () => {
  const { mock } = stubDeck({ state: state("E2", 1), sparks: [FIRST] });
  render(<Sparks />);

  const urls = mock.mock.calls.map((call) => String(call[0]));
  expect(urls[0]).toContain("/v1/sparks/events");
  expect(urls.indexOf("/v1/sparks/events")).toBeLessThan(
    urls.findIndex((url) => url.includes("/v1/sparks?state=offered")),
  );
});

test("a §4.11 `state` frame redraws the band — the ladder is the server's, mid-run", async () => {
  const live = sse();
  stubDeck({
    state: state("E1", 1, { id: "r-42", status: "RUNNING", vault_revision: 42 }),
    sparks: [FIRST],
    events: live.response,
  });
  render(<Sparks />);

  await screen.findByLabelText("Spark");
  expect(screen.getByRole("status").textContent).toContain("Computing sparks");

  // The run landed: the server's own transition, on the event that carries it (§4.11).
  live.push("state", state("E2", 1));

  await waitFor(() => expect(screen.queryByText("Computing sparks…")).toBeNull());
  expect(screen.getByLabelText("Spark").textContent).toContain(FIRST.direction);
});

test("an `offer` frame re-reads §4.9 — the deck is the read, never a local append (§4.11)", async () => {
  const live = sse();
  stubDeck({
    state: state("E2", 2),
    sparks: [FIRST, SECOND],
    // The refresh answers a different head: an append would leave FIRST in front, and a screen that
    // kept its own array would never see this.
    sparksAfter: [SECOND, FIRST],
    events: live.response,
  });
  render(<Sparks />);

  expect((await screen.findByLabelText("Spark")).textContent).toContain(FIRST.direction);

  live.push("offer", THIRD);

  await waitFor(() =>
    expect(screen.getByLabelText("Spark").textContent).toContain(SECOND.direction),
  );
});

test("a dropped stream mid-run leaves the band composed — no takeover, no spinner, no error", async () => {
  const live = sse();
  stubDeck({
    state: state("E1", 1, { id: "r-42", status: "RUNNING", vault_revision: 42 }),
    sparks: [FIRST],
    events: live.response,
  });
  render(<Sparks />);

  await screen.findByLabelText("Spark");
  live.end();

  // The band is the last truth the server gave: the card stays reviewable, the in-flight state keeps
  // announcing itself, and nothing is invented to fill the gap.
  await waitFor(() => expect(screen.getByText("Computing sparks…")).toBeTruthy());
  expect(screen.getByLabelText("Spark").textContent).toContain(FIRST.direction);
  expect(screen.queryByText("Sparks are out of reach.")).toBeNull();
});

test("the list toggle's bar is §4.10's `unreviewed` (> 1), not the deck read's length (§9)", async () => {
  stubDeck({ state: state("E2", 3), sparks: [FIRST] });
  render(<Sparks />);

  await screen.findByLabelText("Spark");
  // Three to review over a one-card read: the toggle is keyed on the count, the same number the header
  // shows, so the two cannot disagree about whether there is a list.
  expect(screen.getByRole("button", { name: "View all" })).toBeTruthy();
});

test("one spark to review is no list at all — the toggle stays away (§9)", async () => {
  stubDeck({ state: state("E2", 1), sparks: [FIRST] });
  render(<Sparks />);

  await screen.findByLabelText("Spark");
  expect(screen.queryByRole("button", { name: "View all" })).toBeNull();
});

test("View all switches the deck to the list and back — the same cards, one path each (§5.5)", async () => {
  stubDeck({ state: state("E2", 3), sparks: [FIRST, SECOND] });
  render(<Sparks />);

  await screen.findByLabelText("Spark");
  expect(screen.getAllByLabelText("Spark")).toHaveLength(1);

  screen.getByRole("button", { name: "View all" }).click();
  await waitFor(() => expect(screen.getAllByLabelText("Spark")).toHaveLength(2));
  expect(screen.getByText(FIRST.direction)).toBeTruthy();
  expect(screen.getByText(SECOND.direction)).toBeTruthy();

  screen.getByRole("button", { name: "One at a time" }).click();
  await waitFor(() => expect(screen.getAllByLabelText("Spark")).toHaveLength(1));
});

/**
 * The one guard (O5 `#25`, `domain/run-trigger.ts`). §4.16's dedup is per `PENDING` run, so a second
 * POST while the first is still `RUNNING` inserts a second row — the press-scoped single flight is what
 * closes that edge, and Recompute must reach it rather than calling `enqueueRun` itself.
 */
test("Recompute goes through the shared guard — three presses in flight send one POST", async () => {
  const { runCalls } = stubDeck({ state: state("E3", 0), sparks: [], holdRun: true });
  render(<Sparks />);

  const recompute = await screen.findByRole("button", { name: "Recompute" });
  recompute.click();
  recompute.click();
  recompute.click();

  expect(runCalls).toHaveLength(1);
});

test("Retry in E4 goes through the same guard — one POST, one press", async () => {
  const { runCalls } = stubDeck({
    state: state("E4", 0),
    sparks: [],
    holdRun: true,
  });
  render(<Sparks />);

  const retry = await screen.findByRole("button", { name: "Retry" });
  retry.click();
  retry.click();

  expect(runCalls).toHaveLength(1);
});

/** How many times §4.10 has been read — the refresh the trigger fires proves itself through this. */
function stateReads(fn: { mock: { calls: unknown[][] } }): number {
  return fn.mock.calls.filter((call) => String(call[0]).includes("/v1/sparks/state")).length;
}

test("Recompute does not invent E1 — the ladder comes back from §4.10, not from the press", async () => {
  // The run POST succeeds, but the state read still answers E3: the client must not draw in-flight work
  // it was never told about (§4.10 is the deck's only state input).
  const stub = stubDeck({ state: state("E3", 0), stateAfter: state("E3", 0), sparks: [] });
  render(<Sparks />);

  (await screen.findByRole("button", { name: "Recompute" })).click();

  // The POST settled, so the screen re-read §4.10 — and §4.10 still says E3.
  await waitFor(() => expect(stateReads(stub.mock)).toBe(2));
  expect(screen.queryByText("Computing sparks…")).toBeNull();
  expect(screen.getByText("No sparks left — for now.")).toBeTruthy();
});

test("and when §4.10 does say E1, the refresh draws it — the read is what moves the band", async () => {
  stubDeck({ state: state("E3", 0), stateAfter: state("E1", 0, { id: "r-1" }), sparks: [] });
  render(<Sparks />);

  (await screen.findByRole("button", { name: "Recompute" })).click();

  expect(await screen.findByText("Computing sparks…")).toBeTruthy();
});

test("a run that never enqueued is dropped, not surfaced — the deck still reports the truth (§4.10)", async () => {
  // The POST fails; the refresh still runs on its settlement and answers E3, and E3 is what stands. No
  // invented E1, and no invented error surface either: the state read is the single source (§4.16).
  const stub = stubDeck({
    state: state("E3", 0),
    stateAfter: state("E3", 0),
    sparks: [],
    failRun: true,
  });
  render(<Sparks />);

  (await screen.findByRole("button", { name: "Recompute" })).click();

  await waitFor(() => expect(stateReads(stub.mock)).toBe(2));
  expect(screen.queryByText("Computing sparks…")).toBeNull();
  expect(screen.getByText("No sparks left — for now.")).toBeTruthy();
  expect(screen.queryByText("Sparks are out of reach.")).toBeNull();
});

/**
 * K7 `#41` — the **resolution seam** at the screen. The card still holds the one `onResolve` (the
 * structural guards own that); what these tests own is what the *screen* does with the outcome:
 * re-read on success, never remove locally, and — on a failure — keep the card and draw T29's
 * non-destructive notice with the one lever Retry.
 */

test("Good posts §4.13 and the screen re-reads — a committed card is never removed locally (K7)", async () => {
  const stub = stubDeck({ state: state("E2", 1), sparks: [FIRST], sparksAfter: [SECOND] });
  render(<Sparks />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  // The server's *next read* decides what stands. A screen that removed the card locally would show an
  // empty deck; the re-read shows the spark the server now offers.
  await waitFor(() =>
    expect(screen.getByLabelText("Spark").textContent).toContain(SECOND.direction),
  );
  expect(stub.decisionCalls).toHaveLength(1);
  expect(stub.decisionCalls[0]!.url).toBe("/v1/sparks/aaa1/decision");
  expect(stub.decisionCalls[0]!.body.kind).toBe("ACCEPT");
  // A real client-generated key, not a literal (§2.2): the id is what a Retry would have to re-issue.
  expect(stub.decisionCalls[0]!.body.decision_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  // And §4.10 was re-read too — the ladder is the server's, not the press's (§4.10).
  expect(stateReads(stub.mock)).toBe(2);
});

test("a retryable failure keeps the card and draws T29's notice — non-destructive, with Retry (K7)", async () => {
  const stub = stubDeck({
    state: state("E2", 1),
    sparks: [FIRST],
    sparksAfter: [SECOND],
    decision: () => Promise.reject(new Error("dropped")),
  });
  render(<Sparks />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  // §2 gives a rejected `fetch` the `network` code — the T29 case the surface exists for.
  expect(await screen.findByText(/Nothing was recorded/)).toBeTruthy();
  const notice = screen.getByText(/Nothing was recorded/).closest("p")!;
  expect(within(notice).getByRole("button", { name: "Retry" })).toBeTruthy();
  // The card **stays**: nothing was removed, and no read ran to replace it (§4.10/§4.9 untouched).
  expect(screen.getByLabelText("Spark").textContent).toContain(FIRST.direction);
  expect(stateReads(stub.mock)).toBe(1);
});

test("Retry re-issues the same decision_id, and a successful retry re-reads (K7)", async () => {
  const stub = stubDeck({
    state: state("E2", 1),
    sparks: [FIRST],
    sparksAfter: [SECOND],
    decision: (body, url) =>
      stub.decisionCalls.length === 1
        ? Promise.reject(new Error("dropped"))
        : Promise.resolve(json(decisionResponse(body, url))),
  });
  render(<Sparks />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));
  const notice = (await screen.findByText(/Nothing was recorded/)).closest("p")!;
  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(stub.decisionCalls).toHaveLength(2));
  // The whole of §2.2: the retry carries **the same** `decision_id`, so a commit the response lost is
  // answered by §4.13's hoisted repeat rather than resolved a second time.
  expect(stub.decisionCalls[1]!.body.decision_id).toBe(stub.decisionCalls[0]!.body.decision_id);
  // The retry committed, so the notice goes and the deck follows the server's next read.
  await waitFor(() => expect(screen.queryByText(/Nothing was recorded/)).toBeNull());
  await waitFor(() =>
    expect(screen.getByLabelText("Spark").textContent).toContain(SECOND.direction),
  );
});

test("a `409` re-reads and offers no Retry — the server stated a truth, so Retrying would loop (K7)", async () => {
  const stub = stubDeck({
    state: state("E2", 1),
    sparks: [FIRST],
    sparksAfter: [SECOND],
    decision: () => json({ error: { code: "conflict", message: "spark is not OFFERED" } }, 409),
  });
  render(<Sparks />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  // Not a blip: the read is re-run instead, and the deck follows it — no notice, no Retry.
  await waitFor(() => expect(stateReads(stub.mock)).toBe(2));
  expect(screen.queryByText(/Nothing was recorded/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await waitFor(() =>
    expect(screen.getByLabelText("Spark").textContent).toContain(SECOND.direction),
  );
});

test("E4 does not disable a resolution — a paused engine still resolves from the deck (K7, NFR-A1)", async () => {
  // E4 is the *server's* engine state (§4.10): the provider is down, the vault is not. Resolving writes
  // the vault, so its lever must reach the seam in E4 exactly as in E2.
  const stub = stubDeck({ state: state("E4", 1), sparks: [FIRST] });
  render(<Sparks />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));

  await waitFor(() => expect(stub.decisionCalls).toHaveLength(1));
  expect(stub.decisionCalls[0]!.body.kind).toBe("ACCEPT");
});

test("the T29 notice is its own surface — in E4 its Retry re-issues the decision, not the run (K7)", async () => {
  // Both surfaces may be on screen at once (an engine that is paused, a resolution that dropped), so
  // the notice is not `band.paused`'s: its Retry re-issues §4.13 and never `POST /v1/sparks/run` (§4.16).
  const stub = stubDeck({
    state: state("E4", 1),
    sparks: [FIRST],
    decision: () => Promise.reject(new Error("dropped")),
  });
  render(<Sparks />);

  fireEvent.click(await screen.findByRole("button", { name: "Good" }));
  const notice = (await screen.findByText(/Nothing was recorded/)).closest("p")!;

  // E4's own Retry (the run) is a *different* lever, and both are on screen.
  expect(screen.getByText("Sparks are paused. Your vault is fully available.")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);

  fireEvent.click(within(notice).getByRole("button", { name: "Retry" }));

  await waitFor(() => expect(stub.decisionCalls).toHaveLength(2));
  expect(stub.decisionCalls[1]!.body.decision_id).toBe(stub.decisionCalls[0]!.body.decision_id);
  expect(stub.runCalls).toHaveLength(0);
});

test("the notice is tied to its own decision — another spark committing does not clear it (K7)", async () => {
  // A notice belongs to the decision that failed. Clearing it on *any* success would drop a surface the
  // user still needs the moment they resolve a different card.
  const stub = stubDeck({
    state: state("E2", 2),
    sparks: [FIRST, SECOND],
    decision: (body, url) =>
      url.includes("aaa1")
        ? Promise.reject(new Error("dropped"))
        : Promise.resolve(json(decisionResponse(body, url))),
  });
  render(<Sparks />);

  await screen.findByLabelText("Spark");
  screen.getByRole("button", { name: "View all" }).click();
  await waitFor(() => expect(screen.getAllByLabelText("Spark")).toHaveLength(2));

  // FIRST fails → a notice for `aaa1`.
  fireEvent.click(screen.getAllByRole("button", { name: "Good" })[0]!);
  expect(await screen.findByText(/Nothing was recorded/)).toBeTruthy();

  // SECOND commits — its own decision, and not the one the notice is about.
  fireEvent.click(screen.getAllByRole("button", { name: "Good" })[1]!);
  await waitFor(() => expect(stub.decisionCalls).toHaveLength(2));
  expect(screen.getByText(/Nothing was recorded/)).toBeTruthy();
});

test("a needs-completion idea draws T27's prompt on the deck — K8 #42", async () => {
  stubDeck({ state: state("E2", 1), sparks: [FIRST], incomplete: { ideas: [OWED] } });
  render(<Sparks />);

  expect(await screen.findByText(/1 idea needs completion/)).toBeTruthy();
  // Its one lever opens the newest owed idea, where the missing field is named and supplied (S4).
  expect(screen.getByRole("link", { name: "Complete" }).getAttribute("href")).toBe("#/ideas/9f1c");
  // Non-blocking, the E4 pattern: the notice composes *around* the reviewable card (§5.6, NFR-A1).
  expect(screen.getByLabelText("Spark").textContent).toContain(FIRST.direction);
});

test("the deck prompt pluralises — two owed ideas read as a count, not a card", async () => {
  stubDeck({
    state: state("E2", 1),
    sparks: [FIRST],
    incomplete: { ideas: [OWED, { ...OWED, id: "other" }] },
  });
  render(<Sparks />);

  expect(await screen.findByText(/2 ideas need completion/)).toBeTruthy();
});

test("the deck prompt is best-effort — a failed prompt read never fails the deck (NFR-A1)", async () => {
  // The three deck reads are fatal; this fourth one is not. A prompt that could not be fetched must
  // read as "nothing owed", never as a deck that failed to load.
  stubDeck({ state: state("E2", 1), sparks: [FIRST], incomplete: "fail" });
  render(<Sparks />);

  expect((await screen.findByLabelText("Spark")).textContent).toContain(FIRST.direction);
  expect(screen.queryByText(/needs? completion/i)).toBeNull();
});

test("E0's cold composition owns the screen — T27's prompt does not intrude (FLOW §4.1)", async () => {
  // Completing an idea does not change E0 (its arms are status-blind), so the prompt would be noise
  // over a state that is a statement about breadth.
  stubDeck({
    state: state("E0", 0),
    sparks: [],
    summary: COLD,
    incomplete: { ideas: [OWED] },
  });
  render(<Sparks />);

  await screen.findByLabelText("Sparks need more domains");
  expect(screen.queryByText(/needs completion/i)).toBeNull();
});
